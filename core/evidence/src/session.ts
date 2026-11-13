/**
 * Recording a session = running a script against a sandboxed build and
 * capturing, per step: the ingress exchange, egress calls the app made to
 * fakes, row-level DB writes, and domain events; plus final fake + DB state.
 * Replay = running the same script against another (or the same) build.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { Json } from '@sluice-dev/fakes';
import { Sandbox, type SandboxOptions } from '@sluice-dev/sandbox';
import { auditCursor, dumpTables, installAudit, readChanges, type DbChange } from './audit.js';
import { getPath, interpolate, parseDuration, stepName, type Script } from './script.js';

export const SESSION_FORMAT = 'sluice-session/1';

export interface EgressCall {
  fake: string;
  method: string;
  path: string;
  query: Json;
  body: Json;
  status: number;
  response: Json;
}

export interface StepEvidence {
  index: number;
  name: string;
  kind: 'http' | 'advance' | 'clock' | 'check';
  request?: { method: string; path: string; body: Json };
  response?: { status: number; body: Json };
  egress: EgressCall[];
  db: DbChange[];
  events: Json[];
}

export interface Session {
  format: typeof SESSION_FORMAT;
  label: string;
  script: Script;
  seed: number;
  startMs: number;
  steps: StepEvidence[];
  final: { fakes: Record<string, Json>; db: Record<string, Json[]> };
  /** Contract violations observed in fakes during the run (should be empty). */
  contractViolations: string[];
}

/** Boot a sandbox with DB write capture installed. */
export function startEvidenceSandbox(opts: Omit<SandboxOptions, 'prepareDatabase'>): Promise<Sandbox> {
  return Sandbox.up({ ...opts, prepareDatabase: installAudit });
}

export interface RunOptions {
  label?: string;
  /** Switch the sandbox to another build (source tree) before running. */
  sourceRoot?: string;
  seed?: number;
  /** Reset the sandbox first (default true). */
  reset?: boolean;
  /** Initial variables available to the script. */
  vars?: Record<string, Json>;
  /** Called after each step's evidence is collected (assertions, early exit by throwing). */
  afterStep?: (ctx: AfterStepContext) => Promise<void> | void;
}

export interface AfterStepContext {
  index: number;
  step: Script['steps'][number];
  evidence: StepEvidence;
  /** Evidence of all steps so far, including this one. */
  steps: StepEvidence[];
  vars: Record<string, Json>;
  sandbox: Sandbox;
  db: pg.Client | undefined;
}

async function readBody(res: Response): Promise<Json> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

export async function runScript(sb: Sandbox, script: Script, opts: RunOptions = {}): Promise<Session> {
  if (opts.reset !== false) await sb.reset({ sourceRoot: opts.sourceRoot, seed: opts.seed });
  const startMs = sb.clock.now();
  const db = sb.spec.database
    ? new pg.Client({ connectionString: sb.databaseUrl, connectionTimeoutMillis: 10_000, query_timeout: 60_000 })
    : undefined;
  await db?.connect();
  try {
    let cursor = db ? await auditCursor(db) : 0;
    const vars: Record<string, Json> = { ...opts.vars };
    const steps: StepEvidence[] = [];
    const eventCursor = new Map<string, number>();
    for (const svc of sb.deterministicServices) eventCursor.set(svc, (await sb.events(svc, 0)).total);

    for (const [index, step] of script.steps.entries()) {
      const journalStart = new Map([...sb.fakes].map(([n, f]) => [n, f.journal.length]));
      const ev: StepEvidence = { index, name: stepName(step), kind: 'http', egress: [], db: [], events: [] };
      if ('http' in step) {
        const method = step.http.method.toUpperCase();
        const path = interpolate(step.http.path, vars) as string;
        const body = step.http.body === undefined ? undefined : interpolate(step.http.body, vars);
        const res = await fetch(sb.ingressUrl + path, {
          method,
          headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...step.http.headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
        ev.request = { method, path, body: body ?? null };
        ev.response = { status: res.status, body: await readBody(res) };
        for (const [k, p] of Object.entries(step.save ?? {})) vars[k] = (getPath(ev.response, p) ?? null) as Json;
      } else if ('advance' in step) {
        ev.kind = 'advance';
        await sb.advance(parseDuration(step.advance));
      } else if ('check' in step) {
        ev.kind = 'check';
      } else {
        ev.kind = 'clock';
        await sb.setClock(Date.parse(step.clock));
      }
      for (const [name, f] of sb.fakes) {
        for (const j of f.journal.slice(journalStart.get(name))) {
          ev.egress.push({
            fake: name,
            method: j.method,
            path: j.path,
            query: j.query as Json,
            body: j.body as Json,
            status: j.status,
            response: j.response,
          });
        }
      }
      if (db) {
        const r = await readChanges(db, cursor);
        cursor = r.cursor;
        ev.db = r.changes;
      }
      for (const svc of sb.deterministicServices) {
        const r = await sb.events(svc, eventCursor.get(svc));
        eventCursor.set(svc, r.total);
        ev.events.push(...(r.events as Json[]));
      }
      steps.push(ev);
      if (opts.afterStep) await opts.afterStep({ index, step, evidence: ev, steps, vars, sandbox: sb, db });
    }

    const fakes: Record<string, Json> = {};
    const violations: string[] = [];
    for (const [name, f] of sb.fakes) {
      fakes[name] = f.fake.state();
      violations.push(...f.violations.map((v) => `${name}: ${v.operation}: ${v.message}`));
    }
    return {
      format: SESSION_FORMAT,
      label: opts.label ?? 'run',
      script,
      seed: opts.seed ?? sb.spec.seed,
      startMs,
      steps,
      final: { fakes, db: db ? await dumpTables(db) : {} },
      contractViolations: violations,
    };
  } finally {
    await db?.end();
  }
}

export function saveSession(file: string, s: Session): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}

export function loadSession(file: string): Session {
  const s = JSON.parse(readFileSync(file, 'utf8')) as Session;
  if (s.format !== SESSION_FORMAT) throw new Error(`${file}: not a ${SESSION_FORMAT} file`);
  return s;
}

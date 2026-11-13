/**
 * `sluice gate run`: judge a change (head) against approved acceptance
 * scenarios, with a behavior diff against base and a mutation proof.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { loadConfig } from '@sluice-dev/config';
import { diffSessions, startEvidenceSandbox, type DiffEntry } from '@sluice-dev/evidence';
import { isTestFile, languageOf } from '@sluice-dev/lang';
import { checkoutRef, git, type Checkout, type Sandbox } from '@sluice-dev/sandbox';
import { applyMutant, changedLines, generateMutants, selectMutants, type Mutant } from './mutation.js';
import { runScenario, type Failure, type ScenarioRun } from './runner.js';
import type { Scenario } from './scenario.js';
import { GATE_DIR, GateStore, type ApprovalStatus } from './store.js';

export interface GateConfig {
  mutation?: { enabled?: boolean; maxMutants?: number; threshold?: number };
  unitTests?: { service: string; command: string[]; mounts: string[] };
}

export interface GateRunOptions extends GateConfig {
  /** Directory containing sluice.yaml inside a git repository. */
  projectRoot: string;
  ticket: string;
  base: string;
  head: string;
  log?: (msg: string) => void;
}

export interface ScenarioReport {
  id: string;
  title: string;
  passed: boolean;
  failures: Failure[];
  /** Behavior diff: base -> head for this scenario. */
  diff: DiffEntry[];
  basePassed: boolean;
  durationMs: number;
}

/**
 * killed: a scenario's outcome changed; survived: none did; invalid: the
 * mutant build did not compile/start (excluded from the score).
 */
export type MutantStatus = 'killed' | 'survived' | 'invalid';

export interface MutantReport extends Omit<Mutant, 'start' | 'end'> {
  status: MutantStatus;
  /** Same as `status === 'killed'` (kept for report consumers). */
  killed: boolean;
  killedBy?: string;
  detail?: string;
}

export interface GateReport {
  format: 'sluice-gate-report/1';
  ticket: { id: string; title: string; spec: string };
  verdict: 'pass' | 'fail';
  reasons: string[];
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  approvals: { scenario: string; status: ApprovalStatus; approvedBy?: string; sha256: string }[];
  integrity: { gateFilesModified: string[] };
  scenarios: ScenarioReport[];
  mutation: {
    enabled: boolean;
    threshold: number;
    /** Mutants run, including invalid ones. */
    total: number;
    killed: number;
    /** Mutants whose build did not compile/start; not in the score's denominator. */
    invalid?: number;
    /** killed / (total - invalid); null when no valid mutant ran. */
    score: number | null;
    mutants: MutantReport[];
  };
  unitTests?: { command: string; exitCode: number; passed: boolean; outputTail: string };
  contractViolations: string[];
  durationMs: number;
}

export async function runGate(opts: GateRunOptions): Promise<GateReport> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  // realpath: git reports symlink-free paths (e.g. /private/var on macOS)
  const projectRoot = realpathSync(resolve(opts.projectRoot));
  const top = (await git(['rev-parse', '--show-toplevel'], projectRoot)).trim();
  const rel = relative(top, projectRoot);
  const checkouts: Checkout[] = [];
  // Mutant trees are bind-mounted into containers; delete them only after the
  // sandbox is down (removing a mounted dir can wedge Docker Desktop).
  const trees: string[] = [];
  let sb: Sandbox | undefined;
  try {
    const baseCo = await checkoutRef(top, opts.base);
    checkouts.push(baseCo);
    const headCo = await checkoutRef(top, opts.head);
    checkouts.push(headCo);
    const baseProj = join(baseCo.dir, rel);
    const headProj = join(headCo.dir, rel);
    log(`gate ${opts.ticket}: base ${opts.base}@${baseCo.sha.slice(0, 8)} head ${opts.head}@${headCo.sha.slice(0, 8)}`);

    // Definitions come from base: a PR cannot approve or rewrite its own checks.
    const store = new GateStore(baseProj);
    const ticket = store.readTicket(opts.ticket);
    const states = store.state(opts.ticket);
    const reasons: string[] = [];
    const gatePath = join(rel, GATE_DIR);
    const touched = (await git(['diff', '--name-only', baseCo.sha, headCo.sha, '--', gatePath], top))
      .split('\n')
      .filter(Boolean);
    if (touched.length) reasons.push(`the change modifies gate definitions (${touched.join(', ')})`);
    for (const s of states)
      if (s.status !== 'approved')
        reasons.push(
          `scenario ${s.scenario.id} is ${s.status === 'stale' ? 'changed since approval' : 'not approved'}`,
        );
    const approved = states.filter((s) => s.status === 'approved').map((s) => s.scenario);
    if (approved.length === 0) reasons.push('no approved scenarios for this ticket');

    const { config } = loadConfig(baseProj);
    if (!config.sandbox) throw new Error('sluice.yaml has no sandbox section');
    sb = await startEvidenceSandbox({
      root: headProj,
      spec: config.sandbox,
      name: config.name,
      sourceRoot: headProj,
      log,
    });

    const headRuns: ScenarioRun[] = [];
    for (const s of approved) {
      const r = await runScenario(sb, s, { sourceRoot: headProj, label: 'head' });
      log(`  ${r.passed ? 'PASS' : 'FAIL'} ${s.id}`);
      headRuns.push(r);
    }
    const scenarios: ScenarioReport[] = [];
    for (const [i, s] of approved.entries()) {
      const baseRun = await runScenario(sb, s, { sourceRoot: baseProj, label: 'base' });
      const h = headRuns[i]!;
      scenarios.push({
        id: s.id,
        title: s.title,
        passed: h.passed,
        failures: h.failures,
        diff: diffSessions(baseRun.session, h.session, { ignore: config.evidence?.ignore ?? [], final: true }).entries,
        basePassed: baseRun.passed,
        durationMs: h.durationMs,
      });
    }
    const failed = scenarios.filter((s) => !s.passed);
    for (const f of failed) reasons.push(`scenario ${f.id} failed: ${f.failures[0]?.message ?? 'unknown'}`);

    // ---------------------------------------------------------------- mutation proof
    const mcfg = { enabled: true, maxMutants: 10, threshold: 0.8, ...opts.mutation };
    const mutants: MutantReport[] = [];
    if (mcfg.enabled && approved.length) {
      const sourceDirs = Object.values(config.sandbox.services)
        .filter((svc) => svc.source)
        .map((svc) => join(svc.build ?? '.', svc.source!));
      const pathspecs = sourceDirs.map((d) => join(rel, d));
      const ranges = await changedLines(top, baseCo.sha, headCo.sha, pathspecs);
      let all: Mutant[] = [];
      for (const [file, r] of Object.entries(ranges)) {
        if (!languageOf(file) || isTestFile(file)) continue;
        all.push(...generateMutants(file, readFileSync(join(headCo.dir, file), 'utf8'), r));
      }
      all = selectMutants(all, mcfg.maxMutants);
      const baseline = headRuns.map((r) => r.passed);
      for (const m of all) {
        const tree = mkdtempSync(join(tmpdir(), 'sluice-mutant-'));
        trees.push(tree);
        {
          for (const d of sourceDirs) cpSync(join(headProj, d), join(tree, d), { recursive: true });
          const target = join(tree, relative(rel, m.file));
          writeFileSync(target, applyMutant(readFileSync(join(headCo.dir, m.file), 'utf8'), m));
          const report: MutantReport = {
            id: m.id,
            file: m.file,
            line: m.line,
            operator: m.operator,
            original: m.original,
            replacement: m.replacement,
            status: 'survived',
            killed: false,
          };
          for (const [i, s] of approved.entries()) {
            const r = await runMutantScenario(sb, s, tree, `mutant ${m.id}`);
            if (r.kind === 'invalid') {
              report.status = 'invalid';
              report.detail = r.detail;
              break;
            }
            if (r.kind === 'error' || r.run.passed !== baseline[i]) {
              report.status = 'killed';
              report.killed = true;
              report.killedBy = s.id;
              report.detail =
                r.kind === 'error'
                  ? `scenario errored: ${r.detail}`
                  : r.run.passed
                    ? 'scenario started passing'
                    : (r.run.failures[0]?.message ?? 'failed');
              break;
            }
          }
          log(
            `  mutant ${m.file}:${m.line} ${m.operator} ${
              report.status === 'killed'
                ? `killed by ${report.killedBy}`
                : report.status === 'invalid'
                  ? `INVALID (did not build/start): ${gist(report.detail)}`
                  : 'SURVIVED'
            }`,
          );
          mutants.push(report);
        }
      }
    }
    const killed = mutants.filter((m) => m.status === 'killed').length;
    const invalid = mutants.filter((m) => m.status === 'invalid').length;
    const valid = mutants.length - invalid;
    const score = valid ? killed / valid : null;
    if (failed.length === 0 && reasons.length === 0 && score !== null && score < mcfg.threshold) {
      reasons.push(
        `checks too weak: only ${killed}/${valid} deliberately broken versions were caught (threshold ${Math.round(mcfg.threshold * 100)}%${invalid ? `; ${invalid} mutant${invalid === 1 ? '' : 's'} did not build/start and ${invalid === 1 ? 'is' : 'are'} excluded` : ''})`,
      );
    }

    // ---------------------------------------------------------------- unit tests (informational)
    let unitTests: GateReport['unitTests'];
    if (opts.unitTests) {
      const svc = config.sandbox.services[opts.unitTests.service];
      if (!svc) throw new Error(`unitTests.service ${opts.unitTests.service} not in sandbox`);
      const ctxDir = join(headProj, svc.build ?? '.');
      const mounts = opts.unitTests.mounts
        .filter((m) => existsSync(join(ctxDir, m)))
        .map((m) => ({ host: join(ctxDir, m), container: `${svc.workdir.replace(/\/$/, '')}/${m}` }));
      const r = await sb.runOneOff(opts.unitTests.service, opts.unitTests.command, mounts);
      unitTests = {
        command: opts.unitTests.command.join(' '),
        exitCode: r.code,
        passed: r.code === 0,
        outputTail: r.output.split('\n').slice(-15).join('\n'),
      };
    }

    const contractViolations = [...sb.fakes.values()].flatMap((f) =>
      f.violations.map((v) => `${f.fake.name}: ${v.operation}: ${v.message}`),
    );
    return {
      format: 'sluice-gate-report/1',
      ticket: { id: ticket.id, title: ticket.title, spec: ticket.spec },
      verdict: reasons.length ? 'fail' : 'pass',
      reasons,
      base: { ref: opts.base, sha: baseCo.sha },
      head: { ref: opts.head, sha: headCo.sha },
      approvals: states.map((s) => ({
        scenario: s.scenario.id,
        status: s.status,
        approvedBy: s.approval?.approvedBy,
        sha256: s.sha256,
      })),
      integrity: { gateFilesModified: touched },
      scenarios,
      mutation: {
        enabled: mcfg.enabled,
        threshold: mcfg.threshold,
        total: mutants.length,
        killed,
        invalid,
        score,
        mutants,
      },
      unitTests,
      contractViolations,
      durationMs: Date.now() - started,
    };
  } finally {
    await sb?.down();
    for (const t of trees) rmSync(t, { recursive: true, force: true });
    for (const c of checkouts.reverse()) await c.remove();
  }
}

export type MutantRun =
  { kind: 'ran'; run: ScenarioRun } | { kind: 'invalid'; detail: string } | { kind: 'error'; detail: string };

const firstLine = (s: string | undefined) => (s ?? '').split('\n')[0]!.slice(0, 200);

/** First and last line of startup output (`service app exited during startup: … ./x.go:3: undefined: y`). */
function gist(s: string | undefined): string {
  const lines = (s ?? '').split('\n').filter((l) => l.trim());
  const last = lines.length > 1 ? lines.at(-1)!.trim().slice(0, 200) : '';
  return last ? `${firstLine(lines[0])} … ${last}` : firstLine(lines[0]);
}

/** Startup output worth keeping in the report (the tail has the compiler error). */
function startupDetail(e: unknown): string {
  const lines = String((e as Error)?.message ?? e).split('\n');
  const text = lines.length > 25 ? [lines[0]!, '…', ...lines.slice(-24)].join('\n') : lines.join('\n');
  return text.length > 4000 ? text.slice(0, 4000) + '…' : text;
}

/**
 * Run one scenario against a mutant tree, telling apart a mutant that does
 * not build/start (the sandbox reset onto the tree throws: compile error, the
 * service exits or never gets ready) from one that starts and then misbehaves.
 * The former is `invalid`; a scenario that throws after startup (e.g. the
 * mutant crashes the app mid-request) is a behaviour change, i.e. killed.
 */
export async function runMutantScenario(
  sb: Sandbox,
  scenario: Scenario,
  tree: string,
  label: string,
): Promise<MutantRun> {
  let startupError: unknown;
  let failedStartup = false;
  const guarded = new Proxy(sb, {
    get(target, prop) {
      if (prop === 'reset')
        return async (o: Parameters<Sandbox['reset']>[0]) => {
          try {
            await target.reset(o);
          } catch (e) {
            failedStartup = true;
            startupError = e;
            throw e;
          }
        };
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  try {
    return { kind: 'ran', run: await runScenario(guarded, scenario, { sourceRoot: tree, label }) };
  } catch (e) {
    if (failedStartup) return { kind: 'invalid', detail: startupDetail(startupError) };
    return { kind: 'error', detail: firstLine((e as Error)?.message ?? String(e)) };
  }
}

/**
 * `sluice gate run`: judge a change (head) against approved acceptance
 * scenarios, with a behavior diff against base and a mutation proof.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { loadConfig } from '@sluice-dev/config';
import { diffSessions, startEvidenceSandbox, type DiffEntry } from '@sluice-dev/evidence';
import { isTestFile, languageOf, type Language } from '@sluice-dev/lang';
import { checkoutRef, git, type Checkout, type Sandbox } from '@sluice-dev/sandbox';
import { applyMutant, changedLines, generateMutants, selectMutants, type Mutant } from './mutation.js';
import { runScenario, type Failure, type ScenarioRun } from './runner.js';
import type { Scenario } from './scenario.js';
import { GATE_DIR, GateStore, type ApprovalStatus } from './store.js';

export interface GateConfig {
  mutation?: {
    enabled?: boolean;
    maxMutants?: number;
    threshold?: number;
    /** Accept changed source lines that yield no mutants (default: the gate fails as unproven). */
    allowNoMutants?: boolean;
  };
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
 * killed: a scenario's outcome changed, or the mutant app crashed / failed to
 * start; survived: nothing changed; invalid: the mutant did not compile (Go/C#
 * compiler errors only); error: the sandbox failed (Docker, database, fakes,
 * restore…) even after a retry, so the mutant was not actually tested.
 * invalid and error are excluded from the score; any error fails the gate.
 */
export type MutantStatus = 'killed' | 'survived' | 'invalid' | 'error';

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
    /** Mutants run, including invalid and errored ones. */
    total: number;
    killed: number;
    /** Mutants that did not compile; not in the score's denominator. */
    invalid?: number;
    /** Mutants whose runs hit sandbox errors; not in the score's denominator (and the gate fails). */
    errored?: number;
    /** killed / (total - invalid - errored); null when no valid mutant ran. */
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
    let changedSourceLines = 0;
    if (mcfg.enabled && approved.length) {
      const sourceDirs = Object.values(config.sandbox.services)
        .filter((svc) => svc.source)
        .map((svc) => join(svc.build ?? '.', svc.source!));
      const pathspecs = sourceDirs.map((d) => join(rel, d));
      const ranges = await changedLines(top, baseCo.sha, headCo.sha, pathspecs);
      let all: Mutant[] = [];
      for (const [file, r] of Object.entries(ranges)) {
        if (!languageOf(file) || isTestFile(file)) continue;
        changedSourceLines += r.reduce((n, [a, b]) => n + b - a + 1, 0);
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
            const r = await runMutantScenario(sb, s, tree, `mutant ${m.id}`, {
              language: languageOf(m.file),
              log,
            });
            if (r.kind === 'invalid') {
              report.status = 'invalid';
              report.detail = r.detail;
              break;
            }
            if (r.kind === 'error') {
              // keep going: a later scenario may still catch the mutant conclusively
              report.status = 'error';
              report.detail = r.detail;
              continue;
            }
            if (r.kind === 'broken' || r.run.passed !== baseline[i]) {
              report.status = 'killed';
              report.killed = true;
              report.killedBy = s.id;
              report.detail =
                r.kind === 'broken'
                  ? r.detail
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
                  ? `INVALID (does not compile): ${gist(report.detail)}`
                  : report.status === 'error'
                    ? `ERROR (sandbox failed, not tested): ${gist(report.detail)}`
                    : 'SURVIVED'
            }`,
          );
          mutants.push(report);
        }
      }
    }
    const outcome = mutationOutcome(mutants, mcfg.threshold, {
      othersFailing: failed.length > 0 || reasons.length > 0,
      changedSourceLines,
      allowNoMutants: mcfg.allowNoMutants,
    });
    const { killed, invalid, errored, score } = outcome;
    reasons.push(...outcome.reasons);

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
        errored,
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

/**
 * Score and verdict reasons of a mutation proof. Invalid (non-compiling) and
 * errored (sandbox failure) mutants are left out of the score. Fail-closed:
 * any errored mutant makes the proof inconclusive (an untested mutant must
 * not look caught), as does every mutant being invalid, and changed source
 * lines that yield no mutant at all (unless allowed). "Too weak" is only
 * reported when nothing else already fails the gate.
 */
export function mutationOutcome(
  mutants: Pick<MutantReport, 'status'>[],
  threshold: number,
  opts: { othersFailing?: boolean; changedSourceLines?: number; allowNoMutants?: boolean } = {},
): { killed: number; invalid: number; errored: number; score: number | null; reasons: string[] } {
  const count = (st: MutantStatus) => mutants.filter((m) => m.status === st).length;
  const killed = count('killed');
  const invalid = count('invalid');
  const errored = count('error');
  const valid = mutants.length - invalid - errored;
  const score = valid ? killed / valid : null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const reasons: string[] = [];
  if (!mutants.length && opts.changedSourceLines && !opts.allowNoMutants)
    reasons.push(
      `mutation proof unproven: ${plural(opts.changedSourceLines, 'changed source line')} but no mutants could be generated (set pluginConfig.gate.mutation.allowNoMutants: true to accept)`,
    );
  else if (errored) reasons.push(`mutation proof inconclusive: ${plural(errored, 'mutant run')} hit sandbox errors`);
  else if (mutants.length && !valid)
    reasons.push(`mutation proof inconclusive: all ${plural(mutants.length, 'mutant')} failed to compile`);
  else if (!opts.othersFailing && score !== null && score < threshold)
    reasons.push(
      `checks too weak: only ${killed}/${valid} deliberately broken versions were caught (threshold ${Math.round(threshold * 100)}%${invalid ? `; ${plural(invalid, 'mutant')} did not compile and ${invalid === 1 ? 'is' : 'are'} excluded` : ''})`,
    );
  return { killed, invalid, errored, score, reasons };
}

/**
 * ran: the scenario completed (compare its outcome to head's); invalid: the
 * mutant does not compile; broken: the mutant app crashed, exited or never got
 * ready, or broke a request (killed); error: the sandbox failed twice (not tested).
 */
export type MutantRun =
  | { kind: 'ran'; run: ScenarioRun }
  | { kind: 'invalid'; detail: string }
  | { kind: 'broken'; detail: string }
  | { kind: 'error'; detail: string };

/** Compiler error output of a service that builds at startup (`go build` / `dotnet build`). */
const COMPILE_ERROR: Partial<Record<Language, RegExp>> = {
  go: /\.go:\d+:\d+: |^# \S+\s*$/m,
  // compiler (CSnnnn) and analyzer errors (CA1822, IDE0059, SA1000…); not restore/SDK/MSBuild (NU…, NETSDK…, MSB…)
  csharp: /\berror CS\d{4}\b|: error (?!NU\d|NETSDK\d|MSB\d)[A-Z]{2,}\d{3,5}: /,
};

/**
 * Toolchain failures a source mutant cannot cause (dependency restore, SDK,
 * module download): a sandbox problem, not the mutant's.
 */
const TOOLCHAIN_ERROR: Partial<Record<Language, RegExp>> = {
  // module downloads also surface as `main.go:2:8: mod@v: Get "https://…": dial tcp …` (import position first);
  // only in module-fetch context: an app that dies dialing its own DB/fake at startup is a kill
  go: /no required module provides package|missing go\.sum entry|module lookup disabled|@v[^:\s]*: Get "https?:\/\/|\/@v\/|^go: .*: reading /m,
  csharp: /: error (NU|NETSDK|MSB)\d+: /,
};

/** The app process itself failed to come up (exit, crash, never ready). */
const APP_STARTUP_FAILURE = /exited during startup|timed out after \d+ms waiting for/;

/** Errors from talking to the app that mean the app broke the request (reset/closed/refused/hung). */
const APP_REQUEST_FAILURE =
  /ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED|other side closed|socket hang up|terminated/i;

function errorText(e: unknown): string {
  const err = e as (Error & { cause?: { message?: string; code?: string } }) | undefined;
  return [err?.message ?? String(e), err?.cause?.code, err?.cause?.message].filter(Boolean).join(' ');
}

/** A request to the app failed because of the app (not Docker, a fake, the database or Sluice). */
export function isAppRequestError(e: unknown): boolean {
  const name = (e as Error | undefined)?.name;
  if (name === 'TimeoutError') return true; // AbortSignal.timeout on the request: the app hung
  return APP_REQUEST_FAILURE.test(errorText(e));
}

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

type Attempt = MutantRun | { kind: 'sandbox'; detail: string };

/**
 * Run one scenario against a mutant tree and classify what went wrong:
 *
 * - the sandbox reset onto the tree throws with compiler output for the
 *   mutant's language (Go `file.go:N:M:` / `# pkg`, C# `error CSnnnn`) →
 *   `invalid` (never for JS/TS, which has no build step);
 * - the app exits, crashes or never gets ready at startup → `broken` (killed);
 * - after startup, a request to the app is reset/refused/closed or times out
 *   → `broken` (killed); HTTP 5xx are ordinary responses, judged by the
 *   scenario's expectations;
 * - anything else (Docker, the database, fakes, dependency restore, Sluice
 *   itself) is a sandbox error: the scenario is retried once; a second
 *   failure is `error` — not tested, never counted as caught.
 */
export async function runMutantScenario(
  sb: Sandbox,
  scenario: Scenario,
  tree: string,
  label: string,
  opts: { language?: Language; log?: (msg: string) => void } = {},
): Promise<MutantRun> {
  const first = await attemptMutantScenario(sb, scenario, tree, label, opts.language);
  if (first.kind !== 'sandbox') return first;
  opts.log?.(`  ${label}: sandbox error, retrying ${scenario.id}: ${firstLine(first.detail)}`);
  const second = await attemptMutantScenario(sb, scenario, tree, label, opts.language);
  // fail closed: an untested mutant is never counted as caught
  return second.kind === 'sandbox'
    ? { kind: 'error', detail: `sandbox error (after retry): ${second.detail}` }
    : second;
}

async function attemptMutantScenario(
  sb: Sandbox,
  scenario: Scenario,
  tree: string,
  label: string,
  language: Language | undefined,
): Promise<Attempt> {
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
    if (failedStartup) {
      const full = errorText(startupError);
      const detail = startupDetail(startupError);
      const compile = language && COMPILE_ERROR[language];
      const toolchain = language && TOOLCHAIN_ERROR[language];
      if (toolchain && toolchain.test(full)) return { kind: 'sandbox', detail };
      if (compile && compile.test(full)) return { kind: 'invalid', detail };
      if (APP_STARTUP_FAILURE.test(full)) return { kind: 'broken', detail: `app did not start: ${detail}` };
      return { kind: 'sandbox', detail };
    }
    const detail = firstLine(errorText(e));
    if (isAppRequestError(e)) return { kind: 'broken', detail: `scenario errored: ${detail}` };
    return { kind: 'sandbox', detail };
  }
}

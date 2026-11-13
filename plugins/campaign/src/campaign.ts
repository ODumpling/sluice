/**
 * Multi-repo migration campaigns: an ordered list of steps, each applied to a
 * set of repositories on a `campaign/<id>` branch and gated by evidence
 * (tests in no-network containers against the *current* state of every repo,
 * structural rule checks). A failing step is rolled back and halts the
 * campaign; a `destructive` step runs only when every earlier step has passed
 * for every repository. State is persisted so campaigns resume.
 */
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { scanTree, validateRule } from '@sluice-dev/policy';
import { git, runInContainer } from '@sluice-dev/sandbox';
import { applyCodemod, type Codemod } from './codemod.js';

export type Evidence =
  | { tests: string; scope?: 'repo' | 'all' }
  | { rule: { language: 'javascript' | 'typescript'; pattern: string; expect: 'none' } };

export interface StepDef {
  id: string;
  title?: string;
  repos: string[];
  destructive?: boolean;
  apply: { copy: string } | { codemod: Codemod } | { command: string };
  evidence: Evidence[];
}

export interface CampaignDef {
  id: string;
  title: string;
  repos: { name: string; path: string }[];
  steps: StepDef[];
  evidenceImage?: string;
}

export type StepStatus = 'pending' | 'passed' | 'failed' | 'rolled_back' | 'blocked';

export interface EvidenceResult {
  kind: 'tests' | 'rule';
  repo: string;
  passed: boolean;
  detail: string;
}

export interface StepRun {
  status: StepStatus;
  before?: string;
  after?: string;
  changed: string[];
  evidence: EvidenceResult[];
  reason?: string;
}

export interface CampaignState {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'blocked';
  reason?: string;
  branch: string;
  repos: Record<string, { baseSha: string }>;
  steps: Record<string, Record<string, StepRun>>;
  log: string[];
}

export interface LoadedCampaign {
  file: string;
  dir: string;
  def: CampaignDef;
  stateFile: string;
  repoPath(name: string): string;
}

export function validateCampaign(raw: unknown, source = 'campaign'): CampaignDef {
  const c = raw as CampaignDef;
  if (!c?.id || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) throw new Error(`${source}: id required (kebab-case)`);
  if (!Array.isArray(c.repos) || !c.repos.length) throw new Error(`${source}: repos required`);
  const names = new Set(c.repos.map((r) => r.name));
  if (names.size !== c.repos.length) throw new Error(`${source}: duplicate repo names`);
  if (!Array.isArray(c.steps) || !c.steps.length) throw new Error(`${source}: steps required`);
  const ids = new Set<string>();
  for (const s of c.steps) {
    if (!s.id || ids.has(s.id)) throw new Error(`${source}: step ids must be unique (${s.id})`);
    ids.add(s.id);
    for (const r of s.repos ?? [])
      if (!names.has(r)) throw new Error(`${source}: step ${s.id} targets unknown repo ${r}`);
    if (!s.repos?.length) throw new Error(`${source}: step ${s.id} needs repos`);
    const kinds = ['copy', 'codemod', 'command'].filter((k) => k in (s.apply ?? {}));
    if (kinds.length !== 1) throw new Error(`${source}: step ${s.id} apply needs exactly one of copy/codemod/command`);
    if (!Array.isArray(s.evidence) || !s.evidence.length)
      throw new Error(`${source}: step ${s.id} has no evidence — every step must be evidence-gated`);
    for (const e of s.evidence)
      if ('rule' in e)
        validateRule(
          { id: 'campaign-rule', message: 'm', severity: 'error', language: e.rule.language, pattern: e.rule.pattern },
          `${source}: step ${s.id}`,
        );
  }
  return c;
}

export function loadCampaign(file: string): LoadedCampaign {
  const abs = resolve(file);
  const dir = dirname(abs);
  const def = validateCampaign(parseYaml(readFileSync(abs, 'utf8')), abs);
  return {
    file: abs,
    dir,
    def,
    stateFile: join(dir, '.sluice', 'campaigns', `${def.id}.json`),
    repoPath: (name) => resolve(dir, def.repos.find((r) => r.name === name)!.path),
  };
}

export function readState(c: LoadedCampaign): CampaignState | undefined {
  return existsSync(c.stateFile) ? (JSON.parse(readFileSync(c.stateFile, 'utf8')) as CampaignState) : undefined;
}

function saveState(c: LoadedCampaign, s: CampaignState): void {
  mkdirSync(dirname(c.stateFile), { recursive: true });
  writeFileSync(c.stateFile, JSON.stringify(s, null, 2) + '\n');
}

const gitc = (repo: string, ...args: string[]) =>
  git(
    ['-c', 'user.email=campaign@sluice.dev', '-c', 'user.name=sluice-campaign', '-c', 'commit.gpgsign=false', ...args],
    repo,
  );

function shell(cmd: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((r) =>
    execFile('sh', ['-c', cmd], { cwd, maxBuffer: 16 * 1024 * 1024 }, (e, so, se) =>
      r({ code: e ? 1 : 0, output: String(so) + String(se) }),
    ),
  );
}

/** Snapshot every repo's campaign branch side by side (consumers import siblings by relative path). */
async function composeWorkspace(c: LoadedCampaign): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), 'sluice-campaign-'));
  for (const r of c.def.repos) {
    const target = join(ws, r.name);
    mkdirSync(target, { recursive: true });
    const tar = await new Promise<Buffer>((res, rej) =>
      execFile(
        'git',
        ['archive', '--format=tar', 'HEAD'],
        { cwd: c.repoPath(r.name), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
        (e, out) => (e ? rej(e) : res(out)),
      ),
    );
    await new Promise<void>((res, rej) => {
      const t = execFile('tar', ['-x', '-C', target], (e) => (e ? rej(e) : res()));
      t.stdin!.end(tar);
    });
  }
  return ws;
}

async function gather(
  c: LoadedCampaign,
  step: StepDef,
  repo: string,
  log: (m: string) => void,
): Promise<EvidenceResult[]> {
  const out: EvidenceResult[] = [];
  for (const e of step.evidence) {
    if ('tests' in e) {
      const targets = e.scope === 'all' ? c.def.repos.map((r) => r.name) : [repo];
      const ws = await composeWorkspace(c);
      for (const t of targets) {
        const r = await runInContainer(ws, `cd ${t} && ${e.tests}`, c.def.evidenceImage ?? 'node:22-alpine', 120);
        out.push({
          kind: 'tests',
          repo: t,
          passed: r.passed,
          detail: r.passed ? `${e.tests}: pass` : `${e.tests}: exit ${r.exitCode}\n${r.outputTail}`,
        });
        log(`    evidence tests ${t}: ${r.passed ? 'pass' : 'FAIL'}`);
      }
    } else {
      const findings = scanTree(
        [
          {
            id: 'campaign-rule',
            message: 'campaign invariant',
            severity: 'error',
            language: e.rule.language,
            pattern: e.rule.pattern,
          },
        ],
        c.repoPath(repo),
      );
      const passed = findings.length === 0;
      out.push({
        kind: 'rule',
        repo,
        passed,
        detail: passed ? `no ${e.rule.pattern}` : findings.map((f) => `${f.file}:${f.line} ${f.text}`).join('\n'),
      });
      log(`    evidence rule ${e.rule.pattern} in ${repo}: ${passed ? 'clean' : `${findings.length} left`}`);
    }
  }
  return out;
}

async function apply(c: LoadedCampaign, step: StepDef, repo: string): Promise<string[]> {
  const dir = c.repoPath(repo);
  if ('copy' in step.apply) cpSync(resolve(c.dir, step.apply.copy), dir, { recursive: true });
  else if ('codemod' in step.apply) applyCodemod(dir, step.apply.codemod);
  else {
    const r = await shell(step.apply.command, dir);
    if (r.code !== 0) throw new Error(`apply command failed: ${r.output.slice(-2000)}`);
  }
  return (await git(['status', '--porcelain'], dir))
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .sort();
}

export interface RunOptions {
  log?: (m: string) => void;
  /** Stop after this step (inclusive). */
  until?: string;
}

export async function runCampaign(c: LoadedCampaign, o: RunOptions = {}): Promise<CampaignState> {
  const log = (m: string) => {
    state.log.push(m);
    o.log?.(m);
  };
  const branch = `campaign/${c.def.id}`;
  const state: CampaignState = readState(c) ?? {
    id: c.def.id,
    status: 'running',
    branch,
    repos: {},
    steps: {},
    log: [],
  };
  if (state.status === 'completed') return state;
  state.status = 'running';
  delete state.reason;
  for (const r of c.def.repos) {
    const dir = c.repoPath(r.name);
    if (!existsSync(join(dir, '.git'))) throw new Error(`repo ${r.name} (${dir}) is not a git repository`);
    const dirty = (await git(['status', '--porcelain'], dir)).trim();
    if (dirty) throw new Error(`repo ${r.name} has uncommitted changes`);
    const branches = (await git(['branch', '--list', branch], dir)).trim();
    if (!branches) {
      state.repos[r.name] = { baseSha: (await git(['rev-parse', 'HEAD'], dir)).trim() };
      await git(['checkout', '-q', '-b', branch], dir);
    } else await git(['checkout', '-q', branch], dir);
  }
  try {
    for (const step of c.def.steps) {
      const runs = (state.steps[step.id] ??= {});
      if (step.destructive) {
        const earlier = c.def.steps.slice(0, c.def.steps.indexOf(step));
        const unmet = earlier.flatMap((s) =>
          s.repos.filter((r) => state.steps[s.id]?.[r]?.status !== 'passed').map((r) => `${r}/${s.id}`),
        );
        if (unmet.length) {
          state.status = 'blocked';
          state.reason = `destructive step ${step.id} blocked: ${unmet.join(', ')} not passed with evidence`;
          for (const r of step.repos) runs[r] = { status: 'blocked', changed: [], evidence: [], reason: state.reason };
          log(state.reason);
          return state;
        }
      }
      for (const repo of step.repos) {
        if (runs[repo]?.status === 'passed') continue;
        const dir = c.repoPath(repo);
        const before = (await git(['rev-parse', 'HEAD'], dir)).trim();
        log(`${step.id} @ ${repo}${step.destructive ? ' (destructive)' : ''}`);
        let changed: string[] = [];
        let evidence: EvidenceResult[] = [];
        let error: string | undefined;
        try {
          changed = await apply(c, step, repo);
          if (changed.length) {
            await gitc(dir, 'add', '-A');
            await gitc(dir, 'commit', '-qm', `campaign ${c.def.id}: ${step.id}${step.title ? ` — ${step.title}` : ''}`);
          }
          evidence = await gather(c, step, repo, log);
        } catch (e) {
          error = (e as Error).message;
        }
        const failed =
          error ??
          evidence.filter((e) => !e.passed).map((e) => `${e.kind} in ${e.repo}: ${e.detail.split('\n')[0]}`)[0];
        if (failed) {
          // Roll this step back in this repo; the campaign halts here.
          await git(['reset', '-q', '--hard', before], dir);
          await git(['clean', '-qfd'], dir);
          runs[repo] = { status: 'rolled_back', before, changed, evidence, reason: failed };
          state.status = 'failed';
          state.reason = `${step.id} failed in ${repo}: ${failed} (rolled back)`;
          log(state.reason);
          // Every later destructive step is explicitly blocked by this failure.
          for (const later of c.def.steps.slice(c.def.steps.indexOf(step) + 1).filter((x) => x.destructive)) {
            const lr = (state.steps[later.id] ??= {});
            for (const r of later.repos)
              lr[r] = {
                status: 'blocked',
                changed: [],
                evidence: [],
                reason: `blocked: ${repo}/${step.id} did not pass`,
              };
            log(`${later.id} (destructive) blocked: ${repo}/${step.id} did not pass`);
          }
          return state;
        }
        runs[repo] = {
          status: 'passed',
          before,
          after: (await git(['rev-parse', 'HEAD'], dir)).trim(),
          changed,
          evidence,
        };
        log(`  passed (${changed.length} file(s) changed)`);
      }
      if (o.until === step.id) return state;
    }
    state.status = 'completed';
    log(`campaign ${c.def.id} completed`);
    return state;
  } finally {
    saveState(c, state);
  }
}

/** Manually roll back a passed step in one repo (and invalidate every later step there). */
export async function rollbackStep(c: LoadedCampaign, stepId: string, repo: string): Promise<CampaignState> {
  const state = readState(c);
  if (!state) throw new Error('campaign has not run');
  const run = state.steps[stepId]?.[repo];
  if (!run?.before) throw new Error(`step ${stepId} has not run in ${repo}`);
  const dir = c.repoPath(repo);
  await git(['checkout', '-q', state.branch], dir);
  await git(['reset', '-q', '--hard', run.before], dir);
  const idx = c.def.steps.findIndex((s) => s.id === stepId);
  for (const s of c.def.steps.slice(idx))
    if (state.steps[s.id]?.[repo])
      state.steps[s.id]![repo] = {
        ...state.steps[s.id]![repo]!,
        status: 'rolled_back',
        reason: `manual rollback of ${stepId}`,
      };
  state.status = 'running';
  state.log.push(`rolled back ${stepId} in ${repo} to ${run.before.slice(0, 8)}`);
  saveState(c, state);
  return state;
}

export function renderStatus(c: LoadedCampaign, s: CampaignState | undefined): string {
  const lines = [`campaign ${c.def.id}: ${s?.status ?? 'not started'}${s?.reason ? ` — ${s.reason}` : ''}`];
  for (const step of c.def.steps) {
    const cells = step.repos.map((r) => `${r}=${s?.steps[step.id]?.[r]?.status ?? 'pending'}`);
    lines.push(`  ${step.id}${step.destructive ? ' (destructive)' : ''}: ${cells.join('  ')}`);
  }
  return lines.join('\n') + '\n';
}

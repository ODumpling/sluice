/**
 * Run agent configs over a task dataset and compare pass rate, cost and wall
 * time. Agents are arbitrary commands (Claude Code, Codex, Cursor CLI, a
 * script…) run in a fresh checkout of the task's base commit; evaluation runs
 * the hidden tests in a container with no network.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '@sluice-dev/sandbox';
import type { BenchTask } from './mine.js';
import { datasetHash, taskRunOptions } from './mine.js';
import { extractTree, initRepo, pool, runTestsInContainer, writeFiles } from './tree.js';

export interface AgentConfig {
  name: string;
  /** Shell command run in the task workspace. */
  command: string;
  timeoutSec?: number;
  env?: Record<string, string>;
  /** Give the agent the reference patch (only for oracle/calibration agents). */
  oracle?: boolean;
}

export interface AgentRun {
  task: string;
  agent: string;
  /** Hidden tests passed after the agent's change. */
  passed: boolean;
  agentExitCode: number;
  timedOut: boolean;
  costUsd: number;
  tokens: number;
  /** Agent wall time (ms). */
  wallMs: number;
  evalMs: number;
  changedFiles: string[];
  outputTail: string;
}

export interface AgentSummary {
  agent: string;
  tasks: number;
  passed: number;
  passRate: number;
  costUsd: number;
  costPerSolved: number | null;
  wallMsTotal: number;
  wallMsMedian: number;
}

export interface BenchReport {
  format: 'sluice-bench-report/1';
  dataset: { name: string; hash: string; tasks: number; repo: string };
  agents: { name: string; configHash: string }[];
  summaries: AgentSummary[];
  runs: AgentRun[];
}

export const PROMPT_TEMPLATE = `You are working in a git checkout of {repo} at commit {base}.
Make the change described below. Do not modify tests unless asked; hidden tests will be run.

{problem}
`;

export function taskPrompt(t: BenchTask): string {
  return PROMPT_TEMPLATE.replace('{repo}', t.repo)
    .replace('{base}', t.base.slice(0, 12))
    .replace('{problem}', t.problem);
}

function runAgentCommand(cmd: string, cwd: string, env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ code: number; timedOut: boolean; output: string }>((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    let timedOut = false;
    const on = (d: Buffer) => {
      output += d.toString();
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, timedOut, output });
    });
  });
}

/**
 * Cost/tokens: from $SLUICE_AGENT_REPORT ({cost_usd, input_tokens, output_tokens})
 * or, failing that, the last JSON line of output carrying `total_cost_usd`
 * (Claude Code `--output-format json`) / `usage`.
 */
export function extractCost(reportFile: string, output: string): { costUsd: number; tokens: number } {
  const fromObj = (o: Record<string, unknown>) => {
    const usage = (o.usage ?? {}) as Record<string, number>;
    const cost = Number(o.cost_usd ?? o.total_cost_usd ?? 0);
    const tokens =
      Number(o.tokens ?? 0) ||
      Number(o.input_tokens ?? usage.input_tokens ?? 0) + Number(o.output_tokens ?? usage.output_tokens ?? 0);
    return { costUsd: Number.isFinite(cost) ? cost : 0, tokens: Number.isFinite(tokens) ? tokens : 0 };
  };
  if (existsSync(reportFile)) {
    try {
      return fromObj(JSON.parse(readFileSync(reportFile, 'utf8')) as Record<string, unknown>);
    } catch {
      /* fall through */
    }
  }
  for (const l of output.trim().split('\n').reverse()) {
    if (!l.startsWith('{')) continue;
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      if ('total_cost_usd' in o || 'cost_usd' in o || 'usage' in o) return fromObj(o);
    } catch {
      /* not json */
    }
  }
  return { costUsd: 0, tokens: 0 };
}

const trace = (msg: string) => {
  if (process.env.SLUICE_TRACE_BENCH) process.stderr.write(`[bench ${new Date().toISOString()}] ${msg}\n`);
};

export async function runTask(repoDir: string, t: BenchTask, a: AgentConfig): Promise<AgentRun> {
  trace(`${a.name} ${t.id} extract`);
  const ws = await extractTree(repoDir, t.base, 'sluice-bench-ws-');
  const tag = createHash('sha1').update(ws).digest('hex').slice(0, 8);
  const report = join(ws, '..', `${tag}-agent-report.json`);
  const gold = join(ws, '..', `${tag}-gold.patch`);
  try {
    trace(`${a.name} ${t.id} init`);
    await initRepo(ws);
    const env: Record<string, string> = {
      ...a.env,
      SLUICE_TASK_ID: t.id,
      SLUICE_TASK_REPO: t.repo,
      SLUICE_TASK_PROMPT: taskPrompt(t),
      SLUICE_AGENT_REPORT: report,
    };
    if (a.oracle) {
      writeFileSync(gold, t.goldPatch);
      env.SLUICE_TASK_GOLD_PATCH = gold;
    }
    trace(`${a.name} ${t.id} agent`);
    const started = Date.now();
    const r = await runAgentCommand(a.command, ws, env, (a.timeoutSec ?? 1800) * 1000);
    const wallMs = Date.now() - started;
    const { costUsd, tokens } = extractCost(report, r.output);
    const changed = (await git(['status', '--porcelain'], ws))
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3));
    // hidden tests overwrite whatever the agent did to test files
    writeFiles(ws, t.tests);
    for (const [p, c] of Object.entries(t.tests)) if (c === null) rmSync(join(ws, p), { force: true });
    trace(`${a.name} ${t.id} eval`);
    const ev = await runTestsInContainer(ws, t.testCommand, t.image, 120, taskRunOptions(t));
    trace(`${a.name} ${t.id} done`);
    return {
      task: t.id,
      agent: a.name,
      passed: ev.passed && !r.timedOut,
      agentExitCode: r.code,
      timedOut: r.timedOut,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      tokens,
      wallMs,
      evalMs: ev.durationMs,
      changedFiles: changed.sort(),
      outputTail: r.output.split('\n').slice(-10).join('\n'),
    };
  } finally {
    rmSync(report, { force: true });
    rmSync(gold, { force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

export function summarize(agent: string, runs: AgentRun[]): AgentSummary {
  const mine = runs.filter((r) => r.agent === agent);
  const passed = mine.filter((r) => r.passed).length;
  const cost = Math.round(mine.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6;
  return {
    agent,
    tasks: mine.length,
    passed,
    passRate: mine.length ? passed / mine.length : 0,
    costUsd: cost,
    costPerSolved: passed ? Math.round((cost / passed) * 1e6) / 1e6 : null,
    wallMsTotal: mine.reduce((s, r) => s + r.wallMs, 0),
    wallMsMedian: median(mine.map((r) => r.wallMs)),
  };
}

export async function runBench(o: {
  repoDir: string;
  name: string;
  tasks: BenchTask[];
  agents: AgentConfig[];
  concurrency?: number;
  log?: (m: string) => void;
}): Promise<BenchReport> {
  const jobs = o.agents.flatMap((a) => o.tasks.map((t) => ({ a, t })));
  const runs = await pool(jobs, o.concurrency ?? 4, async ({ a, t }) => {
    const r = await runTask(o.repoDir, t, a);
    o.log?.(`${a.name} ${t.id}: ${r.passed ? 'PASS' : 'FAIL'} (${r.wallMs}ms, $${r.costUsd})`);
    return r;
  });
  return {
    format: 'sluice-bench-report/1',
    dataset: { name: o.name, hash: datasetHash(o.tasks), tasks: o.tasks.length, repo: o.tasks[0]?.repo ?? '' },
    agents: o.agents.map((a) => ({
      name: a.name,
      configHash: createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0, 12),
    })),
    summaries: o.agents.map((a) => summarize(a.name, runs)),
    runs,
  };
}

/** The parts of a report that must be identical across re-runs (everything except timings). */
export function reproducibleView(r: BenchReport): unknown {
  return {
    dataset: r.dataset,
    agents: r.agents,
    summaries: r.summaries.map(({ wallMsTotal: _a, wallMsMedian: _b, ...s }) => s),
    runs: r.runs.map(({ wallMs: _w, evalMs: _e, outputTail: _o, ...x }) => x),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function renderBenchMarkdown(r: BenchReport): string {
  const rows = r.summaries.map(
    (s) =>
      `| ${s.agent} | ${s.passed}/${s.tasks} | ${pct(s.passRate)} | $${s.costUsd.toFixed(4)} | ${s.costPerSolved === null ? '—' : `$${s.costPerSolved.toFixed(4)}`} | ${secs(s.wallMsMedian)} | ${secs(s.wallMsTotal)} |`,
  );
  const agents = r.summaries.map((s) => s.agent);
  const byTask = new Map<string, Map<string, AgentRun>>();
  for (const run of r.runs) {
    if (!byTask.has(run.task)) byTask.set(run.task, new Map());
    byTask.get(run.task)!.set(run.agent, run);
  }
  const taskRows = [...byTask].map(
    ([t, m]) => `| ${t} | ${agents.map((a) => (m.get(a)?.passed ? '✅' : '❌')).join(' | ')} |`,
  );
  return [
    `# Sluice bench: ${r.dataset.name}`,
    '',
    `Dataset \`${r.dataset.hash}\` — ${r.dataset.tasks} tasks mined from ${r.dataset.repo}.`,
    '',
    '| agent | solved | pass rate | cost | cost / solved | median wall time | total wall time |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `| task | ${agents.join(' | ')} |`,
    `|---|${agents.map(() => '---').join('|')}|`,
    ...taskRows,
    '',
  ].join('\n');
}

export function writeDataset(file: string, tasks: BenchTask[]): void {
  writeFileSync(file, tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
}

export function readDataset(file: string): BenchTask[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as BenchTask);
}

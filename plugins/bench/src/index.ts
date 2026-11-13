import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { definePlugin, type PluginContext } from '@sluice-dev/plugin-api';
import { git } from '@sluice-dev/sandbox';
import {
  readDataset,
  renderBenchMarkdown,
  runBench,
  writeDataset,
  type AgentConfig,
  type BenchReport,
} from './bench.js';
import { mineTasks, type MineResult } from './mine.js';

export * from './bench.js';
export * from './mine.js';
export { extractTree, runTestsInContainer, pool } from './tree.js';

export interface BenchConfig {
  name: string;
  source: { bundle?: string; path?: string; repo: string; ref?: string };
  mine: {
    limit: number;
    maxCandidates?: number;
    /** Path prefixes counted as source (default: non-test files of the detected toolchain's languages). */
    source?: string[];
    /** Test-file regex (default: the toolchain convention — `_test.go`, `*Tests/…cs`, `*.test.js`…). */
    tests?: string;
    /** Default: the detected toolchain's (`npm test --silent`, `go test ./...`, `dotnet test --nologo`). */
    testCommand?: string;
    /** Default: the detected toolchain's image. */
    image?: string;
    /** Dependency prepare: command, `true` (toolchain default) or `false`. Default: Go/.NET when needed. */
    prepare?: string | boolean;
    concurrency?: number;
    timeoutSec?: number;
  };
  agents: AgentConfig[];
  concurrency?: number;
}

export interface LoadedBench {
  file: string;
  dir: string;
  config: BenchConfig;
  /** .sluice/bench/<name> next to the config */
  stateDir: string;
  datasetFile: string;
}

export function loadBenchConfig(file: string): LoadedBench {
  const abs = resolve(file);
  const dir = dirname(abs);
  const raw = parseYaml(readFileSync(abs, 'utf8')) as BenchConfig;
  if (!raw?.name || !raw.source?.repo || !raw.mine || !Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error(`${abs}: needs name, source.repo, mine and at least one agent`);
  }
  if (!raw.source.bundle && !raw.source.path) throw new Error(`${abs}: source needs bundle or path`);
  const names = new Set<string>();
  for (const a of raw.agents) {
    if (!a.name || !a.command) throw new Error(`${abs}: every agent needs name and command`);
    if (names.has(a.name)) throw new Error(`${abs}: duplicate agent ${a.name}`);
    names.add(a.name);
    a.command = a.command.split('${benchDir}').join(dir);
  }
  const stateDir = join(dir, '.sluice', 'bench', raw.name);
  return { file: abs, dir, config: raw, stateDir, datasetFile: join(stateDir, 'tasks.jsonl') };
}

/** Local clone of the task source repository (from a bundle or a path). */
export async function sourceRepo(b: LoadedBench): Promise<string> {
  const s = b.config.source;
  if (s.path) return resolve(b.dir, s.path);
  const target = join(b.stateDir, 'repo');
  if (!existsSync(join(target, '.git'))) {
    mkdirSync(b.stateDir, { recursive: true });
    await git(['clone', '--quiet', resolve(b.dir, s.bundle!), target], b.dir);
  }
  return target;
}

export async function mine(b: LoadedBench, log?: (m: string) => void): Promise<MineResult> {
  const repoDir = await sourceRepo(b);
  const m = b.config.mine;
  const result = await mineTasks({
    repoDir,
    repo: b.config.source.repo,
    ref: b.config.source.ref ? `origin/${b.config.source.ref}` : 'HEAD',
    source: m.source,
    tests: m.tests,
    testCommand: m.testCommand,
    image: m.image,
    prepare: m.prepare,
    limit: m.limit,
    maxCandidates: m.maxCandidates,
    concurrency: m.concurrency,
    timeoutSec: m.timeoutSec,
    log,
  });
  mkdirSync(b.stateDir, { recursive: true });
  writeDataset(b.datasetFile, result.tasks);
  return result;
}

export async function bench(
  b: LoadedBench,
  opts: { agents?: string[]; limit?: number; log?: (m: string) => void } = {},
): Promise<{ report: BenchReport; json: string; markdown: string }> {
  if (!existsSync(b.datasetFile)) await mine(b, opts.log);
  let tasks = readDataset(b.datasetFile);
  if (opts.limit) tasks = tasks.slice(0, opts.limit);
  const agents = opts.agents?.length ? b.config.agents.filter((a) => opts.agents!.includes(a.name)) : b.config.agents;
  const report = await runBench({
    repoDir: await sourceRepo(b),
    name: b.config.name,
    tasks,
    agents,
    concurrency: b.config.concurrency,
    log: opts.log,
  });
  const out = join(b.stateDir, 'reports');
  mkdirSync(out, { recursive: true });
  const stamp = `${report.dataset.hash}-${agents.map((a) => a.name).join('+')}`;
  const json = join(out, `${stamp}.json`);
  const markdown = join(out, `${stamp}.md`);
  writeFileSync(json, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(markdown, renderBenchMarkdown(report));
  return { report, json, markdown };
}

function configPath(ctx: PluginContext, opt: unknown): string {
  const f = typeof opt === 'string' ? opt : 'bench.yaml';
  return resolve(ctx.cwd, f);
}

export default definePlugin({
  name: '@sluice-dev/plugin-bench',
  version: '0.1.0',
  apiVersion: '^1.0.0',
  description: 'Mine merged changes into eval tasks; compare agent configs on pass rate, cost and wall time',
  commands: [
    {
      path: ['bench', 'mine'],
      summary: 'Mine eval tasks from a repository history (hidden tests fail before, pass after)',
      options: [{ flags: '-c, --config <file>', description: 'bench config', default: 'bench.yaml' }],
      async run({ options }, ctx) {
        const b = loadBenchConfig(configPath(ctx, options.config));
        const r = await mine(b, (m) => ctx.stderr.write(`sluice: ${m}\n`));
        ctx.stdout.write(`mined ${r.tasks.length} task(s) from ${r.scanned} candidate commit(s) -> ${b.datasetFile}\n`);
        for (const x of r.rejected) ctx.stdout.write(`  rejected ${x.commit.slice(0, 8)}: ${x.reason}\n`);
        return r.tasks.length > 0 ? 0 : 1;
      },
    },
    {
      path: ['bench', 'run'],
      summary: 'Run agent configs over the mined tasks and compare pass rate, cost and wall time',
      options: [
        { flags: '-c, --config <file>', description: 'bench config', default: 'bench.yaml' },
        { flags: '--agent <name...>', description: 'only these agents' },
        { flags: '--limit <n>', description: 'first N tasks only' },
        { flags: '--json', description: 'print the JSON report' },
      ],
      async run({ options }, ctx) {
        const b = loadBenchConfig(configPath(ctx, options.config));
        const { report, json, markdown } = await bench(b, {
          agents: options.agent as string[] | undefined,
          limit: options.limit ? Number(options.limit) : undefined,
          log: (m) => ctx.logger.info(m),
        });
        if (options.json) ctx.stdout.write(JSON.stringify(report, null, 2) + '\n');
        else ctx.stdout.write(renderBenchMarkdown(report) + `\nreport: ${json}\n        ${markdown}\n`);
        return 0;
      },
    },
  ],
});

/**
 * Mine a repository's history into eval tasks (SWE-bench style): a commit that
 * changes source and tests becomes a task whose hidden tests FAIL on the
 * parent and PASS on the commit. Validation runs the tests in containers with
 * no network.
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultPrepare,
  detectToolchain,
  inRoot,
  isDependencyManifest,
  isToolchainSourceFile,
  isToolchainTestFile,
  type DetectedToolchain,
} from '@sluice-dev/lang';
import { git } from '@sluice-dev/sandbox';
import { extractTree, pool, runTestsInContainer, writeFiles } from './tree.js';

export interface BenchTask {
  id: string;
  repo: string;
  /** Parent commit: the agent's starting point. */
  base: string;
  /** The merged commit the task was mined from. */
  commit: string;
  problem: string;
  /** Hidden tests: test files at the commit (null = deleted). */
  tests: Record<string, string | null>;
  /** Reference solution: source diff base..commit, excluding tests. */
  goldPatch: string;
  testCommand: string;
  image: string;
  /** Dependency prepare command (run with network at image build time; tests stay offline). */
  prepare?: string;
  /** Environment for prepare and test runs. */
  env?: Record<string, string>;
}

/** Container options for a task's test runs (prepared image when the task has a prepare step). */
export function taskRunOptions(t: Pick<BenchTask, 'prepare' | 'env'>): Parameters<typeof runTestsInContainer>[4] {
  return {
    env: t.env,
    prepare: t.prepare ? { command: t.prepare, manifest: isDependencyManifest, env: t.env } : undefined,
  };
}

export interface MineOptions {
  repoDir: string;
  /** Repository label stored in tasks (e.g. "marcbachmann/cel-js"). */
  repo: string;
  ref?: string;
  /** Path prefixes counted as source (default: non-test files of the toolchain's languages). */
  source?: string[];
  /** Regex (string) for test files (default: the toolchain's test-file convention). */
  tests?: string;
  /** Default: the detected toolchain's test command. */
  testCommand?: string;
  /** Default: the detected toolchain's image. */
  image?: string;
  /**
   * Dependency prepare: a command, `true` (toolchain default) or `false` (none).
   * Default: the toolchain default when the tree needs one (Go modules with
   * requirements, .NET projects); none for Node.
   */
  prepare?: string | boolean;
  limit: number;
  /** Stop scanning after this many candidate commits. */
  maxCandidates?: number;
  concurrency?: number;
  /** Per test-run deadline while validating (hung suites are rejected). */
  timeoutSec?: number;
  log?: (m: string) => void;
}

export interface MineResult {
  tasks: BenchTask[];
  scanned: number;
  rejected: { commit: string; reason: string }[];
}

export interface ResolvedMining {
  toolchain?: DetectedToolchain;
  image: string;
  testCommand: string;
  prepare?: string;
  env?: Record<string, string>;
  isTest: (f: string) => boolean;
  isSource: (f: string) => boolean;
}

/** Fill mining defaults from the toolchain detected at the repository root at `ref`. */
export async function resolveMining(o: MineOptions): Promise<ResolvedMining> {
  const tree = await extractTree(o.repoDir, o.ref ?? 'HEAD');
  try {
    const toolchain = detectToolchain(tree);
    // toolchain defaults run at the detected project root (e.g. `cd backend && go test ./...`)
    const root = toolchain?.root ?? '.';
    const testCommand = o.testCommand ?? (toolchain && inRoot(root, toolchain.testCommand));
    if (!testCommand)
      throw new Error(
        `no toolchain detected in ${o.repo} at ${o.ref ?? 'HEAD'}; set mine.testCommand (and mine.image)`,
      );
    let prepare: string | undefined;
    if (typeof o.prepare === 'string') prepare = o.prepare;
    else if (o.prepare === true) {
      if (!toolchain) throw new Error('mine.prepare: true needs a detected toolchain; give the command instead');
      prepare = inRoot(root, toolchain.prepareCommand);
    } else if (o.prepare === undefined) {
      const p = defaultPrepare(toolchain, join(tree, root));
      prepare = p && inRoot(root, p);
    }
    const env = toolchain && Object.keys(toolchain.env).length ? toolchain.env : undefined;
    const testRe = o.tests ? new RegExp(o.tests) : undefined;
    const isTest = testRe ? (f: string) => testRe.test(f) : (f: string) => isToolchainTestFile(toolchain, f);
    const isSource = o.source
      ? (f: string) => o.source!.some((s) => f.startsWith(s)) && !isTest(f)
      : (f: string) => isToolchainSourceFile(toolchain, f) && !isTest(f);
    return {
      toolchain,
      image: o.image ?? toolchain?.image ?? 'node:22-alpine',
      testCommand,
      prepare,
      env,
      isTest,
      isSource,
    };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

export async function mineTasks(o: MineOptions): Promise<MineResult> {
  const log = o.log ?? (() => {});
  const m = await resolveMining(o);
  const { image, testCommand } = m;
  const run = taskRunOptions(m);
  if (m.toolchain) log(`toolchain ${m.toolchain.id}: ${image}, \`${testCommand}\`${m.prepare ? ' (prepared)' : ''}`);
  const shas = (await git(['log', '--first-parent', '--no-merges', '--format=%H', o.ref ?? 'HEAD'], o.repoDir))
    .split('\n')
    .filter(Boolean);
  const candidates: { sha: string; parent: string; files: string[] }[] = [];
  for (const sha of shas) {
    const parents = (await git(['rev-list', '--parents', '-n', '1', sha], o.repoDir)).trim().split(' ').slice(1);
    if (parents.length !== 1) continue;
    const files = (await git(['diff', '--name-only', parents[0]!, sha], o.repoDir)).split('\n').filter(Boolean);
    const touchesSource = files.some(m.isSource);
    const touchesTests = files.some(m.isTest);
    const touchesDeps = files.some(isDependencyManifest);
    if (touchesSource && touchesTests && !touchesDeps) candidates.push({ sha, parent: parents[0]!, files });
    if (candidates.length >= (o.maxCandidates ?? o.limit * 3)) break;
  }
  log(`mining ${candidates.length} candidate commit(s) from ${shas.length}`);
  const rejected: MineResult['rejected'] = [];
  const results = await pool(candidates, o.concurrency ?? 4, async (c) => {
    const testFiles = c.files.filter(m.isTest);
    const tests: Record<string, string | null> = {};
    for (const f of testFiles) tests[f] = await git(['show', `${c.sha}:${f}`], o.repoDir).catch(() => null);
    const before = await extractTree(o.repoDir, c.parent);
    const after = await extractTree(o.repoDir, c.sha);
    try {
      writeFiles(before, tests);
      const fail = await runTestsInContainer(before, testCommand, image, o.timeoutSec ?? 60, run);
      if (fail.prepareFailed) return { c, reason: `prepare failed on the parent: ${fail.outputTail.split('\n')[0]}` };
      if (fail.exitCode === 124) return { c, reason: 'hidden tests hang on the parent' };
      if (fail.passed) return { c, reason: 'hidden tests already pass on the parent' };
      const pass = await runTestsInContainer(after, testCommand, image, o.timeoutSec ?? 60, run);
      if (pass.prepareFailed) return { c, reason: `prepare failed on the commit: ${pass.outputTail.split('\n')[0]}` };
      if (!pass.passed) return { c, reason: 'tests do not pass on the commit' };
      const goldPatch = await git(
        ['diff', '--binary', c.parent, c.sha, '--', '.', ...testFiles.map((f) => `:(exclude)${f}`)],
        o.repoDir,
      );
      const message = (await git(['log', '-1', '--format=%B', c.sha], o.repoDir)).trim();
      const task: BenchTask = {
        id: `${o.repo.split('/').pop()}-${c.sha.slice(0, 8)}`,
        repo: o.repo,
        base: c.parent,
        commit: c.sha,
        problem: message,
        tests,
        goldPatch,
        testCommand,
        image,
        ...(m.prepare ? { prepare: m.prepare } : {}),
        ...(m.env ? { env: m.env } : {}),
      };
      return { c, task };
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(after, { recursive: true, force: true });
    }
  });
  const tasks: BenchTask[] = [];
  for (const r of results) {
    if ('task' in r && r.task) {
      if (tasks.length < o.limit) tasks.push(r.task);
    } else rejected.push({ commit: r.c.sha, reason: (r as { reason: string }).reason });
  }
  log(`mined ${tasks.length} task(s), rejected ${rejected.length}`);
  return { tasks, scanned: candidates.length, rejected };
}

export function datasetHash(tasks: BenchTask[]): string {
  return createHash('sha256').update(JSON.stringify(tasks)).digest('hex').slice(0, 16);
}

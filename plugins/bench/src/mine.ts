/**
 * Mine a repository's history into eval tasks (SWE-bench style): a commit that
 * changes source and tests becomes a task whose hidden tests FAIL on the
 * parent and PASS on the commit. Validation runs the tests in containers with
 * no network.
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
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
}

export interface MineOptions {
  repoDir: string;
  /** Repository label stored in tasks (e.g. "marcbachmann/cel-js"). */
  repo: string;
  ref?: string;
  /** Path prefixes counted as source. */
  source: string[];
  /** Regex (string) for test files. */
  tests: string;
  testCommand: string;
  image?: string;
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

export async function mineTasks(o: MineOptions): Promise<MineResult> {
  const log = o.log ?? (() => {});
  const image = o.image ?? 'node:22-alpine';
  const testRe = new RegExp(o.tests);
  const shas = (await git(['log', '--first-parent', '--no-merges', '--format=%H', o.ref ?? 'HEAD'], o.repoDir))
    .split('\n')
    .filter(Boolean);
  const candidates: { sha: string; parent: string; files: string[] }[] = [];
  for (const sha of shas) {
    const parents = (await git(['rev-list', '--parents', '-n', '1', sha], o.repoDir)).trim().split(' ').slice(1);
    if (parents.length !== 1) continue;
    const files = (await git(['diff', '--name-only', parents[0]!, sha], o.repoDir)).split('\n').filter(Boolean);
    const touchesSource = files.some((f) => o.source.some((s) => f.startsWith(s)) && !testRe.test(f));
    const touchesTests = files.some((f) => testRe.test(f));
    const touchesDeps = files.some((f) =>
      /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f),
    );
    if (touchesSource && touchesTests && !touchesDeps) candidates.push({ sha, parent: parents[0]!, files });
    if (candidates.length >= (o.maxCandidates ?? o.limit * 3)) break;
  }
  log(`mining ${candidates.length} candidate commit(s) from ${shas.length}`);
  const rejected: MineResult['rejected'] = [];
  const results = await pool(candidates, o.concurrency ?? 4, async (c) => {
    const testFiles = c.files.filter((f) => testRe.test(f));
    const tests: Record<string, string | null> = {};
    for (const f of testFiles) tests[f] = await git(['show', `${c.sha}:${f}`], o.repoDir).catch(() => null);
    const before = await extractTree(o.repoDir, c.parent);
    const after = await extractTree(o.repoDir, c.sha);
    try {
      writeFiles(before, tests);
      const fail = await runTestsInContainer(before, o.testCommand, image, o.timeoutSec ?? 60);
      if (fail.exitCode === 124) return { c, reason: 'hidden tests hang on the parent' };
      if (fail.passed) return { c, reason: 'hidden tests already pass on the parent' };
      const pass = await runTestsInContainer(after, o.testCommand, image, o.timeoutSec ?? 60);
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
        testCommand: o.testCommand,
        image,
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

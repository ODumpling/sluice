import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from '@sluice-dev/sandbox';

/** Extract `sha`'s tree from `repo` into a fresh temp dir (no .git). */
export function extractTree(repo: string, sha: string, prefix = 'sluice-bench-'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return new Promise((resolve, reject) => {
    const archive = execFile(
      'git',
      ['archive', '--format=tar', sha],
      { cwd: repo, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`git archive ${sha}: ${err.message}`));
        const tar = execFile('tar', ['-x', '-C', dir], (e) => (e ? reject(e) : resolve(dir)));
        tar.stdin!.end(stdout);
      },
    );
    void archive;
  });
}

export function writeFiles(dir: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const p = join(dir, path);
    if (content === null) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** Make `dir` a git repo with one commit so agents can diff/apply. */
export async function initRepo(dir: string): Promise<void> {
  await git(['init', '-q', '-b', 'main'], dir);
  await git(
    ['-c', 'user.email=bench@sluice.dev', '-c', 'user.name=sluice-bench', '-c', 'commit.gpgsign=false', 'add', '-A'],
    dir,
  );
  await git(
    [
      '-c',
      'user.email=bench@sluice.dev',
      '-c',
      'user.name=sluice-bench',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'base',
      '--allow-empty',
    ],
    dir,
  );
}

export { runInContainer as runTestsInContainer, type TestRun } from '@sluice-dev/sandbox';

/** Bounded-concurrency map preserving order. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

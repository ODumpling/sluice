import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim() || err.message}`));
      else resolve(String(stdout));
    });
  });
}

export interface Checkout {
  dir: string;
  ref: string;
  sha: string;
  remove(): Promise<void>;
}

/** Materialise a git ref as a detached worktree in a temp dir (a "build" to run in a sandbox). */
export async function checkoutRef(repoDir: string, ref: string): Promise<Checkout> {
  const top = (await git(['rev-parse', '--show-toplevel'], repoDir)).trim();
  const sha = (await git(['rev-parse', '--verify', `${ref}^{commit}`], top)).trim();
  const dir = join(mkdtempSync(join(tmpdir(), 'sluice-build-')), 'tree');
  await git(['worktree', 'add', '--detach', dir, sha], top);
  return {
    dir,
    ref,
    sha,
    async remove() {
      await git(['worktree', 'remove', '--force', dir], top).catch(() => rmSync(dir, { recursive: true, force: true }));
    },
  };
}

export type LineRanges = Record<string, [number, number][]>;

/** Changed line ranges on the head side of `git diff base head` (1-based, inclusive). */
export async function changedLines(
  repoDir: string,
  base: string,
  head: string,
  pathspecs: string[] = [],
): Promise<LineRanges> {
  const out = await git(['diff', '-U0', '--no-color', '--no-ext-diff', base, head, '--', ...pathspecs], repoDir);
  const ranges: LineRanges = {};
  let file: string | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? undefined : line.slice(6);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) (ranges[file] ??= []).push([start, start + count - 1]);
    }
  }
  return ranges;
}

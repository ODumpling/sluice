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

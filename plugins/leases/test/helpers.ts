import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli, type HostIO } from '@sluice-dev/cli';

/** Write `files` (path → content) under a fresh temp dir; returns the dir. */
export function writeTree(files: Record<string, string>, dir = mkdtempSync(join(tmpdir(), 'sluice-leases-'))): string {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

/** Copy of `dir` with some files rewritten. */
export function variant(dir: string, edits: Record<string, (s: string) => string>): string {
  const out = mkdtempSync(join(tmpdir(), 'sluice-leases-'));
  cpSync(dir, out, { recursive: true });
  for (const [f, fn] of Object.entries(edits)) {
    const before = readFileSync(join(out, f), 'utf8');
    const after = fn(before);
    if (after === before) throw new Error(`edit of ${f} changed nothing`);
    writeFileSync(join(out, f), after);
  }
  return out;
}

/** 1-based line of the first line containing `needle`. */
export function lineOf(dir: string, file: string, needle: string): number {
  const i = readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`${needle} not in ${file}`);
  return i + 1;
}

/** A git repo (copy of an example) driven through the CLI by simulated agents. */
export class DemoRepo {
  readonly dir: string;
  constructor(example: string) {
    this.dir = join(mkdtempSync(join(tmpdir(), 'sluice-coord-')), 'repo');
    cpSync(example, this.dir, { recursive: true });
    writeFileSync(join(this.dir, '.gitignore'), '.sluice/\n');
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.email', 'dev@acme.test');
    this.git('config', 'user.name', 'dev');
    this.git('config', 'commit.gpgsign', 'false');
    this.git('add', '-A');
    this.git('commit', '-qm', 'demo');
  }

  git(...a: string[]): string {
    return execFileSync('git', a, { cwd: this.dir, stdio: 'pipe' }).toString().trim();
  }

  async cli(...args: string[]): Promise<{ code: number; out: string }> {
    let out = '';
    const io: HostIO = {
      cwd: this.dir,
      env: {},
      stdout: { write: (t) => void (out += t) },
      stderr: { write: () => {} },
    };
    const code = await runCli(args, io);
    return { code, out };
  }

  /** A simulated agent: edits files on its own branch and commits. */
  agentEdit(branch: string, edits: Record<string, (s: string) => string>, message: string): void {
    this.git('checkout', '-q', '-B', branch, 'main');
    for (const [f, fn] of Object.entries(edits)) {
      const p = join(this.dir, f);
      const before = readFileSync(p, 'utf8');
      const after = fn(before);
      if (after === before) throw new Error(`edit of ${f} changed nothing`);
      writeFileSync(p, after);
    }
    this.git('commit', '-qam', message);
    this.git('checkout', '-q', 'main');
  }
}

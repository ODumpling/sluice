import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { docker, git } from '@sluice-dev/sandbox';

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

export interface TestRun {
  passed: boolean;
  exitCode: number;
  durationMs: number;
  outputTail: string;
}

/**
 * Run a test command against a tree inside a container with no network. The
 * tree is streamed in as a tar on stdin (no host bind mounts: works with remote
 * Docker daemons and avoids file-sharing stalls on Docker Desktop).
 */
export function runTestsInContainer(dir: string, command: string, image: string, timeoutSec = 120): Promise<TestRun> {
  const started = Date.now();
  const name = `sluice-bench-${randomBytes(5).toString('hex')}`;
  const inner = `mkdir -p /work && tar -x -C /work && cd /work && ${command}`;
  return new Promise((resolve) => {
    const tar = spawn('tar', ['-c', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
    // Resource caps keep a runaway test (e.g. catastrophic regex backtracking) from starving the Docker VM.
    const limits = ['--cpus', '1', '--memory', '1g', '--pids-limit', '512'];
    const run = spawn(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--init',
        '--name',
        name,
        '--network',
        'none',
        '--label',
        'sluice.bench=1',
        ...limits,
        image,
        'sh',
        '-c',
        inner,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    tar.stdout.pipe(run.stdin);
    let out = '';
    const on = (d: Buffer) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    run.stdout.on('data', on);
    run.stderr.on('data', on);
    let timedOut = false;
    // The deadline is enforced from the host: in-container `timeout` is not reliable under every init.
    const deadline = setTimeout(() => {
      timedOut = true;
      void docker(['kill', name], { allowFail: true, timeoutMs: 60_000 });
      setTimeout(() => run.kill('SIGKILL'), 30_000).unref();
    }, timeoutSec * 1000);
    run.on('close', (c) => {
      clearTimeout(deadline);
      const code = timedOut ? 124 : c;
      if (process.env.SLUICE_TRACE_DOCKER)
        process.stderr.write(`[docker ${Date.now() - started}ms] bench test run -> ${code}\n`);
      resolve({
        passed: code === 0,
        exitCode: code ?? 1,
        durationMs: Date.now() - started,
        outputTail: (timedOut ? `[timed out after ${timeoutSec}s]\n` : '') + out.split('\n').slice(-20).join('\n'),
      });
    });
  });
}

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

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { docker } from './docker.js';

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
export function runInContainer(dir: string, command: string, image: string, timeoutSec = 120): Promise<TestRun> {
  const started = Date.now();
  const name = `sluice-run-${randomBytes(5).toString('hex')}`;
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
        'sluice.run=1',
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

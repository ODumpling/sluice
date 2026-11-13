import { execFile, spawn } from 'node:child_process';

export class DockerError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(`docker ${args.slice(0, 3).join(' ')} failed (${code}): ${stderr.trim().split('\n').slice(-5).join(' | ')}`);
    this.name = 'DockerError';
  }
}

export interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a docker CLI command. Throws DockerError on non-zero exit unless allowFail. */
export function docker(
  args: string[],
  opts: { allowFail?: boolean; input?: string; timeoutMs?: number } = {},
): Promise<DockerResult> {
  const started = Date.now();
  const trace = process.env.SLUICE_TRACE_DOCKER;
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 300_000 },
      (err, stdout, stderr) => {
        const raw = err ? (err as unknown as { code?: unknown }).code : 0;
        const code = typeof raw === 'number' ? raw : err ? 1 : 0;
        if (trace)
          process.stderr.write(`[docker ${Date.now() - started}ms] ${args.slice(0, 4).join(' ')} -> ${code}\n`);
        if (err && !opts.allowFail) reject(new DockerError(args, String(stderr || err.message), code));
        else resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Stream a long docker command (e.g. build), returning combined output. */
export function dockerStream(args: string[], onLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const on = (d: Buffer) => {
      const s = d.toString();
      out += s;
      if (onLine) for (const l of s.split('\n')) if (l.trim()) onLine(l);
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new DockerError(args, out, code))));
  });
}

export async function dockerAvailable(): Promise<boolean> {
  const r = await docker(['version', '--format', '{{.Server.Version}}'], { allowFail: true, timeoutMs: 15_000 }).catch(
    () => ({ code: 1 }) as DockerResult,
  );
  return r.code === 0;
}

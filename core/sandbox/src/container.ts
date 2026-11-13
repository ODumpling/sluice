import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { docker } from './docker.js';

export interface TestRun {
  passed: boolean;
  exitCode: number;
  durationMs: number;
  outputTail: string;
  /** The dependency prepare step failed (tests never ran). */
  prepareFailed?: boolean;
}

/**
 * Dependency preparation for offline test runs. A derived image `FROM <image>`
 * gets only the tree's dependency manifests (paths preserved, under /work) and
 * runs `command` there **with network at image build time** (e.g. `go mod
 * download`, `dotnet restore`); tests then run in it with `--network none`.
 */
export interface PrepareSpec {
  /** Shell command run in /work while building the image. */
  command: string;
  /** Which tree files (relative, `/`-separated) are dependency manifests. */
  manifest: (file: string) => boolean;
  /** Environment baked into the image (also seen by the tests). */
  env?: Record<string, string>;
}

export interface RunInContainerOptions {
  prepare?: PrepareSpec;
  /** Extra environment for the test run. */
  env?: Record<string, string>;
}

/** Exit code reported when the prepare step fails. */
export const PREPARE_FAILED = 125;

const PREPARE_SKIP = new Set(['.git', 'node_modules', '.sluice', 'bin', 'obj']);

function manifestsOf(dir: string, isManifest: (f: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (PREPARE_SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      const rel = relative(dir, p).split('\\').join('/');
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && isManifest(rel)) out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

const building = new Map<string, Promise<string>>();

/**
 * Build (or reuse) the prepared image for `dir`: cached by base image, command,
 * env and the content of every dependency manifest, so a tree whose manifests
 * did not change reuses the image (tag `sluice-prepare:<hash>`).
 */
export function prepareImage(dir: string, image: string, spec: PrepareSpec): Promise<string> {
  const files = manifestsOf(dir, spec.manifest).map((f) => ({ f, text: readFileSync(join(dir, f)) }));
  const env = Object.entries(spec.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const h = createHash('sha256').update(JSON.stringify({ image, command: spec.command, env }));
  for (const { f, text } of files) h.update(`\0${f}\0`).update(createHash('sha256').update(text).digest('hex'));
  const tag = `sluice-prepare:${h.digest('hex').slice(0, 20)}`;
  let p = building.get(tag);
  if (!p) {
    p = (async () => {
      const have = await docker(['image', 'inspect', '--format', '{{.Id}}', tag], {
        allowFail: true,
        timeoutMs: 120_000,
      });
      if (have.code === 0) return tag;
      const ctx = mkdtempSync(join(tmpdir(), 'sluice-prepare-'));
      try {
        for (const { f, text } of files) {
          mkdirSync(dirname(join(ctx, f)), { recursive: true });
          writeFileSync(join(ctx, f), text);
        }
        const dockerfile = [
          `FROM ${image}`,
          ...env.map(([k, v]) => `ENV ${k}=${JSON.stringify(v)}`),
          'WORKDIR /work',
          'COPY . /work/',
          `RUN ${JSON.stringify(['sh', '-c', spec.command])}`,
          '',
        ].join('\n');
        const started = Date.now();
        const r = await docker(['build', '-q', '-t', tag, '--label', 'sluice.prepare=1', '-f', '-', ctx], {
          input: dockerfile,
          allowFail: true,
          timeoutMs: 1_800_000,
        });
        if (process.env.SLUICE_TRACE_DOCKER)
          process.stderr.write(`[docker ${Date.now() - started}ms] prepare ${tag} (${image}) -> ${r.code}\n`);
        if (r.code !== 0)
          throw new Error(
            `prepare \`${spec.command}\` failed on ${image}:\n${(r.stderr || r.stdout).split('\n').slice(-30).join('\n')}`,
          );
        return tag;
      } finally {
        rmSync(ctx, { recursive: true, force: true });
      }
    })();
    building.set(tag, p);
    // concurrent callers share one build; a failure is remembered briefly (no rebuild storm), then retried
    p.catch(() => setTimeout(() => building.delete(tag), 60_000).unref());
  }
  return p;
}

/**
 * Run a test command against a tree inside a container with no network. The
 * tree is streamed in as a tar on stdin (no host bind mounts: works with remote
 * Docker daemons and avoids file-sharing stalls on Docker Desktop). With
 * `prepare`, the tests run in the prepared (dependency-fetched) image.
 */
export async function runInContainer(
  dir: string,
  command: string,
  image: string,
  timeoutSec = 120,
  opts: RunInContainerOptions = {},
): Promise<TestRun> {
  const started = Date.now();
  if (opts.prepare) {
    try {
      image = await prepareImage(dir, image, opts.prepare);
    } catch (e) {
      return {
        passed: false,
        exitCode: PREPARE_FAILED,
        durationMs: Date.now() - started,
        outputTail: (e as Error).message,
        prepareFailed: true,
      };
    }
  }
  const name = `sluice-run-${randomBytes(5).toString('hex')}`;
  const inner = `mkdir -p /work && tar -x -C /work && cd /work && ${command}`;
  const env = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return new Promise((resolve) => {
    // COPYFILE_DISABLE: macOS tar would add AppleDouble `._*` files (e.g. a `._App.sln` breaks `dotnet test`)
    const tar = spawn('tar', ['-c', '-C', dir, '.'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
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
        ...env,
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
        process.stderr.write(`[docker ${Date.now() - started}ms] test run -> ${code}\n`);
      resolve({
        passed: code === 0,
        exitCode: code ?? 1,
        durationMs: Date.now() - started,
        outputTail: (timedOut ? `[timed out after ${timeoutSec}s]\n` : '') + out.split('\n').slice(-20).join('\n'),
      });
    });
  });
}

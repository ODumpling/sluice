/**
 * `determinism: dotnet` — an LD_PRELOAD library plus a tiny PID 1 (see ADR-0010).
 *
 * .NET reads the wall clock (clock_gettime/gettimeofday/time) and randomness
 * (/dev/urandom, getrandom, OpenSSL RAND_bytes) through libc, so a preload
 * can freeze and seed them. `sluice-init` runs as the container entrypoint:
 * it owns the control server and the clock state shared with every process
 * of the service, pipes the command's stdout to capture domain events, and
 * sets LD_PRELOAD (glibc or musl build, picked at runtime) for the command.
 *
 * Sluice compiles the C sources in assets/dotnet once per CPU architecture in
 * throwaway builder containers (alpine for the static init and the musl
 * library, debian:bookworm for glibc) and caches the result under the user
 * cache dir. Set SLUICE_DOTNET_SHIM_DIR to a directory holding prebuilt
 * `sluice-init`, `libsluice-glibc.so` and `libsluice-musl.so` to skip it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { docker } from '../docker.js';
import { ASSETS, DeterminismError, cacheRoot } from './common.js';

export const DOTNET_MOUNT = '/sluice/dotnet';
export const DOTNET_INIT = `${DOTNET_MOUNT}/sluice-init`;
export const DOTNET_SOURCES = ['sluice-init.c', 'sluice-preload.c'] as const;
export const DOTNET_OUTPUTS = ['sluice-init', 'libsluice-glibc.so', 'libsluice-musl.so'] as const;

const MUSL_BUILDER = 'alpine:3.20';
const GLIBC_BUILDER = 'debian:bookworm-slim';
const CFLAGS = '-O2 -Wall -Wextra -Wno-nonnull-compare -fno-delete-null-pointer-checks';

/** Build commands run in the builder containers (sources at /src, outputs to /out). */
export const DOTNET_BUILD = {
  musl: {
    image: MUSL_BUILDER,
    script: [
      'set -e',
      'apk add --no-cache -q gcc musl-dev >/dev/null',
      `gcc ${CFLAGS} -static -o /out/sluice-init /src/sluice-init.c -lpthread`,
      `gcc ${CFLAGS} -shared -fPIC -o /out/libsluice-musl.so /src/sluice-preload.c`,
    ].join('\n'),
  },
  glibc: {
    image: GLIBC_BUILDER,
    script: [
      'set -e',
      'apt-get update -qq >/dev/null',
      'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends gcc libc6-dev >/dev/null',
      `gcc ${CFLAGS} -shared -fPIC -o /out/libsluice-glibc.so /src/sluice-preload.c`,
    ].join('\n'),
  },
} as const;

export interface DotnetShim {
  /** Host directory to mount at DOTNET_MOUNT. */
  dir: string;
  arch: string;
}

export interface ImageConfig {
  arch: string;
  entrypoint: string[];
  cmd: string[];
}

export async function imageConfig(image: string): Promise<ImageConfig> {
  const r = await docker([
    'image',
    'inspect',
    '-f',
    '{{json .Architecture}}\t{{json .Config.Entrypoint}}\t{{json .Config.Cmd}}',
    image,
  ]);
  const [arch, ep, cmd] = r.stdout.trim().split('\t');
  return {
    arch: (JSON.parse(arch ?? '""') as string) || 'amd64',
    entrypoint: (JSON.parse(ep ?? 'null') as string[] | null) ?? [],
    cmd: (JSON.parse(cmd ?? 'null') as string[] | null) ?? [],
  };
}

/**
 * The container command under sluice-init: docker semantics are kept — the
 * image ENTRYPOINT stays in front, `command` (or the image CMD) follows.
 */
export function dotnetCommand(cfg: ImageConfig, command: string[] | undefined): string[] {
  const argv = [...cfg.entrypoint, ...(command ?? cfg.cmd)];
  if (!argv.length) throw new DeterminismError('determinism: dotnet: service has no command and its image no CMD');
  return argv;
}

export function dotnetShimKey(arch: string): string {
  const h = createHash('sha256').update(arch).update(CFLAGS).update(JSON.stringify(DOTNET_BUILD));
  for (const s of DOTNET_SOURCES) h.update(readFileSync(join(ASSETS, 'dotnet', s)));
  return `${arch}-${h.digest('hex').slice(0, 16)}`;
}

const inflight = new Map<string, Promise<DotnetShim>>();

export function prepareDotnetShim(arch: string, log: (m: string) => void = () => {}): Promise<DotnetShim> {
  let p = inflight.get(arch);
  if (!p) {
    p = build(arch, log).finally(() => inflight.delete(arch));
    inflight.set(arch, p);
  }
  return p;
}

const complete = (dir: string) => DOTNET_OUTPUTS.every((f) => existsSync(join(dir, f)));

async function build(arch: string, log: (m: string) => void): Promise<DotnetShim> {
  const pre = process.env.SLUICE_DOTNET_SHIM_DIR;
  if (pre) {
    if (!complete(pre))
      throw new DeterminismError(`SLUICE_DOTNET_SHIM_DIR=${pre} must contain ${DOTNET_OUTPUTS.join(', ')}`);
    return { dir: pre, arch };
  }
  const dir = join(cacheRoot(), 'determinism', 'dotnet', dotnetShimKey(arch));
  if (complete(dir)) return { dir, arch };
  log(`determinism: dotnet: building the shim for linux/${arch} (once; cached in ${dir})`);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  // builders run as root; hand the outputs back to the invoking user
  const owner = process.getuid ? `chown -R ${process.getuid()}:${process.getgid?.() ?? 0} /out` : 'true';
  try {
    for (const b of Object.values(DOTNET_BUILD)) {
      const r = await docker(
        [
          'run',
          '--rm',
          '--label',
          'sluice.builder=1',
          '--platform',
          `linux/${arch}`,
          '-v',
          `${join(ASSETS, 'dotnet')}:/src:ro`,
          '-v',
          `${tmp}:/out`,
          b.image,
          'sh',
          '-c',
          `${b.script}\n${owner}`,
        ],
        { allowFail: true, timeoutMs: 600_000 },
      );
      if (r.code !== 0)
        throw new DeterminismError(
          `determinism: dotnet: building the shim in ${b.image} (linux/${arch}) failed — it needs network access to ` +
            `install gcc once (or set SLUICE_DOTNET_SHIM_DIR to prebuilt binaries):\n${(r.stdout + r.stderr).trim().slice(-2000)}`,
        );
    }
    if (!complete(tmp)) throw new DeterminismError(`determinism: dotnet: shim build produced no output in ${tmp}`);
    mkdirSync(dirname(dir), { recursive: true });
    try {
      renameSync(tmp, dir);
    } catch (e) {
      if (!complete(dir)) throw e; // lost a race with another process: theirs is identical
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { dir, arch };
}

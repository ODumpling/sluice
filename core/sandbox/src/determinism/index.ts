/**
 * Determinism shims per runtime. Every mode speaks the same control protocol
 * on CONTROL_PORT (POST /clock {nowMs}, GET /state, GET /events?since=N) and
 * honours SLUICE_SEED / SLUICE_NOW_MS / SLUICE_CONTROL_PORT, so the sandbox
 * drives them all the same way. See ADR-0002 (node) and ADR-0010 (go, dotnet).
 */
import { join } from 'node:path';
import type { DeterminismMode, ServiceSpec } from '@sluice-dev/config';
import { docker } from '../docker.js';
import { ASSETS } from './common.js';
import { DOTNET_INIT, DOTNET_MOUNT, dotnetCommand, imageConfig, prepareDotnetShim } from './dotnet.js';
import { GO_MOUNT, goCacheVolume, prepareGoShim } from './go.js';

export { DeterminismError, cacheRoot } from './common.js';
export type { DeterminismMode };
export {
  GO_MIN_VERSION,
  GO_PATCHED_FILES,
  GO_PROBE_SCRIPT,
  buildGoOverlay,
  parseGoProbe,
  parseGoVersion,
  patchGoFile,
  type GoProbe,
} from './go.js';
export { DOTNET_BUILD, dotnetCommand, dotnetShimKey, type ImageConfig } from './dotnet.js';

export function isDeterministic(svc: ServiceSpec): boolean {
  return svc.determinism !== 'none';
}

/** What a determinism mode adds to `docker run` for a service. */
export interface Injection {
  /** Extra `docker run` flags (mounts, entrypoint). */
  args: string[];
  /** Environment overrides (merged over the service's env). */
  env: Record<string, string>;
  /** Replacement for the container command (dotnet: the original entrypoint + command). */
  command?: string[];
}

export interface InjectionContext {
  image: string;
  seed: number;
  nowMs: number;
  controlPort: number;
  /** The service's own (interpolated) env. */
  env: Record<string, string>;
  log: (m: string) => void;
}

/**
 * Host-side work a mode needs before its first container (overlay
 * generation, shim build); cached, so later calls are cheap.
 */
export async function prepare(svc: ServiceSpec, image: string, log: (m: string) => void): Promise<void> {
  if (svc.determinism === 'go') {
    const shim = await prepareGoShim(image, log);
    await docker(['volume', 'create', '--label', 'sluice.cache=go', goCacheVolume(shim)]);
  } else if (svc.determinism === 'dotnet') {
    await prepareDotnetShim((await imageConfig(image)).arch, log);
  }
}

export async function inject(svc: ServiceSpec, ctx: InjectionContext): Promise<Injection> {
  const sluice = {
    SLUICE_SEED: String(ctx.seed),
    SLUICE_NOW_MS: String(ctx.nowMs),
    SLUICE_CONTROL_PORT: String(ctx.controlPort),
  };
  switch (svc.determinism) {
    case 'none':
      return { args: [], env: {} };
    case 'node':
      return {
        args: ['-v', `${join(ASSETS, 'determinism.cjs')}:/sluice/determinism.cjs:ro`],
        env: {
          ...sluice,
          NODE_OPTIONS: `${ctx.env.NODE_OPTIONS ? ctx.env.NODE_OPTIONS + ' ' : ''}--require /sluice/determinism.cjs`,
        },
      };
    case 'go': {
      const shim = await prepareGoShim(ctx.image, ctx.log);
      const overlay = `-overlay=${GO_MOUNT}/overlay.json`;
      const goflags = ctx.env.GOFLAGS ?? shim.goflags;
      return {
        args: [
          '-v',
          `${shim.dir}:${GO_MOUNT}:ro`,
          // the overlay recompiles std; keep the build cache across container restarts
          '-v',
          `${goCacheVolume(shim)}:${ctx.env.GOCACHE || shim.gocache}`,
        ],
        env: {
          ...sluice,
          GOFLAGS: goflags ? `${goflags} ${overlay}` : overlay,
          // the overlay patches this image's GOROOT: never switch toolchains
          GOTOOLCHAIN: 'local',
        },
      };
    }
    case 'dotnet': {
      const cfg = await imageConfig(ctx.image);
      const shim = await prepareDotnetShim(cfg.arch, ctx.log);
      return {
        args: ['-v', `${shim.dir}:${DOTNET_MOUNT}:ro`, '--entrypoint', DOTNET_INIT],
        env: {
          ...sluice,
          SLUICE_PRELOAD_GLIBC: `${DOTNET_MOUNT}/libsluice-glibc.so`,
          SLUICE_PRELOAD_MUSL: `${DOTNET_MOUNT}/libsluice-musl.so`,
        },
        command: dotnetCommand(cfg, svc.command),
      };
    }
  }
}

/** Hint appended when a shim's control server never comes up. */
export function controlHint(mode: DeterminismMode): string {
  switch (mode) {
    case 'node':
      return 'the service must run node (NODE_OPTIONS=--require loads the shim)';
    case 'go':
      return 'the command must compile the program at container start (go run / go build with the GOFLAGS overlay) and it must link net/http';
    case 'dotnet':
      return 'sluice-init runs the command; check the service logs';
    default:
      return '';
  }
}

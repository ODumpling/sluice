import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker } from '../docker.js';

export const ASSETS = fileURLToPath(new URL('../../assets/', import.meta.url));

/** A determinism shim cannot be applied to a service (unsupported toolchain, missing patch point, …). */
export class DeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeterminismError';
  }
}

/** Sluice's per-user cache dir: $SLUICE_CACHE_DIR, else $XDG_CACHE_HOME/sluice, else ~/.cache/sluice. */
export function cacheRoot(): string {
  if (process.env.SLUICE_CACHE_DIR) return process.env.SLUICE_CACHE_DIR;
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'sluice');
}

export async function imageId(image: string): Promise<string> {
  const r = await docker(['image', 'inspect', '-f', '{{.Id}}', image]);
  return r.stdout.trim();
}

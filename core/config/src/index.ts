import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SluiceConfigSchema, type SluiceConfig } from './schema.js';

export * from './schema.js';

export const CONFIG_FILENAME = 'sluice.yaml';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
    this.name = 'ConfigError';
  }
}

export interface LoadedConfig {
  file: string;
  /** Directory containing sluice.yaml; relative paths in the config resolve against it. */
  root: string;
  config: SluiceConfig;
}

/** Walk up from `start` to find sluice.yaml. */
export function findConfigFile(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function parseConfig(text: string, file?: string): SluiceConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`invalid YAML: ${(e as Error).message}`, file);
  }
  const result = SluiceConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(`invalid config:\n${z.prettifyError(result.error)}`, file);
  }
  return result.data;
}

export function loadConfig(fileOrDir: string): LoadedConfig {
  const file =
    fileOrDir.endsWith('.yaml') || fileOrDir.endsWith('.yml') ? resolve(fileOrDir) : findConfigFile(fileOrDir);
  if (!file || !existsSync(file)) throw new ConfigError(`no ${CONFIG_FILENAME} found from ${fileOrDir}`);
  return { file, root: dirname(file), config: parseConfig(readFileSync(file, 'utf8'), file) };
}

export function tryLoadConfig(dir: string): LoadedConfig | undefined {
  const file = findConfigFile(dir);
  return file ? loadConfig(file) : undefined;
}

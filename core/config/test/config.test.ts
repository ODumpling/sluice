import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, findConfigFile, loadConfig, parseConfig } from '@sluice-dev/config';

describe('config', () => {
  it('applies defaults', () => {
    expect(parseConfig('name: demo\n')).toMatchObject({ version: 1, name: 'demo', plugins: [], pluginConfig: {} });
  });
  it('rejects unknown keys and bad versions', () => {
    expect(() => parseConfig('nmae: typo\n')).toThrow(ConfigError);
    expect(() => parseConfig('version: 2\n')).toThrow(/invalid config/);
    expect(() => parseConfig('a: [\n')).toThrow(/invalid YAML/);
  });
  it('finds sluice.yaml walking up', () => {
    const root = mkdtempSync(join(tmpdir(), 'sluice-cfg-'));
    writeFileSync(join(root, 'sluice.yaml'), 'name: x\nplugins: [./p.mjs]\n');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    expect(findConfigFile(join(root, 'a', 'b'))).toBe(join(root, 'sluice.yaml'));
    const loaded = loadConfig(join(root, 'a'));
    expect(loaded.root).toBe(root);
    expect(loaded.config.plugins).toEqual(['./p.mjs']);
  });
});

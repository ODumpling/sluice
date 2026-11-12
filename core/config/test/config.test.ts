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

describe('sandbox spec', () => {
  const base = `
sandbox:
  services:
    db: { image: postgres:16-alpine, ports: [5432] }
    app: { build: ., ports: [3000], dependsOn: [db] }
  ingress: { service: app, port: 3000 }
`;
  it('parses with defaults', () => {
    const c = parseConfig(base);
    expect(c.sandbox?.services.app?.workdir).toBe('/app');
    expect(c.sandbox?.seed).toBe(1);
    expect(c.sandbox?.fakes).toEqual([]);
  });
  it('rejects bad references and image+build', () => {
    expect(() => parseConfig(base.replace('service: app', 'service: web'))).toThrow(/ingress service web/);
    expect(() => parseConfig(base.replace('dependsOn: [db]', 'dependsOn: [cache]'))).toThrow(/unknown service cache/);
    expect(() => parseConfig(base.replace('{ build: .,', '{ build: ., image: x,'))).toThrow(
      /exactly one of image or build/,
    );
  });
  it('the bundled billing-demo spec is valid', () => {
    const loaded = loadConfig(join(import.meta.dirname, '..', '..', '..', 'examples', 'billing-demo'));
    expect(loaded.config.sandbox?.fakes).toEqual(['stripe']);
  });
});

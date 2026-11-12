// Enforces ADR-0001 structurally: core packages never depend on plugins or surfaces.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function pkgs(dir: string) {
  return readdirSync(join(root, dir))
    .filter((d) => existsSync(join(root, dir, d, 'package.json')))
    .map((d) => ({ dir: join(dir, d), pkg: JSON.parse(readFileSync(join(root, dir, d, 'package.json'), 'utf8')) }));
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === 'node_modules' || e.name === 'dist'
        ? []
        : walk(join(dir, e.name))
      : [join(dir, e.name)],
  );
}

const forbidden = (name: string) =>
  (name.startsWith('@sluice-dev/plugin-') && name !== '@sluice-dev/plugin-api') ||
  ['@sluice-dev/cli', '@sluice-dev/mcp', '@sluice-dev/github', '@sluice-dev/web'].includes(name);

describe('architecture (ADR-0001)', () => {
  const core = pkgs('core');
  it('has core packages', () => expect(core.length).toBeGreaterThan(0));
  for (const { dir, pkg } of core) {
    it(`${pkg.name} does not depend on plugins or surfaces`, () => {
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
      expect(deps.filter(forbidden)).toEqual([]);
      const offenders = walk(join(root, dir, 'src')).filter((f) => {
        const src = readFileSync(f, 'utf8');
        return /from ['"](@sluice-dev\/plugin-(?!api['"])|@sluice-dev\/(cli|mcp|github|web)['"]|[./]+\/(plugins|surfaces)\/)/.test(
          src,
        );
      });
      expect(offenders).toEqual([]);
    });
  }
  it('every workspace package is Apache-2.0 and scoped @sluice-dev', () => {
    for (const { pkg } of [...core, ...pkgs('plugins'), ...pkgs('surfaces')]) {
      expect(pkg.name).toMatch(/^@sluice-dev\//);
      expect(pkg.license).toBe('Apache-2.0');
    }
  });
});

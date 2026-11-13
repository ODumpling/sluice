#!/usr/bin/env node
// Packaging smoke test: pack every publishable package, install the tarballs
// into an empty project with npm (as a user would from the registry) and run
// the installed `sluice` binary. Run after `pnpm build`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = mkdtempSync(join(tmpdir(), 'sluice-pack-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

run(
  'pnpm',
  [
    '-r',
    '--filter',
    './core/**',
    '--filter',
    './plugins/**',
    '--filter',
    './surfaces/**',
    'exec',
    'pnpm',
    'pack',
    '--pack-destination',
    out,
  ],
  root,
);
const tarballs = readdirSync(out)
  .filter((f) => f.endsWith('.tgz'))
  .map((f) => join(out, f));
console.log(`packed ${tarballs.length} packages`);

const app = mkdtempSync(join(tmpdir(), 'sluice-install-'));
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'pack-smoke', private: true, type: 'module' }));
run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tarballs], app);

const sluice = join(app, 'node_modules', '.bin', 'sluice');
const help = run(sluice, ['--help'], app);
for (const cmd of [
  'gate',
  'bench',
  'rules',
  'policy',
  'work',
  'lease',
  'inbox',
  'campaign',
  'up',
  'replay',
  'diff',
  'record',
]) {
  if (!new RegExp(`^\\s+${cmd}\\b`, 'm').test(help))
    throw new Error(`installed CLI is missing command ${cmd}:\n${help}`);
}
run(sluice, ['init', '--name', 'smoke'], app);
const hello = run(sluice, ['hello', 'npm'], app);
if (!hello.includes('Hello, npm!')) throw new Error(`hello failed: ${hello}`);
console.log('installed CLI works:', help.split('\n')[0]);

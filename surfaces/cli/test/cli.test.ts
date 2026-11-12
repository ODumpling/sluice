import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';

function io(cwd = mkdtempSync(join(tmpdir(), 'sluice-cli-'))): HostIO & { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    cwd,
    env: {},
    stdout: { write: (t) => void (out += t) },
    stderr: { write: (t) => void (err += t) },
    out: () => out,
    err: () => err,
  };
}

describe('sluice CLI', () => {
  it('--help lists commands', async () => {
    const t = io();
    expect(await runCli(['--help'], t)).toBe(0);
    expect(t.out()).toContain('Usage: sluice');
    expect(t.out()).toContain('init');
    expect(t.out()).toContain('hello');
  });
  it('--version prints the version', async () => {
    const t = io();
    expect(await runCli(['--version'], t)).toBe(0);
    expect(t.out().trim()).toBe('0.1.0');
  });
  it('runs the hello plugin command with config from sluice.yaml', async () => {
    const t = io();
    writeFileSync(join(t.cwd, 'sluice.yaml'), 'version: 1\npluginConfig:\n  hello:\n    defaultName: agent\n');
    expect(await runCli(['hello'], t)).toBe(0);
    expect(t.out()).toContain('Hello, agent!');
    expect(await runCli(['hello', 'bob', '--shout'], t)).toBe(0);
    expect(t.out()).toContain('HELLO, BOB!');
  });
  it('loads a third-party plugin from sluice.yaml', async () => {
    const t = io();
    writeFileSync(
      join(t.cwd, 'local-plugin.mjs'),
      `export default { name: 'local', version: '1.0.0', apiVersion: '^1.0.0',
         commands: [{ path: ['local', 'ping'], summary: 'ping', run: (_i, ctx) => { ctx.stdout.write('pong\\n'); return 3; } }] };`,
    );
    writeFileSync(join(t.cwd, 'sluice.yaml'), 'version: 1\nplugins: [./local-plugin.mjs]\n');
    expect(await runCli(['local', 'ping'], t)).toBe(3);
    expect(t.out()).toBe('pong\n');
  });
  it('init writes a valid sluice.yaml and refuses to clobber', async () => {
    const t = io();
    expect(await runCli(['init', '--name', 'billing'], t)).toBe(0);
    expect(readFileSync(join(t.cwd, 'sluice.yaml'), 'utf8')).toContain('name: billing');
    expect(await runCli(['init'], t)).toBe(1);
    expect(t.err()).toContain('already exists');
  });
  it('unknown commands fail with non-zero exit', async () => {
    const t = io();
    expect(await runCli(['nope'], t)).not.toBe(0);
  });
});

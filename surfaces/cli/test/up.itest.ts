import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { loadConfig } from '@sluice-dev/config';
import { docker, GATEWAY_IMAGE, Sandbox } from '@sluice-dev/sandbox';

const DEMO = join(import.meta.dirname, '..', '..', '..', 'examples', 'billing-demo');

describe('sluice up', () => {
  it('boots billing-demo, runs --exec against it and tears down', async () => {
    let out = '';
    const io: HostIO = {
      cwd: DEMO,
      env: {},
      stdout: { write: (t) => void (out += t) },
      stderr: { write: () => {} },
    };
    const script = `node -e "fetch(process.env.SLUICE_INGRESS_URL + '/health').then(r => r.json()).then(j => console.log('HEALTH', JSON.stringify(j)))"`;
    expect(await runCli(['up', '--exec', script], io)).toBe(0);
    expect(out).toContain('HEALTH {"ok":true}');
  });
});

describe('sluice down', () => {
  it("removes only this project's sandboxes unless --all", async () => {
    const project = (name: string) => {
      const dir = mkdtempSync(join(tmpdir(), `sluice-down-${name}-`));
      writeFileSync(
        join(dir, 'sluice.yaml'),
        JSON.stringify({
          version: 1,
          name,
          sandbox: {
            services: {
              app: {
                image: GATEWAY_IMAGE,
                command: ['node', '-e', "require('http').createServer((q, r) => r.end()).listen(8080)"],
                ports: [8080],
                ready: { tcp: 8080 },
              },
            },
            ingress: { service: 'app', port: 8080 },
          },
        }),
      );
      return dir;
    };
    const io = (cwd: string): HostIO => ({ cwd, env: {}, stdout: { write: () => {} }, stderr: { write: () => {} } });
    const dirA = project('down-scope-a');
    const dirB = project('down-scope-b');
    const { config, root } = loadConfig(dirA);
    const sb = await Sandbox.up({ root, spec: config.sandbox!, name: config.name });
    const alive = async () =>
      (await docker(['ps', '-q', '--filter', `label=sluice.sandbox=${sb.id}`])).stdout.trim().length > 0;
    try {
      expect(await runCli(['down'], io(dirB))).toBe(0);
      expect(await alive()).toBe(true);
      expect(await runCli(['down'], io(dirA))).toBe(0);
      expect(await alive()).toBe(false);
    } finally {
      await sb.down();
    }
  });
});

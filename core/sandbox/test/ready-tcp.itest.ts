// `ready: {tcp}` must wait for the service itself, not the gateway port in front of it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@sluice-dev/config';
import { GATEWAY_IMAGE, Sandbox } from '@sluice-dev/sandbox';

const SLOW_SERVER = "setTimeout(() => require('http').createServer((q, r) => r.end('ok')).listen(8080), 4000)";

describe('tcp readiness', () => {
  let sb: Sandbox | undefined;
  afterAll(async () => {
    await sb?.down();
  });

  it('waits until the service listens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sluice-ready-tcp-'));
    writeFileSync(
      join(dir, 'sluice.yaml'),
      JSON.stringify({
        version: 1,
        name: 'ready-tcp',
        sandbox: {
          services: {
            app: { image: GATEWAY_IMAGE, command: ['node', '-e', SLOW_SERVER], ports: [8080], ready: { tcp: 8080 } },
          },
          ingress: { service: 'app', port: 8080 },
        },
      }),
    );
    const { config, root } = loadConfig(dir);
    sb = await Sandbox.up({ root, spec: config.sandbox!, name: config.name });
    const res = await fetch(sb.ingressUrl + '/');
    expect(await res.text()).toBe('ok');
  });
});

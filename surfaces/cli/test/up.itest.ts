import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';

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

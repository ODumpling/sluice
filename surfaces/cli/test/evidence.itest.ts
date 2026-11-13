import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { DEMO, variant } from '../../../test/support/billing.js';

function io(): HostIO & { out: () => string } {
  let out = '';
  return { cwd: DEMO, env: {}, stdout: { write: (t) => void (out += t) }, stderr: { write: () => {} }, out: () => out };
}

describe('sluice record / replay / diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sluice-sessions-'));
  const session = join(dir, 'base.json');

  it('records, replays deterministically, and flags a changed build', async () => {
    const r = io();
    expect(await runCli(['record', 'scripts/subscribe-and-renew.yaml', '-o', session], r)).toBe(0);
    expect(r.out()).toContain('recorded 7 steps');

    const same = io();
    expect(await runCli(['replay', session, '-n', '3'], same)).toBe(0);
    expect(same.out().match(/no behavior differences/g)).toHaveLength(3);

    const changed = io();
    const src = variant('billing.js', 'plan: row.plan,', 'plan: row.plan.toUpperCase(),');
    const other = join(dir, 'changed.json');
    expect(await runCli(['replay', session, '--source', src, '-o', other], changed)).toBe(1);
    expect(changed.out()).toContain('~ response.body.plan: "pro_monthly" -> "PRO_MONTHLY"');

    const d = io();
    expect(await runCli(['diff', session, other, '--json'], d)).toBe(1);
    expect(JSON.parse(d.out()).entries).toHaveLength(3);
    expect(await runCli(['diff', session, other, '--ignore', 'response.body.plan'], io())).toBe(0);
  });
});

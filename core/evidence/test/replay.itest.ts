// M2 exit: same build replayed 10x -> zero diff; seeded behavior change -> exactly that diff.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@sluice-dev/config';
import { diffSessions, formatDiff, runScript, startEvidenceSandbox, type Session } from '@sluice-dev/evidence';
import type { Sandbox } from '@sluice-dev/sandbox';
import { DEMO, subscribeAndRenew, variant } from '../../../test/support/billing.js';

describe('evidence + replay (M2)', () => {
  let sb: Sandbox;
  let base: Session;

  beforeAll(async () => {
    const { config, root } = loadConfig(DEMO);
    sb = await startEvidenceSandbox({ root, spec: config.sandbox!, name: config.name });
    base = await runScript(sb, subscribeAndRenew, { label: 'base' });
  });
  afterAll(async () => {
    await sb?.down();
  });

  it('records ingress, egress, DB writes and events per step', () => {
    expect(base.contractViolations).toEqual([]);
    const [cust, sub, , , advance, sync] = base.steps;
    expect(cust!.response).toEqual({ status: 201, body: { id: 1, email: 'ada@example.com', name: 'Ada' } });
    expect(cust!.egress.map((e) => `${e.fake} ${e.method} ${e.path}`)).toEqual(['stripe POST /v1/customers']);
    expect(cust!.db).toEqual([
      expect.objectContaining({
        table: 'customers',
        op: 'INSERT',
        new: expect.objectContaining({ id: 1, email: 'ada@example.com' }),
      }),
    ]);
    expect(cust!.events).toEqual([{ event: 'customer.created', customer_id: 1 }]);
    expect(sub!.db.map((d) => `${d.op} ${d.table}`)).toEqual(['INSERT plans', 'INSERT subscriptions']);
    expect(advance!.egress).toEqual([]);
    expect(sync!.db).toEqual([
      expect.objectContaining({
        table: 'subscriptions',
        op: 'UPDATE',
        new: expect.objectContaining({ current_period_end: '2030-03-15T12:00:00+00:00' }),
      }),
    ]);
    const stripe = base.final.fakes.stripe as { invoices: unknown[] };
    expect(stripe.invoices).toHaveLength(2);
    expect(base.final.db.customers).toHaveLength(1);
  });

  it('same build replayed 10x -> zero diff (raw, no noise filters)', async () => {
    for (let i = 0; i < 10; i++) {
      const replay = await runScript(sb, subscribeAndRenew, { label: `replay-${i}` });
      const d = diffSessions(base, replay, { idPatterns: [] });
      expect(d.entries, formatDiff(d)).toEqual([]);
      expect(JSON.stringify(replay.steps)).toBe(JSON.stringify(base.steps));
    }
  });

  it('seeded response change -> exactly that diff', async () => {
    const changed = await runScript(sb, subscribeAndRenew, {
      label: 'plan-uppercase',
      sourceRoot: variant('billing.js', 'plan: row.plan,', 'plan: row.plan.toUpperCase(),'),
    });
    const d = diffSessions(base, changed);
    expect(
      d.entries.map(({ step, channel, path, kind, before, after }) => ({ step, channel, path, kind, before, after })),
    ).toEqual([
      { step: 1, channel: 'response', path: 'body.plan', kind: 'changed', before: 'pro_monthly', after: 'PRO_MONTHLY' },
      { step: 2, channel: 'response', path: 'body.plan', kind: 'changed', before: 'pro_monthly', after: 'PRO_MONTHLY' },
      { step: 6, channel: 'response', path: 'body.plan', kind: 'changed', before: 'pro_monthly', after: 'PRO_MONTHLY' },
    ]);
  });

  it('seeded DB-write change -> exactly that diff across response, DB writes and final state', async () => {
    const changed = await runScript(sb, subscribeAndRenew, {
      label: 'name-dropped',
      sourceRoot: variant('billing.js', '[email, name ?? null, sc.id, new Date()]', '[email, null, sc.id, new Date()]'),
    });
    const d = diffSessions(base, changed);
    expect(
      d.entries.map(({ step, channel, path, kind, before, after }) => ({ step, channel, path, kind, before, after })),
    ).toEqual([
      { step: 0, channel: 'response', path: 'body.name', kind: 'changed', before: 'Ada', after: null },
      { step: 0, channel: 'db', path: '[0].new.name', kind: 'changed', before: 'Ada', after: null },
      { step: -1, channel: 'final', path: 'db.customers[0].name', kind: 'changed', before: 'Ada', after: null },
    ]);
  });
});

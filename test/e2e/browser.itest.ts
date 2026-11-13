// Browser steps end to end: Playwright runs inside the sandbox (its own
// container on the internal network), drives billing-demo's portal, and every
// click is attributed its requests, DB writes, Stripe calls and events.
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@sluice-dev/config';
import {
  diffSessions,
  formatDiff,
  loadScript,
  runScript,
  startEvidenceSandbox,
  type Session,
} from '@sluice-dev/evidence';
import { runScenario, validateScenario } from '@sluice-dev/plugin-gate';
import type { Sandbox } from '@sluice-dev/sandbox';
import { DEMO, prTree } from '../support/billing.js';

const portal = loadScript(join(DEMO, 'scripts', 'portal-cancel.yaml'));

const uiScenario = validateScenario({
  id: 'portal-cancel-keeps-access',
  title: 'Cancelling in the portal keeps the subscription active until the period ends',
  steps: [
    {
      http: { method: 'POST', path: '/customers', body: { email: 'ada@example.com', name: 'Ada' } },
      save: { cust: 'body.id' },
    },
    {
      http: { method: 'POST', path: '/subscriptions', body: { customer_id: '${cust}', plan: 'pro_monthly' } },
      save: { sub: 'body.id' },
    },
    { browser: { goto: '/portal/${sub}' }, expect: { text: 'Renews on 2030-02-15', visible: '#cancel' } },
    {
      browser: { click: 'role=button[name="Cancel subscription"]' },
      expect: { text: ['Status: active', 'Cancels on 2030-02-15'], hidden: '#cancel', noErrors: true },
    },
  ],
});

describe('browser steps in the sandbox', () => {
  let sb: Sandbox;
  let good: Session;
  const goodTree = prTree('good-period-end-cancel');
  const badTree = prTree('bad-immediate-cancel');
  const trace = join(mkdtempSync(join(tmpdir(), 'sluice-trace-')), 'trace.zip');

  beforeAll(async () => {
    const { config, root } = loadConfig(DEMO);
    sb = await startEvidenceSandbox({ root, spec: config.sandbox!, name: config.name });
    good = await runScript(sb, portal, { label: 'good', sourceRoot: goodTree, trace });
  });
  afterAll(async () => {
    await sb?.down();
  });

  it('the browser lives on the internal network only', async () => {
    expect((await sb.networks('browser')).length).toBe(1);
    expect(await sb.networks('browser')).toEqual(await sb.networks('app'));
  });

  it('records what the page did and attributes data changes to the click', () => {
    const [, , open, click, , , reopen] = good.steps;
    expect(open!.browser).toMatchObject({
      url: '/portal/1',
      title: 'Billing portal',
      text: expect.arrayContaining(['Status: active', 'Renews on 2030-02-15']),
      network: [
        { method: 'GET', path: '/portal/1', resource: 'document', status: 200 },
        { method: 'GET', path: '/subscriptions/1', resource: 'fetch', status: 200 },
      ],
      console: [],
    });
    expect(open!.browser!.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    expect(open!.db).toEqual([]);

    expect(click!.browser!.network).toEqual([
      expect.objectContaining({ method: 'POST', path: '/subscriptions/1/cancel', status: 200 }),
    ]);
    expect(click!.browser!.text).toEqual(expect.arrayContaining(['Cancels on 2030-02-15', 'Cancellation confirmed']));
    expect(click!.db.map((d) => `${d.op} ${d.table}`)).toEqual(['UPDATE subscriptions']);
    expect(click!.egress.map((e) => `${e.fake} ${e.method}`)).toEqual(['stripe POST']);
    expect(click!.events).toEqual([expect.objectContaining({ event: 'subscription.cancel_scheduled' })]);

    // the browser clock follows the sandbox clock (advance 35d happened in between)
    expect(reopen!.browser!.text).toEqual(expect.arrayContaining(['Status: canceled', 'Ended 2030-02-15']));
    expect(existsSync(trace) && statSync(trace).size).toBeGreaterThan(1000);
  });

  it('replays deterministically (raw, no noise filters)', async () => {
    const again = await runScript(sb, portal, { label: 'good-2', sourceRoot: goodTree, screenshots: false });
    const d = diffSessions(good, again, { idPatterns: [] });
    expect(d.entries, formatDiff(d)).toEqual([]);
  });

  it('diffs a bad build through the frontend down to the data', async () => {
    const bad = await runScript(sb, portal, { label: 'bad', sourceRoot: badTree, screenshots: false });
    const where = diffSessions(good, bad)
      .entries.filter((e) => e.step === 3)
      .map((e) => `${e.channel} ${e.path}`);
    expect(where).toEqual(
      expect.arrayContaining(['browser text[2]', 'browser network[0].response.status', 'db [0].new.status']),
    );
  });

  it('a page outside the sandbox is unreachable', async () => {
    const s = await runScript(
      sb,
      { name: 'outside', steps: [{ browser: { goto: 'https://example.com/' } }] },
      { screenshots: false },
    );
    expect(s.steps[0]!.browser!.error).toMatch(/net::ERR_/);
  });

  it('gate scenarios check the page: good PR passes, bad PR fails on what the customer sees', async () => {
    const ok = await runScenario(sb, uiScenario, { sourceRoot: goodTree, label: 'good' });
    expect(ok.failures).toEqual([]);
    const ko = await runScenario(sb, uiScenario, { sourceRoot: badTree, label: 'bad' });
    expect(ko.passed).toBe(false);
    expect(ko.failures[0]).toMatchObject({ step: 3, message: expect.stringContaining('"Status: active"') });
  });
});

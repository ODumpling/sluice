// M1 exit: billing-demo full flow against the Stripe fake with zero real egress.
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadConfig } from '@sluice-dev/config';
import { Sandbox } from '@sluice-dev/sandbox';

const DEMO = join(import.meta.dirname, '..', '..', '..', 'examples', 'billing-demo');
const DAY = 86_400_000;

async function api(sb: Sandbox, method: string, path: string, body?: unknown) {
  const res = await fetch(sb.ingressUrl + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('billing-demo sandbox (M1)', () => {
  let sb: Sandbox;
  beforeAll(async () => {
    const { config, root } = loadConfig(DEMO);
    sb = await Sandbox.up({ root, spec: config.sandbox!, name: config.name });
  });
  afterAll(async () => {
    await sb?.down();
  });

  it('runs the full billing flow against the Stripe fake', async () => {
    const start = sb.clock.now();
    const cust = await api(sb, 'POST', '/customers', { email: 'ada@example.com', name: 'Ada' });
    expect(cust.status).toBe(201);
    const sub = await api(sb, 'POST', '/subscriptions', { customer_id: cust.body.id, plan: 'pro_monthly' });
    expect(sub.status).toBe(201);
    expect(sub.body).toMatchObject({ status: 'active', plan: 'pro_monthly', cancel_at: null });
    expect(sub.body.current_period_end).toBe('2030-02-15T12:00:00.000Z');
    expect((await api(sb, 'GET', `/customers/${cust.body.id}/access`)).body).toMatchObject({ has_access: true });

    // a month and a bit later the fake renews; the app's sync job picks it up
    await sb.advance(35 * DAY);
    const sync = await api(sb, 'POST', '/jobs/sync-subscriptions');
    expect(sync.body).toEqual({ checked: 1, changed: 1 });
    const renewed = await api(sb, 'GET', `/subscriptions/${sub.body.id}`);
    expect(renewed.body).toMatchObject({ status: 'active', current_period_end: '2030-03-15T12:00:00.000Z' });

    const stripe = sb.fakes.get('stripe')!;
    const state = stripe.fake.state() as { invoices: unknown[]; subscriptions: { status: string }[] };
    expect(state.invoices).toHaveLength(2);
    expect(state.subscriptions[0]!.status).toBe('active');
    expect(stripe.violations).toEqual([]);
    expect(stripe.journal.map((j) => `${j.method} ${j.path.replace(/_\w+$/, '_*')}`)).toEqual([
      'POST /v1/customers',
      'GET /v1/prices',
      'POST /v1/products',
      'POST /v1/prices',
      'POST /v1/subscriptions',
      'GET /v1/subscriptions/sub_*',
    ]);

    // the app saw the simulated clock, not wall time
    const db = new pg.Client({ connectionString: sb.databaseUrl });
    await db.connect();
    const { rows } = await db.query('SELECT created_at FROM customers');
    await db.end();
    expect((rows[0] as { created_at: Date }).created_at.getTime()).toBe(start);
  });

  it('has zero real egress: app is only on the internal network and cannot reach the internet', async () => {
    expect(await sb.networks('app')).toEqual([sb.internalNetwork]);
    expect(await sb.networks('db')).toEqual([sb.internalNetwork]);
    const probe = await sb.exec('app', [
      'node',
      '-e',
      "fetch('https://api.stripe.com/v1/charges').then(()=>{console.log('REACHED');process.exit(0)},e=>{console.log('BLOCKED',e.cause?.code??e.message);process.exit(3)})",
    ]);
    expect(probe.stdout).toContain('BLOCKED');
    expect(probe.code).toBe(3);
    const raw = await sb.exec('app', [
      'node',
      '-e',
      "require('net').connect({host:'1.1.1.1',port:443}).on('connect',()=>{console.log('REACHED');process.exit(0)}).on('error',e=>{console.log('BLOCKED',e.code);process.exit(3)});setTimeout(()=>{console.log('BLOCKED timeout');process.exit(3)},3000)",
    ]);
    expect(raw.stdout).toContain('BLOCKED');
  });

  it('reset returns to a pristine, deterministic state', async () => {
    await sb.reset();
    expect((await api(sb, 'GET', '/subscriptions/1')).status).toBe(404);
    expect(sb.fakes.get('stripe')!.journal).toHaveLength(0);
    const a = await api(sb, 'POST', '/customers', { email: 'ada@example.com' });
    expect(a.status).toBe(201);
    expect(a.body.id).toBe(1);
  });
});

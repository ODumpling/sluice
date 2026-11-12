import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import {
  FakeServer,
  RecordingProxy,
  SimClock,
  StripeFake,
  detectSpecDrift,
  detectTrafficDrift,
  readCassette,
  stripeContract,
  type CassetteEntry,
} from '@sluice-dev/fakes';

const START = Date.UTC(2030, 0, 1);

describe('spec drift', () => {
  const current = stripeContract().doc;
  it('identical specs have no drift', () => {
    expect(detectSpecDrift(current, structuredClone(current)).items).toEqual([]);
  });
  it('detects removed operations, fields, type changes and new required fields', () => {
    const next = structuredClone(current);
    delete next.paths['/v1/events']!.get;
    const sub = next.components!.schemas!.subscription as { properties: Record<string, unknown>; required: string[] };
    delete sub.properties.cancel_at_period_end;
    sub.properties.status = { type: 'integer' };
    sub.properties.brand_new = { type: 'string' };
    sub.required.push('brand_new');
    next.info.version = '2099-01-01.future';
    const r = detectSpecDrift(current, next);
    const locs = r.items.map((i) => `${i.severity}:${i.location}`);
    expect(locs).toContain('breaking:GET /v1/events');
    expect(locs).toContain('breaking:subscription.cancel_at_period_end');
    expect(locs).toContain('breaking:subscription.status');
    expect(locs).toContain('breaking:subscription.brand_new');
    expect(locs).toContain('info:info.version');
    expect(r.breaking).toBe(4);
  });
});

describe('recorded traffic drift', () => {
  // "upstream" stands in for the real API: the recorder proxies to it exactly as it would to api.stripe.com.
  const upClock = new SimClock(START);
  const upstream = new FakeServer(new StripeFake({ clock: upClock, seed: 99 }), { clock: upClock });
  const clock = new SimClock(START);
  const target = new FakeServer(new StripeFake({ clock }), { clock });
  let cassette: CassetteEntry[];

  beforeAll(async () => {
    await upstream.start();
    const out = join(mkdtempSync(join(tmpdir(), 'sluice-cassette-')), 'stripe.jsonl');
    const proxy = new RecordingProxy({ target: upstream.url, out, redact: ['sk_test_recording'] });
    const url = new URL(await proxy.start());
    const stripe = new Stripe('sk_test_recording', {
      host: url.hostname,
      port: Number(url.port),
      protocol: 'http',
      maxNetworkRetries: 0,
      apiVersion: stripeContract().version as Stripe.LatestApiVersion,
    });
    const product = await stripe.products.create({ name: 'Pro' });
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: 900,
      recurring: { interval: 'month' },
    });
    const customer = await stripe.customers.create({ email: 'rec@example.com' });
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    await stripe.subscriptions.retrieve(sub.id);
    await proxy.stop();
    cassette = readCassette(out);
  });
  afterAll(async () => {
    await upstream.stop();
  });

  it('records a redacted cassette', () => {
    expect(cassette.map((c) => `${c.method} ${c.path.replace(/sub_\w+/, ':id')}`)).toEqual([
      'POST /v1/products',
      'POST /v1/prices',
      'POST /v1/customers',
      'POST /v1/subscriptions',
      'POST /v1/subscriptions/:id',
      'GET /v1/subscriptions/:id',
    ]);
    expect(JSON.stringify(cassette)).not.toContain('sk_test_recording');
  });

  it('a faithful fake shows zero drift against the recording (ids remapped)', async () => {
    const r = await detectTrafficDrift(stripeContract(), target, cassette);
    expect(r.items).toEqual([]);
  });

  it('detects when real traffic grows fields or changes status', async () => {
    const mutated = structuredClone(cassette);
    (mutated[3]!.response as Record<string, unknown>).new_upstream_field = 'x';
    mutated[5]!.status = 402;
    const r = await detectTrafficDrift(stripeContract(), target, mutated);
    const msgs = r.items.map((i) => i.message);
    expect(msgs.some((m) => m.includes('real response violates contract') && m.includes('new_upstream_field'))).toBe(
      true,
    );
    expect(msgs.some((m) => m.includes('new_upstream_field: present in recorded traffic, missing from fake'))).toBe(
      true,
    );
    expect(msgs).toContain('status differs: recorded 402, fake 200');
  });
});

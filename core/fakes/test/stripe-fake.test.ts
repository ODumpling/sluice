import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { FakeServer, SimClock, StripeFake, detectClientVersionDrift, stripeContract } from '@sluice-dev/fakes';

const START = Date.UTC(2030, 0, 15, 12);
const DAY = 86_400_000;

describe('Stripe fake via the official stripe SDK', () => {
  const clock = new SimClock(START);
  const fake = new StripeFake({ clock });
  const server = new FakeServer(fake, { clock });
  let stripe: Stripe;

  beforeAll(async () => {
    await server.start();
    stripe = new Stripe('sk_test_sluice', {
      host: '127.0.0.1',
      port: server.port,
      protocol: 'http',
      apiVersion: stripeContract().version as Stripe.LatestApiVersion,
      maxNetworkRetries: 0,
      telemetry: false,
    });
  });
  afterAll(() => server.stop());
  beforeEach(() => {
    server.reset(7);
    clock.reset(START);
  });

  async function setup() {
    const product = await stripe.products.create({ name: 'Pro' });
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: 2000,
      recurring: { interval: 'month' },
    });
    const customer = await stripe.customers.create({ email: 'ada@example.com', metadata: { app_id: '1' } });
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    return { product, price, customer, sub };
  }

  it('creates an active subscription with a paid first invoice', async () => {
    const { customer, sub } = await setup();
    expect(sub.status).toBe('active');
    expect(sub.customer).toBe(customer.id);
    const item = sub.items.data[0]!;
    expect(item.current_period_start).toBe(START / 1000);
    expect(item.current_period_end).toBe(Date.UTC(2030, 1, 15, 12) / 1000);
    const invoices = await stripe.invoices.list({ subscription: sub.id });
    expect(invoices.data).toHaveLength(1);
    expect(invoices.data[0]!.status).toBe('paid');
    expect(invoices.data[0]!.amount_paid).toBe(2000);
    expect(server.violations).toEqual([]);
  });

  it('cancel_at_period_end keeps the subscription active until the period ends', async () => {
    const { sub } = await setup();
    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    expect(updated.status).toBe('active');
    expect(updated.cancel_at).toBe(sub.items.data[0]!.current_period_end);
    clock.advance(10 * DAY);
    expect((await stripe.subscriptions.retrieve(sub.id)).status).toBe('active');
    clock.advance(25 * DAY);
    const after = await stripe.subscriptions.retrieve(sub.id);
    expect(after.status).toBe('canceled');
    expect(after.ended_at).toBe(sub.items.data[0]!.current_period_end);
    expect((await stripe.invoices.list({ subscription: sub.id })).data).toHaveLength(1); // no renewal invoice
    const types = (await stripe.events.list({ limit: 100 })).data.map((e) => e.type);
    expect(types).toContain('customer.subscription.deleted');
    expect(server.violations).toEqual([]);
  });

  it('DELETE cancels immediately', async () => {
    const { sub } = await setup();
    const canceled = await stripe.subscriptions.cancel(sub.id);
    expect(canceled.status).toBe('canceled');
    expect(canceled.ended_at).toBe(START / 1000);
    expect((await stripe.subscriptions.list({ customer: sub.customer as string })).data).toHaveLength(0);
    expect((await stripe.subscriptions.list({ status: 'canceled' })).data).toHaveLength(1);
  });

  it('renews each cycle when the clock passes the period end', async () => {
    const { sub } = await setup();
    clock.advance(65 * DAY); // passes Feb 15 and Mar 15
    const s = await stripe.subscriptions.retrieve(sub.id);
    expect(s.status).toBe('active');
    expect(s.items.data[0]!.current_period_start).toBe(Date.UTC(2030, 2, 15, 12) / 1000);
    const invoices = await stripe.invoices.list({ subscription: sub.id });
    expect(invoices.data.map((i) => i.billing_reason)).toEqual([
      'subscription_cycle',
      'subscription_cycle',
      'subscription_create',
    ]);
    expect(server.violations).toEqual([]);
  });

  it('supports expand[]', async () => {
    const { sub, customer } = await setup();
    const s = await stripe.subscriptions.retrieve(sub.id, { expand: ['customer', 'latest_invoice'] });
    expect((s.customer as Stripe.Customer).email).toBe(customer.email);
    expect((s.latest_invoice as Stripe.Invoice).object).toBe('invoice');
  });

  it('returns Stripe-shaped errors', async () => {
    await expect(stripe.subscriptions.retrieve('sub_missing')).rejects.toMatchObject({
      type: 'StripeInvalidRequestError',
      code: 'resource_missing',
      statusCode: 404,
    });
    await expect(
      stripe.customers.create({ email: 'x@y.z', not_a_param: 1 } as unknown as Stripe.CustomerCreateParams),
    ).rejects.toMatchObject({ statusCode: 400 });
    const anon = new Stripe('pk_live_nope', {
      host: '127.0.0.1',
      port: server.port,
      protocol: 'http',
      maxNetworkRetries: 0,
    });
    await expect(anon.customers.list()).rejects.toMatchObject({ statusCode: 401 });
  });

  it('is deterministic for a given seed', async () => {
    const a = await setup();
    server.reset(7);
    clock.reset(START);
    const b = await setup();
    expect(b.sub.id).toBe(a.sub.id);
    expect(b.customer.id).toBe(a.customer.id);
  });

  it('honours idempotency keys', async () => {
    const c1 = await stripe.customers.create({ email: 'i@x.io' }, { idempotencyKey: 'k1' });
    const c2 = await stripe.customers.create({ email: 'i@x.io' }, { idempotencyKey: 'k1' });
    expect(c2.id).toBe(c1.id);
    expect((await stripe.customers.list()).data).toHaveLength(1);
  });

  it('journals every exchange and reports client API version drift', async () => {
    await setup();
    expect(server.journal.length).toBeGreaterThanOrEqual(4);
    expect(server.journal[0]).toMatchObject({ fake: 'stripe', method: 'POST', path: '/v1/products', status: 200 });
    expect(detectClientVersionDrift(stripeContract(), fake.apiVersionsSeen).items).toEqual([]);
    expect(detectClientVersionDrift(stripeContract(), ['2020-08-27']).warnings).toBe(1);
  });
});

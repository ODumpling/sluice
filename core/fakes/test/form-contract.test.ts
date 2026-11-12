import { describe, expect, it } from 'vitest';
import { decodeForm, detectFixtureDrift, encodeForm, stripeContract, stripeFixtures } from '@sluice-dev/fakes';

describe('form encoding', () => {
  it('decodes Stripe bracket notation', () => {
    expect(
      decodeForm('items[0][price]=p1&items[1][price]=p2&items[1][quantity]=2&expand[]=a&expand[]=b&metadata[k]=v&x=1'),
    ).toEqual({
      items: [{ price: 'p1' }, { price: 'p2', quantity: '2' }],
      expand: ['a', 'b'],
      metadata: { k: 'v' },
      x: '1',
    });
  });
  it('round-trips', () => {
    const o = { a: [{ b: 'c' }], m: { k: 'v w' }, n: '3' };
    expect(decodeForm(encodeForm(o))).toEqual(o);
  });
});

describe('Stripe contract (vendored OpenAPI)', () => {
  const c = stripeContract();
  it('matches routes with path params, literal routes first', () => {
    const m = c.match('GET', '/v1/subscriptions/sub_123');
    expect(m?.template).toBe('/v1/subscriptions/{subscription_exposed_id}');
    expect(m?.pathParams).toEqual({ subscription_exposed_id: 'sub_123' });
    expect(c.match('GET', '/v1/subscriptions')?.template).toBe('/v1/subscriptions');
    expect(c.match('PATCH', '/v1/subscriptions')).toBeUndefined();
    expect(c.match('GET', '/v1/charges')).toBeUndefined();
  });
  it('coerces form strings and rejects unknown parameters', () => {
    const m = c.match('POST', '/v1/subscriptions/{x}'.replace('{x}', 'sub_1'))!;
    const ok = c.validateRequest(m, {}, { cancel_at_period_end: 'true', metadata: { a: 'b' } });
    expect(ok.errors).toEqual([]);
    expect(ok.body.cancel_at_period_end).toBe(true);
    const bad = c.validateRequest(m, {}, { cancel_immediately: 'true' });
    expect(bad.errors.join()).toMatch(/undocumented property "cancel_immediately"/);
  });
  it('synthesizes spec-valid objects for every resource the fake serves', () => {
    for (const name of ['customer', 'product', 'price', 'subscription', 'subscription_item', 'invoice', 'event']) {
      const obj = c.synthesize(name);
      expect(c.validateSchema(name, obj), name).toEqual([]);
    }
  });
  it('strict response validation flags undocumented and mistyped fields', () => {
    const m = c.match('GET', '/v1/customers/cus_1')!;
    const good = { ...(c.synthesize('customer') as object), id: 'cus_1' };
    expect(c.validateResponse(m, 200, good)).toEqual([]);
    expect(c.validateResponse(m, 200, { ...good, made_up: 1 }).join()).toMatch(/undocumented property "made_up"/);
    expect(c.validateResponse(m, 200, { ...good, created: 'yesterday' }).join()).toMatch(/created/);
  });
  it('fixture drift detection finds real drift between Stripe fixtures and spec', () => {
    // Stripe's published fixtures3.json carries invoice.subscription and product.type, which
    // spec3.json no longer documents (invoice.subscription moved to invoice.parent.subscription_details in 2025-03-31.basil).
    // Genuine upstream drift, found by the detector; everything else lines up.
    const r = detectFixtureDrift(c, stripeFixtures());
    expect(r.items.map((i) => i.location).sort()).toEqual(['invoice.subscription', 'product.type']);
    expect(r.breaking).toBe(0);
  });
});

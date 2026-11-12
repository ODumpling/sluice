import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBilling, HttpError } from '../src/billing.js';

function fakeDb(handlers) {
  return {
    async query(sql, params) {
      for (const [prefix, fn] of handlers) if (sql.trim().startsWith(prefix)) return fn(params);
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('createCustomer rejects invalid email', async () => {
  const billing = createBilling({ db: fakeDb([]), stripe: {} });
  await assert.rejects(billing.createCustomer({ email: 'nope' }), (e) => e instanceof HttpError && e.status === 400);
});

test('createCustomer stores the Stripe customer id', async () => {
  const inserted = [];
  const db = fakeDb([
    ['SELECT id FROM customers', () => ({ rows: [] })],
    ['INSERT INTO customers', (p) => (inserted.push(p), { rows: [{ id: 1, email: p[0], name: p[1] }] })],
  ]);
  const stripe = { customers: { create: async () => ({ id: 'cus_123' }) } };
  const c = await createBilling({ db, stripe }).createCustomer({ email: 'a@b.co', name: 'A' });
  assert.deepEqual(c, { id: 1, email: 'a@b.co', name: 'A' });
  assert.equal(inserted[0][2], 'cus_123');
});

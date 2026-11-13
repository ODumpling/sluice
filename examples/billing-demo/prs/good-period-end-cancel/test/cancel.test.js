import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBilling } from '../src/billing.js';

test('cancel schedules cancellation at period end', async () => {
  const updates = [];
  const end = new Date('2030-02-15T12:00:00Z');
  const db = {
    async query(sql, params) {
      if (sql.startsWith('SELECT * FROM subscriptions'))
        return {
          rows: [
            {
              id: 1,
              status: 'active',
              stripe_subscription_id: 'sub_1',
              plan: 'pro_monthly',
              customer_id: 1,
              current_period_end: end,
              cancel_at: null,
              canceled_at: null,
            },
          ],
        };
      if (sql.startsWith('UPDATE subscriptions'))
        return {
          rows: [
            {
              id: 1,
              status: 'active',
              plan: 'pro_monthly',
              customer_id: 1,
              current_period_end: end,
              cancel_at: params[1],
              canceled_at: null,
            },
          ],
        };
      throw new Error(sql);
    },
  };
  const stripe = {
    subscriptions: { update: async (id, p) => (updates.push([id, p]), { cancel_at: end.getTime() / 1000 }) },
  };
  const sub = await createBilling({ db, stripe }).cancel(1);
  assert.deepEqual(updates, [['sub_1', { cancel_at_period_end: true }]]);
  assert.equal(sub.status, 'active');
  assert.equal(sub.cancel_at, end.toISOString());
});

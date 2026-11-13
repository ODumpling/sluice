import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBilling } from '../src/billing.js';

test('cancel cancels the subscription in Stripe and marks it canceled', async () => {
  const canceled = [];
  const db = {
    async query(sql) {
      if (sql.startsWith('SELECT * FROM subscriptions'))
        return {
          rows: [
            {
              id: 1,
              status: 'active',
              stripe_subscription_id: 'sub_1',
              plan: 'pro_monthly',
              customer_id: 1,
              current_period_end: new Date(),
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
              status: 'canceled',
              plan: 'pro_monthly',
              customer_id: 1,
              current_period_end: new Date(),
              cancel_at: null,
              canceled_at: new Date(),
            },
          ],
        };
      throw new Error(sql);
    },
  };
  const stripe = { subscriptions: { cancel: async (id) => canceled.push(id) } };
  const sub = await createBilling({ db, stripe }).cancel(1);
  assert.deepEqual(canceled, ['sub_1']);
  assert.equal(sub.status, 'canceled');
});

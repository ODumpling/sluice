import { emit } from './events.js';

export const PLANS = {
  pro_monthly: { name: 'Pro', amount_cents: 2000, interval: 'month' },
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const iso = (sec) => (sec == null ? null : new Date(sec * 1000).toISOString());

function rowToSubscription(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    plan: row.plan,
    status: row.status,
    current_period_end: row.current_period_end.toISOString(),
    cancel_at: row.cancel_at ? row.cancel_at.toISOString() : null,
    canceled_at: row.canceled_at ? row.canceled_at.toISOString() : null,
  };
}

export function createBilling({ db, stripe }) {
  async function ensurePlan(code) {
    const plan = PLANS[code];
    if (!plan) throw new HttpError(400, `unknown plan ${code}`);
    const existing = await db.query('SELECT * FROM plans WHERE code = $1', [code]);
    if (existing.rows[0]) return existing.rows[0];
    const found = await stripe.prices.list({ lookup_keys: [code], limit: 1 });
    let price = found.data[0];
    if (!price) {
      const product = await stripe.products.create({ name: plan.name });
      price = await stripe.prices.create({
        product: product.id,
        currency: 'usd',
        unit_amount: plan.amount_cents,
        recurring: { interval: plan.interval },
        lookup_key: code,
      });
    }
    const { rows } = await db.query(
      'INSERT INTO plans (code, stripe_price_id, amount_cents, interval) VALUES ($1, $2, $3, $4) RETURNING *',
      [code, price.id, plan.amount_cents, plan.interval],
    );
    return rows[0];
  }

  async function getSubscriptionRow(id) {
    const { rows } = await db.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, `subscription ${id} not found`);
    return rows[0];
  }

  return {
    async createCustomer({ email, name }) {
      if (typeof email !== 'string' || !email.includes('@')) throw new HttpError(400, 'valid email required');
      const dupe = await db.query('SELECT id FROM customers WHERE email = $1', [email]);
      if (dupe.rows[0]) throw new HttpError(409, 'email already registered');
      const sc = await stripe.customers.create({ email, name: name ?? undefined });
      const { rows } = await db.query(
        'INSERT INTO customers (email, name, stripe_customer_id, created_at) VALUES ($1, $2, $3, $4) RETURNING *',
        [email, name ?? null, sc.id, new Date()],
      );
      emit('customer.created', { customer_id: rows[0].id });
      return { id: rows[0].id, email: rows[0].email, name: rows[0].name };
    },

    async subscribe({ customer_id, plan = 'pro_monthly' }) {
      const { rows: custRows } = await db.query('SELECT * FROM customers WHERE id = $1', [customer_id]);
      const customer = custRows[0];
      if (!customer) throw new HttpError(404, `customer ${customer_id} not found`);
      const active = await db.query(
        "SELECT id FROM subscriptions WHERE customer_id = $1 AND status IN ('active', 'past_due')",
        [customer_id],
      );
      if (active.rows[0]) throw new HttpError(409, 'customer already has an active subscription');
      const p = await ensurePlan(plan);
      const sub = await stripe.subscriptions.create({
        customer: customer.stripe_customer_id,
        items: [{ price: p.stripe_price_id }],
        metadata: { customer_id: String(customer_id) },
      });
      const now = new Date();
      const { rows } = await db.query(
        `INSERT INTO subscriptions (customer_id, plan, stripe_subscription_id, status, current_period_end, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
        [customer_id, plan, sub.id, sub.status, new Date(sub.items.data[0].current_period_end * 1000), now],
      );
      emit('subscription.created', { subscription_id: rows[0].id, customer_id });
      return rowToSubscription(rows[0]);
    },

    /** CANCEL-1: cancel a subscription. */
    async cancel(id) {
      const row = await getSubscriptionRow(id);
      if (row.status === 'canceled') throw new HttpError(409, 'subscription already canceled');
      await stripe.subscriptions.cancel(row.stripe_subscription_id);
      const now = new Date();
      const { rows } = await db.query(
        `UPDATE subscriptions SET status = 'canceled', canceled_at = $2, updated_at = $2 WHERE id = $1 RETURNING *`,
        [id, now],
      );
      emit('subscription.canceled', { subscription_id: id });
      return rowToSubscription(rows[0]);
    },

    async getSubscription(id) {
      return rowToSubscription(await getSubscriptionRow(id));
    },

    async access(customer_id) {
      const { rows } = await db.query(`SELECT * FROM subscriptions WHERE customer_id = $1 ORDER BY id DESC LIMIT 1`, [
        customer_id,
      ]);
      const sub = rows[0];
      const now = new Date();
      const hasAccess = !!sub && sub.status !== 'canceled' && sub.current_period_end > now;
      return {
        customer_id: Number(customer_id),
        has_access: hasAccess,
        plan: hasAccess ? sub.plan : null,
        access_until: hasAccess ? (sub.cancel_at ?? sub.current_period_end).toISOString() : null,
      };
    },

    /** Pull subscription state from Stripe (renewals, scheduled cancellations). */
    async syncSubscriptions() {
      const { rows } = await db.query("SELECT * FROM subscriptions WHERE status <> 'canceled' ORDER BY id");
      let changed = 0;
      for (const row of rows) {
        const s = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
        const periodEnd = new Date(s.items.data[0].current_period_end * 1000);
        const cancelAt = s.cancel_at ? new Date(s.cancel_at * 1000) : null;
        const canceledAt = s.ended_at ? new Date(s.ended_at * 1000) : null;
        if (
          s.status !== row.status ||
          periodEnd.getTime() !== row.current_period_end.getTime() ||
          (cancelAt?.getTime() ?? null) !== (row.cancel_at?.getTime() ?? null)
        ) {
          await db.query(
            `UPDATE subscriptions SET status = $2, current_period_end = $3, cancel_at = $4, canceled_at = COALESCE($5, canceled_at), updated_at = $6 WHERE id = $1`,
            [row.id, s.status, periodEnd, cancelAt, canceledAt, new Date()],
          );
          if (s.status !== row.status) emit(`subscription.${s.status}`, { subscription_id: row.id });
          changed++;
        }
      }
      return { checked: rows.length, changed };
    },
    iso,
  };
}

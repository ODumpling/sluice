import pg from 'pg';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS plans (
     code text PRIMARY KEY,
     stripe_price_id text NOT NULL,
     amount_cents integer NOT NULL,
     interval text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS customers (
     id serial PRIMARY KEY,
     email text NOT NULL UNIQUE,
     name text,
     stripe_customer_id text NOT NULL,
     created_at timestamptz NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
     id serial PRIMARY KEY,
     customer_id integer NOT NULL REFERENCES customers(id),
     plan text NOT NULL REFERENCES plans(code),
     stripe_subscription_id text NOT NULL UNIQUE,
     status text NOT NULL,
     current_period_end timestamptz NOT NULL,
     cancel_at timestamptz,
     canceled_at timestamptz,
     created_at timestamptz NOT NULL,
     updated_at timestamptz NOT NULL
   )`,
];

export function createPool(url = process.env.DATABASE_URL) {
  return new pg.Pool({ connectionString: url, max: 5 });
}

export async function migrate(pool) {
  for (const sql of MIGRATIONS) await pool.query(sql);
}

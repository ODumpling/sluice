import Stripe from 'stripe';

/** Stripe client. STRIPE_API_BASE lets the app run against the Sluice Stripe fake. */
export function createStripe(env = process.env) {
  const opts = { apiVersion: '2026-09-30.endive', maxNetworkRetries: 1, telemetry: false };
  if (env.STRIPE_API_BASE) {
    const u = new URL(env.STRIPE_API_BASE);
    Object.assign(opts, { host: u.hostname, port: Number(u.port || 80), protocol: u.protocol.replace(':', '') });
  }
  return new Stripe(env.STRIPE_SECRET_KEY, opts);
}

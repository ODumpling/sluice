import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Script } from '@sluice-dev/evidence';

export const DEMO = join(import.meta.dirname, '..', '..', 'examples', 'billing-demo');

/** A source tree for billing-demo with one textual edit applied to a file under src/. */
export function variant(file: string, from: string, to: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sluice-variant-'));
  cpSync(join(DEMO, 'src'), join(root, 'src'), { recursive: true });
  const p = join(root, 'src', file);
  const src = readFileSync(p, 'utf8');
  if (!src.includes(from)) throw new Error(`variant: ${JSON.stringify(from)} not found in ${file}`);
  writeFileSync(p, src.replace(from, to));
  return root;
}

export const subscribeAndRenew: Script = {
  name: 'subscribe-and-renew',
  steps: [
    {
      http: { method: 'POST', path: '/customers', body: { email: 'ada@example.com', name: 'Ada' } },
      save: { cust: 'body.id' },
    },
    {
      http: { method: 'POST', path: '/subscriptions', body: { customer_id: '${cust}', plan: 'pro_monthly' } },
      save: { sub: 'body.id' },
    },
    { http: { method: 'GET', path: '/subscriptions/${sub}' } },
    { http: { method: 'GET', path: '/customers/${cust}/access' } },
    { advance: '35d' },
    { http: { method: 'POST', path: '/jobs/sync-subscriptions' } },
    { http: { method: 'GET', path: '/subscriptions/${sub}' } },
  ],
};

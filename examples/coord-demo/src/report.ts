import type { Invoice } from './types.js';

export function renderReport(invoices: Invoice[]): string {
  return invoices.map((i) => `${i.id}\t${(i.amountCents / 100).toFixed(2)}`).join('\n');
}

import type { Invoice } from './types.js';

export function createInvoice(customerId: string, amountCents: number, issuedAt: string): Invoice {
  return { id: `inv_${customerId}_${issuedAt}`, customerId, amountCents, issuedAt };
}

export function totalCents(invoices: Invoice[]): number {
  return invoices.reduce((sum, i) => sum + i.amountCents, 0);
}

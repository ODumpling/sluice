/** An invoice as stored and exchanged between modules. */
export interface Invoice {
  id: string;
  customerId: string;
  amountCents: number;
  issuedAt: string;
}

export type InvoiceStatus = 'draft' | 'open' | 'paid';

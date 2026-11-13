import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceSummary } from '../src/invoice.js';

test('summary shows total and tax', () => {
  assert.equal(invoiceSummary({ total: 108.25, tax: 8.25 }), 'Total $108.25 (tax 8.25)');
});

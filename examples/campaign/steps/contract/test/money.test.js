import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as money from '../index.js';

test('formats cents', () => {
  assert.equal(money.formatCents(1250), '$12.50');
  assert.equal(money.formatCents(300, { symbol: false }), '3.00');
  assert.throws(() => money.formatCents(12.5), TypeError);
});

test('the deprecated float API is gone', () => {
  assert.equal(money.formatDollars, undefined);
});

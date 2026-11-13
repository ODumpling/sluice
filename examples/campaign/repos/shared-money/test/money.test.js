import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as money from '../index.js';

test('formats dollars', () => {
  assert.equal(money.formatDollars(12.5), '$12.50');
  assert.equal(money.formatDollars(3, { symbol: false }), '3.00');
});

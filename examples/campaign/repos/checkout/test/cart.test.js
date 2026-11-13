import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartLine } from '../src/cart.js';

test('cart line shows the line total', () => {
  assert.equal(cartLine({ name: 'Pro plan', qty: 2, price: 20 }), 'Pro plan x2: $40.00');
});

/**
 * Money formatting shared by every service.
 * @deprecated formatDollars takes a float amount; use formatCents (integer cents).
 */
export function formatDollars(amount, opts = {}) {
  const s = amount.toFixed(2);
  return opts.symbol === false ? s : `$${s}`;
}

/** Format integer cents. */
export function formatCents(cents, opts = {}) {
  if (!Number.isInteger(cents)) throw new TypeError('formatCents expects integer cents');
  const s = (cents / 100).toFixed(2);
  return opts.symbol === false ? s : `$${s}`;
}

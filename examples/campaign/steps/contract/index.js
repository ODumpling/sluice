/** Money formatting shared by every service. */

/** Format integer cents. */
export function formatCents(cents, opts = {}) {
  if (!Number.isInteger(cents)) throw new TypeError('formatCents expects integer cents');
  const s = (cents / 100).toFixed(2);
  return opts.symbol === false ? s : `$${s}`;
}

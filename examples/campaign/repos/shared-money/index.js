/**
 * Money formatting shared by every service.
 * @deprecated formatDollars takes a float amount; use formatCents (integer cents).
 */
export function formatDollars(amount, opts = {}) {
  const s = amount.toFixed(2);
  return opts.symbol === false ? s : `$${s}`;
}

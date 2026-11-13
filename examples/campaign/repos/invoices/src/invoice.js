import { formatDollars } from '../../shared-money/index.js';

export function invoiceSummary(inv) {
  return `Total ${formatDollars(inv.total)} (tax ${formatDollars(inv.tax, { symbol: false })})`;
}

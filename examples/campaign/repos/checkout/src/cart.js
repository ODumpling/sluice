import { formatDollars } from '../../shared-money/index.js';

export function cartLine(item) {
  return `${item.name} x${item.qty}: ${formatDollars(item.price * item.qty)}`;
}

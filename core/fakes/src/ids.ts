/** Seeded PRNG (mulberry32) and deterministic Stripe-like id generation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export class IdGenerator {
  private rng: () => number;
  constructor(private seed = 1) {
    this.rng = mulberry32(seed);
  }
  reset(seed = this.seed): void {
    this.seed = seed;
    this.rng = mulberry32(seed);
  }
  next(prefix: string, length = 14): string {
    let s = '';
    for (let i = 0; i < length; i++) s += ALPHABET[Math.floor(this.rng() * ALPHABET.length)];
    return `${prefix}_${s}`;
  }
}

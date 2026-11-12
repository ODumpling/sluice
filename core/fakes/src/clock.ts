/** Simulated wall clock shared by fakes and (via the determinism shim) the app. */
export type ClockListener = (nowMs: number, prevMs: number) => void;

export class SimClock {
  private ms: number;
  private readonly listeners = new Set<ClockListener>();

  constructor(startMs: number = Date.UTC(2030, 0, 1)) {
    this.ms = startMs;
  }

  now(): number {
    return this.ms;
  }

  nowSeconds(): number {
    return Math.floor(this.ms / 1000);
  }

  /** Move the clock; time never goes backwards except through reset(). */
  set(ms: number): void {
    if (ms < this.ms) throw new Error(`clock cannot move backwards (${ms} < ${this.ms})`);
    const prev = this.ms;
    this.ms = ms;
    for (const l of this.listeners) l(ms, prev);
  }

  advance(deltaMs: number): void {
    this.set(this.ms + deltaMs);
  }

  reset(ms: number): void {
    this.ms = ms;
  }

  onChange(l: ClockListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

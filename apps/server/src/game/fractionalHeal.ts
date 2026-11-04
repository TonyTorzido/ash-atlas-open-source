/**
 * Percent-of-max-health heals land in whole points, so a per-beat fraction (0.7% of 100 HP is 0.7)
 * is carried to the next tick instead of rounded up: healing per second stays what the design says.
 */
export class FractionalHealCarry {
  private readonly carry = new Map<string, number>();

  /** Whole points to heal now for `amount` (possibly fractional); the remainder waits for the next tick. */
  take(key: string, amount: number): number {
    const total = (this.carry.get(key) ?? 0) + amount;
    const whole = Math.floor(total + 1e-9);
    this.carry.set(key, Math.max(0, total - whole));
    return whole;
  }

  clear(key: string): void {
    this.carry.delete(key);
  }
}

/** Next due time for a fixed-interval pass: no drift, and no burst of catch-up passes after a stall. */
export function nextBeatDueAt(lastDueAt: number, now: number, intervalMs: number): number {
  const next = lastDueAt + intervalMs;
  return now - next >= intervalMs ? now : next;
}

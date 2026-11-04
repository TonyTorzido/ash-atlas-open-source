export type RollingStatsSummary = Readonly<{
  count: number;
  p50: number;
  p95: number;
  max: number;
}>;

/** Fixed-capacity ring of recent numbers with cheap percentile summaries. */
export class RollingStats {
  private readonly values: number[] = [];
  private cursor = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
  }

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.values.length < this.capacity) {
      this.values.push(value);
      return;
    }
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.capacity;
  }

  summary(): RollingStatsSummary {
    if (this.values.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
    const sorted = [...this.values].sort((left, right) => left - right);
    const at = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] as number;
    return {
      count: sorted.length,
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      max: round(sorted[sorted.length - 1] as number)
    };
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

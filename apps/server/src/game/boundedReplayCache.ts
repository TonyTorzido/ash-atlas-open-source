export class BoundedReplayCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly maximumEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("maximumEntries must be a positive integer");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("ttlMs must be positive");
    }
  }

  get(key: K): V | undefined {
    this.pruneExpired();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.pruneExpired();
    this.entries.delete(key);
    while (this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

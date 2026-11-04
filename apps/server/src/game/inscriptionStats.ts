import type pg from "pg";

/** What the combat engine needs: counters only go up (`max` keeps a high-water mark). */
export interface InscriptionCounters {
  add(instanceId: string, key: string, amount?: number): void;
  max(instanceId: string, key: string, value: number): void;
  /** Persist the given items now (a player logging out). */
  flush?(instanceIds?: readonly string[]): Promise<void>;
}

const MAX_KEYS = new Set(["highestDamageTaken"]);

/**
 * In-memory per-item counters, written in batches (a timer, logout and shutdown call flush).
 * A crash loses at most one flush interval. Writes add to the stored value in SQL, so a
 * re-inscription in between never loses or resets the persisted counters.
 */
export class InscriptionStatsRecorder implements InscriptionCounters {
  private pending = new Map<string, Map<string, number>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly pool: pg.Pool, private readonly intervalMs = 30_000) {}

  add(instanceId: string, key: string, amount = 1): void {
    if (!(amount > 0)) return;
    const row = this.row(instanceId);
    row.set(key, (row.get(key) ?? 0) + Math.floor(amount));
  }

  max(instanceId: string, key: string, value: number): void {
    if (!(value > 0)) return;
    const row = this.row(instanceId);
    row.set(key, Math.max(row.get(key) ?? 0, Math.floor(value)));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush().catch(() => undefined); }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  pendingCount(): number { return this.pending.size; }

  /**
   * Writes everything pending (or only the given items). Each item is written on its own; any item
   * that did not get written goes back into pending (merged with counts recorded meanwhile), and the
   * first failure is thrown once every item has been tried.
   */
  async flush(instanceIds?: readonly string[]): Promise<void> {
    const taken = new Map<string, Map<string, number>>();
    for (const [id, row] of this.pending) {
      if (instanceIds && !instanceIds.includes(id)) continue;
      taken.set(id, row);
      this.pending.delete(id);
    }
    let firstError: unknown = null;
    for (const [id, row] of taken) {
      try {
        await this.pool.query(
          `UPDATE equipment_instances e
              SET inscription_stats = e.inscription_stats || COALESCE((
                SELECT jsonb_object_agg(d.key,
                  CASE WHEN d.key = ANY($3::text[])
                    THEN GREATEST(COALESCE((e.inscription_stats->>d.key)::bigint, 0), d.value::bigint)
                    ELSE COALESCE((e.inscription_stats->>d.key)::bigint, 0) + d.value::bigint END)
                FROM jsonb_each_text($2::jsonb) AS d(key, value)), '{}'::jsonb)
            WHERE e.instance_id = $1 AND e.inscription_name IS NOT NULL`,
          [id, JSON.stringify(Object.fromEntries(row)), [...MAX_KEYS]]
        );
      } catch (error) {
        firstError ??= error;
        for (const [key, value] of row) {
          if (MAX_KEYS.has(key)) this.max(id, key, value); else this.add(id, key, value);
        }
      }
    }
    if (firstError !== null) throw firstError;
  }

  private row(instanceId: string): Map<string, number> {
    let row = this.pending.get(instanceId);
    if (!row) { row = new Map(); this.pending.set(instanceId, row); }
    return row;
  }
}

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type pg from "pg";

import type { AppLogger } from "../logger.js";

const JOB_KEY = "remove-population-flag-wildlife-suppression-v1";
const TABLES = [
  "collectible_nodes",
  "generated_world_mobs",
  "repeatable_resource_nodes"
] as const;

export class PopulationFlagSuppressionCleanupWorker {
  private readonly ownerId = `population-flag-cleanup:${process.pid}:${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private stopping = false;
  private lastError: string | null = null;
  private retries = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Pick<AppLogger, "warn">,
    private readonly pressureElevated: () => boolean,
    private readonly intervalMs = 1_000,
    private readonly batchSize = 1_000,
    private readonly leaseMs = 30_000
  ) {}

  start(): void {
    if (this.timer) throw new Error("population flag cleanup worker is already running");
    this.stopping = false;
    this.timer = setInterval(() => this.pump(), this.intervalMs);
    this.timer.unref?.();
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.active) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async metricsSnapshot(): Promise<Readonly<{
    pendingJobs: number;
    active: boolean;
    rowsRemainingEstimate: number | null;
    rowsCleared: number;
    batchesCommitted: number;
    lastBatchDurationMs: number | null;
    lastError: string | null;
    retries: number;
    oldestJobAgeMs: number;
  }>> {
    const result = await this.pool.query<{
      status: string;
      rows_cleared: string | number;
      batches_committed: string | number;
      last_batch_duration_ms: number | null;
      last_error: string | null;
      oldest_job_age_ms: string | number;
    }>(
      `SELECT status, rows_cleared, batches_committed,
              last_batch_duration_ms, last_error,
              extract(epoch FROM (clock_timestamp() - created_at)) * 1000
                AS oldest_job_age_ms
       FROM population_flag_suppression_cleanup_jobs
       WHERE job_key = $1`,
      [JOB_KEY]
    );
    const row = result.rows[0];
    return {
      pendingJobs: row && row.status !== "completed" ? 1 : 0,
      active: this.active,
      rowsRemainingEstimate: row?.status === "completed" ? 0 : null,
      rowsCleared: Number(row?.rows_cleared ?? 0),
      batchesCommitted: Number(row?.batches_committed ?? 0),
      lastBatchDurationMs: row?.last_batch_duration_ms ?? null,
      lastError: row?.last_error ?? this.lastError,
      retries: this.retries,
      oldestJobAgeMs: Number(row?.oldest_job_age_ms ?? 0)
    };
  }

  private pump(): void {
    if (
      this.stopping
      || this.active
      || this.pressureElevated()
    ) return;
    this.active = true;
    void this.runBatch()
      .catch(async (error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.retries += 1;
        const retryMs = Math.min(60_000, 1_000 * (2 ** Math.min(this.retries, 6)));
        await this.pool.query(
          `UPDATE population_flag_suppression_cleanup_jobs
           SET status = 'retrying', lease_owner = NULL, lease_expires_at = NULL,
               next_retry_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
               last_error = $3, updated_at = clock_timestamp()
           WHERE job_key = $1 AND status <> 'completed'`,
          [JOB_KEY, retryMs, this.lastError.slice(0, 2_000)]
        ).catch(() => undefined);
        this.logger.warn(
          { err: error, retryMs },
          "population flag suppression cleanup batch failed"
        );
      })
      .finally(() => {
        this.active = false;
      });
  }

  private async runBatch(): Promise<void> {
    const client = await this.pool.connect();
    const startedAt = performance.now();
    try {
      await client.query("BEGIN");
      const claim = await client.query<{
        table_index: number;
        lease_generation: string | number;
      }>(
        `UPDATE population_flag_suppression_cleanup_jobs
         SET status = 'processing', lease_owner = $2,
             lease_generation = lease_generation + 1,
             lease_expires_at =
               clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             attempt_count = attempt_count + 1,
             updated_at = clock_timestamp()
         WHERE job_key = $1
           AND status <> 'completed'
           AND next_retry_at <= clock_timestamp()
           AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
         RETURNING table_index, lease_generation`,
        [JOB_KEY, this.ownerId, this.leaseMs]
      );
      const claimed = claim.rows[0];
      if (!claimed) {
        await client.query("COMMIT");
        return;
      }
      const table = TABLES[claimed.table_index];
      if (!table) {
        await client.query(
          `UPDATE population_flag_suppression_cleanup_jobs
           SET status = 'completed', completed_at = clock_timestamp(),
               lease_owner = NULL, lease_expires_at = NULL,
               updated_at = clock_timestamp()
           WHERE job_key = $1 AND lease_owner = $2
             AND lease_generation = $3`,
          [JOB_KEY, this.ownerId, claimed.lease_generation]
        );
        await client.query("COMMIT");
        return;
      }
      const updated = await client.query(
        `WITH batch AS (
           SELECT population_v2_entity_id
           FROM ${table}
           WHERE population_v2_entity_id IS NOT NULL
             AND population_flag_suppressed
           ORDER BY population_v2_entity_id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE ${table} AS projection
         SET population_flag_suppressed = false
         FROM batch
         WHERE projection.population_v2_entity_id =
           batch.population_v2_entity_id`,
        [this.batchSize]
      );
      const changed = updated.rowCount ?? 0;
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      await client.query(
        `UPDATE population_flag_suppression_cleanup_jobs
         SET status = 'pending',
             table_index = table_index + CASE WHEN $4 = 0 THEN 1 ELSE 0 END,
             rows_cleared = rows_cleared + $4,
             batches_committed = batches_committed + 1,
             last_batch_duration_ms = $5,
             last_error = NULL, lease_owner = NULL, lease_expires_at = NULL,
             next_retry_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE job_key = $1 AND lease_owner = $2
           AND lease_generation = $3`,
        [
          JOB_KEY,
          this.ownerId,
          claimed.lease_generation,
          changed,
          durationMs
        ]
      );
      await client.query("COMMIT");
      this.lastError = null;
      this.retries = 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

import type pg from "pg";

import {
  closeFlagTerminalOperationsInTransaction,
  lockFlagTerminalOperationsInTransaction
} from "./flags.js";

/** A personal flag is abandoned once its owner has not been seen for 30 days. */
export const FLAG_ABANDONMENT_INACTIVE_DAYS = 30;
export const FLAG_ABANDONMENT_INACTIVE_MS = FLAG_ABANDONMENT_INACTIVE_DAYS * 24 * 60 * 60 * 1_000;
export const FLAG_ABANDONMENT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type FlagAbandonmentResult = Readonly<{
  abandonedFlagIds: string[];
  /** Owners whose flags went, for flag-list refreshes. */
  ownerPlayerIds: string[];
  /** Candidates that threw this pass; the caller logs them and the next sweep retries. */
  failures: Array<Readonly<{ flagId: string; error: unknown }>>;
}>;

/*
 * Candidates: standalone personal flags (never a Kingdom / City flag or a
 * Castle, never a reserved Castle source, a system or developer fixture, or
 * a flag holding a legendary encounter) whose owner's players.last_seen_at
 * is older than the cutoff. last_seen_at is the authoritative activity
 * column: connect, disconnect, movement and travel all advance it.
 */
const CANDIDATE_CONDITIONS = `
  flag.control_type = 'personal'
  AND flag.city_id IS NULL AND flag.kingdom_id IS NULL
  AND flag.system_controlled = false
  AND flag.developer_test_target = false
  AND flag.kingdom_founding_request_id IS NULL
  AND owner.last_seen_at < $1::timestamptz
  AND NOT EXISTS (
    SELECT 1 FROM legendary_bird_events event
    WHERE event.flag_id = flag.id AND event.status IN ('pending', 'active')
  )`;

/**
 * Removes up to `limit` abandoned flags, each in its own transaction with
 * the same terminal order as a destroyed flag (live operations, geometry
 * lock, flag row), re-checking every condition under the row lock. A flag
 * whose owner came back, or that another server already removed, is skipped,
 * so concurrent sweeps and replays are safe; the audit row's flag-id key
 * makes a second record impossible.
 */
export async function abandonInactiveOwnerFlags(
  pool: pg.Pool,
  options: Readonly<{ now?: Date; limit?: number }> = {}
): Promise<FlagAbandonmentResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - FLAG_ABANDONMENT_INACTIVE_MS);
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  const candidates = await pool.query<{ id: string }>(
    `SELECT flag.id::text
     FROM flags flag
     JOIN players owner ON owner.id = flag.owner_id
     WHERE ${CANDIDATE_CONDITIONS}
     ORDER BY owner.last_seen_at, flag.id
     LIMIT $2`,
    [cutoff, limit]
  );
  const abandonedFlagIds: string[] = [];
  const owners = new Set<string>();
  const failures: Array<Readonly<{ flagId: string; error: unknown }>> = [];
  for (const candidate of candidates.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockFlagTerminalOperationsInTransaction(client, candidate.id);
      const locked = await client.query<{
        owner_id: string; name: string; anchor_kind: string; lat: number; lon: number; last_seen_at: Date;
      }>(
        `SELECT flag.owner_id, flag.name, flag.anchor_kind, flag.lat, flag.lon, owner.last_seen_at
         FROM flags flag
         JOIN players owner ON owner.id = flag.owner_id
         WHERE flag.id = $2::uuid AND ${CANDIDATE_CONDITIONS}
         FOR UPDATE OF flag`,
        [cutoff, candidate.id]
      );
      const flag = locked.rows[0];
      if (!flag) {
        await client.query("ROLLBACK");
        continue;
      }
      await closeFlagTerminalOperationsInTransaction(client, candidate.id);
      const recorded = await client.query(
        `INSERT INTO flag_abandonments (flag_id, owner_player_id, flag_name, anchor_kind, lat, lon, owner_last_seen_at, abandoned_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (flag_id) DO NOTHING`,
        [candidate.id, flag.owner_id, flag.name, flag.anchor_kind, flag.lat, flag.lon, flag.last_seen_at, now]
      );
      const deleted = await client.query(
        "DELETE FROM flags WHERE id = $1::uuid AND control_type = 'personal'",
        [candidate.id]
      );
      if (recorded.rowCount !== 1 || deleted.rowCount !== 1) {
        await client.query("ROLLBACK");
        continue;
      }
      await client.query("COMMIT");
      abandonedFlagIds.push(candidate.id);
      owners.add(flag.owner_id);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      failures.push({ flagId: candidate.id, error });
    } finally {
      client.release();
    }
  }
  return { abandonedFlagIds, ownerPlayerIds: [...owners], failures };
}

import { randomUUID } from "node:crypto";

import type pg from "pg";

// Trust alert inbox writer (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md
// 4.3-4.5, table trust_alerts in migration 0912). Locations are stored only
// rounded to 0.01 degrees plus the 0.05 degree alert cell; never the raw fix.

export const ALERT_CELL_DEGREES = 0.05;
/** Decided alerts are purged after this many days; pending alerts stay until an admin decides. */
export const ALERT_RETENTION_DAYS = 180;
const ALERT_CELL_COLS = Math.round(360 / ALERT_CELL_DEGREES);
const ALERT_CELL_ROWS = Math.round(180 / ALERT_CELL_DEGREES);
// Plan 4.5: at most this many red alerts per account in RED_ALERT_WINDOW.
export const RED_ALERT_LIMIT = 3;
const RED_ALERT_WINDOW = "30 days";
const ZONE_ALERT_DEDUPE_WINDOW = "7 days";
const NEW_ACCOUNT_WINDOW = "24 hours";

export const ZONE_ALERT_SEVERITY = {
  zone_red_new_account: 4,
  // A Settled account trying a red zone (its Settled status is paused for review).
  zone_red_settled_hold: 4,
  zone_red: 3,
  zone_orange: 2,
  zone_yellow: 1,
  kingdom_proximity: 4,
  multi_account: 3,
  account_shared: 3,
  state_hopping: 3
} as const;

export type ZoneAlertKind =
  | "zone_orange"
  | "zone_yellow"
  | "kingdom_proximity"
  | "multi_account"
  | "account_shared"
  | "state_hopping";

/** Same 0.05 degree cells as the population grid (row from the north, column from -180). */
export function alertCellKey(lat: number, lon: number): string {
  const row = Math.min(ALERT_CELL_ROWS - 1, Math.max(0, Math.floor((90 - lat) / ALERT_CELL_DEGREES)));
  const col = ((Math.floor((lon + 180) / ALERT_CELL_DEGREES) % ALERT_CELL_COLS) + ALERT_CELL_COLS) % ALERT_CELL_COLS;
  return `${row}:${col}`;
}

export function roundAlertCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

export type RedAlertResult = Readonly<{
  // A new pending red alert was filed; false = rate limited (one pending per
  // account, or the 30-day cap), the pending alert's count was bumped instead
  // (alertId is then that pending alert, when there is one).
  created: boolean;
  alertId: string | null;
  severity: number | null;
}>;

export type RedAllowance = Readonly<{ alertId: string; expiresAt: Date }>;

export type TrustAlertWriter = Readonly<{
  fileRedAlert(input: Readonly<{
    accountId: string;
    lat: number;
    lon: number;
    now: Date;
    details: Record<string, unknown>;
    // Fixed severity (a Settled account's held attempt is 4); default by account age.
    severity?: number;
  }>): Promise<RedAlertResult>;
  fileZoneAlert(input: Readonly<{
    accountId: string;
    kind: ZoneAlertKind;
    lat: number;
    lon: number;
    now: Date;
    details: Record<string, unknown>;
    // "account": one alert per account and kind per 7 days, whatever the cell.
    dedupe?: "cell" | "account";
  }>): Promise<{ created: boolean }>;
  consumeRedAllowance(accountId: string, cellKey: string, now: Date): Promise<RedAllowance | null>;
  restoreRedAllowance(allowance: RedAllowance): Promise<void>;
}>;

export class PostgresTrustAlertStore implements TrustAlertWriter {
  constructor(private readonly pool: pg.Pool) {}

  async deleteDecidedAlertsBefore(cutoff: Date): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM trust_alerts WHERE status <> 'pending' AND created_at < $1",
      [cutoff]
    );
    return result.rowCount ?? 0;
  }

  /**
   * Files a pending red alert unless the account already has one pending (the
   * trust_alerts_one_pending_red_idx unique index) or reached the 30-day cap.
   * New accounts (< 24 h) get severity 4.
   */
  async fileRedAlert(input: Parameters<TrustAlertWriter["fileRedAlert"]>[0]): Promise<RedAlertResult> {
    const id = randomUUID();
    const inserted = await this.pool.query<{ id: string; severity: number }>(
      `INSERT INTO trust_alerts (id, account_id, kind, severity, status, cell_key, lat_rounded, lon_rounded, details, created_at)
       SELECT $1, a.id, 'zone_red',
              COALESCE($11::smallint,
                CASE WHEN a.created_at > $7::timestamptz - interval '${NEW_ACCOUNT_WINDOW}' THEN $9::smallint ELSE $10::smallint END),
              'pending', $3, $4, $5, $6::jsonb, $7
         FROM accounts a
        WHERE a.id = $2
          AND (SELECT count(*) FROM trust_alerts t
                WHERE t.account_id = $2 AND t.kind = 'zone_red'
                  AND t.created_at > $7::timestamptz - interval '${RED_ALERT_WINDOW}') < $8
       ON CONFLICT (account_id) WHERE kind = 'zone_red' AND status = 'pending' DO NOTHING
       RETURNING id, severity`,
      [
        id,
        input.accountId,
        alertCellKey(input.lat, input.lon),
        roundAlertCoordinate(input.lat),
        roundAlertCoordinate(input.lon),
        JSON.stringify({ ...input.details, count: 1 }),
        input.now,
        RED_ALERT_LIMIT,
        ZONE_ALERT_SEVERITY.zone_red_new_account,
        ZONE_ALERT_SEVERITY.zone_red,
        input.severity ?? null
      ]
    );
    const row = inserted.rows[0];
    if (row) return { created: true, alertId: row.id, severity: Number(row.severity) };
    const bumped = await this.pool.query<{ id: string; severity: number }>(
      `UPDATE trust_alerts
          SET details = jsonb_set(details, '{count}', to_jsonb(COALESCE((details->>'count')::integer, 1) + 1)),
              severity = GREATEST(severity, COALESCE($2::smallint, severity))
        WHERE account_id = $1 AND kind = 'zone_red' AND status = 'pending'
        RETURNING id, severity`,
      [input.accountId, input.severity ?? null]
    );
    const pending = bumped.rows[0];
    return { created: false, alertId: pending?.id ?? null, severity: pending ? Number(pending.severity) : null };
  }

  /**
   * Orange/yellow: one alert per account per cell per 7 days; later ones only
   * bump details.count. Serialized per (account, kind, cell).
   */
  async fileZoneAlert(input: Parameters<TrustAlertWriter["fileZoneAlert"]>[0]): Promise<{ created: boolean }> {
    const cellKey = alertCellKey(input.lat, input.lon);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `trust_alert:${input.accountId}:${input.kind}:${input.dedupe === "account" ? "account" : cellKey}`
      ]);
      const bumped = await client.query(
        `UPDATE trust_alerts
            SET details = jsonb_set(details, '{count}', to_jsonb(COALESCE((details->>'count')::integer, 1) + 1))
          WHERE id = (
            SELECT id FROM trust_alerts
             WHERE account_id = $1 AND kind = $2 AND ($5::boolean OR cell_key = $3)
               AND created_at > $4::timestamptz - interval '${ZONE_ALERT_DEDUPE_WINDOW}'
             ORDER BY created_at DESC
             LIMIT 1)`,
        [input.accountId, input.kind, cellKey, input.now, input.dedupe === "account"]
      );
      let created = false;
      if ((bumped.rowCount ?? 0) === 0) {
        await client.query(
          `INSERT INTO trust_alerts (id, account_id, kind, severity, status, cell_key, lat_rounded, lon_rounded, details, created_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8::jsonb, $9)`,
          [
            randomUUID(),
            input.accountId,
            input.kind,
            ZONE_ALERT_SEVERITY[input.kind],
            cellKey,
            roundAlertCoordinate(input.lat),
            roundAlertCoordinate(input.lon),
            JSON.stringify({ ...input.details, count: 1 }),
            input.now
          ]
        );
        created = true;
      }
      await client.query("COMMIT");
      return { created };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One-shot admin allowance (approved red alert for this account and cell,
   * not expired). Consumed atomically: concurrent relocations re-check the
   * row after the lock and only one gets it.
   */
  async consumeRedAllowance(accountId: string, cellKey: string, now: Date): Promise<RedAllowance | null> {
    const result = await this.pool.query<{ id: string; expires_at: Date }>(
      `WITH target AS (
         SELECT id, allowance_expires_at
           FROM trust_alerts
          WHERE account_id = $1 AND kind = 'zone_red' AND status = 'approved'
            AND cell_key = $2 AND allowance_expires_at > $3::timestamptz
          ORDER BY allowance_expires_at DESC
          LIMIT 1
          FOR UPDATE)
       UPDATE trust_alerts t
          SET allowance_expires_at = NULL,
              details = t.details || jsonb_build_object('allowanceUsedAt', $3::timestamptz)
         FROM target
        WHERE t.id = target.id
       RETURNING t.id, target.allowance_expires_at AS expires_at`,
      [accountId, cellKey, now]
    );
    const row = result.rows[0];
    return row ? { alertId: row.id, expiresAt: row.expires_at } : null;
  }

  // Gives a consumed allowance back when the relocation did not commit.
  async restoreRedAllowance(allowance: RedAllowance): Promise<void> {
    await this.pool.query(
      `UPDATE trust_alerts
          SET allowance_expires_at = $2, details = details - 'allowanceUsedAt'
        WHERE id = $1 AND allowance_expires_at IS NULL`,
      [allowance.alertId, allowance.expiresAt]
    );
  }
}

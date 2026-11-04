import { randomUUID } from "node:crypto";

import type {
  TrustAdminAlertView,
  TrustAdminSettlementView,
  TrustAdminUnanchoredRoute,
  TrustAlertAction,
  TrustAlertKind,
  TrustAlertListQuery,
  TrustAlertStatus
} from "@ash-atlas/shared";
import type pg from "pg";

import type { UnanchoredRouteRow } from "./destinationAnchorGate.js";
import { isSettledNow, type SettlementService } from "./settlement.js";
import { alertCellKey, roundAlertCoordinate, ZONE_ALERT_SEVERITY } from "./trustAlerts.js";

// Admin tooling for the alert inbox, Settled overrides and inviter
// quarantine (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md 2.4, 3.6, 4.4).
// Every action leaves a `note` event in the account's trust ledger.

export const ALERT_ALLOWANCE_MS = 7 * 24 * 60 * 60_000;
export const SUSPENSION_REASON_ALERT_LOCK = "trust_alert_locked";
export const SUSPENSION_REASON_QUARANTINE = "trust_arrival_quarantine";
export const SUSPENSION_REASON_RED_ZONE_NEW_ACCOUNT = "trust_red_zone_new_account";
// Suspensions an alert Unlock may lift; deletion and other suspensions stay.
const TRUST_LOCK_REASONS = [SUSPENSION_REASON_ALERT_LOCK, SUSPENSION_REASON_RED_ZONE_NEW_ACCOUNT] as const;
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * Brand-new account red-zone lock (plan 4.3): an active account younger than
 * maxAgeDays that has no settled_at. Shared with the developer Trust Lab.
 */
export function redZoneLockEligible(input: Readonly<{ ageMs: number; settled: boolean; maxAgeDays: number }>): boolean {
  return !input.settled && input.ageMs < input.maxAgeDays * DAY_MS;
}

type Queryable = Pick<pg.PoolClient, "query">;

type AlertRow = {
  id: string;
  account_id: string;
  player_name: string | null;
  kind: TrustAlertKind;
  severity: number;
  status: TrustAlertStatus;
  lat_rounded: number | null;
  lon_rounded: number | null;
  details: Record<string, unknown>;
  allowance_expires_at: Date | null;
  decided_at: Date | null;
  created_at: Date;
};

const ALERT_SELECT = `
  SELECT t.id::text AS id, t.account_id::text AS account_id,
         (SELECT p.username FROM players p WHERE p.account_id = t.account_id LIMIT 1) AS player_name,
         t.kind, t.severity, t.status, t.lat_rounded, t.lon_rounded, t.details,
         t.allowance_expires_at, t.decided_at, t.created_at
    FROM trust_alerts t`;

function alertView(row: AlertRow): TrustAdminAlertView {
  const count = Number(row.details.count);
  return {
    id: row.id,
    accountId: row.account_id,
    playerName: row.player_name,
    kind: row.kind,
    severity: Number(row.severity),
    status: row.status,
    lat: row.lat_rounded,
    lon: row.lon_rounded,
    count: Number.isFinite(count) && count > 0 ? count : 1,
    details: row.details,
    allowanceExpiresAt: row.allowance_expires_at?.toISOString() ?? null,
    decidedAt: row.decided_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString()
  };
}

export type AlertDecisionResult =
  | Readonly<{ outcome: "ok"; alert: TrustAdminAlertView; suspendedAccountIds: readonly string[] }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "invalid_state"; status: TrustAlertStatus }>;

export type QuarantineStoreResult =
  | Readonly<{ outcome: "ok"; accountIds: readonly string[] }>
  | Readonly<{ outcome: "count_mismatch"; actual: number }>;

const ALLOWED_FROM: Readonly<Record<TrustAlertAction, readonly TrustAlertStatus[]>> = {
  approve: ["pending"],
  dismiss: ["pending"],
  lock: ["pending", "approved"],
  unlock: ["locked"]
};
const TARGET_STATUS: Readonly<Record<TrustAlertAction, TrustAlertStatus>> = {
  approve: "approved",
  dismiss: "dismissed",
  lock: "locked",
  // The lock stays on record in the alert details and the ledger notes.
  unlock: "dismissed"
};

async function recordNote(
  db: Queryable,
  accountId: string,
  rule: string,
  metadata: Record<string, unknown>,
  now: Date
): Promise<void> {
  await db.query(
    `INSERT INTO account_trust_events (id, account_id, kind, rule, weight, logodds_after, metadata, created_at)
     VALUES ($1, $2, 'note', $3, 0,
             COALESCE((SELECT logodds FROM account_trust_state WHERE account_id = $2), 0),
             $4::jsonb, $5)`,
    [randomUUID(), accountId, rule, JSON.stringify(metadata), now]
  );
}

// The account suspension path (same columns as the Apple-deletion and
// deletion-request suspensions): status, reason, sessions revoked.
async function suspendAccounts(
  db: Queryable,
  accountIds: readonly string[],
  reason: string,
  now: Date
): Promise<string[]> {
  if (accountIds.length === 0) return [];
  const suspended = await db.query<{ id: string }>(
    `UPDATE accounts
        SET status = 'suspended', suspended_at = COALESCE(suspended_at, $2),
            suspension_reason = COALESCE(suspension_reason, $3),
            session_version = session_version + 1, updated_at = $2
      WHERE id = ANY($1::uuid[]) AND status = 'active'
      RETURNING id::text AS id`,
    [accountIds, now, reason]
  );
  const ids = suspended.rows.map((row) => row.id);
  if (ids.length > 0) {
    await db.query(
      `UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, $2), revoke_reason = COALESCE(revoke_reason, $3)
        WHERE account_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [ids, now, reason]
    );
  }
  return ids;
}

// Lifts a trust-lock suspension. Sessions stay revoked (the player signs in
// again); other suspension reasons are left alone.
async function reactivateTrustLocked(db: Queryable, accountId: string, now: Date): Promise<boolean> {
  const result = await db.query(
    `UPDATE accounts
        SET status = 'active', suspended_at = NULL, suspension_reason = NULL, updated_at = $2
      WHERE id = $1 AND status = 'suspended' AND suspension_reason = ANY($3::text[])`,
    [accountId, now, TRUST_LOCK_REASONS]
  );
  return (result.rowCount ?? 0) > 0;
}

export type RedZoneLockResult = Readonly<{ alertId: string; accountAgeHours: number }>;

export type RedZoneLockInput = Readonly<{
  accountId: string;
  lat: number;
  lon: number;
  maxAgeDays: number;
  details: Record<string, unknown>;
  now: Date;
}>;

export class PostgresTrustAdminOpsStore {
  constructor(private readonly pool: pg.Pool) {}

  async listAlerts(query: TrustAlertListQuery): Promise<{ alerts: TrustAdminAlertView[]; total: number }> {
    const filters = [
      "($1::text IS NULL OR t.status = $1)",
      "($2::text IS NULL OR t.kind = $2)"
    ].join(" AND ");
    const params = [query.status ?? null, query.kind ?? null];
    const [rows, total] = await Promise.all([
      this.pool.query<AlertRow>(
        `${ALERT_SELECT}
          WHERE ${filters}
          ORDER BY (t.status = 'pending') DESC, t.severity DESC, t.created_at DESC, t.id
          LIMIT $3 OFFSET $4`,
        [...params, query.limit, query.offset]
      ),
      this.pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM trust_alerts t WHERE ${filters}`,
        params
      )
    ]);
    return { alerts: rows.rows.map(alertView), total: Number(total.rows[0]?.total ?? 0) };
  }

  /**
   * One decision under the alert row lock. Approve of a red alert opens the
   * one-shot 7 day allowance for the alert's own 0.05 degree cell (cell_key is
   * kept, never recomputed); lock suspends the account and clears any unused
   * allowance. A decision on an alert that is no longer in an allowed state is
   * refused without side effects.
   */
  async decideAlert(
    alertId: string,
    action: TrustAlertAction,
    adminAccountId: string,
    now: Date
  ): Promise<AlertDecisionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ status: TrustAlertStatus; kind: TrustAlertKind; account_id: string; cell_key: string | null }>(
        "SELECT status, kind, account_id::text AS account_id, cell_key FROM trust_alerts WHERE id = $1 FOR UPDATE",
        [alertId]
      );
      const current = locked.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (!ALLOWED_FROM[action].includes(current.status)) {
        await client.query("ROLLBACK");
        return { outcome: "invalid_state", status: current.status };
      }
      const allowanceExpiresAt = action === "approve" && current.kind === "zone_red"
        ? new Date(now.getTime() + ALERT_ALLOWANCE_MS)
        : null;
      const reactivated = action === "unlock"
        ? await reactivateTrustLocked(client, current.account_id, now)
        : null;
      const unlockDetails = reactivated === null
        ? {}
        : { unlockedAt: now.toISOString(), unlockedBy: adminAccountId, accountReactivated: reactivated };
      await client.query(
        `UPDATE trust_alerts
            SET status = $2, allowance_expires_at = $3, decided_by = $4, decided_at = $5,
                details = details || $6::jsonb
          WHERE id = $1`,
        [alertId, TARGET_STATUS[action], allowanceExpiresAt, adminAccountId, now, JSON.stringify(unlockDetails)]
      );
      let suspendedAccountIds: string[] = [];
      if (action === "lock") {
        suspendedAccountIds = await suspendAccounts(client, [current.account_id], SUSPENSION_REASON_ALERT_LOCK, now);
      }
      await recordNote(client, current.account_id, `admin_alert_${action}`, {
        alertId,
        kind: current.kind,
        cellKey: current.cell_key,
        adminAccountId,
        ...(allowanceExpiresAt ? { allowanceExpiresAt: allowanceExpiresAt.toISOString() } : {}),
        ...(reactivated === null ? {} : { accountReactivated: reactivated })
      }, now);
      const updated = await client.query<AlertRow>(`${ALERT_SELECT} WHERE t.id = $1`, [alertId]);
      await client.query("COMMIT");
      return { outcome: "ok", alert: alertView(updated.rows[0]!), suspendedAccountIds };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Automatic red-zone lock for a brand-new account (plan 4.3): younger than
   * `maxAgeDays`, never Settled and still active, checked under the account row
   * lock. Files a `locked` severity 4 red alert and suspends through the same
   * path as the admin Lock. Returns null (nothing written) for any other account.
   */
  async lockNewAccountForRedZone(input: RedZoneLockInput): Promise<RedZoneLockResult | null> {
    const { accountId, now } = input;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ created_at: Date; settled: boolean }>(
        `SELECT a.created_at,
                EXISTS (SELECT 1 FROM account_settlement s
                         WHERE s.account_id = a.id AND s.settled_at IS NOT NULL) AS settled
           FROM accounts a
          WHERE a.id = $1 AND a.status = 'active'
          FOR UPDATE OF a`,
        [accountId]
      );
      const row = found.rows[0];
      const ageMs = row ? now.getTime() - row.created_at.getTime() : Number.POSITIVE_INFINITY;
      if (!row || !redZoneLockEligible({ ageMs, settled: row.settled, maxAgeDays: input.maxAgeDays })) {
        await client.query("ROLLBACK");
        return null;
      }
      const alertId = randomUUID();
      const cellKey = alertCellKey(input.lat, input.lon);
      const accountAgeHours = Math.max(0, Math.floor((ageMs / HOUR_MS) * 10) / 10);
      await client.query(
        `INSERT INTO trust_alerts (id, account_id, kind, severity, status, cell_key, lat_rounded, lon_rounded,
                                   details, decided_at, created_at)
         VALUES ($1, $2, 'zone_red', $3, 'locked', $4, $5, $6, $7::jsonb, $8, $8)`,
        [
          alertId,
          accountId,
          ZONE_ALERT_SEVERITY.zone_red_new_account,
          cellKey,
          roundAlertCoordinate(input.lat),
          roundAlertCoordinate(input.lon),
          JSON.stringify({
            ...input.details,
            autoLocked: true,
            accountAgeHours,
            maxAgeDays: input.maxAgeDays,
            count: 1
          }),
          now
        ]
      );
      await suspendAccounts(client, [accountId], SUSPENSION_REASON_RED_ZONE_NEW_ACCOUNT, now);
      await recordNote(client, accountId, "auto_red_zone_lock", { alertId, cellKey, accountAgeHours }, now);
      await client.query("COMMIT");
      return { alertId, accountAgeHours };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async accountExists(accountId: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM accounts WHERE id = $1", [accountId]);
    return (result.rowCount ?? 0) > 0;
  }

  async recordAdminNote(
    accountId: string,
    rule: string,
    metadata: Record<string, unknown>,
    now: Date
  ): Promise<void> {
    await recordNote(this.pool, accountId, rule, metadata, now);
  }

  async settlementView(accountId: string, now: Date): Promise<TrustAdminSettlementView | null> {
    const result = await this.pool.query<{
      home_lat: number | null; home_lon: number | null;
      settled_home_lat: number | null; settled_home_lon: number | null;
      difficulty: string | number; target_checks: number; target_days: number;
      counted_checks: number; counted_days: number; distinct_positions: number;
      settled_at: Date | null; provisional_until: Date | null;
      unsettled_at: Date | null; unsettle_reason: string | null;
    }>(
      `SELECT home_lat, home_lon, settled_home_lat, settled_home_lon, difficulty, target_checks,
              target_days, counted_checks, counted_days, distinct_positions, settled_at,
              provisional_until, unsettled_at, unsettle_reason
         FROM account_settlement WHERE account_id = $1`,
      [accountId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const round = (lat: number | null, lon: number | null) =>
      lat !== null && lon !== null
        ? { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 }
        : null;
    return {
      settled: isSettledNow({ settledAt: row.settled_at, provisionalUntil: row.provisional_until }, now),
      settledAt: row.settled_at?.toISOString() ?? null,
      provisionalUntil: row.provisional_until?.toISOString() ?? null,
      home: round(row.home_lat, row.home_lon),
      settledHome: round(row.settled_home_lat, row.settled_home_lon),
      difficulty: Number(row.difficulty),
      targetChecks: row.target_checks,
      targetDays: row.target_days,
      countedChecks: row.counted_checks,
      countedDays: row.counted_days,
      distinctPositions: row.distinct_positions,
      unsettledAt: row.unsettled_at?.toISOString() ?? null,
      unsettleReason: row.unsettle_reason
    };
  }

  // Active (not yet suspended) distinct guests the host brought in since T.
  async quarantineGuestCount(hostAccountId: string, since: Date): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(DISTINCT a.guest_account_id)::text AS count
         FROM trust_arrivals a
         JOIN accounts g ON g.id = a.guest_account_id
        WHERE a.host_account_id = $1 AND a.created_at >= $2
          AND a.guest_account_id <> a.host_account_id AND g.status = 'active'`,
      [hostAccountId, since]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Suspends every active guest of the host since T in one transaction. When
   * `expectedCount` is given and the set changed since the dry run, nothing is
   * suspended.
   */
  async quarantineArrivals(
    hostAccountId: string,
    since: Date,
    expectedCount: number | undefined,
    adminAccountId: string,
    now: Date
  ): Promise<QuarantineStoreResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const guests = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM accounts
          WHERE status = 'active'
            AND id IN (SELECT guest_account_id FROM trust_arrivals
                        WHERE host_account_id = $1 AND created_at >= $2 AND guest_account_id <> $1)
          ORDER BY id
          FOR UPDATE`,
        [hostAccountId, since]
      );
      const ids = guests.rows.map((row) => row.id);
      if (expectedCount !== undefined && expectedCount !== ids.length) {
        await client.query("ROLLBACK");
        return { outcome: "count_mismatch", actual: ids.length };
      }
      const suspended = await suspendAccounts(client, ids, SUSPENSION_REASON_QUARANTINE, now);
      for (const guestId of suspended) {
        await recordNote(client, guestId, "admin_quarantine_guest", {
          hostAccountId,
          since: since.toISOString(),
          adminAccountId
        }, now);
      }
      await recordNote(client, hostAccountId, "admin_quarantine_arrivals", {
        since: since.toISOString(),
        suspended: suspended.length,
        adminAccountId
      }, now);
      await client.query("COMMIT");
      return { outcome: "ok", accountIds: suspended };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export type UnanchoredRoutesReader = Readonly<{
  unanchoredRoutesReport(since: Date, limit?: number): Promise<UnanchoredRouteRow[]>;
}>;

export type QuarantineOutcome =
  | Readonly<{ outcome: "ok"; guestCount: number; suspendedCount: number; dryRun: boolean }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "count_mismatch"; actual: number }>;

export type SettleOutcome = "ok" | "not_found" | "no_home";

export type TrustAdminOpsDeps = Readonly<{
  store: PostgresTrustAdminOpsStore;
  settlement: Pick<SettlementService, "revoke" | "adminSettle"> & Partial<Pick<SettlementService, "releaseReviewHold">>;
  anchors: UnanchoredRoutesReader;
  // Closes live game connections for suspended accounts.
  closeConnections?: (accountId: string, reason: string) => Promise<void>;
  // Told about every spoofing lock (admin Lock, red-zone auto-lock): DeviceCheck bit0.
  onSpoofingLock?: (accountId: string) => Promise<unknown>;
  now?: () => Date;
}>;

/** Admin actions behind /api/dev/trust (alerts, Settled overrides, quarantine, reports). */
export class TrustAdminOps {
  private readonly now: () => Date;

  constructor(private readonly deps: TrustAdminOpsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  listAlerts(query: TrustAlertListQuery): ReturnType<PostgresTrustAdminOpsStore["listAlerts"]> {
    return this.deps.store.listAlerts(query);
  }

  async decideAlert(alertId: string, action: TrustAlertAction, adminAccountId: string): Promise<AlertDecisionResult> {
    const result = await this.deps.store.decideAlert(alertId, action, adminAccountId, this.now());
    if (result.outcome === "ok") {
      await this.closeSuspended(result.suspendedAccountIds, SUSPENSION_REASON_ALERT_LOCK);
      if (action === "lock") this.notifySpoofingLock(result.suspendedAccountIds);
      // Owner decision E: approving the held red alert restores the paused Settled status.
      if (action === "approve" && result.alert.kind === "zone_red") {
        await this.deps.settlement.releaseReviewHold?.(result.alert.accountId, alertId);
      }
    }
    return result;
  }

  /**
   * Red relocation by a brand-new account in enforce (plan 4.3): locks it like
   * the admin Lock. `closeConnections` is returned rather than run so the
   * caller can answer the request first; null = not a brand-new account.
   */
  async lockNewAccountForRedZone(
    input: RedZoneLockInput
  ): Promise<(RedZoneLockResult & Readonly<{ closeConnections(): Promise<void> }>) | null> {
    const locked = await this.deps.store.lockNewAccountForRedZone(input);
    if (!locked) return null;
    this.notifySpoofingLock([input.accountId]);
    return {
      ...locked,
      closeConnections: () => this.closeSuspended([input.accountId], SUSPENSION_REASON_RED_ZONE_NEW_ACCOUNT)
    };
  }

  async settle(accountId: string, adminAccountId: string): Promise<SettleOutcome> {
    if (!(await this.deps.store.accountExists(accountId))) return "not_found";
    if (!(await this.deps.settlement.adminSettle(accountId))) return "no_home";
    await this.deps.store.recordAdminNote(accountId, "admin_settled", { adminAccountId }, this.now());
    return "ok";
  }

  async unsettle(accountId: string, adminAccountId: string): Promise<"ok" | "not_found"> {
    if (!(await this.deps.store.accountExists(accountId))) return "not_found";
    await this.deps.settlement.revoke(accountId, "admin", { adminAccountId });
    await this.deps.store.recordAdminNote(accountId, "admin_unsettled", { adminAccountId }, this.now());
    return "ok";
  }

  settlementView(accountId: string): Promise<TrustAdminSettlementView | null> {
    return this.deps.store.settlementView(accountId, this.now());
  }

  async quarantineArrivals(input: Readonly<{
    hostAccountId: string;
    since: Date;
    confirm: boolean;
    expectedCount?: number | undefined;
    adminAccountId: string;
  }>): Promise<QuarantineOutcome> {
    if (!(await this.deps.store.accountExists(input.hostAccountId))) return { outcome: "not_found" };
    if (!input.confirm) {
      const guestCount = await this.deps.store.quarantineGuestCount(input.hostAccountId, input.since);
      return { outcome: "ok", guestCount, suspendedCount: 0, dryRun: true };
    }
    const result = await this.deps.store.quarantineArrivals(
      input.hostAccountId,
      input.since,
      input.expectedCount,
      input.adminAccountId,
      this.now()
    );
    if (result.outcome === "count_mismatch") return result;
    await this.closeSuspended(result.accountIds, SUSPENSION_REASON_QUARANTINE);
    return { outcome: "ok", guestCount: result.accountIds.length, suspendedCount: result.accountIds.length, dryRun: false };
  }

  async unanchoredRoutes(days: number, limit: number): Promise<{ since: Date; routes: TrustAdminUnanchoredRoute[] }> {
    const since = new Date(this.now().getTime() - days * 24 * 60 * 60_000);
    const rows = await this.deps.anchors.unanchoredRoutesReport(since, limit);
    return {
      since,
      routes: rows.map((row) => ({ ...row, lastAttemptAt: row.lastAttemptAt.toISOString() }))
    };
  }

  // Fire-and-forget: a DeviceCheck call must never delay or fail the lock.
  private notifySpoofingLock(accountIds: readonly string[]): void {
    if (!this.deps.onSpoofingLock) return;
    for (const accountId of accountIds) void this.deps.onSpoofingLock(accountId).catch(() => undefined);
  }

  private async closeSuspended(accountIds: readonly string[], reason: string): Promise<void> {
    if (!this.deps.closeConnections) return;
    await Promise.all(accountIds.map((accountId) =>
      this.deps.closeConnections!(accountId, reason).catch(() => undefined)));
  }
}

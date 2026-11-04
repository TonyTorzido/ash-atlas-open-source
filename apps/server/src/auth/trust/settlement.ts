import { randomInt } from "node:crypto";

import { distanceMeters, type LatLon, type LocationFixAssurance } from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import { isTrustReviewAccount, type TrustReviewConfig } from "./trustReviewAccounts.js";

// Structural copy of trustService's TrustSignalSink; importing it would close
// an import cycle (trustService and trustStore both import this module).
type TrustSignalSink = Readonly<{
  recordSignals(input: {
    accountId: string;
    reportId?: string;
    signals: ReadonlyArray<{ rule: string; weight: number; metadata?: Record<string, unknown> }>;
  }): Promise<void>;
}>;

// Settled status (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md §2).
// account_settlement is the only home read by Settled, doorway and anchoring
// code. Targets and progress are server-only: nothing in this module is ever
// sent to a client.

const DAY_MS = 24 * 60 * 60_000;
const MAX_TARGET_CHECKS = 500;
const MAX_TARGET_DAYS = 60;
const MAX_DISTINCT_POSITIONS = 10;
export const FREE_REPICK_ACCOUNT_AGE_MS = DAY_MS;
export const FREE_REPICK_WINDOW_MS = 60 * 60_000;
// $1 account, $2 now, $3 account age limit (ms); aliases s (account_settlement), a (accounts).
const FREE_REPICK_ELIGIBLE_SQL = `a.id = s.account_id
          AND s.free_repick_used_at IS NULL
          AND a.created_at > $2::timestamptz - ($3::bigint * interval '1 millisecond')
          AND (SELECT count(*) FROM location_reports r
                WHERE r.account_id = $1
                  AND r.source = 'relocation'
                  AND r.verdict IN ('accepted', 'shadow_rejected')) = 1`;

export type SettlementConfig = Pick<
  AppConfig,
  | "TRUST_SETTLE_ASSURANCE_MODE"
  | "TRUST_SETTLE_CHECKS_MIN"
  | "TRUST_SETTLE_CHECKS_MAX"
  | "TRUST_SETTLE_DAYS_MIN"
  | "TRUST_SETTLE_DAYS_MAX"
  | "TRUST_SETTLE_RADIUS_KM"
  | "TRUST_SETTLE_MIN_GAP_SECONDS"
  | "TRUST_SETTLE_MIN_DISTINCT_POSITIONS"
  | "TRUST_SETTLE_ACCURACY_M"
  | "TRUST_DOORWAY_MIN_ACCOUNT_AGE_DAYS"
> & TrustReviewConfig;

export type SettlementTargets = Readonly<{ checks: number; days: number }>;

export type UnsettleReason =
  | "location_mock"
  | "relocation_mock"
  | "attest_tamper"
  | "attest_app_fail"
  | "hard_mismatch"
  | "admin"
  | "moved_away"
  | "grandfather_expired"
  // Settled paused while an admin reviews a red-zone relocation attempt (owner decision E).
  | "review_hold";

// Reasons that clear the Settled home and signal settled_revoked.
export type RevocationReason = Exclude<UnsettleReason, "moved_away" | "grandfather_expired" | "review_hold">;

/** Shown to a Settled player whose red-zone relocation is held (explicit approved warning). */
export const SETTLED_REVIEW_HOLD_MESSAGE = "This location needs review. Your Settled status is paused until it's checked.";

export type SettlementState = Readonly<{
  home: LatLon | null;
  homeSetAt: Date | null;
  settledHome: LatLon | null;
  settledHomeAt: Date | null;
  targetChecks: number;
  targetDays: number;
  difficulty: number;
  countedChecks: number;
  countedDays: number;
  // YYYY-MM-DD (UTC).
  lastCountedDay: string | null;
  lastCountedAt: Date | null;
  distinctPositions: number;
  lastPositionKey: string | null;
  settledAt: Date | null;
  provisionalUntil: Date | null;
  unsettledAt: Date | null;
  unsettleReason: UnsettleReason | null;
  freeRepickUsedAt: Date | null;
}>;

/** A fix applied to account_settlement inside the location-report transaction. */
export type SettlementFixUpdate = Readonly<{
  source: "passive" | "relocation";
  lat: number;
  lon: number;
  at: Date;
  // Passive only: the fix itself may count (native, accepted, accurate).
  countable: boolean;
  // Rolled with crypto.randomInt before the transaction (difficulty 1.0).
  baseTargets: SettlementTargets;
  rules: SettlementRules;
}>;

export type SettlementRules = Readonly<{
  radiusM: number;
  minGapMs: number;
  minDistinctPositions: number;
  minAccountAgeMs: number;
}>;

export type SettlementEvent = "settled" | "moved_away" | "returned_home" | null;

export type SettlementTransition = Readonly<{
  next: SettlementState;
  changed: boolean;
  event: SettlementEvent;
}>;

export function settlementRules(config: SettlementConfig): SettlementRules {
  return {
    radiusM: config.TRUST_SETTLE_RADIUS_KM * 1000,
    minGapMs: config.TRUST_SETTLE_MIN_GAP_SECONDS * 1000,
    minDistinctPositions: config.TRUST_SETTLE_MIN_DISTINCT_POSITIONS,
    minAccountAgeMs: config.TRUST_DOORWAY_MIN_ACCOUNT_AGE_DAYS * DAY_MS
  };
}

/** Uniform secret targets (difficulty 1.0). */
export function rollSettlementTargets(
  config: Pick<SettlementConfig, "TRUST_SETTLE_CHECKS_MIN" | "TRUST_SETTLE_CHECKS_MAX" | "TRUST_SETTLE_DAYS_MIN" | "TRUST_SETTLE_DAYS_MAX">,
  roll: (minInclusive: number, maxExclusive: number) => number = randomInt
): SettlementTargets {
  return {
    checks: roll(config.TRUST_SETTLE_CHECKS_MIN, config.TRUST_SETTLE_CHECKS_MAX + 1),
    days: roll(config.TRUST_SETTLE_DAYS_MIN, config.TRUST_SETTLE_DAYS_MAX + 1)
  };
}

export function scaledTargets(base: SettlementTargets, difficulty: number): SettlementTargets {
  return {
    checks: Math.min(MAX_TARGET_CHECKS, Math.max(1, Math.ceil(base.checks * difficulty))),
    days: Math.min(MAX_TARGET_DAYS, Math.max(1, Math.ceil(base.days * difficulty)))
  };
}

/** Assurance of a fix before attestation exists: the WS platform claim only. */
export function assuranceForPlatform(platform: "web" | "ios" | "android" | null | undefined): LocationFixAssurance | null {
  if (platform === "web") return "web";
  if (platform === "ios" || platform === "android") return "native_legacy";
  return null;
}

/** Native per TRUST_SETTLE_ASSURANCE_MODE. Web, flagged and unknown never count. */
export function assuranceCountsAsNative(
  assurance: LocationFixAssurance | null | undefined,
  mode: AppConfig["TRUST_SETTLE_ASSURANCE_MODE"]
): boolean {
  if (assurance === "attested" || assurance === "device_checked") return true;
  if (mode === "enforce") return false;
  return assurance === "unverified" || assurance === "native_legacy";
}

export function settlementPositionKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/** Settled right now: provisional rows past their window no longer count. */
export function isSettledNow(
  state: Pick<SettlementState, "settledAt" | "provisionalUntil"> | null,
  now: Date
): boolean {
  if (!state?.settledAt) return false;
  return state.provisionalUntil === null || state.provisionalUntil.getTime() > now.getTime();
}

export function emptySettlementState(base: SettlementTargets): SettlementState {
  return {
    home: null,
    homeSetAt: null,
    settledHome: null,
    settledHomeAt: null,
    targetChecks: base.checks,
    targetDays: base.days,
    difficulty: 1,
    countedChecks: 0,
    countedDays: 0,
    lastCountedDay: null,
    lastCountedAt: null,
    distinctPositions: 0,
    lastPositionKey: null,
    settledAt: null,
    provisionalUntil: null,
    unsettledAt: null,
    unsettleReason: null,
    freeRepickUsedAt: null
  };
}

function resetProgress(state: SettlementState, base: SettlementTargets): SettlementState {
  const targets = scaledTargets(base, state.difficulty);
  return {
    ...state,
    targetChecks: targets.checks,
    targetDays: targets.days,
    countedChecks: 0,
    countedDays: 0,
    lastCountedDay: null,
    lastCountedAt: null,
    distinctPositions: 0,
    lastPositionKey: null
  };
}

/** Revocation for cause (pure): progress and the Settled home are cleared. */
export function revokedSettlementState(
  current: SettlementState,
  reason: RevocationReason,
  now: Date,
  baseTargets: SettlementTargets
): SettlementState {
  return {
    ...resetProgress(current, baseTargets),
    settledAt: null,
    settledHome: null,
    settledHomeAt: null,
    provisionalUntil: null,
    unsettledAt: now,
    unsettleReason: reason
  };
}

// Ceil without tripping on float noise (22 * 1.5 / 1.0 must stay 33).
function ceilScaled(value: number, factor: number): number {
  return Math.ceil(value * factor - 1e-9);
}

/**
 * Alert-zone difficulty (plan 4.3): difficulty = max(current, zone). Raising it
 * rescales the account's current targets by new/old (ceil); it never lowers
 * difficulty or targets. Returns null when nothing changes.
 */
export function raiseSettlementDifficulty(state: SettlementState, difficulty: number): SettlementState | null {
  if (!(difficulty > state.difficulty)) return null;
  const factor = difficulty / state.difficulty;
  return {
    ...state,
    difficulty,
    targetChecks: Math.min(MAX_TARGET_CHECKS, Math.max(state.targetChecks, ceilScaled(state.targetChecks, factor))),
    targetDays: Math.min(MAX_TARGET_DAYS, Math.max(state.targetDays, ceilScaled(state.targetDays, factor)))
  };
}

function within(a: LatLon | null, b: LatLon, radiusM: number): boolean {
  return a !== null && distanceMeters(a, b) <= radiusM;
}

const UNCHANGED = (state: SettlementState): SettlementTransition => ({ next: state, changed: false, event: null });

/**
 * One fix against the locked settlement row (pure). Relocations move the home
 * anchor (moved away / returned home); passive native fixes near the anchor
 * count toward Settled at most once per minimum gap.
 */
export function applySettlementFix(
  state: SettlementState,
  update: SettlementFixUpdate,
  accountCreatedAt: Date | null
): SettlementTransition {
  const fix = { lat: update.lat, lon: update.lon };
  const { rules } = update;
  if (update.source === "relocation") {
    const nearSettledHome = within(state.settledHome, fix, rules.radiusM);
    if (state.settledAt) {
      if (nearSettledHome || state.settledHome === null) return UNCHANGED(state);
      return {
        next: {
          ...resetProgress(state, update.baseTargets),
          home: fix,
          homeSetAt: update.at,
          settledAt: null,
          unsettledAt: update.at,
          unsettleReason: "moved_away"
        },
        changed: true,
        event: "moved_away"
      };
    }
    if (nearSettledHome && state.unsettleReason === "moved_away") {
      return {
        next: {
          ...state,
          home: fix,
          homeSetAt: update.at,
          settledAt: update.at,
          unsettledAt: null,
          unsettleReason: null
        },
        changed: true,
        event: "returned_home"
      };
    }
    if (within(state.home, fix, rules.radiusM)) return UNCHANGED(state);
    return {
      next: { ...resetProgress(state, update.baseTargets), home: fix, homeSetAt: update.at },
      changed: true,
      event: null
    };
  }

  if (!update.countable) return UNCHANGED(state);
  // A review hold pauses Settled: nothing is earned until an admin decides.
  if (state.unsettleReason === "review_hold") return UNCHANGED(state);
  // Settled (not provisional) accounts have nothing left to earn.
  if (state.settledAt && state.provisionalUntil === null) return UNCHANGED(state);
  let next: SettlementState = state.home === null
    ? { ...state, home: fix, homeSetAt: update.at }
    : state;
  if (!within(next.home, fix, rules.radiusM)) return next === state ? UNCHANGED(state) : { next, changed: true, event: null };
  if (next.lastCountedAt && update.at.getTime() - next.lastCountedAt.getTime() < rules.minGapMs) {
    return next === state ? UNCHANGED(state) : { next, changed: true, event: null };
  }
  const day = update.at.toISOString().slice(0, 10);
  const key = settlementPositionKey(update.lat, update.lon);
  next = {
    ...next,
    countedChecks: next.countedChecks + 1,
    countedDays: next.lastCountedDay === null || day > next.lastCountedDay ? next.countedDays + 1 : next.countedDays,
    lastCountedDay: next.lastCountedDay === null || day > next.lastCountedDay ? day : next.lastCountedDay,
    lastCountedAt: update.at,
    distinctPositions: key === next.lastPositionKey
      ? next.distinctPositions
      : Math.min(MAX_DISTINCT_POSITIONS, next.distinctPositions + 1),
    lastPositionKey: key
  };
  const ageMs = accountCreatedAt ? update.at.getTime() - accountCreatedAt.getTime() : 0;
  const earned = next.countedChecks >= next.targetChecks
    && next.countedDays >= next.targetDays
    && next.distinctPositions >= rules.minDistinctPositions
    && ageMs >= rules.minAccountAgeMs;
  if (!earned) return { next, changed: true, event: null };
  const wasSettled = next.settledAt !== null;
  return {
    next: {
      ...next,
      settledAt: next.settledAt ?? update.at,
      settledHome: next.home,
      settledHomeAt: update.at,
      provisionalUntil: null,
      unsettledAt: null,
      unsettleReason: null
    },
    changed: true,
    event: wasSettled ? null : "settled"
  };
}

// ---------------------------------------------------------------------------
// Storage

type SettlementRow = {
  home_lat: number | null;
  home_lon: number | null;
  home_set_at: Date | null;
  settled_home_lat: number | null;
  settled_home_lon: number | null;
  settled_home_at: Date | null;
  target_checks: number;
  target_days: number;
  difficulty: string | number;
  counted_checks: number;
  counted_days: number;
  last_counted_day: string | null;
  last_counted_at: Date | null;
  distinct_positions: number;
  last_position_key: string | null;
  settled_at: Date | null;
  provisional_until: Date | null;
  unsettled_at: Date | null;
  unsettle_reason: UnsettleReason | null;
  free_repick_used_at: Date | null;
  account_created_at: Date | null;
};

export type Queryable = Pick<pg.PoolClient, "query">;

function mapRow(row: SettlementRow): SettlementState {
  return {
    home: row.home_lat !== null && row.home_lon !== null ? { lat: row.home_lat, lon: row.home_lon } : null,
    homeSetAt: row.home_set_at,
    settledHome: row.settled_home_lat !== null && row.settled_home_lon !== null
      ? { lat: row.settled_home_lat, lon: row.settled_home_lon }
      : null,
    settledHomeAt: row.settled_home_at,
    targetChecks: row.target_checks,
    targetDays: row.target_days,
    difficulty: Number(row.difficulty),
    countedChecks: row.counted_checks,
    countedDays: row.counted_days,
    lastCountedDay: row.last_counted_day,
    lastCountedAt: row.last_counted_at,
    distinctPositions: row.distinct_positions,
    lastPositionKey: row.last_position_key,
    settledAt: row.settled_at,
    provisionalUntil: row.provisional_until,
    unsettledAt: row.unsettled_at,
    unsettleReason: row.unsettle_reason,
    freeRepickUsedAt: row.free_repick_used_at
  };
}

const STATE_COLUMNS = [
  "home_lat", "home_lon", "home_set_at", "settled_home_lat", "settled_home_lon", "settled_home_at",
  "target_checks", "target_days", "counted_checks", "counted_days", "last_counted_day",
  "last_counted_at", "distinct_positions", "last_position_key", "settled_at", "provisional_until",
  "unsettled_at", "unsettle_reason", "free_repick_used_at", "difficulty"
] as const;

function stateValues(state: SettlementState): unknown[] {
  return [
    state.home?.lat ?? null,
    state.home?.lon ?? null,
    state.homeSetAt,
    state.settledHome?.lat ?? null,
    state.settledHome?.lon ?? null,
    state.settledHomeAt,
    state.targetChecks,
    state.targetDays,
    state.countedChecks,
    state.countedDays,
    state.lastCountedDay,
    state.lastCountedAt,
    state.distinctPositions,
    state.lastPositionKey,
    state.settledAt,
    state.provisionalUntil,
    state.unsettledAt,
    state.unsettleReason,
    state.freeRepickUsedAt,
    state.difficulty
  ];
}

async function lockSettlement(
  db: Queryable,
  accountId: string
): Promise<{ state: SettlementState; accountCreatedAt: Date | null } | null> {
  const result = await db.query<SettlementRow>(
    `SELECT s.home_lat, s.home_lon, s.home_set_at, s.settled_home_lat, s.settled_home_lon,
            s.settled_home_at, s.target_checks, s.target_days, s.difficulty, s.counted_checks,
            s.counted_days, s.last_counted_day::text AS last_counted_day, s.last_counted_at,
            s.distinct_positions, s.last_position_key, s.settled_at, s.provisional_until,
            s.unsettled_at, s.unsettle_reason, s.free_repick_used_at,
            a.created_at AS account_created_at
       FROM account_settlement s
       LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.account_id = $1
      FOR UPDATE OF s`,
    [accountId]
  );
  const row = result.rows[0];
  return row ? { state: mapRow(row), accountCreatedAt: row.account_created_at } : null;
}

async function writeSettlement(db: Queryable, accountId: string, state: SettlementState): Promise<void> {
  const assignments = STATE_COLUMNS.map((column, index) => `${column} = $${index + 2}`).join(", ");
  await db.query(
    `UPDATE account_settlement SET ${assignments}, updated_at = now() WHERE account_id = $1`,
    [accountId, ...stateValues(state)]
  );
}

async function insertSettlement(db: Queryable, accountId: string, state: SettlementState): Promise<boolean> {
  const placeholders = STATE_COLUMNS.map((_, index) => `$${index + 2}`).join(", ");
  const result = await db.query(
    `INSERT INTO account_settlement (account_id, ${STATE_COLUMNS.join(", ")})
     SELECT $1, ${placeholders}
      WHERE EXISTS (SELECT 1 FROM accounts WHERE id = $1)
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId, ...stateValues(state)]
  );
  return (result.rowCount ?? 0) > 0;
}

async function loadAccountCreatedAt(db: Queryable, accountId: string): Promise<Date | null> {
  const result = await db.query<{ created_at: Date }>("SELECT created_at FROM accounts WHERE id = $1", [accountId]);
  return result.rows[0]?.created_at ?? null;
}

/**
 * Applies one fix to the account's settlement row under a row lock. Called
 * inside the location-report transaction; a missing row is created only when
 * the fix changes something.
 */
export async function applySettlementFixInTransaction(
  db: Queryable,
  accountId: string,
  update: SettlementFixUpdate
): Promise<SettlementEvent> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const locked = await lockSettlement(db, accountId);
    if (locked) {
      const transition = applySettlementFix(locked.state, update, locked.accountCreatedAt);
      if (transition.changed) await writeSettlement(db, accountId, transition.next);
      return transition.event;
    }
    const createdAt = await loadAccountCreatedAt(db, accountId);
    const transition = applySettlementFix(emptySettlementState(update.baseTargets), update, createdAt);
    if (!transition.changed) return null;
    if (await insertSettlement(db, accountId, transition.next)) return transition.event;
    // A concurrent writer created the row first: lock it and apply again.
  }
  return null;
}

async function clearReviewHold(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    `UPDATE account_settlement
        SET suspended_settled_at = NULL, suspended_provisional_until = NULL, suspended_alert_id = NULL
      WHERE account_id = $1 AND suspended_settled_at IS NOT NULL`,
    [accountId]
  );
}

export type DoorwaySettlement = Readonly<{
  settled: boolean;
  settledHome: LatLon | null;
}>;

export class PostgresSettlementStore {
  constructor(private readonly pool: pg.Pool) {}

  async isSettled(accountId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query<{ settled_at: Date | null; provisional_until: Date | null }>(
      "SELECT settled_at, provisional_until FROM account_settlement WHERE account_id = $1",
      [accountId]
    );
    const row = result.rows[0];
    return isSettledNow(row ? { settledAt: row.settled_at, provisionalUntil: row.provisional_until } : null, now);
  }

  async settledHome(accountId: string): Promise<LatLon | null> {
    const result = await this.pool.query<{ lat: number | null; lon: number | null }>(
      "SELECT settled_home_lat AS lat, settled_home_lon AS lon FROM account_settlement WHERE account_id = $1",
      [accountId]
    );
    const row = result.rows[0];
    return row && row.lat !== null && row.lon !== null ? { lat: row.lat, lon: row.lon } : null;
  }

  // Revocation for cause: progress and the Settled home are cleared.
  async revoke(
    accountId: string,
    reason: RevocationReason,
    now: Date,
    baseTargets: SettlementTargets
  ): Promise<{ wasSettled: boolean; playerIds: string[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockSettlement(client, accountId);
      const current = locked?.state ?? emptySettlementState(baseTargets);
      const next = revokedSettlementState(current, reason, now, baseTargets);
      // Revocation for cause also ends a review hold (the paused Settled is gone).
      if (locked) await clearReviewHold(client, accountId);
      if (locked) await writeSettlement(client, accountId, next);
      else await insertSettlement(client, accountId, next);
      const players = await client.query<{ id: string }>("SELECT id FROM players WHERE account_id = $1", [accountId]);
      await client.query("COMMIT");
      return { wasSettled: isSettledNow(current, now), playerIds: players.rows.map((row) => row.id) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Admin settle (plan 2.4): Settled now at the current home. No-op without a
   * home. Returns the previous Settled state, or null when there is no home.
   */
  async adminSettle(accountId: string, now: Date): Promise<{ wasSettled: boolean } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockSettlement(client, accountId);
      if (!locked?.state.home) {
        await client.query("ROLLBACK");
        return null;
      }
      const current = locked.state;
      await clearReviewHold(client, accountId);
      await writeSettlement(client, accountId, {
        ...current,
        settledAt: current.settledAt ?? now,
        settledHome: current.home,
        settledHomeAt: now,
        provisionalUntil: null,
        unsettledAt: null,
        unsettleReason: null
      });
      await client.query("COMMIT");
      return { wasSettled: isSettledNow(current, now) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Review hold (owner decision E): pauses a Settled account (provisional
   * included) without revoking it. settled_at moves aside until the alert is
   * approved. Returns the account's players, or null when it was not Settled.
   */
  async suspendForReview(accountId: string, alertId: string | null, now: Date): Promise<{ playerIds: string[] } | null> {
    const result = await this.pool.query(
      `UPDATE account_settlement
          SET suspended_settled_at = settled_at,
              suspended_provisional_until = provisional_until,
              suspended_alert_id = $2::uuid,
              settled_at = NULL,
              provisional_until = NULL,
              unsettled_at = $3,
              unsettle_reason = 'review_hold',
              updated_at = now()
        WHERE account_id = $1
          AND settled_at IS NOT NULL
          AND (provisional_until IS NULL OR provisional_until > $3)`,
      [accountId, alertId, now]
    );
    if ((result.rowCount ?? 0) === 0) return null;
    const players = await this.pool.query<{ id: string }>("SELECT id FROM players WHERE account_id = $1", [accountId]);
    return { playerIds: players.rows.map((row) => row.id) };
  }

  /** Approve restores a held Settled status (only the hold of that alert when given). */
  async releaseReviewHold(accountId: string, alertId: string | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_settlement
          SET settled_at = suspended_settled_at,
              provisional_until = suspended_provisional_until,
              suspended_settled_at = NULL,
              suspended_provisional_until = NULL,
              suspended_alert_id = NULL,
              unsettled_at = NULL,
              unsettle_reason = NULL,
              updated_at = now()
        WHERE account_id = $1
          AND unsettle_reason = 'review_hold'
          AND suspended_settled_at IS NOT NULL
          AND ($2::uuid IS NULL OR suspended_alert_id = $2::uuid)`,
      [accountId, alertId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // Provisional (grandfathered) rows past their window that did not earn
  // Settled: not for cause, so the Settled home stays and no signal is
  // recorded; full targets apply from now on.
  async expireProvisional(now: Date): Promise<string[]> {
    const result = await this.pool.query<{ account_id: string }>(
      `UPDATE account_settlement
          SET settled_at = NULL,
              provisional_until = NULL,
              unsettled_at = CASE WHEN settled_at IS NOT NULL THEN $1::timestamptz ELSE unsettled_at END,
              unsettle_reason = 'grandfather_expired',
              target_checks = LEAST(${MAX_TARGET_CHECKS}, target_checks * 2),
              target_days = LEAST(${MAX_TARGET_DAYS}, target_days * 2),
              updated_at = now()
        WHERE provisional_until IS NOT NULL
          AND provisional_until <= $1::timestamptz
        RETURNING account_id`,
      [now]
    );
    return result.rows.map((row) => row.account_id);
  }

  // Free re-pick (owner rule O4): an account younger than a day may move its
  // first home once within an hour of its first relocation.
  async claimFreeRepick(accountId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_settlement s
          SET free_repick_used_at = $2, updated_at = now()
         FROM accounts a
        WHERE s.account_id = $1
          AND ${FREE_REPICK_ELIGIBLE_SQL}`,
      [accountId, now, FREE_REPICK_ACCOUNT_AGE_MS]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // Read-only twin of claimFreeRepick (relocation status for the client).
  async freeRepickEligible(accountId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
         FROM account_settlement s, accounts a
        WHERE s.account_id = $1
          AND ${FREE_REPICK_ELIGIBLE_SQL}`,
      [accountId, now, FREE_REPICK_ACCOUNT_AGE_MS]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Alert-zone difficulty (plan 4.3) under the settlement row lock; creates the
   * row (fresh targets at the new difficulty) when the account has none.
   */
  async raiseDifficulty(accountId: string, difficulty: number, baseTargets: SettlementTargets): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let changed = false;
      for (let attempt = 0; attempt < 2 && !changed; attempt += 1) {
        const locked = await lockSettlement(client, accountId);
        if (locked) {
          const next = raiseSettlementDifficulty(locked.state, difficulty);
          if (next) {
            await writeSettlement(client, accountId, next);
            changed = true;
          }
          break;
        }
        const fresh = raiseSettlementDifficulty(emptySettlementState(baseTargets), difficulty);
        if (!fresh) break;
        changed = await insertSettlement(client, accountId, fresh);
        // Not inserted: a concurrent writer created the row; lock it and retry.
      }
      await client.query("COMMIT");
      return changed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseFreeRepick(accountId: string, claimedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE account_settlement SET free_repick_used_at = NULL, updated_at = now()
        WHERE account_id = $1 AND free_repick_used_at = $2`,
      [accountId, claimedAt]
    );
  }
}

// What SettlementService needs from storage (the Trust Lab supplies an in-memory one).
export type SettlementStore = Pick<
  PostgresSettlementStore,
  | "isSettled"
  | "settledHome"
  | "revoke"
  | "adminSettle"
  | "expireProvisional"
  | "claimFreeRepick"
  | "freeRepickEligible"
  | "raiseDifficulty"
  | "releaseFreeRepick"
  | "suspendForReview"
  | "releaseReviewHold"
>;

export type RelocationExemption = Readonly<{
  kind: "return_home" | "free_repick";
  // Undo a claimed free re-pick when the relocation did not commit.
  release(): Promise<void>;
}>;

export type InviteInvalidator = Readonly<{
  invalidateForInviter(inviterPlayerId: string, reason: string): Promise<string[]>;
}>;

export const SETTLED_REVOKED_WEIGHT = 1;
export const SETTLED_REVOKED_INVITE_REASON = "Travel invitation is unavailable.";

export type SettlementStatusListener = (
  accountId: string,
  change: Readonly<{ revoked: boolean }>
) => void | Promise<void>;

export class SettlementService {
  private readonly statusListeners: SettlementStatusListener[] = [];
  private readonly sink: TrustSignalSink;
  private readonly logger: Pick<AppLogger, "warn" | "info"> | undefined;
  private readonly now: () => Date;
  private readonly invites: InviteInvalidator | undefined;
  private readonly onInvitesInvalidated: ((playerIds: string[]) => void | Promise<void>) | undefined;

  constructor(
    private readonly store: SettlementStore,
    private readonly config: SettlementConfig,
    options: Readonly<{
      sink?: TrustSignalSink;
      logger?: Pick<AppLogger, "warn" | "info">;
      now?: () => Date;
      invites?: InviteInvalidator;
      onInvitesInvalidated?: (playerIds: string[]) => void | Promise<void>;
    }> = {}
  ) {
    this.sink = options.sink ?? { recordSignals: async () => undefined };
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.invites = options.invites;
    this.onInvitesInvalidated = options.onInvitesInvalidated;
  }

  rules(): SettlementRules {
    return settlementRules(this.config);
  }

  rollTargets(): SettlementTargets {
    return rollSettlementTargets(this.config);
  }

  /** Session status only (never targets or progress). */
  async isSettled(accountId: string): Promise<boolean> {
    if (isTrustReviewAccount(this.config, accountId)) return true;
    return this.store.isSettled(accountId, this.now());
  }

  /**
   * Revocation for cause (§2.4): progress and Settled home cleared, signal
   * settled_revoked, and the host's pending Travel Invites invalidated at once.
   */
  async revoke(accountId: string, reason: RevocationReason, metadata: Record<string, unknown> = {}): Promise<void> {
    if (isTrustReviewAccount(this.config, accountId)) {
      this.logger?.info({ accountId, reason, ...metadata }, "Settled revocation skipped for a store-review account");
      return;
    }
    const now = this.now();
    const result = await this.store.revoke(accountId, reason, now, this.rollTargets());
    this.notifyStatusChanged(accountId, { revoked: true });
    try {
      await this.sink.recordSignals({
        accountId,
        signals: [{
          rule: "settled_revoked",
          weight: SETTLED_REVOKED_WEIGHT,
          metadata: { ...metadata, reason, wasSettled: result.wasSettled, dedupeKey: `settled_revoked:${accountId}:${now.toISOString()}` }
        }]
      });
    } catch (error) {
      this.logger?.warn({ err: error, accountId }, "Settled revocation signal could not be recorded");
    }
    if (!this.invites) return;
    const affected = new Set<string>();
    for (const playerId of result.playerIds) {
      for (const id of await this.invites.invalidateForInviter(playerId, SETTLED_REVOKED_INVITE_REASON)) affected.add(id);
    }
    if (affected.size > 0) await this.onInvitesInvalidated?.([...affected]);
  }

  /**
   * Red-zone attempt by a Settled account (owner decision E): Settled is paused
   * (not revoked) until the alert is approved; doorways close at once and the
   * host's pending Travel Invites are invalidated. False when not Settled.
   */
  async suspendForReview(accountId: string, alertId: string | null): Promise<boolean> {
    if (isTrustReviewAccount(this.config, accountId)) return false;
    const result = await this.store.suspendForReview(accountId, alertId, this.now());
    if (!result) return false;
    this.notifyStatusChanged(accountId, { revoked: false });
    if (this.invites) {
      const affected = new Set<string>();
      for (const playerId of result.playerIds) {
        for (const id of await this.invites.invalidateForInviter(playerId, SETTLED_REVOKED_INVITE_REASON)) affected.add(id);
      }
      if (affected.size > 0) await this.onInvitesInvalidated?.([...affected]);
    }
    return true;
  }

  /** Admin Approve on the held red alert restores the paused Settled status. */
  async releaseReviewHold(accountId: string, alertId: string | null): Promise<boolean> {
    const released = await this.store.releaseReviewHold(accountId, alertId);
    if (released) this.notifyStatusChanged(accountId, { revoked: false });
    return released;
  }

  /** Admin settle from the Trust screen. False when the account has no home yet. */
  async adminSettle(accountId: string): Promise<boolean> {
    const result = await this.store.adminSettle(accountId, this.now());
    if (!result) return false;
    this.notifyStatusChanged(accountId, { revoked: false });
    return true;
  }

  async expireProvisional(): Promise<number> {
    const accountIds = await this.store.expireProvisional(this.now());
    for (const accountId of accountIds) this.notifyStatusChanged(accountId, { revoked: false });
    return accountIds.length;
  }

  /**
   * Settled gained or lost in this process (revocation, provisional expiry,
   * or a settlement event from the location-report transaction). Listeners
   * drop cached status (anchoring, hostile gate) and apply side effects.
   */
  addStatusListener(listener: SettlementStatusListener): void {
    this.statusListeners.push(listener);
  }

  // Called by LocationReportService after a committed settlement transition.
  onSettlementEvent(accountId: string, event: Exclude<SettlementEvent, null>): void {
    void event;
    this.notifyStatusChanged(accountId, { revoked: false });
  }

  private notifyStatusChanged(accountId: string, change: Readonly<{ revoked: boolean }>): void {
    for (const listener of this.statusListeners) {
      void Promise.resolve()
        .then(() => listener(accountId, change))
        .catch((error: unknown) => {
          this.logger?.warn({ err: error, accountId }, "Settled status listener failed");
        });
    }
  }

  /** Alert-zone difficulty: max(current, difficulty), never lowered (plan 4.3). */
  async raiseDifficulty(accountId: string, difficulty: number): Promise<boolean> {
    return this.store.raiseDifficulty(accountId, difficulty, this.rollTargets());
  }

  /**
   * Client hint only: whether Relocate should stay usable during a cooldown.
   * True when a free re-pick is still open, or when the account has a Settled
   * home (the server checks the distance when the request arrives). Reveals
   * no thresholds; the server still decides every request.
   */
  async relocationExemptionAvailable(accountId: string, lastRelocatedAt: Date | null): Promise<boolean> {
    if (await this.store.settledHome(accountId)) return true;
    if (!lastRelocatedAt) return false;
    const now = this.now();
    if (now.getTime() - lastRelocatedAt.getTime() >= FREE_REPICK_WINDOW_MS) return false;
    return this.store.freeRepickEligible(accountId, now);
  }

  /**
   * Relocation cooldown exemptions (§6): a relocation within the settle radius
   * of the Settled home never costs a cooldown; a new account may re-pick its
   * first home once. Free re-picks are claimed atomically; call release() if
   * the relocation does not commit.
   */
  async relocationExemption(input: Readonly<{
    accountId: string;
    lat: number;
    lon: number;
    inCooldown: boolean;
    lastRelocatedAt: Date | null;
  }>): Promise<RelocationExemption | null> {
    const settledHome = await this.store.settledHome(input.accountId);
    if (settledHome && distanceMeters(settledHome, input) <= this.config.TRUST_SETTLE_RADIUS_KM * 1000) {
      return { kind: "return_home", release: async () => undefined };
    }
    if (!input.inCooldown || !input.lastRelocatedAt) return null;
    const now = this.now();
    if (now.getTime() - input.lastRelocatedAt.getTime() >= FREE_REPICK_WINDOW_MS) return null;
    if (!(await this.store.claimFreeRepick(input.accountId, now))) return null;
    return {
      kind: "free_repick",
      release: () => this.store.releaseFreeRepick(input.accountId, now)
    };
  }
}

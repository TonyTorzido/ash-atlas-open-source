import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DisposableTestPool } from "../../db/disposableTestPool.js";
import { runMigrations } from "../../db/migrate.js";
import {
  PostgresSettlementStore,
  SettlementService,
  type SettlementConfig,
  type SettlementFixUpdate
} from "./settlement.js";
import { PostgresAltDoorwayStore, PostgresLocationReportStore, type LocationReportRow } from "./trustStore.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const DAY_MS = 24 * 60 * 60_000;
const CONFIG: SettlementConfig = {
  TRUST_SETTLE_ASSURANCE_MODE: "shadow",
  TRUST_SETTLE_CHECKS_MIN: 22,
  TRUST_SETTLE_CHECKS_MAX: 30,
  TRUST_SETTLE_DAYS_MIN: 4,
  TRUST_SETTLE_DAYS_MAX: 6,
  TRUST_SETTLE_RADIUS_KM: 25,
  TRUST_SETTLE_MIN_GAP_SECONDS: 170,
  TRUST_SETTLE_MIN_DISTINCT_POSITIONS: 3,
  TRUST_SETTLE_ACCURACY_M: 5000,
  TRUST_DOORWAY_MIN_ACCOUNT_AGE_DAYS: 14
};
const RULES = { radiusM: 25_000, minGapMs: 170_000, minDistinctPositions: 3, minAccountAgeMs: 14 * DAY_MS };

(adminUrl ? describe : describe.skip)("Settled store (account_settlement)", () => {
  const databaseName = `ash_atlas_stability_settle_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let pool: pg.Pool;

  const account = async (ageDays: number) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, status, trust_tier, created_at) VALUES ($1, 'active', 'standard', now() - ($2::int * interval '1 day'))`,
      [id, ageDays]
    );
    return id;
  };
  const player = async (accountId: string) => {
    const id = `p-${randomUUID()}`;
    await pool.query(
      `INSERT INTO players (id, account_id, username, username_normalized, display_color, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, geom)
       VALUES ($1, $2, $3, lower($3), '#3366cc', 'CO', 40, -105, 40, -105, 600, ST_SetSRID(ST_MakePoint(-105, 40), 4326))`,
      [id, accountId, `S${randomUUID().slice(0, 10)}`]
    );
    return id;
  };
  const report = (accountId: string, source: "passive" | "relocation", lat: number, at: Date): LocationReportRow => ({
    id: randomUUID(), accountId, playerId: null, source, requestId: null, lat, lon: -105, accuracyM: 10,
    clientPlatform: "android", deviceInstallationId: null, networkHash: null, networkPrefixHash: null,
    deviceTimeZone: null, receivedAt: at, prevReportId: null, distanceM: null, elapsedMs: null, impliedKmh: null,
    speedBucket: null, verdict: "accepted", verdictReason: null, features: {}, score: 0, assurance: "native_legacy"
  });
  const accepted = { holdUntil: null, holdReason: null, relocations7dFar: 0 };
  const update = (source: "passive" | "relocation", lat: number, at: Date): SettlementFixUpdate => ({
    source, lat, lon: -105, at, countable: source === "passive", baseTargets: { checks: 3, days: 2 }, rules: RULES
  });
  const row = async (accountId: string) => (await pool.query(
    `SELECT counted_checks, counted_days, distinct_positions, home_lat, settled_at, settled_home_lat,
            unsettle_reason, provisional_until, target_checks, free_repick_used_at
       FROM account_settlement WHERE account_id = $1`,
    [accountId]
  )).rows[0];

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname)
      || parsed.port === "35432"
      || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
    ) throw new Error("Settled store tests require a disposable local database");
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    parsed.pathname = `/${databaseName}`;
    await runMigrations(parsed.toString());
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 6 });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  });

  it("counts one of two concurrent fixes inside the gap and earns Settled across days", async () => {
    const accountId = await account(60);
    const reports = new PostgresLocationReportStore(pool);
    const t0 = new Date("2026-10-01T10:00:00.000Z");
    await Promise.all([
      reports.recordLocationReport(report(accountId, "passive", 40, t0), accepted, update("passive", 40, t0)),
      reports.recordLocationReport(report(accountId, "passive", 40.001, new Date(t0.getTime() + 1000)), accepted,
        update("passive", 40.001, new Date(t0.getTime() + 1000)))
    ]);
    expect(await row(accountId)).toMatchObject({ counted_checks: 1, counted_days: 1, home_lat: 40, settled_at: null });
    expect((await pool.query("SELECT last_fix_assurance FROM account_location_state WHERE account_id = $1", [accountId]))
      .rows[0]).toEqual({ last_fix_assurance: "native_legacy" });

    const day2 = new Date(t0.getTime() + DAY_MS);
    await reports.updateLastFix({
      accountId, lat: 40.01, lon: -105, accuracyM: 10, at: day2, assurance: "native_legacy",
      settlement: update("passive", 40.01, day2)
    });
    const day3 = new Date(t0.getTime() + 2 * DAY_MS);
    const result = await reports.recordLocationReport(report(accountId, "passive", 40.02, day3), accepted, update("passive", 40.02, day3));
    expect(result.settlementEvent).toBe("settled");
    expect(await row(accountId)).toMatchObject({ counted_checks: 3, counted_days: 3, distinct_positions: 3, settled_home_lat: 40 });

    // Moving away loses Settled, returning restores it.
    const away = new Date(day3.getTime() + 1000);
    expect((await reports.recordLocationReport(report(accountId, "relocation", 45, away), accepted, update("relocation", 45, away)))
      .settlementEvent).toBe("moved_away");
    expect(await row(accountId)).toMatchObject({ settled_at: null, unsettle_reason: "moved_away", home_lat: 45, counted_checks: 0 });
    const back = new Date(day3.getTime() + 2000);
    expect((await reports.recordLocationReport(report(accountId, "relocation", 40.05, back), accepted, update("relocation", 40.05, back)))
      .settlementEvent).toBe("returned_home");
  });

  it("revokes for cause: clears progress and home, signals, and invalidates the host's invites", async () => {
    const accountId = await account(60);
    const playerId = await player(accountId);
    await pool.query(
      `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon,
         target_checks, target_days, counted_checks, settled_at)
       VALUES ($1, 40, -105, 40, -105, 25, 5, 30, now())`,
      [accountId]
    );
    const sink = { recordSignals: vi.fn(async () => undefined) };
    const invites = { invalidateForInviter: vi.fn(async () => ["guest-1"]) };
    const notified = vi.fn();
    const service = new SettlementService(new PostgresSettlementStore(pool), CONFIG, {
      sink, invites, onInvitesInvalidated: notified
    });
    expect(await service.isSettled(accountId)).toBe(true);
    await service.revoke(accountId, "location_mock");
    expect(await row(accountId)).toMatchObject({
      settled_at: null, settled_home_lat: null, counted_checks: 0, unsettle_reason: "location_mock"
    });
    expect(await service.isSettled(accountId)).toBe(false);
    expect(sink.recordSignals).toHaveBeenCalledWith(expect.objectContaining({
      accountId,
      signals: [expect.objectContaining({ rule: "settled_revoked", weight: 1 })]
    }));
    expect(invites.invalidateForInviter).toHaveBeenCalledWith(playerId, "Travel invitation is unavailable.");
    expect(notified).toHaveBeenCalledWith(["guest-1"]);

    const doorway = await new PostgresAltDoorwayStore(pool).loadDoorwayPlayer(playerId);
    expect(doorway).toMatchObject({ settled: false, settledHome: null });
  });

  it("expires unearned provisional rows without clearing the Settled home", async () => {
    const accountId = await account(60);
    await pool.query(
      `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon,
         target_checks, target_days, settled_at, provisional_until)
       VALUES ($1, 40, -105, 40, -105, 12, 3, now() - interval '30 days', now() - interval '1 minute')`,
      [accountId]
    );
    const service = new SettlementService(new PostgresSettlementStore(pool), CONFIG);
    expect(await service.isSettled(accountId)).toBe(false);
    expect(await service.expireProvisional()).toBeGreaterThanOrEqual(1);
    expect(await row(accountId)).toMatchObject({
      settled_at: null, provisional_until: null, settled_home_lat: 40, unsettle_reason: "grandfather_expired", target_checks: 24
    });
    expect(await service.expireProvisional()).toBe(0);
  });

  it("exempts a return home from the cooldown and allows one free re-pick for a new account", async () => {
    const service = new SettlementService(new PostgresSettlementStore(pool), CONFIG);
    const settledId = await account(60);
    await pool.query(
      `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon,
         target_checks, target_days, settled_at)
       VALUES ($1, 45, -105, 40, -105, 25, 5, NULL)`,
      [settledId]
    );
    const recent = new Date(Date.now() - 10 * 60_000);
    expect((await service.relocationExemption({ accountId: settledId, lat: 40.1, lon: -105, inCooldown: true, lastRelocatedAt: recent }))
      ?.kind).toBe("return_home");
    expect(await service.relocationExemption({ accountId: settledId, lat: 42, lon: -105, inCooldown: true, lastRelocatedAt: recent }))
      .toBeNull();

    const newcomer = await account(0);
    await pool.query(
      "INSERT INTO account_settlement (account_id, home_lat, home_lon, target_checks, target_days) VALUES ($1, 35, -106, 25, 5)",
      [newcomer]
    );
    await pool.query(
      `INSERT INTO location_reports (id, account_id, seq, source, lat, lon, verdict) VALUES ($1, $2, 1, 'relocation', 35, -106, 'accepted')`,
      [randomUUID(), newcomer]
    );
    const input = { accountId: newcomer, lat: 30, lon: -100, inCooldown: true, lastRelocatedAt: recent };
    const first = await service.relocationExemption(input);
    expect(first?.kind).toBe("free_repick");
    expect(await service.relocationExemption(input)).toBeNull();
    // A failed relocation gives the re-pick back.
    await first!.release();
    expect((await service.relocationExemption(input))?.kind).toBe("free_repick");
    // Too late after the first relocation.
    await pool.query("UPDATE account_settlement SET free_repick_used_at = NULL WHERE account_id = $1", [newcomer]);
    expect(await service.relocationExemption({ ...input, lastRelocatedAt: new Date(Date.now() - 61 * 60_000) })).toBeNull();
  });

  it("pauses Settled for review, keeps it paused through fixes, and Approve restores it (owner decision E)", async () => {
    const accountId = await account(90);
    const playerId = await player(accountId);
    const provisionalUntil = new Date(Date.now() + 10 * DAY_MS);
    await pool.query(
      `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon,
         target_checks, target_days, counted_checks, settled_at, provisional_until)
       VALUES ($1, 40, -105, 40, -105, 3, 1, 1, now() - interval '5 days', $2)`,
      [accountId, provisionalUntil]
    );
    const alertId = randomUUID();
    const invites = { invalidateForInviter: vi.fn(async () => ["guest-9"]) };
    const service = new SettlementService(new PostgresSettlementStore(pool), CONFIG, { invites });
    expect(await service.suspendForReview(accountId, alertId)).toBe(true);
    expect(await service.isSettled(accountId)).toBe(false);
    expect(await row(accountId)).toMatchObject({ settled_at: null, unsettle_reason: "review_hold", settled_home_lat: 40 });
    expect(invites.invalidateForInviter).toHaveBeenCalledWith(playerId, "Travel invitation is unavailable.");
    expect((await new PostgresAltDoorwayStore(pool).loadDoorwayPlayer(playerId))?.settled).toBe(false);
    // Countable passive fixes earn nothing while held (and never break the hold's CHECK).
    const reports = new PostgresLocationReportStore(pool);
    for (const minutes of [10, 7, 4]) {
      const at = new Date(Date.now() - minutes * 60_000);
      await reports.recordLocationReport(report(accountId, "passive", 40 + minutes / 1000, at), accepted, update("passive", 40 + minutes / 1000, at));
    }
    expect(await service.isSettled(accountId)).toBe(false);
    // Another alert's approval does not release it; this alert's does.
    expect(await service.releaseReviewHold(accountId, randomUUID())).toBe(false);
    expect(await service.releaseReviewHold(accountId, alertId)).toBe(true);
    expect(await service.isSettled(accountId)).toBe(true);
    expect((await row(accountId)).provisional_until?.getTime()).toBe(provisionalUntil.getTime());
    // An unsettled account is never held; a held account can still be revoked for cause.
    const newcomer = await account(3);
    expect(await service.suspendForReview(newcomer, null)).toBe(false);
    expect(await service.suspendForReview(accountId, alertId)).toBe(true);
    await service.revoke(accountId, "location_mock");
    expect(await row(accountId)).toMatchObject({ settled_at: null, settled_home_lat: null, unsettle_reason: "location_mock" });
    expect(await service.releaseReviewHold(accountId, alertId)).toBe(false);
  });
});

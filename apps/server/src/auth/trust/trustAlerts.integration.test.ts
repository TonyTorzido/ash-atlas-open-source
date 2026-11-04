import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { PostgresSettlementStore, SettlementService, type SettlementConfig } from "./settlement.js";
import { alertCellKey, PostgresTrustAlertStore } from "./trustAlerts.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60_000;
const CONFIG: SettlementConfig = {
  TRUST_SETTLE_ASSURANCE_MODE: "shadow",
  TRUST_SETTLE_CHECKS_MIN: 22,
  TRUST_SETTLE_CHECKS_MAX: 22,
  TRUST_SETTLE_DAYS_MIN: 5,
  TRUST_SETTLE_DAYS_MAX: 5,
  TRUST_SETTLE_RADIUS_KM: 25,
  TRUST_SETTLE_MIN_GAP_SECONDS: 170,
  TRUST_SETTLE_MIN_DISTINCT_POSITIONS: 3,
  TRUST_SETTLE_ACCURACY_M: 5000,
  TRUST_DOORWAY_MIN_ACCOUNT_AGE_DAYS: 14
};
const RED = { lat: -80.53, lon: 20.27 };

describeDatabase("trust alerts and zone difficulty (PostgreSQL)", () => {
  let pool: pg.Pool;
  let alerts: PostgresTrustAlertStore;

  const account = async (ageDays: number) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, status, trust_tier, created_at)
       VALUES ($1, 'active', 'standard', now() - ($2::double precision * interval '1 day'))`,
      [id, ageDays]
    );
    return id;
  };
  const alertRows = async (accountId: string) => (await pool.query<{
    kind: string; severity: number; status: string; cell_key: string; lat_rounded: number; lon_rounded: number;
    details: Record<string, unknown>; allowance_expires_at: Date | null;
  }>(
    `SELECT kind, severity, status, cell_key, lat_rounded, lon_rounded, details, allowance_expires_at
       FROM trust_alerts WHERE account_id = $1 ORDER BY created_at, id`,
    [accountId]
  )).rows;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 6 });
    alerts = new PostgresTrustAlertStore(pool);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("keeps one pending red alert per account, bumps its count, and caps reds at 3 in 30 days", async () => {
    const accountId = await account(60);
    const now = new Date();
    const first = await alerts.fileRedAlert({ accountId, ...RED, now, details: { mode: "enforce" } });
    expect(first).toMatchObject({ created: true, severity: 3 });
    // Replay, and a concurrent pair: still exactly one pending red.
    const again = await Promise.all([
      alerts.fileRedAlert({ accountId, ...RED, now, details: {} }),
      alerts.fileRedAlert({ accountId, lat: 10, lon: 10, now, details: {} })
    ]);
    expect(again.map((result) => result.created)).toEqual([false, false]);
    const rows = await alertRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "zone_red", status: "pending", cell_key: alertCellKey(RED.lat, RED.lon),
      lat_rounded: -80.53, lon_rounded: 20.27, details: { mode: "enforce", count: 3 }
    });

    // Reviewed alerts free the pending slot until the 30-day cap.
    await pool.query("UPDATE trust_alerts SET status = 'dismissed' WHERE account_id = $1", [accountId]);
    expect((await alerts.fileRedAlert({ accountId, ...RED, now, details: {} })).created).toBe(true);
    await pool.query("UPDATE trust_alerts SET status = 'dismissed' WHERE account_id = $1", [accountId]);
    expect((await alerts.fileRedAlert({ accountId, ...RED, now, details: {} })).created).toBe(true);
    await pool.query("UPDATE trust_alerts SET status = 'dismissed' WHERE account_id = $1", [accountId]);
    expect((await alerts.fileRedAlert({ accountId, ...RED, now, details: {} })).created).toBe(false);
    expect((await alerts.fileRedAlert({
      accountId, ...RED, now: new Date(now.getTime() + 31 * DAY_MS), details: {}
    })).created).toBe(true);
  });

  it("gives a red alert from an account younger than a day severity 4", async () => {
    const accountId = await account(0.5);
    expect(await alerts.fileRedAlert({ accountId, ...RED, now: new Date(), details: {} }))
      .toMatchObject({ created: true, severity: 4 });
  });

  it("files one orange/yellow alert per account per cell per 7 days and bumps the count", async () => {
    const accountId = await account(60);
    const now = new Date();
    const results = await Promise.all([
      alerts.fileZoneAlert({ accountId, kind: "zone_orange", lat: 60.012, lon: -150.01, now, details: {} }),
      alerts.fileZoneAlert({ accountId, kind: "zone_orange", lat: 60.014, lon: -150.02, now, details: {} })
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const later = (ms: number) => new Date(now.getTime() + ms);
    await alerts.fileZoneAlert({ accountId, kind: "zone_yellow", lat: 60.012, lon: -150.01, now: later(1), details: { owners: ["x"] } });
    await alerts.fileZoneAlert({ accountId, kind: "zone_orange", lat: 61, lon: -150.01, now: later(2), details: {} });
    await alerts.fileZoneAlert({
      accountId, kind: "zone_orange", lat: 60.012, lon: -150.01, now: new Date(now.getTime() + 8 * DAY_MS), details: {}
    });
    const rows = await alertRows(accountId);
    expect(rows.map((row) => [row.kind, row.severity, (row.details as { count: number }).count])).toEqual([
      ["zone_orange", 2, 2],
      ["zone_yellow", 1, 1],
      ["zone_orange", 2, 1],
      ["zone_orange", 2, 1]
    ]);
    expect(rows[1]?.details).toMatchObject({ owners: ["x"] });
  });

  it("consumes an approved red allowance once, atomically, and can give it back", async () => {
    const accountId = await account(60);
    const now = new Date();
    const cellKey = alertCellKey(RED.lat, RED.lon);
    const expiresAt = new Date(now.getTime() + 7 * DAY_MS);
    await pool.query(
      `INSERT INTO trust_alerts (id, account_id, kind, severity, status, cell_key, allowance_expires_at)
       VALUES ($1, $2, 'zone_red', 3, 'approved', $3, $4)`,
      [randomUUID(), accountId, cellKey, expiresAt]
    );
    expect(await alerts.consumeRedAllowance(accountId, alertCellKey(0, 0), now)).toBeNull();
    const pair = await Promise.all([
      alerts.consumeRedAllowance(accountId, cellKey, now),
      alerts.consumeRedAllowance(accountId, cellKey, now)
    ]);
    const won = pair.filter((allowance) => allowance !== null);
    expect(won).toHaveLength(1);
    expect(won[0]?.expiresAt.getTime()).toBe(expiresAt.getTime());
    expect(await alerts.consumeRedAllowance(accountId, cellKey, now)).toBeNull();

    await alerts.restoreRedAllowance(won[0]!);
    expect(await alerts.consumeRedAllowance(accountId, cellKey, now)).not.toBeNull();
    expect(await alerts.consumeRedAllowance(accountId, cellKey, now)).toBeNull();
    // Expired allowances never pass.
    const lateAccount = await account(60);
    await pool.query(
      `INSERT INTO trust_alerts (id, account_id, kind, severity, status, cell_key, allowance_expires_at)
       VALUES ($1, $2, 'zone_red', 3, 'approved', $3, $4)`,
      [randomUUID(), lateAccount, cellKey, new Date(now.getTime() - 1000)]
    );
    expect(await alerts.consumeRedAllowance(lateAccount, cellKey, now)).toBeNull();
  });

  it("raises difficulty (creating the row if needed) and never lowers it", async () => {
    const service = new SettlementService(new PostgresSettlementStore(pool), CONFIG);
    const accountId = await account(60);
    const state = async () => (await pool.query(
      "SELECT difficulty::float8 AS difficulty, target_checks, target_days FROM account_settlement WHERE account_id = $1",
      [accountId]
    )).rows[0];
    expect(await service.raiseDifficulty(accountId, 1.5)).toBe(true);
    expect(await state()).toEqual({ difficulty: 1.5, target_checks: 33, target_days: 8 });
    expect(await service.raiseDifficulty(accountId, 2)).toBe(true);
    expect(await state()).toEqual({ difficulty: 2, target_checks: 44, target_days: 11 });
    expect(await service.raiseDifficulty(accountId, 1.5)).toBe(false);
    expect(await service.raiseDifficulty(accountId, 2)).toBe(false);
    expect(await state()).toEqual({ difficulty: 2, target_checks: 44, target_days: 11 });
  });

  it("reports an exemption hint for a Settled home or an open free re-pick", async () => {
    const service = new SettlementService(new PostgresSettlementStore(pool), CONFIG);
    const recent = new Date(Date.now() - 10 * 60_000);
    const settled = await account(60);
    await pool.query(
      `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon, target_checks, target_days)
       VALUES ($1, 45, -105, 40, -105, 25, 5)`,
      [settled]
    );
    expect(await service.relocationExemptionAvailable(settled, null)).toBe(true);

    const newcomer = await account(0);
    expect(await service.relocationExemptionAvailable(newcomer, recent)).toBe(false);
    await pool.query(
      "INSERT INTO account_settlement (account_id, home_lat, home_lon, target_checks, target_days) VALUES ($1, 35, -106, 25, 5)",
      [newcomer]
    );
    await pool.query(
      `INSERT INTO location_reports (id, account_id, seq, source, lat, lon, verdict) VALUES ($1, $2, 1, 'relocation', 35, -106, 'accepted')`,
      [randomUUID(), newcomer]
    );
    expect(await service.relocationExemptionAvailable(newcomer, recent)).toBe(true);
    expect(await service.relocationExemptionAvailable(newcomer, new Date(Date.now() - 61 * 60_000))).toBe(false);
    const claimed = await service.relocationExemption({
      accountId: newcomer, lat: 30, lon: -100, inCooldown: true, lastRelocatedAt: recent
    });
    expect(claimed?.kind).toBe("free_repick");
    expect(await service.relocationExemptionAvailable(newcomer, recent)).toBe(false);
  });
});

function testDatabaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must use local PostgreSQL");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must target an ash_atlas_stability* database");
  }
  return value;
}

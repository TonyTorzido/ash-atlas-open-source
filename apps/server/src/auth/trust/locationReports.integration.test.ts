import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../../db/disposableTestPool.js";
import { runMigrations } from "../../db/migrate.js";
import { LocationReportService } from "./trustService.js";
import {
  PostgresLocationReportStore,
  locationReportRetentionCutoffs,
  type LocationReportRow
} from "./trustStore.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const MIGRATION = "0881_location_reports.sql";

databaseSuite("location report ledger migration and seq authority", () => {
  const databaseName = `ash_atlas_stability_location_reports_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const accountId = randomUUID();
  const deviceId = randomUUID();
  let admin: pg.Pool | undefined;
  let pool: DisposableTestPool | undefined;
  let directory = "";
  let databaseUrl = "";

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.pathname !== "/ash_atlas_stability"
      || !["postgres:", "postgresql:"].includes(url.protocol)
    ) {
      throw new Error("Location report tests require a local disposable ash_atlas_stability admin");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-location-reports-"));
    const migrations = path.resolve(process.cwd(), "../../db/migrations");
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare("0881_") < 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 12 });
    await pool.query(
      "INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')",
      [accountId]
    );
    await pool.query(
      "INSERT INTO device_installations (id, token_hash) VALUES ($1, $2)",
      [deviceId, randomUUID()]
    );
    await copyFile(path.join(migrations, MIGRATION), path.join(directory, MIGRATION));
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([MIGRATION]);
    // The store also writes later account_location_state columns (0884 home/presence).
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare(MIGRATION) > 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("preserves populated accounts and has an empty second run", async () => {
    expect((await pool!.query("SELECT trust_tier FROM accounts WHERE id = $1", [accountId])).rows)
      .toEqual([{ trust_tier: "standard" }]);
    expect((await pool!.query("SELECT count(*)::int AS count FROM location_reports")).rows[0].count).toBe(0);
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([]);
  });

  it("assigns distinct per-account seq under concurrent records", async () => {
    const store = new PostgresLocationReportStore(pool!);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => store.recordLocationReport(row({ lat: 10 + index }), null))
    );
    expect(results.map((result) => result.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await pool!.query(
      "SELECT last_seq::int AS last_seq FROM account_location_state WHERE account_id = $1",
      [accountId]
    )).rows).toEqual([{ last_seq: 8 }]);
  });

  it("records through the service, never shortens a hold, and survives retention cleanup", async () => {
    const otherAccount = randomUUID();
    await pool!.query("INSERT INTO accounts (id) VALUES ($1)", [otherAccount]);
    const store = new PostgresLocationReportStore(pool!);
    const config = {
      TRUST_LOCATION_REJECT_MODE: "shadow" as const,
      TRUST_LAND_ACTION_MIN_DISPLACEMENT_M: 500,
      TRUST_TRANSIT_HOLD_MINUTES: 10,
      TRUST_SETTLE_ACCURACY_M: 5000
    };
    const first = new Date("2026-10-01T00:00:00.000Z");
    const input = (lat: number, now: Date) => ({
      accountId: otherAccount,
      playerId: "player-location",
      source: "relocation" as const,
      lat,
      lon: -105,
      accuracyM: 20,
      clientPlatform: "web" as const,
      deviceInstallationId: deviceId,
      networkHash: "v1:network",
      networkPrefixHash: "v1:prefix",
      avatarPosition: { lat: 31, lon: -105 },
      now
    });
    const service = new LocationReportService(store, config, { now: () => first });
    const firstInput = input(40, first);
    const firstEvaluation = await service.evaluate(firstInput);
    const firstReport = await service.record(firstInput, firstEvaluation, "accepted");
    expect(firstReport.seq).toBe(1);

    // A tiny second move one minute later would hold less; the longer hold stays.
    const second = new Date(first.getTime() + 60_000);
    const secondInput = input(40.006, second);
    const secondEvaluation = await service.evaluate(secondInput);
    expect(secondEvaluation.prevReportId).toBe(firstReport.reportId);
    expect(secondEvaluation.bucket).toBe("cycle");
    expect(secondEvaluation.holdUntil!.getTime()).toBeLessThan(firstEvaluation.holdUntil!.getTime());
    const secondReport = await service.record(secondInput, secondEvaluation, "accepted");

    const state = (await pool!.query(
      `SELECT last_seq::int AS last_seq, last_accepted_report_id, last_fix_lat,
              land_action_hold_until, land_action_hold_reason
         FROM account_location_state WHERE account_id = $1`,
      [otherAccount]
    )).rows[0];
    expect(state).toMatchObject({
      last_seq: 2,
      last_accepted_report_id: secondReport.reportId,
      last_fix_lat: 40.006,
      land_action_hold_reason: "relocation_cooldown"
    });
    expect((state.land_action_hold_until as Date).getTime()).toBe(firstEvaluation.holdUntil!.getTime());
    expect((await pool!.query(
      "SELECT prev_report_id, verdict, speed_bucket FROM location_reports WHERE id = $1",
      [secondReport.reportId]
    )).rows).toEqual([{ prev_report_id: firstReport.reportId, verdict: "accepted", speed_bucket: "cycle" }]);

    expect(await store.deleteLocationReportsBefore(new Date("2100-01-01T00:00:00.000Z"))).toBeGreaterThanOrEqual(10);
    expect((await pool!.query(
      "SELECT last_accepted_report_id, last_seq::int AS last_seq FROM account_location_state WHERE account_id = $1",
      [otherAccount]
    )).rows).toEqual([{ last_accepted_report_id: null, last_seq: 2 }]);
    // seq keeps counting after retention removes old rows.
    expect((await store.recordLocationReport(row({ accountId: otherAccount }), null)).seq).toBe(3);
  });

  it("skips redundant passive rows, keeps speed state, sets passive transit holds, and splits retention", async () => {
    const passiveAccount = randomUUID();
    await pool!.query("INSERT INTO accounts (id) VALUES ($1)", [passiveAccount]);
    const store = new PostgresLocationReportStore(pool!);
    const config = {
      TRUST_LOCATION_REJECT_MODE: "shadow" as const,
      TRUST_LAND_ACTION_MIN_DISPLACEMENT_M: 500,
      TRUST_TRANSIT_HOLD_MINUTES: 10,
      TRUST_SETTLE_ACCURACY_M: 5000
    };
    const service = new LocationReportService(store, config);
    const start = new Date("2026-10-01T00:00:00.000Z");
    const at = (ms: number) => new Date(start.getTime() + ms);
    const input = (source: "relocation" | "passive", lat: number, now: Date) => ({
      accountId: passiveAccount,
      playerId: "player-passive",
      source,
      ...(source === "passive" ? { fixReason: "periodic" as const } : {}),
      lat,
      lon: -105,
      accuracyM: 10,
      deviceInstallationId: deviceId,
      networkHash: null,
      networkPrefixHash: null,
      avatarPosition: null,
      now
    });
    const reportCount = async () => Number((await pool!.query(
      "SELECT count(*)::int AS count FROM location_reports WHERE account_id = $1",
      [passiveAccount]
    )).rows[0].count);
    const record = async (fix: ReturnType<typeof input>) =>
      service.record(fix, await service.evaluate(fix), "accepted");

    const stored = await record(input("relocation", 40, start));
    expect(stored.seq).toBe(1);

    // ~44 m raw, 24 m after accuracy, 5 minutes later: no row, but last_fix_* moves.
    const skipped = await record(input("passive", 40.0004, at(5 * 60_000)));
    expect(skipped).toEqual({ reportId: null, seq: null });
    expect(await reportCount()).toBe(1);
    const afterSkip = await store.loadLocationContext(passiveAccount, start, 100_000);
    expect(afterSkip.state).toMatchObject({
      lastSeq: 1,
      lastAcceptedReportId: stored.reportId,
      lastFix: { lat: 40.0004, at: at(5 * 60_000) },
      lastStoredFix: { lat: 40, at: start },
      lastFixPassive: true
    });

    // 2 km only 10 s after the passive fix: stored, but speed is a feature only.
    const noisyFix = input("passive", 40.0184, at(5 * 60_000 + 10_000));
    const noisy = await service.evaluate(noisyFix);
    expect(noisy).toMatchObject({ bucket: null, holdUntil: null, score: 0, skipStore: false });
    expect(noisy.features).toMatchObject({ speedNoiseGuarded: "air" });
    await service.record(noisyFix, noisy, "accepted");
    expect(await reportCount()).toBe(2);

    // ~33 km in 15 minutes: car, transit hold from a passive fix.
    const carFix = input("passive", 40.3184, at(20 * 60_000 + 10_000));
    const car = await service.evaluate(carFix);
    expect(car).toMatchObject({ bucket: "car", holdReason: "transit" });
    await service.record(carFix, car, "accepted");
    const holdState = (await pool!.query(
      `SELECT land_action_hold_reason, land_action_hold_until
         FROM account_location_state WHERE account_id = $1`,
      [passiveAccount]
    )).rows[0];
    expect(holdState.land_action_hold_reason).toBe("transit");
    expect((holdState.land_action_hold_until as Date).getTime()).toBe(car.holdUntil!.getTime());
    expect((await pool!.query(
      `SELECT features->>'fixReason' AS reason, speed_bucket
         FROM location_reports WHERE account_id = $1 AND source = 'passive' ORDER BY seq`,
      [passiveAccount]
    )).rows).toEqual([
      { reason: "periodic", speed_bucket: null },
      { reason: "periodic", speed_bucket: "car" }
    ]);

    // Retention: passive rows go after 30 days, relocation rows keep the configured window.
    const retentionAccount = randomUUID();
    await pool!.query("INSERT INTO accounts (id) VALUES ($1)", [retentionAccount]);
    const now = new Date("2026-10-01T00:00:00.000Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000);
    await store.recordLocationReport(row({ accountId: retentionAccount, source: "passive", receivedAt: daysAgo(31) }), null);
    await store.recordLocationReport(row({ accountId: retentionAccount, source: "passive", receivedAt: daysAgo(29) }), null);
    await store.recordLocationReport(row({ accountId: retentionAccount, source: "relocation", receivedAt: daysAgo(31) }), null);
    await store.recordLocationReport(row({ accountId: retentionAccount, source: "relocation", receivedAt: daysAgo(181) }), null);
    const { cutoff, passiveCutoff } = locationReportRetentionCutoffs(180, now);
    await store.deleteLocationReportsBefore(cutoff, passiveCutoff);
    expect((await pool!.query(
      `SELECT source, extract(day FROM $2::timestamptz - received_at)::int AS age_days
         FROM location_reports WHERE account_id = $1 ORDER BY received_at DESC`,
      [retentionAccount, now]
    )).rows).toEqual([
      { source: "passive", age_days: 29 },
      { source: "relocation", age_days: 31 }
    ]);
    // A shorter configured retention also bounds passive rows.
    expect(locationReportRetentionCutoffs(7, now).passiveCutoff).toEqual(daysAgo(7));
  });

  function row(overrides: Partial<LocationReportRow> = {}): LocationReportRow {
    return {
      id: randomUUID(),
      accountId,
      playerId: "player-location",
      source: "relocation",
      requestId: null,
      lat: 40,
      lon: -105,
      accuracyM: null,
      clientPlatform: null,
      deviceInstallationId: deviceId,
      networkHash: null,
      networkPrefixHash: null,
      deviceTimeZone: null,
      receivedAt: new Date(),
      prevReportId: null,
      distanceM: null,
      elapsedMs: null,
      impliedKmh: null,
      speedBucket: null,
      verdict: "accepted",
      verdictReason: null,
      features: {},
      score: 0,
      ...overrides
    };
  }
});

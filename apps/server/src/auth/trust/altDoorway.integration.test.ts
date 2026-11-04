import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../../db/disposableTestPool.js";
import { runMigrations } from "../../db/migrate.js";
import { PostgresAltDoorwayStore, PostgresLocationReportStore } from "./trustStore.js";
import type { LocationReportRow } from "./trustStore.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const MIGRATION = "0884_alt_doorway.sql";
const DAY_MS = 24 * 60 * 60_000;

databaseSuite("0884 alt doorway migration and store", () => {
  const databaseName = `ash_atlas_stability_alt_doorway_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const veteran = randomUUID();
  const veteranWithState = randomUUID();
  const newcomer = randomUUID();
  const deviceId = randomUUID();
  const veteranPlayer = `p-${randomUUID()}`;
  const newcomerPlayer = `p-${randomUUID()}`;
  let admin: pg.Pool | undefined;
  let pool: DisposableTestPool | undefined;
  let directory = "";
  let databaseUrl = "";

  const insertPlayer = async (playerId: string, accountId: string, name: string) => {
    await pool!.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color,
         region_code, lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, geom
       ) VALUES (
         $1, $2, $3, lower($3), '#3366cc', 'CO', 40, -105, 40, -105, 600,
         ST_SetSRID(ST_MakePoint(-105, 40), 4326)
       )`,
      [playerId, accountId, name]
    );
  };

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.pathname !== "/ash_atlas_stability"
      || !["postgres:", "postgresql:"].includes(url.protocol)
    ) {
      throw new Error("Alt doorway tests require a local disposable ash_atlas_stability admin");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-alt-doorway-"));
    const migrations = path.resolve(process.cwd(), "../../db/migrations");
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare("0884_") < 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 10 });
    // Populated: two veterans (one with location state), one newcomer.
    await pool.query(
      `INSERT INTO accounts (id, status, trust_tier, created_at) VALUES
         ($1, 'active', 'standard', now() - interval '40 days'),
         ($2, 'active', 'standard', now() - interval '20 days'),
         ($3, 'active', 'new', now() - interval '2 days')`,
      [veteran, veteranWithState, newcomer]
    );
    await pool.query(
      `INSERT INTO account_location_state (account_id, last_seq, land_action_hold_reason, land_action_hold_until)
       VALUES ($1, 7, 'transit', now() + interval '5 minutes')`,
      [veteranWithState]
    );
    await copyFile(path.join(migrations, MIGRATION), path.join(directory, MIGRATION));
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([MIGRATION]);
    // The stores below read the current schema (0911/0912 assurance + settlement).
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare(MIGRATION) > 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    await insertPlayer(veteranPlayer, veteran, `Vet${randomUUID().slice(0, 8)}`);
    await insertPlayer(newcomerPlayer, newcomer, `New${randomUUID().slice(0, 8)}`);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("grandfathers old accounts, keeps existing state, and has an empty second run", async () => {
    const rows = (await pool!.query<{
      account_id: string; confirmed: boolean; last_seq: number; land_action_hold_reason: string | null; confirmed_days: number;
    }>(
      `SELECT account_id, home_confirmed_at IS NOT NULL AS confirmed, last_seq::int AS last_seq,
              land_action_hold_reason, confirmed_days
         FROM account_location_state`
    )).rows;
    const byId = new Map(rows.map((row) => [row.account_id, row]));
    expect(byId.get(veteran)).toMatchObject({ confirmed: true, last_seq: 0, confirmed_days: 0 });
    expect(byId.get(veteranWithState)).toMatchObject({ confirmed: true, last_seq: 7, land_action_hold_reason: "transit" });
    expect(byId.has(newcomer)).toBe(false);
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([]);
  });

  it("sets home from the first relocation and confirms each UTC day once near home", async () => {
    const reports = new PostgresLocationReportStore(pool!);
    const doorway = new PostgresAltDoorwayStore(pool!);
    const base = new Date("2026-10-01T10:00:00.000Z");
    const report = (source: "relocation" | "passive", lat: number, at: Date): LocationReportRow => ({
      id: randomUUID(), accountId: newcomer, playerId: newcomerPlayer, source, requestId: null,
      lat, lon: -105, accuracyM: 10, clientPlatform: "web", deviceInstallationId: null,
      networkHash: null, networkPrefixHash: null, deviceTimeZone: null, receivedAt: at,
      prevReportId: null, distanceM: null, elapsedMs: null, impliedKmh: null, speedBucket: null,
      verdict: "accepted", verdictReason: null, features: {}, score: 0
    });
    const accepted = (presenceDay: string | null) => ({
      holdUntil: null, holdReason: null, relocations7dFar: 0, presenceDay, confirmedDaysTarget: 3
    });
    await reports.recordLocationReport(report("relocation", 40, base), accepted(null));
    await reports.recordLocationReport(report("relocation", 45, new Date(base.getTime() + 1000)), accepted(null));
    await reports.recordLocationReport(report("passive", 40, new Date(base.getTime() + 2000)), accepted("2026-10-01"));
    await reports.updateLastFix({
      accountId: newcomer, lat: 40, lon: -105, accuracyM: 10, at: new Date(base.getTime() + 3000),
      presenceDay: "2026-10-01", confirmedDaysTarget: 3
    });
    await reports.recordLocationReport(report("passive", 40, new Date(base.getTime() + DAY_MS)), accepted("2026-10-02"));
    let state = (await pool!.query(
      "SELECT home_lat, confirmed_days, home_confirmed_at FROM account_location_state WHERE account_id = $1",
      [newcomer]
    )).rows[0];
    expect(state).toMatchObject({ home_lat: 40, confirmed_days: 2, home_confirmed_at: null });
    await reports.updateLastFix({
      accountId: newcomer, lat: 40, lon: -105, accuracyM: 10, at: new Date(base.getTime() + 2 * DAY_MS),
      presenceDay: "2026-10-03", confirmedDaysTarget: 3
    });
    state = (await pool!.query(
      "SELECT confirmed_days, home_confirmed_at FROM account_location_state WHERE account_id = $1",
      [newcomer]
    )).rows[0];
    expect(state.confirmed_days).toBe(3);
    expect(state.home_confirmed_at).toEqual(new Date(base.getTime() + 2 * DAY_MS));

    const loaded = await doorway.loadDoorwayPlayer(newcomerPlayer);
    expect(loaded).toMatchObject({ accountId: newcomer, devProfile: false, settled: false, settledHome: null });
    expect(loaded?.lastFix?.at).toEqual(new Date(base.getTime() + 2 * DAY_MS));
  });

  it("sets home from the first passive fix, counts days there, and lets the first relocation replace it once", async () => {
    const reports = new PostgresLocationReportStore(pool!);
    const accountId = randomUUID();
    await pool!.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'new')", [accountId]);
    const base = new Date("2026-10-05T10:00:00.000Z");
    const report = (source: "relocation" | "passive", lat: number, at: Date): LocationReportRow => ({
      id: randomUUID(), accountId, playerId: null, source, requestId: null,
      lat, lon: -105, accuracyM: 10, clientPlatform: "web", deviceInstallationId: null,
      networkHash: null, networkPrefixHash: null, deviceTimeZone: null, receivedAt: at,
      prevReportId: null, distanceM: null, elapsedMs: null, impliedKmh: null, speedBucket: null,
      verdict: "accepted", verdictReason: null, features: {}, score: 0
    });
    const accepted = (presenceDay: string | null) => ({
      holdUntil: null, holdReason: null, relocations7dFar: 0, presenceDay, confirmedDaysTarget: 3
    });
    const home = async () => (await pool!.query(
      "SELECT home_lat, home_source, confirmed_days FROM account_location_state WHERE account_id = $1",
      [accountId]
    )).rows[0];
    await reports.recordLocationReport(report("passive", 30, base), accepted("2026-10-05"));
    expect(await home()).toEqual({ home_lat: 30, home_source: "passive", confirmed_days: 1 });
    await reports.recordLocationReport(report("passive", 35, new Date(base.getTime() + 60_000)), accepted(null));
    expect(await home()).toMatchObject({ home_lat: 30, home_source: "passive" });
    await reports.recordLocationReport(report("relocation", 40, new Date(base.getTime() + 120_000)), accepted(null));
    expect(await home()).toEqual({ home_lat: 40, home_source: "relocation", confirmed_days: 1 });
    await reports.recordLocationReport(report("relocation", 45, new Date(base.getTime() + 180_000)), accepted(null));
    expect(await home()).toMatchObject({ home_lat: 40, home_source: "relocation" });

    // A redundant (unstored) passive fix also sets home when none exists.
    const other = randomUUID();
    await pool!.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'new')", [other]);
    await pool!.query("INSERT INTO account_location_state (account_id) VALUES ($1)", [other]);
    await reports.updateLastFix({
      accountId: other, lat: 33, lon: -105, accuracyM: 10, at: base, presenceDay: "2026-10-05", confirmedDaysTarget: 3
    });
    expect((await pool!.query(
      "SELECT home_lat, home_source, confirmed_days FROM account_location_state WHERE account_id = $1",
      [other]
    )).rows[0]).toEqual({ home_lat: 33, home_source: "passive", confirmed_days: 1 });
  });

  it("links shared devices and network prefixes, and keeps the longest arrival hold", async () => {
    const doorway = new PostgresAltDoorwayStore(pool!);
    const since = new Date(Date.now() - 30 * DAY_MS);
    expect(await doorway.linkedAccounts(veteran, newcomer, since)).toEqual({ device: false, network: false });
    await pool!.query("INSERT INTO device_installations (id, token_hash) VALUES ($1, $2)", [deviceId, randomUUID()]);
    await pool!.query(
      `INSERT INTO auth_events (id, account_id, event_type, network_prefix_hash) VALUES
         ($1, $3, 'google_login_success', 'prefix-a'), ($2, $4, 'google_login_success', 'prefix-a')`,
      [randomUUID(), randomUUID(), veteran, newcomer]
    );
    expect(await doorway.linkedAccounts(veteran, newcomer, since)).toEqual({ device: false, network: true });
    await pool!.query(
      "INSERT INTO account_device_links (account_id, device_installation_id) VALUES ($1, $3), ($2, $3)",
      [veteran, newcomer, deviceId]
    );
    expect(await doorway.linkedAccounts(veteran, newcomer, since)).toEqual({ device: true, network: true });

    const later = new Date(Date.now() + 60 * 60_000);
    await doorway.setArrivalHold(veteranPlayer, later);
    await doorway.setArrivalHold(veteranPlayer, new Date(Date.now() + 60_000));
    expect(await doorway.loadArrivalHold(veteranPlayer)).toEqual(later);

    const flagId = randomUUID();
    await pool!.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1, $2, 'Doorway Test', 40, -105, 1000, ST_SetSRID(ST_MakePoint(-105, 40), 4326))`,
      [flagId, veteranPlayer]
    );
    expect(await doorway.playerOwnsFlag(veteranPlayer, flagId)).toBe(true);
    expect(await doorway.playerOwnsFlag(newcomerPlayer, flagId)).toBe(false);
    expect(await doorway.ownedDestinationPosition(veteranPlayer, { kind: "flag", id: flagId })).toEqual({ lat: 40, lon: -105 });
    expect(await doorway.ownedDestinationPosition(newcomerPlayer, { kind: "flag", id: flagId })).toBeNull();
  });

  it("reads the shared prefix ASN class from fix reports and counts hard mismatch fixes", async () => {
    const doorway = new PostgresAltDoorwayStore(pool!);
    const reports = new PostgresLocationReportStore(pool!);
    const since = new Date(Date.now() - 30 * DAY_MS);
    const row = (accountId: string, features: Record<string, unknown>, receivedAt: Date): LocationReportRow => ({
      id: randomUUID(),
      accountId,
      playerId: null,
      source: "passive",
      requestId: null,
      lat: 40,
      lon: -105,
      accuracyM: 10,
      clientPlatform: "android",
      deviceInstallationId: null,
      networkHash: null,
      networkPrefixHash: "prefix-a",
      deviceTimeZone: null,
      receivedAt,
      prevReportId: null,
      distanceM: null,
      elapsedMs: null,
      impliedKmh: null,
      speedBucket: null,
      verdict: "accepted",
      verdictReason: null,
      features,
      score: 0
    });
    // prefix-a is shared by veteran and newcomer (previous test) but no class is recorded yet.
    expect(await doorway.sharedPrefixAsnClasses(veteran, newcomer, since)).toEqual([null]);
    await reports.recordLocationReport(row(veteran, { ipAsnClass: "fixed" }, new Date(Date.now() - 2 * 60 * 60_000)), null);
    await reports.recordLocationReport(row(newcomer, { ipAsnClass: "mobile" }, new Date()), null);
    expect(await doorway.sharedPrefixAsnClasses(veteran, newcomer, since)).toEqual(["mobile"]);

    const hardSince = new Date(Date.now() - DAY_MS);
    await reports.recordLocationReport(row(veteran, { hardIpMismatch: true }, new Date(Date.now() - 60_000)), null);
    await reports.recordLocationReport(row(veteran, { hardIpMismatch: true }, new Date(Date.now() - 2 * DAY_MS)), null);
    await reports.recordLocationReport(row(veteran, { hardCarrierMismatch: true }, new Date(Date.now() - 120_000)), null);
    expect(await reports.countHardMismatchFixes(veteran, hardSince)).toEqual({ ip: 1, carrier: 1 });
  });
});

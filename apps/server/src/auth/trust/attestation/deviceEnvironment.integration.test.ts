import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../../../db/disposableTestPool.js";
import { runMigrations } from "../../../db/migrate.js";
import { PostgresTrustAdminStore } from "../trustStore.js";
import { DeviceEnvironmentService, PostgresDeviceEnvironmentStore } from "./deviceEnvironment.js";

// Migration 0995 (device environment): populated upgrade, empty second run, and the
// store's install linking, DeviceCheck token keeping, admin view and retention.

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const MIGRATION = "0995_device_environment.sql";
const DAY_MS = 24 * 60 * 60_000;
const T0 = new Date("2026-10-04T12:00:00.000Z");

databaseSuite("device environment migration and store", () => {
  const databaseName = `ash_atlas_stability_device_env_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const accountA = randomUUID();
  const accountB = randomUUID();
  const attestationId = randomUUID();
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
      throw new Error("Device environment tests require a local disposable ash_atlas_stability admin");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-device-env-"));
    const migrations = path.resolve(process.cwd(), "../../db/migrations");
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare("0995_") < 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 8 });
    // Populated fixture on the pre-0995 schema.
    for (const id of [accountA, accountB]) {
      await pool.query("INSERT INTO accounts (id, status, trust_tier, created_at) VALUES ($1, 'active', 'new', $2)", [id, new Date(T0.getTime() - 30 * DAY_MS)]);
    }
    await pool.query(
      `INSERT INTO device_attestations (id, account_id, platform, method, purpose, outcome, assurance, ref_hash, created_at, expires_at)
       VALUES ($1, $2, 'android', 'play_integrity', 'session', 'pass', 'attested', 'ref-hash-1', $3, $4)`,
      [attestationId, accountA, T0, new Date(T0.getTime() + 1800_000)]
    );
    await pool.query(
      "INSERT INTO account_location_state (account_id, last_seq, last_fix_lat, last_fix_lon, last_fix_at) VALUES ($1, 1, 39.74, -104.99, $2)",
      [accountA, T0]
    );
    await copyFile(path.join(migrations, MIGRATION), path.join(directory, MIGRATION));
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([MIGRATION]);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const config = {
    TRUST_ENVIRONMENT_SIGNALS_MODE: "shadow" as const,
    TRUST_ENVIRONMENT_SIGNAL_WEIGHTS: {},
    TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD: 2,
    TRUST_DEVICECHECK_BIT_SET_ENABLED: true,
    TRUST_ATTEST_RETENTION_DAYS: 90
  };

  it("keeps populated rows and has an empty second run", async () => {
    expect((await pool!.query("SELECT count(*)::int AS count FROM device_attestations")).rows[0].count).toBe(1);
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([]);
  });

  it("stores summaries, links accounts on one install, keeps DeviceCheck tokens and shows them to admins", async () => {
    const recorded: Array<{ accountId: string; rules: string[] }> = [];
    const store = new PostgresDeviceEnvironmentStore(pool!);
    const bits = { queryBits: async () => "unset" as const, updateBits: async () => "ok" as const };
    const service = new DeviceEnvironmentService(store, config, {
      now: () => T0,
      deviceCheck: bits,
      sink: { recordSignals: async (input) => { recorded.push({ accountId: input.accountId, rules: input.signals.map((s) => s.rule) }); } }
    });
    const environment = {
      v: 1, installId: "shared-install-0001", installIdPersistent: true, installSource: "sideload",
      simCountryIso: "de", timeZone: "Europe/Berlin", locale: "de_DE", cellMccs: ["262"]
    };
    await service.record({ accountId: accountA, attestationId, platform: "ios", environment, deviceCheckToken: "dG9rZW4=" });
    await service.record({ accountId: accountB, attestationId: randomUUID(), platform: "android", environment });

    const rows = (await pool!.query(
      "SELECT account_id, attestation_id, install_id_hash, sim_country, time_zone_countries, locale_country, gps_countries FROM device_environment_reports ORDER BY account_id = $1 DESC",
      [accountA]
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ attestation_id: attestationId, sim_country: "DE", locale_country: "DE", gps_countries: ["US"] });
    expect(rows[0].time_zone_countries).toContain("DE");
    // An unknown attestation id is stored as NULL, never failing the insert.
    expect(rows[1].attestation_id).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("shared-install");
    expect(JSON.stringify(rows)).not.toContain("Europe/Berlin");
    expect(await store.installAccountCount(rows[0].install_id_hash, new Date(T0.getTime() - DAY_MS))).toBe(2);

    // Account A: sideload + SIM/cell/time-zone country vs its US fix. Account B: no fix, plus the install link.
    expect(recorded[0]).toMatchObject({ accountId: accountA });
    expect(recorded[0]!.rules).toEqual(expect.arrayContaining([
      "env_sideload", "env_sim_country_mismatch", "env_cell_country_mismatch", "env_timezone_country_mismatch"
    ]));
    expect(recorded[0]!.rules).not.toContain("install_multi_account");
    expect(recorded[1]).toEqual({ accountId: accountB, rules: ["env_sideload", "install_multi_account"] });

    expect(await store.loadDeviceCheckToken(accountA, new Date(T0.getTime() - DAY_MS))).toBe("dG9rZW4=");
    await expect(service.markSpoofingLock(accountA)).resolves.toBe("set");

    const detail = await new PostgresTrustAdminStore(pool!).accountDetail(accountA, T0, 7);
    expect(detail?.environments?.[0]).toMatchObject({ platform: "ios", installSource: "sideload", simCountry: "DE" });
    expect(detail?.installLinkedAccounts?.map((linked) => linked.accountId)).toEqual([accountB]);
  });

  it("drops reports and tokens past retention", async () => {
    const store = new PostgresDeviceEnvironmentStore(pool!);
    const later = new DeviceEnvironmentService(store, config, { now: () => new Date(T0.getTime() + 91 * DAY_MS) });
    expect(await later.cleanup()).toBe(3);
    expect((await pool!.query("SELECT count(*)::int AS count FROM device_environment_reports")).rows[0].count).toBe(0);
  });
});

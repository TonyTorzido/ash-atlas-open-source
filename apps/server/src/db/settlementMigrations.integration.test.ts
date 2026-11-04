import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGETS = ["0915_device_attestation.sql", "0916_settled_and_alert_zones.sql"];
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;

(adminUrl ? describe : describe.skip)("Device attestation and Settled migrations (0915, 0916)", () => {
  const migrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_settled_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const accounts = {
    earned: randomUUID(),
    blanket: randomUUID(),
    blanketNoHome: randomUUID(),
    flagged: randomUUID(),
    young: randomUUID(),
    deleted: randomUUID()
  };
  let databaseUrl = "";
  let directory = "";
  let pool: pg.Pool;
  let reportId = "";

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-settled-"));
    for (const name of await readdir(migrations)) {
      if (name.endsWith(".sql") && name.localeCompare(TARGETS[0]!) < 0) {
        await copyFile(path.join(migrations, name), path.join(directory, name));
      }
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });

    // Populated: earned, blanket (home from the last relocation report), blanket
    // with no home, flagged, young, deleted.
    await pool.query(
      `INSERT INTO accounts (id, status, trust_tier, created_at) VALUES
         ($1, 'active', 'standard', now() - interval '60 days'),
         ($2, 'active', 'standard', now() - interval '40 days'),
         ($3, 'active', 'standard', now() - interval '40 days'),
         ($4, 'active', 'standard', now() - interval '40 days'),
         ($5, 'active', 'new', now() - interval '2 days'),
         ($6, 'deleted', 'standard', now() - interval '90 days')`,
      [accounts.earned, accounts.blanket, accounts.blanketNoHome, accounts.flagged, accounts.young, accounts.deleted]
    );
    await pool.query(
      `INSERT INTO account_location_state
         (account_id, home_lat, home_lon, home_set_at, home_source, confirmed_days, home_confirmed_at)
       VALUES
         ($1, 40, -105, now() - interval '30 days', 'relocation', 4, now() - interval '20 days'),
         ($2, NULL, NULL, NULL, NULL, 0, now() - interval '10 days'),
         ($3, NULL, NULL, NULL, NULL, 1, now() - interval '10 days'),
         ($4, 41, -104, now() - interval '30 days', 'relocation', 5, now() - interval '20 days'),
         ($5, 42, -103, now() - interval '1 day', 'passive', 3, now())`,
      [accounts.earned, accounts.blanket, accounts.blanketNoHome, accounts.flagged, accounts.young]
    );
    reportId = randomUUID();
    await pool.query(
      `INSERT INTO location_reports (id, account_id, seq, source, lat, lon, received_at, verdict)
       VALUES ($1, $2, 1, 'relocation', 35.5, -106.5, now() - interval '3 days', 'accepted'),
              ($3, $2, 2, 'relocation', 36.5, -107.5, now() - interval '2 days', 'travel_failed')`,
      [reportId, accounts.blanket, randomUUID()]
    );
    await pool.query(
      `INSERT INTO account_trust_events (id, account_id, kind, rule, weight, logodds_after)
       VALUES ($1, $2, 'signal', 'speed_impossible', 2, 2)`,
      [randomUUID(), accounts.flagged]
    );
    for (const name of TARGETS) await copyFile(path.join(migrations, name), path.join(directory, name));
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("upgrades a populated database, grandfathers by evidence, and reruns empty", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: directory })).resolves.toEqual(TARGETS);

    const report = (await pool.query(
      "SELECT assurance, attestation_id FROM location_reports WHERE id = $1",
      [reportId]
    )).rows[0];
    expect(report).toEqual({ assurance: null, attestation_id: null });

    const rows = new Map((await pool.query<{
      account_id: string; home_lat: number | null; home_lon: number | null;
      settled_home_lat: number | null; settled: boolean; provisional_days: number | null;
      target_checks: number; target_days: number; counted_checks: number;
    }>(
      `SELECT account_id, home_lat, home_lon, settled_home_lat, settled_at IS NOT NULL AS settled,
              round(extract(epoch FROM provisional_until - now()) / 86400)::int AS provisional_days,
              target_checks, target_days, counted_checks
         FROM account_settlement`
    )).rows.map((row) => [row.account_id, row]));

    expect(rows.get(accounts.earned)).toMatchObject({
      home_lat: 40, home_lon: -105, settled_home_lat: 40, settled: true, provisional_days: null, counted_checks: 0
    });
    const earned = rows.get(accounts.earned)!;
    expect(earned.target_checks).toBeGreaterThanOrEqual(22);
    expect(earned.target_checks).toBeLessThanOrEqual(30);
    expect(earned.target_days).toBeGreaterThanOrEqual(4);
    expect(earned.target_days).toBeLessThanOrEqual(6);

    // The 0884 blanket backfill: provisional for 30 days, halved targets, home
    // from the last applied relocation (the failed one is ignored).
    const blanket = rows.get(accounts.blanket)!;
    expect(blanket).toMatchObject({ home_lat: 35.5, home_lon: -106.5, settled_home_lat: 35.5, settled: true, provisional_days: 30 });
    expect(blanket.target_checks).toBeGreaterThanOrEqual(11);
    expect(blanket.target_checks).toBeLessThanOrEqual(15);
    expect(blanket.target_days).toBeGreaterThanOrEqual(2);
    expect(blanket.target_days).toBeLessThanOrEqual(3);

    for (const id of [accounts.blanketNoHome, accounts.flagged, accounts.young]) {
      expect(rows.get(id)).toMatchObject({ settled: false, settled_home_lat: null, provisional_days: null });
    }
    expect(rows.get(accounts.flagged)).toMatchObject({ home_lat: 41 });
    expect(rows.has(accounts.deleted)).toBe(false);

    for (const table of ["attestation_challenges", "app_attest_keys", "device_attestations", "trust_alerts", "trust_arrivals"]) {
      await expect(pool.query(`SELECT count(*)::int AS count FROM ${table}`)).resolves.toMatchObject({ rows: [{ count: 0 }] });
    }
    await expect(pool.query(
      "UPDATE account_location_state SET last_fix_assurance = 'bogus' WHERE account_id = $1",
      [accounts.earned]
    )).rejects.toThrow();
    const alert = () => pool.query(
      "INSERT INTO trust_alerts (id, account_id, kind, severity) VALUES ($1, $2, 'zone_red', 3)",
      [randomUUID(), accounts.young]
    );
    await alert();
    await expect(alert()).rejects.toThrow();

    await expect(runMigrations(databaseUrl, { migrationsDirectory: directory })).resolves.toEqual([]);
  });
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || parsed.port === "35432"
    || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) throw new Error("Settled migration verification requires a disposable local database");
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe disposable database name");
  return `"${value}"`;
}

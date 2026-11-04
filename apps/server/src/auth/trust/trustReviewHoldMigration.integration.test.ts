import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const MIGRATION = "0996_trust_review_hold_and_alert_kinds.sql";

databaseSuite("0996 review hold and alert kinds migration", () => {
  const databaseName = `ash_atlas_stability_review_hold_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const settled = randomUUID();
  const alertId = randomUUID();
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let directory = "";
  let databaseUrl = "";

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/ash_atlas_stability") {
      throw new Error("Migration tests require a local disposable ash_atlas_stability admin");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-review-hold-"));
    const migrations = path.resolve(process.cwd(), "../../db/migrations");
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare(MIGRATION) < 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    // Populated: a Settled account and a pending red alert.
    await pool.query(`INSERT INTO accounts (id, status, trust_tier, created_at) VALUES ($1, 'active', 'standard', now() - interval '90 days')`, [settled]);
    await pool.query(
      `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon, target_checks,
         target_days, settled_at, provisional_until)
       VALUES ($1, 39.7, -105, 39.7, -105, 25, 5, now() - interval '10 days', now() + interval '5 days')`,
      [settled]
    );
    await pool.query(
      `INSERT INTO trust_alerts (id, account_id, kind, severity, status) VALUES ($1, $2, 'zone_red', 3, 'pending')`,
      [alertId, settled]
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

  it("keeps existing rows, accepts the new states and has an empty second run", async () => {
    const before = await pool!.query<{ settled: boolean; suspended: Date | null }>(
      "SELECT settled_at IS NOT NULL AS settled, suspended_settled_at AS suspended FROM account_settlement WHERE account_id = $1",
      [settled]
    );
    expect(before.rows[0]).toEqual({ settled: true, suspended: null });
    expect((await pool!.query("SELECT 1 FROM trust_alerts WHERE id = $1", [alertId])).rowCount).toBe(1);

    await pool!.query(
      `UPDATE account_settlement
          SET suspended_settled_at = settled_at, suspended_provisional_until = provisional_until, suspended_alert_id = $2,
              settled_at = NULL, provisional_until = NULL, unsettle_reason = 'review_hold', unsettled_at = now()
        WHERE account_id = $1`,
      [settled, alertId]
    );
    for (const kind of ["kingdom_proximity", "multi_account", "account_shared", "state_hopping"]) {
      await pool!.query(
        "INSERT INTO trust_alerts (id, account_id, kind, severity, status) VALUES ($1, $2, $3, 3, 'pending')",
        [randomUUID(), settled, kind]
      );
    }
    // A hold always pauses Settled: suspended_settled_at with settled_at set is refused.
    await expect(pool!.query(
      "UPDATE account_settlement SET settled_at = now() WHERE account_id = $1",
      [settled]
    )).rejects.toThrow(/account_settlement_review_hold_check/u);
    await expect(pool!.query(
      "INSERT INTO trust_alerts (id, account_id, kind, severity, status) VALUES ($1, $2, 'not_a_kind', 1, 'pending')",
      [randomUUID(), settled]
    )).rejects.toThrow(/trust_alerts_kind_check/u);

    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([]);
  });
});

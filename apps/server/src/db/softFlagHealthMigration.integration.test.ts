import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1156_soft_flag_health.sql";

describeDatabase("soft flag reference health populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_soft_flag_hp_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let migrationDirectory = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  const owner = `softflag-${suffix}`;
  const fullFlag = randomUUID();
  const hurtFlag = randomUUID();
  const stoneFlag = randomUUID();

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-soft-flag-hp-"));
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION).sort()) {
      await copyFile(path.join(migrations, name), path.join(migrationDirectory, name));
    }
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter')
       THEN CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN; END IF; END $$`
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });

    const accountId = randomUUID();
    await pool.query(`INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')`, [accountId]);
    await pool.query(
      `INSERT INTO players (id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
       VALUES ($1,$2,$1,$1,'#38bdf8','GLOBAL',35,-106,35,-106,650,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [owner, accountId]
    );
    for (const [id, lon, level] of [[fullFlag, -106.1, 0], [hurtFlag, -106.2, 0], [stoneFlag, -106.3, 1]] as const) {
      await pool.query(
        `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, reinforcement_level)
         VALUES ($1::uuid,$2,$1::text,35,$3::double precision,50,ST_SetSRID(ST_MakePoint($3::double precision,35),4326),$4)`,
        [id, owner, lon, level]
      );
    }
    await pool.query("UPDATE flags SET health = 60 WHERE id = $1", [hurtFlag]);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  }, 60_000);

  it("raises soft flags to 220 max HP, raises current HP in proportion, leaves stone flags, and is a no-op when replayed", async () => {
    expect(await healths()).toEqual([[100, 100], [60, 100], [200, 200]]);
    await copyFile(path.join(migrations, TARGET_MIGRATION), path.join(migrationDirectory, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory })).resolves.toEqual([TARGET_MIGRATION]);
    const after = await healths();
    expect(after).toEqual([[220, 220], [132, 220], [220, 220]]);

    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory })).resolves.toEqual([]);
    await pool.query(await readFile(path.join(migrations, TARGET_MIGRATION), "utf8"));
    expect(await healths()).toEqual(after);
    // A 14 s burn operation is now accepted by the duration constraint.
    await expect(pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='flag_burn_operations_duration_check'`
    )).resolves.toMatchObject({ rows: [{ def: expect.stringContaining("14000") }] });
  }, 120_000);

  async function healths() {
    const result = await pool.query<{ id: string; health: number; maximum_health: number }>(
      "SELECT id, health, maximum_health FROM flags WHERE id = ANY($1::uuid[])",
      [[fullFlag, hurtFlag, stoneFlag]]
    );
    const byId = new Map(result.rows.map((row) => [row.id, [row.health, row.maximum_health]]));
    return [fullFlag, hurtFlag, stoneFlag].map((id) => byId.get(id));
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("admin URL must be PostgreSQL");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Soft flag migration test requires a loopback admin database");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("Soft flag migration test requires a disposable ash_atlas_stability admin database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

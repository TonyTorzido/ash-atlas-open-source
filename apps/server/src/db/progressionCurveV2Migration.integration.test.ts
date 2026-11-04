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
const TARGET_MIGRATION = "0719_progression_curve_v2.sql";

describeDatabase("Progression Curve V2 migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_progression_v2_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const fixtures = [
    ["zero", 0, 0],
    ["below-one", 799, 0],
    ["one", 800, 1],
    ["two", 2_464, 2],
    ["twelve", 100_000, 12],
    ["cap", 500_000, 25]
  ] as const;
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-progression-v2-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    for (const [label, totalXp] of fixtures) {
      const playerId = `progression-v2-${label}-${suffix}`;
      const accountId = randomUUID();
      await pool.query(
        `INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')`,
        [accountId]
      );
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,username_normalized,display_color,region_code,
           lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
         ) VALUES (
           $1,$2,$1,$1,'#38bdf8','NM',35,-106,35,-106,900,false,
           ST_SetSRID(ST_MakePoint(-106,35),4326)
         )`,
        [playerId, accountId]
      );
      await pool.query(
        `INSERT INTO player_progression_profiles (
           player_id,total_xp,level,curve_version,persistence_version
         ) VALUES ($1,$2,0,1,7)
         ON CONFLICT (player_id) DO UPDATE
         SET total_xp=EXCLUDED.total_xp,level=0,curve_version=1,persistence_version=7`,
        [playerId, totalXp]
      );
    }
    const operationId = randomUUID();
    const playerId = `progression-v2-twelve-${suffix}`;
    await pool.query(
      `INSERT INTO xp_operations (
         operation_id,operation_key,player_id,source_type,source_id,
         requested_xp,granted_xp,discarded_xp,previous_xp,resulting_xp,
         previous_level,resulting_level,replay_result,metadata
       ) VALUES (
         $1,$2,$3,'combat','retained-settlement',100000,100000,0,0,100000,
         0,11,$4::jsonb,'{"retained":true}'::jsonb
       )`,
      [
        operationId,
        `progression-v2-retained-${suffix}`,
        playerId,
        JSON.stringify({ grantedXp: 100_000, progression: { level: 11, curveVersion: 1 } })
      ]
    );
    await pool.query(
      `INSERT INTO xp_events (
         operation_id,operation_key,player_id,event_type,xp_delta,
         resulting_xp,resulting_level,metadata
       ) VALUES ($1,$2,$3,'xp_granted',100000,100000,11,'{"retained":true}'::jsonb)`,
      [operationId, `progression-v2-retained-${suffix}`, playerId]
    );
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("reprojects levels without changing XP or historical ledgers", async () => {
    const beforeHistory = await historySnapshot();
    await copyFile(
      path.join(migrations, TARGET_MIGRATION),
      path.join(precedingMigrations, TARGET_MIGRATION)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations }))
      .resolves.toContain(TARGET_MIGRATION);
    const rows = await pool.query<{
      player_id: string;
      total_xp: number;
      level: number;
      curve_version: number;
    }>(
      `SELECT player_id,total_xp,level,curve_version
       FROM player_progression_profiles
       WHERE player_id LIKE $1
       ORDER BY total_xp,player_id`,
      [`progression-v2-%-${suffix}`]
    );
    expect(rows.rows.map((row) => [row.total_xp, row.level, row.curve_version]))
      .toEqual(fixtures.map(([, totalXp, level]) => [totalXp, level, 2]));
    await expect(historySnapshot()).resolves.toEqual(beforeHistory);
  }, 90_000);

  it("is mutation-idempotent and defaults new profiles to Curve V2", async () => {
    const before = await profileSnapshot();
    const sql = await readFile(path.join(migrations, TARGET_MIGRATION), "utf8");
    await pool.query(sql);
    await expect(profileSnapshot()).resolves.toEqual(before);
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations }))
      .resolves.toEqual([]);

    const playerId = `progression-v2-new-${suffix}`;
    const accountId = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,$1,$1,'#38bdf8','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [playerId, accountId]
    );
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id) VALUES ($1)
       ON CONFLICT (player_id) DO NOTHING`,
      [playerId]
    );
    await expect(pool.query(
      `SELECT curve_version FROM player_progression_profiles WHERE player_id=$1`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ curve_version: 2 }] });
  });

  async function historySnapshot(): Promise<unknown> {
    return (await pool.query(
      `SELECT
         (SELECT jsonb_agg(to_jsonb(operation) ORDER BY operation.operation_key)
          FROM (
            SELECT operation_key,requested_xp,granted_xp,discarded_xp,
                   previous_xp,resulting_xp,previous_level,resulting_level,
                   replay_result,metadata
            FROM xp_operations
            WHERE operation_key=$1
          ) operation) AS operations,
         (SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
          FROM (
            SELECT id,operation_key,event_type,xp_delta,resulting_xp,
                   resulting_level,metadata
            FROM xp_events
            WHERE operation_key=$1
          ) event) AS events`,
      [`progression-v2-retained-${suffix}`]
    )).rows[0];
  }

  async function profileSnapshot(): Promise<unknown[]> {
    return (await pool.query(
      `SELECT player_id,total_xp,level,curve_version,persistence_version,updated_at
       FROM player_progression_profiles
       WHERE player_id LIKE $1
       ORDER BY player_id`,
      [`progression-v2-%-${suffix}`]
    )).rows;
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !database.startsWith("ash_atlas_stability")
  ) {
    throw new Error("Progression migration tests require a local stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

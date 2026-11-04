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
const PREVIOUS_MIGRATION = "0731_profession_perks_v2_oil_worker.sql";
const TARGET_MIGRATION = "0732_progression_curve_v3.sql";

describeDatabase("Progression Curve V3 migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_progression_v3_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const fixtures = [
    ["zero", 0, 0, 0],
    ["below-one", 799, 0, 7_185],
    ["one", 800, 1, 7_194],
    ["half-one", 1_632, 1, 11_232],
    ["two", 2_464, 2, 15_270],
    ["twelve", 100_000, 12, 196_687],
    ["near-cap", 499_999, 24, 999_998],
    ["cap", 500_000, 25, 1_000_000]
  ] as const;
  let migrationDirectory = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-progression-v3-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name <= PREVIOUS_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(migrationDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });

    for (const [label, totalXp, level] of fixtures) {
      const playerId = `progression-v3-${label}-${suffix}`;
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
         ) VALUES ($1,$2,$3,2,7)
         ON CONFLICT (player_id) DO UPDATE
         SET total_xp=EXCLUDED.total_xp,level=EXCLUDED.level,
             curve_version=2,persistence_version=7`,
        [playerId, totalXp, level]
      );
      if (totalXp > 0) {
        const operationId = randomUUID();
        await pool.query(
          `INSERT INTO xp_operations (
             operation_id,operation_key,player_id,source_type,source_id,
             requested_xp,granted_xp,discarded_xp,previous_xp,resulting_xp,
             previous_level,resulting_level,replay_result,metadata
           ) VALUES ($1,$2,$3,'combat','fixture',$4,$4,0,0,$4,0,$5,$6::jsonb,'{}')`,
          [
            operationId,
            `progression-v3-fixture-${label}-${suffix}`,
            playerId,
            totalXp,
            level,
            JSON.stringify({ grantedXp: totalXp, progression: { level, curveVersion: 2 } })
          ]
        );
      }
    }
    const combinedPlayerId = `progression-v3-zero-${suffix}`;
    await pool.query(
      `INSERT INTO player_profession_progress (
         player_id,profession_id,xp,rank,curve_version,completed_at
       ) VALUES
         ($1,'woodcutter',100000,8,2,'2026-01-01T00:00:00Z'),
         ($1,'miner',48056,6,2,NULL),
         ($1,'builder',21152,4,2,NULL),
         ($1,'hunter',69795,7,2,NULL),
         ($1,'oil_worker',17449,7,2,NULL)`,
      [combinedPlayerId]
    );
    await pool.query(
      `INSERT INTO player_mastery_achievements (
         player_id,achievement_id,title,badge_id,completed_at
       ) VALUES (
         $1,'master_woodcutter','Master Woodcutter','master_woodcutter','2026-01-01T00:00:00Z'
       )`,
      [combinedPlayerId]
    );
    await pool.query(
      `INSERT INTO player_mastery_state (player_id,equipped_title)
       VALUES ($1,'Master Woodcutter')`,
      [combinedPlayerId]
    );
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("preserves level fraction and records one exact ledger adjustment", async () => {
    const historyBefore = await historySnapshot();
    const professionBefore = await professionSnapshot();
    await copyFile(
      path.join(migrations, TARGET_MIGRATION),
      path.join(migrationDirectory, TARGET_MIGRATION)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    const rows = await pool.query<{
      player_id: string;
      total_xp: number;
      level: number;
      curve_version: number;
      ledger_xp: string;
      adjustment_count: string;
    }>(
      `SELECT profile.player_id,profile.total_xp,profile.level,profile.curve_version,
              (COALESCE(operation.granted_xp,0)+COALESCE(adjustment.xp_delta,0))::text AS ledger_xp,
              COALESCE(adjustment.adjustment_count,0)::text AS adjustment_count
       FROM player_progression_profiles AS profile
       LEFT JOIN (
         SELECT player_id,sum(granted_xp)::bigint AS granted_xp
         FROM xp_operations GROUP BY player_id
       ) AS operation USING (player_id)
       LEFT JOIN (
         SELECT player_id,sum(xp_delta)::bigint AS xp_delta,count(*) AS adjustment_count
         FROM character_xp_curve_adjustments GROUP BY player_id
       ) AS adjustment USING (player_id)
       WHERE profile.player_id LIKE $1
       ORDER BY profile.total_xp,profile.player_id`,
      [`progression-v3-%-${suffix}`]
    );
    expect(rows.rows.map((row) => [
      row.total_xp, row.level, row.curve_version, Number(row.ledger_xp),
      Number(row.adjustment_count)
    ])).toEqual(fixtures.map(([, , level, resultingXp]) => [
      resultingXp, level, 3, resultingXp, 1
    ]));
    await expect(historySnapshot()).resolves.toEqual(historyBefore);
    await expect(professionSnapshot()).resolves.toEqual(professionBefore);
  }, 90_000);

  it("is mutation-idempotent, expands durable caps, and defaults new profiles to V3", async () => {
    const before = await profileAndAdjustmentSnapshot();
    const sql = await readFile(path.join(migrations, TARGET_MIGRATION), "utf8");
    await pool.query(sql);
    await expect(profileAndAdjustmentSnapshot()).resolves.toEqual(before);
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([]);

    const playerId = `progression-v3-new-${suffix}`;
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
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
      "INSERT INTO player_progression_profiles (player_id) VALUES ($1)",
      [playerId]
    );
    const profile = await pool.query<{ curve_version: number }>(
      "SELECT curve_version FROM player_progression_profiles WHERE player_id=$1",
      [playerId]
    );
    expect(profile.rows).toEqual([{ curve_version: 3 }]);

    await expect(pool.query(
      `INSERT INTO xp_operations (
         operation_id,operation_key,player_id,source_type,source_id,
         requested_xp,granted_xp,discarded_xp,previous_xp,resulting_xp,
         previous_level,resulting_level,replay_result,metadata
       ) VALUES ($1,$2,$3,'combat','cap-proof',1,1,0,900000,900001,24,24,'{}','{}')`,
      [randomUUID(), `progression-v3-cap-proof-${suffix}`, playerId]
    )).resolves.toMatchObject({ rowCount: 1 });
  }, 90_000);

  it("refuses an unknown retained curve version without changing profiles", async () => {
    const playerId = `progression-v3-one-${suffix}`;
    await pool.query(
      "UPDATE player_progression_profiles SET curve_version=4 WHERE player_id=$1",
      [playerId]
    );
    const before = await profileAndAdjustmentSnapshot();
    const sql = await readFile(path.join(migrations, TARGET_MIGRATION), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/unsupported retained curve version/i);
    await expect(profileAndAdjustmentSnapshot()).resolves.toEqual(before);
    await pool.query(
      "UPDATE player_progression_profiles SET curve_version=3 WHERE player_id=$1",
      [playerId]
    );
  }, 90_000);

  async function historySnapshot(): Promise<unknown[]> {
    return (await pool.query(
      `SELECT operation_key,requested_xp,granted_xp,discarded_xp,previous_xp,
              resulting_xp,previous_level,resulting_level,replay_result,metadata
       FROM xp_operations
       WHERE player_id LIKE $1
       ORDER BY operation_key`,
      [`progression-v3-%-${suffix}`]
    )).rows;
  }

  async function profileAndAdjustmentSnapshot(): Promise<unknown> {
    return (await pool.query(
      `SELECT
         (SELECT jsonb_agg(to_jsonb(profile) ORDER BY profile.player_id)
          FROM (
            SELECT player_id,total_xp,level,curve_version,persistence_version,updated_at
            FROM player_progression_profiles WHERE player_id LIKE $1
          ) AS profile) AS profiles,
         (SELECT jsonb_agg(to_jsonb(adjustment) ORDER BY adjustment.player_id)
          FROM (
            SELECT operation_key,player_id,from_curve_version,to_curve_version,
                   previous_xp,resulting_xp,xp_delta,previous_level,resulting_level,created_at
            FROM character_xp_curve_adjustments WHERE player_id LIKE $1
          ) AS adjustment) AS adjustments`,
      [`progression-v3-%-${suffix}`]
    )).rows[0];
  }

  async function professionSnapshot(): Promise<unknown> {
    return (await pool.query(
      `SELECT
         (SELECT jsonb_agg(to_jsonb(progress) ORDER BY progress.profession_id)
          FROM (
            SELECT profession_id,xp,rank,curve_version,completed_at
            FROM player_profession_progress
            WHERE player_id=$1
          ) AS progress) AS professions,
         (SELECT jsonb_agg(to_jsonb(achievement) ORDER BY achievement.achievement_id)
          FROM (
            SELECT achievement_id,title,badge_id,completed_at
            FROM player_mastery_achievements
            WHERE player_id=$1
          ) AS achievement) AS achievements,
         (SELECT to_jsonb(state)
          FROM (
            SELECT equipped_title FROM player_mastery_state WHERE player_id=$1
          ) AS state) AS mastery_state`,
      [`progression-v3-zero-${suffix}`]
    )).rows[0];
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

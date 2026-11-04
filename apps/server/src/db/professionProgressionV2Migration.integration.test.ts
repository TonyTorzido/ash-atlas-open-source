import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";
import { MasteryService } from "../game/masteries.js";

const TARGET_MIGRATION = "0730_profession_progression_v2.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Profession Progression V2 migration", () => {
  const databaseName = `ash_atlas_stability_profession_v2_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-profession-v2-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedPlayer("profession-partial");
    await seedPlayer("profession-mastered");
    await pool.query(
      `INSERT INTO player_profession_progress (player_id,profession_id,xp,rank,completed_at)
       VALUES
         ('profession-partial','woodcutter',31,0,NULL),
         ('profession-partial','miner',250,2,NULL),
         ('profession-partial','builder',1281,4,NULL),
         ('profession-partial','hunter',3532,7,NULL),
         ('profession-mastered','woodcutter',4000,8,'2026-01-01T00:00:00Z'),
         ('profession-mastered','miner',4000,8,'2026-01-02T00:00:00Z'),
         ('profession-mastered','builder',4000,8,'2026-01-03T00:00:00Z'),
         ('profession-mastered','hunter',4000,8,'2026-01-04T00:00:00Z')`
    );
    await pool.query(
      `INSERT INTO player_mastery_achievements (
         player_id,achievement_id,title,badge_id,completed_at
       ) VALUES (
         'profession-mastered','master_hunter','Master Hunter','master_hunter','2026-01-04T00:00:00Z'
       )`
    );
    await pool.query(
      `INSERT INTO player_mastery_state (player_id,equipped_title)
       VALUES ('profession-mastered','Master Hunter')
       ON CONFLICT (player_id) DO UPDATE SET equipped_title=EXCLUDED.equipped_title`
    );
    await pool.query(
      `INSERT INTO mastery_progression_operations (
         operation_key,player_id,profession_id,source_type,source_id,
         requested_xp,granted_xp,previous_xp,resulting_xp,previous_rank,resulting_rank,result
       ) VALUES (
         'legacy-profession-operation','profession-partial','woodcutter','harvest','tree-1',
         31,31,0,31,0,0,'{}'::jsonb
       )`
    );
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  }, 30_000);

  it("preserves rank-relative progress, mastery metadata, and append-only history", async () => {
    await copyFile(path.join(migrations, TARGET_MIGRATION), path.join(precedingMigrations, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([TARGET_MIGRATION]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([]);

    const partial = await pool.query<{
      profession_id: string; xp: number; rank: number; curve_version: number;
    }>(
      `SELECT profession_id,xp,rank,curve_version
       FROM player_profession_progress
       WHERE player_id='profession-partial'
       ORDER BY profession_id`
    );
    expect(partial.rows).toEqual([
      { profession_id: "builder", xp: 26_772, rank: 4, curve_version: 2 },
      { profession_id: "hunter", xp: 84_914, rank: 7, curve_version: 2 },
      { profession_id: "miner", xp: 7_218, rank: 2, curve_version: 2 },
      { profession_id: "woodcutter", xp: 1_487, rank: 0, curve_version: 2 }
    ]);

    const mastered = await pool.query<{
      profession_id: string; xp: number; rank: number; completed_at: Date | string | null;
    }>(
      `SELECT profession_id,xp,rank,completed_at
       FROM player_profession_progress
       WHERE player_id='profession-mastered'
       ORDER BY profession_id`
    );
    expect(mastered.rows.every((row) =>
      row.xp === 100_000 && row.rank === 8 && row.completed_at !== null
    )).toBe(true);
    expect(mastered.rows).toHaveLength(4);
    expect((await pool.query(
      `SELECT equipped_title FROM player_mastery_state WHERE player_id='profession-mastered'`
    )).rows[0]?.equipped_title).toBe("Master Hunter");
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM player_mastery_achievements
       WHERE player_id='profession-mastered'`
    )).rows[0]?.count).toBe(4);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM mastery_progression_operations
       WHERE operation_key LIKE 'profession-curve-v2:%'`
    )).rows[0]?.count).toBe(8);
    expect((await pool.query(
      `SELECT requested_xp,resulting_xp,policy_id
       FROM mastery_progression_operations WHERE operation_key='legacy-profession-operation'`
    )).rows[0]).toEqual({ requested_xp: 31, resulting_xp: 31, policy_id: null });

    await runMigrations(databaseUrl);
    const legacyReplay = await new MasteryService(pool).grantProfessionXp({
      operationKey: "legacy-profession-operation",
      playerId: "profession-partial",
      sourceId: "tree-1",
      activity: { kind: "wood-harvest" }
    });
    expect(legacyReplay.replayed).toBe(true);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM mastery_progression_operations
       WHERE operation_key='legacy-profession-operation'`
    )).rows[0]?.count).toBe(1);
  }, 90_000);

  async function seedPlayer(playerId: string): Promise<void> {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         $1,$1,'profession-test',0,0,0,0,1250,false,
         ST_SetSRID(ST_MakePoint(0,0),4326)
       )`,
      [playerId]
    );
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Profession migration tests require a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

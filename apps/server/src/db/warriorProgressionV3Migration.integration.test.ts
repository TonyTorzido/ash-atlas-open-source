import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET = "0733_warrior_progression_v3.sql";
const adminUrl = process.env.WARRIOR_V3_MIGRATION_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Warrior Progression V3 populated migration", () => {
  const databaseName = `ash_atlas_stability_warrior_v3_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const migrations = path.resolve(process.cwd(), "../../db/migrations");
  let prefix = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposable(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    prefix = await mkdtemp(path.join(tmpdir(), "ash-atlas-warrior-v3-"));
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < TARGET).sort()) {
      await copyFile(path.join(migrations, name), path.join(prefix, name));
    }
    await admin.query(`CREATE DATABASE ${quote(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: prefix });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 3 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (prefix) await rm(prefix, { recursive: true, force: true });
  });

  it("projects historical and current rows, preserves separate tracks, and replays empty", async () => {
    const ids = ["fresh", "historical-mid", "historical-master", "current-max", "current-inconsistent"];
    await pool.query(`
      INSERT INTO players (id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
      SELECT id,id,'NM',35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326)
      FROM unnest($1::text[]) AS id`, [ids]);
    await pool.query(`
      INSERT INTO player_class_progress
        (player_id,class_id,mastery_xp,mastery_rank,training_points_earned,training_points_spent,completed_at)
      VALUES
        ('fresh','warrior',0,0,0,0,NULL),
        ('historical-mid','warrior',100000,10,0,0,NULL),
        ('historical-master','warrior',200000,15,0,0,now()),
        ('current-max','warrior',38000,15,0,0,NULL),
        ('current-inconsistent','warrior',38000,15,0,0,NULL)`);
    await pool.query(`
      INSERT INTO class_progression_operations
        (operation_key,player_id,class_id,subclass_id,requested_xp,granted_xp,previous_rank,resulting_rank,result,created_at)
      VALUES
        ('current-max-op','current-max','warrior',NULL,38000,38000,0,15,'{}',now()),
        ('current-inconsistent-op','current-inconsistent','warrior',NULL,38000,38000,0,15,'{}',now())`);
    await pool.query(`
      INSERT INTO player_mastery_achievements (player_id,achievement_id,title,badge_id)
      VALUES ('historical-master','master_warrior','Master Warrior','master_warrior');
      INSERT INTO player_mastery_state (player_id,equipped_title)
      VALUES ('historical-master','Master Warrior');
      INSERT INTO player_progression_profiles (player_id,total_xp,level,curve_version)
      VALUES ('historical-mid',150791,11,3);
      INSERT INTO player_profession_progress (player_id,profession_id,xp,rank,curve_version)
      VALUES ('historical-mid','hunter',7218,2,2),('historical-mid','oil_worker',1804,2,2)`);

    await copyFile(path.join(migrations, TARGET), path.join(prefix, TARGET));
    expect(await runMigrations(databaseUrl, { migrationsDirectory: prefix })).toEqual([TARGET]);
    expect(await runMigrations(databaseUrl, { migrationsDirectory: prefix })).toEqual([]);

    const warrior = await pool.query<{ player_id: string; mastery_xp: number; mastery_rank: number; curve_version: number }>(
      `SELECT player_id,mastery_xp,mastery_rank,curve_version FROM player_class_progress
       WHERE class_id='warrior' ORDER BY player_id`
    );
    expect(warrior.rows).toEqual([
      { player_id: "current-inconsistent", mastery_xp: 72000, mastery_rank: 15, curve_version: 3 },
      { player_id: "current-max", mastery_xp: 72000, mastery_rank: 15, curve_version: 3 },
      { player_id: "fresh", mastery_xp: 0, mastery_rank: 0, curve_version: 3 },
      { player_id: "historical-master", mastery_xp: 72000, mastery_rank: 15, curve_version: 3 },
      { player_id: "historical-mid", mastery_xp: 36000, mastery_rank: 11, curve_version: 3 }
    ]);
    expect((await pool.query(`SELECT count(*)::int AS count FROM warrior_xp_curve_adjustments`)).rows[0]?.count).toBe(5);
    expect((await pool.query(
      `SELECT player_id,from_curve_version,source_max_xp FROM warrior_xp_curve_adjustments
       WHERE player_id IN ('current-max','historical-mid') ORDER BY player_id`
    )).rows).toEqual([
      { player_id: "current-max", from_curve_version: 2, source_max_xp: 38000 },
      { player_id: "historical-mid", from_curve_version: 1, source_max_xp: 200000 }
    ]);
    expect((await pool.query(`SELECT total_xp,level,curve_version FROM player_progression_profiles WHERE player_id='historical-mid'`)).rows[0])
      .toEqual({ total_xp: 150791, level: 11, curve_version: 3 });
    expect((await pool.query(`SELECT profession_id,xp,rank FROM player_profession_progress WHERE player_id='historical-mid' ORDER BY profession_id`)).rows)
      .toEqual([{ profession_id: "hunter", xp: 7218, rank: 2 }, { profession_id: "oil_worker", xp: 1804, rank: 2 }]);
    expect((await pool.query(`SELECT equipped_title FROM player_mastery_state WHERE player_id='historical-master'`)).rows[0]?.equipped_title)
      .toBe("Master Warrior");
  }, 120_000);
});

function requireDisposable(value: string): URL {
  const parsed = new URL(value);
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("Warrior V3 migration test requires an ash_atlas_stability admin database");
  }
  return parsed;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

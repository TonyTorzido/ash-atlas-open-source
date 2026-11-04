import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0847_fishing_unresolved_water_ids.sql";
const adminUrl = process.env.FISHING_UNRESOLVED_WATER_IDS_MIGRATION_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("fishing unresolved water ID migration", () => {
  const databaseName = `ash_atlas_stability_fishing_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-fishing-unresolved-"));
    for (const name of (await readdir(repoMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(repoMigrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  }, 30_000);

  it("preserves prior fishing rows and is empty on the second run", async () => {
    const hutId = randomUUID();
    const encounterId = randomUUID();
    const catchId = randomUUID();
    await pool.query(`
      INSERT INTO players (
        id,username,region_code,lat,lon,anchor_lat,anchor_lon,
        move_leash_radius_m,online,geom
      ) VALUES ('migration-fishing-player','migration-fishing-player','NM',35,-106,35,-106,900,false,
        ST_SetSRID(ST_MakePoint(-106,35),4326))`);
    await pool.query(
      `INSERT INTO player_fishing_huts (
         fishing_hut_id,owner_player_id,world_id,region_code,lat,lon,geom,
         waterbody_kind,waterbody_source_id,waterbody_name,waterbody_distance_m
       ) VALUES ($1,'migration-fishing-player','migration-world','NM',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),'lake','lake-preserved','Mirror Lake',50)`
      , [hutId]
    );
    await pool.query(
      `INSERT INTO fishing_encounters (
         encounter_id,player_id,fishing_hut_id,waterbody_kind,waterbody_source_id,
         waterbody_name,phase,behavior_profile,seed,difficulty,bite_at,reconnect_deadline_at
       ) VALUES ($1,'migration-fishing-player',$2,'lake','lake-preserved','Mirror Lake',
         'landed','runner',7,0.4,clock_timestamp(),clock_timestamp())`,
      [encounterId, hutId]
    );
    await pool.query(
      `INSERT INTO fishing_catch_records (
         catch_id,encounter_id,player_id,fishing_hut_id,waterbody_kind,
         waterbody_source_id,waterbody_name,fish_item_id,behavior_profile,
         difficulty,length_in,weight_lb,score,duration_ms,week_start
       ) VALUES ($1,$2,'migration-fishing-player',$3,'lake','lake-preserved',
         'Mirror Lake','freshwater_fish','runner',0.4,3.2,1.1,100,1000,current_date)`,
      [catchId, encounterId, hutId]
    );

    const before = await retainedFishingRows(pool, encounterId, catchId);
    await copyFile(path.join(repoMigrations, TARGET_MIGRATION), path.join(precedingMigrations, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations }))
      .resolves.toEqual([TARGET_MIGRATION]);
    await expect(retainedFishingRows(pool, encounterId, catchId)).resolves.toEqual(before);

    const nullability = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name,column_name,is_nullable
       FROM information_schema.columns
       WHERE table_schema='public'
         AND ((table_name='fishing_encounters' AND column_name IN ('waterbody_source_id','waterbody_name'))
           OR (table_name='fishing_catch_records' AND column_name='waterbody_source_id'))
       ORDER BY table_name,column_name`
    );
    expect(nullability.rows).toEqual([
      { table_name: "fishing_catch_records", column_name: "waterbody_source_id", is_nullable: "YES" },
      { table_name: "fishing_encounters", column_name: "waterbody_name", is_nullable: "YES" },
      { table_name: "fishing_encounters", column_name: "waterbody_source_id", is_nullable: "YES" }
    ]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([]);
  }, 120_000);
});

async function retainedFishingRows(pool: pg.Pool, encounterId: string, catchId: string): Promise<unknown> {
  const encounters = await pool.query(
    `SELECT encounter_id,waterbody_kind,waterbody_source_id,waterbody_name,
            canonical_waterbody_id,gameplay_water_type,canonical_display_name,
            waterbody_resolution_state,presentation_name,presentation_relation
     FROM fishing_encounters WHERE encounter_id=$1`,
    [encounterId]
  );
  const catches = await pool.query(
    `SELECT catch_id,encounter_id,waterbody_kind,waterbody_source_id,waterbody_name,
            canonical_waterbody_id,gameplay_water_type,canonical_display_name,
            waterbody_resolution_state,presentation_name,presentation_relation
     FROM fishing_catch_records WHERE catch_id=$1`,
    [catchId]
  );
  return { encounters: encounters.rows, catches: catches.rows };
}

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Fishing migration tests require a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

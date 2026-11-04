import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0727_universal_player_location.sql";
const adminUrl = process.env.UNIVERSAL_LOCATION_MIGRATION_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("universal player location populated migration", () => {
  const databaseName = `ash_atlas_stability_location_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-location-"));
    for (const name of (await readdir(repoMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(repoMigrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 3 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("preserves representative Manor, Salon, and Sewer presence with an empty second run", async () => {
    const manorId = randomUUID();
    const cityId = randomUUID();
    const seatFlagId = randomUUID();
    const salonId = randomUUID();
    const sewerId = randomUUID();
    await pool.query(`
      INSERT INTO players (
        id,username,region_code,lat,lon,anchor_lat,anchor_lon,
        move_leash_radius_m,online,geom
      ) VALUES
        ('location-manor','location-manor','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)),
        ('location-salon','location-salon','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)),
        ('location-sewer','location-sewer','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`);
    await pool.query(
      `INSERT INTO player_manors (
         id,owner_player_id,world_region_code,world_lat,world_lon,geom,built_at
       ) VALUES ($1::uuid,'location-manor','NM',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),clock_timestamp())`,
      [manorId]
    );
    await pool.query(
      `INSERT INTO player_manor_presence (
         player_id,manor_id,return_region_code,return_lat,return_lon,
         access_source,local_position_x,local_position_y
       ) VALUES ('location-manor',$1::uuid,'NM',35,-106,'OWNER',420,730)`,
      [manorId]
    );
    await pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
       VALUES ($1,'location-manor','Location City Center',35,-106,1000,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [seatFlagId]
    );
    await pool.query(
      `INSERT INTO cities (
         id,world_settlement_id,world_settlement_source,world_source_settlement_id,canonical_municipality_id,
         name,country_code,region_code,founder_player_id,founding_request_id,
         hall_lat,hall_lon,hall_geom,founding_annex_radius_m,seat_flag_id
       ) VALUES ($1::uuid,'location-city','test','location-city','location-city','Location City',
         'US','NM','location-manor','location-city-request',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),1000,$2::uuid)`,
      [cityId, seatFlagId]
    );
    for (const [structureId, structureType, longitude] of [
      [salonId, "salon", -106.001],
      [sewerId, "cistern_warrens", -106.002]
    ] as const) {
      await pool.query(
        `INSERT INTO city_structures (
           structure_id,city_id,structure_type,tier,owner_player_id,world_id,
           region_code,lat,lon,geom,footprint_geom,footprint_radius_m,
           placement_revision,state,build_operation_key,built_at
         ) VALUES ($1::uuid,$2::uuid,$3,1,NULL,'main','NM',35,$4,
           ST_SetSRID(ST_MakePoint($4,35),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint($4,35),4326)::geography,8)::geometry,
           8,1,'active',$5,clock_timestamp())`,
        [structureId, cityId, structureType, longitude, `location-${structureType}`]
      );
    }
    await pool.query(
      `INSERT INTO salon_presence (
         player_id,salon_structure_id,session_id,local_x,local_y,
         return_region_code,return_lat,return_lon
       ) VALUES ('location-salon',$1::uuid,$2::uuid,610,720,'NM',35,-106)`,
      [salonId, randomUUID()]
    );
    await pool.query(
      `INSERT INTO cistern_warrens_presence (
         player_id,sewer_structure_id,session_id,local_x,local_y,
         return_region_code,return_lat,return_lon
       ) VALUES ('location-sewer',$1::uuid,$2::uuid,44,55,'NM',35,-106)`,
      [sewerId, randomUUID()]
    );

    await copyFile(path.join(repoMigrations, TARGET_MIGRATION), path.join(precedingMigrations, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations }))
      .resolves.toEqual([TARGET_MIGRATION]);
    const result = await pool.query(`
      SELECT id,location_type,location_id,location_instance_id,location_space_id,
             location_local_x,location_local_y,location_revision::int,last_portal_id
      FROM players WHERE id LIKE 'location-%' ORDER BY id`);
    expect(result.rows).toEqual([
      expect.objectContaining({
        id: "location-manor", location_type: "manor", location_id: manorId,
        location_instance_id: `manor:${manorId}`, location_space_id: "manor_main_room",
        location_local_x: 420, location_local_y: 730, location_revision: 1
      }),
      expect.objectContaining({
        id: "location-salon", location_type: "salon", location_id: salonId,
        location_instance_id: `salon:${salonId}`, location_space_id: "salon_main_room",
        location_local_x: 610, location_local_y: 720, location_revision: 1
      }),
      expect.objectContaining({
        id: "location-sewer", location_type: "cistern_warrens", location_id: sewerId,
        location_instance_id: `sewer:${sewerId}`, location_space_id: "sewer_depths",
        location_local_x: 44, location_local_y: 55, location_revision: 1
      })
    ]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([]);
  }, 60_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Universal location migration tests require a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

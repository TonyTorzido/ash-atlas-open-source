import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET = "0794_goblin_village.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Goblin Village migration", () => {
  const databaseName = `ash_atlas_stability_goblin_village_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let preceding = "";
  let pool: pg.Pool;
  const playerCityId = randomUUID();
  const playerFlagId = randomUUID();

  beforeAll(async () => {
    const parsed = disposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-0794-"));
    const source = path.resolve(process.cwd(), "../../db/migrations");
    for (const name of (await readdir(source)).filter((entry) => entry.endsWith(".sql") && entry < TARGET)) {
      await copyFile(path.join(source, name), path.join(preceding, name));
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 3 });
    await pool.query(
      `INSERT INTO players (id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
       VALUES ('goblin-test-player','goblin-test-player','NM',35,-106,35,-106,1250,false,
               ST_SetSRID(ST_MakePoint(-106,35),4326))`
    );
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,reinforcement_level,health,maximum_health,geom
       ) VALUES ($1,'goblin-test-player','Player Seat',35,-106,500,1,200,200,
               ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerFlagId]
    );
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,world_settlement_source,
         world_source_settlement_id,name,country_code,founder_player_id,founding_request_id,
         seat_flag_id,hall_lat,hall_lon,hall_geom,founding_annex_radius_m
       ) VALUES ($1,'main',$2,$2,'test',$2,'Preserved City','US','goblin-test-player','player-city',
                 $3,35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326),1000)`,
      [playerCityId, `settlement-${playerCityId}`, playerFlagId]
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  });

  it("preserves player cities, admits only system NPC city towers, skips NPC leaderboard credit, and reruns empty", async () => {
    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET);
    await expect(pool.query(
      "SELECT controller_kind,culture FROM cities WHERE id=$1",
      [playerCityId]
    )).resolves.toMatchObject({ rows: [{ controller_kind: "player", culture: "human" }] });
    await pool.query(
      `UPDATE flags
       SET control_type='city_seat',city_id=$2,city_affiliated_at=now(),
           access_mode='public',jump_toll_gold=0
       WHERE id=$1`,
      [playerFlagId, playerCityId]
    );

    const npcCityId = randomUUID();
    const npcFlagId = randomUUID();
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,world_settlement_source,
         world_source_settlement_id,name,country_code,founder_player_id,founding_request_id,
         hall_lat,hall_lon,hall_geom,founding_annex_radius_m,controller_kind,culture,banner_color
       ) VALUES ($1,'main',$2,$2,'system','goblin','Goblin Village','US','goblin-test-player','npc-city',
                 36,-107,ST_SetSRID(ST_MakePoint(-107,36),4326),2000,'npc','goblin','#174f2a')`,
      [npcCityId, `npc-${npcCityId}`]
    );
    await expect(pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,reinforcement_level,control_type,city_id,
         access_mode,jump_toll_gold,city_affiliated_at,health,maximum_health,
         system_controlled,presentation_color,geom
       ) VALUES ($1,'goblin-test-player','Goblin Tower',36,-107,500,3,'city_seat',$2,
                 'public',0,now(),200,200,true,'#174f2a',
                 ST_SetSRID(ST_MakePoint(-107,36),4326))`,
      [npcFlagId, npcCityId]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      "UPDATE flags SET reinforcement_level=3 WHERE id=$1",
      [playerFlagId]
    )).rejects.toThrow();
    const leaderboard = await pool.query(
      "SELECT source_id FROM weekly_leaderboard_events WHERE source_type='city_founding' AND source_id=$1",
      [npcCityId]
    );
    expect(leaderboard.rowCount).toBe(0);
    const laterPlayerCityId = randomUUID();
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,world_settlement_source,
         world_source_settlement_id,name,country_code,founder_player_id,founding_request_id,
         hall_lat,hall_lon,hall_geom,founding_annex_radius_m
       ) VALUES ($1,'main',$2,$2,'test',$2,'Later Player City','US','goblin-test-player',$3,
                 35.1,-106.1,ST_SetSRID(ST_MakePoint(-106.1,35.1),4326),1000)`,
      [laterPlayerCityId, `settlement-${laterPlayerCityId}`, `player-city-${laterPlayerCityId}`]
    );
    await expect(pool.query(
      "SELECT source_id FROM weekly_leaderboard_events WHERE source_type='city_founding' AND source_id=$1",
      [laterPlayerCityId]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 60_000);
});

function disposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "35432" ||
    !parsed.pathname.slice(1).startsWith("ash_atlas_stability")
  ) {
    throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must target a local ash_atlas_stability database outside the retained port");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

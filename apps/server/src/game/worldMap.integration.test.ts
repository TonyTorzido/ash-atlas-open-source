import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { WorldMapDestinationSnapshot } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { WorldMapService } from "./worldMap.js";

const databaseUrl = process.env.SETTLEMENT_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const unfeatured = { capitalAnchor: { lat: 0, lon: 0 }, topCityLimit: 0, featuredCacheTtlMs: 0 };

describeDatabase("world map PostgreSQL authority", () => {
  let pool: pg.Pool;
  let service: WorldMapService;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    service = new WorldMapService(pool, { WORLD_ID: "main" }, unfeatured);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayer(pool, "a", "Ash");
    await createPlayer(pool, "b", "Bex");
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("upgrades populated player data once and leaves the second migration run empty", async () => {
    const url = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.pathname.startsWith("/ash_atlas_stability")) throw new Error("Requires a local disposable database");
    const name = `ash_atlas_stability_world_map_${randomUUID().replaceAll("-", "")}`;
    url.pathname = `/${name}`;
    const migration = "0754_world_map_destination_visibility.sql";
    const source = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
    const preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-world-map-migration-"));
    let historical: pg.Pool | undefined;
    let created = false;
    try {
      for (const file of await readdir(source)) {
        if (file.endsWith(".sql") && file < migration) {
          await copyFile(path.join(source, file), path.join(preceding, file));
        }
      }
      await pool.query(`CREATE DATABASE "${name}"`);
      created = true;
      await runMigrations(url.toString(), { migrationsDirectory: preceding });
      historical = new DisposableTestPool({ connectionString: url.toString(), max: 1 });
      await createPlayer(historical, "retained-map-player", "Retained");
      const before = await historical.query("SELECT id,username FROM players ORDER BY id");
      await copyFile(path.join(source, migration), path.join(preceding, migration));
      await expect(runMigrations(url.toString(), { migrationsDirectory: preceding })).resolves.toEqual([migration]);
      await expect(runMigrations(url.toString(), { migrationsDirectory: preceding })).resolves.toEqual([]);
      await expect(historical.query("SELECT id,username FROM players ORDER BY id"))
        .resolves.toMatchObject({ rows: before.rows });
    } finally {
      await historical?.end();
      if (created) await pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await rm(preceding, { recursive: true, force: true });
    }
  }, 60_000);

  it("discovers an entered active city durably and idempotently without revealing it to another player", async () => {
    const cityId = await createCity(pool, "a", "Albuquerque", 35.0844, -106.6504);

    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({ destinations: [] });
    await expect(service.discoverAtAuthoritativePosition("b", {
      lat: 35.0844,
      lon: -106.6504
    })).resolves.toEqual({ cityId, discovered: true });
    await expect(service.discoverAtAuthoritativePosition("b", {
      lat: 35.0844,
      lon: -106.6504
    })).resolves.toEqual({ cityId, discovered: false });

    const rows = await pool.query(
      "SELECT player_id, city_id FROM player_discovered_cities WHERE player_id = 'b'"
    );
    expect(rows.rows).toEqual([{ player_id: "b", city_id: cityId }]);
    await expect(privateRoster(new WorldMapService(pool, { WORLD_ID: "main" }, unfeatured).snapshot("b")))
      .resolves.toMatchObject({
        destinations: [{
          kind: "city",
          id: cityId,
          name: "Albuquerque",
          lat: 35.0844,
          lon: -106.6504,
          visible: false
        }]
      });
    await expect(privateRoster(service.snapshot("a"))).resolves.toMatchObject({ destinations: [] });
  });

  it("defaults joined cities visible and persists authorized visibility choices", async () => {
    const cityId = await createCity(pool, "a", "Joined City", 35.0844, -106.6504);
    await service.discoverAtAuthoritativePosition("b", {
      lat: 35.0844,
      lon: -106.6504
    });
    await createCityMembership(pool, cityId, "b", 35.0844, -106.6504);

    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({
      destinations: [expect.objectContaining({ id: cityId, visible: true })]
    });
    await expect(privateRoster(service.setDestinationVisibility("b", {
      kind: "city",
      id: cityId
    }, false))).resolves.toMatchObject({
      destinations: [expect.objectContaining({ id: cityId, visible: false })]
    });
    await expect(privateRoster(new WorldMapService(pool, { WORLD_ID: "main" }, unfeatured).snapshot("b")))
      .resolves.toMatchObject({
        destinations: [expect.objectContaining({ id: cityId, visible: false })]
      });
    await expect(privateRoster(service.setDestinationVisibility("b", {
      kind: "city",
      id: cityId
    }, false))).resolves.toMatchObject({
      destinations: [expect.objectContaining({ id: cityId, visible: false })]
    });
    await expect(pool.query(
      `SELECT visible FROM player_world_map_destination_preferences
       WHERE player_id = 'b' AND destination_kind = 'city' AND destination_id = $1`,
      [cityId]
    )).resolves.toMatchObject({ rows: [{ visible: false }] });
  });

  it("rejects visibility changes for destinations outside the player's roster", async () => {
    const cityId = await createCity(pool, "a", "Private City", 35.0844, -106.6504);
    await expect(service.setDestinationVisibility("b", {
      kind: "city",
      id: cityId
    }, true)).rejects.toMatchObject({ code: "WORLD_MAP_DESTINATION_UNAVAILABLE" });
    await expect(pool.query(
      "SELECT 1 FROM player_world_map_destination_preferences WHERE player_id = 'b'"
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("publishes coarse social positions by default, preserves explicit privacy choices, and expires stale data", async () => {
    await service.publishSocialPosition("a", {
      lat: 35.12349,
      lon: -106.65431
    });
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({
      socialPlayers: []
    });

    await pool.query(
      `INSERT INTO friendships (player_low_id, player_high_id)
       VALUES ('a', 'b')`
    );
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({
      socialPlayers: [{
        playerId: "a",
        username: "Ash",
        displayColor: "#38bdf8",
        lat: 35.12,
        lon: -106.65
      }]
    });

    await expect(privateRoster(service.setSocialVisibility("a", "friends", false)))
      .resolves.toMatchObject({ socialPlayers: [] });
    await expect(privateRoster(service.setSocialVisibility("a", "friends", true)))
      .resolves.toMatchObject({ socialPlayers: [{ playerId: "a" }] });

    await service.publishSocialPosition("a", {
      lat: 36.9876,
      lon: -105.4321
    });
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({
      socialPlayers: [{ lat: 35.12, lon: -106.65 }]
    });

    await pool.query(
      `UPDATE player_world_map_social_positions
       SET published_at = now() - interval '31 seconds'
       WHERE player_id = 'a'`
    );
    await service.publishSocialPosition("a", {
      lat: 36.9876,
      lon: -105.4321
    });
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({
      socialPlayers: [{ lat: 36.99, lon: -105.43 }]
    });

    await pool.query(
      `INSERT INTO player_blocks (blocker_id, blocked_id)
       VALUES ('b', 'a')`
    );
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({
      socialPlayers: []
    });
    await pool.query(
      `DELETE FROM player_blocks
       WHERE blocker_id = 'b' AND blocked_id = 'a'`
    );

    await pool.query(
      `UPDATE player_world_map_social_positions
       SET published_at = now() - interval '11 minutes'
       WHERE player_id = 'a'`
    );
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({
      socialPlayers: []
    });
  });

  it("does not discover a city from membership or proximity outside its authoritative territory", async () => {
    const cityId = await createCity(pool, "a", "Santa Fe", 35.687, -105.9378);
    await pool.query(
      `WITH house AS (
         INSERT INTO city_structures (
           structure_id,city_id,structure_type,tier,owner_player_id,world_id,
           lat,lon,geom,footprint_geom,footprint_radius_m,state,
           build_operation_key,built_at
         ) VALUES (
           gen_random_uuid(),$1,'city_house',1,'b','main',
           35.688,-105.9378,
           ST_SetSRID(ST_MakePoint(-105.9378,35.688),4326),
           ST_Buffer(
             ST_SetSRID(ST_MakePoint(-105.9378,35.688),4326)::geography,
             10
           )::geometry,
           10,'active','world-map-membership-house',now()
         )
         RETURNING structure_id
       )
       INSERT INTO city_memberships (
         city_id,player_id,world_id,role,house_structure_id
       )
       SELECT $1,'b','main','member',structure_id FROM house`,
      [cityId]
    );

    await expect(service.discoverAtAuthoritativePosition("b", {
      lat: 35.9,
      lon: -105.9378
    })).resolves.toBeNull();
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({ destinations: [] });
  });

  it("resolves current city identity and location, hides inactive cities, and rejects undiscovered travel", async () => {
    const cityId = await createCity(pool, "a", "Old Name", 35.0844, -106.6504);
    await service.discoverAtAuthoritativePosition("b", {
      lat: 35.0844,
      lon: -106.6504
    });
    await pool.query(
      `UPDATE cities
       SET name = 'New Name',
           hall_lat = 35.12,
           hall_lon = -106.71,
           hall_geom = ST_SetSRID(ST_MakePoint(-106.71, 35.12), 4326)
       WHERE id = $1`,
      [cityId]
    );
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({
      destinations: [{ id: cityId, name: "New Name", lat: 35.12, lon: -106.71 }]
    });
    await expect(service.hasDiscoveredCity("a", cityId)).resolves.toBe(false);
    await expect(service.hasDiscoveredCity("b", cityId)).resolves.toBe(true);

    await pool.query(
      `UPDATE cities
       SET active = false, jumpable = false, inactive_reason = 'abandoned',
           ended_at = now(), rebuild_available_at = now() + interval '7 days'
       WHERE id = $1`,
      [cityId]
    );
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({ destinations: [] });
    await expect(service.hasDiscoveredCity("b", cityId)).resolves.toBe(false);
    await expect(pool.query(
      "SELECT 1 FROM player_discovered_cities WHERE player_id = 'b' AND city_id = $1",
      [cityId]
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("features the capital and largest cities for everyone and allows travel only to them", async () => {
    await createPlayer(pool, "c", "Cal");
    await createPlayer(pool, "d", "Dov");
    const capitalId = await createCity(pool, "a", "Albuquerque", 35.0853, -106.6511);
    const topId = await createCity(pool, "c", "Santa Fe", 35.687, -105.9378);
    const quietId = await createCity(pool, "d", "Quiet Town", 36.5, -104.5);
    await createCityMembership(pool, topId, "c", 35.688, -105.9378);
    await createPlayer(pool, "e", "Eli");
    await createPlayer(pool, "f", "Fay");
    const thirdId = await createCity(pool, "e", "Taos", 36.4, -105.57);
    const fourthId = await createCity(pool, "f", "Zuni", 35.07, -108.85);
    await createCityMembership(pool, thirdId, "e", 36.401, -105.57);
    await createCityMembership(pool, fourthId, "f", 35.071, -108.85);
    const featured = new WorldMapService(pool, { WORLD_ID: "main" }, { featuredCacheTtlMs: 0, topCityLimit: 3 });

    const snapshot = await featured.snapshot("b");
    expect(snapshot.destinations).toEqual([
      expect.objectContaining({ id: capitalId, featured: "capital", discovered: false }),
      expect.objectContaining({ id: topId, featured: "top", memberCount: 1 }),
      expect.objectContaining({ id: thirdId, featured: "top" })
    ]);
    await expect(featured.canTravelToCity("b", capitalId)).resolves.toBe(true);
    await expect(featured.canTravelToCity("b", topId)).resolves.toBe(true);
    await expect(featured.canTravelToCity("b", quietId)).resolves.toBe(false);
    await expect(featured.canTravelToCity("b", fourthId)).resolves.toBe(false);

    await pool.query("UPDATE cities SET active = false, jumpable = false, inactive_reason = 'abandoned', ended_at = now(), rebuild_available_at = now() + interval '7 days' WHERE id = $1", [capitalId]);
    await expect(featured.canTravelToCity("b", capitalId)).resolves.toBe(false);
    expect((await featured.snapshot("b")).destinations.map((d) => d.id)).toEqual([topId, thirdId, fourthId]);
  });

  it("includes only the player's own manor and current Castle and exposes no flag fields", async () => {
    await createBuiltManor(pool, "a", 35.1, -106.7);
    await createBuiltManor(pool, "b", 36.1, -105.7);
    await createKingdomSeat(pool, "a", "Ash Realm", 35.2, -106.8);
    await createKingdomSeat(pool, "b", "Bex Realm", 36.2, -105.8);

    const snapshot = await service.snapshot("a");
    expect((await privateRoster(Promise.resolve(snapshot))).destinations).toEqual([
      expect.objectContaining({ kind: "manor", name: "Your Manor", lat: 35.1, lon: -106.7, visible: true }),
      expect.objectContaining({ kind: "kingdom", name: "Ash Realm", lat: 35.2, lon: -106.8, visible: true })
    ]);
    const json = JSON.stringify(snapshot);
    expect(json).not.toMatch(/flagId|sourceFlag|personal|nearby/i);

    await pool.query(
      `UPDATE kingdom_memberships
       SET status = 'left', ended_at = now(), end_reason = 'test'
       WHERE player_id = 'a' AND status = 'active'`
    );
    await expect(privateRoster(service.snapshot("a"))).resolves.toMatchObject({
      destinations: [expect.objectContaining({ kind: "manor" })]
    });
  });

  it("includes live Atlas Shrines only for their owner and removes destroyed destinations", async () => {
    const shrineId = randomUUID();
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
         control_type,reinforcement_level,atlas_shrine_slot_number,access_mode,geom
       ) VALUES (
         $1,'a','Atlas Shrine 1',35.25,-106.75,1000,1250,
         'personal',2,1,'public',ST_SetSRID(ST_MakePoint(-106.75,35.25),4326)
       )`,
      [shrineId]
    );
    await expect(privateRoster(service.snapshot("a"))).resolves.toMatchObject({
      destinations: [{
        kind: "atlas_shrine",
        id: shrineId,
        name: "Atlas Shrine 1",
        lat: 35.25,
        lon: -106.75,
        visible: true
      }]
    });
    await expect(privateRoster(service.snapshot("b"))).resolves.toMatchObject({ destinations: [] });
    await expect(service.getOwnedAtlasShrine("b", shrineId)).resolves.toBeNull();
    await expect(service.getOwnedAtlasShrine("a", shrineId))
      .resolves.toMatchObject({ id: shrineId });

    await pool.query("DELETE FROM flags WHERE id = $1", [shrineId]);
    await expect(privateRoster(service.snapshot("a"))).resolves.toMatchObject({ destinations: [] });
    await expect(service.getOwnedAtlasShrine("a", shrineId)).resolves.toBeNull();
  });
});

async function privateRoster(snapshot: Promise<WorldMapDestinationSnapshot>): Promise<WorldMapDestinationSnapshot> {
  return snapshot;
}

async function createPlayer(pool: pg.Pool, id: string, username: string): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
       move_leash_radius_m, online, geom
     ) VALUES ($1,$2,'#38bdf8','NM',35.0844,-106.6504,35.0844,-106.6504,
               900,false,ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`,
    [id, username]
  );
}

async function createCity(
  pool: pg.Pool,
  founderId: string,
  name: string,
  lat: number,
  lon: number
): Promise<string> {
  const cityId = randomUUID();
  const flagId = randomUUID();
  await pool.query(
    `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
     VALUES ($1,$2,$3,$4,$5,1000,ST_SetSRID(ST_MakePoint($5,$4),4326))`,
    [flagId, founderId, `${name} Seat`, lat, lon]
  );
  await pool.query(
    `INSERT INTO cities (
       id, world_id, canonical_municipality_id, world_settlement_id,
       world_settlement_source, world_source_settlement_id, name, country_code,
       region_code, founder_player_id, mayor_player_id, founding_request_id,
       seat_flag_id, hall_lat, hall_lon, hall_geom, founding_annex_radius_m
     ) VALUES (
       $1,'main',$2,$2,'test',$2,$3,'US','US-NM',$4,$4,$5,$6,$7,$8,
       ST_SetSRID(ST_MakePoint($8,$7),4326),1000
     )`,
    [cityId, `municipality-${cityId}`, name, founderId, `found-${cityId}`, flagId, lat, lon]
  );
  await pool.query(
    `UPDATE flags
     SET control_type = 'city_seat', city_id = $2, city_affiliated_at = now(),
         city_affiliated_by_player_id = NULL, original_owner_player_id = NULL,
         contributed_by_player_id = NULL, original_personal_color = NULL
     WHERE id = $1`,
    [flagId, cityId]
  );
  return cityId;
}

async function createBuiltManor(
  pool: pg.Pool,
  playerId: string,
  lat: number,
  lon: number
): Promise<void> {
  await pool.query(
    `INSERT INTO player_manors (
       owner_player_id, world_region_code, world_lat, world_lon, geom, built_at
     ) VALUES (
       $1,'NM',$2,$3,ST_SetSRID(ST_MakePoint($3,$2),4326),now()
     )`,
    [playerId, lat, lon]
  );
}

async function createCityMembership(
  pool: pg.Pool,
  cityId: string,
  playerId: string,
  lat: number,
  lon: number
): Promise<void> {
  await pool.query(
    `WITH house AS (
       INSERT INTO city_structures (
         structure_id, city_id, structure_type, tier, owner_player_id, world_id,
         lat, lon, geom, footprint_geom, footprint_radius_m, state,
         build_operation_key, built_at
       ) VALUES (
         gen_random_uuid(), $1, 'city_house', 1, $2, 'main', $3, $4,
         ST_SetSRID(ST_MakePoint($4,$3),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,10)::geometry,
         10, 'active', $5, now()
       )
       RETURNING structure_id
     )
     INSERT INTO city_memberships (
       membership_id, city_id, player_id, world_id, role, house_structure_id, joined_at
     )
     SELECT gen_random_uuid(), $1, $2, 'main', 'member', structure_id, now()
     FROM house`,
    [cityId, playerId, lat, lon, `world-map-membership:${cityId}:${playerId}`]
  );
}

async function createKingdomSeat(
  pool: pg.Pool,
  playerId: string,
  name: string,
  lat: number,
  lon: number
): Promise<void> {
  const kingdomId = randomUUID();
  await pool.query(
    `INSERT INTO kingdoms (
       id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id
     ) VALUES ($1,$2,$3,$4,$4,$5)`,
    [kingdomId, name.toLowerCase().replaceAll(" ", "-"), name, playerId, randomUUID()]
  );
  await pool.query(
    `INSERT INTO kingdom_memberships (
       id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
     ) VALUES ($1,$2,$3,'leader','active',now(),now())`,
    [randomUUID(), kingdomId, playerId]
  );
  await pool.query(
    `INSERT INTO kingdom_seats (
       id, kingdom_id, lat, lon, geom, territory_radius_m,
       is_land, is_saltwater, inside_major_lake, environment_rules_version,
       environment_lookup_at, construction_state, completed_under_free_construction,
       status, completed_at
     ) VALUES (
       $1,$2,$3,$4,ST_SetSRID(ST_MakePoint($4,$3),4326),1000,
       true,false,false,1,now(),'complete',true,'active',now()
     )`,
    [randomUUID(), kingdomId, lat, lon]
  );
}

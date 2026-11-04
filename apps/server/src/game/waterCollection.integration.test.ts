import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";
import { CollectibleService } from "./collectibles.js";

const databaseUrl = process.env.WATER_CADENCE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("durable water collection PostgreSQL integration", () => {
  const firstPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const secondPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const playerId = `water-cadence-${randomUUID()}`;
  const target = { lat: 35.0844, lon: -106.6504 };
  const player = { playerId, regionCode: "GLOBAL", position: target };
  const config = loadConfig({ NODE_ENV: "test", WATER_COLLECTION_CADENCE_MS: "60000" });
  const firstWorldLookup = worldLookupClient();
  const secondWorldLookup = worldLookupClient();
  const first = new CollectibleService(firstPool, firstWorldLookup.client, config, loggerStub());
  const second = new CollectibleService(secondPool, secondWorldLookup.client, config, loggerStub());

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await firstPool.query(
      `INSERT INTO players (
         id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES ($1,$1,'GLOBAL',$2,$3,$2,$3,1250,true,
                 ST_SetSRID(ST_MakePoint($3,$2),4326))`,
      [playerId, target.lat, target.lon]
    );
  });

  afterAll(async () => {
    const client = await firstPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM water_collection_operations WHERE player_id = $1`, [playerId]);
      await client.query(`DELETE FROM player_water_collection_cadence WHERE player_id = $1`, [playerId]);
      await client.query("ALTER TABLE inventory_events DISABLE TRIGGER inventory_events_immutable");
      await client.query("ALTER TABLE inventory_operations DISABLE TRIGGER inventory_operations_immutable");
      await client.query("ALTER TABLE player_inventory DISABLE TRIGGER player_inventory_identity_guard");
      await client.query(`DELETE FROM inventory_events WHERE player_id = $1`, [playerId]);
      await client.query(`DELETE FROM inventory_operations WHERE player_id = $1`, [playerId]);
      await client.query(`DELETE FROM player_inventory WHERE player_id = $1`, [playerId]);
      await client.query("ALTER TABLE player_inventory ENABLE TRIGGER player_inventory_identity_guard");
      await client.query("ALTER TABLE inventory_operations ENABLE TRIGGER inventory_operations_immutable");
      await client.query("ALTER TABLE inventory_events ENABLE TRIGGER inventory_events_immutable");
      await client.query(`DELETE FROM players WHERE id = $1`, [playerId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  });

  it("rejects every new collection request without creating durable water", async () => {
    const attempts = await Promise.allSettled([
      first.collectWaterAt(player, target, "runtime-a"),
      second.collectWaterAt(player, target, "runtime-b")
    ]);
    expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        expect(attempt.reason).toMatchObject({ message: expect.stringMatching(/not currently available/) });
      }
    }
    expect(firstWorldLookup.lookup).not.toHaveBeenCalled();
    expect(secondWorldLookup.lookup).not.toHaveBeenCalled();

    const persisted = await firstPool.query<{ operation_count: string; water_quantity: string }>(
      `SELECT
         (SELECT count(*)::text FROM water_collection_operations WHERE player_id = $1)
           AS operation_count,
         (SELECT COALESCE(sum(quantity), 0)::text FROM player_inventory
          WHERE player_id = $1 AND resource_type = 'water') AS water_quantity`,
      [playerId]
    );
    expect(persisted.rows[0]).toEqual({ operation_count: "0", water_quantity: "0" });
  });
});

function worldLookupClient() {
  const result: WorldLookupResult = {
    ok: true,
    packageId: "us_nm_v1_lat35_lon-107",
    elevationM: 1_500,
    terrainClass: "flat",
    biome: "Desert",
    ecoregion: "Chihuahuan Desert",
    raw: {
      profile: {
        is_land: true,
        is_saltwater: false,
        inside_major_lake: true,
        near_major_river: false,
        major_river_distance_m: null
      }
    }
  };
  const lookup = vi.fn(async () => result);
  return {
    client: {
      isReachable: vi.fn(async () => true),
      lookupGameplayEnvironment: lookup,
      lookupResourceEnvironments: vi.fn(async () => []),
      collectibleWaterSourcesNear: vi.fn(async () => [])
    } as unknown as WorldLookupClient,
    lookup
  };
}

function loggerStub() {
  return { warn: vi.fn(), info: vi.fn() };
}

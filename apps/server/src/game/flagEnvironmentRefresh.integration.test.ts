import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createPool, type DbPool } from "../db/pool.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";
import { FlagService } from "./flags.js";

const databaseUrl = process.env.FLAG_ENVIRONMENT_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("FlagService refresh integration", () => {
  let pool: DbPool;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = createPool({ databaseUrl: databaseUrl! });
    await pool.query(
      `INSERT INTO players (
         id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, geom
       ) VALUES ($1, $2, $3, 'GLOBAL', 53.3498, -6.2603, 53.3498, -6.2603,
                 1250, ST_SetSRID(ST_MakePoint(-6.2603, 53.3498), 4326))`,
      [OWNER_ID, "Audit Owner", "#38bdf8"]
    );
    await insertFlag(pool, CURRENT_FLAG_ID, world().raw, "Current Flag", -6.2603);
    await insertFlag(pool, LEGACY_FLAG_ID, { legacy: true }, "Legacy Flag", -6.3503);
    await insertFlag(pool, EMPTY_FLAG_ID, {}, "Empty Flag", -6.3203);
    await insertFlag(pool, REFRESH_FLAG_ID, { legacy: true }, "Refresh Flag", -6.2903);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM flags WHERE id = ANY($1::uuid[])", [
      [CURRENT_FLAG_ID, LEGACY_FLAG_ID, EMPTY_FLAG_ID, REFRESH_FLAG_ID]
    ]);
    await pool.query("DELETE FROM players WHERE id = $1", [OWNER_ID]);
    await pool.end();
  });

  it("preserves identity and territory columns while replacing only authoritative environment data", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl!,
      WORLD_REQUIRED_PROFILE_SET_FINGERPRINT: "a".repeat(64),
      WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT: "b".repeat(64)
    });
    const lookup = {
      lookupGameplayEnvironment: vi.fn(async () => world(-6.2903))
    } as unknown as WorldLookupClient;
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as AppLogger;
    const service = new FlagService(pool, lookup, config, logger);

    await service.refreshEnvironment(REFRESH_FLAG_ID);

    const result = await pool.query<{
      id: string;
      owner_id: string;
      name: string;
      lat: number;
      lon: number;
      claim_radius_m: number;
      city_id: string | null;
      created_at: Date;
      package_id: string;
      elevation_m: number;
      terrain_class: string;
      biome: string;
      ecoregion: string;
      environment_snapshot: Record<string, unknown>;
      updated_at: Date;
    }>("SELECT * FROM flags WHERE id = $1", [REFRESH_FLAG_ID]);
    expect(result.rows[0]).toMatchObject({
      id: REFRESH_FLAG_ID,
      owner_id: OWNER_ID,
      name: "Refresh Flag",
      lat: 53.3498,
      lon: -6.2903,
      claim_radius_m: 777,
      city_id: null,
      package_id: "world_v1_lat53_lon-7",
      elevation_m: 0,
      terrain_class: "flat",
      biome: "Temperate Broadleaf & Mixed Forests",
      ecoregion: "Celtic broadleaf forests"
    });
    expect(result.rows[0]?.created_at.toISOString()).toBe(CREATED_AT.toISOString());
    expect(result.rows[0]?.environment_snapshot).toEqual(world(-6.2903).raw);
    expect(result.rows[0]?.updated_at.getTime()).toBeGreaterThan(INITIAL_UPDATED_AT.getTime());
  });

  it("executes the production environment-details SQL for current, legacy, empty, and missing flags", async () => {
    const service = new FlagService(
      pool,
      {
        lookupGameplayEnvironment: vi.fn(async () => world())
      } as unknown as WorldLookupClient,
      loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl!,
        WORLD_REQUIRED_PROFILE_SET_FINGERPRINT: "a".repeat(64),
        WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT: "b".repeat(64)
      }),
      { info: vi.fn(), warn: vi.fn() } as unknown as AppLogger
    );

    await expect(service.getEnvironmentDetails(CURRENT_FLAG_ID)).resolves.toMatchObject({
      identity: { flagId: CURRENT_FLAG_ID },
      provenance: { snapshotStatus: "current" }
    });
    await expect(service.getEnvironmentDetails(LEGACY_FLAG_ID)).resolves.toMatchObject({
      identity: { flagId: LEGACY_FLAG_ID },
      provenance: { snapshotStatus: "legacy" }
    });
    await expect(service.getEnvironmentDetails(EMPTY_FLAG_ID)).resolves.toMatchObject({
      identity: { flagId: EMPTY_FLAG_ID },
      provenance: { snapshotStatus: "unavailable" }
    });
    await expect(service.getEnvironmentDetails(MISSING_FLAG_ID)).resolves.toBeNull();
  });
});

const CURRENT_FLAG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LEGACY_FLAG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const EMPTY_FLAG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const REFRESH_FLAG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const MISSING_FLAG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const OWNER_ID = "flag-environment-audit-owner";
const CREATED_AT = new Date("2026-07-13T03:00:00.000Z");
const INITIAL_UPDATED_AT = new Date("2026-07-13T03:05:00.000Z");

async function insertFlag(
  pool: DbPool,
  id: string,
  snapshot: unknown,
  name: string,
  lon: number
): Promise<void> {
  await pool.query(
    `INSERT INTO flags (
       id, owner_id, name, lat, lon, package_id, elevation_m, terrain_class,
       biome, ecoregion, claim_radius_m, environment_snapshot, created_at, updated_at, geom
     ) VALUES ($1, $2, $3, 53.3498, $4, 'legacy-package',
               99, 'legacy-terrain', 'legacy-biome', 'legacy-ecoregion', 777,
               $5::jsonb, $6, $7,
               ST_SetSRID(ST_MakePoint($4, 53.3498), 4326))`,
    [id, OWNER_ID, name, lon, JSON.stringify(snapshot), CREATED_AT, INITIAL_UPDATED_AT]
  );
}

function world(lon = -6.2603): WorldLookupResult {
  const raw = {
    ok: true,
    covered: true,
    release: { release_id: "world-packages-v1", profile_set_fingerprint: "a".repeat(64), build_contract_fingerprint: "b".repeat(64), boundary_release_id: "world-boundaries-v1", package_count: 64800 },
    selected_package: { package_id: "world_v1_lat53_lon-7" },
    profile: { environment_schema_version: "world-profile-v2", latitude: 53.3498, longitude: lon, administrative: {}, environment: { ecology_resolution: "nearest_land_fallback" }, water: { nearest_water_resolution: "within_search_radius" }, derived_tags: [], source_versions: {}, warnings: [] }
  };
  return {
    ok: true,
    packageId: "world_v1_lat53_lon-7",
    elevationM: 0,
    terrainClass: "flat",
    biome: "Temperate Broadleaf & Mixed Forests",
    ecoregion: "Celtic broadleaf forests",
    raw
  };
}

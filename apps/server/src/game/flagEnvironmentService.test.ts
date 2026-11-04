import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";
import { FlagService } from "./flags.js";

describe("FlagService environment operations", () => {
  it("returns normalized advanced details without changing lightweight snapshots", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [storedRow()], rowCount: 1 }))
    } as unknown as pg.Pool;
    const service = new FlagService(pool, worldClient(world()), config(), logger());

    await expect(service.getEnvironmentDetails(FLAG_ID)).resolves.toMatchObject({
      identity: { flagId: FLAG_ID, ownerName: "Ash" },
      ecology: { ecoregionId: "651", resolution: "nearest_land_fallback" },
      water: { supportingRiver: { id: "20287927" } },
      provenance: { snapshotStatus: "current" }
    });
    const sql = String(vi.mocked(pool.query).mock.calls[0]?.[0]);
    expect(sql).toContain("environment_snapshot");
    expect(sql).toContain("f.created_at, f.updated_at");
  });

  it("runs an authoritative diagnostics lookup without mutating the stored snapshot", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [storedRow()], rowCount: 1 }))
    } as unknown as pg.Pool;
    const lookup = worldClient(world());
    const service = new FlagService(pool, lookup, config(), logger());

    const diagnostics = await service.getEnvironmentDiagnostics(FLAG_ID);

    expect(diagnostics).toMatchObject({
      stored: { identity: { flagId: FLAG_ID } },
      live: {
        details: { provenance: { snapshotStatus: "current" } },
        rawLookup: world().raw
      },
      required: { environmentSchemaVersion: "world-profile-v2" },
      refreshRecommended: false
    });
    expect(diagnostics?.live.durationMs).toBeGreaterThanOrEqual(0);
    expect(lookup.lookup).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
    expect(String(vi.mocked(pool.query).mock.calls[0]?.[0])).not.toContain("UPDATE flags");
  });

  it("refreshes only environment columns in one transaction", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push(values ? { text, values } : { text });
        if (text.includes("FOR UPDATE")) {
          return { rows: [{ id: FLAG_ID, lat: 53.3498, lon: -6.2603 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const lookup = worldClient(world());
    const service = new FlagService(pool, lookup, config(), logger());

    await service.refreshEnvironment(FLAG_ID);

    expect(calls.map((call) => call.text.trim())).toEqual([
      "BEGIN",
      "SELECT id, lat, lon FROM flags WHERE id = $1 FOR UPDATE",
      expect.stringContaining("UPDATE flags"),
      "COMMIT"
    ]);
    const update = calls[2];
    expect(update?.text).toContain("environment_snapshot = $7::jsonb");
    expect(update?.text).not.toContain("updated_at =");
    for (const preserved of ["owner_id", "name =", "lat =", "lon =", "claim_radius_m", "city_id", "created_at"]) {
      expect(update?.text).not.toContain(preserved);
    }
    expect(JSON.parse(String(update?.values?.[6]))).toEqual(world().raw);
    expect(lookup.lookupGameplayEnvironment).toHaveBeenCalledWith(53.3498, -6.2603);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back a failed authoritative refresh", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text.trim());
        if (text.includes("FOR UPDATE")) return { rows: [{ id: FLAG_ID, lat: 1, lon: 2 }] };
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const failed = { ...world(), ok: false, warning: "release mismatch" };
    const service = new FlagService(
      { connect: vi.fn(async () => client) } as unknown as pg.Pool,
      worldClient(failed),
      config(),
      logger()
    );

    await expect(service.refreshEnvironment(FLAG_ID)).rejects.toThrow("Authoritative world lookup failed.");
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(calls.some((text) => text.includes("UPDATE flags"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("bounds refresh-all work and reports per-flag failures without stopping", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ id: "flag-a" }, { id: "flag-b" }, { id: "flag-c" }],
        rowCount: 3
      }))
    } as unknown as pg.Pool;
    const service = new FlagService(pool, worldClient(world()), config(), logger());
    vi.spyOn(service, "refreshEnvironment")
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("lookup failed"));

    await expect(service.refreshAllEnvironments(2)).resolves.toEqual({
      requested: 2,
      refreshed: 1,
      refreshedFlagIds: ["flag-a"],
      failures: [{ flagId: "flag-b", error: "Environment refresh failed. Check server logs." }],
      truncated: true
    });
    expect(pool.query).toHaveBeenCalledWith(
      "SELECT id FROM flags ORDER BY created_at ASC, id ASC LIMIT $1",
      [3]
    );
  });

  it("refreshes only legacy or incomplete snapshots within the requested bound", async () => {
    const pool = {
      query: vi.fn(async (text: string) => String(text).includes("SELECT f.id")
        ? { rows: [storedRow()], rowCount: 1 }
        : {
            rows: [{ id: "current" }, { id: "legacy" }, { id: "incomplete" }, { id: "extra" }],
            rowCount: 4
          })
    } as unknown as pg.Pool;
    const service = new FlagService(pool, worldClient(world()), config(), logger());
    const current = await service.getEnvironmentDetails(FLAG_ID);
    if (!current) throw new Error("fixture details missing");
    vi.mocked(pool.query).mockClear();
    vi.spyOn(service, "getEnvironmentDetails")
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, provenance: { ...current.provenance, snapshotStatus: "legacy" } })
      .mockResolvedValueOnce({ ...current, provenance: { ...current.provenance, snapshotStatus: "incomplete" } });
    const refresh = vi.spyOn(service, "refreshEnvironment").mockResolvedValue();

    await expect(service.refreshEnvironmentsNeedingRefresh(1)).resolves.toEqual({
      requested: 1,
      refreshed: 1,
      refreshedFlagIds: ["legacy"],
      failures: [],
      truncated: true
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith("legacy");
    expect(pool.query).toHaveBeenCalledWith(
      "SELECT id FROM flags ORDER BY created_at ASC, id ASC LIMIT 1001"
    );
  });
});

const FLAG_ID = "11111111-1111-4111-8111-111111111111";

function config() {
  return loadConfig({
    NODE_ENV: "test",
    WORLD_REQUIRED_PROFILE_SET_FINGERPRINT: "a".repeat(64),
    WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT: "b".repeat(64)
  });
}

function logger(): AppLogger {
  return { info: vi.fn(), warn: vi.fn() } as unknown as AppLogger;
}

function worldClient(result: WorldLookupResult): WorldLookupClient {
  return {
    lookup: vi.fn(async () => result),
    lookupGameplayEnvironment: vi.fn(async () => result)
  } as unknown as WorldLookupClient;
}

function storedRow() {
  return {
    id: FLAG_ID,
    owner_id: "owner-id",
    owner_username: "Ash",
    owner_color: "#38bdf8",
    name: "Flag 9",
    lat: 53.3498,
    lon: -6.2603,
    package_id: "world_v1_lat53_lon-7",
    elevation_m: 0,
    terrain_class: "flat",
    biome: "Temperate Broadleaf & Mixed Forests",
    ecoregion: "Celtic broadleaf forests",
    claim_radius_m: 1000,
    city_id: null,
    environment_snapshot: world().raw,
    created_at: new Date("2026-07-13T08:00:00.000Z"),
    updated_at: new Date("2026-07-13T09:00:00.000Z")
  };
}

function world(): WorldLookupResult {
  const raw = {
    ok: true,
    covered: true,
    release: { release_id: "world-packages-v1", profile_set_fingerprint: "a".repeat(64), build_contract_fingerprint: "b".repeat(64), boundary_release_id: "world-boundaries-v1", package_count: 64800 },
    selected_package: { package_id: "world_v1_lat53_lon-7" },
    profile: {
      environment_schema_version: "world-profile-v2",
      latitude: 53.3498,
      longitude: -6.2603,
      administrative: {},
      environment: { elevation_m: 0, terrain_class: "flat", land_cover_class: "inland_water", source_land_cover_code: 210, biome_id: "4", biome_name: "Temperate Broadleaf & Mixed Forests", ecoregion_id: "651", ecoregion_name: "Celtic broadleaf forests", is_land: true, is_saltwater: false, is_coastal: true, land_cover_conflict: true, ecology_resolution: "nearest_land_fallback", ecology_distance_m: 1795.604, ecology_source_package_id: "world_v1_lat53_lon-7", ecology_fallback_max_m: 10000 },
      water: { inside_major_lake: false, nearest_supporting_river_id: "20287927", supporting_river_flow_order: 6, nearest_water_source_type: "coast", nearest_water_source_kind: "salt", nearest_water_source_distance_m: 2.311, nearest_water_resolution: "within_search_radius", nearest_water_search_radius_m: 25000, nearest_water_search_complete: true },
      derived_tags: ["coastal_ecology_inferred", "land_cover_conflict"],
      source_versions: { ecoregions: "2017" },
      warnings: []
    }
  };
  return {
    ok: true,
    packageId: "world_v1_lat53_lon-7",
    latitude: 53.3498,
    longitude: -6.2603,
    elevationM: 0,
    terrainClass: "flat",
    landCoverClass: "inland_water",
    sourceLandCoverCode: 210,
    biome: "Temperate Broadleaf & Mixed Forests",
    biomeId: "4",
    ecoregion: "Celtic broadleaf forests",
    ecoregionId: "651",
    isLand: true,
    isSaltwater: false,
    isCoastal: true,
    landCoverConflict: true,
    ecologyResolution: "nearest_land_fallback",
    ecologyDistanceM: 1795.604,
    ecologySourcePackageId: "world_v1_lat53_lon-7",
    ecologyFallbackMaxM: 10000,
    insideMajorLake: false,
    supportingRiverId: "20287927",
    supportingRiverFlowOrder: 6,
    nearestWaterSourceType: "coast",
    nearestWaterSourceKind: "salt",
    nearestWaterSourceDistanceM: 2.311,
    nearestWaterResolution: "within_search_radius",
    nearestWaterSearchRadiusM: 25000,
    nearestWaterSearchComplete: true,
    environmentSchemaVersion: "world-profile-v2",
    release: { releaseId: "world-packages-v1", profileSetFingerprint: "a".repeat(64), buildContractFingerprint: "b".repeat(64), boundaryReleaseId: "world-boundaries-v1", packageCount: 64800 },
    sourceVersions: { ecoregions: "2017" },
    derivedTags: ["coastal_ecology_inferred", "land_cover_conflict"],
    warnings: [],
    raw
  };
}

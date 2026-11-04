import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { buildFlagEnvironmentDetails, type PersistedFlagEnvironmentRow } from "./flagEnvironment.js";

describe("buildFlagEnvironmentDetails", () => {
  it("preserves Dublin fallback, hydrology, conflict, and provenance metadata", () => {
    const details = buildFlagEnvironmentDetails(row(dublinLookup()), config());

    expect(details).toMatchObject({
      coordinates: { latitude: 53.3498, longitude: -6.2603, packageId: "world_v1_lat53_lon-7" },
      terrain: { landCoverClass: "inland_water", sourceLandCoverCode: 210, isLand: true, isSaltwater: false, isCoastal: true, coastlineSearchRadiusM: 100000, coastlineSearchComplete: true, coastalThresholdM: 5000, landCoverConflict: true },
      ecology: { biomeId: "4", ecoregionId: "651", resolution: "nearest_land_fallback", distanceM: 1795.604, fallbackMaxM: 10000, searchComplete: true },
      water: { nearest: { sourceType: "coast", kind: "salt", distanceM: 2.311 }, namedRiver: { searchRadiusM: 100000, searchComplete: true }, supportingRiver: { id: "20287927", flowOrder: 6, searchRadiusM: 100000, searchComplete: true }, majorLake: { searchRadiusM: 100000, searchComplete: true } },
      provenance: { environmentSchemaVersion: "world-profile-v2", snapshotStatus: "current" }
    });
    expect(details.rawSnapshot).toEqual(dublinLookup());
  });

  it("classifies unavailable, legacy, stale, and incomplete snapshots without fake defaults", () => {
    const unavailable = buildFlagEnvironmentDetails(row(null), config());
    expect(unavailable.provenance.snapshotStatus).toBe("unavailable");
    expect(unavailable.ecology).toMatchObject({ biomeId: null, biomeName: "stored biome", resolution: null });
    expect(unavailable.water.nearest.sourceType).toBeNull();

    const empty = buildFlagEnvironmentDetails(row({}), config());
    expect(empty.provenance.snapshotStatus).toBe("unavailable");

    const legacy = buildFlagEnvironmentDetails(row({ old: "shape" }), config());
    expect(legacy.provenance.snapshotStatus).toBe("legacy");

    const staleRaw = dublinLookup();
    staleRaw.release.profile_set_fingerprint = "f".repeat(64);
    expect(buildFlagEnvironmentDetails(row(staleRaw), config()).provenance.snapshotStatus).toBe("stale");

    const incompleteRaw = dublinLookup();
    delete (incompleteRaw.profile.water as Record<string, unknown>).nearest_water_resolution;
    expect(buildFlagEnvironmentDetails(row(incompleteRaw), config()).provenance.snapshotStatus).toBe("incomplete");
  });

  it("derives honest exact ecology, nearest water, and conflict semantics from a structured v1 snapshot", () => {
    const legacy = dublinLookup();
    const profile = legacy.profile as unknown as Record<string, unknown>;
    const environment = profile.environment as Record<string, unknown>;
    profile.environment_schema_version = "world-profile-v1";
    Object.assign(environment, {
      is_land: true,
      land_cover_class: "mixed_or_mosaic"
    });
    delete environment.land_cover_conflict;
    delete environment.coastline_distance_m;
    delete environment.ecology_resolution;
    delete environment.ecology_distance_m;
    delete environment.ecology_source_package_id;
    delete environment.ecology_fallback_max_m;
    profile.water = {
      nearest_named_river_id: "rio-grande",
      nearest_named_river_name: "Rio Grande",
      river_distance_m: 178,
      major_lake_id: "jemez-canyon",
      major_lake_name: "Jemez Canyon Reservoir",
      major_lake_distance_m: 35000
    };

    const details = buildFlagEnvironmentDetails(row(legacy), config());
    expect(details.provenance).toMatchObject({
      snapshotStatus: "legacy",
      environmentSchemaVersion: "world-profile-v1"
    });
    expect(details.ecology).toMatchObject({
      resolution: "exact_legacy",
      distanceM: 0,
      sourcePackageId: "world_v1_lat53_lon-7",
      fallbackMaxM: null
    });
    expect(details.terrain.landCoverConflict).toBe(false);
    expect(details.water.nearest).toMatchObject({
      sourceType: "river",
      sourceId: "rio-grande",
      sourceName: "Rio Grande",
      kind: "fresh",
      distanceM: 178,
      resolution: "derived_legacy_candidates",
      searchRadiusM: null,
      searchComplete: null
    });
  });

  it("keeps gameplay city association distinct from geographic city identity", () => {
    const persisted = row(null);
    persisted.city_id = "player-city-id";
    persisted.gameplay_city_name = "Ash Harbor";
    const details = buildFlagEnvironmentDetails(persisted, config());

    expect(details.identity).toMatchObject({ cityId: "player-city-id", cityName: "Ash Harbor" });
    expect(details.administrative.cityId).toBeNull();
    expect(details.administrative.cityName).toBeNull();
  });

  it("reads compact gameplay environment snapshots as current structured facts", () => {
    const details = buildFlagEnvironmentDetails(row(compactGameplayEnvironment()), config());

    expect(details).toMatchObject({
      coordinates: {
        packageId: "world_v1_lat53_lon-7"
      },
      administrative: {
        countryId: "IRL",
        countryName: "Ireland",
        regionId: "IE-L",
        regionName: "Leinster"
      },
      terrain: {
        elevationM: 14,
        terrainClass: "flat",
        landCoverClass: "urban",
        isLand: true,
        isSaltwater: false,
        isCoastal: true
      },
      ecology: {
        biomeId: "4",
        biomeName: "Temperate Broadleaf & Mixed Forests",
        ecoregionId: "651",
        ecoregionName: "Celtic broadleaf forests"
      },
      provenance: {
        environmentSchemaVersion: "gameplay-environment-v1",
        snapshotStatus: "current"
      }
    });
  });
});

function config() {
  return loadConfig({
    NODE_ENV: "test",
    WORLD_REQUIRED_PROFILE_SET_FINGERPRINT: "a".repeat(64),
    WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT: "b".repeat(64)
  });
}

function row(environmentSnapshot: unknown): PersistedFlagEnvironmentRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    owner_id: "22222222-2222-4222-8222-222222222222",
    owner_username: "Ash",
    owner_color: "#38bdf8",
    name: "Flag 9",
    lat: 53.3498,
    lon: -6.2603,
    package_id: "world_v1_lat53_lon-7",
    elevation_m: 0,
    terrain_class: "flat",
    biome: "stored biome",
    ecoregion: "stored ecoregion",
    claim_radius_m: 1_000,
    city_id: null,
    environment_snapshot: environmentSnapshot,
    created_at: new Date("2026-07-13T08:00:00.000Z"),
    updated_at: new Date("2026-07-13T09:00:00.000Z")
  };
}

function dublinLookup() {
  return {
    ok: true,
    covered: true,
    release: {
      release_id: "world-packages-v1",
      profile_set_fingerprint: "a".repeat(64),
      build_contract_fingerprint: "b".repeat(64),
      boundary_release_id: "world-boundaries-v1",
      package_count: 64_800
    },
    selected_package: { package_id: "world_v1_lat53_lon-7" },
    profile: {
      environment_schema_version: "world-profile-v2",
      latitude: 53.3498,
      longitude: -6.2603,
      administrative: { country_id: "IRL", country_name: "Ireland", country_code: "IE", inside_city: false },
      environment: {
        elevation_m: 0,
        terrain_class: "flat",
        land_cover_class: "inland_water",
        source_land_cover_code: 210,
        biome_id: "4",
        biome_name: "Temperate Broadleaf & Mixed Forests",
        ecoregion_id: "651",
        ecoregion_name: "Celtic broadleaf forests",
        is_land: true,
        is_saltwater: false,
        is_coastal: true,
        coastline_distance_m: 2.311,
        coastline_search_radius_m: 100000,
        coastline_search_complete: true,
        coastal_threshold_m: 5000,
        land_cover_conflict: true,
        ecology_resolution: "nearest_land_fallback",
        ecology_distance_m: 1795.604,
        ecology_source_package_id: "world_v1_lat53_lon-7",
        ecology_fallback_max_m: 10000,
        ecology_search_complete: true
      },
      water: {
        inside_major_lake: false,
        nearest_supporting_river_id: "20287927",
        supporting_river_flow_order: 6,
        supporting_river_discharge_cms: 2.692,
        supporting_river_drainage_area_sq_km: 9.36,
        supporting_river_distance_m: 3813.225,
        nearest_water_source_type: "coast",
        nearest_water_source_kind: "salt",
        nearest_water_source_distance_m: 2.311,
        nearest_water_resolution: "within_search_radius",
        nearest_water_search_radius_m: 25000,
        nearest_water_search_complete: true,
        named_river_search_radius_m: 100000,
        named_river_search_complete: true,
        major_lake_search_radius_m: 100000,
        major_lake_search_complete: true,
        supporting_river_search_radius_m: 100000,
        supporting_river_search_complete: true,
        ocean_depth_class: "not_applicable"
      },
      derived_tags: ["coastal_ecology_inferred", "land_cover_conflict"],
      source_versions: { ecoregions: "Resolve_Ecoregions2017" },
      warnings: ["terrestrial ecology inferred from nearest RESOLVE polygon"]
    }
  };
}

function compactGameplayEnvironment() {
  return {
    ok: true,
    contract_version: "gameplay-environment-v1",
    release: {
      release_id: "world-packages-v1",
      profile_set_fingerprint: "a".repeat(64),
      build_contract_fingerprint: "b".repeat(64),
      boundary_release_id: "world-boundaries-v1",
      package_count: 64_800
    },
    runtime: {
      sha: "bd9432f46436402d8edb8b914dd2300c997508fb",
      branch: "main"
    },
    result: {
      latitude: 53.3498,
      longitude: -6.2603,
      packageId: "world_v1_lat53_lon-7",
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      isRiverbank: false,
      isLakeshore: false,
      isCoastal: true,
      isCoastalLand: true,
      elevationM: 14,
      elevationBand: "lowland",
      terrainClass: "flat",
      landCoverClass: "urban",
      biomeId: "4",
      biomeName: "Temperate Broadleaf & Mixed Forests",
      ecoregionId: "651",
      ecoregionName: "Celtic broadleaf forests",
      countryId: "IRL",
      countryName: "Ireland",
      regionId: "IE-L",
      regionName: "Leinster",
      settlementId: "dublin",
      settlementName: "Dublin",
      flagPlacementWater: {
        blocked: false,
        kind: "land",
        source_id: null,
        source_name: null,
        distance_m: null,
        corridor_radius_m: null,
        reason: "authoritative land",
        resolution: "water-placement-surface-v1",
        release_id: "world-packages-v1"
      }
    }
  };
}

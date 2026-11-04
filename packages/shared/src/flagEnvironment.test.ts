import { describe, expect, it } from "vitest";

import {
  normalizeFlagEnvironmentDiagnostics,
  flagEnvironmentDetailsSchema,
  normalizeFlagEnvironmentDetails
} from "./flagEnvironment.js";

describe("flagEnvironmentDetailsSchema", () => {
  it("accepts a comprehensive, JSON-safe flag environment", () => {
    const details = currentDetails();
    expect(normalizeFlagEnvironmentDetails(JSON.parse(JSON.stringify(details)))).toEqual(details);
  });

  it("rejects malformed finite values and unknown snapshot states", () => {
    expect(
      flagEnvironmentDetailsSchema.safeParse({
        ...currentDetails(),
        terrain: { ...currentDetails().terrain, coastlineDistanceM: Number.NaN }
      }).success
    ).toBe(false);
    expect(
      flagEnvironmentDetailsSchema.safeParse({
        ...currentDetails(),
        provenance: { ...currentDetails().provenance, snapshotStatus: "fresh" }
      }).success
    ).toBe(false);
  });

  it("accepts a stored-versus-live diagnostics payload", () => {
    const stored = currentDetails();
    const live = {
      ...stored,
      provenance: { ...stored.provenance, snapshotStatus: "current" as const }
    };
    const diagnostics = {
      stored,
      live: {
        details: live,
        rawLookup: { timing: { cache: "warm" } },
        lookupStartedAt: "2026-07-13T08:01:00.000Z",
        durationMs: 12.5,
        packageCacheState: "warm"
      },
      comparison: [{
        path: "provenance.environmentSchemaVersion",
        label: "Provenance / Environment Schema Version",
        kind: "changed" as const,
        stored: "world-profile-v1",
        live: "world-profile-v2"
      }],
      required: {
        environmentSchemaVersion: "world-profile-v2",
        worldReleaseId: "world-packages-v1",
        profileSetFingerprint: "a".repeat(64),
        buildContractFingerprint: "b".repeat(64),
        boundaryReleaseId: "world-boundaries-v1"
      },
      refreshRecommended: true
    };
    expect(normalizeFlagEnvironmentDiagnostics(JSON.parse(JSON.stringify(diagnostics)))).toEqual(diagnostics);
  });
});

function currentDetails() {
  return {
    identity: {
      flagId: "11111111-1111-4111-8111-111111111111",
      flagName: "Flag 9",
      ownerId: "22222222-2222-4222-8222-222222222222",
      ownerName: "Ash",
      ownerColor: "#38bdf8",
      createdAt: "2026-07-13T08:00:00.000Z",
      claimRadiusM: 1_000,
      cityId: null
    },
    coordinates: {
      latitude: 53.3498,
      longitude: -6.2603,
      packageId: "world_v1_lat53_lon-7"
    },
    administrative: {
      countryId: "IRL",
      countryName: "Ireland",
      countryCode: "IE",
      regionId: null,
      regionName: null,
      regionCode: null,
      cityId: null,
      cityName: null,
      insideCity: false,
      cityBoundaryDistanceM: 3_200
    },
    terrain: {
      elevationM: 0,
      terrainClass: "flat",
      landCoverClass: "inland_water",
      sourceLandCoverCode: 210,
      isLand: true,
      isSaltwater: false,
      isCoastal: true,
      coastlineDistanceM: 2.311,
      landCoverConflict: true
    },
    ecology: {
      biomeId: "4",
      biomeName: "Temperate Broadleaf & Mixed Forests",
      ecoregionId: "651",
      ecoregionName: "Celtic broadleaf forests",
      resolution: "nearest_land_fallback" as const,
      distanceM: 1_795.604,
      sourcePackageId: "world_v1_lat53_lon-7",
      fallbackMaxM: 10_000
    },
    water: {
      nearest: {
        sourceType: "coast",
        sourceId: null,
        sourceName: null,
        kind: "salt" as const,
        distanceM: 2.311,
        resolution: "within_search_radius",
        searchRadiusM: 25_000,
        searchComplete: true
      },
      namedRiver: { id: null, name: null, riverClass: null, distanceM: null, searchRadiusM: 100_000, searchComplete: true },
      supportingRiver: {
        id: "20287927",
        flowOrder: 6,
        dischargeCms: 2.692,
        drainageAreaSqKm: 9.36,
        distanceM: 3_813.225,
        searchRadiusM: 100_000,
        searchComplete: true
      },
      majorLake: { id: null, name: null, inside: false, distanceM: null, searchRadiusM: 100_000, searchComplete: true },
      oceanDepthClass: "not_applicable"
    },
    provenance: {
      worldReleaseId: "world-packages-v1",
      profileSetFingerprint: "a".repeat(64),
      buildContractFingerprint: "b".repeat(64),
      boundaryReleaseId: "world-boundaries-v1",
      environmentSchemaVersion: "world-profile-v2",
      sourceVersions: { ecoregions: "Resolve_Ecoregions2017" },
      derivedTags: ["coastal_ecology_inferred", "land_cover_conflict"],
      warnings: ["terrestrial ecology inferred from nearest RESOLVE polygon"],
      snapshotStatus: "current" as const,
      snapshotStatusReason: "The snapshot matches the required world release and schema.",
      snapshotUpdatedAt: "2026-07-13T08:00:00.000Z"
    },
    rawSnapshot: { ok: true }
  };
}

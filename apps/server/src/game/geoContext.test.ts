import { describe, expect, it, vi } from "vitest";

import {
  evaluateGeoPredicate,
  waterTypeIs,
  waterbodyIs,
  withinDistanceOfWaterbody
} from "@ash-atlas/shared";

import {
  geoContextFromPersisted,
  geoContextFromWorldEnvironment,
  resolveGeoContextAt,
  resolveGeoContextsAt
} from "./geoContext.js";
import type { CanonicalWaterbodyLookup } from "../world/worldLookupClient.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";

const RIO_ID = "4bdb931c-d880-5cb0-b8b2-e9c8c220e83a";

function world(overrides: Record<string, unknown> = {}): WorldGameplayEnvironmentResult {
  return {
    ok: true,
    contractVersion: "gameplay-environment-v1",
    runtime: null,
    packageId: "world_v1_lat35_lon-106",
    latitude: 35.0844,
    longitude: -106.6504,
    countryId: "world-country-united-states",
    countryName: "United States",
    countryCode: "US",
    regionId: "world-admin1-new-mexico",
    regionName: "New Mexico",
    regionCode: "NM",
    cityId: null,
    cityName: null,
    settlementId: "settlement-albuquerque",
    settlementName: "Albuquerque",
    isLand: false,
    isSaltwater: false,
    isCoastalLand: false,
    insideMajorLake: false,
    majorLakeId: null,
    majorLakeName: null,
    majorLakeDistanceM: null,
    elevationBand: null,
    biomeName: null,
    ecoregionName: null,
    namedRiverId: null,
    namedRiverName: null,
    riverClass: null,
    riverDistanceM: 0,
    supportingRiverId: null,
    supportingRiverFlowOrder: null,
    supportingRiverDischargeCms: null,
    supportingRiverDrainageAreaSqKm: null,
    supportingRiverDistanceM: null,
    flagPlacementWater: null,
    surfaceKind: "water",
    waterKind: "river",
    waterbodyIdentity: {
      canonicalWaterbodyId: RIO_ID,
      gameplayWaterType: "river",
      displayName: "Rio Grande",
      resolutionStatus: "resolved",
      candidateCount: 1,
      parentCanonicalWaterbodyId: null
    },
    waterNameFallback: null,
    raw: null,
    ...overrides
  } as WorldGameplayEnvironmentResult;
}

function candidate(overrides: Partial<CanonicalWaterbodyLookup> = {}): CanonicalWaterbodyLookup {
  return {
    kind: "river",
    sourceId: RIO_ID,
    sourceName: "Rio Grande",
    distanceM: 0,
    searchComplete: true,
    resolutionStatus: "resolved",
    sourceRevision: "world-release",
    ...overrides
  };
}

describe("World GeoContext adapter", () => {
  it("preserves Albuquerque's authoritative river, canonical ID, and admin IDs", () => {
    const context = geoContextFromWorldEnvironment(world());
    expect(context).toMatchObject({
      latitude: 35.0844,
      longitude: -106.6504,
      country: { id: "world-country-united-states", name: "United States", resolutionState: "resolved" },
      admin1: { id: "world-admin1-new-mexico", name: "New Mexico", resolutionState: "resolved" },
      water: {
        gameplayWaterType: "river",
        canonicalWaterbodyId: RIO_ID,
        canonicalDisplayName: "Rio Grande",
        resolutionState: "resolved",
        presentationName: "Rio Grande",
        presentationRelation: "exact",
        presentationDistanceM: 0
      }
    });
    expect(evaluateGeoPredicate(context, waterTypeIs("river"))).toBe(true);
    expect(evaluateGeoPredicate(context, waterbodyIs(RIO_ID))).toBe(true);
  });

  it("keeps Romey unresolved while accepting only the presentation fallback", () => {
    const context = geoContextFromWorldEnvironment(world({
      isLand: true,
      waterKind: "river",
      waterbodyIdentity: {
        canonicalWaterbodyId: null,
        gameplayWaterType: "river",
        displayName: null,
        resolutionStatus: "unresolved",
        candidateCount: 1,
        parentCanonicalWaterbodyId: null
      },
      waterNameFallback: {
        name: "Grand River",
        waterClass: "river",
        distanceM: 8,
        authority: "water-names-v1",
        referenceId: "grand-river-name"
      }
    }));
    expect(context.water).toMatchObject({
      gameplayWaterType: "river",
      canonicalWaterbodyId: null,
      resolutionState: "unresolved",
      presentationName: "Grand River",
      presentationRelation: "near",
      presentationDistanceM: 8
    });
    expect(evaluateGeoPredicate(context, waterbodyIs("grand-river-name"))).toBe(false);
  });

  it("keeps offshore political/admin fields independent from a mapped marine parent", () => {
    const context = geoContextFromWorldEnvironment(world({
      countryId: null,
      countryName: null,
      regionId: null,
      regionName: null,
      settlementId: null,
      settlementName: null,
      isLand: false,
      isSaltwater: true,
      waterKind: "ocean",
      waterbodyIdentity: {
        canonicalWaterbodyId: "gulf-of-mexico-canonical",
        gameplayWaterType: "ocean",
        displayName: "Gulf of Mexico",
        resolutionStatus: "resolved",
        candidateCount: 1,
        parentCanonicalWaterbodyId: "north-atlantic-canonical"
      }
    }));
    expect(context.country.id).toBeNull();
    expect(context.admin1.id).toBeNull();
    expect(context.water).toMatchObject({
      gameplayWaterType: "ocean",
      canonicalWaterbodyId: "gulf-of-mexico-canonical",
      marineParentId: "north-atlantic-canonical"
    });
  });

  it("rebuilds durable context without making a lookup during catch mapping", () => {
    const persisted = geoContextFromPersisted({
      latitude: 35.0844,
      longitude: -106.6504,
      countryId: "world-country-united-states",
      countryName: "United States",
      admin1Id: "world-admin1-new-mexico",
      admin1Name: "New Mexico",
      gameplayWaterType: "river",
      canonicalWaterbodyId: RIO_ID,
      canonicalDisplayName: "Rio Grande",
      waterbodyResolutionState: "resolved",
      presentationName: "Rio Grande",
      presentationRelation: "exact",
      presentationDistanceM: 0
    });
    expect(persisted).not.toBeNull();
    expect(evaluateGeoPredicate(persisted!, withinDistanceOfWaterbody(RIO_ID, 0))).toBe(true);
  });

  it("does not promote a retained unresolved display name into canonical identity", () => {
    const persisted = geoContextFromPersisted({
      latitude: 35.0844,
      longitude: -106.6504,
      gameplayWaterType: "river",
      canonicalWaterbodyId: "stale-unresolved-id",
      canonicalDisplayName: "Grand River",
      waterbodyResolutionState: "unresolved"
    });
    expect(persisted?.water).toMatchObject({
      canonicalWaterbodyId: null,
      canonicalDisplayName: null,
      resolutionState: "unresolved",
      presentationName: null,
      presentationRelation: "unnamed"
    });
  });
});

describe("indexed World context resolution", () => {
  it("uses the existing cache/batch client and does not fail the base context if proximity is unavailable", async () => {
    const lookupGameplayEnvironment = vi.fn(async () => world());
    const lookupCanonicalWaterbodiesNear = vi.fn(async () => [candidate({ distanceM: 120 })]);
    const client = { lookupGameplayEnvironment, lookupCanonicalWaterbodiesNear };
    const context = await resolveGeoContextAt(client, { lat: 35.0844, lon: -106.6504 }, { proximityRadiusM: 500 });
    expect(lookupGameplayEnvironment).toHaveBeenCalledTimes(1);
    expect(lookupCanonicalWaterbodiesNear).toHaveBeenCalledTimes(1);
    expect(evaluateGeoPredicate(context, withinDistanceOfWaterbody(RIO_ID, 120))).toBe(true);

    const failingClient = {
      lookupGameplayEnvironment: vi.fn(async () => world({ waterNameFallback: null })),
      lookupCanonicalWaterbodiesNear: vi.fn(async () => { throw new Error("temporary index failure"); })
    };
    await expect(resolveGeoContextAt(failingClient, { lat: 35.0844, lon: -106.6504 }, { proximityRadiusM: 500 }))
      .resolves.toMatchObject({ water: { canonicalWaterbodyId: RIO_ID } });
  });

  it("offers a batch context API for multiple gameplay events", async () => {
    const client = {
      lookupGameplayEnvironments: vi.fn(async (points: readonly { lat: number; lon: number }[]) =>
        points.map((point) => world({ latitude: point.lat, longitude: point.lon }))
      ),
      lookupCanonicalWaterbodiesNear: vi.fn(async () => [candidate({ distanceM: 10 })])
    };
    const contexts = await resolveGeoContextsAt(client, [
      { lat: 35.0844, lon: -106.6504 },
      { lat: 35.1, lon: -106.7 }
    ], { proximityRadiusM: 50 });
    expect(contexts).toHaveLength(2);
    expect(client.lookupGameplayEnvironments).toHaveBeenCalledTimes(1);
    expect(client.lookupCanonicalWaterbodiesNear).toHaveBeenCalledTimes(2);
  });
});

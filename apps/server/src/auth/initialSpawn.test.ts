import { describe, expect, it } from "vitest";

import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import {
  INITIAL_SPAWN_ALGORITHM_VERSION,
  InitialSpawnSampler,
  type InitialSpawnError,
  type InitialSpawnWorldAuthority
} from "./initialSpawn.js";

const CREATED_AT = new Date("2026-01-02T03:04:05.000Z");
const SECRET = "spawn-test-secret-aaaaaaaaaaaaaaaa";

describe("InitialSpawnSampler", () => {
  it("is deterministic from only the versioned server seed inputs", async () => {
    const first = sampler(landAuthority());
    const second = sampler(landAuthority());
    const input = {
      accountId: "00000000-0000-4000-8000-000000000001",
      accountCreatedAt: CREATED_AT
    };

    const assignment = await first.assign(input);
    const replay = await second.assign(input);

    expect(replay.position).toEqual(assignment.position);
    expect(replay.region).toBe(assignment.region);
    expect(assignment.algorithmVersion).toBe(INITIAL_SPAWN_ALGORITHM_VERSION);
    expect(assignment.position).not.toEqual({ lat: 0, lon: 0 });
    expect(Number.isFinite(assignment.position.lat)).toBe(true);
    expect(Number.isFinite(assignment.position.lon)).toBe(true);
  });

  it("uses immutable account id as collision salt for identical creation times", async () => {
    const spawnSampler = sampler(landAuthority());
    const [left, right] = await Promise.all([
      spawnSampler.assign({
        accountId: "00000000-0000-4000-8000-000000000001",
        accountCreatedAt: CREATED_AT
      }),
      spawnSampler.assign({
        accountId: "00000000-0000-4000-8000-000000000002",
        accountCreatedAt: CREATED_AT
      })
    ]);

    expect(right.position).not.toEqual(left.position);
  });

  it("rejects water and non-US candidates before accepting authoritative US land", async () => {
    let calls = 0;
    const spawnSampler = sampler({
      async lookupGameplayEnvironment(lat, lon) {
        calls += 1;
        if (calls === 1) return environment(lat, lon, { water: true });
        if (calls === 2) return environment(lat, lon, { countryCode: "CA" });
        if (calls === 3) return environment(lat + 0.001, lon);
        return environment(lat, lon);
      }
    });

    const result = await spawnSampler.assign({
      accountId: "00000000-0000-4000-8000-000000000003",
      accountCreatedAt: CREATED_AT
    });

    expect(result.rejectedCandidates).toBe(3);
    expect(calls).toBe(4);
  });

  it("fails closed when world authority is unavailable or no valid land is found", async () => {
    const unavailable = sampler({
      async lookupGameplayEnvironment(lat, lon) {
        return {
          ...environment(lat, lon),
          ok: false,
          failure: {
            code: "WORLD_AUTHORITY_UNAVAILABLE",
            message: "offline",
            retryable: true
          }
        };
      }
    });
    await expect(unavailable.assign({
      accountId: "00000000-0000-4000-8000-000000000004",
      accountCreatedAt: CREATED_AT
    })).rejects.toEqual(expect.objectContaining<Partial<InitialSpawnError>>({
      reason: "WORLD_AUTHORITY_UNAVAILABLE"
    }));

    const exhausted = sampler(landAuthority({ water: true }), 3);
    await expect(exhausted.assign({
      accountId: "00000000-0000-4000-8000-000000000005",
      accountCreatedAt: CREATED_AT
    })).rejects.toEqual(expect.objectContaining<Partial<InitialSpawnError>>({
      reason: "MAXIMUM_ATTEMPTS_EXHAUSTED"
    }));
    expect(exhausted.metricsSnapshot()).toMatchObject({
      successfulAssignments: 0,
      failedAssignments: 1,
      rejectedCandidates: 3
    });
  });

  it("deterministically reaches contiguous land, Alaska, Hawaii, remote Aleutians, and D.C.", async () => {
    const spawnSampler = sampler(landAuthority());
    const cases = [
      ["00000000-0000-4000-8000-000000000000", "contiguous-us", "US-NM"],
      ["00000000-0000-4000-8000-000000000008", "alaska", "US-AK"],
      ["00000000-0000-4000-8000-0000000000f0", "hawaii", "US-HI"],
      ["00000000-0000-4000-8000-000000000123", "alaska-west-aleutians", "US-AK"],
      ["00000000-0000-4000-8000-00000000bce7", "contiguous-us", "US-DC"]
    ] as const;

    for (const [accountId, expectedRegion, expectedState] of cases) {
      const result = await spawnSampler.assign({ accountId, accountCreatedAt: CREATED_AT });
      expect(result.region).toBe(expectedRegion);
      expect(result.stateCode).toBe(expectedState);
    }
  });

  it("runs a fixed 10000-account corpus with area weighting and finite in-bounds land", async () => {
    const spawnSampler = sampler(landAuthority());
    const counts = new Map<string, number>();
    for (let index = 0; index < 10_000; index += 1) {
      const accountId =
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      const result = await spawnSampler.assign({ accountId, accountCreatedAt: CREATED_AT });
      expect(result.position.lat).toBeGreaterThanOrEqual(-90);
      expect(result.position.lat).toBeLessThanOrEqual(90);
      expect(result.position.lon).toBeGreaterThanOrEqual(-180);
      expect(result.position.lon).toBeLessThanOrEqual(180);
      counts.set(result.region, (counts.get(result.region) ?? 0) + 1);
    }

    expect(counts.get("contiguous-us")).toBeGreaterThan(5_000);
    expect(counts.get("alaska")).toBeGreaterThan(1_000);
    expect(counts.get("hawaii")).toBeGreaterThan(20);
    expect(counts.get("alaska-west-aleutians")).toBeGreaterThan(10);
    expect(new Set(counts.values()).size).toBeGreaterThan(1);
    expect(spawnSampler.metricsSnapshot().successfulAssignments).toBe(10_000);
  });
});

function sampler(
  world: InitialSpawnWorldAuthority,
  maximumAttempts = 256
): InitialSpawnSampler {
  return new InitialSpawnSampler({
    INITIAL_SPAWN_HMAC_KEY: SECRET,
    INITIAL_SPAWN_MAX_ATTEMPTS: maximumAttempts,
    WORLD_ID: "world-v1",
    WORLD_REQUIRED_RELEASE_ID: "world-release-v1",
    WORLD_REQUIRED_BOUNDARY_RELEASE_ID: "boundary-release-v1"
  }, world);
}

function landAuthority(
  options: { water?: boolean; countryCode?: string } = {}
): InitialSpawnWorldAuthority {
  return {
    async lookupGameplayEnvironment(lat, lon) {
      return environment(lat, lon, options);
    }
  };
}

function environment(
  lat: number,
  lon: number,
  options: { water?: boolean; countryCode?: string } = {}
): WorldGameplayEnvironmentResult {
  const water = options.water ?? false;
  return {
    ok: true,
    contractVersion: "gameplay-environment-v1",
    runtime: { sha: "a".repeat(40), branch: "integration/test" },
    packageId: "package",
    latitude: lat,
    longitude: lon,
    countryId: "country-us",
    countryName: "United States",
    countryCode: options.countryCode ?? "US",
    regionId: stateCode(lat, lon),
    regionName: stateCode(lat, lon),
    regionCode: stateCode(lat, lon),
    cityId: null,
    cityName: null,
    insideCity: false,
    elevationM: water ? -1 : 10,
    elevationBand: water ? "water" : "low",
    terrainClass: water ? "water" : "land",
    landCoverClass: water ? "inland_water" : "forest",
    biome: water ? null : "temperate",
    biomeName: water ? null : "temperate",
    ecoregion: water ? null : "test",
    ecoregionName: water ? null : "test",
    isLand: !water,
    isSaltwater: false,
    isCoastalLand: false,
    isRiverbank: false,
    isLakeshore: false,
    insideMajorLake: water,
    majorLakeId: water ? "lake" : null,
    majorLakeName: water ? "Lake" : null,
    majorLakeDistanceM: water ? 0 : null,
    settlementId: null,
    settlementName: null,
    namedRiverId: null,
    namedRiverName: null,
    riverClass: null,
    riverDistanceM: null,
    supportingRiverId: null,
    supportingRiverFlowOrder: null,
    supportingRiverDischargeCms: null,
    supportingRiverDrainageAreaSqKm: null,
    supportingRiverDistanceM: null,
    flagPlacementWater: {
      blocked: water,
      kind: water ? "lake" : "land",
      sourceId: water ? "lake" : null,
      sourceName: water ? "Lake" : null,
      distanceM: water ? 0 : null,
      corridorRadiusM: null,
      reason: water ? "water" : "authoritative land",
      resolution: "test-mask-v1",
      releaseId: "world-release-v1"
    },
    release: {
      releaseId: "world-release-v1",
      profileSetFingerprint: "profiles",
      buildContractFingerprint: "contract",
      boundaryReleaseId: "boundary-release-v1",
      packageCount: 1
    },
    environmentSchemaVersion: "environment-v1",
    raw: {}
  };
}

function stateCode(lat: number, lon: number): string {
  if (lat >= 38.79 && lat <= 38.995 && lon >= -77.12 && lon <= -76.91) return "US-DC";
  if (lat >= 51 || lon >= 170) return "US-AK";
  if (lat <= 22.6 && lon >= -160.7 && lon <= -154.7) return "US-HI";
  return "US-NM";
}

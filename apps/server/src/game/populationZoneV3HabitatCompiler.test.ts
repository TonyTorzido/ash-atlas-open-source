import type { LatLon } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import {
  WorldBatchBackpressureError,
  WorldBatchLookupError
} from "../world/worldLookupClient.js";
import {
  worldEnvironmentIdentityKey,
  worldEnvironmentProfileRequestForPoint
} from "./gameplayEnvironmentProfiles.js";
import {
  PopulationZoneV3HabitatCompiler
} from "./populationZoneV3HabitatCompiler.js";
import {
  populationZoneV2Geometry,
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import {
  generatePopulationZonesV2Plans,
  type GeneratedPopulationZoneV2Plan,
  POPULATION_ZONE_V2_HABITAT_SAMPLE_COUNT,
  POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT,
  type PopulationZoneV2Habitat,
  populationZoneV2HabitatSamplePoints,
  populationZoneV2PlanningHabitatZoneIds,
  populationZoneV2PlanContentHash,
  populationZoneV3ConservativeHabitat,
  populationZoneV3CompactHabitatSamplePoints
} from "./populationZonesV2Plan.js";
import { populationZoneV2CanonicalRegionCode } from "./populationZonesV2Planner.js";

const WORLD_IDENTITY = {
  releaseId: "world-packages-v1",
  profileSetFingerprint: "a".repeat(64),
  buildContractFingerprint: "b".repeat(64),
  boundaryReleaseId: "world-boundaries-v1"
};
const WORLD_IDENTITY_KEY = worldEnvironmentIdentityKey(WORLD_IDENTITY);
const WORLD_SHA = "c".repeat(40);
const DENVER_ZONE = populationZoneV2IdForPoint({
  lat: 39.7392,
  lon: -104.9903
});

describe("PopulationZoneV3HabitatCompiler", () => {
  it("uses exactly 48 deterministic samples and one compact World batch", async () => {
    const lookup = vi.fn(async (points: readonly LatLon[]) =>
      points.map((point) => compactResult(point))
    );
    const compiler = new PopulationZoneV3HabitatCompiler({
      lookupGameplayEnvironments: lookup
    });

    const habitat = await compiler.compileZone({
      zoneId: DENVER_ZONE,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      regionCode: "test"
    });

    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0]?.[0]).toHaveLength(48);
    expect(habitat.habitatSummary).toMatchObject({
      requestedSamples: 48,
      uniqueSamples: 48,
      compactBatchCalls: 1
    });
  });

  it("keeps every representative geography at the normal and absolute bounds", () => {
    const locations = [
      { lat: 25.7617, lon: -80.1918 },
      { lat: 29.9511, lon: -90.0715 },
      { lat: 31.7683, lon: -106.501 },
      { lat: 39.7392, lon: -104.9903 },
      { lat: 47.6062, lon: -122.3321 },
      { lat: 64.1466, lon: -21.9426 },
      { lat: 78.2232, lon: 15.6469 },
      { lat: -45.0312, lon: 168.6626 },
      { lat: 0, lon: 179.999 },
      { lat: 0, lon: -179.999 }
    ];

    for (const position of locations) {
      const samples = populationZoneV3CompactHabitatSamplePoints({
        zoneId: populationZoneV2IdForPoint(position),
        worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
      });
      expect(samples).toHaveLength(POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT);
      expect(samples.length).toBeLessThanOrEqual(64);
      expect(samples.length).toBeLessThanOrEqual(96);
      expect(new Set(samples.map((sample) => sample.sampleKey)).size)
        .toBe(samples.length);
    }
  });

  it("retries a failed compact batch once and never exceeds two calls", async () => {
    const lookup = vi.fn()
      .mockRejectedValueOnce(new Error("temporary World failure"))
      .mockImplementationOnce(async (points: readonly LatLon[]) =>
        points.map((point) => compactResult(point))
      );
    const compiler = new PopulationZoneV3HabitatCompiler(
      { lookupGameplayEnvironments: lookup },
      { retryBaseMs: 1 }
    );

    await compiler.compileZone({
      zoneId: DENVER_ZONE,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      regionCode: "test"
    });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(compiler.snapshot().zones[0]).toMatchObject({
      state: "ready",
      batchCalls: 2
    });
  });

  it("honors World Retry-After before its single bounded retry", async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn()
        .mockRejectedValueOnce(new WorldBatchBackpressureError(
          "World materializer busy",
          1_000,
          503
        ))
        .mockImplementationOnce(async (points: readonly LatLon[]) =>
          points.map((point) => compactResult(point))
        );
      const compiler = new PopulationZoneV3HabitatCompiler(
        { lookupGameplayEnvironments: lookup },
        { retryBaseMs: 1, retryBudgetMs: 2_000 }
      );

      const compilation = compiler.compileZone({
        zoneId: DENVER_ZONE,
        worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
        regionCode: "test"
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(lookup).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await compilation;

      expect(lookup).toHaveBeenCalledTimes(2);
      expect(lookup.mock.calls[0]?.[1]).toMatchObject({
        caller: "population-plan"
      });
      expect(compiler.snapshot().zones[0]).toMatchObject({
        state: "ready",
        batchCalls: 2,
        backpressureRetries: 1
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("singleflights identical concurrent sample work without Promise fan-out", async () => {
    let release!: () => void;
    const lookup = vi.fn(async (points: readonly LatLon[]) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return points.map((point) => compactResult(point));
    });
    const compiler = new PopulationZoneV3HabitatCompiler({
      lookupGameplayEnvironments: lookup
    });
    const input = {
      zoneId: DENVER_ZONE,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      regionCode: "test"
    } as const;
    const first = compiler.compileZone(input);
    const second = compiler.compileZone(input);

    await waitFor(() => lookup.mock.calls.length === 1);
    expect(compiler.snapshot().inFlightSamples).toBe(48);
    release();
    await Promise.all([first, second]);

    expect(lookup).toHaveBeenCalledOnce();
    expect(compiler.snapshot().inFlightSamples).toBe(0);
  });

  it("reuses canonical shared edge samples between adjacent owner zones", async () => {
    const firstGeometry = populationZoneV2Geometry(DENVER_ZONE);
    const adjacentZone = populationZoneV2IdForPoint({
      lat: firstGeometry.center.lat,
      lon: firstGeometry.bounds.eastLon + 0.000001
    });
    const firstSamples = populationZoneV3CompactHabitatSamplePoints({
      zoneId: DENVER_ZONE,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
    });
    const adjacentSamples = populationZoneV3CompactHabitatSamplePoints({
      zoneId: adjacentZone,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
    });
    const shared = adjacentSamples.filter((sample) =>
      firstSamples.some((candidate) => candidate.sampleKey === sample.sampleKey)
    );
    expect(shared.length).toBeGreaterThan(0);

    const lookup = vi.fn(async (points: readonly LatLon[]) =>
      points.map((point) => compactResult(point))
    );
    const compiler = new PopulationZoneV3HabitatCompiler({
      lookupGameplayEnvironments: lookup
    });
    await compiler.compileZone({
      zoneId: DENVER_ZONE,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      regionCode: "test"
    });
    await compiler.compileZone({
      zoneId: adjacentZone,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      regionCode: "test"
    });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[1]?.[0].length)
      .toBe(POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT - shared.length);
    expect(compiler.snapshot().zones.find((zone) =>
      zone.zoneId === adjacentZone
    )?.cacheHits).toBe(shared.length);
  });

  it("bounds its LRU cache while compiling many different zones", async () => {
    const compiler = new PopulationZoneV3HabitatCompiler(
      {
        lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[]) =>
          points.map((point) => compactResult(point))
        )
      },
      { cacheMaximum: 64 }
    );

    for (let index = 0; index < 6; index += 1) {
      await compiler.compileZone({
        zoneId: populationZoneV2IdForPoint({
          lat: 35 + index,
          lon: -110 + index
        }),
        worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
        regionCode: "test"
      });
    }

    expect(compiler.snapshot().cacheEntries).toBe(64);
    expect(compiler.snapshot().inFlightSamples).toBe(0);
  });

  it("isolates protected locality samples from global backfill churn", async () => {
    const lookup = vi.fn(async (points: readonly LatLon[]) =>
      points.map((point) => compactResult(point)));
    const compiler = new PopulationZoneV3HabitatCompiler(
      { lookupGameplayEnvironments: lookup },
      { cacheMaximum: POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT }
    );
    const protectedZone = populationZoneV2IdForPoint({ lat: 35, lon: -110 });

    await compiler.compileZone({
      zoneId: protectedZone,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      regionCode: "test",
      cacheClass: "protected"
    });
    for (let index = 0; index < 3; index += 1) {
      await compiler.compileZone({
        zoneId: populationZoneV2IdForPoint({
          lat: 45 + index,
          lon: -100 + index
        }),
        worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
        regionCode: "background",
        cacheClass: "probationary"
      });
    }
    await compiler.compileZone({
      zoneId: protectedZone,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      regionCode: "test",
      cacheClass: "protected"
    });

    expect(lookup).toHaveBeenCalledTimes(4);
    expect(compiler.snapshot()).toMatchObject({
      protectedCacheEntries: POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT,
      probationaryCacheEntries: 12,
      cacheMetrics: {
        protectedHits: POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT,
        protectedEvictions: 0
      }
    });
    expect(compiler.snapshot().cacheMetrics.probationaryEvictions)
      .toBeGreaterThan(0);
  });

  it("fails closed for incomplete facts or the wrong immutable World identity", async () => {
    const compiler = new PopulationZoneV3HabitatCompiler({
      lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[]) =>
        points.map((point, index) => index === 0
          ? { ...compactResult(point), isLand: null }
          : {
              ...compactResult(point),
              release: {
                ...compactResult(point).release!,
                releaseId: "wrong-release"
              }
            })
      )
    }, { maximumBatchAttempts: 1 });

    await expect(compiler.compileZone({
      zoneId: DENVER_ZONE,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      regionCode: "test"
    })).rejects.toThrow("authoritative land/water facts");
  });

  it("documents the old >2,000-profile dependency explosion and the v3 bound", () => {
    const productionShapeZone = populationZoneV2IdForPoint({
      lat: 48.528,
      lon: -78.890
    });
    const oldHabitatZones = populationZoneV2PlanningHabitatZoneIds(
      [productionShapeZone],
      3
    );
    const oldSamples = oldHabitatZones.flatMap((zoneId) =>
      populationZoneV2HabitatSamplePoints({
        zoneId,
        worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
        sampleCount: POPULATION_ZONE_V2_HABITAT_SAMPLE_COUNT
      })
    );
    const uniqueProfileKeys = new Set(oldSamples.map((sample) =>
      worldEnvironmentProfileRequestForPoint({
        position: sample.position,
        regionCode: "test",
        worldIdentity: WORLD_IDENTITY,
        sourceRuntimeSha: WORLD_SHA
      }).cellId
    ));
    const compactSamples = populationZoneV3CompactHabitatSamplePoints({
      zoneId: productionShapeZone,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
    });

    expect(oldHabitatZones.length).toBeGreaterThan(60);
    expect(oldSamples.length).toBeGreaterThan(3_000);
    expect(uniqueProfileKeys.size).toBeGreaterThan(2_000);
    expect(compactSamples).toHaveLength(48);
  });

  it("prefetches one six-zone destination without touching compiler state", async () => {
    const lookup = vi.fn(async (points: readonly LatLon[]) =>
      points.map((point) => compactResult(point))
    );
    const compiler = new PopulationZoneV3HabitatCompiler({
      lookupGameplayEnvironments: lookup
    });

    const result = await compiler.prefetchWorldEnvironmentForZones({
      zoneIds: destinationZoneIds(),
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      priority: 0
    });

    expect(destinationZoneIds()).toHaveLength(6);
    expect(result).toMatchObject({
      sampleReferences: 288,
      uniqueSamples: 280,
      sentPointCount: 280,
      chunkCount: 1,
      chunkSizes: [280],
      upstreamBatchCalls: 1
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0]?.[0]).toHaveLength(280);
    expect(compiler.snapshot()).toMatchObject({
      cacheEntries: 0,
      inFlightSamples: 0,
      zones: []
    });
  });

  it("reports a fully World-cached destination without an upstream call", async () => {
    let metrics = { hits: 0, batchUpstreamAttempts: 0, batchPoints: 0 };
    const world = {
      lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[]) => {
        metrics = { ...metrics, hits: metrics.hits + points.length };
        return points.map((point) => compactResult(point));
      }),
      gameplayEnvironmentMetrics: () => metrics
    };
    const result = await new PopulationZoneV3HabitatCompiler(world)
      .prefetchWorldEnvironmentForZones({
        zoneIds: destinationZoneIds(),
        worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
      });

    expect(result).toMatchObject({
      worldCacheHits: 280,
      sentPointCount: 0,
      upstreamBatchCalls: 0
    });
  });

  it("uses deterministic minimum chunks when unique points exceed 512", async () => {
    const zoneIds = manyZoneIds();
    const firstCalls: LatLon[][] = [];
    const secondCalls: LatLon[][] = [];
    const create = (calls: LatLon[][]) => new PopulationZoneV3HabitatCompiler({
      lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[]) => {
        calls.push([...points]);
        return points.map((point) => compactResult(point));
      })
    });
    const first = await create(firstCalls).prefetchWorldEnvironmentForZones({
      zoneIds,
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
    });
    const second = await create(secondCalls).prefetchWorldEnvironmentForZones({
      zoneIds: [...zoneIds].reverse(),
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
    });

    expect(first.uniqueSamples).toBeGreaterThan(512);
    expect(first.chunkCount).toBe(Math.ceil(first.uniqueSamples / 512));
    expect(first.chunkSizes.every((size) => size <= 512)).toBe(true);
    expect(second.chunkSizes).toEqual(first.chunkSizes);
    expect(secondCalls).toEqual(firstCalls);
  });

  it("shares Retry-After policy with normal compiles", async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn()
        .mockRejectedValueOnce(new WorldBatchBackpressureError(
          "World busy",
          1_000,
          503
        ))
        .mockImplementationOnce(async (points: readonly LatLon[]) =>
          points.map((point) => compactResult(point))
        );
      const operation = new PopulationZoneV3HabitatCompiler(
        { lookupGameplayEnvironments: lookup },
        { retryBaseMs: 1, retryBudgetMs: 2_000 }
      ).prefetchWorldEnvironmentForZones({
        zoneIds: destinationZoneIds(),
        worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(lookup).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      const result = await operation;
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(result.backpressureRetries).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries temporary World unavailability without treating it as terminal", async () => {
    const lookup = vi.fn()
      .mockRejectedValueOnce(new WorldBatchLookupError(
        "gameplay environment batch authority is unavailable"
      ))
      .mockImplementationOnce(async (points: readonly LatLon[]) =>
        points.map((point) => compactResult(point))
      );

    const result = await new PopulationZoneV3HabitatCompiler(
      { lookupGameplayEnvironments: lookup },
      { retryBaseMs: 1, retryBudgetMs: 10 }
    ).prefetchWorldEnvironmentForZones({
      zoneIds: destinationZoneIds(),
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
    });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.upstreamBatchCalls).toBe(2);
  });

  it("aborts before, during admission, and between chunks", async () => {
    const before = new AbortController();
    before.abort();
    const beforeLookup = vi.fn();
    await expect(new PopulationZoneV3HabitatCompiler({
      lookupGameplayEnvironments: beforeLookup
    }).prefetchWorldEnvironmentForZones({
      zoneIds: destinationZoneIds(),
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      signal: before.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(beforeLookup).not.toHaveBeenCalled();

    const queued = new AbortController();
    const queuedLookup = vi.fn((_points: readonly LatLon[], options?: {
      signal?: AbortSignal;
    }) => new Promise<WorldGameplayEnvironmentResult[]>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(
        options.signal?.reason
      ), { once: true });
    }));
    const queuedOperation = new PopulationZoneV3HabitatCompiler({
      lookupGameplayEnvironments: queuedLookup
    }).prefetchWorldEnvironmentForZones({
      zoneIds: destinationZoneIds(),
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      signal: queued.signal
    });
    await waitFor(() => queuedLookup.mock.calls.length === 1);
    queued.abort(new DOMException("aborted", "AbortError"));
    await expect(queuedOperation).rejects.toMatchObject({ name: "AbortError" });

    const between = new AbortController();
    const betweenLookup = vi.fn(async (points: readonly LatLon[]) => {
      between.abort(new DOMException("aborted", "AbortError"));
      return points.map((point) => compactResult(point));
    });
    await expect(new PopulationZoneV3HabitatCompiler({
      lookupGameplayEnvironments: betweenLookup
    }).prefetchWorldEnvironmentForZones({
      zoneIds: manyZoneIds(),
      worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
      signal: between.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(betweenLookup).toHaveBeenCalledOnce();
  });

  it("fails closed for wrong World authority and invalid facts", async () => {
    const invalidResults: Array<(point: LatLon) => WorldGameplayEnvironmentResult> = [
      (point) => {
        const result = compactResult(point);
        return {
          ...result,
          release: { ...result.release!, releaseId: "wrong" }
        };
      },
      (point) => ({ ...compactResult(point), isLand: null })
    ];
    for (const invalid of invalidResults) {
      const compiler = new PopulationZoneV3HabitatCompiler({
        lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[]) =>
          points.map(invalid)
        )
      }, { maximumBatchAttempts: 1 });
      await expect(compiler.prefetchWorldEnvironmentForZones({
        zoneIds: destinationZoneIds(),
        worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
      })).rejects.toMatchObject({
        name: "PopulationEnvironmentPrefetchTerminalError"
      });
    }
  });

  it("preserves every serialized plan field except operational batch latency", async () => {
    const zoneIds = destinationZoneIds();
    const compilePlans = async (prefetch: boolean) => {
      const compiler = new PopulationZoneV3HabitatCompiler({
        lookupGameplayEnvironments: async (points) =>
          points.map((point) => compactResult(point))
      });
      if (prefetch) {
        await compiler.prefetchWorldEnvironmentForZones({
          zoneIds,
          worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY
        });
      }
      const habitats = new Map<PopulationZoneV2Id, PopulationZoneV2Habitat>();
      for (const zoneId of zoneIds) {
        habitats.set(zoneId, await compiler.compileZone({
          zoneId,
          worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
          regionCode: populationZoneV2CanonicalRegionCode(zoneId)
        }));
      }
      return zoneIds.flatMap((zoneId) => generatePopulationZonesV2Plans({
        outputZoneIds: [zoneId],
        worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
        worldPipelineSha: WORLD_SHA,
        habitatForZone: (dependencyZoneId) =>
          dependencyZoneId === zoneId
            ? habitats.get(zoneId)!
            : populationZoneV3ConservativeHabitat({
                zoneId: dependencyZoneId,
                worldEnvironmentIdentityKey: WORLD_IDENTITY_KEY,
                regionCode: populationZoneV2CanonicalRegionCode(
                  dependencyZoneId
                )
              })
      }));
    };

    const baseline = normalizeOperationalLatency(await compilePlans(false));
    const prefetched = normalizeOperationalLatency(await compilePlans(true));
    expect(prefetched).toEqual(baseline);
  });
});

function destinationZoneIds() {
  return populationZonesV2IntersectingCircle({
    lat: 39.7,
    lon: -105.017
  }, 650);
}

function manyZoneIds() {
  return [...new Set(Array.from({ length: 18 }, (_, index) =>
    populationZoneV2IdForPoint({
      lat: 20 + index * 2,
      lon: -150 + index * 7
    })
  ))];
}

function compactResult(point: LatLon): WorldGameplayEnvironmentResult {
  return {
    ok: true,
    contractVersion: "gameplay-environment-v1",
    runtime: { sha: WORLD_SHA, branch: "main" },
    packageId: "package-1",
    latitude: point.lat,
    longitude: point.lon,
    countryId: "country-1",
    countryName: "Test Country",
    countryCode: "TC",
    regionId: "region-1",
    regionName: "Test Region",
    regionCode: "TR",
    settlementId: null,
    settlementName: null,
    elevationM: 125,
    elevationBand: "lowland",
    terrainClass: "forest",
    landCoverClass: "forest",
    biome: "Temperate Forest",
    biomeName: "Temperate Forest",
    biomeId: "temperate-forest",
    ecoregion: "Test Ecoregion",
    ecoregionName: "Test Ecoregion",
    ecoregionId: "ecoregion-1",
    isLand: true,
    isSaltwater: false,
    isCoastalLand: false,
    isRiverbank: false,
    isLakeshore: false,
    isCoastal: false,
    insideMajorLake: false,
    majorLakeId: null,
    majorLakeName: null,
    majorLakeDistanceM: null,
    namedRiverId: null,
    namedRiverName: null,
    riverClass: null,
    riverDistanceM: null,
    supportingRiverId: null,
    supportingRiverFlowOrder: null,
    supportingRiverDischargeCms: null,
    supportingRiverDrainageAreaSqKm: null,
    supportingRiverDistanceM: null,
    flagPlacementWater: null,
    release: { ...WORLD_IDENTITY, packageCount: 64_800 },
    raw: {}
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not met");
}

function normalizeOperationalLatency(
  plans: readonly GeneratedPopulationZoneV2Plan[]
): GeneratedPopulationZoneV2Plan[] {
  return plans.map((plan) => {
    const habitat = JSON.parse(JSON.stringify(plan.habitat, (key, nested) =>
      key === "compactBatchLatencyMs" ? 0 : nested
    )) as PopulationZoneV2Habitat;
    return {
      ...plan,
      habitat,
      contentHash: populationZoneV2PlanContentHash({
        identity: plan.identity,
        planId: plan.planId,
        geometry: plan.geometry,
        habitat,
        slots: plan.slots
      })
    };
  });
}

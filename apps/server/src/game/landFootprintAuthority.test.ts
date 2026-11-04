import { describe, expect, it, vi } from "vitest";

import { WORLD_RUNTIME_CONTRACT } from "../runtime/authorityIdentity.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import {
  canonicalCellsIntersectingFootprint,
  classifyLandFootprint
} from "./landFootprintAuthority.js";

describe("land footprint river authority", () => {
  it("uses the canonical cell geometry from the approved World identity", () => {
    expect(WORLD_RUNTIME_CONTRACT.surfaceCellSizeM).toBe(
      WORLD_RUNTIME_CONTRACT.riverSurface.cellSizeM
    );
    expect(WORLD_RUNTIME_CONTRACT.surfaceCellSizeM).toBe(
      WORLD_RUNTIME_CONTRACT.lakeSurface.cellSizeM
    );
    expect(WORLD_RUNTIME_CONTRACT.surfaceCellSizeM).toBe(
      WORLD_RUNTIME_CONTRACT.oceanCoastSurface.cellSizeM
    );
  });

  it("enumerates only the bounded canonical cells intersecting a structure footprint", () => {
    const probes = canonicalCellsIntersectingFootprint(
      { lat: 35.09056835150741, lon: -106.68231374542755 },
      20
    );
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.length).toBeLessThanOrEqual(4);
    expect(new Set(probes.map((point) => `${point.lat}:${point.lon}`)).size)
      .toBe(probes.length);
  });

  it("rejects the whole footprint when any exact canonical cell is river water", async () => {
    const lookupGameplayEnvironments = vi.fn(async (points: readonly unknown[]) =>
      points.map((_, index) => environment(index === 0 ? "river" : "land"))
    );
    await expect(classifyLandFootprint(
      { lookupGameplayEnvironments },
      { lat: 35.09056835150741, lon: -106.68231374542755 },
      20
    )).resolves.toBe("river");
    expect(lookupGameplayEnvironments).toHaveBeenCalledOnce();
  });

  it("preserves non-river land placement", async () => {
    await expect(classifyLandFootprint(
      {
        lookupGameplayEnvironments: async (points) =>
          points.map(() => environment("land"))
      },
      { lat: 35.0844, lon: -106.6504 },
      20
    )).resolves.toBe("land");
  });
});

function environment(kind: "land" | "river"): WorldGameplayEnvironmentResult {
  return {
    ok: true,
    contractVersion: "gameplay-environment-v1",
    runtime: { branch: "main", sha: "a".repeat(40) },
    packageId: "world_v1_lat35_lon-107",
    latitude: 35,
    longitude: -106,
    countryId: null,
    countryName: null,
    countryCode: null,
    regionId: null,
    regionName: null,
    regionCode: null,
    settlementId: null,
    settlementName: null,
    elevationM: 1,
    elevationBand: null,
    terrainClass: "flat",
    landCoverClass: "urban",
    biome: null,
    biomeName: null,
    ecoregion: null,
    ecoregionName: null,
    isLand: kind === "land",
    isSaltwater: false,
    isCoastalLand: false,
    isRiverbank: false,
    isLakeshore: false,
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
    flagPlacementWater: kind === "river"
      ? {
          blocked: true,
          kind: "river",
          sourceId: "river-surface-v1:1:1",
          sourceName: null,
          distanceM: 0,
          corridorRadiusM: null,
          reason: "canonical river surface",
          resolution: "river-surface-v1",
          releaseId: "world-packages-v1"
        }
      : {
          blocked: false,
          kind: "land",
          sourceId: null,
          sourceName: null,
          distanceM: null,
          corridorRadiusM: null,
          reason: "authoritative land",
          resolution: "water-placement-surface-v1",
          releaseId: "world-packages-v1"
        },
    surfaceKind: kind === "river" ? "water" : "land",
    waterKind: kind === "river" ? "river" : null,
    riverSurface: null,
    raw: {}
  };
}

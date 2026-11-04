import { describe, expect, it } from "vitest";

import {
  activeSetDelta,
  deterministicEligibleAreaCount,
  generateGridPopulationPlan,
  globalRankedGridCandidates,
  rareParentDomainForPoint,
  runPersistentPopulationV2Simulation,
  SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY,
  SIMULATION_WORLD_RUNTIME_SHA,
  simulateStableRespawn,
  stableRareParentSlot
} from "./persistentPopulationV2Simulation.js";
import {
  ENVIRONMENT_PROFILE_VERSION
} from "../../apps/server/src/game/gameplayEnvironmentProfileVersions.js";
import {
  greatCircleDistanceMeters,
  type PopulationZoneV2Id,
  populationZonesV2IntersectingCircle
} from "../../apps/server/src/game/populationZonesV2Geometry.js";
import {
  deterministicPopulationZoneV2RareParentAllocation
} from "../../apps/server/src/game/populationZonesV2Plan.js";
import {
  POPULATION_BALANCE
} from "../../packages/shared/src/populationBalance.js";

describe("persistent population v2 simulation primitives", () => {
  it("fractionally rounds eligible-area budgets deterministically", () => {
    const input = {
      ownerId: "zone-test",
      kind: "tree",
      eligibleAreaKm2: 0.31,
      densityPerEligibleKm2: 4
    } as const;
    expect(deterministicEligibleAreaCount(input))
      .toBe(deterministicEligibleAreaCount(input));
    expect(deterministicEligibleAreaCount(input)).toBeGreaterThanOrEqual(1);
    expect(deterministicEligibleAreaCount(input)).toBeLessThanOrEqual(2);
    expect(deterministicEligibleAreaCount({
      ...input,
      eligibleAreaKm2: 0
    })).toBe(0);
  });

  it("retains about half of rare allocations for binary half-eligible habitat", () => {
    for (const kind of ["stone", "ogre", "sap_crawler_group"] as const) {
      const domains = new Map<string, ReturnType<typeof rareParentDomainForPoint>>();
      for (let latitude = -70; latitude <= 70; latitude += 7) {
        for (let longitude = -170; longitude <= 170; longitude += 17) {
          const domain = rareParentDomainForPoint(
            kind,
            { lat: latitude, lon: longitude }
          );
          domains.set(domain.id, domain);
        }
      }
      const selected = [...domains.values()].filter((domain) =>
        deterministicPopulationZoneV2RareParentAllocation(
          domain,
          domain.areaKm2 * 0.5,
          SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY
        )
      ).map((domain) => domain.id);
      const repeated = [...domains.values()].filter((domain) =>
        deterministicPopulationZoneV2RareParentAllocation(
          domain,
          domain.areaKm2 * 0.5,
          SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY
        )
      ).map((domain) => domain.id);
      expect(repeated).toEqual(selected);
      expect(selected.length / domains.size).toBeGreaterThan(0.4);
      expect(selected.length / domains.size).toBeLessThan(0.6);
    }
  });

  it("computes retained, activated, and released lease sets", () => {
    expect(activeSetDelta(["a", "b", "c"], ["b", "c", "d"])).toEqual({
      retained: ["b", "c"],
      activated: ["d"],
      released: ["a"]
    });
  });

  it("gives rare parent domains and their slots stable antimeridian-safe IDs", () => {
    const east = rareParentDomainForPoint(
      "stone",
      { lat: -16.5, lon: 179.999 }
    );
    const wrapped = rareParentDomainForPoint(
      "stone",
      { lat: -16.5, lon: -180.001 }
    );
    expect(east.id).toBe(wrapped.id);
    expect(stableRareParentSlot(east)).toEqual(stableRareParentSlot(wrapped));
    expect(east.areaKm2).toBeGreaterThan(4);
    expect(east.areaKm2).toBeLessThan(5);
  });

  it("keeps plan and respawn identities stable across activation order", () => {
    const zoneIds = populationZonesV2IntersectingCircle(
      { lat: 35.0844, lon: -106.6504 },
      1_000
    );
    const first = generateGridPopulationPlan({
      zoneIds,
      eligibleFraction: 0.91,
      disableMemoization: true
    });
    const reversed = generateGridPopulationPlan({
      zoneIds: [...zoneIds].reverse() as PopulationZoneV2Id[],
      eligibleFraction: 0.91,
      disableMemoization: true
    });
    const firstIds = first.entities.map((entity) => entity.entityId).sort();
    const reversedIds = reversed.entities
      .map((entity) => entity.entityId)
      .sort();
    const respawnedIds = simulateStableRespawn(first.entities, 5)
      .map((entity) => entity.entityId)
      .sort();
    expect(reversedIds).toEqual(firstIds);
    expect(respawnedIds).toEqual(firstIds);
    expect(new Set(firstIds).size).toBe(firstIds.length);
  });

  it("namespaces candidate and entity identity with the derived environment key", () => {
    const zoneIds = populationZonesV2IntersectingCircle(
      { lat: 35.0844, lon: -106.6504 },
      1_000
    );
    const baseline = generateGridPopulationPlan({
      zoneIds,
      eligibleFraction: 0.91
    });
    const otherEnvironment = generateGridPopulationPlan({
      zoneIds,
      eligibleFraction: 0.91,
      worldEnvironmentIdentityKey: "a".repeat(64)
    });
    expect(otherEnvironment.entities.map((entity) => entity.entityId))
      .not.toEqual(baseline.entities.map((entity) => entity.entityId));
    expect(otherEnvironment.anchors.map((candidate) => candidate.rank))
      .not.toEqual(baseline.anchors.map((candidate) => candidate.rank));

    const uuidV8 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    for (const entity of baseline.entities) {
      expect(entity.entityId).toMatch(uuidV8);
      expect(entity.slotId).toMatch(uuidV8);
      if (entity.encounterId !== null) {
        expect(entity.encounterId).toMatch(uuidV8);
      }
      if (entity.packId !== null) {
        expect(entity.packId).toMatch(uuidV8);
      }
    }
  });

  it("resolves cross-zone wolf packs through the full 1,250 m halo", () => {
    const zoneIds = populationZonesV2IntersectingCircle(
      { lat: 37.25, lon: -101.75 },
      10_000
    );
    const packs = globalRankedGridCandidates({
      zoneIds,
      kind: "wolf_pack",
      eligibleFraction: 1
    });
    const crossZonePairs: Array<readonly [
      (typeof packs)[number],
      (typeof packs)[number]
    ]> = [];
    for (let left = 0; left < packs.length; left += 1) {
      for (let right = left + 1; right < packs.length; right += 1) {
        if (packs[left]!.ownerId !== packs[right]!.ownerId) {
          crossZonePairs.push([packs[left]!, packs[right]!]);
        }
      }
    }
    expect(crossZonePairs.length).toBeGreaterThan(0);
    expect(Math.min(...crossZonePairs.map(([first, second]) =>
      greatCircleDistanceMeters(first.position, second.position)
    ))).toBeGreaterThanOrEqual(
      POPULATION_BALANCE.common.wolf_pack.minimumSpacingM
    );

    const wolves = generateGridPopulationPlan({
      zoneIds,
      eligibleFraction: 1
    }).entities.filter((entity) => entity.kind === "wolf");
    const withinPackDistances: number[] = [];
    for (let left = 0; left < wolves.length; left += 1) {
      for (let right = left + 1; right < wolves.length; right += 1) {
        if (wolves[left]!.packId === wolves[right]!.packId) {
          withinPackDistances.push(greatCircleDistanceMeters(
            wolves[left]!.homePosition,
            wolves[right]!.homePosition
          ));
        }
      }
    }
    expect(withinPackDistances.length).toBeGreaterThan(0);
    expect(Math.min(...withinPackDistances)).toBeGreaterThanOrEqual(55);
  });

  it("runs the complete in-memory H3/grid bake-off without writing outputs", () => {
    const { report, zoneStatistics } =
      runPersistentPopulationV2Simulation();
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        "desert",
        "grassland",
        "temperate_forest",
        "wetland",
        "coastal_new_orleans",
        "mountainous",
        "high_latitude",
        "antimeridian",
        "water_heavy",
        "dense_flags",
        "sparse_flags",
        "multiple_players",
        "repeated_visits_respawns"
      ])
    );
    expect(report.acceptanceSummary).toMatchObject({
      selectedGeometryNumericGatesPassed: true,
      allEntityIdsUnique: true,
      allOrdersDeterministic: true,
      allRespawnsIdentityStable: true,
      allRepeatedVisitsIdentityStable: true,
      totalSeamSpacingViolations: 0
    });
    expect(report.deterministicInputs).toMatchObject({
      worldEnvironmentIdentityKey:
        SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY,
      worldRuntimeSha: SIMULATION_WORLD_RUNTIME_SHA,
      environmentProfileVersion: ENVIRONMENT_PROFILE_VERSION
    });
    const gates = report.selectedGeometryAcceptance;
    expect(gates.passed).toBe(true);
    expect(gates.singleCircleActiveZones.observedMaximum)
      .toBeLessThanOrEqual(gates.singleCircleActiveZones.limit);
    expect(gates.identitiesAndSeams).toMatchObject({
      duplicateEntityIds: 0,
      orderMismatches: 0,
      repeatedVisitMismatches: 0,
      respawnMismatches: 0,
      seamSpacingViolations: 0,
      passed: true
    });
    expect(gates.identitiesAndSeams.seamSpacingComparisons.tree)
      .toBeGreaterThan(0);
    expect(gates.identitiesAndSeams.seamSpacingComparisons.deer)
      .toBeGreaterThan(0);
    expect(Object.values(
      gates.identitiesAndSeams.conflictMatrixViolations
    ).every((count) => count === 0)).toBe(true);
    expect(Object.entries(
      gates.identitiesAndSeams.conflictMatrixExerciseCounts
    ).filter(([kind]) => kind !== "wolfPackAnchors")
      .every(([, count]) => count > 0)).toBe(true);
    for (const metric of Object.values(gates.longRunDensity.kinds)) {
      expect(metric.relativeError)
        .toBeLessThanOrEqual(gates.longRunDensity.toleranceFraction);
      expect(metric.passed).toBe(true);
    }
    expect(gates.longRunDensity.samples).toHaveLength(3);
    expect(new Set(gates.longRunDensity.samples.map(
      (sample) => sample.worldEnvironmentIdentityKey
    )).size).toBe(3);
    expect(gates.longRunDensity.eligibleAreaKm2).toBeGreaterThan(6_000);
    const equivalentFlagFootprintKm2 = Math.PI * 0.5 ** 2;
    const expectedWildlifePerEquivalentFlag = {
      deer:
        POPULATION_BALANCE.common.deer.densityPerEligibleKm2
        * equivalentFlagFootprintKm2,
      equivalentFlagsPerWolfPack:
        1 / (
          POPULATION_BALANCE.common.wolf_pack.densityPerEligibleKm2
          * equivalentFlagFootprintKm2
        ),
      equivalentFlagsPerOgre:
        POPULATION_BALANCE.rare.ogre.targetAreaKm2
        / equivalentFlagFootprintKm2
    };
    for (const key of Object.keys(
      expectedWildlifePerEquivalentFlag
    ) as Array<keyof typeof expectedWildlifePerEquivalentFlag>) {
      const expected = expectedWildlifePerEquivalentFlag[key];
      expect(Math.abs(
        gates.longRunDensity.wildlifePerEquivalentFlag[key] - expected
      ) / expected).toBeLessThanOrEqual(
        gates.longRunDensity.toleranceFraction
      );
    }
    expect(gates.longRunDensity.wolfPackSizes.two.percentage)
      .toBeCloseTo(0.15, 1);
    expect(gates.longRunDensity.wolfPackSizes.three.percentage)
      .toBeCloseTo(0.60, 1);
    expect(gates.longRunDensity.wolfPackSizes.four.percentage)
      .toBeCloseTo(0.25, 1);
    expect(gates.longRunDensity.wolfPackSizes.averageWolvesPerPack)
      .toBeCloseTo(3.1, 1);
    expect(
      gates.longRunDensity.wolfPackSizes.encounterCountUnchangedByExpansion
    ).toBe(true);
    expect(gates.longRunDensity.wolfPackSizes.passed).toBe(true);
    expect(gates.longRunDensity.rareAllocation.ogreToSapCrawlerGroupRatio)
      .toBeCloseTo(2, 1);
    expect(gates.longRunDensity.rareAllocation.sapCrawlerGroupSizes.five.percentage)
      .toBeCloseTo(0.30, 1);
    expect(gates.longRunDensity.rareAllocation.sapCrawlerGroupSizes.six.percentage)
      .toBeCloseTo(0.50, 1);
    expect(gates.longRunDensity.rareAllocation.sapCrawlerGroupSizes.seven.percentage)
      .toBeCloseTo(0.20, 1);
    expect(gates.longRunDensity.rareAllocation.sapCrawlerGroupSizes.passed)
      .toBe(true);
    expect(gates.longRunDensity.rareAllocation.passed).toBe(true);
    expect(gates.longRunDensity.kinds.wolfPacks.minimumObservedSpacingM)
      .toBeGreaterThanOrEqual(
        POPULATION_BALANCE.common.wolf_pack.minimumSpacingM
      );
    expect(gates.syntheticWaterSampling).toMatchObject({
      fieldVersion: "synthetic-water-geography-v1",
      sampleCount: 48,
      referenceSampleCount: 1_024,
      maximumAllowedAbsoluteError: 0.08,
      ineligibleSelectedSlotCount: 0,
      nonOwnerSelectedSlotCount: 0,
      passed: true
    });
    expect(gates.syntheticWaterSampling.absoluteEligibleFractionError)
      .toBeLessThanOrEqual(0.08);
    expect(gates.syntheticWaterSampling.selectedSlotCount)
      .toBeGreaterThan(0);
    expect(gates.adjacentRetention.distanceM).toBe(500);
    expect(gates.adjacentRetention.observedMinimumDestinationRatio)
      .toBeGreaterThanOrEqual(
        gates.adjacentRetention.minimumRequiredDestinationRatio
      );
    expect(gates.adjacentRetention.probes).toBe(104);
    expect(gates.fourFlagPermutations).toMatchObject({
      permutations: 24,
      fixtureCenter: { lat: 24, lon: 13 },
      flagOffsetM: 650,
      eligibleFraction: 1,
      entityCountMismatches: 0,
      entityIdMismatches: 0,
      planCountMismatches: 0,
      passed: true
    });
    expect(gates.fourFlagPermutations.finalEntityCounts.trees)
      .toBeGreaterThan(0);
    expect(gates.fourFlagPermutations.finalEntityCounts.deer)
      .toBeGreaterThan(0);
    expect(gates.fourFlagPermutations.finalEntityCounts.wolfPacks)
      .toBeGreaterThan(0);
    expect(gates.fourFlagPermutations.finalEntityCounts.wolves)
      .toBeGreaterThan(0);
    expect(gates.fourFlagPermutations.finalEntityCounts.stones)
      .toBeGreaterThan(0);
    expect(gates.longRunDensity.rareAllocation.sapCrawlerGroups.actualCount)
      .toBeGreaterThan(0);
    expect(
      gates.longRunDensity.rareAllocation.sapCrawlerGroupSizes
        .totalSapCrawlerCount
    )
      .toBeGreaterThanOrEqual(
        gates.longRunDensity.rareAllocation.sapCrawlerGroups.actualCount * 5
      );
    expect(
      gates.longRunDensity.rareAllocation.sapCrawlerGroupSizes
        .totalSapCrawlerCount
    )
      .toBeLessThanOrEqual(
        gates.longRunDensity.rareAllocation.sapCrawlerGroups.actualCount * 7
      );
    expect(gates.adjacentPingPong).toMatchObject({
      visits: 20,
      plansCreatedAfterWarmup: 0,
      newEntityIdsAfterWarmup: 0,
      duplicateEntityIds: 0,
      fullResetsAfterFirstVisit: 0,
      passed: true
    });
    expect(gates.durableRespawn).toMatchObject({
      cycles: 5,
      identityMismatches: 0,
      homeMismatches: 0,
      countIncreases: 0,
      passed: true
    });
    expect(report.simulationScope).toMatchObject({
      habitatFractions: "fixture-inputs-plus-synthetic-water-field",
      eligibleAreaSampleErrorGate:
        "passed-deterministic-synthetic-48-vs-1024",
      runtimeLeaseAndActorAcceptance:
        "passed-real-postgresql-20-player-runtime-leases-and-actors"
    });
    expect(gates.fullyLandFootprint.observedMaximumDatabaseBytes)
      .toBeLessThanOrEqual(gates.fullyLandFootprint.databaseLimitBytes);
    expect(gates.fullyLandFootprint.observedMaximumRuntimeActors)
      .toBeLessThanOrEqual(gates.fullyLandFootprint.runtimeActorLimit);
    expect(zoneStatistics.length).toBeGreaterThan(100);
    expect(zoneStatistics).toContainEqual(expect.objectContaining({
      scenarioId: "synthetic_water_sampling_gate",
      absoluteEligibleFractionError:
        gates.syntheticWaterSampling.absoluteEligibleFractionError,
      ineligibleSelectedSlotCount: 0
    }));
  }, 25_000);
});

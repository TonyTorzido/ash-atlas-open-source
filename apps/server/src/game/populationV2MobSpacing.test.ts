import { destinationPoint } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  POPULATION_V2_MAXIMUM_SPACING_DISTANCE_M,
  POPULATION_V2_SPACING_CLASSES,
  POPULATION_V2_SPACING_MATRIX,
  populationV2SpacingConflict,
  populationV2SpacingRule,
  validatePopulationV2SpacingMatrix,
  type PopulationV2SpacingClass,
  type PopulationV2SpacingRule
} from "./populationV2MobSpacing.js";
import {
  populationPlacementCandidatesConflict,
  type PopulationPlacementCandidate,
  type PopulationZoneV2PlanKind
} from "./populationZonesV2Plan.js";

const LEGACY_CLASS_BY_KIND = {
  tree: "scenery_tree",
  flax: "scenery_tree",
  deer: "passive_single",
  wolf_pack: "hostile_pack",
  ogre: "large_hostile",
  sap_crawler_group: "small_hostile_pack",
  stone: "permanent_stone"
} as const satisfies Record<PopulationZoneV2PlanKind, PopulationV2SpacingClass>;

describe("Population V2 spacing classes", () => {
  it("provides the complete exact symmetric legacy matrix", () => {
    validatePopulationV2SpacingMatrix();
    for (const left of POPULATION_V2_SPACING_CLASSES) {
      for (const right of POPULATION_V2_SPACING_CLASSES) {
        expect(populationV2SpacingRule(left, right))
          .toEqual(populationV2SpacingRule(right, left));
      }
    }
    expect(upperTriangleRules()).toEqual([
      ["scenery_tree/scenery_tree", "closest-body-distance", 70],
      ["scenery_tree/passive_single", "closest-body-distance", 35],
      ["scenery_tree/hostile_pack", "closest-body-distance", 70],
      ["scenery_tree/large_hostile", "closest-body-distance", 70],
      ["scenery_tree/small_hostile_pack", "closest-body-distance", 20],
      ["scenery_tree/permanent_stone", "closest-body-distance", 50],
      ["scenery_tree/settlement_hut", "closest-body-distance", 150],
      ["passive_single/passive_single", "closest-body-distance", 45],
      ["passive_single/hostile_pack", "closest-body-distance", 70],
      ["passive_single/large_hostile", "closest-body-distance", 70],
      ["passive_single/small_hostile_pack", "closest-body-distance", 35],
      ["passive_single/permanent_stone", "closest-body-distance", 120],
      ["passive_single/settlement_hut", "closest-body-distance", 150],
      ["hostile_pack/hostile_pack", "anchor-distance", 700],
      ["hostile_pack/large_hostile", "anchor-distance", 350],
      ["hostile_pack/small_hostile_pack", "anchor-distance", 350],
      ["hostile_pack/permanent_stone", "closest-body-distance", 120],
      ["hostile_pack/settlement_hut", "closest-body-distance", 250],
      ["large_hostile/large_hostile", "anchor-distance", 350],
      ["large_hostile/small_hostile_pack", "anchor-distance", 350],
      ["large_hostile/permanent_stone", "closest-body-distance", 120],
      ["large_hostile/settlement_hut", "closest-body-distance", 250],
      ["small_hostile_pack/small_hostile_pack", "anchor-distance", 350],
      ["small_hostile_pack/permanent_stone", "closest-body-distance", 120],
      ["small_hostile_pack/settlement_hut", "closest-body-distance", 250],
      ["permanent_stone/permanent_stone", "none", 0],
      ["permanent_stone/settlement_hut", "closest-body-distance", 150],
      ["settlement_hut/settlement_hut", "anchor-distance", 2500]
    ]);
    expect(POPULATION_V2_MAXIMUM_SPACING_DISTANCE_M).toBe(2500);
  });

  it("matches every legacy kind pair at representative boundaries", () => {
    const kinds = Object.keys(LEGACY_CLASS_BY_KIND) as PopulationZoneV2PlanKind[];
    const distancesM = [
      0,
      19,
      21,
      34,
      36,
      44,
      46,
      49,
      51,
      69,
      71,
      119,
      121,
      349,
      351,
      699,
      701
    ];
    for (const leftKind of kinds) {
      for (const rightKind of kinds) {
        for (const distanceM of distancesM) {
          const left = legacyPlacement(leftKind, 0);
          const right = legacyPlacement(rightKind, distanceM);
          expect(populationV2SpacingConflict(
            classPlacement(left, LEGACY_CLASS_BY_KIND[leftKind]),
            classPlacement(right, LEGACY_CLASS_BY_KIND[rightKind])
          ), `${leftKind}/${rightKind} at ${distanceM}m`).toBe(
            populationPlacementCandidatesConflict(left, right)
          );
        }
      }
    }
  });

  it("preserves anchor versus closest-body measurements", () => {
    const origin = { lat: 35, lon: -106 };
    const distantAnchor = destinationPoint(origin, 800, 90);
    const nearBody = destinationPoint(origin, 10, 90);
    const wolfLeft = {
      spacingClass: "hostile_pack" as const,
      anchor: origin,
      bodies: [origin]
    };
    const wolfRight = {
      spacingClass: "hostile_pack" as const,
      anchor: distantAnchor,
      bodies: [nearBody]
    };
    expect(populationV2SpacingConflict(wolfLeft, wolfRight)).toBe(false);
    expect(populationV2SpacingConflict({
      spacingClass: "scenery_tree",
      anchor: origin,
      bodies: [origin]
    }, wolfRight)).toBe(true);
  });

  it("rejects incomplete and asymmetric matrices", () => {
    const incomplete = mutableMatrix();
    delete incomplete.passive_single!.hostile_pack;
    expect(() => validatePopulationV2SpacingMatrix(incomplete))
      .toThrow(/incomplete/i);

    const asymmetric = mutableMatrix();
    asymmetric.passive_single!.hostile_pack = {
      measurement: "anchor-distance",
      minimumDistanceM: 999
    };
    expect(() => validatePopulationV2SpacingMatrix(asymmetric))
      .toThrow(/asymmetric/i);
  });
});

function upperTriangleRules(): [string, string, number][] {
  return POPULATION_V2_SPACING_CLASSES.flatMap((left, leftIndex) =>
    POPULATION_V2_SPACING_CLASSES.slice(leftIndex).map((right) => {
      const rule = populationV2SpacingRule(left, right);
      return [
        `${left}/${right}`,
        rule.measurement,
        rule.minimumDistanceM
      ] as [string, string, number];
    })
  );
}

function legacyPlacement(
  kind: PopulationZoneV2PlanKind,
  distanceM: number
): PopulationPlacementCandidate {
  const point = destinationPoint({ lat: 35, lon: -106 }, distanceM, 90);
  return {
    kind,
    position: point,
    homes: [point]
  };
}

function classPlacement(
  placement: PopulationPlacementCandidate,
  spacingClass: PopulationV2SpacingClass
) {
  return {
    spacingClass,
    anchor: placement.position,
    bodies: placement.homes
  };
}

function mutableMatrix(): Record<
  string,
  Record<string, PopulationV2SpacingRule>
> {
  return Object.fromEntries(POPULATION_V2_SPACING_CLASSES.map((left) => [
    left,
    Object.fromEntries(POPULATION_V2_SPACING_CLASSES.map((right) => [
      right,
      { ...POPULATION_V2_SPACING_MATRIX[left][right] }
    ]))
  ]));
}

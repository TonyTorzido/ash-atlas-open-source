import {
  greatCircleDistanceMeters,
  type PopulationZoneV2Point
} from "./populationZonesV2Geometry.js";

export const POPULATION_V2_SPACING_CLASSES = [
  "scenery_tree",
  "passive_single",
  "hostile_pack",
  "large_hostile",
  "small_hostile_pack",
  "permanent_stone",
  "settlement_hut"
] as const;

export type PopulationV2SpacingClass =
  (typeof POPULATION_V2_SPACING_CLASSES)[number];

export type PopulationV2SpacingRule = Readonly<
  | {
      measurement: "none";
      minimumDistanceM: 0;
    }
  | {
      measurement: "anchor-distance" | "closest-body-distance";
      minimumDistanceM: number;
    }
>;

export type PopulationV2SpacingMatrix = Readonly<Record<
  PopulationV2SpacingClass,
  Readonly<Record<PopulationV2SpacingClass, PopulationV2SpacingRule>>
>>;

const NONE: PopulationV2SpacingRule = Object.freeze({
  measurement: "none",
  minimumDistanceM: 0
});

const entries: readonly Readonly<{
  left: PopulationV2SpacingClass;
  right: PopulationV2SpacingClass;
  rule: PopulationV2SpacingRule;
}>[] = [
  bodyRule("scenery_tree", "scenery_tree", 70),
  bodyRule("scenery_tree", "passive_single", 35),
  bodyRule("scenery_tree", "hostile_pack", 70),
  bodyRule("scenery_tree", "large_hostile", 70),
  bodyRule("scenery_tree", "small_hostile_pack", 20),
  bodyRule("scenery_tree", "permanent_stone", 50),
  bodyRule("passive_single", "passive_single", 45),
  bodyRule("passive_single", "hostile_pack", 70),
  bodyRule("passive_single", "large_hostile", 70),
  bodyRule("passive_single", "small_hostile_pack", 35),
  bodyRule("passive_single", "permanent_stone", 120),
  anchorRule("hostile_pack", "hostile_pack", 700),
  anchorRule("hostile_pack", "large_hostile", 350),
  anchorRule("hostile_pack", "small_hostile_pack", 350),
  bodyRule("hostile_pack", "permanent_stone", 120),
  anchorRule("large_hostile", "large_hostile", 350),
  anchorRule("large_hostile", "small_hostile_pack", 350),
  bodyRule("large_hostile", "permanent_stone", 120),
  anchorRule("small_hostile_pack", "small_hostile_pack", 350),
  bodyRule("small_hostile_pack", "permanent_stone", 120),
  {
    left: "permanent_stone",
    right: "permanent_stone",
    rule: NONE
  },
  // Settlement huts (Hollin Huts): kept well clear of every other class so a hut's farmers,
  // guards and orchard (within ~45 m of the hut) never land on nodes or mob camps, and far
  // from one another so a region does not fill with shops.
  bodyRule("scenery_tree", "settlement_hut", 150),
  bodyRule("passive_single", "settlement_hut", 150),
  bodyRule("hostile_pack", "settlement_hut", 250),
  bodyRule("large_hostile", "settlement_hut", 250),
  bodyRule("small_hostile_pack", "settlement_hut", 250),
  bodyRule("permanent_stone", "settlement_hut", 150),
  anchorRule("settlement_hut", "settlement_hut", 2_500)
];

export const POPULATION_V2_SPACING_MATRIX: PopulationV2SpacingMatrix =
  createSpacingMatrix(entries);

export const POPULATION_V2_MAXIMUM_SPACING_DISTANCE_M = Math.max(
  ...POPULATION_V2_SPACING_CLASSES.flatMap((left) =>
    POPULATION_V2_SPACING_CLASSES.map((right) =>
      POPULATION_V2_SPACING_MATRIX[left][right].minimumDistanceM
    )
  )
);

export function populationV2SpacingRule(
  left: PopulationV2SpacingClass,
  right: PopulationV2SpacingClass
): PopulationV2SpacingRule {
  return POPULATION_V2_SPACING_MATRIX[left][right];
}

export function populationV2SpacingConflict(
  left: Readonly<{
    spacingClass: PopulationV2SpacingClass;
    anchor: PopulationZoneV2Point;
    bodies: readonly PopulationZoneV2Point[];
  }>,
  right: Readonly<{
    spacingClass: PopulationV2SpacingClass;
    anchor: PopulationZoneV2Point;
    bodies: readonly PopulationZoneV2Point[];
  }>
): boolean {
  const rule = populationV2SpacingRule(
    left.spacingClass,
    right.spacingClass
  );
  if (rule.measurement === "none") return false;
  const distanceM = rule.measurement === "anchor-distance"
    ? greatCircleDistanceMeters(left.anchor, right.anchor)
    : closestBodyDistance(left.bodies, right.bodies);
  return distanceM < rule.minimumDistanceM;
}

export function validatePopulationV2SpacingMatrix(
  matrix: Readonly<Record<
    string,
    Readonly<Record<string, PopulationV2SpacingRule>>
  >> = POPULATION_V2_SPACING_MATRIX
): void {
  for (const left of POPULATION_V2_SPACING_CLASSES) {
    const row = matrix[left];
    if (row === undefined) {
      throw new Error(`Population V2 spacing matrix is missing ${left}`);
    }
    for (const right of POPULATION_V2_SPACING_CLASSES) {
      const rule = row[right];
      const reverse = matrix[right]?.[left];
      if (rule === undefined || reverse === undefined) {
        throw new Error(
          `Population V2 spacing matrix is incomplete for ${left}/${right}`
        );
      }
      if (
        rule.measurement !== reverse.measurement
        || rule.minimumDistanceM !== reverse.minimumDistanceM
      ) {
        throw new Error(
          `Population V2 spacing matrix is asymmetric for ${left}/${right}`
        );
      }
      if (
        !Number.isFinite(rule.minimumDistanceM)
        || rule.minimumDistanceM < 0
        || (
          rule.measurement === "none"
          && rule.minimumDistanceM !== 0
        )
        || (
          rule.measurement !== "none"
          && rule.minimumDistanceM <= 0
        )
      ) {
        throw new Error(
          `Population V2 spacing rule is invalid for ${left}/${right}`
        );
      }
    }
  }
}

function createSpacingMatrix(
  source: typeof entries
): PopulationV2SpacingMatrix {
  const mutable = Object.fromEntries(POPULATION_V2_SPACING_CLASSES.map(
    (spacingClass) => [spacingClass, {}]
  )) as Record<
    PopulationV2SpacingClass,
    Partial<Record<PopulationV2SpacingClass, PopulationV2SpacingRule>>
  >;
  for (const { left, right, rule } of source) {
    if (mutable[left][right] !== undefined) {
      throw new Error(`duplicate Population V2 spacing rule ${left}/${right}`);
    }
    mutable[left][right] = rule;
    mutable[right][left] = rule;
  }
  const matrix = Object.fromEntries(POPULATION_V2_SPACING_CLASSES.map(
    (left) => [
      left,
      Object.freeze(Object.fromEntries(POPULATION_V2_SPACING_CLASSES.map(
        (right) => {
          const rule = mutable[left][right];
          if (rule === undefined) {
            throw new Error(
              `Population V2 spacing matrix is incomplete for ${left}/${right}`
            );
          }
          return [right, rule];
        }
      )))
    ]
  )) as PopulationV2SpacingMatrix;
  validatePopulationV2SpacingMatrix(matrix);
  return Object.freeze(matrix);
}

function bodyRule(
  left: PopulationV2SpacingClass,
  right: PopulationV2SpacingClass,
  minimumDistanceM: number
) {
  return {
    left,
    right,
    rule: Object.freeze({
      measurement: "closest-body-distance" as const,
      minimumDistanceM
    })
  };
}

function anchorRule(
  left: PopulationV2SpacingClass,
  right: PopulationV2SpacingClass,
  minimumDistanceM: number
) {
  return {
    left,
    right,
    rule: Object.freeze({
      measurement: "anchor-distance" as const,
      minimumDistanceM
    })
  };
}

function closestBodyDistance(
  left: readonly PopulationZoneV2Point[],
  right: readonly PopulationZoneV2Point[]
): number {
  if (left.length === 0 || right.length === 0) {
    throw new Error("Population V2 spacing bodies cannot be empty");
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (const leftPoint of left) {
    for (const rightPoint of right) {
      minimum = Math.min(
        minimum,
        greatCircleDistanceMeters(leftPoint, rightPoint)
      );
    }
  }
  return minimum;
}

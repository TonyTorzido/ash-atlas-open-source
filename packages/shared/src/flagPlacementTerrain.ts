export type FlagPlacementTerrain = "land" | "water" | "unknown";

export type FlagPlacementWaterKind =
  | "ocean"
  | "lake"
  | "river"
  | "inland_water"
  | "land"
  | "unknown";

export type FlagPlacementWaterDecision = {
  blocked: boolean;
  kind: FlagPlacementWaterKind;
  sourceId: string | null;
  sourceName: string | null;
  distanceM: number | null;
  corridorRadiusM: number | null;
  reason: string;
  resolution: string;
  releaseId: string;
};

export function classifyFlagPlacementTerrain(environment: {
  flagPlacementWater?: FlagPlacementWaterDecision | null;
  isLand?: boolean | null;
  isSaltwater?: boolean | null;
  insideMajorLake?: boolean | null;
  landCoverClass?: string | null;
}): FlagPlacementTerrain {
  if (environment.flagPlacementWater) {
    if (environment.flagPlacementWater.blocked) return "water";
    if (environment.flagPlacementWater.kind === "land") return "land";
    return "unknown";
  }
  if (
    environment.isLand === false ||
    environment.isSaltwater === true ||
    environment.insideMajorLake === true ||
    environment.landCoverClass === "inland_water"
  ) {
    return "water";
  }
  if (
    environment.isLand === true &&
    environment.isSaltwater === false &&
    environment.insideMajorLake === false &&
    environment.landCoverClass !== "inland_water"
  ) {
    return "land";
  }
  return "unknown";
}

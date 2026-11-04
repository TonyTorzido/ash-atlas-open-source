import { distanceMeters } from "./geo.js";

export type TerritoryFlag = {
  id: string;
  ownerId: string;
  ownerUsername?: string | null;
  ownerColor?: string | null;
  name?: string | null;
  lat: number;
  lon: number;
  claimRadiusM: number;
};

export type TerritoryResolution = {
  claimed: boolean;
  ownerPlayerId: string | null;
  ownerUsername: string | null;
  ownerColor: string | null;
  nearestFlagId: string | null;
  nearestFlagName: string | null;
  distanceToNearestFlagM: number | null;
  distanceToNearestClaimEdgeM: number | null;
  coveringFlagCount: number;
};

type FlagDistance = {
  flag: TerritoryFlag;
  distanceM: number;
  edgeDistanceM: number;
};

export const TERRITORY_EDGE_TOLERANCE_M = 0.05;

export function territoryInteriorsOverlap(
  distanceM: number,
  existingRadiusM: number,
  candidateRadiusM: number,
  toleranceM = TERRITORY_EDGE_TOLERANCE_M
): boolean {
  return distanceM < existingRadiusM + candidateRadiusM - toleranceM;
}

export function resolveTerritoryAtPoint({
  lat,
  lon,
  flags
}: {
  lat: number;
  lon: number;
  flags: TerritoryFlag[];
}): TerritoryResolution {
  const distances = flags
    .map((flag): FlagDistance => {
      const distanceM = distanceMeters({ lat, lon }, { lat: flag.lat, lon: flag.lon });
      return {
        flag,
        distanceM,
        edgeDistanceM: distanceM - flag.claimRadiusM
      };
    })
    .sort(compareFlagDistance);

  const nearest = distances[0] ?? null;
  const nearestEdge = distances.reduce<FlagDistance | null>((current, next) => {
    if (!current) {
      return next;
    }
    const currentEdge = Math.abs(current.edgeDistanceM);
    const nextEdge = Math.abs(next.edgeDistanceM);
    if (nextEdge < currentEdge) {
      return next;
    }
    if (nextEdge === currentEdge && compareFlagDistance(next, current) < 0) {
      return next;
    }
    return current;
  }, null);
  const covering = distances.filter((entry) => entry.edgeDistanceM <= TERRITORY_EDGE_TOLERANCE_M);
  const owner = covering[0] ?? null;

  if (!owner) {
    return {
      claimed: false,
      ownerPlayerId: null,
      ownerUsername: null,
      ownerColor: null,
      nearestFlagId: nearest?.flag.id ?? null,
      nearestFlagName: nearest?.flag.name ?? null,
      distanceToNearestFlagM: nearest?.distanceM ?? null,
      distanceToNearestClaimEdgeM: nearestEdge ? Math.abs(nearestEdge.edgeDistanceM) : null,
      coveringFlagCount: 0
    };
  }

  return {
    claimed: true,
    ownerPlayerId: owner.flag.ownerId,
    ownerUsername: owner.flag.ownerUsername ?? null,
    ownerColor: owner.flag.ownerColor ?? null,
    nearestFlagId: owner.flag.id,
    nearestFlagName: owner.flag.name ?? null,
    distanceToNearestFlagM: owner.distanceM,
    distanceToNearestClaimEdgeM: nearestEdge ? Math.abs(nearestEdge.edgeDistanceM) : null,
    coveringFlagCount: covering.length
  };
}

function compareFlagDistance(left: FlagDistance, right: FlagDistance): number {
  if (left.distanceM !== right.distanceM) {
    return left.distanceM - right.distanceM;
  }
  return left.flag.id.localeCompare(right.flag.id);
}

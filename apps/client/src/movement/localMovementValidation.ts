import type { LatLon, PlayerSnapshot } from "@ash-atlas/shared";
import {
  WORLD_EDGE_MESSAGE,
  distanceMeters,
  isFiniteLatLon,
  isWithinWorldEdge
} from "@ash-atlas/shared";

export const OUTSIDE_MOVEMENT_RANGE_WARNING = "Destination is outside your movement range.";

type LocalMovementAuthority = Pick<
  PlayerSnapshot,
  "anchorLat" | "anchorLon" | "moveLeashRadiusM"
>;

export function isLocalMovementTargetValid(
  player: LocalMovementAuthority | null,
  target: LatLon
): boolean {
  if (
    !player ||
    !isFiniteLatLon(target.lat, target.lon) ||
    !isFiniteLatLon(player.anchorLat, player.anchorLon) ||
    !Number.isFinite(player.moveLeashRadiusM) ||
    player.moveLeashRadiusM < 0
  ) {
    return false;
  }

  return distanceMeters(
    { lat: player.anchorLat, lon: player.anchorLon },
    target
  ) <= player.moveLeashRadiusM;
}

export function runIfLocalMovementTargetIsValid<T>(
  player: LocalMovementAuthority | null,
  target: LatLon,
  warn: (message: string) => void,
  request: () => T,
  boundTravelRequestId?: string
): T | null {
  if (isFiniteLatLon(target.lat, target.lon) && !isWithinWorldEdge(target)) {
    warn(WORLD_EDGE_MESSAGE);
    return null;
  }
  const validRequestBoundTarget = Boolean(boundTravelRequestId) &&
    isFiniteLatLon(target.lat, target.lon);
  if (!validRequestBoundTarget && !isLocalMovementTargetValid(player, target)) {
    warn(OUTSIDE_MOVEMENT_RANGE_WARNING);
    return null;
  }
  return request();
}

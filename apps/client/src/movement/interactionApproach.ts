import {
  distanceMeters,
  moveToward,
  resolveGameplayAreaTarget,
  type LatLon
} from "@ash-atlas/shared";
import { isLocalMovementTargetValid } from "./localMovementValidation.js";

type ReachablePlayerPosition = LatLon & Readonly<{
  anchorLat: number;
  anchorLon: number;
  moveLeashRadiusM: number;
}>;

export function getClosestInteractionApproachPoint(
  playerPosition: LatLon,
  targetPosition: LatLon,
  interactionRadiusM: number,
  bufferM: number
): LatLon | null {
  if (distanceMeters(playerPosition, targetPosition) <= interactionRadiusM) {
    return null;
  }
  const approachDistanceFromTargetM = Math.max(
    0,
    interactionRadiusM - Math.max(0, bufferM)
  );
  return moveToward(targetPosition, playerPosition, approachDistanceFromTargetM);
}

export function getClosestReachableInteractionApproachPoint(
  player: ReachablePlayerPosition,
  targetPosition: LatLon,
  interactionRadiusM: number,
  bufferM: number
): LatLon | null {
  const preferred = getClosestInteractionApproachPoint(
    { lat: player.lat, lon: player.lon },
    targetPosition,
    interactionRadiusM,
    bufferM
  );
  if (!preferred || isLocalMovementTargetValid(player, preferred)) {
    return preferred;
  }

  const anchor = { lat: player.anchorLat, lon: player.anchorLon };
  const requiredDistanceFromTargetM = Math.max(
    0,
    distanceMeters(anchor, targetPosition) - player.moveLeashRadiusM
  );
  if (requiredDistanceFromTargetM > interactionRadiusM) return null;

  const bufferedDistanceFromTargetM = Math.max(
    0,
    interactionRadiusM - Math.max(0, bufferM)
  );
  const reachable = moveToward(
    targetPosition,
    anchor,
    Math.max(bufferedDistanceFromTargetM, requiredDistanceFromTargetM)
  );
  const resolved = resolveGameplayAreaTarget(player, reachable)?.target ?? null;
  return resolved && isLocalMovementTargetValid(player, resolved) &&
    distanceMeters(resolved, targetPosition) <= interactionRadiusM
    ? resolved
    : null;
}

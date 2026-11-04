import {
  resourceVisionRadiusForLeash,
  type FlagSnapshot,
  type PlayerSnapshot,
  type ResourceVision
} from "@ash-atlas/shared";

export type GameplayViewCircle = {
  center: { lat: number; lon: number };
  radiusM: number;
};

export function resolveGameplayViewCircle(
  player: PlayerSnapshot | null,
  flags: readonly FlagSnapshot[],
  resourceVision: ResourceVision | null
): GameplayViewCircle | null {
  if (resourceVision && resourceVision.radiusM > 0) {
    return {
      center: resourceVision.center,
      radiusM: resourceVision.radiusM
    };
  }
  if (!player) return null;
  const currentFlag = player.currentFlagId
    ? flags.find((flag) => flag.id === player.currentFlagId)
    : null;
  const flagRadiusM = currentFlag?.resourceVisionRadiusM;
  return {
    center: {
      lat: player.anchorLat,
      lon: player.anchorLon
    },
    radiusM: flagRadiusM && flagRadiusM > 0
      ? flagRadiusM
      : resourceVisionRadiusForLeash(player.moveLeashRadiusM)
  };
}

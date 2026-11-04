import { DEFAULT_INTERACTION_RADIUS_M, type LatLon } from "./types.js";
import {
  clampToWorldEdge,
  destinationPoint,
  distanceMeters,
  isFiniteLatLon
} from "./geo.js";

export { DEFAULT_INTERACTION_RADIUS_M } from "./types.js";

export const DEFAULT_FLAG_CLAIM_RADIUS_M = 500;
export const DEFAULT_MOVE_LEASH_RADIUS_M = 600;
export const DEFAULT_PLAYER_SPEED_MPS = 125;
export const DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M = 650;
/** Shared world interaction distance for ordinary player actions. */
/** @deprecated Use DEFAULT_INTERACTION_RADIUS_M for ordinary interactions. */
export const DEFAULT_COLLECTIBLE_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
export const DEFAULT_FLAG_PREPARE_BUFFER_M = 100;
export const DEFAULT_FLAG_PREPARE_RADIUS_M = 750;
export const DEFAULT_MOVE_LEASH_TO_VISION_GAP_M =
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M - DEFAULT_MOVE_LEASH_RADIUS_M;

/** Keeps clamped movement just inside the authoritative inclusive boundary. */
export const GAMEPLAY_AREA_BOUNDARY_EPSILON_M = 0.25;
export const GAMEPLAY_AREA_ARRIVAL_TOLERANCE_M = 1.5;

export type GameplayAreaMovementAuthority = Readonly<{
  anchorLat: number;
  anchorLon: number;
  moveLeashRadiusM: number;
}>;

export type ResolvedGameplayAreaTarget = Readonly<{
  requested: LatLon;
  target: LatLon;
  outside: boolean;
  /** Set when the leash-resolved target was pulled back onto the world edge. */
  worldEdgeClamped?: true;
}>;

export function isInsideGameplayArea(
  area: GameplayAreaMovementAuthority,
  target: LatLon
): boolean {
  return isValidGameplayAreaMovementAuthority(area) &&
    isFiniteLatLon(target.lat, target.lon) &&
    distanceMeters({ lat: area.anchorLat, lon: area.anchorLon }, target) <= area.moveLeashRadiusM;
}

export function resolveGameplayAreaTarget(
  area: GameplayAreaMovementAuthority,
  requested: LatLon
): ResolvedGameplayAreaTarget | null {
  if (!isValidGameplayAreaMovementAuthority(area) || !isFiniteLatLon(requested.lat, requested.lon)) {
    return null;
  }
  const center = { lat: area.anchorLat, lon: area.anchorLon };
  const outside = distanceMeters(center, requested) > area.moveLeashRadiusM;
  const leashTarget = outside
    ? destinationPoint(
        center,
        Math.max(0, area.moveLeashRadiusM - GAMEPLAY_AREA_BOUNDARY_EPSILON_M),
        initialBearingDegrees(center, requested)
      )
    : { ...requested };
  // Like the leash, the world edge resolves a movement target to the nearest
  // reachable point (same meridian) instead of rejecting the whole move.
  const target = clampToWorldEdge(leashTarget);
  return {
    requested: { ...requested },
    target,
    outside,
    ...(target === leashTarget ? {} : { worldEdgeClamped: true as const })
  };
}

function isValidGameplayAreaMovementAuthority(area: GameplayAreaMovementAuthority): boolean {
  return isFiniteLatLon(area.anchorLat, area.anchorLon) &&
    Number.isFinite(area.moveLeashRadiusM) &&
    area.moveLeashRadiusM >= 0;
}

function initialBearingDegrees(from: LatLon, to: LatLon): number {
  const fromLat = from.lat * Math.PI / 180;
  const toLat = to.lat * Math.PI / 180;
  const deltaLon = (to.lon - from.lon) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);
  return Math.atan2(y, x) * 180 / Math.PI;
}

export type FlagRadiusContract = Readonly<{
  claimRadiusM: number;
  movementLeashRadiusM: number;
  certifiedVisionRadiusM: number;
  preparationBufferM: number;
  preparedRadiusM: number;
}>;

export const DEFAULT_FLAG_RADIUS_CONTRACT: FlagRadiusContract = Object.freeze({
  claimRadiusM: DEFAULT_FLAG_CLAIM_RADIUS_M,
  movementLeashRadiusM: DEFAULT_MOVE_LEASH_RADIUS_M,
  certifiedVisionRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  preparationBufferM: DEFAULT_FLAG_PREPARE_BUFFER_M,
  preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M
});

export type GameplayAreaSourceType =
  | "flag"
  | "kingdom_seat"
  | "area"
  | "player_anchor";

export type GameplayAreaContract = Readonly<{
  center: LatLon;
  certifiedVisibleRadiusM: number;
  preparedRadiusM: number;
  sourceType: GameplayAreaSourceType;
  sourceId: string;
  generation: number;
}>;

export function flagRadiusContractIssues(contract: FlagRadiusContract): string[] {
  const issues: string[] = [];
  for (const [name, value] of Object.entries(contract)) {
    if (!Number.isFinite(value) || value <= 0) issues.push(`${name} must be positive`);
  }
  if (contract.claimRadiusM >= contract.movementLeashRadiusM) {
    issues.push("claim radius must be smaller than movement leash radius");
  }
  if (
    contract.certifiedVisionRadiusM <
    contract.movementLeashRadiusM + DEFAULT_COLLECTIBLE_INTERACTION_RADIUS_M
  ) {
    issues.push(
      "certified vision radius must include the movement leash plus collectible interaction radius"
    );
  }
  if (contract.certifiedVisionRadiusM >= contract.preparedRadiusM) {
    issues.push("certified vision radius must be smaller than prepared radius");
  }
  if (
    contract.certifiedVisionRadiusM + contract.preparationBufferM !==
    contract.preparedRadiusM
  ) {
    issues.push("prepared radius must equal certified vision radius plus preparation buffer");
  }
  return issues;
}

export function assertGameplayAreaContract(area: GameplayAreaContract): void {
  if (
    !Number.isFinite(area.center.lat) ||
    !Number.isFinite(area.center.lon) ||
    !Number.isFinite(area.certifiedVisibleRadiusM) ||
    !Number.isFinite(area.preparedRadiusM) ||
    area.certifiedVisibleRadiusM <= 0 ||
    area.preparedRadiusM <= area.certifiedVisibleRadiusM ||
    !area.sourceId ||
    !Number.isSafeInteger(area.generation) ||
    area.generation < 0
  ) {
    throw new Error("invalid authoritative gameplay area contract");
  }
}

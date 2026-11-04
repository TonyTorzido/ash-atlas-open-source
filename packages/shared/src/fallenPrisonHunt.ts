import { bearingDegrees } from "./boss.js";
import { distanceMeters } from "./geo.js";
import type { LatLon } from "./types.js";

/**
 * The Fallen Prison hunt (docs/design/WORLD_DUNGEON_ENTRANCES.md, "Fallen Prison hunt"): the crash lands
 * 15-30 km from a level 40 player, and level 40 players within FALLEN_PRISON_HUNT.hintRadiusM get only a
 * rough, live hint (an 8-point compass direction and a coarse distance band) until the smoke column
 * comes into sight.
 */
export const FALLEN_PRISON_HUNT = Object.freeze({
  /** Level 40 players within this distance of a live crash get the hint. */
  hintRadiusM: 40_000,
  /** "near" below this distance. */
  nearM: 3_000,
  /** "closer" below this distance, "far" from here out. */
  closerM: 10_000,
  /** The crash (and its smoke column) is listed to players within this distance, not the usual 25 km. */
  smokeSightM: 3_000
});

export const FALLEN_PRISON_HUNT_DIRECTIONS = [
  "north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"
] as const;
export type FallenPrisonHuntDirection = (typeof FALLEN_PRISON_HUNT_DIRECTIONS)[number];
export const FALLEN_PRISON_HUNT_BANDS = ["far", "closer", "near"] as const;
export type FallenPrisonHuntBand = (typeof FALLEN_PRISON_HUNT_BANDS)[number];

export type FallenPrisonHuntHint = Readonly<{
  direction: FallenPrisonHuntDirection;
  band: FallenPrisonHuntBand;
  /** Within smoke sight: the crash is in the player's nearby entrance list. */
  smokeInSight: boolean;
}>;

/** The 8-point compass direction of a bearing (degrees clockwise from north). */
export function fallenPrisonHuntDirection(bearing: number): FallenPrisonHuntDirection {
  const normalized = ((bearing % 360) + 360) % 360;
  return FALLEN_PRISON_HUNT_DIRECTIONS[Math.round(normalized / 45) % 8]!;
}

/** The coarse distance band of a distance in metres. */
export function fallenPrisonHuntBand(distanceM: number): FallenPrisonHuntBand {
  return distanceM < FALLEN_PRISON_HUNT.nearM ? "near" : distanceM < FALLEN_PRISON_HUNT.closerM ? "closer" : "far";
}

/** The hint from `from` towards a crash at `crash`, or null when the crash is beyond the hint radius. */
export function fallenPrisonHuntHint(from: LatLon, crash: LatLon): FallenPrisonHuntHint | null {
  const distanceM = distanceMeters(from, crash);
  if (!Number.isFinite(distanceM) || distanceM > FALLEN_PRISON_HUNT.hintRadiusM) return null;
  return {
    direction: fallenPrisonHuntDirection(bearingDegrees(from, crash)),
    band: fallenPrisonHuntBand(distanceM),
    smokeInSight: distanceM <= FALLEN_PRISON_HUNT.smokeSightM
  };
}

/** The landing announcement for a player at `from`. */
export function fallenPrisonLandingAnnouncement(from: LatLon, crash: LatLon): string {
  return `A prison has fallen from the sky somewhere to the ${fallenPrisonHuntDirection(bearingDegrees(from, crash))}.`;
}

/** The degrees an arrow should turn for a direction (north = 0). */
export function fallenPrisonHuntDirectionDegrees(direction: FallenPrisonHuntDirection): number {
  return FALLEN_PRISON_HUNT_DIRECTIONS.indexOf(direction) * 45;
}

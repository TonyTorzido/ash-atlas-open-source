import {
  BOW_SHOT_PROFILE,
  SWING_MAX_TARGETS,
  shotLineContains,
  swingArcContains,
  toLocalMeters,
  type LocalMetersOut,
  type ShotProfile
} from "@ash-atlas/shared";

/**
 * Pure part of server swing resolution (action combat, plan §2): candidate geometry plus
 * nearest-N selection. Allocation-free per candidate: the caller owns one `SwingTargetScratch`
 * and one reader function and reuses both for every swing.
 */

/** Filled by the reader for one candidate: its (rewound) position and its body radius. */
export type SwingCandidateSample = { lat: number; lon: number; radiusM: number };

/**
 * Reads one candidate id into `out`. Returns false to skip it (wrong kind, dead, invulnerable,
 * owned by another session, ...). Game rules live in the reader; geometry lives here.
 */
export type SwingCandidateReader = (entityId: string, out: SwingCandidateSample) => boolean;

/** Fixed-slot result of a selection: `ids[0..count)` sorted nearest first, centre distances alongside. */
export type SwingTargetScratch = {
  readonly ids: string[];
  readonly distancesM: Float64Array;
  count: number;
  readonly sample: SwingCandidateSample;
  readonly local: LocalMetersOut;
};

export function createSwingTargetScratch(maxTargets: number = SWING_MAX_TARGETS): SwingTargetScratch {
  return {
    ids: new Array<string>(maxTargets).fill(""),
    distancesM: new Float64Array(maxTargets),
    count: 0,
    sample: { lat: 0, lon: 0, radiusM: 0 },
    local: { x: 0, y: 0 }
  };
}

/**
 * Keeps the nearest `ids.length` offers by insertion into the fixed slots. Ties keep the earlier
 * offer first (grid ids arrive sorted, so the result is deterministic). No sort, no allocation.
 */
export function offerSwingTarget(scratch: SwingTargetScratch, entityId: string, distanceM: number): void {
  const capacity = scratch.ids.length;
  let index = scratch.count;
  if (index >= capacity) {
    if (distanceM >= scratch.distancesM[capacity - 1]!) return;
    index = capacity - 1;
  } else {
    scratch.count += 1;
  }
  while (index > 0 && scratch.distancesM[index - 1]! > distanceM) {
    scratch.ids[index] = scratch.ids[index - 1]!;
    scratch.distancesM[index] = scratch.distancesM[index - 1]!;
    index -= 1;
  }
  scratch.ids[index] = entityId;
  scratch.distancesM[index] = distanceM;
}

/**
 * Tests every candidate against the swing arc from (originLat, originLon) along the world-space
 * unit direction (dirX east, dirY north), in the attacker's local metric frame. Fills `scratch`
 * with the nearest SWING_MAX_TARGETS hits and returns how many there are.
 */
export function selectSwingTargets(
  originLat: number,
  originLon: number,
  dirX: number,
  dirY: number,
  candidateIds: readonly string[],
  read: SwingCandidateReader,
  scratch: SwingTargetScratch
): number {
  scratch.count = 0;
  const cosLat0 = Math.cos((originLat * Math.PI) / 180);
  const sample = scratch.sample;
  const local = scratch.local;
  for (let index = 0; index < candidateIds.length; index += 1) {
    const entityId = candidateIds[index]!;
    if (!read(entityId, sample)) continue;
    toLocalMeters(originLat, originLon, cosLat0, sample.lat, sample.lon, local);
    if (!swingArcContains(dirX, dirY, local.x, local.y, sample.radiusM)) continue;
    // Nearest by distance to the target's edge, so a big body in reach is not skipped for a small one behind it.
    offerSwingTarget(scratch, entityId, Math.max(0, Math.hypot(local.x, local.y) - Math.max(0, sample.radiusM)));
  }
  return scratch.count;
}

/**
 * Hitscan shot (ranged proof): tests every candidate against the profile's range x width corridor (the bow's by default)
 * along the unit direction and keeps only the FIRST one on the line (smallest distance along it; ties keep
 * the earlier offer). On a hit `scratch.ids[0]` is the target and `scratch.distancesM[0]` its distance along
 * the aim line. Returns 0 or 1. Allocation-free per candidate, like `selectSwingTargets`.
 */
export function selectShotTarget(
  originLat: number,
  originLon: number,
  dirX: number,
  dirY: number,
  candidateIds: readonly string[],
  read: SwingCandidateReader,
  scratch: SwingTargetScratch,
  profile: ShotProfile = BOW_SHOT_PROFILE
): number {
  scratch.count = 0;
  const cosLat0 = Math.cos((originLat * Math.PI) / 180);
  const sample = scratch.sample;
  const local = scratch.local;
  for (let index = 0; index < candidateIds.length; index += 1) {
    const entityId = candidateIds[index]!;
    if (!read(entityId, sample)) continue;
    toLocalMeters(originLat, originLon, cosLat0, sample.lat, sample.lon, local);
    const along = shotLineContains(dirX, dirY, local.x, local.y, sample.radiusM, profile);
    if (along === null || (scratch.count > 0 && along >= scratch.distancesM[0]!)) continue;
    scratch.ids[0] = entityId;
    scratch.distancesM[0] = along;
    scratch.count = 1;
  }
  return scratch.count;
}

/**
 * Every candidate on a shot's line (the profile's corridor), with its distance along the aim line, in candidate order
 * (unsorted; `resolveHolyArcPath` orders them). The holy arc uses it for the allies it passes through. Allocates only
 * the result entries.
 */
export function collectShotLineEntries(
  originLat: number,
  originLon: number,
  dirX: number,
  dirY: number,
  candidateIds: readonly string[],
  read: SwingCandidateReader,
  scratch: SwingTargetScratch,
  profile: ShotProfile
): Array<{ id: string; alongM: number }> {
  const entries: Array<{ id: string; alongM: number }> = [];
  const cosLat0 = Math.cos((originLat * Math.PI) / 180);
  const sample = scratch.sample;
  const local = scratch.local;
  for (const entityId of candidateIds) {
    if (!read(entityId, sample)) continue;
    toLocalMeters(originLat, originLon, cosLat0, sample.lat, sample.lon, local);
    const along = shotLineContains(dirX, dirY, local.x, local.y, sample.radiusM, profile);
    if (along !== null) entries.push({ id: entityId, alongM: along });
  }
  return entries;
}

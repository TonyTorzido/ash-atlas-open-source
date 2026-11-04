import {
  distanceMeters,
  interpolateLatLon,
  type CombatEntitySnapshot,
  type LatLon
} from "@ash-atlas/shared";

/** Linear motion between two server samples, for companions that step every server update. */
export type CompanionRenderMotion = {
  from: LatLon;
  to: LatLon;
  startMs: number;
  durationMs: number;
  lastSampleMs: number;
};

const COMPANION_MIN_SAMPLE_MS = 50;
const COMPANION_MAX_SAMPLE_MS = 250;
/** Larger than any walking step between samples: the owner travelled, so the pet appears there. */
const COMPANION_SNAP_M = 400;
/** World mobs walk a few metres per second; a correction this large is a teleport or respawn and snaps. */
export const MOB_RENDER_SNAP_M = 40;

/**
 * Companions render at a steady velocity from the previous server sample to the latest one over
 * the observed sample interval, so a pet walking at constant speed moves continuously instead of
 * catching up and pausing between deltas. A travel-sized jump snaps. World mobs use the same model
 * with a smaller snap distance.
 */
export function nextCompanionRenderPosition(
  motion: CompanionRenderMotion | null,
  current: LatLon | null,
  entity: LatLon,
  nowMs: number,
  snapM = COMPANION_SNAP_M
): Readonly<{ position: LatLon; motion: CompanionRenderMotion }> {
  const target = { lat: entity.lat, lon: entity.lon };
  if (!motion || !current) {
    return { position: target, motion: { from: target, to: target, startMs: nowMs, durationMs: 0, lastSampleMs: nowMs } };
  }
  let next = motion;
  if (Math.abs(target.lat - motion.to.lat) > 1e-10 || Math.abs(target.lon - motion.to.lon) > 1e-10) {
    if (distanceMeters(current, target) > snapM) {
      return { position: target, motion: { from: target, to: target, startMs: nowMs, durationMs: 0, lastSampleMs: nowMs } };
    }
    const interval = Math.max(COMPANION_MIN_SAMPLE_MS, Math.min(COMPANION_MAX_SAMPLE_MS, nowMs - motion.lastSampleMs));
    next = { from: current, to: target, startMs: nowMs, durationMs: interval, lastSampleMs: nowMs };
  }
  const progress = next.durationMs <= 0 ? 1 : Math.max(0, Math.min(1, (nowMs - next.startMs) / next.durationMs));
  // Land exactly on the sample so the render stops changing (and the overlay can go idle) once it is reached.
  const position = progress >= 1 ? next.to : interpolateLatLon(next.from, next.to, progress);
  return { position, motion: next };
}

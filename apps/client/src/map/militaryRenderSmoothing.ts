import { distanceMeters, interpolateLatLon, type LatLon } from "@ash-atlas/shared";

/** Corrections beyond this distance are authoritative discontinuities. */
export const MILITARY_RENDER_SNAP_DISTANCE_M = 500;

export type MilitaryRenderSample = Readonly<{
  authoritative: LatLon;
  rendered: LatLon;
  locationState: string;
  revision: string;
}>;

/**
 * Decide whether a newly published military coordinate should replace the
 * rendered sample immediately. Normal movement is interpolated in the map
 * frame loop; reconnects, large corrections, and stationary lifecycle changes
 * must not leave a unit visibly travelling through invalid state.
 */
export function shouldSnapMilitaryRenderPosition(
  previous: MilitaryRenderSample | null,
  next: Pick<MilitaryRenderSample, "authoritative" | "locationState">,
  reducedMotion: boolean
): boolean {
  if (!previous || reducedMotion) return true;
  if (
    previous.locationState !== next.locationState &&
    (
      previous.locationState === "STATIONED_CITY" ||
      previous.locationState === "STATIONED_WAR_CAMP" ||
      previous.locationState === "RECOVERING" ||
      next.locationState === "STATIONED_CITY" ||
      next.locationState === "STATIONED_WAR_CAMP" ||
      next.locationState === "RECOVERING"
    )
  ) {
    return true;
  }
  return distanceMeters(previous.authoritative, next.authoritative) > MILITARY_RENDER_SNAP_DISTANCE_M;
}

/**
 * Advance the rendered point toward the latest authoritative sample. The
 * exponential blend is frame-rate independent and never overshoots.
 */
export function nextMilitaryRenderPosition(
  current: LatLon | null,
  target: LatLon,
  deltaSeconds: number,
  reducedMotion: boolean
): LatLon {
  if (!current || reducedMotion) return { ...target };
  const distance = distanceMeters(current, target);
  if (!Number.isFinite(distance) || distance <= 0.01) return { ...target };
  const blend = 1 - Math.exp(-Math.max(0, deltaSeconds) * 14);
  return interpolateLatLon(current, target, blend);
}

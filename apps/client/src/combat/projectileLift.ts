import { MOB_RANGED_AIM_ID, type BossTelegraphGeometry, type LatLon } from "@ash-atlas/shared";

/**
 * Lifted projectiles (docs/plans/hurt-circles.md): a projectile is drawn at chest height while a small soft shadow
 * traces its true ground path, the one the server tests against hurt circles. Pure helpers; pixiOverlay draws.
 */

/** Mob telegraphs whose strike is a projectile: the ranged aim shot, the caster volley lines and the blast orb. */
export const MOB_PROJECTILE_ABILITY_IDS: ReadonlySet<string> = new Set([
  MOB_RANGED_AIM_ID, "caster_volley_l", "caster_volley_c", "caster_volley_r", "caster_blast"
]);
/** A mob shot flies this long once its telegraph resolves (the player's arrow takes SHOT_FLIGHT_MS = 150). */
export const MOB_SHOT_FLIGHT_MS = 180;
/** Ground shadow ellipse of a flying projectile, in screen px (scaled with the sprite scale by the renderer). */
export const PROJECTILE_SHADOW_RADIUS_X_PX = 6;
export const PROJECTILE_SHADOW_RADIUS_Y_PX = 2.5;
export const PROJECTILE_SHADOW_ALPHA = 0.28;

export type ScreenPoint = { x: number; y: number };

/**
 * Where a projectile is drawn at `progress` (0..1) along its ground path from `start` to `end`: `ground` is the true
 * position (the shadow), `body` the same point lifted `liftPx` up the screen (the projectile art).
 */
export function liftedProjectilePoint(
  start: ScreenPoint, end: ScreenPoint, progress: number, liftPx: number,
  out: { ground: ScreenPoint; body: ScreenPoint } = { ground: { x: 0, y: 0 }, body: { x: 0, y: 0 } }
): { ground: ScreenPoint; body: ScreenPoint } {
  const t = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  out.ground.x = start.x + (end.x - start.x) * t;
  out.ground.y = start.y + (end.y - start.y) * t;
  out.body.x = out.ground.x;
  out.body.y = out.ground.y - Math.max(0, liftPx);
  return out;
}

/**
 * Ground path of a mob projectile from its telegraph: a line flies from its origin to its far end; the blast orb
 * flies from the caster (`source`) to the circle's centre. Null for shapes without a path.
 */
export function mobProjectileGroundPath(
  geometry: BossTelegraphGeometry, source: LatLon | null
): { start: LatLon; end: LatLon } | null {
  if (geometry.kind === "line") {
    const rad = (geometry.facingDegrees * Math.PI) / 180;
    const cosLat = Math.max(1e-6, Math.cos((geometry.origin.lat * Math.PI) / 180));
    const metresPerDegree = 111_320;
    return {
      start: geometry.origin,
      end: {
        lat: geometry.origin.lat + (Math.cos(rad) * geometry.lengthM) / metresPerDegree,
        lon: geometry.origin.lon + (Math.sin(rad) * geometry.lengthM) / (metresPerDegree * cosLat)
      }
    };
  }
  if (geometry.kind === "circle" && source) return { start: source, end: geometry.center };
  return null;
}

/** Flight progress of a mob shot `elapsedMs` after its telegraph resolved, or null when it is not in the air. */
export function mobShotFlightProgress(elapsedMs: number): number | null {
  if (!(elapsedMs >= 0) || elapsedMs > MOB_SHOT_FLIGHT_MS) return null;
  return elapsedMs / MOB_SHOT_FLIGHT_MS;
}

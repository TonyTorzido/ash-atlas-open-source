import { MOB_TACTICS_BODY_WIDTH_M, MOB_TACTICS_PLAYER_BODY_WIDTH_M, mobTacticsBodyWidthM, mobTacticsSpriteBodyWidthM } from "./mobTactics.js";
import { RUNTIME_PNG_PRESENTATION_CATALOG } from "./runtimePngPresentation.js";

/**
 * Readable 2.5D hit geometry (docs/plans/hurt-circles.md). Every combatant has a ground hurt circle anchored at
 * its feet (the entity position); every attack is a ground shape (circle, cone, lane, swept segment) and a hit is
 * "the shape overlaps the hurt circle", never "the centre point is inside the shape". The art floats above the
 * circle; projectiles and impact VFX are lifted to chest height on the client only, so the server never needs a Z.
 *
 * All helpers work in a local metric frame centred on the shape's origin (x = metres east, y = metres north, as
 * `toLocalMeters` builds it). Facings are compass bearings in degrees (0 = north, 90 = east).
 */

/** Share of the player's half body width that counts as its hurt circle (the feet, not the whole sprite). */
export const PLAYER_HURT_RADIUS_SCALE = 0.65;
/** Player hurt circle radius: 0.65 x half of MOB_TACTICS_PLAYER_BODY_WIDTH_M (about 13.8 m at master scale 0.8). */
export const PLAYER_HURT_RADIUS_M = PLAYER_HURT_RADIUS_SCALE * MOB_TACTICS_PLAYER_BODY_WIDTH_M / 2;
/**
 * Mob hurt circle = this x half of the art-derived body width (mobTacticsBodyWidthM). Slightly over 1 so player
 * swings and shots connect when they visibly touch the body (player-favoured, the old "measure to the edge" rule).
 */
export const MOB_HURT_RADIUS_SCALE = 1.05;

/** Hurt circle of a mob from its archetype and sprite keys (art-derived, falls back to the generic body width). */
export function mobHurtRadiusM(archetypeKey: string | null | undefined, spriteKey?: string | null): number {
  return MOB_HURT_RADIUS_SCALE * mobTacticsBodyWidthM(archetypeKey, spriteKey) / 2;
}

/** Largest mob hurt circle any catalog sprite produces: broad-phase query margin so big bodies are never skipped. */
export const MOB_HURT_RADIUS_MAX_M = (() => {
  let widest = MOB_TACTICS_BODY_WIDTH_M;
  for (const key of Object.keys(RUNTIME_PNG_PRESENTATION_CATALOG.sprites)) widest = Math.max(widest, mobTacticsSpriteBodyWidthM(key));
  return MOB_HURT_RADIUS_SCALE * widest / 2;
})();

/**
 * Reach compensation: the size a shape is drawn and tested at so that, against a hurt circle of `hurtRadiusM`, it
 * connects at the same centre distance `effectiveReachM` a point test used to. Never below `minM`.
 */
export function hurtShapeReachM(effectiveReachM: number, hurtRadiusM: number, minM = 1): number {
  return Math.max(minM, effectiveReachM - Math.max(0, hurtRadiusM));
}

function finite(...values: number[]): boolean {
  for (const value of values) if (!Number.isFinite(value)) return false;
  return true;
}

/** Two circles overlap (touching counts). */
export function circleVsCircle(x: number, y: number, radiusM: number, cx: number, cy: number, otherRadiusM: number): boolean {
  if (!finite(x, y, cx, cy)) return false;
  return Math.hypot(x - cx, y - cy) <= Math.max(0, radiusM) + Math.max(0, otherRadiusM);
}

/**
 * A circle at (x, y) of `radiusM` overlaps the sector with its apex at the origin, `rangeM` long, `angleDeg` wide,
 * centred on `facingDeg`. Exact: the circle hits when its distance to the sector is at most its radius.
 */
export function circleVsCone(facingDeg: number, rangeM: number, angleDeg: number, x: number, y: number, radiusM: number): boolean {
  if (!finite(facingDeg, rangeM, angleDeg, x, y)) return false;
  const radius = Math.max(0, radiusM);
  const distance = Math.hypot(x, y);
  if (distance <= radius) return true;
  if (distance - radius > rangeM) return false;
  const half = Math.min(180, Math.max(0, angleDeg / 2)) * Math.PI / 180;
  const facing = facingDeg * Math.PI / 180;
  const ux = Math.sin(facing);
  const uy = Math.cos(facing);
  const along = ux * x + uy * y;
  const across = Math.abs(ux * y - uy * x);
  // Centre inside the wedge: only the arc can be in the way (already checked).
  if (Math.atan2(across, along) <= half + 1e-9) return true;
  // Otherwise the nearest point of the sector is on the nearer edge segment (apex to arc end).
  const ex = Math.cos(half);
  const ey = Math.sin(half);
  const t = Math.min(rangeM, Math.max(0, along * ex + across * ey));
  return Math.hypot(along - t * ex, across - t * ey) <= radius;
}

/**
 * A circle at (x, y) of `radiusM` overlaps the capsule swept by a projectile of `halfWidthM` travelling from
 * (ax, ay) to (bx, by). The whole path is tested at once, so a fast shot cannot tunnel through a small body
 * between two tick samples.
 */
export function circleVsSegment(
  ax: number, ay: number, bx: number, by: number, halfWidthM: number, x: number, y: number, radiusM: number
): boolean {
  return segmentCircleDistanceM(ax, ay, bx, by, x, y) <= Math.max(0, halfWidthM) + Math.max(0, radiusM);
}

/** Distance from (x, y) to the segment (ax, ay)-(bx, by); Infinity for non-finite input. */
export function segmentCircleDistanceM(ax: number, ay: number, bx: number, by: number, x: number, y: number): number {
  if (!finite(ax, ay, bx, by, x, y)) return Number.POSITIVE_INFINITY;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/**
 * A circle at (x, y) of `radiusM` overlaps the lane (oriented rectangle) that starts at the origin and runs
 * `lengthM` along `facingDeg`, `widthM` wide (half each side). This is a lane telegraph decal: charge, lunge,
 * tongue, ranged aim, volley line.
 */
export function circleVsRect(facingDeg: number, lengthM: number, widthM: number, x: number, y: number, radiusM: number): boolean {
  if (!finite(facingDeg, lengthM, widthM, x, y)) return false;
  const facing = facingDeg * Math.PI / 180;
  const along = Math.sin(facing) * x + Math.cos(facing) * y;
  const across = Math.abs(Math.cos(facing) * x - Math.sin(facing) * y);
  const dAlong = along < 0 ? -along : along > lengthM ? along - lengthM : 0;
  const dAcross = Math.max(0, across - Math.max(0, widthM) / 2);
  return Math.hypot(dAlong, dAcross) <= Math.max(0, radiusM);
}

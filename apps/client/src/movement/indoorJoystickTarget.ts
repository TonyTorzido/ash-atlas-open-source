import { isIndoorNavigationPointWalkable, type IndoorPoint, type IndoorRoomNavigation } from "@ash-atlas/shared";

/** Shorter steps than this are not worth a server move (the stick is pushing into a wall). */
const MIN_STEP_UNITS = 6;
const SEARCH_STEPS = 10;

/**
 * Joystick, keys and pad inside a DOM interior (manor, salon, greenhouse): the stick's look-ahead target, kept on the room's
 * walkable floor so the server never rejects it ("That target is outside the manor floor"). An off-floor target slides along
 * the wall (one axis kept), else stops at the furthest walkable point toward it; null when the player cannot move that way.
 */
export function walkableIndoorJoystickTarget(
  room: IndoorRoomNavigation,
  from: IndoorPoint,
  target: IndoorPoint
): IndoorPoint | null {
  const walkable = (point: IndoorPoint): boolean => isIndoorNavigationPointWalkable(room, point);
  const far = (point: IndoorPoint): boolean => Math.hypot(point.x - from.x, point.y - from.y) >= MIN_STEP_UNITS;
  if (walkable(target)) return far(target) ? target : null;
  const along = furthestWalkable(walkable, from, target);
  // Slide: keep the axis that still moves (pushing diagonally into a wall walks along it, like the overworld shore slide).
  const slides = [{ x: target.x, y: from.y }, { x: from.x, y: target.y }]
    .map((slide) => furthestWalkable(walkable, from, slide))
    .filter((point): point is IndoorPoint => point !== null && far(point));
  const best = [along, ...slides]
    .filter((point): point is IndoorPoint => point !== null && far(point))
    .sort((a, b) => progress(from, target, b) - progress(from, target, a))[0];
  return best ?? null;
}

function progress(from: IndoorPoint, target: IndoorPoint, point: IndoorPoint): number {
  return (point.x - from.x) * (target.x - from.x) + (point.y - from.y) * (target.y - from.y);
}

/** The furthest walkable point on from -> to (bisection, from assumed walkable), or null when the first step is blocked. */
function furthestWalkable(walkable: (point: IndoorPoint) => boolean, from: IndoorPoint, to: IndoorPoint): IndoorPoint | null {
  const at = (t: number): IndoorPoint => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  if (walkable(to)) return to;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < SEARCH_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (walkable(at(mid))) lo = mid;
    else hi = mid;
  }
  return lo > 0 ? at(lo) : null;
}

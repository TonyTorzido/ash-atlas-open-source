import { dashDirectionForBearing, toLocalMeters, type LatLon, type LocalMetersOut } from "@ash-atlas/shared";

import { joystickBearingDeg, normalizeDegrees } from "../movement/joystickMovementMath.js";
import type { SwingDirection } from "./swing.js";

/**
 * Aim helpers for action combat. Directions on the wire are WORLD-space unit vectors (dirX east,
 * dirY north); screen vectors are x right, y down. The map bearing is the compass heading at the
 * top of the screen, the same convention as `joystickBearingDeg`.
 */

/** World aim for a screen-space offset from the player (cursor, stick). Null inside the dead zone. */
export function swingDirectionFromScreenOffset(
  dxPx: number,
  dyPx: number,
  mapBearingDeg: number,
  radiusPx = 1
): SwingDirection | null {
  const bearingDeg = joystickBearingDeg(dxPx, dyPx, radiusPx, mapBearingDeg);
  return bearingDeg === null ? null : dashDirectionForBearing(bearingDeg);
}

/** Unit vector in the screen plane (x right, y down) for a world aim, for the pose lunge and arc. */
export function swingScreenDirection(direction: SwingDirection, mapBearingDeg: number): { x: number; y: number } {
  const bearingDeg = (Math.atan2(direction.dirX, direction.dirY) * 180) / Math.PI;
  const rad = ((normalizeDegrees(bearingDeg - mapBearingDeg)) * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

const scratch: LocalMetersOut = { x: 0, y: 0 };

/** World aim from one position toward another; null when they coincide. */
export function swingDirectionToward(from: LatLon, to: LatLon): SwingDirection | null {
  toLocalMeters(from.lat, from.lon, Math.cos((from.lat * Math.PI) / 180), to.lat, to.lon, scratch);
  const length = Math.hypot(scratch.x, scratch.y);
  if (!(length > 0.01)) return null;
  return { dirX: scratch.x / length, dirY: scratch.y / length };
}

/**
 * Attack button drag: inside this distance (px) of the button centre the finger is "on the button".
 * Just past a thumb's wobble on a tap (~12 px), so a sloppy tap still auto-aims; the first move past it picks
 * a direction and swings at once.
 */
export const ATTACK_BUTTON_DEAD_ZONE_PX = 18;
/**
 * Once aiming, the finger must come back inside this (px) to pause: hysteresis against jitter at the dead zone edge.
 * Below ATTACK_AIM_DECISION_PX so a pull caught early (at ~9 px) does not pause on its next small wobble.
 */
export const ATTACK_BUTTON_RELEASE_PX = 5;
/**
 * Touch-down grace (owner 2026-10-20, widened t1559): the touch attack button waits this long after touch-down before
 * its auto-aimed swing, so a thumb that lands and pulls (walking left, pulling the stick right) swings toward the pull
 * first instead of the last movement bearing. 60 ms was too short: a real thumb takes ~100-250 ms from landing to cross
 * the old 18 px dead zone. Inside the window a drag past ATTACK_AIM_DECISION_PX swings at once in the drag direction;
 * a finger lifted inside it swings toward the lift point when that is past the same distance (a fast flick whose moves
 * were coalesced into the pointerup), else auto-aimed; a still hold starts the auto swings when it ends and repeats
 * them at the recovery cadence (SwingClientState gates it, so a tap never swings twice). Mouse and gamepad aim are
 * not delayed.
 */
export const ATTACK_TOUCH_GRACE_MS = 150;
/** Holding the button still this long starts the auto-aimed swings (the touch-down grace). */
export const ATTACK_HOLD_REPEAT_MS = ATTACK_TOUCH_GRACE_MS;
/**
 * The first aim decision inside the touch-down grace uses this smaller dead zone (px): a pull is caught after a few
 * frames of travel, well before it would cross ATTACK_BUTTON_DEAD_ZONE_PX. A still thumb drifts ~2-5 px while it
 * settles; most of the ~12 px tap wobble lands on the lift, which only counts if it is past this too. After the
 * window (a held auto swing) leaving the full dead zone is needed to switch to aiming, so hold wobble never flips it.
 */
export const ATTACK_AIM_DECISION_PX = 9;
/**
 * A finger already this far (px) off its landing point when the grace ends is still travelling (a slow pull, e.g. one that
 * crosses the old 18 px at ~200 ms): the decision then waits up to ATTACK_TOUCH_GRACE_MAX_MS for it to reach
 * ATTACK_AIM_DECISION_PX before the auto-aimed swing. A thumb resting still stays under it, so a hold is not delayed.
 */
export const ATTACK_GRACE_MOVING_PX = 3;
/** The latest the first auto-aimed swing of a held, slowly moving finger waits (ms after touch-down). */
export const ATTACK_TOUCH_GRACE_MAX_MS = 250;

/** The touch-down grace for a finger currently `offsetPx` off its landing point (the hold time before auto swings). */
export function attackTouchGraceMs(offsetPx: number): number {
  return offsetPx >= ATTACK_GRACE_MOVING_PX ? ATTACK_TOUCH_GRACE_MAX_MS : ATTACK_TOUCH_GRACE_MS;
}

export type AttackDragState =
  /** On the button and never left it: a tap (or a hold). */
  | { kind: "idle" }
  /** Dragged out far enough to aim. */
  | { kind: "aim"; direction: SwingDirection }
  /** Aimed, then dragged back onto the button: releasing swings nothing. */
  | { kind: "cancel" };

/**
 * Classifies a finger offset (screen px, x right, y down) from the attack button's centre.
 * Leaving the dead zone (`deadZonePx`, ATTACK_AIM_DECISION_PX during the touch-down grace) starts aiming; coming back
 * in after aiming cancels.
 */
export function classifyAttackDrag(
  dxPx: number,
  dyPx: number,
  mapBearingDeg: number,
  wasAiming: boolean,
  deadZonePx = ATTACK_BUTTON_DEAD_ZONE_PX
): AttackDragState {
  const length = Math.hypot(dxPx, dyPx);
  if (wasAiming ? length < ATTACK_BUTTON_RELEASE_PX : length < deadZonePx) {
    return wasAiming ? { kind: "cancel" } : { kind: "idle" };
  }
  const direction = swingDirectionFromScreenOffset(dxPx, dyPx, mapBearingDeg, 1);
  return direction ? { kind: "aim", direction } : { kind: "idle" };
}

/** A tap auto-aim candidate; `radiusM` is its ground hurt circle (the swing reaches its edge, as on the server). */
export type AutoAimMob = Readonly<{ lat: number; lon: number; radiusM?: number }>;

/** Tap auto-aim prefers a mob within this many degrees either side of the facing (the last movement bearing). */
export const AUTO_AIM_CONE_HALF_DEG = 70;

/**
 * Tap aim: the nearest mob within `rangeM` inside the forgiving cone around the facing (`lastBearingDeg`, compass
 * degrees), else the nearest mob in range anywhere, else the facing, else null. `mobs` must already be alive hostile
 * mobs only (rendered positions).
 */
export function autoAimDirection(
  origin: LatLon,
  mobs: Iterable<AutoAimMob>,
  rangeM: number,
  lastBearingDeg: number | null,
  coneHalfDeg = AUTO_AIM_CONE_HALF_DEG
): SwingDirection | null {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  let best: AutoAimMob | null = null;
  let bestDistance = Infinity;
  let bestInCone: AutoAimMob | null = null;
  let bestInConeDistance = Infinity;
  for (const mob of mobs) {
    toLocalMeters(origin.lat, origin.lon, cosLat, mob.lat, mob.lon, scratch);
    // Measured to the hurt circle edge, like the server swing test, but ranked by centre distance.
    const distance = Math.hypot(scratch.x, scratch.y);
    if (!(distance - Math.max(0, mob.radiusM ?? 0) <= rangeM)) continue;
    if (distance < bestDistance) { best = mob; bestDistance = distance; }
    if (lastBearingDeg !== null) {
      const bearing = (Math.atan2(scratch.x, scratch.y) * 180) / Math.PI;
      let off = Math.abs(normalizeDegrees(bearing) - normalizeDegrees(lastBearingDeg));
      if (off > 180) off = 360 - off;
      if (off <= coneHalfDeg && distance < bestInConeDistance) { bestInCone = mob; bestInConeDistance = distance; }
    }
  }
  const pick = bestInCone ?? best;
  const toward = pick ? swingDirectionToward(origin, pick) : null;
  if (toward) return toward;
  return lastBearingDeg === null ? null : dashDirectionForBearing(lastBearingDeg);
}

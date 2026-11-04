import { destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";

import { hasFreshServerWall, isShoreSliding } from "./shoreSlide.js";

/**
 * Joystick movement tuning. Everything the owner may want to feel-adjust lives here.
 */
/** Stick deflection (0..1 of the radius) below which nothing is sent. ~7 px: a thumb landing a little off does not walk yet. */
export const JOYSTICK_DEAD_ZONE = 0.15;
/** How often the joystick considers sending a MOVE_TO while deflected. */
export const JOYSTICK_SEND_INTERVAL_MS = 90;
/** The target sits this many seconds of travel ahead of the predicted position. */
export const JOYSTICK_LOOKAHEAD_S = 0.7;
/** Resend when less than this many seconds of travel remain to the last target. */
export const JOYSTICK_RESEND_REMAINING_S = 0.35;
/** Resend immediately when the stick direction changed by more than this (small, so a circling thumb is followed closely). */
export const JOYSTICK_RESEND_BEARING_DEG = 5;
/** Never aim closer than this, so slow speeds still produce a real walk target. */
export const JOYSTICK_MIN_LOOKAHEAD_M = 2;
/** Stay this fraction inside the movement leash so rounding never trips the server throw. */
export const JOYSTICK_LEASH_MARGIN = 0.98;

export type JoystickLeash = Readonly<{
  anchorLat: number;
  anchorLon: number;
  moveLeashRadiusM: number;
}>;

export type JoystickTargetInput = Readonly<{
  /** Stick offset from its centre in screen pixels (x right, y down). */
  dxPx: number;
  dyPx: number;
  /** Stick travel radius in pixels. */
  radiusPx: number;
  /** Map bearing in degrees: the compass heading pointing to the top of the screen. */
  mapBearingDeg: number;
  position: LatLon;
  speedMps: number;
  leash: JoystickLeash | null;
}>;

export type JoystickTarget = Readonly<{ target: LatLon; bearingDeg: number; distanceM: number }>;

export function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function bearingDeltaDegrees(a: number, b: number): number {
  const delta = Math.abs(normalizeDegrees(a) - normalizeDegrees(b));
  return delta > 180 ? 360 - delta : delta;
}

/** Compass bearing for a screen-space stick offset, honouring map rotation. Null in the dead zone. */
export function joystickBearingDeg(
  dxPx: number,
  dyPx: number,
  radiusPx: number,
  mapBearingDeg: number
): number | null {
  if (!(radiusPx > 0)) return null;
  const deflection = Math.hypot(dxPx, dyPx) / radiusPx;
  if (!Number.isFinite(deflection) || deflection < JOYSTICK_DEAD_ZONE) return null;
  const fromScreenUpDeg = (Math.atan2(dxPx, -dyPx) * 180) / Math.PI;
  return normalizeDegrees(mapBearingDeg + fromScreenUpDeg);
}

/** Target point ahead of the predicted position, clamped inside the movement leash. */
export function computeJoystickTarget(input: JoystickTargetInput): JoystickTarget | null {
  const bearingDeg = joystickBearingDeg(input.dxPx, input.dyPx, input.radiusPx, input.mapBearingDeg);
  if (bearingDeg === null || !(input.speedMps > 0)) return null;
  let distanceM = Math.max(JOYSTICK_MIN_LOOKAHEAD_M, input.speedMps * JOYSTICK_LOOKAHEAD_S);
  const { leash, position } = input;
  if (leash) {
    const limitM = leash.moveLeashRadiusM * JOYSTICK_LEASH_MARGIN;
    const anchor = { lat: leash.anchorLat, lon: leash.anchorLon };
    const within = (meters: number): boolean =>
      distanceMeters(anchor, destinationPoint(position, meters, bearingDeg)) <= limitM;
    if (!within(distanceM)) {
      let low = 0;
      let high = distanceM;
      for (let i = 0; i < 14; i += 1) {
        const mid = (low + high) / 2;
        if (within(mid)) low = mid; else high = mid;
      }
      distanceM = low;
      if (distanceM < 0.5) return null;
    }
  }
  return { target: destinationPoint(position, distanceM, bearingDeg), bearingDeg, distanceM };
}

export type JoystickSendState = Readonly<{ target: LatLon; bearingDeg: number }>;

/** Whether a fresh MOVE_TO is warranted: first send, turned stick, or last target nearly reached. */
export function shouldSendJoystickMove(
  last: JoystickSendState | null,
  next: JoystickTarget,
  position: LatLon,
  speedMps: number
): boolean {
  if (!last) return true;
  // Sliding along a shore: the server leg is short and the raw target lies in the water, so keep resending.
  const nowMs = performance.now();
  if (isShoreSliding(nowMs) || hasFreshServerWall(nowMs)) return true;
  if (bearingDeltaDegrees(last.bearingDeg, next.bearingDeg) > JOYSTICK_RESEND_BEARING_DEG) return true;
  return distanceMeters(position, last.target) < speedMps * JOYSTICK_RESEND_REMAINING_S;
}

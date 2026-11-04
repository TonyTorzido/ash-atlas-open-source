import { clipWalkTargetToShore, distanceMeters, type LatLon, type WaterShoreHint } from "@ash-atlas/shared";

/**
 * Client side of walking next to water (docs/plans/water-shore.md). The server stops an unrafted walker at
 * the shore and slides the leg along it, and sends the local shore wall with every MOVE_ACCEPTED while the
 * player is near water. This module remembers that wall so the next walk targets are slid along it before
 * they are sent: the predicted player never enters the water and the server's answer matches, so nothing
 * snaps back. The server stays the authority; a missing or expired wall just means no client prediction.
 */
/** A wall older than this is ignored (the next MOVE_ACCEPTED normally refreshes it every ~100 ms). */
export const SHORE_HINT_TTL_MS = 2_000;
/** A wall is only trusted this close to the spot where the server measured it. */
export const SHORE_HINT_MAX_DISTANCE_M = 40;
/** Slides shorter than this are a stop. */
export const SHORE_MIN_SLIDE_M = 0.3;
/** After sending a real slide, the joystick resends on its next frame instead of waiting for its own target. */
const SLIDE_RESEND_WINDOW_MS = 400;
/** A target this close to the player is a stop command and is never altered. */
const STOP_EPSILON_M = 0.05;

let memory: { hint: WaterShoreHint; receivedAtMs: number } | null = null;
let slidingUntilMs = Number.NEGATIVE_INFINITY;
let serverWallUntilMs = Number.NEGATIVE_INFINITY;

/** MOVE_ACCEPTED: remember the server's wall, or forget it when the server reports none. */
export function recordShoreHint(hint: WaterShoreHint | undefined, nowMs: number): void {
  memory = hint ? { hint, receivedAtMs: nowMs } : null;
  // The server may have cut or slid that leg (a slide never runs past its 24 m probe), so keep resending.
  serverWallUntilMs = hint ? nowMs + SLIDE_RESEND_WINDOW_MS : Number.NEGATIVE_INFINITY;
  if (!hint) slidingUntilMs = Number.NEGATIVE_INFINITY;
}

export function resetShoreSlide(): void {
  memory = null;
  slidingUntilMs = Number.NEGATIVE_INFINITY;
  serverWallUntilMs = Number.NEGATIVE_INFINITY;
}

/** Slides a walk target along the remembered shore wall (a stop when it would only push into the water). */
export function slideWalkTarget(position: LatLon, target: LatLon, nowMs: number): LatLon {
  if (!memory) return target;
  if (
    nowMs - memory.receivedAtMs > SHORE_HINT_TTL_MS ||
    distanceMeters(position, memory.hint.at) > SHORE_HINT_MAX_DISTANCE_M
  ) {
    memory = null;
    return target;
  }
  if (distanceMeters(position, target) <= STOP_EPSILON_M) return target;
  const clip = clipWalkTargetToShore(target, memory.hint);
  if (!clip.clipped) return target;
  if (distanceMeters(position, clip.target) < SHORE_MIN_SLIDE_M) return position;
  slidingUntilMs = nowMs + SLIDE_RESEND_WINDOW_MS;
  return clip.target;
}

/** True right after a slide was sent: the stick should resend at its normal cadence to keep following the shore. */
export function isShoreSliding(nowMs: number): boolean {
  return nowMs < slidingUntilMs;
}

/**
 * True right after the server reported a shore wall: the stick resends at its normal cadence, because the
 * server's leg may be shorter than the stick target (a cut at the shore, or a slide capped at the probe radius).
 */
export function hasFreshServerWall(nowMs: number): boolean {
  return nowMs < serverWallUntilMs;
}

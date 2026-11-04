import { DEFAULT_PLAYER_SPEED_MPS } from "@ash-atlas/shared";

/** Tunables for deciding when a rendered player counts as walking. */
export const PLAYER_WALK_MOTION = {
  /** Below this speed (fraction of the normal walk speed) motion is a correction, not a step. */
  minSpeedFraction: 0.2,
  /** Above this (fraction) the move is a teleport/relocation, not walking. */
  maxSpeedFraction: 12,
  /** Keep walking this long after the last real movement so corrections never stutter. */
  holdMs: 160,
  /** Frame gaps longer than this are not trusted for a speed estimate. */
  maxSampleGapMs: 250
} as const;

const METERS_PER_DEGREE = 111_320;

export type PlayerWalkMotionState = {
  lat: number;
  lon: number;
  sampledAtMs: number;
  lastMovingAtMs: number;
  moving: boolean;
};

export function createPlayerWalkMotionState(): PlayerWalkMotionState {
  return { lat: 0, lon: 0, sampledAtMs: -1, lastMovingAtMs: -1e9, moving: false };
}

/**
 * Feeds the interpolated render position of one frame and returns whether the
 * player is walking. Mutates the state; allocates nothing.
 */
export function observePlayerWalkMotion(
  state: PlayerWalkMotionState,
  lat: number,
  lon: number,
  nowMs: number
): boolean {
  const dtMs = nowMs - state.sampledAtMs;
  let speed = 0;
  if (state.sampledAtMs >= 0 && dtMs > 0) {
    const dy = (lat - state.lat) * METERS_PER_DEGREE;
    const dx = (lon - state.lon) * METERS_PER_DEGREE * Math.cos(lat * Math.PI / 180);
    speed = Math.sqrt(dx * dx + dy * dy) * 1000 / dtMs;
  }
  return commitWalkSample(state, lat, lon, speed, DEFAULT_PLAYER_SPEED_MPS, nowMs);
}

/**
 * Same detection for planar room coordinates (interiors, dungeons).
 * walkUnitsPerSecond is the normal walking speed in those units.
 */
export function observePlanarWalkMotion(
  state: PlayerWalkMotionState,
  x: number,
  y: number,
  walkUnitsPerSecond: number,
  nowMs: number
): boolean {
  const dtMs = nowMs - state.sampledAtMs;
  let speed = 0;
  if (state.sampledAtMs >= 0 && dtMs > 0) {
    speed = Math.hypot(x - state.lat, y - state.lon) * 1000 / dtMs;
  }
  return commitWalkSample(state, x, y, speed, walkUnitsPerSecond, nowMs);
}

function commitWalkSample(
  state: PlayerWalkMotionState,
  a: number,
  b: number,
  speed: number,
  walkSpeed: number,
  nowMs: number
): boolean {
  const dtMs = nowMs - state.sampledAtMs;
  if (state.sampledAtMs >= 0 && dtMs === 0) return state.moving;
  if (
    state.sampledAtMs >= 0 &&
    dtMs <= PLAYER_WALK_MOTION.maxSampleGapMs &&
    speed >= PLAYER_WALK_MOTION.minSpeedFraction * walkSpeed &&
    speed <= PLAYER_WALK_MOTION.maxSpeedFraction * walkSpeed
  ) {
    state.lastMovingAtMs = nowMs;
  }
  state.lat = a;
  state.lon = b;
  state.sampledAtMs = nowMs;
  state.moving = nowMs - state.lastMovingAtMs <= PLAYER_WALK_MOTION.holdMs;
  return state.moving;
}

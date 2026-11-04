import { destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";

/**
 * Loose, pet-like roaming around the owner. A companion picks a destination somewhere in a loose
 * area around/behind its owner every so often, walks there, pauses (sniffs) a while, and repeats.
 * It never tracks the owner step by step: when the owner moves far it heads back toward them.
 * Movement is always one constant speed (the owner's walking speed): no jogging, no teleports.
 */
export type RoamProfile = Readonly<{
  /** Destinations land this far from the owner. */
  roamMinM: number;
  roamMaxM: number;
  /** Beyond this the companion drifts back into its roam area at a walk. */
  driftAtM: number;
  /** Beyond this it re-aims at a nearer point (still at the same speed). */
  jogAtM: number;
  /** Pause at each destination. */
  pauseMinMs: number;
  pauseMaxMs: number;
  /** Destinations favour the area behind the owner's facing within this spread (degrees). */
  behindSpreadDeg: number;
  /**
   * When the owner is within this distance the companion stays put (no new roam spot, a walk in
   * progress stops) until its normal pause runs out: it never runs off because the owner came near.
   */
  settleNearOwnerM: number;
}>;

/** Whistle pets: usually 60–150 m off, roaming like a dog in a field. */
export const PET_ROAM: RoamProfile = {
  roamMinM: 60, roamMaxM: 150, driftAtM: 170, jogAtM: 215,
  pauseMinMs: 6_000, pauseMaxMs: 16_000, behindSpreadDeg: 160, settleNearOwnerM: 60
};
/** Minions stay closer so they are useful inside dungeon rooms. */
export const MINION_ROAM: RoamProfile = {
  roamMinM: 30, roamMaxM: 80, driftAtM: 95, jogAtM: 150,
  pauseMinMs: 3_000, pauseMaxMs: 9_000, behindSpreadDeg: 200, settleNearOwnerM: 0
};

const ARRIVED_M = 1;
/** A heading-back waypoint is kept at least this long before it may be re-picked. */
const WAYPOINT_COMMIT_MS = 4_000;
/** Turning is gradual: at most this many degrees per second (direct within the last few metres). */
const MAX_TURN_DEG_PER_S = 200;
const DIRECT_FINISH_M = 6;

export type RoamState = {
  goal: LatLon | null;
  /** "roam": a relaxed wander spot; "return": heading back toward the owner. */
  kind: "roam" | "return";
  goalSetAtMs: number;
  /** Current travel heading, turned gradually toward the goal. */
  heading: number | null;
  pauseUntilMs: number;
  seed: number;
  /** Fixed bearing offset so several companions of one owner spread out. */
  offsetDeg: number;
};

export function createRoamState(key: string, nowMs: number, offsetDeg = 0): RoamState {
  let seed = 2166136261;
  for (const char of key) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  return { goal: null, kind: "roam", goalSetAtMs: 0, heading: null, pauseUntilMs: nowMs, seed: seed || 1, offsetDeg };
}

function next(state: RoamState): number {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x1_0000_0000;
}

/** A destination in the roam area, biased behind the owner's facing (any side when unknown). */
export function roamPoint(state: RoamState, profile: RoamProfile, owner: LatLon, ownerHeading: number | null, scale = 1): LatLon {
  const behind = ownerHeading === null ? next(state) * 360 : (ownerHeading + 180) % 360;
  const spread = ownerHeading === null ? 0 : profile.behindSpreadDeg;
  const angle = behind + state.offsetDeg + (next(state) - 0.5) * spread;
  const distance = (profile.roamMinM + next(state) * (profile.roamMaxM - profile.roamMinM)) * scale;
  return destinationPoint(owner, distance, ((angle % 360) + 360) % 360);
}

/** One roam tick: the companion's next position, or null to stay where it is. */
export function roamStep(
  state: RoamState,
  profile: RoamProfile,
  input: Readonly<{
    position: LatLon;
    owner: LatLon;
    ownerHeading: number | null;
    baseSpeedMps: number;
    elapsedS: number;
    nowMs: number;
  }>
): LatLon | null {
  const fromOwner = distanceMeters(input.position, input.owner);
  // Heading back: commit to a waypoint for a few seconds (or until reached) and only re-pick
  // once the owner has moved well away from it, so the path is a few long legs, not a zigzag.
  const committed = state.goal !== null && input.nowMs - state.goalSetAtMs < WAYPOINT_COMMIT_MS;
  const goalStale = state.goal !== null && distanceMeters(state.goal, input.owner) > profile.roamMaxM;
  if (fromOwner > profile.jogAtM) {
    if (!state.goal || (!committed && goalStale)) setGoal(state, roamPoint(state, profile, input.owner, input.ownerHeading, 0.6), "return", input.nowMs);
  } else if (fromOwner > profile.driftAtM) {
    if (!state.goal || (!committed && state.kind === "roam" && goalStale)) {
      setGoal(state, roamPoint(state, profile, input.owner, input.ownerHeading, 0.8), "return", input.nowMs);
    }
  } else if (fromOwner < profile.settleNearOwnerM) {
    // The owner came close: settle in place; roaming resumes on the normal pause timer.
    if (state.goal && state.kind === "roam") {
      state.goal = null;
      state.pauseUntilMs = Math.max(state.pauseUntilMs, input.nowMs + profile.pauseMinMs);
    }
    if (input.nowMs >= state.pauseUntilMs) {
      state.pauseUntilMs = input.nowMs + profile.pauseMinMs + next(state) * (profile.pauseMaxMs - profile.pauseMinMs);
    }
    if (state.kind === "roam") return null;
  } else if (!state.goal && input.nowMs >= state.pauseUntilMs) {
    setGoal(state, roamPoint(state, profile, input.owner, input.ownerHeading), "roam", input.nowMs);
  }
  if (!state.goal) {
    state.heading = null;
    return null;
  }
  let remaining = distanceMeters(input.position, state.goal);
  if (remaining <= ARRIVED_M) {
    const wasReturning = state.kind === "return";
    state.goal = null;
    if (wasReturning && fromOwner > profile.driftAtM) {
      // Still far: carry straight on to the next waypoint with no stop.
      setGoal(state, roamPoint(state, profile, input.owner, input.ownerHeading, 0.8), "return", input.nowMs);
      remaining = distanceMeters(input.position, state.goal!);
    } else {
      state.heading = null;
      state.pauseUntilMs = input.nowMs + profile.pauseMinMs + next(state) * (profile.pauseMaxMs - profile.pauseMinMs);
      return null;
    }
  }
  const step = Math.min(remaining, input.baseSpeedMps * input.elapsedS);
  const desired = bearing(input.position, state.goal!);
  if (state.heading === null || remaining <= DIRECT_FINISH_M) {
    state.heading = desired;
  } else {
    const delta = ((desired - state.heading + 540) % 360) - 180;
    const maxTurn = MAX_TURN_DEG_PER_S * input.elapsedS;
    state.heading = (state.heading + Math.max(-maxTurn, Math.min(maxTurn, delta)) + 360) % 360;
  }
  return destinationPoint(input.position, step, state.heading);
}

function setGoal(state: RoamState, goal: LatLon, kind: RoamState["kind"], nowMs: number): void {
  state.goal = goal;
  state.kind = kind;
  state.goalSetAtMs = nowMs;
}

export function bearing(from: LatLon, to: LatLon): number {
  const p1 = from.lat * Math.PI / 180;
  const p2 = to.lat * Math.PI / 180;
  const dl = (to.lon - from.lon) * Math.PI / 180;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}

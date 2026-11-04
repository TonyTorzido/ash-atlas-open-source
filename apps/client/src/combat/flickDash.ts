/**
 * Flick to dash: pure timing logic for the movement stick. A flick is a touch that gets quickly to the stick rim
 * and lets go just as quickly. Anything slower, held longer or shorter than the rim threshold is plain walking.
 * All times are milliseconds since touch-down.
 */

/** Tunable flick constants, in one place. */
export const FLICK_DASH = {
  /** The stick vector must reach this fraction of the stick radius (for the floating stick, from the planted centre)... */
  minRadiusFraction: 0.525, // was 0.7 (x0.75)
  /** ...within this long of touch-down... */
  reachWithinMs: 105, // was 140 (x0.75, like the pull): the rim is reached at 5.0 radii/s, the original speed
  /** ...and the finger must lift within this long of touch-down. Tight, so a quick step or nudge (held ~200 ms+) never dashes. */
  releaseWithinMs: 135, // was 180 (x0.75)
  /** The finger must also have travelled this fraction of the radius from where it landed (a fixed-stick tap on the rim is not a flick). */
  minTravelFraction: 0.375 // was 0.5 (x0.75)
} as const;

export type FlickState = Readonly<{
  /** Elapsed ms when the rim threshold was first reached inside the window, else null. */
  reachedAtMs: number | null;
  /** Longest stick vector seen inside the reach window (screen px, x right, y down); the flick direction. */
  peak: Readonly<{ dx: number; dy: number }> | null;
}>;

export const FLICK_IDLE: FlickState = { reachedAtMs: null, peak: null };

export type FlickSample = Readonly<{
  /** Ms since touch-down. */
  elapsedMs: number;
  /** Stick vector (finger relative to the stick origin), already clamped to the radius. */
  dx: number;
  dy: number;
  /** Finger distance from where the touch landed. */
  travelPx: number;
  radiusPx: number;
}>;

/** Folds one pointer sample into the flick state. Samples after the reach window change nothing. */
export function flickStep(state: FlickState, sample: FlickSample, c = FLICK_DASH): FlickState {
  if (sample.elapsedMs > c.reachWithinMs || !(sample.radiusPx > 0)) return state;
  const length = Math.hypot(sample.dx, sample.dy);
  if (length < c.minRadiusFraction * sample.radiusPx || sample.travelPx < c.minTravelFraction * sample.radiusPx) {
    return state;
  }
  const best = state.peak ? Math.hypot(state.peak.dx, state.peak.dy) : -1;
  return {
    reachedAtMs: state.reachedAtMs ?? sample.elapsedMs,
    peak: length > best ? { dx: sample.dx, dy: sample.dy } : state.peak
  };
}

export type FlickOutcome = Readonly<{ dash: false }> | Readonly<{ dash: true; dx: number; dy: number }>;

/** Decides at release. A flick on dash cooldown does nothing extra (no queued dash). */
export function flickResolve(state: FlickState, releaseElapsedMs: number, dashReady: boolean, c = FLICK_DASH): FlickOutcome {
  if (!dashReady || !state.peak || state.reachedAtMs === null) return { dash: false };
  if (state.reachedAtMs > c.reachWithinMs || releaseElapsedMs > c.releaseWithinMs) return { dash: false };
  return { dash: true, dx: state.peak.dx, dy: state.peak.dy };
}

/**
 * Mid-hold flick: a fast thumb movement while the stick is already held and the player is walking. It dashes in the
 * direction the thumb ends up pointing. It is measured on the finger's own path (screen px), over a short window, so
 * normal steering (circles, zig-zags, 90 degree turns, corrections) is far below it in speed.
 */
export const WALK_FLICK = {
  /** The flick must happen inside this window (ms): the finger moves at least `minTravelFraction` of the radius in it (about 860 px/s on a 46 px stick). */
  windowMs: 50, // was 70 (x0.75, rounded down: 52 let a 300 ms arc reversal through)
  /** Finger travel inside the window, as a fraction of the stick radius: 0.975 radii in 50 ms = 19.5 radii/s, the original 1.3 in 70 ms = 18.6. */
  minTravelFraction: 0.975, // was 1.3 (x0.75)
  /** The stick must have been held beyond the dead zone this long (ms) before the flick starts: "walking". This also hands the first moments of a touch to the fresh-touch flick. */
  walkingForMs: 150,
  /** Stick deflection (fraction of the radius) that counts as walking. */
  walkingMinFraction: 0.15,
  /** At the end of the flick the stick must point somewhere real (a quick return to centre is a stop, not a flick). */
  endMinFraction: 0.4,
  /** A sharp change: the end direction differs from the walking direction by at least this many degrees. */
  turnMinDeg: 60,
  /** A push outward: it starts at or under this stick deflection (fraction) and ends past `pushEndFraction`, straight outward along the line it started on... */
  pushStartMaxFraction: 0.55,
  pushEndFraction: 0.8,
  pushAlignMaxDeg: 40,
  /** With every movement reported, a gap of `quietGapMs` to `quietMaxGapMs` between events means the thumb was resting; it moved again within `quietSettleMs` of the new event. Longer gaps are read cautiously (a stall, or an input that jumps). */
  quietGapMs: 30,
  quietMaxGapMs: 200,
  quietSettleMs: 8,
  /** ...and covers this much finger travel (fraction of the radius) inside this window (ms). */
  pushMinTravelFraction: 0.675, // was 0.9 (x0.75)
  pushWindowMs: 50 // was 70: 13.5 radii/s, the original 0.9 in 70 ms = 12.9
} as const;

type WalkSample = Readonly<{
  t: number;
  fx: number;
  fy: number;
  dx: number;
  dy: number;
  /** When the stick last left the dead zone (continuously beyond it since), as known at this sample; null inside the dead zone. */
  since: number | null;
}>;

export type WalkFlickState = Readonly<{
  /** Recent samples, oldest first (only the last `windowMs`). */
  samples: readonly WalkSample[];
  /** Ms (touch clock) since which the stick has been continuously beyond the dead zone, else null. */
  walkingSince: number | null;
}>;

export const WALK_FLICK_IDLE: WalkFlickState = { samples: [], walkingSince: null };

export type WalkFlickInput = Readonly<{
  /** Ms on any steady clock (touch-down is not needed). */
  t: number;
  /** Finger position on screen. */
  fx: number;
  fy: number;
  /** Stick vector (finger relative to the stick origin), already clamped to the radius. */
  dx: number;
  dy: number;
  radiusPx: number;
  /**
   * True when every finger movement is reported (the browser hands over its coalesced events), so a quiet stretch means a
   * thumb held perfectly still: the flick is then measured against that rest, not spread over the quiet. False keeps the
   * safe reading (the finger may have moved unseen during a stall), which a perfectly still thumb makes a bit less sensitive.
   */
  quietMeansStill?: boolean;
}>;

export type WalkFlickResult = Readonly<{ state: WalkFlickState; flick: Readonly<{ dx: number; dy: number }> | null }>;

function angleBetweenDeg(ax: number, ay: number, bx: number, by: number): number {
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (!(la > 0) || !(lb > 0)) return 0;
  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Step (ms) between look-back points inside the window. */
const LOOKBACK_STEP_MS = 10;
/** The look-back points: every step inside the window, and the window's own length (so a short window is measured to its end). */
function lookbacks(windowMs: number): number[] {
  const out: number[] = [];
  for (let back = LOOKBACK_STEP_MS; back < windowMs; back += LOOKBACK_STEP_MS) out.push(back);
  out.push(windowMs);
  return out;
}

/**
 * The finger and stick state at time `t`, interpolated between the two samples around it, and whether the stick had
 * been walking (beyond the dead zone) for `walkingForMs` by then: it was walking at the earlier sample, or the later
 * sample says the walk began long enough ago (a held thumb sends no events, so a quiet gap is a walk, not a pause).
 */
function sampleAt(samples: readonly WalkSample[], t: number, walkingForMs: number): (WalkSample & { walking: boolean }) | null {
  for (let i = samples.length - 1; i > 0; i -= 1) {
    const b = samples[i]!;
    const a = samples[i - 1]!;
    if (a.t <= t && t <= b.t) {
      const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return {
        t,
        fx: a.fx + (b.fx - a.fx) * k,
        fy: a.fy + (b.fy - a.fy) * k,
        dx: a.dx + (b.dx - a.dx) * k,
        dy: a.dy + (b.dy - a.dy) * k,
        since: b.since,
        walking: (a.since !== null && a.since <= a.t - walkingForMs) || (b.since !== null && b.since <= t - walkingForMs)
      };
    }
  }
  return null;
}

/**
 * Folds one pointer sample into the walk-flick state. `flick` is set when this sample completes a flick; the state is
 * then re-armed, so the next flick needs the thumb to walk for `walkingForMs` again. Look-back points are interpolated, so
 * sparse pointer events (30 Hz) are measured as fairly as dense ones, and a jump between samples further apart than the
 * window is just slow movement (not a flick).
 */
export function walkFlickStep(state: WalkFlickState, input: WalkFlickInput, c = WALK_FLICK): WalkFlickResult {
  if (!(input.radiusPx > 0)) return { state, flick: null };
  const deflection = Math.hypot(input.dx, input.dy) / input.radiusPx;
  const beyondDeadZone = deflection >= c.walkingMinFraction;
  const walkingSince = beyondDeadZone ? (state.walkingSince ?? input.t) : null;
  const current: WalkSample = { t: input.t, fx: input.fx, fy: input.fy, dx: input.dx, dy: input.dy, since: walkingSince };
  // Keep one sample older than the window as the anchor to interpolate from.
  const kept = state.samples.filter((s) => input.t - s.t <= c.windowMs);
  const anchor = state.samples.filter((s) => input.t - s.t > c.windowMs).at(-1);
  const previous = state.samples.at(-1);
  // A reported-in-full quiet stretch is a still finger: it rested at its last position until just before this sample.
  const rest: WalkSample[] = input.quietMeansStill && previous && input.t - previous.t > c.quietGapMs && input.t - previous.t <= c.quietMaxGapMs
    ? [{ ...previous, t: input.t - c.quietSettleMs }]
    : [];
  const samples = [...(anchor ? [anchor] : []), ...kept, ...rest, current];
  const next: WalkFlickState = { samples, walkingSince };

  const endLen = Math.hypot(input.dx, input.dy);
  if (endLen < c.endMinFraction * input.radiusPx) return { state: next, flick: null };
  for (const back of lookbacks(c.windowMs)) {
    const from = sampleAt(samples, input.t - back, c.walkingForMs);
    if (!from || !from.walking) continue;
    const travel = Math.hypot(input.fx - from.fx, input.fy - from.fy);
    const startLen = Math.hypot(from.dx, from.dy);
    const turned = travel >= c.minTravelFraction * input.radiusPx
      && angleBetweenDeg(from.dx, from.dy, input.dx, input.dy) >= c.turnMinDeg;
    const pushed = back <= c.pushWindowMs
      && travel >= c.pushMinTravelFraction * input.radiusPx
      && startLen <= c.pushStartMaxFraction * input.radiusPx
      && endLen >= c.pushEndFraction * input.radiusPx
      && angleBetweenDeg(input.fx - from.fx, input.fy - from.fy, input.dx, input.dy) <= c.pushAlignMaxDeg
      && angleBetweenDeg(input.fx - from.fx, input.fy - from.fy, from.dx, from.dy) <= c.pushAlignMaxDeg;
    if (turned || pushed) {
      // Keep only this sample, as a new walk start: the thumb is still out, so the next flick needs another `walkingForMs` of walking.
      const rearm: WalkSample = { ...current, since: input.t };
      return { state: { samples: [rearm], walkingSince: input.t }, flick: { dx: input.dx, dy: input.dy } };
    }
  }
  return { state: next, flick: null };
}

import { stickVector, trailOrigin, type Point } from "./floatingStick.js";
import { WALK_FLICK_IDLE, walkFlickStep, type WalkFlickState } from "./flickDash.js";

/**
 * Scripted thumb paths for measuring the mid-hold flick detector (floating stick geometry: the origin is where the
 * thumb landed and trails a finger past the rim). Used by the unit tests; no DOM.
 */
export const SIM_RADIUS = 46;

export type Path = (tMs: number) => Point;
export type SimResult = Readonly<{ flicks: number; firstAtMs: number | null }>;

/** Minimum-jerk easing: how a real thumb accelerates and brakes. */
export function minJerk(tau: number): number {
  const x = Math.max(0, Math.min(1, tau));
  return 10 * x ** 3 - 15 * x ** 4 + 6 * x ** 5;
}

/** Deterministic pseudo-random noise (mulberry32), so runs are repeatable. */
export function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Piecewise path through timed waypoints with minimum-jerk easing between them. */
export function waypoints(points: ReadonlyArray<Readonly<{ at: number; p: Point }>>): Path {
  return (t) => {
    if (t <= points[0]!.at) return points[0]!.p;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (t <= b.at) {
        const s = minJerk((t - a.at) / Math.max(1, b.at - a.at));
        return { x: a.p.x + (b.p.x - a.p.x) * s, y: a.p.y + (b.p.y - a.p.y) * s };
      }
    }
    return points[points.length - 1]!.p;
  };
}

/**
 * Plays a path through the detector from touch-down at the origin (0,0). Samples arrive every `periodMs` with up to
 * `timingJitterMs` of timing jitter and `posJitterPx` of finger noise.
 */
export function simulate(path: Path, durationMs: number, opts: { periodMs?: number; timingJitterMs?: number; posJitterPx?: number; seed?: number } = {}): SimResult {
  const period = opts.periodMs ?? 16;
  const rand = noise(opts.seed ?? 1);
  let origin: Point = { x: 0, y: 0 };
  let state: WalkFlickState = WALK_FLICK_IDLE;
  let flicks = 0;
  let firstAtMs: number | null = null;
  let t = 0;
  while (t <= durationMs) {
    const p = path(t);
    const finger = { x: p.x + (rand() - 0.5) * 2 * (opts.posJitterPx ?? 0), y: p.y + (rand() - 0.5) * 2 * (opts.posJitterPx ?? 0) };
    origin = trailOrigin(origin, finger, SIM_RADIUS);
    const v = stickVector(origin, finger, SIM_RADIUS);
    const out = walkFlickStep(state, { t, fx: finger.x, fy: finger.y, dx: v.dx, dy: v.dy, radiusPx: SIM_RADIUS });
    state = out.state;
    if (out.flick) { flicks += 1; firstAtMs ??= t; }
    t += period + (rand() - 0.5) * 2 * (opts.timingJitterMs ?? 0);
  }
  return { flicks, firstAtMs };
}

const R = SIM_RADIUS;
const at = (angleDeg: number, r = R): Point => ({ x: Math.sin((angleDeg * Math.PI) / 180) * r, y: -Math.cos((angleDeg * Math.PI) / 180) * r });
export { at as polar };

/** Thumb lands, goes to the rim at `angle` within 120 ms, then does `then` starting at `startMs`. */
export function walkThen(angle: number, then: (startMs: number) => Path | null, startMs = 600): Path {
  const approach = waypoints([{ at: 0, p: { x: 0, y: 0 } }, { at: 120, p: at(angle) }]);
  return (t) => (t < startMs ? approach(t) : then(startMs)?.(t) ?? at(angle));
}

/** Steady hold with a little wobble (handled by posJitterPx). */
export const steady = (angle: number): Path => walkThen(angle, () => null);

/** Continuous circle of radius r*R around the origin, `periodMs` per lap, starting at `angle`. */
export function circle(angle: number, periodMs: number, rFrac = 1, clockwise = true): Path {
  return walkThen(angle, (s) => (t) => at(angle + (clockwise ? 1 : -1) * ((t - s) / periodMs) * 360, R * rFrac), 600);
}

/** Zig-zag: heading alternates between angle-swing and angle+swing every `legMs`, finger straight between (chord). */
export function zigzag(angle: number, swingDeg: number, legMs: number, legs: number): Path {
  const pts = [{ at: 0, p: { x: 0, y: 0 } }, { at: 120, p: at(angle - swingDeg) }, { at: 600, p: at(angle - swingDeg) }];
  for (let i = 1; i <= legs; i += 1) pts.push({ at: 600 + i * legMs, p: at(angle + (i % 2 ? swingDeg : -swingDeg)) });
  return waypoints(pts);
}

/** One turn from `angle` by `turnDeg` taking `turnMs`. `via` = "arc" (along the rim) or "chord" (straight across). */
export function turn(angle: number, turnDeg: number, turnMs: number, via: "arc" | "chord" = "arc"): Path {
  const approach = waypoints([{ at: 0, p: { x: 0, y: 0 } }, { at: 120, p: at(angle) }]);
  const chord = waypoints([{ at: 600, p: at(angle) }, { at: 600 + turnMs, p: at(angle + turnDeg) }]);
  return (t) => {
    if (t < 600) return approach(t);
    if (via === "chord") return chord(t);
    const s = minJerk((t - 600) / turnMs);
    return at(angle + turnDeg * s);
  };
}

/** Walk then jump the finger straight to `to` in `ms` (a flick when quick), then hold. */
export function jump(angle: number, to: Point, ms: number): Path {
  return waypoints([{ at: 0, p: { x: 0, y: 0 } }, { at: 120, p: at(angle) }, { at: 600, p: at(angle) }, { at: 600 + ms, p: to }]);
}

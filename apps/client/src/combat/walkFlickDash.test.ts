import { describe, expect, it } from "vitest";

import { WALK_FLICK, WALK_FLICK_IDLE, walkFlickStep } from "./flickDash.js";
import { stickVector, trailOrigin } from "./floatingStick.js";
import * as S from "./walkFlickSim.js";

const R = S.SIM_RADIUS;
const P = S.polar;
const ANGLES = [0, 90, 180, 270, 37, 143, 215];
/** Pointer event spacing: 120 Hz, 60 Hz, a loaded 40 Hz, and a sparse 30 Hz. */
const PERIODS = [8, 16, 25, 33];
const SEEDS = [1, 2, 3, 4];
const base = (seed: number, periodMs: number) => ({ posJitterPx: 1.2, timingJitterMs: 4, seed, periodMs });

type Tally = { tried: number; fired: number };
const tally = (): Tally => ({ tried: 0, fired: 0 });

describe("mid-hold flick: false triggers (must be zero)", () => {
  const falsePaths: Array<[string, (a: number) => S.Path, number]> = [];
  for (const per of [4000, 2000, 1200, 800, 600, 500]) {
    for (const rf of [0.6, 1]) for (const cw of [true, false]) falsePaths.push([`circle ${per} ms/lap r${rf} ${cw ? "cw" : "ccw"}`, (a) => S.circle(a, per, rf, cw), 4000]);
  }
  for (const leg of [200, 250, 300, 400, 600]) for (const sw of [30, 45, 60]) falsePaths.push([`zig-zag ${leg} ms legs, +-${sw} deg`, (a) => S.zigzag(a, sw, leg, 6), 600 + 6 * leg + 300]);
  for (const ms of [150, 200, 250, 300, 400, 600]) for (const d of [90, -90]) for (const via of ["arc", "chord"] as const) falsePaths.push([`90 deg turn ${ms} ms ${via}`, (a) => S.turn(a, d, ms, via), 1500]);
  for (const ms of [300, 400, 600]) for (const via of ["arc", "chord"] as const) falsePaths.push([`180 deg reversal ${ms} ms ${via}`, (a) => S.turn(a, 180, ms, via), 1500]);
  for (const ms of [40, 60, 80, 100, 150]) for (const d of [8, 14, 20]) falsePaths.push([`correction ${d}px in ${ms} ms`, (a) => S.jump(a, { x: P(a).x + d, y: P(a).y + d * 0.6 }, ms), 1400]);
  // A light walk that opens up to the rim at a natural pace (not a push).
  for (const ms of [90, 100, 150, 250, 400]) falsePaths.push([`light walk opens to the rim in ${ms} ms`, (a) => S.waypoints([{ at: 0, p: { x: 0, y: 0 } }, { at: 120, p: P(a, R * 0.3) }, { at: 600, p: P(a, R * 0.3) }, { at: 600 + ms, p: P(a, R) }]), 1400]);
  falsePaths.push(["steady walk", (a) => S.steady(a), 3000]);

  it("never fires on steady walks, circles, zig-zags, turns and small corrections", () => {
    let tried = 0;
    const fired: string[] = [];
    for (const [name, make, dur] of falsePaths) {
      for (const a of ANGLES) for (const hz of PERIODS) for (const seed of SEEDS) {
        tried += 1;
        if (S.simulate(make(a), dur, base(seed, hz)).flicks) fired.push(`${name} a${a} ${hz}ms s${seed}`);
      }
    }
    expect(tried).toBeGreaterThan(9000);
    if (process.env.FLICK_REPORT === "1") console.log(`walk-flick false triggers: ${fired.length} / ${tried} scripted paths${fired.length ? `: ${[...new Set(fired.map((f) => f.replace(/ a\d+ .*/, "")))].join("; ")}` : ""}`);
    expect(fired.slice(0, 5)).toEqual([]);
  });

  it("a fresh touch that reaches the rim fast is not armed yet (the fresh-touch flick owns it)", () => {
    for (const ms of [40, 80, 120]) {
      const r = S.simulate(S.waypoints([{ at: 0, p: { x: 0, y: 0 } }, { at: ms, p: P(0, R * 1.2) }, { at: ms + 60, p: P(180, R * 1.2) }]), 400, base(1, 16));
      expect(r.flicks).toBe(0);
    }
  });

  it("a teleport between two samples far apart in time is slow movement, not a flick", () => {
    for (const quietMeansStill of [false, true]) {
      let state = WALK_FLICK_IDLE;
      let flicks = 0;
      for (const [t, y] of [[0, 0], [100, -40], [300, -46], [600, -46], [900, -46], [1200, -46], [1450, 46]] as const) {
        const out = walkFlickStep(state, { t, fx: 0, fy: y, dx: 0, dy: y, radiusPx: R, quietMeansStill });
        state = out.state;
        if (out.flick) flicks += 1;
      }
      expect(flicks).toBe(0);
    }
  });

  it("a quick return to the centre (letting the stick go) is not a flick", () => {
    const r = S.simulate(S.jump(0, P(0, R * 0.2), 50), 1400, base(1, 16));
    expect(r.flicks).toBe(0);
  });

  it("sliding further the way you already walk is not a flick", () => {
    const r = S.simulate(S.jump(0, P(0, R * 2.5), 50), 1400, base(1, 16));
    expect(r.flicks).toBe(0);
  });
});

describe("mid-hold flick: deliberate flicks (must all fire)", () => {
  /** Name, path, and the slowest flick (ms) that must still fire at sparse (<= 33 ms) and dense (<= 16 ms) pointer spacing. */
  const kinds: Array<[string, (a: number, ms: number) => S.Path, number, number]> = [
    ["reversal", (a, ms) => S.jump(a, P(a + 180, R * 1.3), ms), 70, 80],
    ["short reversal", (a, ms) => S.jump(a, P(a + 180, R * 0.6), ms), 0, 70],
    ["90 deg right", (a, ms) => S.jump(a, P(a + 90, R * 1.1), ms), 50, 60],
    ["90 deg left", (a, ms) => S.jump(a, P(a - 90, R * 1.1), ms), 50, 60],
    ["135 deg", (a, ms) => S.jump(a, P(a + 135, R * 1.2), ms), 60, 70],
    ["push out from a light walk", (a, ms) => S.waypoints([{ at: 0, p: { x: 0, y: 0 } }, { at: 120, p: P(a, R * 0.3) }, { at: 600, p: P(a, R * 0.3) }, { at: 600 + ms, p: P(a, R * 1.4) }]), 50, 40]
  ];

  it("fires on every scripted flick within each kind's speed limit, in every direction", () => {
    const sparse = tally();
    const dense = tally();
    const missed: string[] = [];
    for (const [name, make, sparseMs, denseMs] of kinds) {
      for (const a of ANGLES) for (const seed of SEEDS) {
        for (const ms of [30, 40, 50, 60, 70, 80, 90, 100]) {
          for (const hz of PERIODS) {
            const dense16 = hz <= 16;
            if (ms > (dense16 ? denseMs : sparseMs)) continue;
            // A flick shorter than the pointer spacing lands between two samples; sparse (loaded) input needs at least 50 ms of flick.
            if (!dense16 && ms < 50) continue;
            // The 50 ms window is about one and a half events at 33 ms spacing (a very loaded main thread): a flick is not guaranteed there.
            if (hz > 25) continue;
            const t = dense16 ? dense : sparse;
            t.tried += 1;
            const r = S.simulate(make(a, ms), 1400, base(seed, hz));
            if (r.flicks === 1) t.fired += 1; else missed.push(`${name} a${a} ${ms}ms spacing ${hz}ms s${seed}: ${r.flicks}`);
          }
        }
      }
    }
    if (process.env.FLICK_REPORT === "1") console.log(`walk-flick detection: sparse (25-33 ms spacing) ${sparse.fired}/${sparse.tried}, dense (8-16 ms spacing) ${dense.fired}/${dense.tried}; missed: ${missed.slice(0, 10).join("; ")}`);
    expect(missed.slice(0, 5)).toEqual([]);
  });

  it("the dash goes where the thumb ends up pointing (reversal and 90 degrees)", () => {
    let state = WALK_FLICK_IDLE;
    let flick: { dx: number; dy: number } | null = null;
    // Walking up (rim), 600 ms; then the finger snaps to the right rim in 50 ms.
    const path = S.jump(0, P(90, R), 50);
    for (let t = 0; t <= 1000; t += 16) {
      const p = path(t);
      const dx = Math.max(-R, Math.min(R, p.x));
      const dy = Math.max(-R, Math.min(R, p.y));
      const out = walkFlickStep(state, { t, fx: p.x, fy: p.y, dx, dy, radiusPx: R });
      state = out.state;
      flick ??= out.flick;
    }
    expect(flick).not.toBeNull();
    expect(flick!.dx).toBeGreaterThan(0.7 * R);
    expect(Math.abs(flick!.dy)).toBeLessThan(0.3 * R);
  });

  it("a thumb held perfectly still (no pointer events for a second) is still walking when it flicks", () => {
    let state = WALK_FLICK_IDLE;
    const fire: Array<{ dx: number; dy: number }> = [];
    // Rim up at 100 ms, silence, then a reversal flick at 1100, 1120, 1145 ms.
    for (const [t, y] of [[0, 0], [50, -25], [100, -46], [1100, -30], [1120, 5], [1145, 60]] as const) {
      const out = walkFlickStep(state, { t, fx: 0, fy: y, dx: 0, dy: Math.max(-R, Math.min(R, y)), radiusPx: R });
      state = out.state;
      if (out.flick) fire.push(out.flick);
    }
    expect(fire).toHaveLength(1);
  });

  it("a still thumb followed by a 90 degree flick: caught when movements are reported in full, safely cautious otherwise", () => {
    // Rest at the bottom rim, last event at 20945 ms; the flick's three events then arrive at 21033, 21055, 21082 (a quiet 88 ms before).
    const fingers: Array<[number, number, number]> = [[0, 0, 0], [60, 0, 32], [120, 0, 46], [20945, 0, 46], [21033, -22.5, 29.5], [21055, -45, 8], [21082, -64, 0]];
    const run = (quietMeansStill: boolean): number => {
      let state = WALK_FLICK_IDLE;
      let flicks = 0;
      let origin = { x: 0, y: 0 };
      for (const [t, x, y] of fingers) {
        // Floating stick: the origin trails a finger that goes past the rim.
        origin = trailOrigin(origin, { x, y }, R);
        const v = stickVector(origin, { x, y }, R);
        const out = walkFlickStep(state, { t, fx: x, fy: y, dx: v.dx, dy: v.dy, radiusPx: R, quietMeansStill });
        state = out.state;
        if (out.flick) flicks += 1;
      }
      return flicks;
    };
    expect(run(true)).toBe(1);
    expect(run(false)).toBeLessThanOrEqual(1);
  });

  it("with movements reported in full, a long quiet stretch still never turns a steady walk into a flick", () => {
    let state = WALK_FLICK_IDLE;
    let flicks = 0;
    for (const t of [0, 50, 100, 400, 900, 1500, 2600, 3000]) {
      const out = walkFlickStep(state, { t, fx: 0, fy: t === 0 ? 0 : -46, dx: 0, dy: t === 0 ? 0 : -46, radiusPx: R, quietMeansStill: true });
      state = out.state;
      if (out.flick) flicks += 1;
    }
    expect(flicks).toBe(0);
  });

  it("after a flick the next one needs the thumb to walk again first (no double dash from one swing)", () => {
    let state = WALK_FLICK_IDLE;
    let flicks = 0;
    // Reversal, then straight back again 120 ms later.
    for (const [t, y] of [[0, 0], [50, -46], [100, -46], [700, -46], [720, 0], [745, 46], [800, 46], [840, 0], [865, -46]] as const) {
      const out = walkFlickStep(state, { t, fx: 0, fy: y, dx: 0, dy: y, radiusPx: R });
      state = out.state;
      if (out.flick) flicks += 1;
    }
    expect(flicks).toBe(1);
  });

  it("fires once, then needs the thumb to walk again before the next flick", () => {
    const path = S.jump(0, P(180, R * 1.3), 50);
    const r = S.simulate((t) => path(t), 1400, base(1, 16));
    expect(r.flicks).toBe(1);
  });

  it("exposes the thresholds in one place", () => {
    expect(WALK_FLICK).toMatchObject({ windowMs: 50, minTravelFraction: 0.975, walkingForMs: 150, pushWindowMs: 50, pushMinTravelFraction: 0.675 });
  });
});

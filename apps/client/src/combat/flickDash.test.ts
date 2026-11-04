import { describe, expect, it } from "vitest";

import { FLICK_DASH, FLICK_IDLE, flickResolve, flickStep, type FlickSample, type FlickState } from "./flickDash.js";

const R = 46;
const sample = (elapsedMs: number, dx: number, dy: number, travelPx = Math.hypot(dx, dy)): FlickSample => ({ elapsedMs, dx, dy, travelPx, radiusPx: R });
const run = (samples: FlickSample[]): FlickState => samples.reduce((state, s) => flickStep(state, s), FLICK_IDLE);

describe("flick to dash", () => {
  it("a fast flick dashes in the flick direction", () => {
    const state = run([sample(20, 0, -10), sample(40, 0, -30), sample(70, 0, -46)]);
    expect(flickResolve(state, 100, true)).toEqual({ dash: true, dx: 0, dy: -46 });
  });

  it("a slow push does not dash (rim reached after the window)", () => {
    const state = run([sample(40, 0, -20), sample(106, 0, -46), sample(140, 0, -46)]);
    expect(flickResolve(state, 120, true).dash).toBe(false);
    expect(flickResolve(state, 100, true).dash).toBe(false);
  });

  it("a hold past 135 ms (a quick step) does not dash even after a fast rim touch", () => {
    const state = run([sample(30, 40, 0), sample(70, 46, 0)]);
    expect(flickResolve(state, 136, true).dash).toBe(false);
    expect(flickResolve(state, 200, true).dash).toBe(false);
    expect(flickResolve(state, 135, true).dash).toBe(true);
  });

  it("a short wiggle under 52.5% of the radius does not dash", () => {
    const state = run([sample(30, 20, 0), sample(60, 0.51 * R, 0), sample(100, 10, 5)]);
    expect(flickResolve(state, 120, true).dash).toBe(false);
  });

  it("respects the cooldown: nothing extra when the dash is not ready", () => {
    const state = run([sample(30, 0, -46)]);
    expect(flickResolve(state, 100, false).dash).toBe(false);
  });

  it("a fixed-stick tap on the rim (no finger travel) is not a flick", () => {
    const state = run([sample(10, 0, 46, 0)]);
    expect(flickResolve(state, 80, true).dash).toBe(false);
  });

  it("keeps the strongest direction inside the window and ignores samples after it", () => {
    const state = run([sample(30, 33, 0), sample(70, 0, 46), sample(100, -46, 0)]);
    expect(flickResolve(state, 110, true)).toEqual({ dash: true, dx: 0, dy: 46 });
  });

  it("exposes the thresholds in one place", () => {
    expect(FLICK_DASH).toMatchObject({ minRadiusFraction: 0.525, reachWithinMs: 105, releaseWithinMs: 135, minTravelFraction: 0.375 });
  });
});

import { describe, expect, it } from "vitest";
import { distanceMeters, type LatLon } from "@ash-atlas/shared";

import { MOB_RENDER_SNAP_M, nextCompanionRenderPosition, type CompanionRenderMotion } from "./combatRenderSmoothing.js";

type Rendered = { position: LatLon | null; motion: CompanionRenderMotion | null };

function step(state: Rendered, sample: LatLon, nowMs: number, snapM = MOB_RENDER_SNAP_M): Rendered {
  const next = nextCompanionRenderPosition(state.motion, state.position, sample, nowMs, snapM);
  return { position: next.position, motion: next.motion };
}

/** 0.00001 degrees of latitude is about 1.1 m. */
const stepLat = (index: number): LatLon => ({ lat: 35 + index * 0.00001, lon: -106 });

describe("mob render smoothing (velocity model)", () => {
  it("moves at a constant speed between 10 Hz samples", () => {
    let state: Rendered = { position: null, motion: null };
    state = step(state, stepLat(0), 0);
    const speeds: number[] = [];
    for (let sample = 1; sample <= 5; sample += 1) {
      const sampleAt = sample * 100;
      state = step(state, stepLat(sample), sampleAt);
      for (let t = 1; t <= 5; t += 1) {
        const before = state.position as LatLon;
        state = step(state, stepLat(sample), sampleAt + t * 20);
        if (sample >= 3) speeds.push(distanceMeters(before, state.position as LatLon));
      }
    }
    const first = speeds[0] as number;
    expect(first).toBeGreaterThan(0);
    for (const speed of speeds) expect(speed).toBeCloseTo(first, 3);
  });

  it("lands exactly on the sample within one interval and then stops changing", () => {
    let state: Rendered = { position: null, motion: null };
    state = step(state, stepLat(0), 0);
    state = step(state, stepLat(1), 100);
    for (let t = 116; t <= 216; t += 16) state = step(state, stepLat(1), t);
    expect(state.position).toEqual(stepLat(1));
    const settled = state.position;
    state = step(state, stepLat(1), 400);
    expect(state.position).toBe(settled);
    expect(state.position).toEqual(stepLat(1));
  });

  it("does not trail the sample by more than one sample interval", () => {
    let state: Rendered = { position: null, motion: null };
    state = step(state, stepLat(0), 0);
    state = step(state, stepLat(1), 100);
    state = step(state, stepLat(2), 200);
    const reached = step(state, stepLat(2), 300);
    expect(reached.position).toEqual(stepLat(2));
  });

  it("snaps on a large correction and keeps smoothing small ones", () => {
    let state: Rendered = { position: null, motion: null };
    state = step(state, stepLat(0), 0);
    const far: LatLon = { lat: 35 + (MOB_RENDER_SNAP_M * 2) / 111_000, lon: -106 };
    const snapped = step(state, far, 100);
    expect(snapped.position).toEqual(far);
    const small = step(state, stepLat(1), 100);
    expect(small.position).toEqual(stepLat(0));
  });

  it("smooths across the antimeridian the short way", () => {
    let state: Rendered = { position: null, motion: null };
    state = step(state, { lat: -17.8, lon: 179.9999 }, 0);
    state = step(state, { lat: -17.8, lon: -179.9999 }, 100);
    const mid = step(state, { lat: -17.8, lon: -179.9999 }, 150).position as LatLon;
    expect(Math.abs(mid.lon)).toBeGreaterThan(179.9998);
  });
});

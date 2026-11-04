import { describe, expect, it } from "vitest";

import {
  centsOff,
  compassHeading,
  detectPitchHz,
  headingDelta,
  heldTouchPoints,
  isFaceDownFromAccel,
  isFaceDownFromOrientation,
  normalizeTilt,
  rmsLevel,
  shakeMagnitude,
  slopeFromOrientation,
  snapGravity
} from "./sensorMath.js";

const sine = (hz: number, rate = 44100, n = 2048, amp = 0.4): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

describe("tilt", () => {
  it("maps portrait slope: right edge down is +x, bottom edge down is +y", () => {
    expect(slopeFromOrientation(10, 20, 0)).toEqual({ x: 20, y: 10 });
  });
  it("rotates the slope with the screen angle", () => {
    expect(slopeFromOrientation(10, 20, 90)).toEqual({ x: 10, y: -20 });
    expect(slopeFromOrientation(10, 20, 180)).toEqual({ x: -20, y: -10 });
    expect(slopeFromOrientation(10, 20, 270)).toEqual({ x: -10, y: 20 });
  });
  it("normalizes with a dead zone and caps at 1", () => {
    expect(normalizeTilt({ x: 1, y: 0 }, 20, 2)).toEqual({ x: 0, y: 0 });
    expect(normalizeTilt({ x: 60, y: 0 }, 20, 2).x).toBeCloseTo(1);
    expect(normalizeTilt({ x: 11, y: 0 }, 20, 2).x).toBeCloseTo(0.5);
  });
});

describe("motion", () => {
  it("shake magnitude is zero at rest and grows when shaken", () => {
    expect(shakeMagnitude(0, 0, 9.81)).toBeCloseTo(0);
    expect(shakeMagnitude(12, 8, 9.81)).toBeGreaterThan(5);
  });
  it("detects face down", () => {
    expect(isFaceDownFromAccel(-9.5)).toBe(true);
    expect(isFaceDownFromAccel(9.5)).toBe(false);
    expect(isFaceDownFromOrientation(175, 5)).toBe(true);
    expect(isFaceDownFromOrientation(40, 5)).toBe(false);
  });
  it("snaps gravity to four directions with hysteresis", () => {
    expect(snapGravity(0, 9.8)).toEqual({ x: 0, y: 1 });
    expect(snapGravity(9.8, 0)).toEqual({ x: -1, y: 0 });
    expect(snapGravity(-6, 5.5, { x: 0, y: 1 })).toEqual({ x: 0, y: 1 });
    expect(snapGravity(-9, 3, { x: 0, y: 1 })).toEqual({ x: 1, y: 0 });
  });
});

describe("compass", () => {
  it("prefers the iOS compass heading, else derives from alpha", () => {
    expect(compassHeading(90, 200)).toBe(200);
    expect(compassHeading(90)).toBe(270);
    expect(compassHeading(null)).toBeNull();
  });
  it("takes the shortest signed delta across north", () => {
    expect(headingDelta(350, 10)).toBe(20);
    expect(headingDelta(10, 350)).toBe(-20);
  });
});

describe("microphone", () => {
  it("measures rms level", () => {
    expect(rmsLevel(new Float32Array(100))).toBe(0);
    expect(rmsLevel(sine(220))).toBeCloseTo(0.4 / Math.SQRT2, 2);
  });
  it("finds the pitch of a hum", () => {
    for (const hz of [110, 220, 330, 440]) {
      const found = detectPitchHz(sine(hz), 44100);
      expect(found, String(hz)).not.toBeNull();
      expect(Math.abs(centsOff(found!, hz))).toBeLessThan(15);
    }
  });
  it("returns null for silence and a noise-floor signal", () => {
    expect(detectPitchHz(new Float32Array(2048), 44100)).toBeNull();
    expect(detectPitchHz(sine(220, 44100, 2048, 0.002), 44100)).toBeNull();
  });
});

describe("touches", () => {
  it("counts distinct fingers by id", () => {
    expect(heldTouchPoints([{ id: 1, x: 0, y: 0 }, { id: 1, x: 5, y: 5 }, { id: 2, x: 9, y: 9 }])).toHaveLength(2);
  });
});

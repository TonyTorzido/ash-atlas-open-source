import { DASH_COOLDOWN_MS, DASH_DISTANCE_M, DASH_DURATION_MS, destinationPoint, distanceMeters } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { chooseDashDirection, dashClientState, padAAction, predictDashEnd } from "./dash.js";

const origin = { lat: 35.0844, lon: -106.6504 };

describe("dash direction choice", () => {
  it("uses the held stick, rotated by the map bearing, as a world unit vector", () => {
    // Stick right on a north-up map: east.
    const east = chooseDashDirection({ stick: { dx: 40, dy: 0, radiusPx: 46 }, lastBearingDeg: 0, mapBearingDeg: 0 });
    expect(east.dirX).toBeCloseTo(1);
    expect(east.dirY).toBeCloseTo(0);
    // Stick up on a map rotated to face east: east again.
    const rotated = chooseDashDirection({ stick: { dx: 0, dy: -40, radiusPx: 46 }, lastBearingDeg: null, mapBearingDeg: 90 });
    expect(rotated.bearingDeg).toBeCloseTo(90);
    expect(Math.hypot(rotated.dirX, rotated.dirY)).toBeCloseTo(1);
  });

  it("falls back to the last movement direction when the stick is neutral, then to screen-up", () => {
    const last = chooseDashDirection({ stick: { dx: 2, dy: 1, radiusPx: 46 }, lastBearingDeg: 180, mapBearingDeg: 0 });
    expect(last.dirX).toBeCloseTo(0);
    expect(last.dirY).toBeCloseTo(-1);
    const none = chooseDashDirection({ stick: null, lastBearingDeg: null, mapBearingDeg: 270 });
    expect(none.bearingDeg).toBeCloseTo(270);
  });
});

describe("gamepad A split", () => {
  it("selects inside menus and popups, dashes in the world, and yields to bumper chords", () => {
    expect(padAAction(true, false)).toBe("select");
    expect(padAAction(false, false)).toBe("dash");
    expect(padAAction(false, true)).toBe("none");
    expect(padAAction(true, true)).toBe("none");
  });
});

describe("dash prediction", () => {
  const north = chooseDashDirection({ stick: null, lastBearingDeg: 0, mapBearingDeg: 0 });

  it("predicts the full distance, and clamps inside the leash", () => {
    const free = predictDashEnd(origin, north, { anchorLat: origin.lat, anchorLon: origin.lon, moveLeashRadiusM: 600 });
    expect(distanceMeters(origin, free!)).toBeCloseTo(DASH_DISTANCE_M, 0);
    const nearEdge = destinationPoint(origin, 560, 0);
    const clamped = predictDashEnd(nearEdge, north, { anchorLat: origin.lat, anchorLon: origin.lon, moveLeashRadiusM: 600 });
    expect(distanceMeters(origin, clamped!)).toBeLessThanOrEqual(600);
    expect(predictDashEnd(destinationPoint(origin, 599, 0), north, { anchorLat: origin.lat, anchorLon: origin.lon, moveLeashRadiusM: 600 })).toBeNull();
  });

  it("tracks active window, cooldown, acceptance measurement and rejection", () => {
    dashClientState.reset();
    const end = destinationPoint(origin, DASH_DISTANCE_M, 0);
    dashClientState.started({ requestId: "d1", pressedAtMs: 1_000, from: origin, predictedEnd: end });
    expect(dashClientState.isActive(1_000 + DASH_DURATION_MS - 1)).toBe(true);
    expect(dashClientState.isActive(1_000 + DASH_DURATION_MS)).toBe(false);
    expect(dashClientState.ready(1_000 + DASH_COOLDOWN_MS - 1)).toBe(false);
    // Walking: the server started 20 m behind the predicted start; the end differs by 3 m.
    const measurement = dashClientState.accepted("d1", destinationPoint(end, 3, 0), 1_080, destinationPoint(origin, 20, 270));
    expect(measurement).toMatchObject({ requestId: "d1", pressToAcceptMs: 80 });
    expect(measurement!.correctionM).toBeCloseTo(3, 1);
    expect(measurement!.startOffsetM).toBeCloseTo(20, 0);
    expect(dashClientState.takeMeasurement()).toEqual(measurement);
    expect(dashClientState.takeMeasurement()).toBeNull();
    dashClientState.started({ requestId: "d2", pressedAtMs: 5_000, from: origin, predictedEnd: end });
    expect(dashClientState.rejected("d2")).toBe(true);
    expect(dashClientState.ready(5_001)).toBe(true);
  });
});

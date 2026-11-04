import { distanceMeters } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  JOYSTICK_DEAD_ZONE,
  computeJoystickTarget,
  joystickBearingDeg,
  shouldSendJoystickMove
} from "./joystickMovementMath.js";

const origin = { lat: 35.08, lon: -106.65 };
const base = { radiusPx: 50, mapBearingDeg: 0, position: origin, speedMps: 5, leash: null };

describe("joystick movement math", () => {
  it("ignores deflection inside the dead zone", () => {
    expect(joystickBearingDeg(50 * (JOYSTICK_DEAD_ZONE - 0.02), 0, 50, 0)).toBeNull();
    expect(computeJoystickTarget({ ...base, dxPx: 3, dyPx: -3 })).toBeNull();
  });

  it("maps screen-up to the map bearing", () => {
    expect(joystickBearingDeg(0, -40, 50, 0)).toBeCloseTo(0);
    expect(joystickBearingDeg(40, 0, 50, 0)).toBeCloseTo(90);
    expect(joystickBearingDeg(0, -40, 50, 90)).toBeCloseTo(90);
    expect(joystickBearingDeg(-40, 0, 50, 90)).toBeCloseTo(0);
    expect(joystickBearingDeg(0, 40, 50, 350)).toBeCloseTo(170);
  });

  it("aims north of the player when pushed up on an unrotated map", () => {
    const result = computeJoystickTarget({ ...base, dxPx: 0, dyPx: -45 });
    expect(result).not.toBeNull();
    expect(result!.target.lat).toBeGreaterThan(origin.lat);
    expect(result!.target.lon).toBeCloseTo(origin.lon, 6);
    expect(distanceMeters(origin, result!.target)).toBeCloseTo(result!.distanceM, 1);
  });

  it("clamps the target inside the movement leash", () => {
    const leash = { anchorLat: origin.lat, anchorLon: origin.lon, moveLeashRadiusM: 100 };
    const nearEdge = computeJoystickTarget({
      ...base, dxPx: 0, dyPx: -45, leash,
      position: { lat: origin.lat + 95 / 111_195, lon: origin.lon }
    });
    expect(nearEdge).not.toBeNull();
    expect(distanceMeters(origin, nearEdge!.target)).toBeLessThanOrEqual(100);
    const atEdge = computeJoystickTarget({
      ...base, dxPx: 0, dyPx: -45, leash,
      position: { lat: origin.lat + 98.4 / 111_195, lon: origin.lon }
    });
    expect(atEdge).toBeNull();
  });

  it("resends only on first send, a turn, or a nearly reached target", () => {
    const next = computeJoystickTarget({ ...base, dxPx: 0, dyPx: -45 })!;
    expect(shouldSendJoystickMove(null, next, origin, 5)).toBe(true);
    const last = { target: next.target, bearingDeg: next.bearingDeg };
    expect(shouldSendJoystickMove(last, next, origin, 5)).toBe(false);
    expect(shouldSendJoystickMove(last, { ...next, bearingDeg: 30 }, origin, 5)).toBe(true);
    expect(shouldSendJoystickMove(last, next, next.target, 5)).toBe(true);
  });
});

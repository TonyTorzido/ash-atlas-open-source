import { afterEach, describe, expect, it } from "vitest";
import { destinationPoint, distanceMeters, type WaterShoreHint } from "@ash-atlas/shared";

import {
  SHORE_HINT_MAX_DISTANCE_M,
  SHORE_HINT_TTL_MS,
  hasFreshServerWall,
  isShoreSliding,
  recordShoreHint,
  resetShoreSlide,
  slideWalkTarget
} from "./shoreSlide.js";
import { JOYSTICK_RESEND_REMAINING_S, shouldSendJoystickMove } from "./joystickMovementMath.js";

const origin = { lat: 35.08, lon: -106.65 };
// Water due east, 1 m away from where the server measured.
const eastWall: WaterShoreHint = { at: origin, normalDeg: 90, gapM: 1 };

afterEach(() => resetShoreSlide());

describe("shore slide prediction", () => {
  it("leaves targets alone without a wall", () => {
    const target = destinationPoint(origin, 3, 45);
    expect(slideWalkTarget(origin, target, 0)).toBe(target);
  });

  it("slides a diagonal push along the shore instead of into the water", () => {
    recordShoreHint(eastWall, 0);
    const slid = slideWalkTarget(origin, destinationPoint(origin, 4, 45), 10);
    // Heading north-east against a wall on the east: keeps the northward part, never passes the wall.
    expect(slid.lat).toBeGreaterThan(origin.lat);
    expect(distanceMeters(origin, { lat: origin.lat, lon: slid.lon })).toBeLessThanOrEqual(0.61);
    expect(isShoreSliding(11)).toBe(true);
    expect(isShoreSliding(1000)).toBe(false);
  });

  it("stops (target is the player) when pushing straight into the wall", () => {
    recordShoreHint({ ...eastWall, gapM: 0.2 }, 0);
    const straight = destinationPoint(origin, 3, 90);
    expect(slideWalkTarget(origin, straight, 10)).toEqual(origin);
    expect(isShoreSliding(11)).toBe(false);
  });

  it("does not touch a walk away from the water or an explicit stop", () => {
    recordShoreHint(eastWall, 0);
    const west = destinationPoint(origin, 3, 270);
    expect(slideWalkTarget(origin, west, 10)).toBe(west);
    expect(slideWalkTarget(origin, origin, 10)).toBe(origin);
  });

  it("forgets the wall when the server reports none, when stale, or when far away", () => {
    const target = destinationPoint(origin, 3, 90);
    recordShoreHint(eastWall, 0);
    recordShoreHint(undefined, 5);
    expect(slideWalkTarget(origin, target, 10)).toBe(target);
    recordShoreHint(eastWall, 0);
    expect(slideWalkTarget(origin, target, SHORE_HINT_TTL_MS + 1)).toBe(target);
    recordShoreHint(eastWall, 0);
    const far = destinationPoint(origin, SHORE_HINT_MAX_DISTANCE_M + 5, 0);
    expect(slideWalkTarget(far, destinationPoint(far, 3, 90), 10)).toEqual(destinationPoint(far, 3, 90));
  });

  it("keeps a held stick resending while sliding so it follows the shore", () => {
    const position = origin;
    const next = { target: destinationPoint(origin, 3, 45), bearingDeg: 45, distanceM: 3 };
    const last = { target: next.target, bearingDeg: 45 };
    expect(shouldSendJoystickMove(last, next, position, 4 * (JOYSTICK_RESEND_REMAINING_S - 0.2))).toBe(false);
    recordShoreHint(eastWall, performance.now());
    slideWalkTarget(position, next.target, performance.now());
    expect(shouldSendJoystickMove(last, next, position, 4)).toBe(true);
  });

  it("keeps a held stick resending right after the server reports a wall, even without a client slide", () => {
    const position = origin;
    const next = { target: destinationPoint(origin, 3, 45), bearingDeg: 45, distanceM: 3 };
    const last = { target: next.target, bearingDeg: 45 };
    const speed = 4 * (JOYSTICK_RESEND_REMAINING_S - 0.2);
    expect(shouldSendJoystickMove(last, next, position, speed)).toBe(false);
    recordShoreHint(eastWall, performance.now());
    expect(shouldSendJoystickMove(last, next, position, speed)).toBe(true);
    expect(hasFreshServerWall(performance.now() + 1_000)).toBe(false);
    recordShoreHint(undefined, performance.now());
    expect(shouldSendJoystickMove(last, next, position, speed)).toBe(false);
  });
});

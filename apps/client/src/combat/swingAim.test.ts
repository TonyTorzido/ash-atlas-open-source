import { describe, expect, it } from "vitest";

import {
  ATTACK_BUTTON_DEAD_ZONE_PX,
  ATTACK_BUTTON_RELEASE_PX,
  autoAimDirection,
  classifyAttackDrag,
  swingDirectionFromScreenOffset,
  swingDirectionToward,
  swingScreenDirection
} from "./swingAim.js";

describe("swing aim", () => {
  it("turns a cursor offset into a world vector using the map bearing", () => {
    const east = swingDirectionFromScreenOffset(50, 0, 0)!;
    expect(east.dirX).toBeCloseTo(1);
    expect(east.dirY).toBeCloseTo(0);
    // Cursor straight up on a map rotated to face east aims east.
    const rotated = swingDirectionFromScreenOffset(0, -50, 90)!;
    expect(rotated.dirX).toBeCloseTo(1);
    expect(rotated.dirY).toBeCloseTo(0);
    expect(swingDirectionFromScreenOffset(0, 0, 0)).toBeNull();
  });

  it("round-trips world aim to screen direction", () => {
    expect(swingScreenDirection({ dirX: 1, dirY: 0 }, 0)).toEqual({ x: expect.closeTo(1), y: expect.closeTo(0) });
    const up = swingScreenDirection({ dirX: 1, dirY: 0 }, 90);
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(-1);
  });

  it("aims from one position toward another in world space", () => {
    const from = { lat: 35, lon: -106 };
    const north = swingDirectionToward(from, { lat: 35.001, lon: -106 })!;
    expect(north.dirY).toBeCloseTo(1);
    const east = swingDirectionToward(from, { lat: 35, lon: -105.999 })!;
    expect(east.dirX).toBeCloseTo(1);
    expect(swingDirectionToward(from, from)).toBeNull();
  });
});

describe("attack button drag", () => {
  it("stays idle inside the dead zone, aims outside it, cancels on the way back", () => {
    expect(classifyAttackDrag(ATTACK_BUTTON_DEAD_ZONE_PX - 1, 0, 0, false)).toEqual({ kind: "idle" });
    expect(classifyAttackDrag(ATTACK_BUTTON_RELEASE_PX - 1, 0, 0, true)).toEqual({ kind: "cancel" });
    // Hysteresis: an aiming finger between the release and entry radii keeps aiming.
    expect(classifyAttackDrag(ATTACK_BUTTON_DEAD_ZONE_PX - 2, 0, 0, true).kind).toBe("aim");
    // A 12 px thumb wobble is still a tap; a 20 px drag already aims, in the drag direction.
    expect(classifyAttackDrag(-12, 3, 0, false)).toEqual({ kind: "idle" });
    const quick = classifyAttackDrag(0, 20, 0, false);
    expect(quick.kind).toBe("aim");
    if (quick.kind === "aim") expect(quick.direction.dirY).toBeLessThan(-0.99);
    const east = classifyAttackDrag(60, 0, 0, false);
    expect(east.kind).toBe("aim");
    if (east.kind === "aim") {
      expect(east.direction.dirX).toBeCloseTo(1);
      expect(east.direction.dirY).toBeCloseTo(0);
    }
  });

  it("maps a drag to a world bearing through the map bearing", () => {
    // Dragging up on a map facing east aims east; dragging down on a north-up map aims south.
    const rotated = classifyAttackDrag(0, -60, 90, false);
    expect(rotated.kind === "aim" && rotated.direction.dirX).toBeCloseTo(1);
    const south = classifyAttackDrag(0, 60, 0, true);
    expect(south.kind === "aim" && south.direction.dirY).toBeCloseTo(-1);
  });
});

describe("auto aim", () => {
  const origin = { lat: 35, lon: -106 };
  it("picks the nearest mob in range when none is in the facing cone", () => {
    const near = { lat: 35.0003, lon: -106 };
    const far = { lat: 35, lon: -105.9995 };
    const direction = autoAimDirection(origin, [far, near], 110, 180)!;
    expect(direction.dirY).toBeCloseTo(1);
  });
  it("prefers a mob in the facing cone over a closer one behind", () => {
    const ahead = { lat: 35.0009, lon: -106 }; // ~100 m north
    const behind = { lat: 34.99937, lon: -106 }; // ~70 m south
    const facingNorth = autoAimDirection(origin, [behind, ahead], 130, 0)!;
    expect(facingNorth.dirY).toBeCloseTo(1);
    // Up to 70 degrees off the facing still counts as in front.
    const side = { lat: 35.0003, lon: -105.9991 }; // ~33 m north, ~82 m east: ~68 degrees
    expect(autoAimDirection(origin, [behind, side], 130, 0)!.dirX).toBeGreaterThan(0.9);
  });
  it("falls back to the last movement bearing when nothing is in range", () => {
    const tooFar = { lat: 35.01, lon: -106 };
    const direction = autoAimDirection(origin, [tooFar], 110, 90)!;
    expect(direction.dirX).toBeCloseTo(1);
    expect(direction.dirY).toBeCloseTo(0);
    expect(autoAimDirection(origin, [], 110, null)).toBeNull();
  });
});

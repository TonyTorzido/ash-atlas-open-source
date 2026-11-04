import { describe, expect, it } from "vitest";
import type { IndoorRoomNavigation } from "@ash-atlas/shared";

import { walkableIndoorJoystickTarget } from "./indoorJoystickTarget.js";

const room: IndoorRoomNavigation = {
  roomWidth: 1000,
  roomHeight: 800,
  playerRadius: 20,
  colliders: [{ id: "table", minX: 400, minY: 300, maxX: 600, maxY: 500 }]
};

describe("walkableIndoorJoystickTarget", () => {
  it("keeps a walkable target", () => {
    expect(walkableIndoorJoystickTarget(room, { x: 200, y: 200 }, { x: 260, y: 200 })).toEqual({ x: 260, y: 200 });
  });

  it("stops short of the wall instead of sending an off-floor target", () => {
    const target = walkableIndoorJoystickTarget(room, { x: 940, y: 200 }, { x: 1040, y: 200 })!;
    expect(target.x).toBeGreaterThan(970);
    expect(target.x).toBeLessThanOrEqual(980);
    expect(target.y).toBe(200);
  });

  it("slides along the wall when pushed diagonally into it", () => {
    const target = walkableIndoorJoystickTarget(room, { x: 975, y: 200 }, { x: 1040, y: 260 })!;
    expect(target.y).toBeGreaterThan(250);
    expect(target.x).toBeLessThanOrEqual(980);
  });

  it("returns null when the player is pressed flat against the wall", () => {
    expect(walkableIndoorJoystickTarget(room, { x: 980, y: 200 }, { x: 1040, y: 200 })).toBeNull();
  });

  it("stops at a collider", () => {
    const target = walkableIndoorJoystickTarget(room, { x: 300, y: 400 }, { x: 450, y: 400 })!;
    expect(target.x).toBeLessThanOrEqual(380);
    expect(target.x).toBeGreaterThan(370);
  });
});

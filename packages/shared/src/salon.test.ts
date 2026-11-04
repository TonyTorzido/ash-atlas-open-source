import { describe, expect, it } from "vitest";

import {
  SALON_CHAIR,
  SALON_CHAIR_APPROACH,
  SALON_FLOOR_SIZE,
  SALON_INTERACTION_APPROACH_INSET,
  SALON_MAIN_ROOM,
  SALON_PLAYER_RADIUS,
  SALON_SPAWN
} from "./salon.js";
import {
  findIndoorNavigationRoute,
  indoorInteractionApproachPoint,
  isIndoorNavigationPointWalkable,
  isIndoorNavigationSegmentWalkable,
  type IndoorPoint
} from "./indoor.js";
import { SALON_CHAIR_INTERACTION_RADIUS } from "./salon.js";

describe("Salon room definition", () => {
  it("owns the canonical room, spawn, and chair geometry", () => {
    expect(SALON_MAIN_ROOM).toMatchObject({
      spaceId: "salon_main_room",
      roomWidth: 1_000,
      roomHeight: 1_000,
      playerRadius: 24,
      spawn: { x: 500, y: 790 }
    });
    expect(SALON_MAIN_ROOM.fixtures.chair).toEqual({
      position: { x: 500, y: 170 },
      approachPosition: { x: 500, y: 255 },
      collider: { id: "salon_chair", minX: 435, maxX: 565, minY: 125, maxY: 215 }
    });
    expect(SALON_MAIN_ROOM.colliders).toEqual([SALON_MAIN_ROOM.fixtures.chair.collider]);
    expect(SALON_FLOOR_SIZE).toBe(SALON_MAIN_ROOM.roomWidth);
    expect(SALON_PLAYER_RADIUS).toBe(SALON_MAIN_ROOM.playerRadius);
    expect(SALON_SPAWN).toBe(SALON_MAIN_ROOM.spawn);
    expect(SALON_CHAIR).toBe(SALON_MAIN_ROOM.fixtures.chair.position);
    expect(SALON_CHAIR_APPROACH).toBe(SALON_MAIN_ROOM.fixtures.chair.approachPosition);
    expect(Object.isFrozen(SALON_MAIN_ROOM)).toBe(true);
    expect(Object.isFrozen(SALON_MAIN_ROOM.fixtures)).toBe(true);
    expect(Object.isFrozen(SALON_MAIN_ROOM.fixtures.chair)).toBe(true);
    expect(Object.isFrozen(SALON_MAIN_ROOM.fixtures.chair.collider)).toBe(true);
    expect(Object.isFrozen(SALON_MAIN_ROOM.colliders)).toBe(true);
  });

  it("blocks the chair center while keeping the shared approach point walkable", () => {
    const approach = indoorInteractionApproachPoint(
      SALON_SPAWN,
      SALON_CHAIR,
      SALON_CHAIR_INTERACTION_RADIUS,
      SALON_INTERACTION_APPROACH_INSET
    );
    expect(approach).toEqual({ x: 500, y: 255 });
    expect(SALON_CHAIR_APPROACH).toEqual(approach);
    expect(isIndoorNavigationPointWalkable(SALON_MAIN_ROOM, SALON_CHAIR)).toBe(false);
    expect(isIndoorNavigationPointWalkable(SALON_MAIN_ROOM, approach)).toBe(true);
  });

  it("finds the deterministic collision-free route around the chair", () => {
    const route = findIndoorNavigationRoute(SALON_MAIN_ROOM, SALON_SPAWN, { x: 500, y: 50 });
    expect(route).toEqual([
      { x: 411, y: 239 },
      { x: 411, y: 101 },
      { x: 500, y: 50 }
    ]);
    let previous: IndoorPoint = SALON_SPAWN;
    for (const waypoint of route ?? []) {
      expect(isIndoorNavigationSegmentWalkable(SALON_MAIN_ROOM, previous, waypoint)).toBe(true);
      previous = waypoint;
    }
  });
});

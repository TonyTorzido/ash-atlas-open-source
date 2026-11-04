import { describe, expect, it } from "vitest";

import {
  findIndoorNavigationRoute,
  isIndoorNavigationPointWalkable,
  isIndoorNavigationSegmentWalkable,
  type IndoorPoint,
  type IndoorRoomNavigation
} from "./indoor.js";

const room: IndoorRoomNavigation = {
  roomWidth: 300,
  roomHeight: 300,
  playerRadius: 10,
  colliders: [{ id: "fixture", minX: 130, maxX: 170, minY: 100, maxY: 200 }]
};

describe("indoor room navigation", () => {
  it("returns a direct logical route when unobstructed", () => {
    expect(findIndoorNavigationRoute(room, { x: 50, y: 50 }, { x: 250, y: 50 }))
      .toEqual([{ x: 250, y: 50 }]);
    expect(findIndoorNavigationRoute(room, { x: 50, y: 50 }, { x: 50, y: 50 }))
      .toEqual([{ x: 50, y: 50 }]);
  });

  it("rejects a target blocked by an actor-radius-inflated collider", () => {
    expect(isIndoorNavigationPointWalkable(room, { x: 150, y: 150 })).toBe(false);
    expect(findIndoorNavigationRoute(room, { x: 50, y: 150 }, { x: 150, y: 150 })).toBeNull();
  });

  it("chooses the deterministic shortest detour and keeps every segment collision-free", () => {
    const start = { x: 50, y: 150 };
    const route = findIndoorNavigationRoute(room, start, { x: 250, y: 150 });
    expect(route).toEqual([
      { x: 120, y: 90 },
      { x: 180, y: 90 },
      { x: 250, y: 150 }
    ]);
    let previous: IndoorPoint = start;
    for (const waypoint of route ?? []) {
      expect(isIndoorNavigationSegmentWalkable(room, previous, waypoint)).toBe(true);
      previous = waypoint;
    }
  });
});

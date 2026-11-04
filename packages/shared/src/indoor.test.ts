import { describe, expect, it } from "vitest";

import {
  CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS,
  CISTERN_WARRENS_FLOOR_SIZE,
  MANOR_DOOR, MANOR_DOOR_INTERACTION_RADIUS, MANOR_FLOOR_SIZE, MANOR_MAX_TARGET_DISTANCE,
  MANOR_FOYER_ROOM, MANOR_MAIN_ROOM, MANOR_INTERIOR_SPACE, worldExitOf,
  MANOR_MOVE_SPEED, MANOR_PLAYER_RADIUS, MANOR_PLAYER_VISUAL_HEIGHT_UNITS, MANOR_SPAWN,
  SALON_DOOR, SALON_DOOR_INTERACTION_RADIUS, SALON_FLOOR_SIZE, SALON_MAX_TARGET_DISTANCE,
  SALON_MOVE_SPEED, SALON_PLAYER_RADIUS, SALON_PLAYER_VISUAL_HEIGHT_UNITS, SALON_SPAWN,
  STANDARD_INDOOR_SPATIAL_PROFILE, advanceIndoorVector,
  findIndoorNavigationRoute, isIndoorNavigationPointWalkable,
  isIndoorNavigationSegmentWalkable
} from "./index.js";

describe("standard indoor spatial profile", () => {
  it("preserves the public Manor and Salon constants as aliases", () => {
    expect(STANDARD_INDOOR_SPATIAL_PROFILE.roomWidth).toBe(1_000);
    expect(STANDARD_INDOOR_SPATIAL_PROFILE.roomHeight).toBe(1_000);
    expect(STANDARD_INDOOR_SPATIAL_PROFILE.playerVisualHeightUnits).toBe(70);
    expect(MANOR_PLAYER_VISUAL_HEIGHT_UNITS).toBe(70);
    expect(SALON_PLAYER_VISUAL_HEIGHT_UNITS).toBe(70);
    expect(CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS).toBe(35);
    expect(CISTERN_WARRENS_FLOOR_SIZE).toBe(1_000);
    expect(MANOR_FLOOR_SIZE).toBe(1_254);
    expect(MANOR_MAIN_ROOM.roomWidth).toBe(1_254);
    expect(MANOR_MAIN_ROOM.roomHeight).toBe(1_254);
    expect(MANOR_FOYER_ROOM.roomWidth).toBe(1_000);
    expect(MANOR_FOYER_ROOM.roomHeight).toBe(1_000);
    expect(MANOR_MAIN_ROOM.colliders).toEqual([]);
    expect(MANOR_MAIN_ROOM.colliders).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "manor_chest" }),
      expect.objectContaining({ id: "manor_smith" }),
      expect.objectContaining({ id: "manor_jewel" }),
      expect.objectContaining({ id: "manor_breeder" })
    ]));
    expect(MANOR_FOYER_ROOM.colliders).toEqual([]);
    expect(SALON_FLOOR_SIZE).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.roomWidth);
    expect(MANOR_PLAYER_RADIUS).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius);
    expect(SALON_PLAYER_RADIUS).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius);
    expect(MANOR_MOVE_SPEED).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond);
    expect(SALON_MOVE_SPEED).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond);
    expect(MANOR_MAX_TARGET_DISTANCE).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.maxTargetDistance);
    expect(SALON_MAX_TARGET_DISTANCE).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.maxTargetDistance);
    // Players arrive just inside the lobby front door (the authored spawn anchor).
    const lobbySpawn = MANOR_INTERIOR_SPACE.rooms[0]!.anchors.find((anchor) => anchor.id === MANOR_INTERIOR_SPACE.rooms[0]!.spawnAnchorId)!;
    expect(MANOR_SPAWN).toEqual({ x: lobbySpawn.x, y: lobbySpawn.y });
    expect(SALON_SPAWN).toEqual(STANDARD_INDOOR_SPATIAL_PROFILE.spawn);
    expect(MANOR_DOOR).toEqual(worldExitOf(MANOR_INTERIOR_SPACE)!.position);
    expect(SALON_DOOR).toEqual(STANDARD_INDOOR_SPATIAL_PROFILE.door);
    expect(MANOR_DOOR_INTERACTION_RADIUS).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.doorInteractionRadius);
    expect(SALON_DOOR_INTERACTION_RADIUS).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.doorInteractionRadius);
    expect(Object.isFrozen(STANDARD_INDOOR_SPATIAL_PROFILE)).toBe(true);
    expect(Object.isFrozen(STANDARD_INDOOR_SPATIAL_PROFILE.spawn)).toBe(true);
  });

  it("advances along a vector and reports arrival without owning settle policy", () => {
    expect(advanceIndoorVector({ x: 0, y: 0 }, { x: 3, y: 4 }, 2)).toEqual({
      x: 1.2, y: 1.6, arrived: false
    });
    expect(advanceIndoorVector({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toEqual({
      x: 3, y: 4, arrived: true
    });
  });

  it("routes around polygon colliders with exact player-radius clearance", () => {
    const room = {
      roomWidth: 1_000,
      roomHeight: 1_000,
      playerRadius: 20,
      colliders: [{
        id: "polygon",
        kind: "polygon" as const,
        points: [
          { x: 400, y: 400 }, { x: 600, y: 400 },
          { x: 600, y: 600 }, { x: 400, y: 600 }
        ]
      }]
    };
    expect(isIndoorNavigationPointWalkable(room, { x: 390, y: 500 })).toBe(false);
    expect(isIndoorNavigationPointWalkable(room, { x: 380, y: 500 })).toBe(true);
    expect(isIndoorNavigationSegmentWalkable(room, { x: 300, y: 500 }, { x: 700, y: 500 }))
      .toBe(false);
    const route = findIndoorNavigationRoute(room, { x: 300, y: 500 }, { x: 700, y: 500 });
    expect(route).not.toBeNull();
    let previous = { x: 300, y: 500 };
    for (const waypoint of route ?? []) {
      expect(isIndoorNavigationSegmentWalkable(room, previous, waypoint)).toBe(true);
      previous = waypoint;
    }
    expect(previous).toEqual({ x: 700, y: 500 });
  });

  it("keeps authored floor surfaces authoritative for endpoints and route segments", () => {
    const room = {
      roomWidth: 1_000,
      roomHeight: 1_000,
      playerRadius: 20,
      walkableSurfaces: [[
        { x: 100, y: 100 }, { x: 900, y: 100 },
        { x: 900, y: 900 }, { x: 100, y: 900 }
      ]],
      colliders: []
    };
    expect(isIndoorNavigationPointWalkable(room, { x: 100, y: 500 })).toBe(true);
    expect(isIndoorNavigationPointWalkable(room, { x: 100 - 5e-10, y: 500 })).toBe(true);
    expect(isIndoorNavigationPointWalkable(room, { x: 100 - 2e-9, y: 500 })).toBe(false);
    expect(isIndoorNavigationPointWalkable(room, { x: 120, y: 500 })).toBe(true);
    expect(isIndoorNavigationPointWalkable(room, { x: 900, y: 500 })).toBe(true);
    expect(isIndoorNavigationSegmentWalkable(room, { x: 120, y: 500 }, { x: 880, y: 500 })).toBe(true);
    expect(isIndoorNavigationSegmentWalkable(room, { x: 120, y: 500 }, { x: 100, y: 500 })).toBe(true);
    expect(isIndoorNavigationSegmentWalkable(room, { x: 120, y: 500 }, { x: 950, y: 500 })).toBe(false);
  });

  it("uses the authored Manor floor boundary without obsolete invisible colliders", () => {
    const floor = MANOR_MAIN_ROOM.walkableSurfaces?.[0];
    expect(floor).toBeDefined();
    const targets = [
      { x: 627, y: 200 },
      { x: 80, y: 700 },
      { x: 1180, y: 700 },
      { x: 558, y: 485 },
      { x: MANOR_MAIN_ROOM.roomWidth / 2, y: MANOR_MAIN_ROOM.roomHeight }
    ];
    for (const target of targets) {
      expect(isIndoorNavigationPointWalkable(MANOR_MAIN_ROOM, target)).toBe(true);
      expect(findIndoorNavigationRoute(MANOR_MAIN_ROOM, MANOR_SPAWN, target)).not.toBeNull();
    }

    const leftTop = floor![0]!;
    const leftBottom = floor![3]!;
    const y = 700;
    const leftEdgeX = leftTop.x + (y - leftTop.y) / (leftBottom.y - leftTop.y) *
      (leftBottom.x - leftTop.x);
    expect(isIndoorNavigationPointWalkable(MANOR_MAIN_ROOM, { x: leftEdgeX - 1e-6, y })).toBe(false);
  });

  it("keeps concave authored floor paths inside while allowing boundary travel", () => {
    const room = {
      roomWidth: 20,
      roomHeight: 20,
      playerRadius: 10,
      walkableSurfaces: [[
        { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 },
        { x: 12, y: 20 }, { x: 12, y: 8 }, { x: 8, y: 8 },
        { x: 8, y: 20 }, { x: 0, y: 20 }
      ]],
      colliders: []
    };
    expect(isIndoorNavigationPointWalkable(room, { x: 0, y: 0 })).toBe(true);
    expect(isIndoorNavigationSegmentWalkable(room, { x: 0, y: 20 }, { x: 8, y: 20 })).toBe(true);
    expect(isIndoorNavigationSegmentWalkable(room, { x: 0, y: 20 }, { x: 20, y: 20 })).toBe(false);
    expect(isIndoorNavigationSegmentWalkable(room, { x: 4, y: 16 }, { x: 16, y: 16 })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { MELEE_ATTACK_RANGE_M, RANGED_ATTACK_RANGE_M } from "./combat.js";
import { DEFAULT_PLAYER_SPEED_MPS } from "./gameplayArea.js";
import {
  CISTERN_WARRENS_ENTRANCE_ROOM,
  CISTERN_WARRENS_FLOOR_SIZE,
  CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT,
  CISTERN_WARRENS_LEGACY_STORED_FLOOR_SIZE,
  CISTERN_WARRENS_MOVE_SPEED,
  CISTERN_WARRENS_PLAYER_RADIUS,
  CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS,
  CISTERN_WARRENS_SPATIAL_PROFILE,
  cisternWarrensIndoorPointToStored,
  cisternWarrensIndoorDistanceToStored,
  cisternWarrensRoomNavigation,
  cisternWarrensStoredPointToIndoor,
  cisternWarrensStoredDistanceToIndoor,
  combatPositionToDungeonLocal,
  dungeonLocalDistanceToCombatMeters,
  dungeonLocalToCombatPosition
} from "./dungeon.js";
import { STANDARD_INDOOR_SPATIAL_PROFILE } from "./indoor.js";

describe("Cistern Warrens spatial rules", () => {
  it("uses the canonical indoor profile while retaining exact legacy storage conversion", () => {
    expect(CISTERN_WARRENS_LEGACY_STORED_FLOOR_SIZE).toBe(160);
    expect(CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT).toBe(6.25);
    expect(CISTERN_WARRENS_FLOOR_SIZE).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.roomWidth);
    expect(CISTERN_WARRENS_PLAYER_RADIUS).toBe(STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius);
    expect(CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS).toBe(35);
    expect(CISTERN_WARRENS_MOVE_SPEED).toBe(130);
    const indoor = cisternWarrensStoredPointToIndoor({ x: 28, y: 105 });
    expect(indoor).toEqual({ x: 175, y: 656.25 });
    expect(cisternWarrensIndoorPointToStored(indoor)).toEqual({ x: 28, y: 105 });
    expect(cisternWarrensStoredDistanceToIndoor(12)).toBe(75);
    expect(cisternWarrensIndoorDistanceToStored(75)).toBe(12);
  });

  it("owns frozen canonical room and fixture identities", () => {
    expect(CISTERN_WARRENS_ENTRANCE_ROOM).toMatchObject({
      spaceId: "hatch_landing", roomWidth: 1_000, roomHeight: 1_000,
      playerRadius: 24, spawn: { x: 500, y: 200 }
    });
    expect(CISTERN_WARRENS_ENTRANCE_ROOM.colliders).toHaveLength(7);
    expect(CISTERN_WARRENS_ENTRANCE_ROOM.fixtures).toMatchObject({
      ladder: { position: { x: 500, y: 60 } }
    });
    expect(cisternWarrensRoomNavigation("hatch_landing")).toBe(CISTERN_WARRENS_ENTRANCE_ROOM);
    expect(Object.isFrozen(CISTERN_WARRENS_ENTRANCE_ROOM)).toBe(true);
  });

  it("preserves physical combat positions and ranges after canonical scaling", () => {
    const canonical = cisternWarrensStoredPointToIndoor({ x: 28, y: 105 });
    const point = combatPositionToDungeonLocal(
      dungeonLocalToCombatPosition(canonical.x, canonical.y)
    );
    expect(point.x).toBeCloseTo(canonical.x, 8);
    expect(point.y).toBeCloseTo(canonical.y, 8);
    expect(CISTERN_WARRENS_SPATIAL_PROFILE.combatMetersPerLocalUnit).toBeCloseTo(
      DEFAULT_PLAYER_SPEED_MPS / CISTERN_WARRENS_MOVE_SPEED, 8
    );
    expect(dungeonLocalDistanceToCombatMeters(
      CISTERN_WARRENS_SPATIAL_PROFILE.playerMeleeRangeLocalUnits
    )).toBeCloseTo(MELEE_ATTACK_RANGE_M, 8);
    expect(dungeonLocalDistanceToCombatMeters(
      CISTERN_WARRENS_SPATIAL_PROFILE.playerRangedRangeLocalUnits
    )).toBeCloseTo(RANGED_ATTACK_RANGE_M, 8);
    expect(dungeonLocalDistanceToCombatMeters(
      CISTERN_WARRENS_SPATIAL_PROFILE.playerMovementLocalUnitsPerSecond
    )).toBeCloseTo(DEFAULT_PLAYER_SPEED_MPS, 8);
    expect(CISTERN_WARRENS_SPATIAL_PROFILE.playerMeleeRangeLocalUnits)
      .toBeGreaterThan(CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS * 2);
  });
});

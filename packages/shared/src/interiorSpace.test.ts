import { describe, expect, it } from "vitest";

import {
  combatPositionToDungeonLocal,
  DUNGEON_METERS_PER_COORDINATE,
  dungeonLocalToCombatPosition
} from "./dungeon.js";
import { DEFAULT_PLAYER_SPEED_MPS } from "./gameplayArea.js";
import { bearingDegrees } from "./boss.js";
import { distanceMeters } from "./geo.js";
import {
  INTERIOR_SPATIAL_PROFILES,
  interiorLngLatToLocal,
  interiorLocalToLngLat,
  interiorMetersPerUnit,
  interiorPlayerHeightMeters
} from "./interiorSpace.js";

const profiles = Object.entries(INTERIOR_SPATIAL_PROFILES);

describe("interior map space", () => {
  it("round-trips local points for every indoor profile", () => {
    for (const [, profile] of profiles) {
      const mpu = interiorMetersPerUnit(profile);
      for (const point of [{ x: 0, y: 0 }, { x: 125.5, y: 870.25 }, { x: 1000, y: 1000 }]) {
        const local = interiorLngLatToLocal(interiorLocalToLngLat(point, mpu), mpu);
        expect(local.x).toBeCloseTo(point.x, 9);
        expect(local.y).toBeCloseTo(point.y, 9);
      }
    }
  });

  it("maps local +y (down on screen) to south so rooms render upright", () => {
    const mpu = interiorMetersPerUnit(INTERIOR_SPATIAL_PROFILES.dungeon);
    const top = interiorLocalToLngLat({ x: 500, y: 100 }, mpu);
    const bottom = interiorLocalToLngLat({ x: 500, y: 900 }, mpu);
    expect(bottom.lat).toBeLessThan(top.lat);
    expect(bearingDegrees(top, bottom)).toBeCloseTo(180, 6);
    const right = interiorLocalToLngLat({ x: 900, y: 100 }, mpu);
    expect(bearingDegrees(top, right)).toBeCloseTo(90, 3);
  });

  it("matches the authoritative dungeon combat conversion exactly", () => {
    const mpu = interiorMetersPerUnit(INTERIOR_SPATIAL_PROFILES.dungeon);
    expect(mpu).toBe(DUNGEON_METERS_PER_COORDINATE);
    const point = { x: 312, y: 644 };
    const combat = dungeonLocalToCombatPosition(point.x, point.y);
    const map = interiorLocalToLngLat(point, mpu);
    expect(map.lat).toBeCloseTo(combat.lat, 12);
    expect(map.lon).toBeCloseTo(combat.lon, 12);
    const back = combatPositionToDungeonLocal(map);
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
  });

  it("moves every indoor profile at the overworld pace with the same player height", () => {
    for (const [, profile] of profiles) {
      const mpu = interiorMetersPerUnit(profile);
      const start = interiorLocalToLngLat({ x: 0, y: 0 }, mpu);
      const oneSecond = interiorLocalToLngLat({ x: profile.movementUnitsPerSecond, y: 0 }, mpu);
      expect(distanceMeters(start, oneSecond)).toBeCloseTo(DEFAULT_PLAYER_SPEED_MPS, 3);
      expect(interiorPlayerHeightMeters(profile)).toBeCloseTo(33.65, 2);
      expect(interiorPlayerHeightMeters(profile))
        .toBeCloseTo(interiorPlayerHeightMeters(INTERIOR_SPATIAL_PROFILES.standard_indoor), 9);
    }
  });
});

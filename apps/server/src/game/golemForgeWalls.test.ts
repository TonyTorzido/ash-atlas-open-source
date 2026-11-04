import {
  DUNGEON_CATALOG, cisternWarrensRoomNavigation, combatPositionToDungeonLocal, destinationPoint, dungeonLocalToCombatPosition,
  isIndoorNavigationPointWalkable, isIndoorNavigationSegmentWalkable, type DungeonCatalog, type LatLon
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { CombatEngine } from "./combat/combatEngine.js";
import { clampPathToDungeonWalls } from "./coreBossRuntime.js";

describe("golem forge: charges and knockback stop at walls", () => {
  const forge = (DUNGEON_CATALOG as DungeonCatalog).dungeons.find((dungeon) => dungeon.id === "golem_forge")!;

  it("clamps a long charge to the last walkable point of its line, in every Golem Forge room", () => {
    let clamped = 0;
    for (const room of forge.rooms) {
      const navigation = cisternWarrensRoomNavigation(room.id, forge);
      const zoneId = `interior:i:${room.id}`;
      const startLocal = { x: room.width / 2, y: room.height / 2 };
      if (!isIndoorNavigationPointWalkable(navigation, startLocal)) continue;
      const from = dungeonLocalToCombatPosition(startLocal.x, startLocal.y);
      for (let bearing = 0; bearing < 360; bearing += 45) {
        const to: LatLon = destinationPoint(from, 700, bearing);
        const landed = clampPathToDungeonWalls(zoneId, from, to);
        const local = combatPositionToDungeonLocal(landed);
        expect(isIndoorNavigationPointWalkable(navigation, local), `${room.id} ${bearing}`).toBe(true);
        expect(isIndoorNavigationSegmentWalkable(navigation, startLocal, local), `${room.id} ${bearing}`).toBe(true);
        if (landed !== to) clamped += 1;
      }
    }
    expect(clamped).toBeGreaterThan(0);
  });

  it("leaves paths outside dungeon rooms alone", () => {
    const from = { lat: 35, lon: -106 };
    const to = { lat: 35.001, lon: -106 };
    expect(clampPathToDungeonWalls("zone:open", from, to)).toBe(to);
  });

  it("a knockback asks the room for a clear path and shortens until it gets one", () => {
    const calls: Array<{ distance: number; clear: boolean | undefined }> = [];
    const origin = { lat: 35, lon: -106 };
    const engine = new CombatEngine({
      tickRateHz: 20, playerMovementSpeedMps: 40,
      isPlayerAuthorityActive: () => true, isSharedMobCombat: () => true, isMobPlayerAttackAuthorized: () => true,
      repositionPlayer: (_id: string, _target: LatLon, maximum?: number, clear?: boolean) => {
        calls.push({ distance: (maximum ?? 0) - 50, clear });
        return calls.length >= 3;
      }
    } as never);
    engine.connectPlayer({
      playerId: "p1", name: "p1", regionCode: "interior:g", zoneId: "interior:g:r", position: origin, accountId: "a", connectionId: "c",
      profile: { playerId: "p1", maxHealth: 100, currentHealth: 100, baseAttackDamage: 1 }
    });
    expect(engine.knockbackPlayer("p1", destinationPoint(origin, 10, 180), 80)).toBe(true);
    expect(calls.map((call) => call.clear)).toEqual([true, true, true]);
    expect(calls.map((call) => Math.round(call.distance))).toEqual([80, 70, 60]);
    void vi;
  });
});

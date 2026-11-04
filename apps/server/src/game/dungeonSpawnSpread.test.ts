import {
  DUNGEON_CATALOG, dungeonAnchorDefinition, dungeonFormationOffset, isIndoorNavigationPointWalkable,
  isIndoorNavigationSegmentWalkable, type DungeonCatalog, type IndoorPoint
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { DungeonRuntime, separatedSpawnPoint } from "./dungeon.js";

type Internals = {
  prepareWaveSpawns(instance: unknown, definition: unknown, state: unknown, wave: unknown, room: unknown, torchTotal?: number):
    Array<{ placement: { id: string; anchorId: string; randomSpawnZoneId?: string | null; spawnGroupId?: string | null }; spawnPoint: IndoorPoint }>;
  roomNavigation(spaceId: string, dungeon: unknown): Parameters<typeof isIndoorNavigationPointWalkable>[0];
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const catalog = DUNGEON_CATALOG as DungeonCatalog;

function runtimeFor(dungeon: DungeonCatalog["dungeons"][number]): Internals {
  const combat = new Proxy({}, { get: () => vi.fn(() => null) });
  return DungeonRuntime.ephemeral({
    combat: combat as never, dungeon, catalog, runId: "55555555-5555-4555-8555-555555555555", now: () => 1_000
  }) as unknown as Internals;
}

describe("dungeon spawn spread", () => {
  it("every wave plan in every dungeon ends walkable, and a moved spawn is reachable from where it was placed", () => {
    for (const dungeon of catalog.dungeons) {
      const internals = runtimeFor(dungeon);
      for (const definition of dungeon.encounters) {
        if (definition.retired) continue;
        const room = dungeon.rooms.find((candidate) => candidate.id === definition.roomId);
        if (!room) continue;
        const navigation = internals.roomNavigation(room.id, dungeon);
        for (const wave of definition.waves) {
          let plans: ReturnType<Internals["prepareWaveSpawns"]>;
          try {
            plans = internals.prepareWaveSpawns(
              { runId: "run", torchTotal: 99, dungeon }, definition, { spawnedMobIds: new Map() }, wave, room, 99);
          } catch {
            // A placement that cannot spawn at all is the catalog validator's business, not the spread's.
            continue;
          }
          for (const plan of plans) {
            expect(isIndoorNavigationPointWalkable(navigation, plan.spawnPoint),
              `${dungeon.id}/${plan.placement.id} ends on a blocked point`).toBe(true);
            if (plan.placement.randomSpawnZoneId) continue;
            const anchor = dungeonAnchorDefinition(room, plan.placement.anchorId);
            const group = wave.mobSpawnIds.filter((id) =>
              room.mobs.find((candidate) => candidate.id === id)?.spawnGroupId === plan.placement.spawnGroupId);
            const offset = dungeonFormationOffset(definition.groupControls?.formation ?? "scatter",
              Math.max(0, group.indexOf(plan.placement.id)), group.length);
            const base = { x: clamp(anchor.x + offset.x, 0, room.width), y: clamp(anchor.y + offset.y, 0, room.height) };
            if (base.x === plan.spawnPoint.x && base.y === plan.spawnPoint.y) continue;
            expect(isIndoorNavigationSegmentWalkable(navigation, base, plan.spawnPoint),
              `${dungeon.id}/${plan.placement.id} was moved through a wall`).toBe(true);
          }
        }
      }
    }
  });

  it("when a spawn is crowded at any mob anchor in any room, the spread stays walkable, connected and within two rings", () => {
    let spread = 0;
    for (const dungeon of catalog.dungeons) {
      const internals = runtimeFor(dungeon);
      for (const room of dungeon.rooms) {
        const navigation = internals.roomNavigation(room.id, dungeon);
        for (const placement of room.mobs) {
          if (placement.retired) continue;
          const anchor = dungeonAnchorDefinition(room, placement.anchorId);
          const base = { x: anchor.x, y: anchor.y };
          if (!isIndoorNavigationPointWalkable(navigation, base)) continue;
          const result = separatedSpawnPoint(base, [base], navigation, room);
          expect(isIndoorNavigationPointWalkable(navigation, result), `${dungeon.id}/${placement.id}`).toBe(true);
          if (result.x === base.x && result.y === base.y) continue;
          spread += 1;
          expect(Math.hypot(result.x - base.x, result.y - base.y)).toBeLessThanOrEqual(36 * 2 + 1e-6);
          expect(isIndoorNavigationSegmentWalkable(navigation, base, result),
            `${dungeon.id}/${placement.id} was spread through a wall`).toBe(true);
        }
      }
    }
    expect(spread).toBeGreaterThan(0);
  });
});

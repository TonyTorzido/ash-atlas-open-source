import { DUNGEON_CATALOG, portalIds, type DungeonCatalog } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { DungeonRuntime } from "./dungeon.js";

type Internals = {
  instances: Map<string, {
    encounters: Map<string, { state: string; currentWaveId: string | null; spawnedMobIds: Map<string, string> }>;
    bossCredits: Map<string, Set<string>>;
    portalLocks: Map<string, boolean>;
  }>;
  pollEncounters(instanceId: string, instance: unknown, now: number): void;
};

describe("golem forge boss gathering", () => {
  it("credits everyone who walks in before the boss wakes, then seals the entry against late strangers", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    const forge = catalog.dungeons.find((dungeon) => dungeon.id === "golem_forge")!;
    catalog.entrances.push({
      id: "gather-forge", dungeonId: forge.id, revision: "v1", retired: false, name: "Golem Forge", description: "Fixture",
      lat: 35, lon: -106, interactionRadiusM: 8, footprintRadiusM: 5, portalId: "golem_forge_world_to_entrance",
      portalRevision: "v1", interactionLabel: "Enter", presentation: "cave", assetKey: null
    });
    let clock = 1_000_000;
    const spawnMob = vi.fn((input: { entityId: string }) => ({ entityId: input.entityId, lat: 0, lon: 0, maxHealth: 100 }));
    const combat = new Proxy({ spawnMob }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(() => null)
    });
    const runtime = DungeonRuntime.ephemeral({ combat: combat as never, dungeon: forge, catalog,
      runId: "33333333-3333-4333-8333-333333333333", now: () => clock });
    const instanceId = "dungeon:gather-forge";
    const gallery = forge.rooms.find((room) => room.id === "gf_monolith_gallery")!;
    const pen = forge.rooms.find((room) => room.id === "gf_bull_pen")!;
    const at = (room: typeof pen) => room.anchors.find((anchor) => anchor.id === room.spawnAnchorId)!;
    const sessions = new Map<string, string>();
    for (const playerId of ["leader", "follower", "stranger"]) {
      const snapshot = await runtime.enter({ playerId, username: playerId, displayColor: null, movementRevision: 1,
        regionCode: "GLOBAL", position: { lat: 35, lon: -106 } } as never, "gather-forge",
        { spaceId: gallery.id, position: { x: at(gallery).x, y: at(gallery).y }, instanceId, locationType: "dungeon" });
      sessions.set(playerId, snapshot.sessionId);
    }
    const entry = portalIds.dungeon("gather-forge", "quarry_to_boss");
    const walkIn = (playerId: string) => {
      runtime.authorizePortal(playerId, entry);
      runtime.transferSpace(playerId, sessions.get(playerId)!, pen.id, { x: at(pen).x, y: at(pen).y }, entry);
    };
    const internals = runtime as unknown as Internals;
    const instance = internals.instances.get(instanceId)!;
    // Clear the gallery's own fight first (combat reports its mobs gone), which unlocks its doors.
    const galleryFights = forge.encounters.filter((encounter) => encounter.roomId === gallery.id).map((encounter) => encounter.id);
    for (let step = 0; step < 30 && galleryFights.some((id) => instance.encounters.get(id)!.state !== "completed"); step += 1) {
      clock += 10_000;
      internals.pollEncounters(instanceId, instance, clock);
    }
    walkIn("leader");
    const fight = instance.encounters.get("quarry_boss")!;
    // Gathering: the fight is on but the boss is not up and the entry is still open.
    expect(fight.state).toBe("active");
    expect(fight.spawnedMobIds.size).toBe(0);
    expect(instance.portalLocks.get("quarry_to_boss")).not.toBe(true);
    clock += 4_000;
    internals.pollEncounters(instanceId, instance, clock);
    walkIn("follower");
    clock += 5_000;
    internals.pollEncounters(instanceId, instance, clock);
    expect(fight.spawnedMobIds.size).toBe(1);
    expect([...instance.bossCredits.get("quarry_boss")!].sort()).toEqual(["follower", "leader"]);
    expect(instance.portalLocks.get("quarry_to_boss")).toBe(true);
    expect(() => runtime.authorizePortal("stranger", entry)).toThrow(expect.objectContaining({ code: "PORTAL_LOCKED" }));
  });
});

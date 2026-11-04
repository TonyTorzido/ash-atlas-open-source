import { DUNGEON_CATALOG, dungeonObjectSpawnsInRun, type DungeonCatalog } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { DungeonRuntime, GOLEM_FORGE_TRASH_REFILL_MS } from "./dungeon.js";

type Internals = {
  instances: Map<string, {
    encounters: Map<string, { state: string; completedAt?: number; attempts: number }>;
    objectAvailability: Map<string, boolean>;
  }>;
  dispatch(instance: unknown, event: Record<string, unknown>): void;
  pollEncounters(instanceId: string, instance: unknown, now: number): void;
};

describe("golem forge trash refill", () => {
  it("refills a cleared trash room 2 h after its clear, never a boss room", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    const forge = catalog.dungeons.find((dungeon) => dungeon.id === "golem_forge")!;
    catalog.entrances.push({
      id: "refill-forge", dungeonId: forge.id, revision: "refill-forge-v1", retired: false, name: "Golem Forge",
      description: "Fixture only", lat: 35, lon: -106, interactionRadiusM: 8, footprintRadiusM: 5,
      portalId: "golem_forge_world_to_entrance", portalRevision: "portal-v1", interactionLabel: "Enter",
      presentation: "cave", assetKey: null
    });
    let clock = 1_000_000;
    const spawnMob = vi.fn((input: { entityId: string }) => ({ entityId: input.entityId, lat: 0, lon: 0, maxHealth: 100 }));
    const combat = new Proxy({ spawnMob }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(() => null)
    });
    const runtime = DungeonRuntime.ephemeral({ combat: combat as never, dungeon: forge, catalog,
      runId: "11111111-1111-4111-8111-111111111111", now: () => clock });
    const gate = forge.rooms.find((room) => room.id === "gf_forge_gate")!;
    const spawn = gate.anchors.find((anchor) => anchor.id === gate.spawnAnchorId)!;
    const instanceId = "dungeon:refill-forge";
    await runtime.enter({ playerId: "p1", username: "p1", displayColor: null, movementRevision: 1, regionCode: "GLOBAL",
      position: { lat: 35, lon: -106 } } as never, "refill-forge",
      { spaceId: gate.id, position: { x: spawn.x, y: spawn.y }, instanceId, locationType: "dungeon" });
    const internals = runtime as unknown as Internals;
    const instance = internals.instances.get(instanceId)!;
    const gateGolems = instance.encounters.get("gate_golems")!;
    // Combat reports every spawned mob gone, so each poll clears a wave until the encounter completes.
    for (let step = 0; step < 20 && gateGolems.state !== "completed"; step += 1) {
      clock += 10_000;
      internals.pollEncounters(instanceId, instance, clock);
    }
    expect(gateGolems.state).toBe("completed");
    const clearedAt = gateGolems.completedAt!;
    const attempts = gateGolems.attempts;
    const quarry = instance.encounters.get("quarry_boss")!;
    Object.assign(quarry, { state: "completed", completedAt: clearedAt });

    clock = clearedAt + GOLEM_FORGE_TRASH_REFILL_MS - 1;
    internals.pollEncounters(instanceId, instance, clock);
    expect(gateGolems.state).toBe("completed");
    spawnMob.mockClear();
    clock += 1;
    internals.pollEncounters(instanceId, instance, clock);
    // The player is in the room, so the base set comes straight back as a new combat life.
    expect(gateGolems.state).toBe("active");
    expect(gateGolems.attempts).toBe(attempts + 1);
    expect(spawnMob).toHaveBeenCalled();
    expect(quarry.state).toBe("completed");
  });

  it("rolls the slag vault's cracked wall into about 35% of Forge runs, from the run seed", () => {
    const forge = DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === "golem_forge")!;
    const wall = forge.rooms.find((room) => room.id === "gf_slag_yard")!.objects.find((object) => object.id === "cracked_wall")!;
    const runs = Array.from({ length: 4_000 }, (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`);
    const rolled = runs.map((runId) => dungeonObjectSpawnsInRun(forge, runId, "gf_slag_yard", wall));
    expect(rolled.filter(Boolean).length / runs.length).toBeGreaterThan(0.32);
    expect(rolled.filter(Boolean).length / runs.length).toBeLessThan(0.38);
    // The same run always rolls the same way.
    expect(runs.map((runId) => dungeonObjectSpawnsInRun(forge, runId, "gf_slag_yard", wall))).toEqual(rolled);
  });

  it("lights a hub sigil per dead wing boss and opens the north door once both are dead", async () => {
    const forge = DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === "golem_forge")!;
    const combat = new Proxy({}, { get: () => vi.fn(() => null) });
    const crucible = forge.rooms.find((room) => room.id === "gf_crucible")!;
    const spawn = crucible.anchors.find((anchor) => anchor.id === crucible.spawnAnchorId)!;
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    catalog.entrances.push({ id: "sigil-forge", dungeonId: forge.id, revision: "v1", retired: false, name: "F", description: "F",
      lat: 35, lon: -106, interactionRadiusM: 8, footprintRadiusM: 5, portalId: "golem_forge_world_to_entrance",
      portalRevision: "v1", interactionLabel: "Enter", presentation: "cave", assetKey: null });
    const host = DungeonRuntime.ephemeral({ combat: combat as never, dungeon: forge, catalog,
      runId: "22222222-2222-4222-8222-222222222222", now: () => 1 });
    await host.enter({ playerId: "p1", username: "p1", displayColor: null, movementRevision: 1, regionCode: "GLOBAL",
      position: { lat: 35, lon: -106 } } as never, "sigil-forge",
      { spaceId: crucible.id, position: { x: spawn.x, y: spawn.y }, instanceId: "dungeon:sigil-forge", locationType: "dungeon" });
    const hostInternals = host as unknown as Internals;
    const instance = hostInternals.instances.get("dungeon:sigil-forge")!;
    const shown = (objectId: string) => instance.objectAvailability.get(`gf_crucible:${objectId}`) === true;
    expect([shown("quarry_sigil"), shown("conduit_sigil"), shown("forge_door_sealed"), shown("forge_door_open")])
      .toEqual([false, false, true, false]);
    hostInternals.dispatch(instance, { type: "encounter_state", encounterId: "quarry_boss", state: "completed" });
    expect([shown("quarry_sigil"), shown("conduit_sigil"), shown("forge_door_sealed"), shown("forge_door_open")])
      .toEqual([true, false, true, false]);
    hostInternals.dispatch(instance, { type: "encounter_state", encounterId: "conduit_boss", state: "completed" });
    expect([shown("quarry_sigil"), shown("conduit_sigil"), shown("forge_door_sealed"), shown("forge_door_open")])
      .toEqual([true, true, false, true]);
  });
});

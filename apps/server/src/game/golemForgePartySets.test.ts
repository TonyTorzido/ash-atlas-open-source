import { DUNGEON_CATALOG, type DungeonCatalog } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { DungeonRuntime } from "./dungeon.js";

type Encounter = { state: string; spawnedMobIds: Map<string, string> };
type Instance = {
  encounters: Map<string, Encounter>;
  partyEntries: Map<string, { torches: number; rooms: Set<string> }>;
  playerPartyEntries: Map<string, string>;
};
type Internals = {
  instances: Map<string, Instance>;
  pollEncounters(instanceId: string, instance: unknown, now: number): void;
  handlePartyWipe(instance: unknown, definition: unknown, state: unknown, now: number): void;
  spawnPartyTorchSets(instance: unknown, playerId: string, roomId: string): void;
};

/** A Golem Forge host with one player in the Forge Gate; combat reports only `alive` ids as living. */
async function forgeHost(alive: (entityId: string) => boolean, failSpawn: { party: boolean }) {
  const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
  const forge = catalog.dungeons.find((dungeon) => dungeon.id === "golem_forge")!;
  catalog.entrances.push({
    id: "sets-forge", dungeonId: forge.id, revision: "v1", retired: false, name: "Golem Forge", description: "Fixture",
    lat: 35, lon: -106, interactionRadiusM: 8, footprintRadiusM: 5, portalId: "golem_forge_world_to_entrance",
    portalRevision: "v1", interactionLabel: "Enter", presentation: "cave", assetKey: null
  });
  const spawnMob = vi.fn((input: { entityId: string }) => {
    if (failSpawn.party && input.entityId.includes("~party:")) throw new Error("blocked");
    return { entityId: input.entityId, lat: 0, lon: 0, maxHealth: 100 };
  });
  const fake = {
    spawnMob,
    entity: (entityId: string) => alive(entityId) ? { lifeState: "alive", currentHealth: 1, maxHealth: 1, lat: 0, lon: 0 } : null
  };
  const combat = new Proxy(fake, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(() => null) });
  let clock = 1_000_000;
  const runtime = DungeonRuntime.ephemeral({ combat: combat as never, dungeon: forge, catalog,
    runId: "44444444-4444-4444-8444-444444444444", now: () => clock });
  const gate = forge.rooms.find((room) => room.id === "gf_forge_gate")!;
  const spawn = gate.anchors.find((anchor) => anchor.id === gate.spawnAnchorId)!;
  await runtime.enter({ playerId: "p1", username: "p1", displayColor: null, movementRevision: 1, regionCode: "GLOBAL",
    position: { lat: 35, lon: -106 } } as never, "sets-forge",
    { spaceId: gate.id, position: { x: spawn.x, y: spawn.y }, instanceId: "dungeon:sets-forge", locationType: "dungeon" });
  const internals = runtime as unknown as Internals;
  const instance = internals.instances.get("dungeon:sets-forge")!;
  const poll = () => { clock += 10_000; internals.pollEncounters("dungeon:sets-forge", instance, clock); };
  return { forge, internals, instance, poll, spawnMob };
}

describe("golem forge party torch sets", () => {
  it("never lets a party copy's split children hold the base wave open", async () => {
    const { instance, poll } = await forgeHost((id) => id.includes("~split"), { party: false });
    const gate = instance.encounters.get("gate_golems")!;
    expect(gate.state).toBe("active");
    gate.spawnedMobIds.set("gate_golems_roll_s2_w1_g1_m1~party:e1~split1", "living-split-child");
    for (let step = 0; step < 20 && gate.state !== "completed"; step += 1) poll();
    expect(gate.state).toBe("completed");
  });

  it("marks a room done for a party entry only after its sets spawned, and a base wipe keeps party copies", async () => {
    const failSpawn = { party: true };
    const { forge, internals, instance, spawnMob } = await forgeHost(() => false, failSpawn);
    instance.partyEntries.set("e1", { torches: 3, rooms: new Set() });
    instance.playerPartyEntries.set("p1", "e1");
    internals.spawnPartyTorchSets(instance, "p1", "gf_forge_gate");
    expect(instance.partyEntries.get("e1")!.rooms.has("gf_forge_gate")).toBe(false);
    failSpawn.party = false;
    spawnMob.mockClear();
    internals.spawnPartyTorchSets(instance, "p1", "gf_forge_gate");
    expect(instance.partyEntries.get("e1")!.rooms.has("gf_forge_gate")).toBe(true);
    const gate = instance.encounters.get("gate_golems")!;
    const partyIds = () => [...gate.spawnedMobIds.keys()].filter((id) => id.includes("~party:e1"));
    const spawnedCopies = partyIds();
    expect(spawnedCopies.length).toBeGreaterThan(0);
    expect(spawnMob.mock.calls.filter(([input]) => input.entityId.includes("~party:")).length).toBe(spawnedCopies.length);
    const definition = forge.encounters.find((encounter) => encounter.id === "gate_golems")!;
    internals.handlePartyWipe(instance, definition, gate, 2_000_000);
    expect(partyIds()).toEqual(spawnedCopies);
    expect([...gate.spawnedMobIds.keys()].every((id) => id.includes("~party:"))).toBe(true);
  });
});

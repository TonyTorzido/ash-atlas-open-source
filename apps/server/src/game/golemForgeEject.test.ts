import { DUNGEON_CATALOG, dungeonLocalToCombatPosition, portalIds, type DungeonCatalog } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { createCoreBossRuntime } from "./coreBossRuntime.js";
import { DungeonRuntime } from "./dungeon.js";
import { FORGEMASTER } from "./golemForgeBosses.js";

type Internals = {
  instances: Map<string, {
    encounters: Map<string, { state: string; spawnedMobIds: Map<string, string>; nextWaveAt: number | null }>;
    bossCredits: Map<string, Set<string>>;
  }>;
  sessions: Map<string, { spaceId: string; sessionId: string }>;
  pollEncounters(instanceId: string, instance: unknown, now: number): void;
};

type StubEntity = {
  entityId: string; kind: "mob" | "player"; lat: number; lon: number; zoneId: string; regionCode: string;
  maxHealth: number; currentHealth: number; lifeState: "alive" | "defeated"; archetypeKey: string | null;
};

/** A minimal combat engine: entities with positions and health, enough for the boss runtime and the dungeon host. */
function stubCombat() {
  const entities = new Map<string, StubEntity>();
  const methods = {
    spawnMob: vi.fn((input: { entityId?: string; archetype: string; position: { lat: number; lon: number }; zoneId: string; regionCode: string }) => {
      const entityId = input.entityId ?? `stub:${entities.size + 1}:${input.archetype}`;
      const entity: StubEntity = {
        entityId, kind: "mob", lat: input.position.lat, lon: input.position.lon, zoneId: input.zoneId, regionCode: input.regionCode,
        maxHealth: 1_000, currentHealth: 1_000, lifeState: "alive", archetypeKey: input.archetype
      };
      entities.set(entityId, entity);
      return entity;
    }),
    entity: (id: string) => entities.get(id) ?? null,
    despawnMob: (id: string) => { entities.delete(id); },
    leapMobTo: (id: string, position: { lat: number; lon: number }) => {
      const entity = entities.get(id);
      if (!entity) return false;
      entity.lat = position.lat;
      entity.lon = position.lon;
      return true;
    },
    livingSummonedMobIds: () => [] as string[]
  };
  const combat = new Proxy(methods, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(() => null)
  });
  return { combat, entities };
}

async function forgeScenario() {
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    const forge = catalog.dungeons.find((dungeon) => dungeon.id === "golem_forge")!;
    catalog.entrances.push({
      id: "eject-forge", dungeonId: forge.id, revision: "v1", retired: false, name: "Golem Forge", description: "Fixture",
      lat: 35, lon: -106, interactionRadiusM: 8, footprintRadiusM: 5, portalId: "golem_forge_world_to_entrance",
      portalRevision: "v1", interactionLabel: "Enter", presentation: "cave", assetKey: null
    });
    let clock = 1_000_000;
    const { combat, entities } = stubCombat();
    const manager = createCoreBossRuntime(combat as never, 125, () => clock);
    const runtime = DungeonRuntime.ephemeral({ combat: combat as never, dungeon: forge, catalog,
      runId: "44444444-4444-4444-8444-444444444444", now: () => clock, bossEncounters: manager });
    const instanceId = "dungeon:eject-forge";
    const cooling = forge.rooms.find((room) => room.id === "gf_cooling_hall")!;
    const greatForge = forge.rooms.find((room) => room.id === "gf_great_forge")!;
    const anchor = (room: typeof greatForge, id: string) => room.anchors.find((candidate) => candidate.id === id)!;
    const players = ["leader", "follower"];
    for (const playerId of players) {
      const snapshot = await runtime.enter({ playerId, username: playerId, displayColor: null, movementRevision: 1,
        regionCode: "GLOBAL", position: { lat: 35, lon: -106 } } as never, "eject-forge",
        { spaceId: cooling.id, position: { x: anchor(cooling, cooling.spawnAnchorId).x, y: anchor(cooling, cooling.spawnAnchorId).y },
          instanceId, locationType: "dungeon" });
      void snapshot;
    }
    const internals = runtime as unknown as Internals;
    const instance = internals.instances.get(instanceId)!;
    const session = (playerId: string) => internals.sessions.get(playerId)!;
    // The players stand in the middle of the Great Forge for the controller's sake.
    const centre = dungeonLocalToCombatPosition(greatForge.width / 2, greatForge.height / 2);
    const zoneId = `interior:${instanceId}:${greatForge.id}`;
    for (const playerId of players) {
      entities.set(playerId, { entityId: playerId, kind: "player", ...centre, zoneId, regionCode: `interior:${instanceId}`,
        maxHealth: 1_000, currentHealth: 1_000, lifeState: "alive", archetypeKey: null });
    }
    // Clear the Cooling Hall's own fight first (its mobs fall), which unlocks the door to the Forgemaster.
    for (let step = 0; step < 30 && instance.encounters.get("cooling_hall")!.state !== "completed"; step += 1) {
      for (const entity of entities.values()) if (entity.kind === "mob") entity.lifeState = "defeated";
      clock += 10_000;
      internals.pollEncounters(instanceId, instance, clock);
    }
    expect(instance.encounters.get("cooling_hall")!.state).toBe("completed");
    const entry = portalIds.dungeon("eject-forge", "cooling_to_forge");
    const door = anchor(greatForge, "door_s");
    const walkIn = (playerId: string) => {
      runtime.transferSpace(playerId, session(playerId).sessionId, cooling.id,
        { x: anchor(cooling, "door_n").x, y: anchor(cooling, "door_n").y });
      runtime.authorizePortal(playerId, entry);
      runtime.transferSpace(playerId, session(playerId).sessionId, greatForge.id, { x: door.x, y: door.y }, entry);
    };
    const advance = (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        clock += 100;
        manager.tick(clock);
        if (elapsed % 1_000 === 0) internals.pollEncounters(instanceId, instance, clock);
      }
    };
    const fight = () => instance.encounters.get("forgemaster")!;
    const bossHealth = () => {
      const entity = entities.get([...fight().spawnedMobIds.values()][0] ?? "");
      return entity ? { current: entity.currentHealth, max: entity.maxHealth } : null;
    };
    return { runtime, instance, session, walkIn, advance, fight, bossHealth, entities, players, greatForge, internals };
}

describe("golem forge: the Forgemaster's fourth anvil strike", () => {
  it("does not restart the fight on players whose eject is still in flight", async () => {
    const { runtime, session, walkIn, advance, fight, entities, players } = await forgeScenario();
    const hold = vi.spyOn(runtime as unknown as { ejectToRoomNow: () => Promise<void> }, "ejectToRoomNow")
      .mockImplementation(() => new Promise<void>(() => undefined));
    for (const playerId of players) walkIn(playerId);
    advance(10_000);
    const boss = entities.get([...fight().spawnedMobIds.values()][0]!)!;
    boss.currentHealth = 400;
    for (let step = 0; step < 6_000 && fight().state === "active"; step += 1) advance(1_000);
    expect(fight().state).toBe("resetting");
    expect(hold).toHaveBeenCalled();
    // The commit never finishes: the sessions still say they are in the Great Forge, but the room stays idle.
    expect(players.map((playerId) => session(playerId).spaceId)).toEqual(["gf_great_forge", "gf_great_forge"]);
    advance(30_000);
    expect(fight().state).toBe("idle");
    expect(fight().spawnedMobIds.size).toBe(0);
  });

  it("ejects the room to the Crucible, resets the boss to full health, clears the credit list, and a rejoin re-credits", async () => {
    const { instance, session, walkIn, advance, fight, bossHealth, entities, players, greatForge } = await forgeScenario();
    void greatForge;

    // Both walk in during the gathering; the Forgemaster wakes with both credited.
    for (const playerId of players) walkIn(playerId);
    expect(fight().state).toBe("active");
    advance(10_000);
    expect(fight().spawnedMobIds.size).toBe(1);
    expect([...instance.bossCredits.get("forgemaster")!].sort()).toEqual(["follower", "leader"]);
    expect(players.map((playerId) => session(playerId).spaceId)).toEqual([greatForge.id, greatForge.id]);

    // The party hurts it, then lets three hammers reach the anvil.
    const boss = entities.get([...fight().spawnedMobIds.values()][0]!)!;
    boss.currentHealth = 400;
    for (let step = 0; step < 6_000 && fight().state === "active"; step += 1) advance(1_000);
    expect(fight().state).toBe("resetting");
    // The eject goes through an async location commit; let it settle.
    await vi.waitFor(() => expect(players.map((playerId) => session(playerId).spaceId)).toEqual(["gf_crucible", "gf_crucible"]));
    expect(instance.bossCredits.has("forgemaster")).toBe(false);
    expect(bossHealth()).toBeNull();

    // After the reset the boss is up again at full health; a rejoin is credited afresh.
    advance(30_000);
    // Nobody is inside, so the Forgemaster waits: no countdown runs out on an empty room.
    expect(fight().state).toBe("idle");
    expect(fight().spawnedMobIds.size).toBe(0);
    for (const playerId of players) walkIn(playerId);
    advance(10_000);
    expect(fight().spawnedMobIds.size).toBe(1);
    expect(bossHealth()).toEqual({ current: 1_000, max: 1_000 });
    expect([...instance.bossCredits.get("forgemaster")!].sort()).toEqual(["follower", "leader"]);
    expect(FORGEMASTER.strikesToFail).toBe(4);
  });
});

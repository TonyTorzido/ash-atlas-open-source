import { afterEach, describe, expect, it } from "vitest";
import {
  createDevelopmentTestPlayer, DEFAULT_PLAYER_SPEED_MPS, DUNGEON_CATALOG,
  DUNGEON_METERS_PER_COORDINATE, dungeonAnchorDefinition,
  type MobArchetypeKey
} from "@ash-atlas/shared";
import { DungeonPlaytestRuntime } from "./dungeonPlaytestRuntime.js";
import type { CreatePlaytestInput, DungeonPlaytestFrame } from "./dungeonPlaytestContracts.js";

const live: DungeonPlaytestRuntime[] = [];
afterEach(async () => {
  for (const runtime of live.splice(0)) {
    await runtime.dispose();
    // A swallowed fire-and-forget storage failure is still a test failure.
    expect(runtime.storageAttempts).toBe(0);
  }
});

async function create(input: Partial<CreatePlaytestInput> = {}) {
  const runtime = await DungeonPlaytestRuntime.create({ catalog: DUNGEON_CATALOG,
    dungeonId: "cistern_warrens", mode: "full", seed: "reproducible-run", ...input });
  live.push(runtime);
  return runtime;
}

function combatFixture(archetype: MobArchetypeKey = "slime") {
  const catalog = structuredClone(DUNGEON_CATALOG);
  const dungeon = catalog.dungeons.find((entry) => entry.name === "Example - Slime Dungeon Template")!;
  const room = dungeon.rooms[0]!;
  const encounter = dungeon.encounters[0]!;
  const mob = room.mobs[0]!;
  mob.archetype = archetype;
  room.mobs = [mob];
  encounter.waves = [{ id: "wave_1", delayMs: 0, mobSpawnIds: [mob.id] }];
  room.resourceNodes = [{ id: "test_ore", retired: false, anchorId: room.spawnAnchorId,
    resourceType: "ore", minYield: 2, maxYield: 2, respawnSeconds: null, resetOnRun: true,
    available: true, interactionRadius: 82 }];
  return { catalog, dungeon, room, mob };
}

async function until(runtime: DungeonPlaytestRuntime, predicate: (frame: DungeonPlaytestFrame) => boolean, seconds = 90) {
  let frame = runtime.snapshot();
  for (let index = 0; index < seconds * 4 && !predicate(frame); index += 1) frame = await runtime.advance(0.25);
  expect(predicate(frame), JSON.stringify({ lifecycle: frame.lifecycle, player: frame.snapshot.player,
    enemies: frame.snapshot.enemies, log: frame.log.slice(-6) })).toBe(true);
  return frame;
}

describe("isolated production dungeon Play Test", () => {
  it("starts every full run at the exact authored Start arrival, ignoring the edited room", async () => {
    const first = await create({ roomId: "warden_junction" });
    const definition = DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const room = definition.rooms.find((entry) => entry.id === definition.entrance.roomId)!;
    const anchor = dungeonAnchorDefinition(room, definition.entrance.arrivalAnchorId);
    expect(first.snapshot().snapshot).toMatchObject({ spaceId: room.id, player: { x: anchor.x, y: anchor.y } });
    await first.command({ type: "teleport", roomId: "warden_junction" });
    await first.dispose();
    const next = await create({ roomId: "warden_junction", seed: "another-run" });
    expect(next.runId).not.toBe(first.runId);
    expect(next.snapshot().snapshot).toMatchObject({ spaceId: room.id, player: { x: anchor.x, y: anchor.y } });
    expect(next.snapshot().sandbox.inventory).toEqual({});
  });

  it("keeps Quick Room Test explicit and uses the selected room spawn", async () => {
    const runtime = await create({ mode: "room", roomId: "warden_junction" });
    expect(runtime.snapshot()).toMatchObject({ mode: "room", lifecycle: "PLAYING",
      snapshot: { spaceId: "warden_junction", player: { x: 500, y: 800 },
        encounters: expect.arrayContaining([expect.objectContaining({ id: "warden-escorts", state: "active" })]) } });
  });

  it("resolves the ordinary Warrior and actual Axe/Breastplate appearance without boosted stats", async () => {
    const runtime = await create();
    const frame = runtime.snapshot();
    const canonical = createDevelopmentTestPlayer(frame.snapshot.player.playerId);
    expect(frame).toMatchObject({ classId: "warrior", debug: { invulnerable: false, speed: 1, aiEnabled: true },
      appearance: { bodyVariantId: "default", styles: { eyes: "blue-eyes", hair: "viking-hair", beard: "blonde-beard" },
        slots: { melee: { equipmentDefinitionId: "training_axe" }, chest: { equipmentDefinitionId: "breast_plate" } } } });
    expect(canonical.equipment.derivedStats).toMatchObject({ maximumHealth: 100, classRank: 0, weaponItemLevel: 0 });
    expect(frame.snapshot.player).toMatchObject({ currentHealth: 100, maxHealth: 100,
      movementSpeed: DEFAULT_PLAYER_SPEED_MPS / DUNGEON_METERS_PER_COORDINATE * 0.9 });
    expect(frame.combatEntities.find((entity) => entity.kind === "player")?.classCombat?.activeClassId).toBe("warrior");
  });

  it("uses canonical collision, fixed simulation steps, pause, and speed without touching authored data", async () => {
    const source = structuredClone(DUNGEON_CATALOG);
    const original = structuredClone(source);
    const runtime = await create({ catalog: source });
    await expect(runtime.command({ type: "move", x: 0, y: 0 })).rejects.toThrow();
    await runtime.command({ type: "move", x: 800, y: 200 });
    const start = runtime.snapshot();
    await runtime.command({ type: "debug", paused: true });
    await runtime.advance(1);
    expect(runtime.snapshot().snapshot.player.x).toBe(start.snapshot.player.x);
    expect(runtime.snapshot().snapshot.serverTime).toBe(start.snapshot.serverTime);
    await runtime.command({ type: "debug", paused: false, speed: 2 });
    const advanced = await runtime.advance(0.25);
    expect(advanced.snapshot.serverTime - start.snapshot.serverTime).toBe(500);
    expect(advanced.snapshot.player.x - start.snapshot.player.x)
      .toBeCloseTo(start.snapshot.player.movementSpeed * 0.5, 5);
    expect(source).toEqual(original);
  });

  it("rejects a blocked final formation position before spawning an encounter wave", async () => {
    const fixture = combatFixture();
    const secondMob = { ...fixture.mob, id: "slime_two" };
    fixture.room.mobs.push(secondMob);
    fixture.dungeon.encounters[0]!.waves[0]!.mobSpawnIds.push(secondMob.id);
    fixture.dungeon.encounters[0]!.groupControls = { formation: "line", linkedAggro: false };
    fixture.room.colliders.push({
      id: "formation_blocker", retired: false, kind: "rectangle", x: 560, y: 350, width: 20, height: 100
    });
    await expect(DungeonPlaytestRuntime.create({
      catalog: fixture.catalog, dungeonId: fixture.dungeon.id, mode: "room", roomId: fixture.room.id, seed: "blocked-formation"
    })).rejects.toMatchObject({ code: "SPAWN_POSITION_BLOCKED" });
  });

  it("rejects an encounter with multiple non-summoned boss placements", async () => {
    const fixture = combatFixture();
    const secondMob = { ...fixture.mob, id: "slime_two" };
    fixture.room.mobs.push(secondMob);
    fixture.dungeon.encounters[0]!.waves[0]!.mobSpawnIds.push(secondMob.id);
    fixture.dungeon.encounters[0]!.bossTemplateId = "sewer-rat-miniboss";
    await expect(DungeonPlaytestRuntime.create({
      catalog: fixture.catalog, dungeonId: fixture.dungeon.id, mode: "room", roomId: fixture.room.id, seed: "ambiguous-boss"
    })).rejects.toMatchObject({ code: "AMBIGUOUS_BOSS_PLACEMENT" });
  });

  it("uses the universal coordinator for approach, threshold, exact arrival, cancellation, and same-instance traversal", async () => {
    const runtime = await create();
    const initial = runtime.snapshot();
    const planned = await runtime.command({ type: "portal", portalId: "hatch-to-overflow" });
    expect(planned.snapshot.spaceId).toBe("hatch_landing");
    expect(planned.portalMessages.some((message) => message.type === "PORTAL_TRANSITION_PLANNED")).toBe(true);
    await runtime.command({ type: "move", x: 300, y: 300 });
    await runtime.advance(1);
    expect(runtime.snapshot().snapshot.spaceId).toBe("hatch_landing");
    await runtime.command({ type: "portal", portalId: "hatch-to-overflow" });
    const entered = await until(runtime, (frame) => frame.snapshot.spaceId === "overflow_channel");
    expect(entered.snapshot.instanceId).toBe(initial.snapshot.instanceId);
    expect(entered.snapshot.sessionId).toBe(initial.snapshot.sessionId);
    const definition = DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const portal = definition.portals.find((entry) => entry.id === "hatch-to-overflow")!;
    const arrival = dungeonAnchorDefinition(definition.rooms.find((entry) => entry.id === "overflow_channel")!, portal.destinationArrivalAnchorId!);
    expect(entered.snapshot.player).toMatchObject({ x: arrival.x, y: arrival.y, currentHealth: 100 });
    expect(entered.portalMessages.some((message) => message.type === "PLAYER_LOCATION_SNAPSHOT")).toBe(true);
  });

  it("uses the simulation clock for authored room timers and restarts their trigger state", async () => {
    const fixture = combatFixture();
    const chest = fixture.room.objects.find((object) => object.type === "chest")!;
    fixture.dungeon.triggers.push({ id: "room-timer", retired: false, enabled: true,
      scope: "instance", repetition: "once", cooldownMs: 0, event: { type: "timer", delayMs: 1_000 },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "set_object_state", roomId: fixture.room.id, objectId: chest.id, state: "open" }] });
    const runtime = await create({ catalog: fixture.catalog, dungeonId: fixture.dungeon.id });
    await runtime.command({ type: "debug", paused: true });
    await runtime.advance(1);
    expect(runtime.snapshot().snapshot.objects.find((object) => object.id === chest.id)?.state).toBe("closed");
    await runtime.command({ type: "debug", paused: false, speed: 2 });
    await runtime.advance(0.5);
    expect(runtime.snapshot().snapshot.objects.find((object) => object.id === chest.id)?.state).toBe("open");
    await runtime.command({ type: "restart_room" });
    expect(runtime.snapshot().snapshot.objects.find((object) => object.id === chest.id)?.state).toBe("closed");
    await runtime.advance(0.5);
    expect(runtime.snapshot().snapshot.objects.find((object) => object.id === chest.id)?.state).toBe("open");
  });

  it("attacks through real range/approach/cadence, damages a mob, and emits equipped-weapon combat actions", async () => {
    const fixture = combatFixture();
    const runtime = await create({ catalog: fixture.catalog, dungeonId: fixture.dungeon.id });
    await runtime.command({ type: "debug", aiEnabled: false });
    const enemy = runtime.snapshot().snapshot.enemies[0]!;
    expect(enemy).toBeDefined();
    await runtime.command({ type: "attack", targetEntityId: enemy.entityId });
    const tooFar = await runtime.advance(0.05);
    expect(tooFar.snapshot.enemies[0]!.currentHealth).toBe(enemy.maxHealth);
    const damaged = await until(runtime, (frame) => frame.snapshot.enemies.some((entry) => entry.currentHealth < enemy.maxHealth));
    expect(damaged.events.some((event) => event.type === "DAMAGE" || event.type === "ATTACK_LANDED")).toBe(true);
    expect(damaged.combatEntities.find((entity) => entity.kind === "player")?.classCombat?.weaponMode).toBeDefined();
  });

  it("applies exactly 1,000 scripted damage through normal enemy defeat while paused", async () => {
    const fixture = combatFixture();
    const runtime = await create({ catalog: fixture.catalog, dungeonId: fixture.dungeon.id });
    const enemy = runtime.snapshot().snapshot.enemies[0]!;
    await runtime.command({ type: "debug", paused: true });
    const defeated = await runtime.command({ type: "damage", targetEntityId: enemy.entityId, amount: 1000 });
    expect(defeated.snapshot.enemies).toEqual([]);
    expect(defeated.snapshot.completed).toBe(true);
    expect(defeated.log).toContain("Dealt 1,000 damage to Slime (debug).");
    await expect(runtime.command({ type: "damage", targetEntityId: enemy.entityId, amount: 1000 })).rejects.toThrow(/no longer alive/);
  });

  it("allows actual enemy AI/attacks to damage and kill the player; invulnerability is explicit", async () => {
    const fixture = combatFixture("wolf");
    const runtime = await create({ catalog: fixture.catalog, dungeonId: fixture.dungeon.id });
    const enemy = runtime.snapshot().snapshot.enemies[0]!;
    await runtime.command({ type: "move", x: enemy.x + 10, y: enemy.y });
    const damaged = await until(runtime, (frame) => frame.snapshot.player.currentHealth < 100, 120);
    expect(damaged.events.some((event) => event.type === "DAMAGE")).toBe(true);
    await runtime.command({ type: "debug", invulnerable: true });
    await runtime.command({ type: "heal" });
    for (let index = 0; index < 40; index += 1) await runtime.advance(0.25);
    expect(runtime.snapshot().snapshot.player.currentHealth).toBe(100);
    await runtime.command({ type: "debug", invulnerable: false });
    const dead = await until(runtime, (frame) => frame.lifecycle === "PLAYER_DEAD", 240);
    expect(dead.snapshot.player.currentHealth).toBe(0);
    await expect(runtime.command({ type: "move", x: 500, y: 500 })).rejects.toThrow(/dead/);
    await runtime.command({ type: "restart_room" });
    expect(runtime.snapshot()).toMatchObject({ lifecycle: "PLAYING", snapshot: { player: { currentHealth: 100 } } });
    expect(runtime.snapshot().snapshot.enemies).toHaveLength(1);
  });

  it("real kills unlock the authored exit, reveal loot, complete the dungeon, and restore clean room state", async () => {
    const fixture = combatFixture();
    const original = structuredClone(fixture.catalog);
    const runtime = await create({ catalog: fixture.catalog, dungeonId: fixture.dungeon.id });
    const enemy = runtime.snapshot().snapshot.enemies[0]!;
    expect(runtime.snapshot().snapshot.objects.find((entry) => entry.kind === "chest")?.available).toBe(false);
    await expect(runtime.command({ type: "portal", portalId: fixture.dungeon.escape.portalId })).rejects.toThrow(/locked/);
    await runtime.command({ type: "debug", invulnerable: true });
    await runtime.command({ type: "attack", targetEntityId: enemy.entityId });
    const complete = await until(runtime, (frame) => frame.snapshot.completed);
    expect(complete.lifecycle).toBe("DUNGEON_COMPLETED");
    await runtime.command({ type: "debug", paused: true });
    const paused = await runtime.advance(1);
    expect(paused.lifecycle).toBe("DEBUG_PAUSED");
    expect(paused.snapshot.serverTime).toBe(complete.snapshot.serverTime);
    expect((await runtime.command({ type: "debug", paused: false })).lifecycle).toBe("DUNGEON_COMPLETED");
    const chest = complete.snapshot.objects.find((entry) => entry.kind === "chest")!;
    expect(chest.available).toBe(true);
    expect(Object.values(complete.snapshot.portalLocks)).not.toContain(true);
    await runtime.command({ type: "interact", objectId: chest.id });
    const looted = await until(runtime, (frame) => frame.log.some((entry) => entry.startsWith("Reward:")));
    const rewards = structuredClone(looted.sandbox);
    await runtime.command({ type: "interact", objectId: chest.id });
    expect(runtime.snapshot().sandbox).toEqual(rewards);
    await runtime.command({ type: "harvest", resourceId: "test_ore" });
    // Dungeon nodes follow the overworld harvest rule (one unit); catalog minYield/maxYield are ignored in-game.
    await until(runtime, (frame) => frame.sandbox.inventory.ore === 1);
    expect(runtime.snapshot().snapshot.resources?.[0]?.state).toBe("depleted");
    await runtime.command({ type: "restart_room" });
    const reset = runtime.snapshot();
    expect(reset.snapshot.enemies).toHaveLength(1);
    expect(reset.snapshot.enemies[0]!.currentHealth).toBe(reset.snapshot.enemies[0]!.maxHealth);
    expect(reset.snapshot.completed).toBe(false);
    expect(reset.snapshot.resources?.[0]?.state).toBe("available");
    expect(reset.snapshot.objects.find((entry) => entry.kind === "chest")?.available).toBe(false);
    expect(fixture.catalog).toEqual(original);
    await runtime.command({ type: "kill_room" });
    await runtime.command({ type: "portal", portalId: fixture.dungeon.escape.portalId });
    await until(runtime, (frame) => frame.sandbox.exited);
    await expect(runtime.command({ type: "restart_room" })).rejects.toThrow(/exited/);
    await expect(runtime.command({ type: "heal" })).rejects.toThrow(/exited/);
    expect(runtime.storageAttempts).toBe(0);
  });

  it("keeps canonical ground loot on the floor until an in-range pickup and prevents duplicate grants", async () => {
    const fixture = combatFixture("lightning_bird");
    const runtime = await create({ catalog: fixture.catalog, dungeonId: fixture.dungeon.id });
    await runtime.command({ type: "kill_room" });
    const dropped = runtime.snapshot();
    const feather = dropped.drops.find((drop) => drop.itemId === "tempest_quill")!;
    expect(feather).toMatchObject({ status: "active", quantity: 1 });
    expect(dropped.sandbox.inventory.tempest_quill).toBeUndefined();
    expect(feather.zoneId).toBe(`interior:${dropped.snapshot.instanceId}:${dropped.snapshot.spaceId}`);
    await runtime.command({ type: "pickup", dropId: feather.dropId });
    const pickedUp = await until(runtime, (frame) => frame.drops.some((drop) => drop.dropId === feather.dropId && drop.status === "picked_up"));
    expect(pickedUp.sandbox.inventory.tempest_quill).toBe(1);
    await expect(runtime.command({ type: "pickup", dropId: feather.dropId })).rejects.toThrow(/no longer exists/);
    expect(runtime.snapshot().sandbox.inventory.tempest_quill).toBe(1);
    await runtime.command({ type: "restart_room" });
    expect(runtime.snapshot().drops).toEqual([]);
    const next = await create({ catalog: fixture.catalog, dungeonId: fixture.dungeon.id });
    expect(next.snapshot().drops).toEqual([]);
    expect(next.snapshot().sandbox.inventory).toEqual({});
  });

  it("ends an incomplete authored exit explicitly and cannot resume exited gameplay", async () => {
    const runtime = await create();
    const definition = DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    await runtime.command({ type: "portal", portalId: definition.escape.portalId });
    const exited = await until(runtime, (frame) => frame.sandbox.exited);
    expect(exited.lifecycle).toBe("RUN_EXITED");
    const stopped = await runtime.advance(1);
    expect(stopped.snapshot.serverTime).toBe(exited.snapshot.serverTime);
    await expect(runtime.command({ type: "attack", targetEntityId: "missing" })).rejects.toThrow(/exited/);
  });

  it("reproduces health-threshold summons and fresh runs with the same seed", async () => {
    const template = DUNGEON_CATALOG.dungeons.find((entry) => entry.name === "Example - Slime Dungeon Template")!;
    const first = await create({ dungeonId: template.id });
    const second = await create({ dungeonId: template.id });
    async function summon(runtime: DungeonPlaytestRuntime) {
      await runtime.command({ type: "debug", invulnerable: true });
      await runtime.command({ type: "attack", targetEntityId: runtime.snapshot().snapshot.enemies[0]!.entityId });
      return until(runtime, (frame) => frame.snapshot.enemies.filter((enemy) => enemy.archetype === "slime").length === 3, 180);
    }
    const a = await summon(first);
    const b = await summon(second);
    expect(a.snapshot.enemies.map(({ spawnId, x, y, currentHealth }) => ({ spawnId, x, y, currentHealth })))
      .toEqual(b.snapshot.enemies.map(({ spawnId, x, y, currentHealth }) => ({ spawnId, x, y, currentHealth })));
    await first.dispose();
    const fresh = await create({ dungeonId: template.id });
    expect(fresh.snapshot().snapshot.enemies).toHaveLength(1);
    expect(fresh.snapshot().snapshot.enemies[0]!.currentHealth).toBe(fresh.snapshot().snapshot.enemies[0]!.maxHealth);
    expect(fresh.snapshot().snapshot.player.currentHealth).toBe(100);
    expect(fresh.snapshot().sandbox.inventory).toEqual({});
    await expect(first.advance(0.1)).rejects.toThrow(/stopped/);
  });
});

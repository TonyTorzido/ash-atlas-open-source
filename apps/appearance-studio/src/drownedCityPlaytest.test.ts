import { afterEach, describe, expect, it } from "vitest";
import { DUNGEON_CATALOG } from "@ash-atlas/shared";

import { DungeonPlaytestRuntime } from "./dungeonPlaytestRuntime.js";
import type { DungeonPlaytestFrame } from "./dungeonPlaytestContracts.js";

/** Drowned City wings on the real dungeon, combat and boss services (docs/design/DROWNED_CITY_SPEC.md, build slice 2). */
const DROWNED_CITY = DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === "drowned_city")!;
const live: DungeonPlaytestRuntime[] = [];
afterEach(async () => {
  for (const runtime of live.splice(0)) {
    await runtime.dispose();
    expect(runtime.storageAttempts).toBe(0);
  }
});

async function create(seed = "drowned-city") {
  const runtime = await DungeonPlaytestRuntime.create({ catalog: DUNGEON_CATALOG, dungeonId: "drowned_city", mode: "full", seed });
  live.push(runtime);
  await runtime.command({ type: "debug", invulnerable: true });
  return runtime;
}

/** Kills everything in the room (adds included) until its encounters complete. */
async function clearRoom(runtime: DungeonPlaytestRuntime, rounds = 40): Promise<DungeonPlaytestFrame> {
  let frame = runtime.snapshot();
  for (let round = 0; round < rounds; round += 1) {
    const room = frame.snapshot.spaceId;
    const ids = new Set(DROWNED_CITY.encounters.filter((encounter) => encounter.roomId === room).map((encounter) => encounter.id));
    if (frame.snapshot.encounters.filter((encounter) => ids.has(encounter.id)).every((encounter) => encounter.state === "completed") &&
        !frame.snapshot.enemies.some((enemy) => enemy.lifeState === "alive")) return frame;
    if (frame.snapshot.enemies.some((enemy) => enemy.lifeState === "alive")) await runtime.command({ type: "kill_room" });
    frame = await runtime.advance(1);
  }
  return frame;
}

const object = (frame: DungeonPlaytestFrame, id: string) => frame.snapshot.objects.find((entry) => entry.id === id);

describe("Drowned City wings (Play Test host)", () => {
  it("opens the rift on the Gate Warden, lets citizens be, and raises the floodgate on both past switches", async () => {
    const runtime = await create();
    await runtime.command({ type: "teleport", roomId: "dc_obs_warden_hall" });
    let frame = await runtime.advance(0.5);
    expect(object(frame, "obs_time_rift")?.state).toBe("closed");
    expect(object(frame, "obs_floodgate")?.state).toBe("closed");
    const rift = object(frame, "obs_rift_object");
    expect(rift?.available).toBe(false);
    frame = await clearRoom(runtime);
    expect(frame.snapshot.encounters.find((encounter) => encounter.id === "obs_warden")?.state).toBe("completed");
    expect(object(frame, "obs_time_rift")?.state).toBe("open");
    expect(object(frame, "obs_rift_object")?.available).toBe(true);

    // The past: chrono wisps fall while the citizens (objects, not mobs) stay; the clear is not blocked.
    await runtime.command({ type: "portal", portalId: object(frame, "obs_rift_object")!.portalId! });
    frame = await advanceBy(runtime, 10);
    expect(frame.snapshot.spaceId).toBe("dc_obs_past_street");
    frame = await clearRoom(runtime);
    expect(frame.snapshot.encounters.find((encounter) => encounter.id === "obs_past_wisps")?.state).toBe("completed");
    expect(frame.snapshot.objects.filter((entry) => entry.kind === "npc").map((entry) => entry.id).sort()).toEqual(["obs_citizen_1", "obs_citizen_2"]);
    expect(frame.snapshot.enemies.every((enemy) => enemy.archetype === "chrono_wisp")).toBe(true);
    await runtime.command({ type: "interact", objectId: "obs_switch_1" });
    frame = await advanceBy(runtime, 8);
    expect(object(frame, "obs_switch_1")?.state).toBe("on");

    // One switch is not enough.
    await runtime.command({ type: "teleport", roomId: "dc_obs_warden_hall" });
    frame = await runtime.advance(0.25);
    expect(object(frame, "obs_floodgate")?.state).toBe("closed");
    expect(object(frame, "obs_floodgate_object")?.available).toBe(false);

    await runtime.command({ type: "teleport", roomId: "dc_obs_past_square" });
    frame = await clearRoom(runtime);
    await runtime.command({ type: "interact", objectId: "obs_switch_2" });
    frame = await advanceBy(runtime, 8);
    expect(object(frame, "obs_switch_2")?.state).toBe("on");
    await runtime.command({ type: "teleport", roomId: "dc_obs_warden_hall" });
    frame = await runtime.advance(0.25);
    expect(object(frame, "obs_floodgate")?.state).toBe("open");
    expect(object(frame, "obs_floodgate_object")?.available).toBe(true);
  }, 120_000);

  it("the Watcher's wing chest pays two orbs and 1,500 gold once per player per run, and lights its hub third", async () => {
    const runtime = await create("drowned-city-watcher");
    await runtime.command({ type: "teleport", roomId: "dc_obs_boss" });
    let frame = await advanceBy(runtime, 2);
    expect(object(frame, "obs_chest")?.available).toBe(false);
    frame = await clearRoom(runtime, 80);
    expect(frame.snapshot.encounters.find((encounter) => encounter.id === "obs_boss")?.state).toBe("completed");
    expect(object(frame, "obs_chest")?.available).toBe(true);
    const before = { gold: frame.sandbox.gold, orbs: frame.sandbox.inventory.abyssal_orb ?? 0 };
    await runtime.command({ type: "interact", objectId: "obs_chest" });
    frame = await advanceBy(runtime, 8);
    expect(frame.sandbox.gold - before.gold).toBe(1_500);
    expect((frame.sandbox.inventory.abyssal_orb ?? 0) - before.orbs).toBe(2);
    await runtime.command({ type: "interact", objectId: "obs_chest" });
    frame = await advanceBy(runtime, 8);
    frame = await runtime.advance(0.5);
    expect(frame.sandbox.gold - before.gold).toBe(1_500);
    expect((frame.sandbox.inventory.abyssal_orb ?? 0) - before.orbs).toBe(2);
    await runtime.command({ type: "teleport", roomId: "dc_circle_of_tides" });
    frame = await runtime.advance(0.25);
    expect(object(frame, "tide_circle_west_lit")?.available).toBe(true);
    expect(object(frame, "tide_circle_north_lit")?.available).toBe(false);
    expect(object(frame, "abyssal_gate_art")?.state).toBe("closed");
  }, 120_000);

  it("walks the front door into the hub and beats the Drowned Admiral through all three weapon phases", async () => {
    const runtime = await create("drowned-city-admiral");
    let frame = runtime.snapshot();
    expect(frame.snapshot.spaceId).toBe("dc_sunken_stair");
    // Front door: stair -> causeway -> plaza -> hub through the authored doors.
    for (const [doorObject, next] of [["stair_to_causeway_object", "dc_drowned_causeway"], ["causeway_to_plaza_object", "dc_flooded_plaza"],
      ["plaza_to_tides_object", "dc_circle_of_tides"]] as const) {
      frame = await clearRoom(runtime);
      frame = await walkTo(runtime, object(frame, doorObject)!);
      await runtime.command({ type: "portal", portalId: object(frame, doorObject)!.portalId! });
      frame = await advanceBy(runtime, 12);
      expect(frame.snapshot.spaceId).toBe(next);
    }
    expect(object(frame, "tides_to_sanctum_object")?.available).toBe(false);
    await runtime.command({ type: "teleport", roomId: "dc_harbor_boss" });
    frame = await advanceBy(runtime, 2);
    frame = await clearRoom(runtime, 80);
    expect(frame.snapshot.encounters.find((encounter) => encounter.id === "harbor_boss")?.state).toBe("completed");
    expect(object(frame, "harbor_chest")?.available).toBe(true);
    await runtime.command({ type: "teleport", roomId: "dc_circle_of_tides" });
    frame = await runtime.advance(0.25);
    expect(object(frame, "tide_circle_east_lit")?.available).toBe(true);
  }, 120_000);

  it("a missed ritual ejects the sanctum to the hub and the Abyssal One returns at full health", async () => {
    const runtime = await create("drowned-city-ritual");
    await runtime.command({ type: "teleport", roomId: "dc_abyssal_sanctum" });
    let frame = await advanceBy(runtime, 3);
    const boss = frame.snapshot.enemies.find((enemy) => enemy.archetype === "abyssal_one" && enemy.lifeState === "alive")!;
    expect(boss).toBeDefined();
    await runtime.command({ type: "damage", targetEntityId: boss.entityId, amount: 1000 });
    frame = await advanceBy(runtime, 2);
    expect(frame.snapshot.enemies.filter((enemy) => enemy.archetype === "abyssal_cultist" && enemy.lifeState === "alive")).toHaveLength(3);
    frame = await advanceBy(runtime, 50);
    expect(frame.snapshot.spaceId).toBe("dc_circle_of_tides");
    frame = await advanceBy(runtime, 5);
    await runtime.command({ type: "teleport", roomId: "dc_abyssal_sanctum" });
    frame = await advanceBy(runtime, 1);
    const again = frame.combatEntities.find((entity) => entity.archetypeKey === "abyssal_one" && entity.lifeState === "alive")!;
    expect(again).toBeDefined();
    expect(again.currentHealth).toBe(again.maxHealth);
    expect(frame.combatEntities.some((entity) => entity.archetypeKey === "abyssal_cultist" && entity.lifeState === "alive")).toBe(false);
  }, 120_000);

  it("a replayed bomb plant does not apply twice", async () => {
    const runtime = await create("drowned-city-bombs");
    await runtime.command({ type: "teleport", roomId: "dc_abyssal_sanctum" });
    let frame = await advanceBy(runtime, 10);
    const bomb = frame.snapshot.objects.find((entry) => entry.id.startsWith("tide_bomb_") && entry.available)!;
    expect(bomb).toBeDefined();
    const dungeon = (runtime as unknown as { dungeon: { interact(p: string, s: string, o: string, r: string): unknown } }).dungeon;
    const player = "studio-test-player";
    frame = await walkTo(runtime, bomb);
    dungeon.interact(player, frame.snapshot.sessionId, bomb.id, "pickup-1");
    dungeon.interact(player, frame.snapshot.sessionId, bomb.id, "pickup-1");
    const arm = object(frame, "abyssal_arm_sw")!;
    frame = await walkTo(runtime, arm);
    dungeon.interact(player, frame.snapshot.sessionId, arm.id, "plant-1");
    dungeon.interact(player, frame.snapshot.sessionId, arm.id, "plant-1");
    expect(() => dungeon.interact(player, frame.snapshot.sessionId, "abyssal_arm_nw", "plant-1")).toThrow();
    frame = await runtime.advance(0.25);
    expect(frame.snapshot.objects.filter((entry) => entry.id.startsWith("abyssal_arm_") && entry.state === "destroyed").map((entry) => entry.id))
      .toEqual(["abyssal_arm_sw"]);
  }, 120_000);

  it("a full run grants 10 Abyssal Orbs: two from each wing boss and four from the sanctum", async () => {
    const runtime = await create("drowned-city-full");
    let frame = runtime.snapshot();
    const start = frame.sandbox.inventory.abyssal_orb ?? 0;
    for (const [room, encounter, chest] of [["dc_obs_boss", "obs_boss", "obs_chest"], ["dc_kelp_boss", "kelp_boss", "kelp_chest"],
      ["dc_harbor_boss", "harbor_boss", "harbor_chest"], ["dc_abyssal_sanctum", "abyssal_one", "sanctum_chest"]] as const) {
      await runtime.command({ type: "teleport", roomId: room });
      frame = await advanceBy(runtime, 2);
      frame = await clearRoom(runtime, 120);
      expect(frame.snapshot.encounters.find((entry) => entry.id === encounter)?.state, room).toBe("completed");
      await runtime.command({ type: "interact", objectId: chest });
      frame = await advanceBy(runtime, 10);
    }
    expect((frame.sandbox.inventory.abyssal_orb ?? 0) - start).toBe(10);
    expect(frame.snapshot.completed).toBe(true);
  }, 180_000);
});

async function advanceBy(runtime: DungeonPlaytestRuntime, seconds: number): Promise<DungeonPlaytestFrame> {
  let frame = runtime.snapshot();
  for (let left = seconds; left > 0; left -= 1) frame = await runtime.advance(Math.min(1, left));
  return frame;
}

/** Walks in short legs (a single move order is capped at the indoor max target distance). */
async function walkTo(runtime: DungeonPlaytestRuntime, target: Readonly<{ x: number; y: number }>): Promise<DungeonPlaytestFrame> {
  let frame = runtime.snapshot();
  for (let leg = 0; leg < 20; leg += 1) {
    const { x, y } = frame.snapshot.player;
    const distance = Math.hypot(target.x - x, target.y - y);
    if (distance < 120) return frame;
    const step = Math.min(250, distance - 100) / distance;
    await runtime.command({ type: "move", x: x + (target.x - x) * step, y: y + (target.y - y) * step });
    frame = await advanceBy(runtime, 3);
  }
  return frame;
}

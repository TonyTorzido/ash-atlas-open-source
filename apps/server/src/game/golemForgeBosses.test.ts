import { describe, expect, it } from "vitest";
import { destinationPoint, distanceMeters, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter, type BossRoomHooks } from "./bossFramework.js";
import {
  createForgemasterController, createGraniteBullController, FORGEMASTER, GRANITE_BULL, GRANITE_BULL_ABILITIES
} from "./golemForgeBosses.js";

const origin: LatLon = { lat: 0.01, lon: 0.01 };

function roomHooks() {
  const states = new Map<string, string>();
  const notices: string[] = [];
  const room: BossRoomHooks = {
    objectAvailable: () => true,
    objectState: (id) => states.get(id) ?? "intact",
    setObjectAvailable: () => undefined,
    setObjectState: (id, state) => { states.set(id, state); },
    notify: (_player, text) => { notices.push(text); }
  };
  return { room, states, notices };
}

type Mob = { archetype: MobArchetypeKey; position: LatLon; scripted: boolean };

function mobWorld() {
  const mobs = new Map<string, Mob>();
  const despawned: string[] = [];
  let next = 0;
  return {
    mobs, despawned,
    spawn: (archetype: MobArchetypeKey, position: LatLon, scripted: boolean) => {
      const id = `m${++next}`;
      mobs.set(id, { archetype, position, scripted });
      return id;
    },
    despawn: (ids: readonly string[]) => { for (const id of ids) { mobs.delete(id); despawned.push(id); } },
    of: (archetype: MobArchetypeKey) => [...mobs].filter(([, mob]) => mob.archetype === archetype).map(([id]) => id)
  };
}

function bullHarness(options: { players?: readonly LatLon[]; ratio?: number } = {}) {
  const { room, states, notices } = roomHooks();
  const world = mobWorld();
  const state = {
    now: 1_000,
    ratio: options.ratio ?? 1,
    players: options.players ?? [destinationPoint(origin, 200, 90)],
    healed: 0,
    bossMoves: [] as LatLon[]
  };
  // NE monolith sits on the east line through the boss; the rest are well off it.
  const anchors = new Map<string, LatLon>([
    ["monolith_ne_anchor", destinationPoint(origin, 420, 90)],
    ["monolith_nw_anchor", destinationPoint(origin, 420, 0)],
    ["monolith_sw_anchor", destinationPoint(origin, 420, 270)],
    ["door_e", destinationPoint(origin, 450, 135)]
  ]);
  const ids = state.players.map((_, index) => `p${index + 1}`);
  const encounter = new BossEncounter({
    encounterId: "enc",
    definition: { id: "granite_bull", revision: 1, archetypeKey: "granite_bull", controllerId: "granite_bull", rewardPolicy: { id: "x", minimumContribution: 1 } },
    host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "gf_bull_pen", encounterId: "e", participantIds: ids, room }),
    mobEntityId: "boss",
    controller: createGraniteBullController({
      bossHealthRatio: () => state.ratio,
      bossPosition: () => origin,
      playerPosition: (id) => state.players[ids.indexOf(id)] ?? null,
      anchorPosition: (_boss, anchorId) => anchors.get(anchorId) ?? null,
      spawnScriptedMob: (_boss, archetype, position) => world.spawn(archetype, position, true),
      mobPosition: (id) => world.mobs.get(id)?.position ?? null,
      moveMobTo: (id, position) => { const mob = world.mobs.get(id); if (mob) mob.position = position; return mob !== undefined; },
      moveBossTo: (_boss, position) => { state.bossMoves.push(position); return true; },
      healBoss: (_boss, amount) => { state.healed += amount; },
      isAlive: (id) => world.mobs.has(id),
      despawn: world.despawn,
      random: () => 0
    }),
    initialState: "active",
    positionOfEntity: (id) => state.players[ids.indexOf(id)] ?? null,
    now: () => state.now
  });
  const tick = (ms: number) => { state.now += ms; encounter.tick(state.now); };
  const tickFor = (ms: number, stepMs = 100) => { for (let elapsed = 0; elapsed < ms; elapsed += stepMs) tick(stepMs); };
  return { encounter, state, states, notices, world, tick, tickFor, anchors };
}

describe("Granite Bull", () => {
  it("starts with every monolith standing and heals 30% of each hit per standing monolith", () => {
    const h = bullHarness();
    h.encounter.activate();
    expect(h.encounter.phase).toBe("monoliths_3");
    h.encounter.notifyDamage(100, "p1");
    expect(h.state.healed).toBe(90);
    h.states.set("healer_monolith_nw", "destroyed");
    h.encounter.notifyDamage(100, "p1");
    expect(h.state.healed).toBe(90 + 60);
    for (const monolith of GRANITE_BULL.monoliths) h.states.set(monolith.objectId, "destroyed");
    h.encounter.notifyDamage(100, "p1");
    expect(h.state.healed).toBe(150);
  });

  it("charges at a player and breaks only the monolith whose socket the line passes through", () => {
    const h = bullHarness();
    h.encounter.activate();
    h.tickFor(GRANITE_BULL.openingDelayMs + 200);
    const charge = h.encounter.activeCasts.find((cast) => cast.abilityId === GRANITE_BULL_ABILITIES.charge);
    expect(charge).toBeDefined();
    expect(charge!.geometry.kind).toBe("line");
    expect(h.states.get("healer_monolith_ne")).toBe("intact");
    h.tickFor(GRANITE_BULL.charge.telegraphMs + 400);
    expect(h.states.get("healer_monolith_ne")).toBe("destroyed");
    expect(["healer_monolith_nw", "healer_monolith_sw"].map((id) => h.states.get(id))).toEqual(["intact", "intact"]);
    expect(h.state.bossMoves.length).toBeGreaterThan(0);
    // Two standing now: 60% of a hit is healed.
    h.state.healed = 0;
    h.encounter.notifyDamage(200, "p1");
    expect(h.state.healed).toBe(120);
  });

  it("stomps instead when two players crowd it", () => {
    const h = bullHarness({ players: [destinationPoint(origin, 40, 90), destinationPoint(origin, 50, 270)] });
    h.encounter.activate();
    h.tickFor(GRANITE_BULL.openingDelayMs + 200);
    expect(h.encounter.activeCasts.map((cast) => cast.abilityId)).toEqual([GRANITE_BULL_ABILITIES.stomp]);
    expect(h.encounter.activeCasts[0]!.geometry).toMatchObject({ kind: "circle", radiusM: GRANITE_BULL.stomp.radiusM });
  });

  it("charges twice back to back below 25% health", () => {
    const h = bullHarness({ ratio: 0.2 });
    h.encounter.activate();
    h.tickFor(GRANITE_BULL.openingDelayMs + 200);
    const castIds = new Set<string>();
    for (let step = 0; step < 60; step += 1) {
      h.tick(100);
      for (const cast of h.encounter.activeCasts) if (cast.abilityId === GRANITE_BULL_ABILITIES.charge) castIds.add(cast.castInstanceId);
    }
    expect(castIds.size).toBe(2);
    expect(h.encounter.phase).toBe("enraged_monoliths_2");
  });

  it("sends a Mender Golem from the door to the nearest broken monolith; it repairs after 8 s", () => {
    const h = bullHarness({ players: [] });
    h.encounter.activate();
    h.states.set("healer_monolith_sw", "destroyed");
    h.tickFor(GRANITE_BULL.mender.intervalMs - 500);
    expect(h.world.mobs.size).toBe(0);
    h.tickFor(700);
    const [menderId] = h.world.of("mender_golem_gf");
    expect(menderId).toBeDefined();
    expect(h.world.mobs.get(menderId!)!.scripted).toBe(true);
    // It walks, arrives and channels; the HUD deadline shows the channel.
    h.tickFor(25_000, 100);
    expect(h.states.get("healer_monolith_sw")).toBe("intact");
    expect(h.world.mobs.size).toBe(0);
    expect(h.encounter.phase).toBe("monoliths_3");
  });

  it("does not repair when the Mender Golem is killed mid-channel", () => {
    const h = bullHarness({ players: [] });
    h.encounter.activate();
    h.states.set("healer_monolith_sw", "destroyed");
    for (let step = 0; step < 400 && h.world.of("mender_golem_gf").length === 0; step += 1) h.tick(100);
    const firstSpawnAt = h.state.now;
    const [menderId] = h.world.of("mender_golem_gf");
    expect(menderId).toBeDefined();
    // Walk until it channels (the deadline appears), then kill it.
    for (let step = 0; step < 200 && h.encounter.phaseDeadlineAt === null; step += 1) h.tick(100);
    expect(h.encounter.phaseDeadlineAt).not.toBeNull();
    h.tickFor(3_000);
    h.world.mobs.delete(menderId!);
    h.tickFor(GRANITE_BULL.mender.channelMs + 1_000);
    expect(h.states.get("healer_monolith_sw")).toBe("destroyed");
    expect(h.encounter.phaseDeadlineAt).toBeNull();
    // The next one comes 30 s after the first.
    for (let step = 0; step < 600 && h.world.of("mender_golem_gf").length === 0; step += 1) h.tick(100);
    expect(h.world.of("mender_golem_gf")).toHaveLength(1);
    expect(Math.abs(h.state.now - firstSpawnAt - GRANITE_BULL.mender.intervalMs)).toBeLessThanOrEqual(200);
  });

  it("restores every monolith and drops the mender on a wipe or reset", () => {
    const h = bullHarness({ players: [] });
    h.encounter.activate();
    for (const monolith of GRANITE_BULL.monoliths) h.states.set(monolith.objectId, "destroyed");
    h.tickFor(GRANITE_BULL.mender.intervalMs + 200);
    expect(h.world.of("mender_golem_gf")).toHaveLength(1);
    h.encounter.reset();
    for (const monolith of GRANITE_BULL.monoliths) expect(h.states.get(monolith.objectId)).toBe("intact");
    expect(h.world.mobs.size).toBe(0);
  });
});

function forgemasterHarness(options: { ratio?: number } = {}) {
  const { room, notices } = roomHooks();
  const world = mobWorld();
  const state = { now: 1_000, ratio: options.ratio ?? 1, zones: 0 };
  const anvil = destinationPoint(origin, 600, 0);
  const anchors = new Map<string, LatLon>([
    ["great_anvil_anchor", anvil],
    ["hammer_spawn_s", destinationPoint(origin, 500, 180)],
    ["hammer_spawn_e", destinationPoint(origin, 700, 90)],
    ["hammer_spawn_w", destinationPoint(origin, 700, 270)]
  ]);
  const player = destinationPoint(origin, 80, 90);
  let spawnSequence = 0;
  const encounter = new BossEncounter({
    encounterId: "enc",
    definition: { id: "forgemaster", revision: 1, archetypeKey: "forgemaster", controllerId: "forgemaster", rewardPolicy: { id: "x", minimumContribution: 1 } },
    host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "gf_great_forge", encounterId: "e", participantIds: ["p1"], room }),
    mobEntityId: "boss",
    controller: createForgemasterController({
      bossHealthRatio: () => state.ratio,
      bossPosition: () => origin,
      playerPosition: () => player,
      anchorPosition: (_boss, anchorId) => anchors.get(anchorId) ?? null,
      spawnMob: (_boss, archetype, position, scripted) => world.spawn(archetype, position, scripted),
      mobPosition: (id) => world.mobs.get(id)?.position ?? null,
      moveMobTo: (id, position) => { const mob = world.mobs.get(id); if (mob) mob.position = position; return mob !== undefined; },
      isAlive: (id) => world.mobs.has(id),
      despawn: world.despawn,
      spawnDamageZone: () => { state.zones += 1; },
      clearDamageZones: () => { state.zones = 0; },
      // Rotates through the three walls.
      random: () => (spawnSequence++ % 3) / 3
    }),
    initialState: "active",
    positionOfEntity: () => player,
    now: () => state.now
  });
  const tick = (ms: number) => { state.now += ms; encounter.tick(state.now); };
  const tickFor = (ms: number, stepMs = 100) => { for (let elapsed = 0; elapsed < ms; elapsed += stepMs) tick(stepMs); };
  return { encounter, state, world, notices, tick, tickFor, anvil };
}

describe("The Forgemaster", () => {
  it("throws a hammer to a wall spawn point; it walks to the anvil, and its arrival adds a strike and an Iron Golem", () => {
    const h = forgemasterHarness();
    h.encounter.activate();
    expect(h.encounter.phase).toBe("anvil_strikes_0");
    h.tickFor(FORGEMASTER.firstHammerDelayMs + 300);
    const [hammerId] = h.world.of("walking_hammer_gf");
    expect(hammerId).toBeDefined();
    expect(h.world.mobs.get(hammerId!)!.scripted).toBe(true);
    const start = h.world.mobs.get(hammerId!)!.position;
    h.tickFor(2_000);
    expect(distanceMeters(h.world.mobs.get(hammerId!)!.position, h.anvil)).toBeLessThan(distanceMeters(start, h.anvil));
    expect(h.world.of("iron_golem_gf")).toHaveLength(0);
    for (let step = 0; step < 400 && h.world.of("iron_golem_gf").length === 0; step += 1) h.tick(100);
    const [golemId] = h.world.of("iron_golem_gf");
    expect(golemId).toBeDefined();
    expect(h.world.mobs.get(golemId!)!.scripted).toBe(false);
    expect(distanceMeters(h.world.mobs.get(golemId!)!.position, h.anvil)).toBeLessThan(FORGEMASTER.golemRingRadiusM + 1);
    expect(h.world.mobs.has(hammerId!)).toBe(false);
    h.tick(100);
    h.tick(100);
    expect(h.encounter.phase).toBe("anvil_strikes_1");
    expect(h.encounter.failureRequested).toBeNull();
  });

  it("is a failed encounter on the fourth strike: hammers and golems despawn, the counter resets, the host is asked to eject", () => {
    const h = forgemasterHarness({ ratio: 0.2 });
    h.encounter.activate();
    let golemPositions: LatLon[] = [];
    for (let step = 0; step < 4_000 && h.encounter.failureRequested === null; step += 1) {
      h.tick(100);
      golemPositions = h.world.of("iron_golem_gf").map((id) => h.world.mobs.get(id)!.position);
    }
    expect(h.encounter.failureRequested).toBe("anvil_struck");
    expect(h.world.mobs.size).toBe(0);
    expect(h.notices.some((text) => /strike 1 of 4/i.test(text))).toBe(true);
    expect(h.notices.some((text) => /strike 2 of 4/i.test(text))).toBe(true);
    expect(h.notices.some((text) => /third time/i.test(text))).toBe(false);
    expect(h.notices.some((text) => /fourth time/i.test(text))).toBe(true);
    expect(golemPositions).toEqual([]);
    // After the failure the controller is quiet: no new hammers until the host resets it.
    h.tickFor(20_000);
    expect(h.world.mobs.size).toBe(0);
  });

  it("never stacks Iron Golems on one point", () => {
    const h = forgemasterHarness({ ratio: 0.2 });
    h.encounter.activate();
    const seen = new Set<string>();
    for (let step = 0; step < 4_000 && h.encounter.failureRequested === null; step += 1) {
      h.tick(100);
      for (const id of h.world.of("iron_golem_gf")) {
        const position = h.world.mobs.get(id)!.position;
        seen.add(`${position.lat.toFixed(7)},${position.lon.toFixed(7)}`);
      }
    }
    expect(seen.size).toBe(3);
  });

  it("keeps 1, 2 and 3 hammers on the floor in its three health phases", () => {
    for (const [ratio, expected] of [[1, 1], [0.5, 2], [0.2, 3]] as const) {
      const h = forgemasterHarness({ ratio });
      h.encounter.activate();
      let peak = 0;
      for (let step = 0; step < 200 && h.encounter.failureRequested === null && h.world.of("iron_golem_gf").length === 0; step += 1) {
        h.tick(100);
        peak = Math.max(peak, h.world.of("walking_hammer_gf").length);
      }
      expect(peak).toBe(expected);
    }
  });

  it("walks hammers faster in the last phase", () => {
    const secondsToFirstArrival = (ratio: number): number => {
      const h = forgemasterHarness({ ratio });
      h.encounter.activate();
      const startedAt = h.state.now;
      for (let step = 0; step < 4_000 && h.world.of("iron_golem_gf").length === 0; step += 1) h.tick(100);
      return h.state.now - startedAt;
    };
    expect(secondsToFirstArrival(0.2)).toBeLessThan(secondsToFirstArrival(1));
  });

  it("opens quench steam zones only from 50% health", () => {
    const high = forgemasterHarness({ ratio: 0.8 });
    high.encounter.activate();
    high.tickFor(10_000);
    expect(high.state.zones).toBe(0);
    const low = forgemasterHarness({ ratio: 0.4 });
    low.encounter.activate();
    low.tickFor(10_000);
    expect(low.state.zones).toBe(FORGEMASTER.quench.zones);
  });

  it("clears its quench zones on reset", () => {
    const h = forgemasterHarness({ ratio: 0.4 });
    h.encounter.activate();
    h.tickFor(10_000);
    expect(h.state.zones).toBeGreaterThan(0);
    h.encounter.reset();
    expect(h.state.zones).toBe(0);
  });

  it("clears hammers and golems on reset", () => {
    const h = forgemasterHarness();
    h.encounter.activate();
    for (let step = 0; step < 400 && h.world.of("iron_golem_gf").length === 0; step += 1) h.tick(100);
    expect(h.world.mobs.size).toBeGreaterThan(0);
    h.encounter.reset();
    expect(h.world.mobs.size).toBe(0);
  });
});

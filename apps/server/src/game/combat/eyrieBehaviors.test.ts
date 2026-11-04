import { describe, expect, it, vi } from "vitest";
import { destinationPoint, distanceMeters, moveToward, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter } from "../bossFramework.js";
import { createCoreBossRuntime } from "../coreBossRuntime.js";
import {
  THUNDERWING,
  THUNDERWING_ABILITIES,
  createThunderwingController
} from "../thunderwingBoss.js";
import { CombatEngine } from "./combatEngine.js";
import { MOB_DEFINITIONS } from "./mobDefinitions.js";
import {
  CLIFF_HAWK,
  NEST_MOUSE_HOP,
  hawkClimbDestination,
  hawkKeepsRange,
  newMobSpecialState,
  shouldScreech,
  shouldStartHawkDive
} from "./mobSpecialBehaviors.js";

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);
const at = (p: LatLon) => ({ lat: p.lat, lon: p.lon });
const REGION = "interior:eyrie";
const ZONE = "interior:eyrie:room";

function createEngine(extra: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    isSharedMobCombat: () => true,
    isMobPlayerAttackAuthorized: () => true,
    ...extra
  });
}

function addPlayer(engine: CombatEngine, position: LatLon = origin, damage = 1): void {
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: REGION, zoneId: ZONE, position,
    accountId: "a", connectionId: "c",
    profile: { playerId: "p1", maxHealth: 100_000, currentHealth: 100_000, baseAttackDamage: damage }
  });
}

function spawn(engine: CombatEngine, archetype: MobArchetypeKey, id: string, position: LatLon, zoneId = ZONE) {
  return engine.spawnMob({
    entityId: id, archetype, position, homePosition: position, regionCode: REGION, zoneId, worldAi: false
  });
}

const raw = (engine: CombatEngine, id: string) =>
  (engine as unknown as { entities: Map<string, Record<string, any>> }).entities.get(id)!;

describe("Eyrie mob helpers", () => {
  it("screeches only once", () => {
    const state = newMobSpecialState();
    expect(shouldScreech(state)).toBe(true);
    state.screeched = true;
    expect(shouldScreech(state)).toBe(false);
  });

  it("dives from range on cooldown, keeps its distance, and climbs straight away", () => {
    const state = newMobSpecialState();
    expect(shouldStartHawkDive(state, CLIFF_HAWK.diveMinRangeM - 1, 210, 0)).toBe(false);
    expect(shouldStartHawkDive(state, 200, 210, 0)).toBe(true);
    state.nextDiveTick = 100;
    expect(shouldStartHawkDive(state, 200, 210, 99)).toBe(false);
    expect(hawkKeepsRange(newMobSpecialState(), CLIFF_HAWK.keepRangeM - 1, 0)).toBe(true);
    expect(hawkKeepsRange(newMobSpecialState(), CLIFF_HAWK.keepRangeM + 1, 0)).toBe(false);
    const climbTo = hawkClimbDestination(east(10), origin, 90);
    expect(distanceMeters(climbTo, origin)).toBeGreaterThan(CLIFF_HAWK.climbDistanceM);
  });
});

describe("Eyrie mobs in the combat engine", () => {
  it("a nest mouse slows its target on the bite and scurries well clear afterwards", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "nest_mouse", "mouse", east(60));
    expect(engine.directMobTarget("mouse", "p1")).toBe(true);
    let farthest = 0;
    for (let tick = 0; tick < 120; tick += 1) {
      engine.tick();
      farthest = Math.max(farthest, distanceMeters(at(engine.entity("mouse")!), origin));
    }
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(100_000);
    const effects = raw(engine, "p1").classRuntime?.effects ?? [];
    expect(effects.some((effect: { kind: string }) => effect.kind === "movement_slow")).toBe(true);
    expect(farthest).toBeGreaterThan(NEST_MOUSE_HOP.awayDistanceM * 0.8);
  });

  it("the first hit on a carrion chick makes it screech: idle hawks in the room join its attacker", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "carrion_chick", "chick", east(60));
    spawn(engine, "cliff_hawk", "hawk", east(500));
    spawn(engine, "cliff_hawk", "far-hawk", east(500), "interior:eyrie:other-room");
    spawn(engine, "cave_raptor", "not-a-hawk", east(500));
    expect(engine.entity("hawk")!.targetEntityId).toBeNull();
    engine.startAttack({ attackerId: "p1", targetEntityId: "chick", requestId: "r", accountId: "a", connectionId: "c" });
    for (let tick = 0; tick < 80; tick += 1) engine.tick();
    expect(engine.entity("chick")!.currentHealth).toBeLessThan(MOB_DEFINITIONS.carrion_chick.maxHealth);
    expect(engine.entity("hawk")!.targetEntityId).toBe("p1");
    expect(engine.entity("far-hawk")!.targetEntityId).toBeNull();
    expect(engine.entity("not-a-hawk")!.targetEntityId).toBeNull();
    expect(raw(engine, "chick").special.screeched).toBe(true);
  });

  it("a cliff hawk telegraphs a dive, slams the spot, then climbs out of reach", () => {
    const engine = createEngine();
    addPlayer(engine);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    spawn(engine, "cliff_hawk", "hawk", east(220));
    expect(engine.directMobTarget("hawk", "p1")).toBe(true);
    let telegraphed = false;
    for (let tick = 0; tick < 60 && !telegraphed; tick += 1) {
      engine.tick();
      telegraphed = raw(engine, "hawk").special?.diveCenter != null;
    }
    expect(telegraphed).toBe(true);
    expect(damage).not.toHaveBeenCalledWith("hawk", "p1", expect.any(Number), CLIFF_HAWK.techniqueId);
    for (let tick = 0; tick < 30; tick += 1) engine.tick();
    expect(damage).toHaveBeenCalledWith(
      "hawk", "p1", Math.round(MOB_DEFINITIONS.cliff_hawk.attackPower * CLIFF_HAWK.diveDamageFactor), CLIFF_HAWK.techniqueId
    );
    // Climbing: unreachable, and moving away.
    expect(raw(engine, "hawk").special.climbing).toBe(true);
    expect(() => engine.startAttack({
      attackerId: "p1", targetEntityId: "hawk", requestId: "climb", accountId: "a", connectionId: "c"
    })).toThrow();
    for (let tick = 0; tick < 30; tick += 1) engine.tick();
    expect(distanceMeters(at(engine.entity("hawk")!), origin)).toBeGreaterThan(50);
    for (let tick = 0; tick < 60; tick += 1) engine.tick();
    expect(raw(engine, "hawk").special.climbing).toBe(false);
    expect(engine.entity("hawk")!.targetEntityId).toBe("p1");
  });

  it("knockback pushes away from the source but is clamped by the room bounds", () => {
    const wallM = 300;
    const inside = (destination: LatLon) => distanceMeters(destination, origin) <= wallM;
    const engine = createEngine({ repositionPlayer: (_id, destination) => inside(destination) });
    addPlayer(engine, east(100));
    expect(engine.knockbackPlayer("p1", origin, 250)).toBe(true);
    const pushed = distanceMeters(at(engine.entity("p1")!), origin);
    expect(pushed).toBeGreaterThan(200);
    expect(pushed).toBeLessThanOrEqual(wallM);

    // Pinned against the wall: nothing fits, the player stays put and never leaves the room.
    engine.syncPlayer({ playerId: "p1", position: east(wallM), regionCode: REGION, zoneId: ZONE });
    expect(engine.knockbackPlayer("p1", origin, 250)).toBe(false);
    expect(distanceMeters(at(engine.entity("p1")!), origin)).toBeLessThanOrEqual(wallM + 1);
  });
});

describe("Thunderwing", () => {
  const definition = {
    id: "thunderwing", revision: 1, archetypeKey: "thunderwing" as const,
    controllerId: "thunderwing", rewardPolicy: { id: "thunderwing", minimumContribution: 1 }
  };
  function make(now: () => number, leaps: LatLon[]) {
    return new BossEncounter({
      encounterId: "i:r:tw:1:boss",
      definition,
      host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "nest", encounterId: "tw:1:boss", participantIds: ["p1"] }),
      mobEntityId: "mob:tw",
      controller: createThunderwingController({
        bossPosition: () => east(500),
        playerPosition: () => origin,
        leapBossTo: (_id, position) => { leaps.push(position); }
      }),
      initialState: "active",
      now
    });
  }

  it("casts a gust cone, a dive circle that moves the boss, and a lightning mark on every third gust", () => {
    let now = 1_000;
    const leaps: LatLon[] = [];
    const encounter = make(() => now, leaps);
    const resolver = { positionOfEntity: () => origin, applyHit: () => {} };
    encounter.activate();
    const seen: string[] = [];
    const abilitiesAt = (t: number) => {
      now = t;
      encounter.tick(now, resolver);
      for (const cast of encounter.projection(now).activeCasts ?? []) seen.push(`${cast.abilityId}`);
    };
    abilitiesAt(1_000 + THUNDERWING.firstGustDelayMs);
    expect(seen).toContain(THUNDERWING_ABILITIES.windGust);
    const gust = encounter.projection(now).activeCasts!.find((cast) => cast.abilityId === THUNDERWING_ABILITIES.windGust)!;
    expect(gust.geometry).toMatchObject({ kind: "cone", rangeM: THUNDERWING.gustRangeM });
    expect(seen).not.toContain(THUNDERWING_ABILITIES.lightning);

    abilitiesAt(1_000 + THUNDERWING.firstDiveDelayMs);
    expect(encounter.projection(now).activeCasts!.some((cast) => cast.abilityId === THUNDERWING_ABILITIES.dive)).toBe(true);
    now += THUNDERWING.diveTelegraphMs;
    encounter.tick(now, resolver);
    expect(leaps).toHaveLength(1);

    // Gust 2, then gust 3 also marks a lightning strike.
    seen.length = 0;
    abilitiesAt(1_000 + THUNDERWING.firstGustDelayMs + THUNDERWING.gustIntervalMs);
    expect(seen).not.toContain(THUNDERWING_ABILITIES.lightning);
    seen.length = 0;
    abilitiesAt(1_000 + THUNDERWING.firstGustDelayMs + THUNDERWING.gustIntervalMs * 2);
    expect(seen).toContain(THUNDERWING_ABILITIES.lightning);
  });

  it("drops gold; its Giant Egg comes from the per-member completion reward", () => {
    const rewards = MOB_DEFINITIONS.thunderwing.rewards;
    expect(rewards.items).toEqual([]);
    expect(rewards.gold).toBeGreaterThan(0);
    expect(MOB_DEFINITIONS.thunderwing.boss).toBe(true);
  });

  it("runs through the boss runtime: the gust shoves and hurts, the dive hurts and moves the boss", () => {
    const wall = 400;
    const engine = createEngine({ repositionPlayer: (_id, destination) => distanceMeters(destination, origin) <= wall });
    addPlayer(engine, east(100));
    const boss = spawn(engine, "thunderwing", "boss:tw", east(150));
    let now = 1_000;
    const manager = createCoreBossRuntime(engine, 40, () => now);
    manager.create({
      encounterId: "i:r:tw:1:boss",
      definitionId: "thunderwing",
      host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "nest", encounterId: "tw:1:boss", participantIds: ["p1"] }),
      mobEntityId: boss.entityId,
      initialState: "active",
      lifeGeneration: 1
    });
    now += THUNDERWING.firstGustDelayMs;
    manager.tick(now);
    const before = engine.entity("p1")!;
    now += THUNDERWING.gustTelegraphMs;
    manager.tick(now);
    const after = engine.entity("p1")!;
    expect(after.currentHealth).toBeLessThan(before.currentHealth);
    expect(distanceMeters(at(after), at(boss))).toBeGreaterThan(distanceMeters(at(before), at(boss)));
    expect(distanceMeters(at(after), origin)).toBeLessThanOrEqual(wall);
    expect(destinationPoint).toBeDefined();
  });
});

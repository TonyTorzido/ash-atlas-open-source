import { describe, expect, it, vi } from "vitest";
import { destinationPoint, distanceMeters, moveToward, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter } from "../bossFramework.js";
import { createCoreBossRuntime } from "../coreBossRuntime.js";
import {
  RAPTOR_CHIEFTAIN,
  RAPTOR_CHIEFTAIN_ABILITIES,
  RAPTOR_CHIEFTAIN_PHASES,
  createRaptorChieftainController
} from "../raptorChieftainBoss.js";
import { CombatEngine } from "./combatEngine.js";
import { MOB_DEFINITIONS } from "./mobDefinitions.js";
import {
  CAVE_RAPTOR_POUNCE,
  RAPTOR_RUNT,
  RAPTOR_SPITTER,
  caveBatLifesteal,
  flankSlotPosition,
  isWarRoared,
  newMobSpecialState,
  shouldRuntFlee,
  shouldSpit,
  shouldSpitterBackOff,
  spitterBackoffDestination
} from "./mobSpecialBehaviors.js";

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);
const at = (p: LatLon) => ({ lat: p.lat, lon: p.lon });

function createEngine(): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    isSharedMobCombat: () => true,
    isMobPlayerAttackAuthorized: () => true
  });
}

function addPlayer(engine: CombatEngine, health = 100_000): void {
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: "interior:t", zoneId: "interior:t:room", position: origin,
    accountId: "a", connectionId: "c",
    profile: { playerId: "p1", maxHealth: health, currentHealth: health, baseAttackDamage: 1 }
  });
}

function spawn(engine: CombatEngine, archetype: MobArchetypeKey, id: string, position: LatLon, zoneId = "interior:t:room") {
  return engine.spawnMob({
    entityId: id, archetype, position, homePosition: position, regionCode: "interior:t", zoneId, worldAi: false
  });
}

const raw = (engine: CombatEngine, id: string) =>
  (engine as unknown as { entities: Map<string, Record<string, any>> }).entities.get(id)!;

describe("raptor family helpers", () => {
  it("spreads flank slots evenly around the target", () => {
    const slots = [0, 1, 2].map((index) => flankSlotPosition(index, 3, origin));
    for (const slot of slots) {
      expect(distanceMeters(slot, origin)).toBeCloseTo(CAVE_RAPTOR_POUNCE.flankRadiusM, 0);
    }
    expect(distanceMeters(slots[0]!, slots[1]!)).toBeGreaterThan(CAVE_RAPTOR_POUNCE.flankRadiusM);
    expect(distanceMeters(slots[1]!, slots[2]!)).toBeGreaterThan(CAVE_RAPTOR_POUNCE.flankRadiusM);
  });

  it("flees once at low health and backs off / spits on the right ranges", () => {
    const state = newMobSpecialState();
    expect(shouldRuntFlee(state, 30, 30)).toBe(false);
    expect(shouldRuntFlee(state, 8, 30)).toBe(true);
    state.fled = true;
    expect(shouldRuntFlee(state, 4, 30)).toBe(false);

    const spitter = newMobSpecialState();
    expect(shouldSpitterBackOff(spitter, RAPTOR_SPITTER.backoffDistanceM - 1, 0)).toBe(true);
    expect(shouldSpitterBackOff(spitter, RAPTOR_SPITTER.backoffDistanceM + 1, 0)).toBe(false);
    expect(shouldSpit(spitter, 200, 240, 0)).toBe(true);
    expect(shouldSpit(spitter, 260, 240, 0)).toBe(false);
    spitter.nextSpitTick = 50;
    expect(shouldSpit(spitter, 200, 240, 49)).toBe(false);
    expect(distanceMeters(spitterBackoffDestination(east(50), origin), origin)).toBeGreaterThan(RAPTOR_SPITTER.backoffStepM);
    expect(caveBatLifesteal(10)).toBe(3);
    expect(caveBatLifesteal(0)).toBe(0);
    expect(isWarRoared({ ...newMobSpecialState(), roarUntilTick: 10 }, 9)).toBe(true);
  });
});

describe("raptor family in the combat engine", () => {
  it("cave raptors on one target pounce into separate flank slots instead of stacking", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "cave_raptor", "r1", east(400));
    spawn(engine, "cave_raptor", "r2", east(405));
    expect(engine.directMobTarget("r1", "p1")).toBe(true);
    expect(engine.directMobTarget("r2", "p1")).toBe(true);
    for (let tick = 0; tick < 20; tick += 1) engine.tick();
    const [a, b] = [engine.entity("r1")!, engine.entity("r2")!];
    expect(distanceMeters(at(a), origin)).toBeLessThan(CAVE_RAPTOR_POUNCE.flankRadiusM + 20);
    expect(distanceMeters(at(b), origin)).toBeLessThan(CAVE_RAPTOR_POUNCE.flankRadiusM + 20);
    expect(distanceMeters(at(a), at(b))).toBeGreaterThan(CAVE_RAPTOR_POUNCE.flankRadiusM);
  });

  it("a wounded raptor runt shrieks idle raptors onto its attacker and runs away", () => {
    const engine = createEngine();
    addPlayer(engine);
    const runt = spawn(engine, "raptor_runt", "runt", east(80));
    spawn(engine, "cave_raptor", "idle-raptor", east(500));
    spawn(engine, "cave_raptor", "other-room-raptor", east(500), "interior:t:other");
    expect(engine.directMobTarget("runt", "p1")).toBe(true);
    raw(engine, "runt").currentHealth = Math.max(1, Math.floor(raw(engine, "runt").maxHealth * 0.25));
    (engine as unknown as { processRuntFlee(m: unknown, a: unknown): void })
      .processRuntFlee(raw(engine, "runt"), raw(engine, "p1"));
    expect(engine.entity("idle-raptor")!.targetEntityId).toBe("p1");
    expect(engine.entity("other-room-raptor")!.targetEntityId).toBeNull();
    const before = distanceMeters(at(engine.entity(runt.entityId)!), origin);
    for (let tick = 0; tick < 120; tick += 1) engine.tick();
    expect(distanceMeters(at(engine.entity("runt")!), origin)).toBeGreaterThan(before + RAPTOR_RUNT.fleeDistanceM * 0.5);
  });

  it("a raptor spitter backs away when meleed and spits acid that damages inside the zone", () => {
    const engine = createEngine();
    addPlayer(engine);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    spawn(engine, "raptor_spitter", "spitter", east(60));
    expect(engine.directMobTarget("spitter", "p1")).toBe(true);
    for (let tick = 0; tick < 12; tick += 1) engine.tick();
    expect(distanceMeters(at(engine.entity("spitter")!), origin)).toBeGreaterThan(RAPTOR_SPITTER.backoffDistanceM);

    for (let tick = 0; tick < 100; tick += 1) engine.tick();
    expect(damage).toHaveBeenCalledWith("spitter", "p1", expect.any(Number), RAPTOR_SPITTER.techniqueId);
    // The puddle only hurts people standing in it.
    damage.mockClear();
    engine.syncPlayer({ playerId: "p1", position: destinationPoint(origin, 2_000, 270), regionCode: "interior:t", zoneId: "interior:t:room" });
    (engine as unknown as { acidZones: Array<{ center: LatLon; landTick: number; endTick: number; nextTick: number; sourceEntityId: string; damage: number }> })
      .acidZones.push({ center: origin, landTick: 0, endTick: 10_000, nextTick: 0, sourceEntityId: "spitter", damage: 5 });
    for (let tick = 0; tick < 25; tick += 1) engine.tick();
    expect(damage).not.toHaveBeenCalled();
  });

  it("a cave bat steals life on its bite and flutters away", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "cave_bat", "bat", east(60));
    raw(engine, "bat").currentHealth = 20;
    expect(engine.directMobTarget("bat", "p1")).toBe(true);
    let farthest = 0;
    for (let tick = 0; tick < 120; tick += 1) {
      engine.tick();
      farthest = Math.max(farthest, distanceMeters(at(engine.entity("bat")!), origin));
    }
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(100_000);
    expect(engine.entity("bat")!.currentHealth).toBeGreaterThan(20);
    expect(farthest).toBeGreaterThan(120);
  });

  it("the war roar buffs only raptors in the room and raises their hit damage", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "cave_raptor", "in-room", east(500), "room-a");
    spawn(engine, "raptor_spitter", "in-room-2", east(500), "room-a");
    spawn(engine, "cave_raptor", "elsewhere", east(500), "room-b");
    spawn(engine, "cave_bat", "bat", east(500), "room-a");
    expect(engine.applyWarRoar("room-a", 6_000)).toBe(2);
    expect(raw(engine, "in-room").special.roarUntilTick).toBeGreaterThan(0);
    expect(raw(engine, "elsewhere").special).toBeUndefined();
    expect(raw(engine, "bat").special).toBeUndefined();
  });
});

describe("Raptor Chieftain controller", () => {
  const definition = {
    id: "raptor_chieftain", revision: 1, archetypeKey: "raptor_chieftain" as const,
    controllerId: "raptor_chieftain", rewardPolicy: { id: "raptor_chieftain", minimumContribution: 1 }
  };
  function make(health: { ratio: number }, now: () => number, calls: { leaps: LatLon[]; roars: number[] }) {
    return new BossEncounter({
      encounterId: "i:r:chief:1:boss",
      definition,
      host: new DungeonBossHostAdapter({
        instanceId: "i", runId: "r", roomId: "chief", encounterId: "chief:1:boss", participantIds: ["p1"]
      }),
      mobEntityId: "mob:chief",
      controller: createRaptorChieftainController({
        bossHealthRatio: () => health.ratio,
        playerPosition: () => origin,
        leapBossTo: (_id, position) => { calls.leaps.push(position); },
        warRoar: (_id, durationMs) => { calls.roars.push(durationMs); }
      }),
      initialState: "active",
      now
    });
  }

  it("telegraphs a leap slam circle, jumps onto it as it lands, and roars on schedule", () => {
    let now = 1_000;
    const calls = { leaps: [] as LatLon[], roars: [] as number[] };
    const hits: string[] = [];
    const resolver = { positionOfEntity: () => origin, applyHit: (cast: { abilityId: string }) => { hits.push(cast.abilityId); } };
    const encounter = make({ ratio: 1 }, () => now, calls);
    encounter.activate();
    now += RAPTOR_CHIEFTAIN.firstSlamDelayMs;
    encounter.tick(now, resolver);
    const casts = encounter.projection(now).activeCasts ?? [];
    expect(casts[0]).toMatchObject({ abilityId: RAPTOR_CHIEFTAIN_ABILITIES.leapSlam, geometry: { kind: "circle" } });
    expect(calls.leaps).toEqual([]);
    now += RAPTOR_CHIEFTAIN.slamTelegraphMs;
    encounter.tick(now, resolver);
    expect(calls.leaps).toHaveLength(1);
    expect(hits).toEqual([RAPTOR_CHIEFTAIN_ABILITIES.leapSlam]);
    expect(calls.roars).toEqual([]);
    now = 1_000 + RAPTOR_CHIEFTAIN.firstRoarDelayMs;
    encounter.tick(now, resolver);
    expect(calls.roars).toEqual([RAPTOR_CHIEFTAIN.roarDurationMs]);
  });

  it("enrages below 25% health with a shorter telegraph, faster interval, and speed boost", () => {
    const run = (ratio: number) => {
      let now = 1_000;
      const calls = { leaps: [] as LatLon[], roars: [] as number[] };
      const encounter = make({ ratio }, () => now, calls);
      encounter.activate();
      now += RAPTOR_CHIEFTAIN.firstSlamDelayMs;
      encounter.tick(now);
      const cast = encounter.projection(now).activeCasts![0]!;
      return { encounter, telegraphMs: cast.resolveTime - cast.startTime };
    };
    const calm = run(0.5);
    const enraged = run(0.2);
    expect(calm.encounter.phase).toBe(RAPTOR_CHIEFTAIN_PHASES.normal);
    expect(calm.telegraphMs).toBe(RAPTOR_CHIEFTAIN.slamTelegraphMs);
    expect(enraged.encounter.phase).toBe(RAPTOR_CHIEFTAIN_PHASES.enraged);
    expect(enraged.telegraphMs).toBe(RAPTOR_CHIEFTAIN.enragedSlamTelegraphMs);
    expect(enraged.encounter.movementOverride).toMatchObject({
      movementSpeedMultiplier: RAPTOR_CHIEFTAIN.enragedMovementMultiplier
    });
    expect(RAPTOR_CHIEFTAIN.enragedSlamIntervalMs).toBeLessThan(RAPTOR_CHIEFTAIN.slamIntervalMs);
  });

  it("drops gold; its Raptor Scale comes from the per-member completion reward", () => {
    const rewards = MOB_DEFINITIONS.raptor_chieftain.rewards;
    expect(rewards.items).toEqual([]);
    expect(rewards.gold).toBeGreaterThan(0);
    expect(MOB_DEFINITIONS.raptor_chieftain.boss).toBe(true);
  });

  it("runs through the registered boss runtime: the slam damages the target and moves the boss", () => {
    const engine = createEngine();
    addPlayer(engine);
    const boss = spawn(engine, "raptor_chieftain", "boss:chief", east(300));
    let now = 1_000;
    const manager = createCoreBossRuntime(engine, 40, () => now);
    manager.create({
      encounterId: "i:r:chief:1:boss",
      definitionId: "raptor_chieftain",
      host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "chief", encounterId: "chief:1:boss", participantIds: ["p1"] }),
      mobEntityId: boss.entityId,
      initialState: "active",
      lifeGeneration: 1
    });
    now += RAPTOR_CHIEFTAIN.firstSlamDelayMs;
    manager.tick(now);
    expect(engine.entity("p1")!.currentHealth).toBe(100_000);
    now += RAPTOR_CHIEFTAIN.slamTelegraphMs;
    manager.tick(now);
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(100_000);
    expect(distanceMeters(at(engine.entity(boss.entityId)!), origin)).toBeLessThan(5);
  });
});

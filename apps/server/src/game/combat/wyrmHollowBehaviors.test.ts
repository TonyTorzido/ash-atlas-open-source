import { describe, expect, it, vi } from "vitest";
import { distanceMeters, moveToward, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter } from "../bossFramework.js";
import { createCoreBossRuntime } from "../coreBossRuntime.js";
import {
  ELDER_DRAGON,
  ELDER_DRAGON_ABILITIES,
  ELDER_DRAGON_PHASES,
  createElderDragonController,
  elderDragonLavaPoolRadiusM
} from "../elderDragonBoss.js";
import { CombatEngine } from "./combatEngine.js";
import { DRAKELING_SPIT, LAVA_SLIME_TRAIL, LAVA_VENT, MAGMA_SALAMANDER, lavaVentDue } from "./wyrmHollowBehaviors.js";
import { MOB_DEFINITIONS } from "./mobDefinitions.js";

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);
const at = (p: LatLon) => ({ lat: p.lat, lon: p.lon });
const REGION = "interior:lair";
const ZONE = "interior:lair:room";

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

function addPlayer(engine: CombatEngine, position: LatLon = origin): void {
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: REGION, zoneId: ZONE, position,
    accountId: "a", connectionId: "c",
    profile: { playerId: "p1", maxHealth: 100_000, currentHealth: 100_000, baseAttackDamage: 1 }
  });
}

function spawn(engine: CombatEngine, archetype: MobArchetypeKey, id: string, position: LatLon) {
  return engine.spawnMob({ entityId: id, archetype, position, homePosition: position, regionCode: REGION, zoneId: ZONE, worldAi: false });
}

const raw = (engine: CombatEngine, id: string) =>
  (engine as unknown as { entities: Map<string, Record<string, any>> }).entities.get(id)!;
const burning = (engine: CombatEngine) => (engine.entity("p1")!.harmfulStatusIds ?? []).includes("burning");

describe("Wyrm Hollow helpers", () => {
  it("staggers lava vents and erupts each once per cycle", () => {
    expect(lavaVentDue(0, 0, 0, undefined)).toBe(true);
    expect(lavaVentDue(100, 0, 0, 0)).toBe(false);
    expect(lavaVentDue(LAVA_VENT.cycleMs, 0, 0, 0)).toBe(true);
    expect(lavaVentDue(LAVA_VENT.staggerMs - 1, 0, 1, undefined)).toBe(false);
    expect(lavaVentDue(LAVA_VENT.staggerMs, 0, 1, undefined)).toBe(true);
  });

  it("widens the boss lava pools up to a cap", () => {
    expect(elderDragonLavaPoolRadiusM(5)).toBeGreaterThan(elderDragonLavaPoolRadiusM(0));
    expect(elderDragonLavaPoolRadiusM(10_000)).toBe(elderDragonLavaPoolRadiusM(1_000));
  });
});

describe("Wyrm Hollow mobs in the combat engine", () => {
  it("a drakeling telegraphs a small fire cone that hurts and sets the player burning", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "drakeling", "drake", east(80));
    expect(engine.directMobTarget("drake", "p1")).toBe(true);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    for (let tick = 0; tick < 100; tick += 1) engine.tick();
    expect(damage).toHaveBeenCalledWith("drake", "p1", expect.any(Number), DRAKELING_SPIT.techniqueId);
    expect(burning(engine)).toBe(true);
  });

  it("a magma salamander submerges out of reach, then surfaces beside its target with a burning bite", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "magma_salamander", "sal", east(300));
    expect(engine.directMobTarget("sal", "p1")).toBe(true);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    let submerged = false;
    for (let tick = 0; tick < 200 && !submerged; tick += 1) {
      engine.tick();
      submerged = raw(engine, "sal").special?.climbing === true;
    }
    expect(submerged).toBe(true);
    expect(engine.entity("sal")!.targetEntityId ?? null).toBeNull();
    for (let tick = 0; tick < 60; tick += 1) engine.tick();
    expect(raw(engine, "sal").special.climbing).toBe(false);
    expect(damage).toHaveBeenCalledWith("sal", "p1", expect.any(Number), MAGMA_SALAMANDER.techniqueId);
    expect(distanceMeters(at(engine.entity("sal")!), origin)).toBeLessThan(MAGMA_SALAMANDER.surfaceDistanceM * 2);
    expect(burning(engine)).toBe(true);
  });

  it("a lava slime leaves short-lived burning puddles while it fights", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "lava_slime", "slime", east(60));
    expect(engine.directMobTarget("slime", "p1")).toBe(true);
    for (let tick = 0; tick < 10; tick += 1) engine.tick();
    const zones = (engine as unknown as { acidZones: { techniqueId?: string; burning?: boolean }[] }).acidZones;
    expect(zones.some((zone) => zone.techniqueId === LAVA_SLIME_TRAIL.techniqueId && zone.burning)).toBe(true);
  });

  it("a drake broodguard enrages while a player stands at the eggs it guards", () => {
    const engine = createEngine();
    spawn(engine, "drake_broodguard", "guard", east(800));
    engine.tick();
    expect(raw(engine, "guard").special?.roarUntilTick ?? 0).toBe(0);
    addPlayer(engine, east(820));
    engine.tick();
    expect(raw(engine, "guard").special.roarUntilTick).toBeGreaterThan(0);
    expect((engine.entity("guard")!.mobBuffs ?? []).map((buff) => buff.kind)).toContain("enraged");
  });

  it("an ash wyvern dive knocks the player back", () => {
    const reposition = vi.fn(() => true);
    const engine = createEngine({ repositionPlayer: reposition });
    addPlayer(engine);
    spawn(engine, "ash_wyvern", "wyvern", east(180));
    expect(engine.directMobTarget("wyvern", "p1")).toBe(true);
    for (let tick = 0; tick < 200 && reposition.mock.calls.length === 0; tick += 1) engine.tick();
    expect(reposition).toHaveBeenCalled();
  });

  it("a room hazard with no owner lands after its telegraph and burns whoever stands in it", () => {
    const engine = createEngine();
    addPlayer(engine);
    engine.spawnRoomHazard({
      zoneId: ZONE, hazardId: "vent", center: origin, radiusM: 60, delayMs: LAVA_VENT.telegraphMs,
      durationMs: LAVA_VENT.eruptionMs, damage: LAVA_VENT.tickDamage, techniqueId: LAVA_VENT.techniqueId
    });
    engine.tick();
    expect(engine.entity("p1")!.currentHealth).toBe(100_000);
    for (let tick = 0; tick < 40; tick += 1) engine.tick();
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(100_000);
    expect(burning(engine)).toBe(true);
  });
});

describe("Elder Dragon", () => {
  const definition = {
    id: "elder_dragon", revision: 1, archetypeKey: "elder_dragon" as const,
    controllerId: "elder_dragon", rewardPolicy: { id: "elder_dragon", minimumContribution: 1 }
  };
  type State = { ratio: number; airborne: boolean[]; pools: number[]; occupied?: boolean };
  function make(state: State, now: () => number) {
    return new BossEncounter({
      encounterId: "i:r:dragon:1:boss",
      definition,
      host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "hoard", encounterId: "dragon:1:boss", participantIds: ["p1"] }),
      mobEntityId: "mob:dragon",
      controller: createElderDragonController({
        bossHealthRatio: () => state.ratio,
        bossPosition: () => east(300),
        playerPosition: () => origin,
        setAirborne: (_id, airborne) => { state.airborne.push(airborne); },
        spawnLavaPool: (_id, _index, _center, radiusM) => { state.pools.push(radiusM); },
        roomOccupied: () => state.occupied ?? true
      }),
      initialState: "active",
      now
    });
  }
  const casts = (encounter: BossEncounter, now: number, abilityId: string) =>
    (encounter.projection(now).activeCasts ?? []).filter((cast) => cast.abilityId === abilityId);

  it("breathes a telegraphed cone, buffets around itself, and keeps widening four lava pools", () => {
    let now = 1_000;
    const state: State = { ratio: 1, airborne: [], pools: [] };
    const encounter = make(state, () => now);
    encounter.activate();
    encounter.tick(now);
    expect(state.pools).toHaveLength(4);
    now += ELDER_DRAGON.firstBreathDelayMs;
    encounter.tick(now);
    const breath = casts(encounter, now, ELDER_DRAGON_ABILITIES.breath);
    expect(breath).toHaveLength(1);
    expect(breath[0]!.geometry.kind).toBe("cone");
    now = 1_000 + ELDER_DRAGON.firstBuffetDelayMs;
    encounter.tick(now);
    expect(casts(encounter, now, ELDER_DRAGON_ABILITIES.buffet)[0]?.geometry.kind).toBe("circle");
    expect(state.pools.length).toBeGreaterThan(4);
    expect(state.pools[state.pools.length - 1]!).toBeGreaterThan(state.pools[0]!);
  });

  it("takes off at 70% and 40% for 15s (immune, raining fireballs), then lands; enraged below 25%", () => {
    let now = 1_000;
    const state: State = { ratio: 0.69, airborne: [], pools: [] };
    const encounter = make(state, () => now);
    encounter.activate();
    encounter.tick(now);
    expect(encounter.phase).toBe(ELDER_DRAGON_PHASES.flight);
    expect(state.airborne).toEqual([true]);
    expect(encounter.movementOverride).toMatchObject({ incomingDamageMultiplier: 0, movementSpeedMultiplier: 0 });
    expect(encounter.movementOverride?.outgoingDamageMultiplier).toBeUndefined();
    expect(encounter.phaseDeadlineAt).toBe(now + ELDER_DRAGON.flightDurationMs);
    now += 1_000;
    encounter.tick(now);
    expect(casts(encounter, now, ELDER_DRAGON_ABILITIES.fireball)).toHaveLength(1);
    now = 1_000 + ELDER_DRAGON.flightDurationMs;
    encounter.tick(now);
    expect(state.airborne).toEqual([true, false]);
    expect(encounter.phase).toBe(ELDER_DRAGON_PHASES.normal);
    expect(encounter.movementOverride).toBeNull();
    now += 100;
    encounter.tick(now);
    expect(encounter.phase).toBe(ELDER_DRAGON_PHASES.normal);
    state.ratio = 0.39;
    now += 100;
    encounter.tick(now);
    expect(encounter.phase).toBe(ELDER_DRAGON_PHASES.flight);
    now += ELDER_DRAGON.flightDurationMs;
    encounter.tick(now);
    state.ratio = 0.2;
    now += 100;
    encounter.tick(now);
    expect(encounter.phase).toBe(ELDER_DRAGON_PHASES.enraged);
    expect(state.airborne).toEqual([true, false, true, false]);
  });

  it("pauses the lava pools (and their widening) while nobody is in the boss room", () => {
    let now = 1_000;
    const state: State = { ratio: 1, airborne: [], pools: [], occupied: false };
    const encounter = make(state, () => now);
    encounter.activate();
    for (let step = 0; step < 5; step += 1) { now += ELDER_DRAGON.lavaPoolPulseMs; encounter.tick(now); }
    expect(state.pools).toEqual([]);
    state.occupied = true;
    now += 100;
    encounter.tick(now);
    expect(state.pools).toEqual(Array(4).fill(elderDragonLavaPoolRadiusM(0)));
  });

  it("drops a guaranteed Wyrm Egg, Dragon Scales and gold", () => {
    const rewards = MOB_DEFINITIONS.elder_dragon.rewards;
    expect(rewards.items).toEqual([{ itemId: "wyrm_egg", quantity: 1 }, { itemId: "dragon_scale", quantity: 3 }]);
    expect(rewards.gold).toBeGreaterThan(0);
    expect(MOB_DEFINITIONS.elder_dragon.boss).toBe(true);
  });

  it("runs through the boss runtime: the flight makes the dragon unreachable until it lands", () => {
    const engine = createEngine();
    addPlayer(engine);
    const boss = spawn(engine, "elder_dragon", "boss:dragon", east(200));
    let now = 1_000;
    const manager = createCoreBossRuntime(engine, 40, () => now);
    manager.create({
      encounterId: "i:r:dragon:1:boss",
      definitionId: "elder_dragon",
      host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "hoard", encounterId: "dragon:1:boss", participantIds: ["p1"] }),
      mobEntityId: boss.entityId,
      initialState: "active",
      lifeGeneration: 1
    });
    raw(engine, boss.entityId).currentHealth = Math.floor(raw(engine, boss.entityId).maxHealth * 0.69);
    manager.tick(now);
    expect(raw(engine, boss.entityId).special?.climbing).toBe(true);
    // A fireball during the flight still hurts (the flight override only blocks incoming damage).
    const before = engine.entity("p1")!.currentHealth;
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    now += 1_000;
    manager.tick(now);
    now += ELDER_DRAGON.fireballTelegraphMs;
    manager.tick(now);
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(before);
    const fireball = damage.mock.calls.findIndex((call) => call[3] === `boss:elder_dragon:${ELDER_DRAGON_ABILITIES.fireball}`);
    expect(fireball).toBeGreaterThanOrEqual(0);
    expect(damage.mock.results[fireball]!.value).toBeGreaterThan(0);
    now += ELDER_DRAGON.flightDurationMs;
    manager.tick(now);
    expect(raw(engine, boss.entityId).special.climbing).toBe(false);
  });
});

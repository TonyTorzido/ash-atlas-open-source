import { describe, expect, it, vi } from "vitest";
import { destinationPoint, distanceMeters, moveToward, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter } from "../bossFramework.js";
import { createCoreBossRuntime } from "../coreBossRuntime.js";
import {
  HOLLOW_ELDER,
  HOLLOW_ELDER_ABILITIES,
  HOLLOW_ELDER_PHASES,
  createHollowElderController
} from "../hollowElderBoss.js";
import { CombatEngine } from "./combatEngine.js";
import { MOB_DEFINITIONS } from "./mobDefinitions.js";
import {
  BLIGHTED_STAG,
  BLIGHT_SPRITE,
  BLIGHT_TREANT,
  ROT_WOLF_PACK,
  THORNFERN,
  chargeLaneSamples,
  laneHitsPoint,
  newMobSpecialState,
  packDamageFactor,
  shouldStagCharge,
  treantMayRegenerate
} from "./mobSpecialBehaviors.js";

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);
const at = (p: LatLon) => ({ lat: p.lat, lon: p.lon });
const REGION = "interior:grove";
const ZONE = "interior:grove:room";

function createEngine(extra: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  // Fake clock, one tick (50 ms) per tick(): telegraphed charges wait for their wall-clock resolveTime.
  let clock = 1_000_000;
  const engine = new CombatEngine({
    now: () => clock,
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    isSharedMobCombat: () => true,
    isMobPlayerAttackAuthorized: () => true,
    ...extra
  });
  const tick = engine.tick.bind(engine);
  engine.tick = () => { clock += 50; tick(); };
  return engine;
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
const rooted = (engine: CombatEngine, id: string) =>
  (engine.entity(id)?.controlEffects ?? []).some((effect) => effect.kind === "rooted");

describe("Grove mob helpers", () => {
  it("caps the rot wolf pack bonus", () => {
    expect(packDamageFactor(0)).toBe(1);
    expect(packDamageFactor(2)).toBeCloseTo(1.24);
    expect(packDamageFactor(50)).toBeCloseTo(1 + ROT_WOLF_PACK.maxBonus);
  });

  it("charges only from range and on cooldown, and the lane catches players on the line", () => {
    const state = newMobSpecialState();
    expect(shouldStagCharge(state, BLIGHTED_STAG.minRangeM - 1, 0)).toBe(false);
    expect(shouldStagCharge(state, 300, 0)).toBe(true);
    state.nextChargeTick = 100;
    expect(shouldStagCharge(state, 300, 99)).toBe(false);
    const samples = chargeLaneSamples(origin, 90, 400);
    expect(laneHitsPoint(samples, east(250))).toBe(true);
    expect(laneHitsPoint(samples, destinationPoint(east(250), BLIGHTED_STAG.widthM * 3, 0))).toBe(false);
  });

  it("treants stop regenerating after a hit or a burn", () => {
    const state = newMobSpecialState();
    expect(treantMayRegenerate(state, 0, 20)).toBe(true);
    state.lastHitTick = 100;
    expect(treantMayRegenerate(state, 150, 20)).toBe(false);
    expect(treantMayRegenerate(state, 100 + 80, 20)).toBe(true);
    state.lastBurnTick = 300;
    expect(treantMayRegenerate(state, 350, 20)).toBe(false);
  });
});

describe("Grove mobs in the combat engine", () => {
  it("rot wolves count packmates on the same target and their bite poisons", () => {
    const engine = createEngine({ random: () => 0.1 });
    addPlayer(engine);
    for (const [index, id] of ["w1", "w2", "w3"].entries()) spawn(engine, "rot_wolf", id, east(60 + index * 5));
    for (const id of ["w1", "w2", "w3"]) expect(engine.directMobTarget(id, "p1")).toBe(true);
    const internals = engine as unknown as { spiderlingAlliesOnTarget(a: unknown, t: unknown): number };
    expect(internals.spiderlingAlliesOnTarget(raw(engine, "w1"), raw(engine, "p1"))).toBe(2);
    for (let tick = 0; tick < 80; tick += 1) engine.tick();
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(100_000);
    expect(engine.entity("p1")!.harmfulStatusIds ?? []).toContain("poison");
  });

  it("a blighted stag telegraphs a charge, hits and knocks back what is in the lane", () => {
    const engine = createEngine({ repositionPlayer: () => true });
    addPlayer(engine);
    spawn(engine, "blighted_stag", "stag", east(350));
    expect(engine.directMobTarget("stag", "p1")).toBe(true);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    let telegraphed = false;
    for (let tick = 0; tick < 60 && !telegraphed; tick += 1) {
      engine.tick();
      telegraphed = raw(engine, "stag").special?.chargeOrigin != null;
    }
    expect(telegraphed).toBe(true);
    const before = distanceMeters(at(engine.entity("stag")!), at(engine.entity("p1")!));
    for (let tick = 0; tick < 30; tick += 1) engine.tick();
    expect(damage).toHaveBeenCalledWith("stag", "p1", expect.any(Number), BLIGHTED_STAG.techniqueId);
    expect(distanceMeters(at(engine.entity("p1")!), origin)).toBeGreaterThan(50);
    expect(before).toBeGreaterThan(BLIGHTED_STAG.minRangeM);
    expect(raw(engine, "stag").special.stunUntilTick).toBe(0);
  });

  it("a stag whose charge misses is stunned and rooted for about two seconds", () => {
    const engine = createEngine({ repositionPlayer: () => true });
    addPlayer(engine);
    spawn(engine, "blighted_stag", "stag", east(350));
    expect(engine.directMobTarget("stag", "p1")).toBe(true);
    for (let tick = 0; tick < 60 && raw(engine, "stag").special?.chargeOrigin == null; tick += 1) engine.tick();
    expect(raw(engine, "stag").special.chargeOrigin).not.toBeNull();
    // The target sidesteps the lane before the charge lands.
    engine.syncPlayer({ playerId: "p1", position: destinationPoint(origin, 800, 0), regionCode: REGION, zoneId: ZONE });
    for (let tick = 0; tick < 30; tick += 1) engine.tick();
    expect(raw(engine, "stag").special.stunUntilTick).toBeGreaterThan(0);
    expect(rooted(engine, "stag")).toBe(true);
    for (let tick = 0; tick < 60; tick += 1) engine.tick();
    expect(rooted(engine, "stag")).toBe(false);
  });

  it("a thornfern never moves, volleys its target, and poisons melee attackers", () => {
    const engine = createEngine();
    addPlayer(engine);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    spawn(engine, "thornfern", "fern", east(60));
    engine.startAttack({ attackerId: "p1", targetEntityId: "fern", requestId: "r", accountId: "a", connectionId: "c" });
    const start = at(engine.entity("fern")!);
    for (let tick = 0; tick < 120; tick += 1) engine.tick();
    expect(distanceMeters(at(engine.entity("fern")!), start)).toBeLessThan(1);
    expect(damage).toHaveBeenCalledWith("fern", "p1", expect.any(Number), THORNFERN.techniqueId);
    expect(engine.entity("p1")!.harmfulStatusIds ?? []).toContain("poison");
  });

  it("a blight treant slam roots nearby players, and it regenerates unless recently hit", () => {
    const engine = createEngine();
    addPlayer(engine, east(80));
    spawn(engine, "blight_treant", "treant", origin);
    expect(engine.directMobTarget("treant", "p1")).toBe(true);
    for (let tick = 0; tick < 5; tick += 1) engine.tick();
    expect(rooted(engine, "p1")).toBe(true);

    const max = engine.entity("treant")!.maxHealth;
    raw(engine, "treant").currentHealth = Math.round(max * 0.5);
    const afterRegen = () => engine.entity("treant")!.currentHealth;
    for (let tick = 0; tick < 45; tick += 1) engine.tick();
    expect(afterRegen()).toBeGreaterThan(Math.round(max * 0.5));

    engine.applyScriptedDamage("p1", "treant", 5, "test-hit");
    const wounded = afterRegen();
    for (let tick = 0; tick < 60; tick += 1) engine.tick();
    expect(afterRegen()).toBe(wounded);
    for (let tick = 0; tick < 80; tick += 1) engine.tick();
    expect(afterRegen()).toBeGreaterThan(wounded);
    expect(BLIGHT_TREANT.slamRadiusM).toBeGreaterThan(100);
  });

  it("a blight sprite bursts into a poison cloud that ticks damage and poison", () => {
    const engine = createEngine();
    addPlayer(engine);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    spawn(engine, "blight_sprite", "sprite", east(60));
    expect(engine.directMobTarget("sprite", "p1")).toBe(true);
    for (let tick = 0; tick < 100; tick += 1) engine.tick();
    expect(engine.entity("sprite")?.lifeState ?? "defeated").not.toBe("alive");
    expect(damage).toHaveBeenCalledWith(expect.any(String), "p1", expect.any(Number), BLIGHT_SPRITE.techniqueId);
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(100_000);
    expect(engine.entity("p1")!.harmfulStatusIds ?? []).toContain("poison");
  });
});

describe("Hollow Elder", () => {
  const definition = {
    id: "hollow_elder", revision: 1, archetypeKey: "hollow_elder" as const,
    controllerId: "hollow_elder", rewardPolicy: { id: "hollow_elder", minimumContribution: 1 }
  };
  function make(state: { ratio: number; sprites: string[]; heals: number[]; clouds: number[] }, now: () => number) {
    return new BossEncounter({
      encounterId: "i:r:elder:1:boss",
      definition,
      host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "heart", encounterId: "elder:1:boss", participantIds: ["p1"] }),
      mobEntityId: "mob:elder",
      controller: createHollowElderController({
        bossHealthRatio: () => state.ratio,
        bossPosition: () => east(500),
        playerPosition: () => origin,
        livingSprites: () => state.sprites,
        healBoss: (_id, fraction) => { state.heals.push(fraction); },
        spawnSporeCloud: (_id, _center, _radius, _delay, duration) => { state.clouds.push(duration); }
      }),
      initialState: "active",
      now
    });
  }

  it("telegraphs three root-slam lanes radiating from the boss and a lingering spore cloud", () => {
    let now = 1_000;
    const state = { ratio: 1, sprites: [] as string[], heals: [] as number[], clouds: [] as number[] };
    const encounter = make(state, () => now);
    encounter.activate();
    now += HOLLOW_ELDER.firstSlamDelayMs;
    encounter.tick(now);
    const lanes = (encounter.projection(now).activeCasts ?? []).filter((cast) => cast.abilityId === HOLLOW_ELDER_ABILITIES.rootSlam);
    expect(lanes).toHaveLength(3);
    const facings = lanes.map((cast) => (cast.geometry as { facingDegrees: number }).facingDegrees).sort((a, b) => a - b);
    expect(facings[1]! - facings[0]!).toBeCloseTo(120, 5);
    expect(lanes.every((cast) => cast.geometry.kind === "line")).toBe(true);
    now = 1_000 + HOLLOW_ELDER.firstSporeDelayMs;
    encounter.tick(now);
    expect(state.clouds).toEqual([HOLLOW_ELDER.sporeDurationMs]);
  });

  it("at 50% it draws in the corruption and heals if the sprites that were alive are not cleared in time", () => {
    const run = (clear: boolean, sprites: string[]) => {
      let now = 1_000;
      const state = { ratio: 0.5, sprites, heals: [] as number[], clouds: [] as number[] };
      const encounter = make(state, () => now);
      encounter.activate();
      now += 100;
      encounter.tick(now);
      expect(encounter.phase).toBe(HOLLOW_ELDER_PHASES.normal);
      now += HOLLOW_ELDER.drawInStartDelayMs;
      encounter.tick(now);
      const channeling = encounter.phase === HOLLOW_ELDER_PHASES.drawingIn;
      if (clear) state.sprites = [];
      now += HOLLOW_ELDER.drawInWindowMs;
      encounter.tick(now);
      return { channeling, heals: state.heals, phase: encounter.phase };
    };
    const ignored = run(false, ["s1", "s2"]);
    expect(ignored.channeling).toBe(true);
    expect(ignored.heals).toEqual([HOLLOW_ELDER.drawInHealFraction]);
    expect(ignored.phase).toBe(HOLLOW_ELDER_PHASES.normal);
    const cleared = run(true, ["s1", "s2"]);
    expect(cleared.channeling).toBe(true);
    expect(cleared.heals).toEqual([]);
    const none = run(false, []);
    expect(none.channeling).toBe(false);
    expect(none.heals).toEqual([]);
  });

  it("drops gold; its Elder Acorns come from the per-member completion reward", () => {
    const rewards = MOB_DEFINITIONS.hollow_elder.rewards;
    expect(rewards.items).toEqual([]);
    expect(rewards.gold).toBeGreaterThan(0);
    expect(MOB_DEFINITIONS.hollow_elder.boss).toBe(true);
  });

  it("runs through the boss runtime: a slam lane damages and roots the player in it", () => {
    const engine = createEngine();
    addPlayer(engine);
    const boss = spawn(engine, "hollow_elder", "boss:elder", east(200));
    let now = 1_000;
    const manager = createCoreBossRuntime(engine, 40, () => now);
    manager.create({
      encounterId: "i:r:elder:1:boss",
      definitionId: "hollow_elder",
      host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "heart", encounterId: "elder:1:boss", participantIds: ["p1"] }),
      mobEntityId: boss.entityId,
      initialState: "active",
      lifeGeneration: 1
    });
    now += HOLLOW_ELDER.firstSlamDelayMs;
    manager.tick(now);
    expect(rooted(engine, "p1")).toBe(false);
    now += HOLLOW_ELDER.slamTelegraphMs;
    manager.tick(now);
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(100_000);
    expect(rooted(engine, "p1")).toBe(true);
  });
});

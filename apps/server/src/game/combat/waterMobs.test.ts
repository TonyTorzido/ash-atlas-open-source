import { describe, expect, it } from "vitest";
import {
  MOB_SPAWN_RULES,
  distanceMeters,
  mobMovementHabitat,
  moveToward,
  type LatLon,
  type MobArchetypeKey
} from "@ash-atlas/shared";

import { packageIdForPosition, zoneIdForPosition } from "../spatialZones.js";
import { CombatEngine, type MobSurfaceLookup } from "./combatEngine.js";
import { MOB_AI_PROFILES, MOB_DEFINITIONS } from "./mobDefinitions.js";
import { DARTER_BURST, GATE_WARDEN_RIFT } from "./mobGimmicks.js";

/** Water game phase B: the water mobs' behaviours and the mob habitat rule. */

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);
const REGION = packageIdForPosition(origin);
const ZONE = zoneIdForPosition(origin);
const WATER_MOBS = [
  "shellback", "darter", "ink_pool", "drowned_citizen", "tide_wraith", "gate_warden", "drowned_cultist"
] as const satisfies readonly MobArchetypeKey[];

function createEngine(extra: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    isSharedMobCombat: () => true,
    isMobPlayerAttackAuthorized: () => true,
    repositionPlayer: () => true,
    ...extra
  });
}

function addPlayer(engine: CombatEngine, position: LatLon = origin, damage = 1): void {
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: REGION, zoneId: ZONE, position, accountId: "a-p1", connectionId: "c-p1",
    profile: { playerId: "p1", maxHealth: 1_000_000, currentHealth: 1_000_000, baseAttackDamage: damage }
  });
}

function spawn(engine: CombatEngine, archetype: MobArchetypeKey, id: string, position: LatLon, packId: string | null = null) {
  return engine.spawnMob({
    entityId: id, archetype, position, homePosition: position, regionCode: REGION, zoneId: ZONE, worldAi: false, packId
  });
}

type RawEntity = Record<string, any>;
const entities = (engine: CombatEngine) =>
  (engine as unknown as { entities: Map<string, RawEntity> }).entities;
const raw = (engine: CombatEngine, id: string) => entities(engine).get(id)!;
const run = (engine: CombatEngine, ticks: number) => { for (let tick = 0; tick < ticks; tick += 1) engine.tick(); };
const hit = (engine: CombatEngine, targetId: string, requestId = `hit-${targetId}`) =>
  engine.startAttack({ attackerId: "p1", targetEntityId: targetId, requestId, accountId: "a-p1", connectionId: "c-p1" });
const along = (engine: CombatEngine, id: string) => distanceMeters(origin, raw(engine, id).position as LatLon);

/** Water everywhere east of `shoreM`; land west of it; or nothing known. */
function shoreLookup(shoreM: number | null, prewarmed: Array<[LatLon, LatLon]> = []): MobSurfaceLookup {
  const shore = shoreM === null ? null : east(shoreM).lon;
  return {
    surfaceAt: (position) => shore === null ? null : position.lon > shore ? "water" : "land",
    prewarm: (from, to) => { prewarmed.push([from, to]); }
  };
}

describe("water mob spawning", () => {
  it("spawns every water mob only on water surfaces, so each one is a water-habitat mob", () => {
    for (const kind of WATER_MOBS) {
      const rules = MOB_SPAWN_RULES[kind];
      expect(rules.length, kind).toBeGreaterThan(0);
      for (const rule of rules) expect(rule.surface, kind).not.toBe("land");
      expect(mobMovementHabitat(kind), kind).toBe("water");
    }
    expect(MOB_SPAWN_RULES.shellback.map((rule) => rule.surface).sort()).toEqual(["lake", "ocean"]);
    expect(mobMovementHabitat("wolf")).toBe("land");
    expect(mobMovementHabitat("squid")).toBe("water");
    // Dungeon-only mobs have no spawn rules and move anywhere.
    expect(mobMovementHabitat("sewer_rat")).toBeNull();
  });

  it("keeps the levels in the 14-25 sea band and gives each mob its own drops", () => {
    for (const kind of WATER_MOBS) {
      expect(MOB_DEFINITIONS[kind].level, kind).toBeGreaterThanOrEqual(14);
      expect(MOB_DEFINITIONS[kind].level, kind).toBeLessThanOrEqual(25);
    }
    const chance = (kind: MobArchetypeKey, itemId: string) =>
      MOB_DEFINITIONS[kind].rewards.chanceItems.find((reward) => reward.itemId === itemId)?.probability ?? 0;
    expect(MOB_DEFINITIONS.shellback.rewards.items).toEqual([{ itemId: "shellback_plate", quantity: 2 }]);
    expect(chance("darter", "shellback_plate")).toBe(0.15);
    expect(MOB_DEFINITIONS.ink_pool.rewards.items).toEqual([{ itemId: "crude_oil", quantity: 1 }]);
    expect(chance("tide_wraith", "abyssal_orb")).toBe(0.02);
    expect(chance("gate_warden", "abyssal_orb")).toBe(0.05);
    for (const kind of ["drowned_citizen", "drowned_cultist"] as const) {
      expect(MOB_DEFINITIONS[kind].rewards.items, kind).toEqual([]);
      expect(MOB_DEFINITIONS[kind].rewards.chanceItems, kind).toEqual([]);
    }
    // Herd and pack: one hit engages the group. The citizen never fights back.
    expect(MOB_AI_PROFILES.shellback.onAttacked?.group).toBe("exact_pack");
    expect(MOB_AI_PROFILES.shellback.proactive).toBeNull();
    expect(MOB_AI_PROFILES.darter.onAttacked?.group).toBe("exact_pack");
    expect(MOB_AI_PROFILES.drowned_citizen.onAttacked).toBeNull();
    expect(MOB_AI_PROFILES.drowned_citizen.proactive).toBeNull();
    expect(MOB_DEFINITIONS.drowned_citizen.retaliates).toBe(false);
    expect(MOB_AI_PROFILES.tide_wraith.proactive?.intent).toBe("combat");
  });
});

describe("water mob behaviours", () => {
  it("a hit on one Shellback brings the whole herd", () => {
    const engine = createEngine();
    addPlayer(engine);
    for (const [index, id] of ["s1", "s2", "s3"].entries()) spawn(engine, "shellback", id, east(60 + index * 20), "herd");
    hit(engine, "s1");
    run(engine, 10);
    for (const id of ["s1", "s2", "s3"]) expect(raw(engine, id).targetEntityId, id).toBe("p1");
  });

  it("a Shellback blunts some hits", () => {
    const lost = (roll: number) => {
      const engine = createEngine({ random: () => roll });
      addPlayer(engine, origin, 50);
      spawn(engine, "shellback", "s1", east(60));
      const before = raw(engine, "s1").currentHealth as number;
      hit(engine, "s1");
      run(engine, 40);
      return before - (raw(engine, "s1").currentHealth as number);
    };
    const blunted = lost(0);
    const clean = lost(0.99);
    expect(clean).toBeGreaterThan(0);
    expect(blunted).toBeGreaterThan(0);
    expect(blunted).toBeLessThan(clean);
  });

  it("a Darter bursts into a damaging cloud when it dies", () => {
    const engine = createEngine();
    addPlayer(engine, origin, 100_000);
    spawn(engine, "darter", "mob", east(60));
    hit(engine, "mob");
    run(engine, 40);
    expect(engine.entity("mob")).toBeNull();
    const cast = engine.entity("p1")!.telegraphs?.find((telegraph) => telegraph.abilityId === DARTER_BURST.techniqueId);
    expect(cast?.geometry).toMatchObject({ kind: "circle", radiusM: DARTER_BURST.radiusM });
  });

  it("an Ink Pool drifts once it is fighting", () => {
    const engine = createEngine({ random: () => 0.5 });
    addPlayer(engine);
    spawn(engine, "ink_pool", "mob", east(60));
    expect(engine.directMobTarget("mob", "p1")).toBe(true);
    const start = { ...raw(engine, "mob").position } as LatLon;
    run(engine, 200);
    expect(distanceMeters(start, raw(engine, "mob").position as LatLon)).toBeGreaterThan(1);
  });

  it("a Gate Warden blinks away once and its rift calls a bounded number of cultists that fade", () => {
    const engine = createEngine();
    addPlayer(engine, origin, 1);
    spawn(engine, "gate_warden", "warden", east(60));
    const warden = raw(engine, "warden");
    warden.currentHealth = Math.floor(warden.maxHealth * GATE_WARDEN_RIFT.healthRatio);
    const startM = along(engine, "warden");
    const cultists = () => [...entities(engine).values()]
      .filter((entity) => entity.kind === "mob" && entity.archetypeKey === "drowned_cultist" && entity.lifeState === "alive");
    hit(engine, "warden");
    let blinkedM = startM;
    for (let tick = 0; tick < 40 && cultists().length === 0; tick += 1) {
      engine.tick();
      blinkedM = along(engine, "warden");
    }
    expect(cultists()).toHaveLength(GATE_WARDEN_RIFT.cultists);
    for (const cultist of cultists()) expect(cultist.targetEntityId).toBe("p1");
    // The blink lands away from the attacker, at the rift's far side.
    expect(blinkedM).toBeGreaterThan(startM + GATE_WARDEN_RIFT.blinkDistanceM / 2);
    run(engine, 40);
    expect(raw(engine, "warden").targetEntityId).toBe("p1");
    // More hits below the threshold never open a second rift.
    run(engine, 200);
    expect(cultists().length).toBeLessThanOrEqual(GATE_WARDEN_RIFT.cultists);
    run(engine, Math.ceil(GATE_WARDEN_RIFT.cultistLifetimeMs / 50) + 5);
    expect(cultists()).toHaveLength(0);
  });
});

describe("mob habitat", () => {
  it("stops a land mob at the shore", () => {
    const engine = createEngine();
    const prewarmed: Array<[LatLon, LatLon]> = [];
    engine.setMobSurfaceLookup(shoreLookup(120, prewarmed));
    addPlayer(engine, east(240));
    spawn(engine, "bear", "mob", origin);
    expect(engine.directMobTarget("mob", "p1")).toBe(true);
    run(engine, 400);
    expect(prewarmed.length).toBeGreaterThan(0);
    expect(along(engine, "mob")).toBeGreaterThan(60);
    expect(along(engine, "mob")).toBeLessThanOrEqual(120);
  });

  it("keeps a water mob in the water", () => {
    const engine = createEngine();
    engine.setMobSurfaceLookup(shoreLookup(120));
    addPlayer(engine, origin);
    spawn(engine, "squid", "mob", east(240));
    expect(engine.directMobTarget("mob", "p1")).toBe(true);
    run(engine, 400);
    expect(along(engine, "mob")).toBeLessThan(180);
    expect(along(engine, "mob")).toBeGreaterThanOrEqual(120);
  });

  it("moves normally where the surface is unknown", () => {
    const engine = createEngine();
    engine.setMobSurfaceLookup(shoreLookup(null));
    addPlayer(engine, east(240));
    spawn(engine, "skeleton", "mob", origin);
    expect(engine.directMobTarget("mob", "p1")).toBe(true);
    run(engine, 400);
    expect(along(engine, "mob")).toBeGreaterThan(120);
  });
});

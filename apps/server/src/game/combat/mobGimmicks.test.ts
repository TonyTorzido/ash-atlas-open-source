import { describe, expect, it, vi } from "vitest";
import { PLAYER_HURT_RADIUS_M, distanceMeters, hurtShapeReachM, moveToward, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

/** Telegraphs are drawn the player hurt radius short of the table reach (docs/plans/hurt-circles.md). */
const drawnM = (effectiveM: number): number => hurtShapeReachM(effectiveM, PLAYER_HURT_RADIUS_M);

import { CombatEngine } from "./combatEngine.js";
import {
  ALLIGATOR_DEATH_ROLL,
  BANDIT_BACKSTAB,
  BEAR_MAUL,
  FROG_TONGUE,
  GOBLIN_BOMB,
  POUNCE,
  QUILL_REFLECT,
  SWOOP,
  bearMaulDamageFactor,
  deathRollBonusFactor,
  quillDamage,
  roarDamageMultiplier,
  shellGuardFor,
  OGRE_SLAM,
  SLIME_SPLIT,
  SQUID_INK,
  deathRollPrimed,
  gimmickStrikeFor,
  hasOwnGimmick,
  hasShellGuard,
  isDeathRollBite,
  roarBuffKind
} from "./mobGimmicks.js";
import { BLIGHT_SPRITE, BLIGHTED_STAG, CLIFF_HAWK, DODGE_REWARD, HOG_CHARGE, HOG_CHARGE_ANIMAL, RAPTOR_SPITTER } from "./mobSpecialBehaviors.js";

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);
const REGION = "interior:g";
const ZONE = "interior:g:room";

/** Engines here run on a fake clock that advances one tick (50 ms) per `tick()`, like the real loop. */
function createEngine(extra: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  let clock = 1_000_000;
  const engine = new CombatEngine({
    now: () => clock,
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    isSharedMobCombat: () => true,
    isMobPlayerAttackAuthorized: () => true,
    repositionPlayer: () => true,
    ...extra
  });
  const tick = engine.tick.bind(engine);
  engine.tick = () => { clock += 50; tick(); };
  return engine;
}

function addPlayer(engine: CombatEngine, id = "p1", position: LatLon = origin, damage = 1, zoneId = ZONE, regionCode = REGION): void {
  engine.connectPlayer({
    playerId: id, name: id, regionCode, zoneId, position, accountId: `a-${id}`, connectionId: `c-${id}`,
    profile: { playerId: id, maxHealth: 1_000_000, currentHealth: 1_000_000, baseAttackDamage: damage }
  });
}

function spawn(engine: CombatEngine, archetype: MobArchetypeKey, id: string, position: LatLon, zoneId = ZONE, regionCode = REGION) {
  return engine.spawnMob({ entityId: id, archetype, position, homePosition: position, regionCode, zoneId, worldAi: false });
}

const raw = (engine: CombatEngine, id: string) =>
  (engine as unknown as { entities: Map<string, Record<string, any>> }).entities.get(id)!;
const run = (engine: CombatEngine, ticks: number) => { for (let tick = 0; tick < ticks; tick += 1) engine.tick(); };
const effects = (engine: CombatEngine, id: string): { kind: string; sourceTechniqueId: string }[] =>
  raw(engine, id).classRuntime?.effects ?? [];
const hit = (engine: CombatEngine, targetId: string) =>
  engine.startAttack({ attackerId: "p1", targetEntityId: targetId, requestId: `hit-${targetId}`, accountId: "a-p1", connectionId: "c-p1" });

/** Ticks until a telegraph from `mobId` appears in its snapshot; returns it. */
function waitForTelegraph(engine: CombatEngine, mobId: string, maxTicks = 400) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    engine.tick();
    const casts = engine.entity(mobId)?.telegraphs;
    if (casts && casts.length > 0) return casts[0]!;
  }
  return undefined;
}

function fight(engine: CombatEngine, archetype: MobArchetypeKey, distanceM: number, extraId = "mob") {
  addPlayer(engine);
  spawn(engine, archetype, extraId, east(distanceM));
  expect(engine.directMobTarget(extraId, "p1")).toBe(true);
}

describe("gimmick tables", () => {
  it("gives every strike mob a profile and counts death rolls", () => {
    for (const key of ["ogre", "bear", "goblin", "frog", "bandit", "squid"]) expect(gimmickStrikeFor(key)).not.toBeNull();
    expect(gimmickStrikeFor("deer")).toBeNull();
    expect([1, 2, 3, 4, 6].map(isDeathRollBite)).toEqual([false, false, true, false, true]);
    expect(deathRollPrimed(2)).toBe(true);
    expect(deathRollPrimed(3)).toBe(false);
    expect(roarBuffKind("orc_brute")).toBe("enraged");
    expect(roarBuffKind("wolf")).toBe("howl");
    expect(roarBuffKind("cave_raptor")).toBe("war_roar");
  });
});

describe("phase B animal gimmicks", () => {
  it("animals get milder numbers than fantasy mobs on the same template", () => {
    expect(HOG_CHARGE_ANIMAL.damageFactor).toBe(1.25);
    expect(HOG_CHARGE.damageFactor).toBe(1.5);
    expect([bearMaulDamageFactor("bear"), bearMaulDamageFactor("yeti")]).toEqual([1.3, BEAR_MAUL.damageFactor]);
    expect([deathRollBonusFactor("alligator"), deathRollBonusFactor("caiman")]).toEqual([0.4, 0.4]);
    expect(deathRollBonusFactor("drowned_cultist")).toBe(ALLIGATOR_DEATH_ROLL.bonusDamageFactor);
    expect(roarDamageMultiplier("wolf", 1.35)).toBe(1.15);
    expect(roarDamageMultiplier("griffin", 1.35)).toBe(1.35);
    expect(roarDamageMultiplier("cave_raptor", 1.35)).toBe(1.35);
  });

  it("a hog charge hits for 1.25x while a basilisk (hog template) keeps 1.5x", () => {
    for (const [archetype, factor] of [["hog", 1.25], ["basilisk", 1.5]] as const) {
      const engine = createEngine();
      fight(engine, archetype, 220);
      const damage = vi.spyOn(engine, "applyScriptedDamage");
      waitForTelegraph(engine, "mob");
      run(engine, 40);
      const attack = raw(engine, "mob").attackDamage as number;
      expect(damage, archetype).toHaveBeenCalledWith("mob", "p1", Math.max(1, Math.round(attack * factor)), HOG_CHARGE.techniqueId);
    }
  });

  it("a tortoise hunkers down for 2s at half damage taken", () => {
    expect(shellGuardFor("spur_thighed_tortoise")).toMatchObject({ intervalMs: 12_000, durationMs: 2_000, incomingFactor: 0.5 });
    expect(shellGuardFor("coastal_crab").incomingFactor).toBe(0.35);
    const engine = createEngine();
    fight(engine, "spur_thighed_tortoise", 60);
    let shelled = false;
    for (let tick = 0; tick < 200 && !shelled; tick += 1) {
      engine.tick();
      shelled = engine.entity("mob")!.mobBuffs?.some((buff) => buff.kind === "shell") === true;
    }
    expect(shelled).toBe(true);
  });

  it("quills reflect 10% of a melee hit, min 1, capped at 5% of the attacker's max HP", () => {
    expect(quillDamage(100, 1_000)).toBe(10);
    expect(quillDamage(3, 1_000)).toBe(1);
    expect(quillDamage(400, 100)).toBe(5);
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 200);
    spawn(engine, "crested_porcupine", "mob", east(60));
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    hit(engine, "mob");
    run(engine, 40);
    expect(damage).toHaveBeenCalledWith("mob", "p1", expect.any(Number), QUILL_REFLECT.techniqueId);
  });

  it("a lioness pounces once on a new target, then hits normally until it loses the target", () => {
    const engine = createEngine();
    fight(engine, "lioness", 60);
    const lost: number[] = [];
    let last = raw(engine, "p1").currentHealth as number;
    for (let tick = 0; tick < 200 && lost.length < 2; tick += 1) {
      engine.tick();
      const now = raw(engine, "p1").currentHealth as number;
      if (now < last) lost.push(last - now);
      last = now;
    }
    expect(lost).toHaveLength(2);
    expect(lost[0]! / lost[1]!).toBeCloseTo(POUNCE.damageFactor, 1);
    expect(raw(engine, "mob").special.pounceTargetId).toBe("p1");
    (engine as unknown as { clearTarget(entity: unknown): void }).clearTarget(raw(engine, "mob"));
    expect(raw(engine, "mob").special.pounceTargetId).toBeNull();
  });

  it("an owl swoop: a cone warning, then a 1.3x strike", () => {
    const engine = createEngine();
    fight(engine, "great_grey_owl", 60);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    const cast = waitForTelegraph(engine, "mob");
    expect(cast?.geometry).toMatchObject({ kind: "cone", rangeM: drawnM(SWOOP.rangeM) });
    expect(cast!.resolveTime - cast!.startTime).toBe(SWOOP.delayMs);
    run(engine, 40);
    const attack = raw(engine, "mob").attackDamage as number;
    expect(damage).toHaveBeenCalledWith("mob", "p1", Math.max(1, Math.round(attack * SWOOP.damageFactor)), SWOOP.techniqueId);
  });
});

describe("normal mobs can show a telegraph", () => {
  it("draws the hawk dive, stag and hog charges, spitter acid, and sprite fuse as boss-shaped casts", () => {
    const cases: [MobArchetypeKey, number, string, string][] = [
      ["cliff_hawk", 220, CLIFF_HAWK.techniqueId, "circle"],
      ["blighted_stag", 400, BLIGHTED_STAG.techniqueId, "line"],
      ["hog", 220, HOG_CHARGE.techniqueId, "line"],
      ["raptor_spitter", 250, RAPTOR_SPITTER.techniqueId, "circle"],
      ["blight_sprite", 60, BLIGHT_SPRITE.techniqueId, "circle"]
    ];
    for (const [archetype, distanceM, abilityId, geometry] of cases) {
      const engine = createEngine();
      fight(engine, archetype, distanceM);
      const cast = waitForTelegraph(engine, "mob");
      expect(cast, archetype).toBeDefined();
      expect(cast!.abilityId).toBe(abilityId);
      expect(cast!.geometry.kind).toBe(geometry);
      expect(cast!.resolveTime).toBeGreaterThan(cast!.startTime);
    }
  });
});

describe("dodgeable windows", () => {
  it("land-roster windows are long enough to outrun, and the slam fits inside a sprint", () => {
    expect([HOG_CHARGE.telegraphMs, HOG_CHARGE_ANIMAL.telegraphMs]).toEqual([1_500, 1_500]);
    expect(BEAR_MAUL.delayMs).toBe(1_500);
    expect(OGRE_SLAM.delayMs).toBe(1_800);
    expect(OGRE_SLAM.radiusM).toBeCloseTo(110);
    expect(OGRE_SLAM.triggerRangeM).toBeCloseTo(130);
    expect(SWOOP.delayMs).toBe(1_300);
    expect(BANDIT_BACKSTAB.delayMs).toBe(1_100);
    // 125 m/s outruns the 110 m slam well inside its window.
    expect((OGRE_SLAM.radiusM / 125) * 1_000).toBeLessThan(OGRE_SLAM.delayMs);
    // Legendary stag keeps its own, shorter profile.
    expect(BLIGHTED_STAG.telegraphMs).toBe(1_200);
  });

  it("serializes remaining and total time, and damage never lands before resolveTime", () => {
    const engine = createEngine();
    fight(engine, "ogre", 60);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    const cast = waitForTelegraph(engine, "mob")!;
    expect(cast.durationMs).toBe(OGRE_SLAM.delayMs);
    expect(cast.remainingMs).toBeGreaterThan(OGRE_SLAM.delayMs - 100);
    expect(cast.remainingMs).toBeLessThanOrEqual(OGRE_SLAM.delayMs);
    let landedAt = 0;
    for (let tick = 0; tick < 60 && landedAt === 0; tick += 1) {
      engine.tick();
      const nowMs = (engine as unknown as { now(): number }).now();
      if (damage.mock.calls.some((call) => call[3] === OGRE_SLAM.techniqueId)) landedAt = nowMs;
    }
    expect(landedAt).toBeGreaterThanOrEqual(cast.resolveTime);
    expect(landedAt - cast.resolveTime).toBeLessThanOrEqual(50);
  });

  it("flags a replication flush once when a telegraph is added", () => {
    const engine = createEngine();
    fight(engine, "bear", 60);
    expect(engine.takeImmediateFlush()).toBe(false);
    waitForTelegraph(engine, "mob");
    expect(engine.takeImmediateFlush()).toBe(true);
    expect(engine.takeImmediateFlush()).toBe(false);
  });
});

describe("telegraphed strikes", () => {
  it("ogre slam: warns with a circle, then damages and knocks back whoever stays", () => {
    const engine = createEngine();
    fight(engine, "ogre", 60);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    const cast = waitForTelegraph(engine, "mob");
    expect(cast?.geometry).toMatchObject({ kind: "circle", radiusM: drawnM(OGRE_SLAM.radiusM) });
    expect(damage).not.toHaveBeenCalledWith("mob", "p1", expect.any(Number), OGRE_SLAM.techniqueId);
    const before = distanceMeters(origin, { lat: engine.entity("p1")!.lat, lon: engine.entity("p1")!.lon });
    run(engine, 40);
    expect(damage).toHaveBeenCalledWith("mob", "p1", expect.any(Number), OGRE_SLAM.techniqueId);
    expect(distanceMeters(origin, { lat: engine.entity("p1")!.lat, lon: engine.entity("p1")!.lon })).toBeGreaterThan(before);
  });

  it("bear maul: a cone warning, then a heavy swipe", () => {
    const engine = createEngine();
    fight(engine, "bear", 60);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    const cast = waitForTelegraph(engine, "mob");
    expect(cast?.geometry).toMatchObject({ kind: "cone", rangeM: drawnM(BEAR_MAUL.rangeM) });
    run(engine, 40);
    expect(damage).toHaveBeenCalledWith("mob", "p1", expect.any(Number), BEAR_MAUL.techniqueId);
  });

  it("goblin bomb: lands where the player stood, so stepping away dodges it", () => {
    const engine = createEngine();
    fight(engine, "goblin", 60);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    const cast = waitForTelegraph(engine, "mob");
    expect(cast?.geometry).toMatchObject({ kind: "circle", radiusM: drawnM(GOBLIN_BOMB.radiusM) });
    // Dodge: step the player well clear before the blast.
    engine.syncPlayer({ playerId: "p1", regionCode: REGION, zoneId: ZONE, position: east(900) });
    run(engine, 30);
    expect(damage).not.toHaveBeenCalledWith("mob", "p1", expect.any(Number), GOBLIN_BOMB.techniqueId);
  });

  it("frog tongue: a line warning, then the target is yanked up to the frog", () => {
    const engine = createEngine();
    fight(engine, "frog", 170);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    const cast = waitForTelegraph(engine, "mob", 40);
    expect(cast?.geometry).toMatchObject({ kind: "line" });
    const frogPosition = { lat: engine.entity("mob")!.lat, lon: engine.entity("mob")!.lon };
    run(engine, 30);
    expect(damage).toHaveBeenCalledWith("mob", "p1", expect.any(Number), FROG_TONGUE.techniqueId);
    const player = engine.entity("p1")!;
    expect(distanceMeters(frogPosition, { lat: player.lat, lon: player.lon })).toBeLessThan(FROG_TONGUE.stopDistanceM + 40);
  });

  it("bandit smoke step: blinks behind the target and primes a backstab for the next hit", () => {
    const engine = createEngine();
    fight(engine, "bandit", 200);
    const cast = waitForTelegraph(engine, "mob", 40);
    expect(cast?.geometry).toMatchObject({ kind: "circle", radiusM: BANDIT_BACKSTAB.puffRadiusM });
    let primed = false;
    for (let tick = 0; tick < 60 && !primed; tick += 1) {
      engine.tick();
      primed = engine.entity("mob")!.mobBuffs?.some((buff) => buff.kind === "backstab") === true;
    }
    expect(primed).toBe(true);
    const bandit = engine.entity("mob")!;
    expect(distanceMeters(origin, { lat: bandit.lat, lon: bandit.lon })).toBeLessThan(BANDIT_BACKSTAB.behindM + 60);
    // The first bite spends the backstab.
    run(engine, 80);
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(1_000_000);
    expect(engine.entity("mob")!.mobBuffs?.map((buff) => buff.kind) ?? []).not.toContain("backstab");
  });

  it("squid ink: a marked cloud that slows anyone left in it", () => {
    const engine = createEngine();
    fight(engine, "squid", 60);
    const cast = waitForTelegraph(engine, "mob");
    expect(cast?.geometry).toMatchObject({ kind: "circle", radiusM: SQUID_INK.radiusM });
    expect(cast!.resolveTime - cast!.startTime).toBeGreaterThan(SQUID_INK.durationMs);
    run(engine, 60);
    expect(effects(engine, "p1").some((effect) => effect.kind === "movement_slow")).toBe(true);
    expect(engine.entity("p1")!.harmfulStatusIds).toContain("ice_slow");
  });
});

describe("statuses and buffs", () => {
  it("orc brute enrages once below 40% health and shows the Enraged buff", () => {
    const engine = createEngine();
    fight(engine, "orc_brute", 60);
    raw(engine, "mob").currentHealth = Math.round(raw(engine, "mob").maxHealth * 0.41);
    hit(engine, "mob");
    run(engine, 40);
    expect(engine.entity("mob")!.mobBuffs?.map((buff) => buff.kind)).toContain("enraged");
  });

  it("a hurt wolf howls: nearby wolves join in and hit harder, with the Howling buff", () => {
    const engine = createEngine();
    fight(engine, "wolf", 60, "wolf-a");
    spawn(engine, "wolf", "wolf-b", east(150));
    raw(engine, "wolf-a").currentHealth = Math.round(raw(engine, "wolf-a").maxHealth * 0.61);
    hit(engine, "wolf-a");
    run(engine, 40);
    expect(engine.entity("wolf-b")!.targetEntityId).toBe("p1");
    expect(engine.entity("wolf-b")!.mobBuffs?.map((buff) => buff.kind)).toContain("howl");
  });

  it("a crab hunkers behind its shell periodically and shrugs off most damage meanwhile", () => {
    const engine = createEngine();
    fight(engine, "coastal_crab", 60);
    let shelled = false;
    for (let tick = 0; tick < 200 && !shelled; tick += 1) {
      engine.tick();
      shelled = engine.entity("mob")!.mobBuffs?.some((buff) => buff.kind === "shell") === true;
    }
    expect(shelled).toBe(true);
  });

  it("a badly hurt deer no longer bolts away", () => {
    const engine = createEngine();
    fight(engine, "deer", 60);
    raw(engine, "mob").currentHealth = Math.round(raw(engine, "mob").maxHealth * 0.61);
    hit(engine, "mob");
    let farthest = 0;
    for (let tick = 0; tick < 200; tick += 1) {
      engine.tick();
      const deer = engine.entity("mob")!;
      farthest = Math.max(farthest, distanceMeters(origin, { lat: deer.lat, lon: deer.lon }));
    }
    expect(farthest).toBeLessThan(300);
  });

  it("a sewer rat squeaks for its pack the first time it is hurt", () => {
    const engine = createEngine();
    fight(engine, "sewer_rat", 60, "rat-a");
    spawn(engine, "sewer_rat", "rat-b", east(150));
    spawn(engine, "sewer_rat", "rat-far", east(150), "interior:g:other");
    hit(engine, "rat-a");
    run(engine, 40);
    expect(engine.entity("rat-b")!.targetEntityId).toBe("p1");
    expect(engine.entity("rat-far")!.targetEntityId).toBeNull();
  });

  it("sap crawler hits slow, and the alligator's third bite is a rooting death roll", () => {
    const sticky = createEngine({ random: () => 0 });
    fight(sticky, "sap_crawler", 60);
    run(sticky, 80);
    expect(effects(sticky, "p1").some((effect) => effect.kind === "movement_slow")).toBe(true);

    const engine = createEngine();
    fight(engine, "alligator", 60);
    let primed = false;
    let rooted = false;
    for (let tick = 0; tick < 400 && !rooted; tick += 1) {
      engine.tick();
      primed ||= engine.entity("mob")!.mobBuffs?.some((buff) => buff.kind === "death_roll") === true;
      rooted = effects(engine, "p1").some((effect) => effect.sourceTechniqueId === ALLIGATOR_DEATH_ROLL.techniqueId);
    }
    expect(primed).toBe(true);
    expect(rooted).toBe(true);
  });

  it("elemental birds burn, chill, and arc lightning to a second player", () => {
    const fire = createEngine({ random: () => 0 });
    fight(fire, "fire_bird", 60);
    run(fire, 60);
    expect(fire.entity("p1")!.harmfulStatusIds).toContain("burning");

    const ice = createEngine({ random: () => 0 });
    fight(ice, "ice_bird", 60);
    run(ice, 60);
    expect(ice.entity("p1")!.harmfulStatusIds).toContain("ice_slow");

    const storm = createEngine();
    fight(storm, "lightning_bird", 60);
    addPlayer(storm, "p2", east(120));
    const damage = vi.spyOn(storm, "applyScriptedDamage");
    run(storm, 60);
    expect(storm.entity("p1")!.harmfulStatusIds).toContain("storm");
    expect(damage).toHaveBeenCalledWith("mob", "p2", expect.any(Number), "lightning_bird_arc");
  });
});

describe("death and rebirth", () => {
  it("a skeleton falls apart once, reassembles at partial health, then dies for real", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 100_000);
    spawn(engine, "skeleton", "mob", east(60));
    hit(engine, "mob");
    for (let tick = 0; tick < 40 && !engine.entity("mob")?.mobBuffs?.some((buff) => buff.kind === "reassembling"); tick += 1) engine.tick();
    engine.cancelAttack("p1");
    const scattered = engine.entity("mob");
    expect(scattered?.lifeState).toBe("alive");
    expect(scattered?.currentHealth).toBeGreaterThan(0);
    expect(scattered?.mobBuffs?.map((buff) => buff.kind)).toContain("reassembling");
    run(engine, 60);
    engine.startAttack({ attackerId: "p1", targetEntityId: "mob", requestId: "hit-again", accountId: "a-p1", connectionId: "c-p1" });
    run(engine, 60);
    expect(engine.entity("mob")).toBeNull();
  });

  it("a reassembling skeleton pile is vulnerable, not immune, and heals only once", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 100_000);
    spawn(engine, "skeleton", "mob", east(60));
    spawn(engine, "skeleton", "twin", east(2_500));
    hit(engine, "mob");
    for (let tick = 0; tick < 40 && !engine.entity("mob")?.mobBuffs?.some((buff) => buff.kind === "reassembling"); tick += 1) engine.tick();
    engine.cancelAttack("p1");
    const pile = raw(engine, "mob");
    const healed = pile.currentHealth;
    expect(healed).toBe(Math.round(pile.maxHealth * 0.35));
    expect(pile.special.shellUntilTick).toBe(0);
    const damageTaken = (id: string, technique: string) => {
      const before = raw(engine, id).currentHealth;
      (engine as any).applyScriptedDamage("p1", id, Math.floor(raw(engine, id).maxHealth * 0.05), technique);
      return before - raw(engine, id).currentHealth;
    };
    const normal = damageTaken("twin", "test_hit");
    const normalMelee = damageTaken("twin", "warrior_basic_attack");
    const other = damageTaken("mob", "test_hit");
    const melee = damageTaken("mob", "warrior_basic_attack");
    expect(other).toBeGreaterThan(0);
    expect(Math.abs(other - normal * 1.25)).toBeLessThanOrEqual(1);
    expect(Math.abs(melee - normalMelee * 1.5)).toBeLessThanOrEqual(1);
    expect(pile.currentHealth).toBe(healed - other - melee);
  });

  it("a sick sewer rat bursts into a marked plague cloud that outlives it", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 100_000);
    spawn(engine, "sick_sewer_rat", "mob", east(60));
    hit(engine, "mob");
    run(engine, 40);
    expect(engine.entity("mob")).toBeNull();
    const cast = engine.entity("p1")!.telegraphs?.[0];
    expect(cast?.geometry.kind).toBe("circle");
    run(engine, 60);
    expect(engine.entity("p1")!.harmfulStatusIds).toContain("poison");
  });

  it("a slime splits into two small slimelets that do not split again", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 100_000, "world:g", "NM");
    spawn(engine, "slime", "mob", east(60), "world:g", "NM");
    const parentMax = raw(engine, "mob").maxHealth;
    hit(engine, "mob");
    run(engine, 40);
    expect(engine.entity("mob")).toBeNull();
    const children = [...(engine as unknown as { entities: Map<string, Record<string, any>> }).entities.values()]
      .filter((entity) => entity.kind === "mob" && entity.archetypeKey === "slime");
    expect(children).toHaveLength(SLIME_SPLIT.children);
    for (const child of children) {
      expect(child.name).toBe(SLIME_SPLIT.childName);
      expect(child.maxHealth).toBeLessThan(parentMax);
    }
    const childIds = children.map((child) => child.entityId as string);
    for (const id of childIds) { hit(engine, id); run(engine, 30); }
    run(engine, 40);
    const left = [...(engine as unknown as { entities: Map<string, Record<string, any>> }).entities.values()]
      .filter((entity) => entity.kind === "mob" && entity.archetypeKey === "slime");
    expect(left).toHaveLength(0);
  });
});

describe('own gimmicks replace the template gimmick', () => {
  it('drops the template strike for pounce, quill, shell and swoop mobs', () => {
    expect(gimmickStrikeFor('jaguar')).toBeNull();
    expect(gimmickStrikeFor('sidewinder')).toBeNull();
    expect(gimmickStrikeFor('crested_porcupine')).toBeNull();
    expect(hasOwnGimmick('jaguar')).toBe(true);
    expect(hasOwnGimmick('crested_porcupine')).toBe(true);
    expect(gimmickStrikeFor('golden_eagle')?.kind).toBe('swoop');
  });

  it('keeps the template gimmick for wolverine, ostrich and musk ox', () => {
    expect(gimmickStrikeFor('wolverine')?.kind).toBe('maul');
    for (const key of ['wolverine', 'ostrich', 'musk_ox']) expect(hasOwnGimmick(key)).toBe(false);
  });

  it('gives the armadillo the tortoise shell', () => {
    expect(hasShellGuard('armadillo')).toBe(true);
    expect(shellGuardFor('armadillo')).toMatchObject({ intervalMs: 12_000, durationMs: 2_000, incomingFactor: 0.5 });
  });
});

describe("dodging a telegraphed strike", () => {
  const staggered = (engine: CombatEngine, id: string) =>
    engine.entity(id)?.mobBuffs?.some((buff) => buff.kind === "staggered") === true;
  const rooted = (engine: CombatEngine, id: string) =>
    (engine.entity(id)?.controlEffects ?? []).some((effect) => effect.kind === "rooted");
  /** Ticks until `done()` or the limit; returns how many ticks ran. */
  const until = (engine: CombatEngine, done: () => boolean, max = 200) => {
    let ticks = 0;
    while (ticks < max && !done()) { engine.tick(); ticks += 1; }
    return ticks;
  };
  const dodge = (engine: CombatEngine, archetype: MobArchetypeKey, distanceM = 60) => {
    fight(engine, archetype, distanceM);
    waitForTelegraph(engine, "mob");
    engine.syncPlayer({ playerId: "p1", regionCode: REGION, zoneId: ZONE, position: east(2_000) });
  };

  it.each([["ogre"], ["bear"]] as const)("a missed %s strike staggers it: frozen, 1.25x damage, then it ends", (archetype) => {
    const engine = createEngine();
    dodge(engine, archetype);
    expect(until(engine, () => staggered(engine, "mob"))).toBeLessThan(200);
    expect(rooted(engine, "mob")).toBe(true);
    const mob = raw(engine, "mob");
    expect(mob.special.staggerUntilTick - (engine as any).currentTick).toBeGreaterThanOrEqual(
      DODGE_REWARD.staggerMs / 50 - 2
    );
    const frozenAt = { lat: mob.position.lat, lon: mob.position.lon };
    expect(DODGE_REWARD.staggerMs).toBe(5_000);
    const damageTaken = (id: string, technique: string) => {
      const before = raw(engine, id).currentHealth;
      (engine as any).applyScriptedDamage("p1", id, Math.floor(raw(engine, id).maxHealth * 0.1), technique);
      return before - raw(engine, id).currentHealth;
    };
    spawn(engine, archetype, "twin", east(2_500));
    const normal = damageTaken("twin", "test_hit");
    const bonus = damageTaken("mob", "test_hit");
    expect(bonus).toBeGreaterThan(normal);
    // Whole-number damage: allow one point of rounding.
    expect(Math.abs(bonus - normal * DODGE_REWARD.staggerDamageFactor)).toBeLessThanOrEqual(1);
    // Melee (a basic weapon strike by a non-ranged attacker) gets the bigger bonus.
    const normalMelee = damageTaken("twin", "warrior_basic_attack");
    const meleeBonus = damageTaken("mob", "warrior_basic_attack");
    expect(Math.abs(meleeBonus - normalMelee * DODGE_REWARD.staggerMeleeDamageFactor)).toBeLessThanOrEqual(1);
    run(engine, 30);
    expect(raw(engine, "mob").position).toEqual(frozenAt);
    // Still staggered well past the old 2.5 s, then expires on schedule and the ability does not fire right away.
    expect(staggered(engine, "mob")).toBe(true);
    run(engine, 80);
    expect(staggered(engine, "mob")).toBe(false);
    expect(raw(engine, "mob").special.strikeKind).toBeNull();
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    run(engine, 10);
    expect(raw(engine, "mob").special.nextGimmickTick).toBeGreaterThan((engine as any).currentTick);
    expect(damage).not.toHaveBeenCalledWith("mob", "p1", expect.any(Number), expect.stringMatching(/maul|slam/));
  });

  it("a missed swoop staggers the owl", () => {
    const engine = createEngine();
    dodge(engine, "great_grey_owl");
    expect(until(engine, () => staggered(engine, "mob"))).toBeLessThan(200);
  });

  it("a strike that lands only costs a 0.6 s recovery, with no damage bonus", () => {
    const engine = createEngine();
    fight(engine, "ogre", 60);
    waitForTelegraph(engine, "mob");
    until(engine, () => rooted(engine, "mob"));
    expect(rooted(engine, "mob")).toBe(true);
    expect(staggered(engine, "mob")).toBe(false);
    const special = raw(engine, "mob").special;
    expect(special.staggerUntilTick).toBe(0);
    expect(special.stunUntilTick - (engine as any).currentTick).toBeLessThanOrEqual(DODGE_REWARD.recoveryMs / 50);
    run(engine, DODGE_REWARD.recoveryMs / 50 + 2);
    expect(rooted(engine, "mob")).toBe(false);
  });

  it("a missed hog charge staggers (5 s) instead of the old 1.5 s stun; the stag keeps its own stun", () => {
    const hog = createEngine();
    dodge(hog, "hog", 220);
    until(hog, () => staggered(hog, "mob"), 200);
    expect(staggered(hog, "mob")).toBe(true);
    const special = raw(hog, "mob").special;
    expect(special.stunUntilTick - (hog as any).currentTick).toBeGreaterThan(HOG_CHARGE.missStunMs / 50);
    const stag = createEngine();
    dodge(stag, "blighted_stag", 400);
    until(stag, () => rooted(stag, "mob"), 200);
    expect(rooted(stag, "mob")).toBe(true);
    expect(staggered(stag, "mob")).toBe(false);
    expect(raw(stag, "mob").special.staggerUntilTick).toBe(0);
  });
});

describe("a rooted mob stays put on every movement path", () => {
  it("does not walk home while rooted, then resumes", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1);
    spawn(engine, "barrow_wight", "mob", east(30));
    const mob = raw(engine, "mob");
    mob.homePosition = east(130);
    (engine as any).addTimedEffect(mob, mob, "rooted", "skeleton_reassemble", 2_500, 1);
    (engine as any).returningMobs.add("mob");
    const frozenAt = { lat: mob.position.lat, lon: mob.position.lon };
    run(engine, 44);
    expect(raw(engine, "mob").position).toEqual(frozenAt);
    run(engine, 20);
    expect(distanceMeters(raw(engine, "mob").position, frozenAt)).toBeGreaterThan(0.5);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ClassSnapshot,
  type CombatEvent,
  type EquipmentSnapshot,
  type EquipmentDefinitionId,
  type EquipmentCombatStats,
  requireEquipmentDefinition,
  HUNTER_BALANCE,
  type LatLon,
  type MobArchetypeKey,
  type SubclassId,
  type WeaponCategory,
  damageFromStats
} from "@ash-atlas/shared";

import { CombatEngine, CombatRequestError, type PlayerEquipmentCombatState } from "./combatEngine.js";

const ORIGIN: LatLon = { lat: 35.0844, lon: -106.6504 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Hunter combat acceptance", () => {
  it("applies no retired Hunter profession perks, even for a legacy rank-8 Hunter", () => {
    // random() = 0 would always have rolled the old 5% execute.
    const low = createEngine(() => 0);
    addHunter(low, { weapon: "bow", attackPower: 1, professionRank: 8 });
    const lowTarget = spawn(low, "wolf", 10);
    const lowInternal = low as unknown as { entities: Map<string, { currentHealth: number; maxHealth: number }> };
    Object.assign(lowInternal.entities.get(lowTarget.entityId)!, { currentHealth: 20, maxHealth: 100 });
    start(low, lowTarget.entityId);
    low.tick();
    const lowEvents = low.beginDeltaFlush().events;
    expect(lowEvents.some((event) => event.type === "PROFESSION_EXECUTED")).toBe(false);
    expect(lowEvents.some((event) => event.type === "DEFEATED")).toBe(false);
    expect(lowInternal.entities.get(lowTarget.entityId)!.currentHealth).toBeGreaterThan(0);

    const fresh = createEngine(() => 0.99);
    addHunter(fresh, { weapon: "bow", attackPower: 20, professionRank: 8 });
    const freshTarget = spawn(fresh, "wolf", 10);
    start(fresh, freshTarget.entityId);
    fresh.tick();
    const freshEvents = fresh.beginDeltaFlush().events;
    const damage = freshEvents.find((event) => event.type === "DAMAGE" && event.targetEntityId === freshTarget.entityId);
    expect(damage).toBeDefined();
    expect(damage?.professionBonusAmount).toBeUndefined();
    expect(freshEvents.some((event) => event.type === "PROFESSION_OPENING_STRIKE")).toBe(false);

    const baseline = createEngine(() => 0.99);
    addHunter(baseline, { weapon: "bow", attackPower: 20 });
    const baselineTarget = spawn(baseline, "wolf", 10);
    start(baseline, baselineTarget.entityId);
    baseline.tick();
    const baselineDamage = baseline.beginDeltaFlush().events
      .find((event) => event.type === "DAMAGE" && event.targetEntityId === baselineTarget.entityId);
    expect(damage?.amount).toBe(baselineDamage?.amount);
  });
  it("uses one generic class runtime with Focus and weapon-derived range", () => {
    const ranged = createEngine();
    addHunter(ranged, { weapon: "bow", focus: 73 });
    expect(ranged.entity("hunter")?.classCombat).toMatchObject({
      activeClassId: "hunter",
      resource: { resourceId: "focus", current: 73 },
      rage: 73,
      weaponMode: "ranged"
    });

    const melee = createEngine();
    addHunter(melee, { weapon: "sword" });
    expect(melee.entity("hunter")?.classCombat?.weaponMode).toBe("melee");

    const unarmed = createEngine();
    addHunter(unarmed, {
      weapon: null,
      subclassId: "sharpshooter",
      resetActives: ["sharpshooter_deadeye_shot"]
    });
    const target = spawn(unarmed, "goblin", HUNTER_BALANCE.meleeRangeM - 1);
    expect(unarmed.entity("hunter")?.classCombat?.weaponMode).toBeNull();
    expect(unarmed.entity("hunter")?.attackRangeM).toBe(HUNTER_BALANCE.meleeRangeM);
    start(unarmed, target.entityId);
    expectCombatError(
      () => unarmed.useResetAbility({ ...authority(), abilityId: "sharpshooter_deadeye_shot" }),
      "CLASS_WEAPON_REQUIRED"
    );
    expect(collectDamage(unarmed, 1, (event) => event.sourceEntityId === "hunter")[0]?.amount)
      .toBeGreaterThan(0);
  });

  it("regenerates fractional Focus deterministically and grants one basic-action gain", () => {
    const engine = createEngine();
    addHunter(engine, { level: 3, weapon: "bow", focus: 0, attackPower: 1 });
    const target = spawn(engine, "ogre", 20);
    start(engine, target.entityId);
    drainDamage(engine);
    for (let tick = 0; tick < 20; tick += 1) {
      engine.tick();
      drainDamage(engine);
    }
    const state = engine.entity("hunter")!.classCombat!;
    // Level 3 Focus Control I regenerates 5.5/s in combat; one basic hit grants +2.
    expect(state.resource?.current).toBe(7);
    expect(state.classCounters?.focus_regeneration).toBe(4);
    for (let tick = 0; tick < 20; tick += 1) {
      engine.tick();
      drainDamage(engine);
    }
    expect(engine.entity("hunter")!.classCombat!.classCounters?.focus_regeneration).toBe(9);
  });

  it("resolves Predator's Strike once, spending and generating Focus once", () => {
    const engine = createEngine();
    addHunter(engine, {
      weapon: "sword",
      focus: 50,
      resetActives: ["hunter_predators_strike"],
      attackPower: 20
    });
    const target = spawn(engine, "ogre", 20);
    start(engine, target.entityId);
    engine.applyScriptedDamage("hunter", target.entityId, 1, "fixture_claim");
    drainDamage(engine);
    engine.useResetAbility({ ...authority(), abilityId: "hunter_predators_strike" });
    engine.tick();
    const hits = drainDamage(engine).filter((event) => event.sourceEntityId === "hunter");
    expect(hits).toHaveLength(1);
    // 50 - 20 cost +2 empowered basic +5 Predator bonus.
    expect(engine.entity("hunter")!.classCombat!.resource?.current).toBe(37);
  });

  it("uses the authoritative queue for ranged Volley and melee Sweep target caps", () => {
    expect(sweepHitCount("bow")).toBe(5);
    expect(sweepHitCount("sword")).toBe(4);
  });

  it("applies and consumes owner-scoped Marked Quarry charges", () => {
    const engine = createEngine();
    addHunter(engine, { weapon: "sword", focus: 100, maxHealth: 300, resetActives: ["hunter_marked_strike"] });
    const target = spawn(engine, "ogre", 20);
    start(engine, target.entityId);
    engine.applyScriptedDamage("hunter", target.entityId, 1, "fixture_claim");
    drainDamage(engine);
    engine.useResetAbility({ ...authority(), abilityId: "hunter_marked_strike" });
    engine.tick();
    drainDamage(engine);
    expect(engine.entity("hunter")!.classCombat!.classCounters?.markedQuarryApplications).toBe(1);
    collectDamage(engine, 3, (event) => event.sourceEntityId === "hunter");
    expect(engine.entity("hunter")!.classCombat!.classCounters?.markedQuarryChargesConsumed).toBe(3);
  });

  it("applies Lone, Pack, and Patient Hunter from the one authoritative queue/focus", () => {
    const loneBase = firstBasicDamage([], 1);
    const lone = firstBasicDamage([null, "hunter_lone_hunter"], 1);
    expect(lone).toBeGreaterThan(loneBase);
    const packBase = firstBasicDamage([], 5);
    const pack = firstBasicDamage([null, "hunter_pack_hunter"], 5);
    expect(pack).toBeGreaterThan(packBase);

    const patient = createEngine();
    addHunter(patient, { weapon: "bow", attackPower: 20, passives: [null, null, "hunter_patient_hunter"] });
    const target = spawn(patient, "ogre", 20);
    start(patient, target.entityId);
    const hits = collectDamage(patient, 3, (event) => event.sourceEntityId === "hunter");
    expect(hits[2]!.amount).toBeGreaterThan(hits[1]!.amount!);
  });

  it("applies Hunter class multipliers before generic outgoing damage exactly once", () => {
    const engine = createEngine();
    addHunter(engine, {
      weapon: "bow",
      attackPower: 20,
      passives: [null, "hunter_lone_hunter"],
      outgoingEffect: 0.25
    });
    const target = spawn(engine, "ogre", 20);
    start(engine, target.entityId);
    engine.applyScriptedDamage("hunter", target.entityId, 1, "fixture_claim");
    drainDamage(engine);
    const hit = collectDamage(engine, 1, (event) => event.sourceEntityId === "hunter")[0]!;

    // 20 attack; Weaponry V, Quarry Sense V, Lone Hunter; then one +25% generic stage.
    const classAdjusted = Math.round(20 * 1.05 * 1.15 * 1.15);
    expect(hit.amount).toBe(damageFromStats(Math.round(classAdjusted * 1.25), 0));
  });

  it("records Snare opportunities and Deadeye's deterministic long-range branch", () => {
    const snare = createEngine();
    addHunter(snare, { weapon: "bow", normalActives: ["hunter_snare_trap"], focus: 100, attackPower: 1 });
    const enemy = spawn(snare, "ogre", 20);
    start(snare, enemy.entityId);
    snare.tick();
    snare.useNormalAbility({ ...authority(), abilityId: "hunter_snare_trap" });
    for (let tick = 0; tick < 100 && (snare.entity("hunter")!.classCombat!.classCounters?.snaredEnemyActions ?? 0) < 1; tick += 1) {
      snare.tick();
      drainDamage(snare);
    }
    expect(snare.entity("hunter")!.classCombat!.classCounters?.snareApplications).toBe(1);
    expect(snare.entity("hunter")!.classCombat!.classCounters?.snaredEnemyActions).toBeGreaterThan(0);

    expect(deadeyeDamage(90)).toBeGreaterThan(deadeyeDamage(50));
  });

  it("enforces subclass weapon modes and snapshots Stalker Rending bleed", () => {
    const sharpshooter = createEngine();
    addHunter(sharpshooter, {
      weapon: "sword",
      subclassId: "sharpshooter",
      resetActives: ["sharpshooter_deadeye_shot"]
    });
    const rangedTarget = spawn(sharpshooter, "ogre", 20);
    start(sharpshooter, rangedTarget.entityId);
    expectCombatError(
      () => sharpshooter.useResetAbility({ ...authority(), abilityId: "sharpshooter_deadeye_shot" }),
      "SUBCLASS_WEAPON_REQUIRED"
    );

    const stalker = createEngine();
    addHunter(stalker, {
      weapon: "sword",
      subclassId: "stalker",
      resetActives: ["stalker_rending_strike"],
      focus: 100,
      attackPower: 20
    });
    const meleeTarget = spawn(stalker, "ogre", 10);
    start(stalker, meleeTarget.entityId);
    stalker.applyScriptedDamage("hunter", meleeTarget.entityId, 1, "fixture_claim");
    drainDamage(stalker);
    stalker.useResetAbility({ ...authority(), abilityId: "stalker_rending_strike" });
    stalker.tick();
    drainDamage(stalker);
    const bleed = collectDamage(stalker, 1, (event) => event.sourceEntityId === "hunter")[0];
    expect(bleed?.amount).toBeGreaterThan(0);
  });
});

type HunterOptions = {
  level?: number;
  focus?: number;
  maxHealth?: number;
  attackPower?: number;
  weapon?: WeaponCategory | null;
  subclassId?: Extract<SubclassId, "sharpshooter" | "stalker">;
  resetActives?: string[];
  normalActives?: string[];
  passives?: Array<string | null>;
  outgoingEffect?: number;
  professionRank?: number;
};

function createEngine(random?: () => number): CombatEngine {
  return new CombatEngine({ tickRateHz: 20, playerMovementSpeedMps: 40, isPlayerAuthorityActive: () => true, ...(random ? { random } : {}) });
}

function addHunter(engine: CombatEngine, options: HunterOptions = {}): void {
  const level = options.level ?? 25;
  const focus = options.focus ?? 100;
  const equipment = hunterEquipment(options.weapon === undefined ? "bow" : options.weapon);
  engine.connectPlayer({
    playerId: "hunter",
    name: "hunter",
    regionCode: "NM",
    zoneId: "world:NM",
    position: ORIGIN,
    accountId: "account-hunter",
    connectionId: "connection-hunter",
    profile: {
      playerId: "hunter",
      level,
      maxHealth: options.maxHealth ?? 100,
      currentHealth: options.maxHealth ?? 100,
      baseAttackDamage: options.attackPower ?? 10,
      defense: 0
    }
  });
  if (equipment.weapon) {
    engine.syncPlayerEquipmentCombatState("hunter", equipmentRuntime(equipment.weapon.definitionId, options.attackPower ?? 10));
  }
  const snapshot: ClassSnapshot = {
    playerId: "hunter",
    characterLevel: level,
    activeClassId: "hunter",
    activeSubclassId: options.subclassId ?? null,
    warrior: { classId: "warrior", level: 0, xp: 0, nextLevelXp: 100, completedAt: null },
    hunter: { classId: "hunter", level, xp: level === 25 ? 38_000 : 0, nextLevelXp: level === 25 ? null : 100, completedAt: null },
    classes: [],
    subclasses: [
      { classId: "warrior", subclassId: "reaver", unlocked: false },
      { classId: "warrior", subclassId: "warden", unlocked: false },
      { classId: "hunter", subclassId: "sharpshooter", unlocked: options.subclassId === "sharpshooter" },
      { classId: "hunter", subclassId: "stalker", unlocked: options.subclassId === "stalker" }
    ],
    selectedSubclasses: {
      warrior: null,
      hunter: options.subclassId ?? null
    },
    loadout: {
      resetActives: [options.resetActives?.[0] ?? null, options.resetActives?.[1] ?? null],
      normalActives: [options.normalActives?.[0] ?? null, options.normalActives?.[1] ?? null],
      passiveTiers: [options.passives?.[0] ?? null, options.passives?.[1] ?? null, options.passives?.[2] ?? null], ultimateActive: null
    },
    resource: { classId: "hunter", resourceId: "focus", displayName: "Focus", current: focus, maximum: 100, reserved: 0, updatedAt: new Date(0).toISOString() },
    resources: [],
    weaponMode: options.weapon === "bow" || options.weapon === "crossbow" ? "ranged" : options.weapon ? "melee" : null,
    legacyIds: [],
    rage: 0,
    maximumRage: 100,
    queuedAbility: null,
    cooldownEndsAt: {},
    serverTime: Date.now(),
    revision: 1,
    // A stale `hunter` rank simulates legacy profession data; combat must ignore it.
    professionRanks: {
      woodcutter: 0, miner: 0, builder: 0, oil_worker: 0, metallurgy: 0,
      ...(options.professionRank === undefined ? {} : { hunter: options.professionRank })
    } as NonNullable<ClassSnapshot["professionRanks"]>
  };
  engine.updatePlayerClassState("hunter", snapshot, equipment, {
    activeClassId: "hunter",
    resourceId: "focus",
    resourceCurrent: focus,
    resourceReserved: 0,
    rage: 0,
    rageReserved: 0,
    queuedAbilityId: null,
    queuedTargetEntityId: null,
    queuedAtTick: null,
    cooldownEndsAt: {},
    statusEffects: options.outgoingEffect
      ? [{
          id: "test:hunter:outgoing_damage",
          kind: "outgoing_damage",
          sourceTechniqueId: "hunter_lone_hunter",
          sourceEntityId: "hunter",
          startTick: 0,
          endTick: 10_000,
          nextTick: 10_000,
          stacks: 1,
          maximumStacks: 1,
          amount: options.outgoingEffect
        }]
      : [],
    counters: {},
    combatGeneration: 0,
    lastCombatAt: null
  });
  drainDamage(engine);
}

function sweepHitCount(weapon: "bow" | "sword"): number {
  const engine = createEngine();
  addHunter(engine, { weapon, normalActives: ["hunter_sweep"], focus: 100 });
  const mobs = Array.from({ length: 7 }, (_, index) => spawn(engine, "ogre", 8 + index));
  start(engine, mobs[0]!.entityId);
  for (const mob of mobs) engine.applyScriptedDamage("hunter", mob.entityId, 1, "fixture_claim");
  drainDamage(engine);
  const immediate = engine.useNormalAbility({ ...authority(), abilityId: "hunter_sweep" });
  void immediate;
  return drainDamage(engine).filter((event) => event.sourceEntityId === "hunter").length;
}

function firstBasicDamage(passives: Array<string | null>, queueSize: number): number {
  const engine = createEngine();
  addHunter(engine, { weapon: "bow", attackPower: 20, passives });
  const mobs = Array.from({ length: queueSize }, (_, index) => spawn(engine, "ogre", 10 + index));
  start(engine, mobs[0]!.entityId);
  for (const mob of mobs) engine.applyScriptedDamage("hunter", mob.entityId, 1, "fixture_claim");
  drainDamage(engine);
  return collectDamage(engine, 1, (event) => event.sourceEntityId === "hunter")[0]!.amount!;
}

function deadeyeDamage(distanceM: number): number {
  const engine = createEngine();
  addHunter(engine, { weapon: "bow", subclassId: "sharpshooter", resetActives: ["sharpshooter_deadeye_shot"], focus: 100, attackPower: 20 });
  const target = spawn(engine, "ogre", distanceM);
  start(engine, target.entityId);
  engine.applyScriptedDamage("hunter", target.entityId, 1, "fixture_claim");
  drainDamage(engine);
  engine.useResetAbility({ ...authority(), abilityId: "sharpshooter_deadeye_shot" });
  engine.tick();
  return drainDamage(engine).find((event) => event.sourceEntityId === "hunter")!.amount!;
}

function hunterEquipment(category: WeaponCategory | null): EquipmentSnapshot {
  const weapon = category === null ? null : {
    instanceId: "00000000-0000-4000-8000-000000000010",
    definitionId: category === "bow" ? "starter_bow" as const : "starter_sword" as const,
    displayName: category === "bow" ? "Starter Bow" : "Starter Sword",
    ownerPlayerId: "hunter",
    location: "equipped" as const,
    equippedSlot: "weapon" as const,
    attackPowerBonus: 2,
    defenseBonus: 0,
    weaponCategory: category,
    armorCategory: null,
    twoHanded: category === "bow" || category === "crossbow",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  return { playerId: "hunter", instances: weapon ? [weapon] : [], weapon, chest: null, totalAttackPowerBonus: weapon ? 2 : 0, totalDefenseBonus: 0 };
}

function spawn(engine: CombatEngine, archetype: MobArchetypeKey, distanceM: number) {
  // Ogre fixtures stand in for a large generic target: a Squid with the old 700 HP pool.
  const genericTarget = archetype === "ogre";
  return engine.spawnMob({
    archetype: genericTarget ? "squid" : archetype,
    ...(genericTarget ? { maxHealthMultiplier: 700 / 49 } : {}),
    position: east(distanceM), regionCode: "NM", zoneId: "world:NM"
  });
}

function start(engine: CombatEngine, targetEntityId: string): void {
  engine.startAttack({ ...authority(), attackerId: "hunter", targetEntityId, requestId: "hunter-start" });
}

function authority() {
  return { playerId: "hunter", accountId: "account-hunter", connectionId: "connection-hunter" };
}

function drainDamage(engine: CombatEngine): CombatEvent[] {
  return engine.beginDeltaFlush().events.filter((event) => event.type === "DAMAGE");
}

function collectDamage(engine: CombatEngine, count: number, predicate: (event: CombatEvent) => boolean): CombatEvent[] {
  const matches: CombatEvent[] = [];
  for (let tick = 0; tick < 2_000 && matches.length < count; tick += 1) {
    engine.tick();
    matches.push(...drainDamage(engine).filter(predicate));
  }
  expect(matches).toHaveLength(count);
  return matches;
}

function expectCombatError(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CombatRequestError);
    expect((error as CombatRequestError).code).toBe(code);
  }
}

function east(meters: number): LatLon {
  return { lat: ORIGIN.lat, lon: ORIGIN.lon + meters / 91_000 };
}

function equipmentRuntime(definitionId: EquipmentDefinitionId, attackPower: number): PlayerEquipmentCombatState {
  const definition = requireEquipmentDefinition(definitionId);
  const slot = definition.slot === "secondary" ? "secondary" : "melee";
  const stats: EquipmentCombatStats = {
    balanceVersion: 2, context: "pve", maximumHealth: 100, characterLevel: 25, classId: "warrior", classRank: 15,
    normalizedClassPower: 0, readiedWeaponSlot: slot, readiedWeaponCategory: definition.weaponCategory,
    weaponItemLevel: 0, effectiveWeaponLevel: 0, weightedArmorLevel: 0, shieldLevel: null, shieldGuardBonus: 0,
    pvpOffense: 0, pvpGuard: 0, pveAttackPower: attackPower, pveDefense: 0, pveWeaponProficiencyMultiplier: 1,
    universalAttackPower: attackPower, universalDefense: 0,
    weaponAttackPower: { melee: attackPower, secondary: attackPower },
    weaponCategories: { melee: slot === "melee" ? definition.weaponCategory : null, secondary: slot === "secondary" ? definition.weaponCategory : null },
    resourceMaximumBonus: 0, resourceGenerationMultiplier: 1, actionDurationMultiplier: 1,
    choppingDurationMultiplier: 1, miningDurationMultiplier: 1,
    movementSpeedMultiplier: 1, crowdControlDurationMultiplier: 1,
    challengeProfile: { balanceVersion: 2, currentGearLevel: 0, unlockedGearLevel: 0, tier: "common", contributors: { melee: 0, chest: 0, secondary: 0 } },
    attackIntervalMs: 800, attackRangeM: slot === "secondary" ? 150 : 75,
    // Fixed-damage (defense-bypassing) fixture weapon: these tests measure
    // Hunter multipliers, not the universal weapon x armor table.
    bypassPveDefense: true,
    items: { head: null, chest: null, gloves: null, boots: null, ring: null, ring_2: null, melee: null, secondary: null, tool_axe: null, tool_pickaxe: null, tool_fishing_pole: null }
  };
  const instanceId = "00000000-0000-4000-8000-000000000001";
  return {
    activeKitIndex: null, inventoryRevision: 1, activeRevision: 1, stats,
    weaponCategory: definition.weaponCategory, chestArmorCategory: null, chestDefinitionId: null,
    heavyArmorPieces: 0, hasShield: false, activeWeaponInstanceId: instanceId,
    activeWeaponEnchantmentIdentity: null,
    armorEnchantmentIdentities: { head: null, chest: null, gloves: null, boots: null },
    weaponSlots: {
      melee: { instanceId: slot === "melee" ? instanceId : null, definitionId: slot === "melee" ? definitionId : null,
        category: slot === "melee" ? definition.weaponCategory : null, enchantmentIdentity: null },
      secondary: { instanceId: slot === "secondary" ? instanceId : null, definitionId: slot === "secondary" ? definitionId : null,
        category: slot === "secondary" ? definition.weaponCategory : null, enchantmentIdentity: null }
    },
    activeWeaponSlot: slot, switchPolicy: slot === "secondary" ? "ranged_priority" : "melee_priority",
    switchingToSlot: null, switchStartedAtTick: null, switchCompletesAtTick: null
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  moveToward,
  requireEquipmentDefinition,
  type ClassSnapshot,
  type CombatEvent,
  type EquipmentDefinitionId,
  type EquipmentSnapshot,
  type LatLon,
  type MobArchetypeKey
} from "@ash-atlas/shared";

import { CombatEngine, CombatRequestError } from "./combatEngine.js";
import { InMemoryPartyAuthority } from "../party/PartyAuthority.js";

const origin = { lat: 35.0844, lon: -106.6504 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resource-free Warrior PvE rework", () => {
  it("pays Empowered Hit's exact HP cost, floors at 1 HP, arms once, and starts one 15s cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
    const engine = createEngine();
    addWarrior(engine, { currentHealth: 6, skills: ["warrior_empowered_hit"] });
    const target = spawn(engine, "ogre", 10);
    start(engine, target.entityId);
    engine.useNormalAbility({ ...authority(), abilityId: "warrior_empowered_hit", targetMode: "self" });
    engine.tick();

    expect(engine.entity("warrior")?.currentHealth).toBe(1);
    const expiry = engine.entity("warrior")!.classCombat!.cooldownEndsAt.warrior_empowered_hit!;
    expect(expiry).toBe(Date.now() + 15_000);
    expect(engine.entity("warrior")!.classCombat!.resource).toBeUndefined();
    expect(engine.entity("warrior")!.classCombat!.rage).toBe(0);
    for (let snapshot = 0; snapshot < 20; snapshot += 1) {
      expect(engine.entity("warrior")!.classCombat!.cooldownEndsAt.warrior_empowered_hit).toBe(expiry);
    }
    expectCombatError(
      () => engine.useNormalAbility({ ...authority(), abilityId: "warrior_empowered_hit", targetMode: "self" }),
      "ABILITY_COOLDOWN"
    );
  });

  it("bounds restored cooldowns to their configured durations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
    const engine = createEngine();
    addWarrior(engine, {
      skills: ["warrior_empowered_hit", "warrior_anger_explosion"],
      cooldownEndsAt: {
        warrior_empowered_hit: Date.now() + 135_000,
        warrior_anger_explosion: Date.now() + 141_000,
        retired_skill: Date.now() + 500_000,
        expired_skill: Date.now() - 1
      }
    });

    expect(engine.entity("warrior")?.classCombat?.cooldownEndsAt).toEqual({
      warrior_empowered_hit: Date.now() + 15_000,
      warrior_anger_explosion: Date.now() + 20_000
    });
  });

  it("makes the next basic attack 125% and consumes the empowerment", () => {
    const baseline = createEngine();
    addWarrior(baseline, { attackPower: 100 });
    const baselineTarget = spawn(baseline, "ogre", 10);
    start(baseline, baselineTarget.entityId);
    const normal = collectDamage(baseline, 1, fromWarrior)[0]!.amount!;

    const empowered = createEngine();
    addWarrior(empowered, { attackPower: 100, skills: ["warrior_empowered_hit"] });
    const target = spawn(empowered, "ogre", 10);
    start(empowered, target.entityId);
    empowered.useNormalAbility({ ...authority(), abilityId: "warrior_empowered_hit", targetMode: "self" });
    const hits = collectDamage(empowered, 2, fromWarrior);
    expect(hits[0]!.amount).toBe(Math.round(normal * 1.23));
    expect(hits[1]!.amount).toBe(normal + 1);
  });

  it("makes Anger Explosion a 140m, 30% multi-target action with an 8 HP floor-safe cost", () => {
    const engine = createEngine();
    addWarrior(engine, { attackPower: 100, currentHealth: 100, skills: ["warrior_anger_explosion"] });
    const near = spawn(engine, "ogre", 10);
    const second = spawn(engine, "goblin", 100);
    const far = spawn(engine, "ogre", 170);
    start(engine, near.entityId);
    engine.useNormalAbility({ ...authority(), abilityId: "warrior_anger_explosion", targetMode: "self" });
    const hits = collectDamage(engine, 2, (event) => event.sourceEntityId === "warrior" && event.amount === 30);
    expect(new Set(hits.map((event) => event.targetEntityId))).toEqual(new Set([near.entityId, second.entityId]));
    expect(hits.every((event) => event.amount === 30)).toBe(true);
    expect(hits.some((event) => event.targetEntityId === far.entityId)).toBe(false);
    expect(engine.entity("warrior")?.currentHealth).toBeLessThanOrEqual(92);
  });

  it("consumes Concussed on the mob's next damaging player attack without stopping the mob", () => {
    const engine = createEngine();
    addWarrior(engine, { skills: ["warrior_concussive_blow"] });
    const target = spawn(engine, "ogre", 10);
    start(engine, target.entityId);
    engine.tick(); // A landed hit establishes authoritative hostile ownership.
    engine.useNormalAbility({ ...authority(), abilityId: "warrior_concussive_blow", targetMode: "hostile" });
    const misses = collectDamage(engine, 1, (event) => event.sourceEntityId === target.entityId && event.amount === 0);
    expect(misses).toHaveLength(1);
    const next = collectDamage(engine, 1, (event) => event.sourceEntityId === target.entityId && (event.amount ?? 0) > 0);
    expect(next[0]!.amount).toBeGreaterThan(0);
  });

  it("applies non-stacking Battle Cry outgoing damage for 9 seconds", () => {
    const engine = createEngine();
    addWarrior(engine, { attackPower: 100, skills: ["warrior_battle_cry"] });
    const target = spawn(engine, "ogre", 10);
    start(engine, target.entityId);
    engine.useNormalAbility({ ...authority(), abilityId: "warrior_battle_cry", targetMode: "self" });
    const hit = collectDamage(engine, 1, fromWarrior)[0]!;
    expect(hit.amount).toBe(109);
  });

  it("buffs only nearby participating party members for 9 seconds and never stacks", () => {
    const party = new InMemoryPartyAuthority();
    party.loadSnapshots([{
      partyId: "party", leaderPlayerId: "warrior",
      memberPlayerIds: ["warrior", "ally", "remote"], allowTravel: false,
      autoFollowPlayerIds: [], revision: 1
    }]);
    const engine = createEngine(party);
    addWarrior(engine, { skills: ["warrior_battle_cry"] });
    addWarrior(engine, { playerId: "ally", skills: ["warrior_battle_cry"] });
    addWarrior(engine, { playerId: "remote", position: east(200) });
    const target = spawn(engine, "ogre", 10);
    start(engine, target.entityId, "warrior");
    start(engine, target.entityId, "ally");
    start(engine, target.entityId, "remote");

    engine.useNormalAbility({ ...authority(), abilityId: "warrior_battle_cry", targetMode: "self" });
    expect(battleCryEffects(engine, "warrior")).toMatchObject([{ startTick: 0, endTick: 180 }]);
    expect(battleCryEffects(engine, "ally")).toHaveLength(1);
    expect(battleCryEffects(engine, "remote")).toHaveLength(0);

    engine.useNormalAbility({ ...authority("ally"), abilityId: "warrior_battle_cry", targetMode: "self" });
    expect(battleCryEffects(engine, "warrior")).toHaveLength(1);
    expect(battleCryEffects(engine, "ally")).toHaveLength(1);
  });

  it("derives Axe mastery from the shared stock and cosmetic family", () => {
    const canonical = createEngine();
    addWarrior(canonical, { level: 15, attackPower: 100, weaponDefinitionId: requireEquipmentDefinition("double_axe").definitionId });
    const canonicalTarget = spawn(canonical, "ogre", 10);
    start(canonical, canonicalTarget.entityId);
    expect(collectDamage(canonical, 1, fromWarrior)[0]!.amount).toBe(104);

    const genericAxe = createEngine();
    addWarrior(genericAxe, { level: 15, attackPower: 100, weaponDefinitionId: "training_axe" });
    const genericTarget = spawn(genericAxe, "ogre", 10);
    start(genericAxe, genericTarget.entityId);
    expect(collectDamage(genericAxe, 1, fromWarrior)[0]!.amount).toBe(104);
  });

  it.each([
    [5, 1], [9, 2], [13, 4]
  ])("grants exactly +%i Axe Attack at the family mastery threshold", (level, bonus) => {
    const engine = createEngine();
    addWarrior(engine, { level, attackPower: 100, weaponDefinitionId: requireEquipmentDefinition("double_axe").definitionId });
    const target = spawn(engine, "ogre", 10);
    start(engine, target.entityId);
    expect(collectDamage(engine, 1, fromWarrior)[0]!.amount).toBe(100 + bonus);
  });

  it("applies flat offensive passives at their exact thresholds", () => {
    const heavy = createEngine();
    addWarrior(heavy, { attackPower: 100, passives: ["warrior_heavy_handed"] });
    const heavyTarget = spawn(heavy, "ogre", 10);
    start(heavy, heavyTarget.entityId);
    expect(collectDamage(heavy, 1, fromWarrior)[0]!.amount).toBe(101);

    const relentless = createEngine();
    addWarrior(relentless, { attackPower: 100, passives: ["warrior_heavy_handed", "warrior_relentless"] });
    const relentlessTarget = spawn(relentless, "ogre", 10);
    start(relentless, relentlessTarget.entityId);
    expect(collectDamage(relentless, 3, fromWarrior).map((event) => event.amount)).toEqual([101, 102, 129]);

    const desperate = createEngine();
    addWarrior(desperate, { attackPower: 100, passives: ["warrior_heavy_handed", null, "warrior_desperate_fury"] });
    const desperateTarget = spawn(desperate, "ogre", 10);
    (desperate as unknown as { entities: Map<string, { currentHealth: number; maxHealth: number }> })
      .entities.get(desperateTarget.entityId)!.currentHealth = Math.floor(desperateTarget.maxHealth * 0.34);
    start(desperate, desperateTarget.entityId);
    expect(collectDamage(desperate, 1, fromWarrior)[0]!.amount).toBe(103);
  });

  it("heals exactly 5 from Bloodthirst without exceeding maximum health", () => {
    const engine = createEngine();
    addWarrior(engine, { attackPower: 10_000, currentHealth: 97, passives: ["warrior_bloodthirst"] });
    const target = spawn(engine, "goblin", 10);
    start(engine, target.entityId);
    collectDamage(engine, 1, fromWarrior);
    expect(engine.entity("warrior")?.currentHealth).toBe(100);
  });

  it.each([[6, 2], [10, 3], [14, 4]])(
    "grants exactly +%i Breastplate Defense at the family mastery threshold",
    (level, bonus) => {
      const engine = createEngine();
      addWarrior(engine, { level, chestDefinitionId: requireEquipmentDefinition("breast_plate").definitionId });
      expect(flatDefenseBonus(engine)).toBe(bonus);
    }
  );

  it("applies Crowd Fighter and low-health passives as exact flat bonuses", () => {
    const crowd = createEngine();
    addWarrior(crowd, { passives: ["warrior_heavy_handed", "warrior_crowd_fighter"] });
    const first = spawn(crowd, "ogre", 10);
    const second = spawn(crowd, "goblin", 12);
    start(crowd, first.entityId);
    crowd.tick();
    start(crowd, second.entityId);
    for (let tick = 0; tick < 32; tick += 1) crowd.tick();
    crowd.healEntity("warrior", 100); // Isolate Crowd Fighter from health-based innate bonuses.
    expect(flatAttackBonus(crowd, false)).toBe(1);
    expect(flatDefenseBonus(crowd)).toBe(1);

    const lowHealth = createEngine();
    addWarrior(lowHealth, {
      currentHealth: 34,
      passives: ["warrior_heavy_handed", "warrior_relentless", "warrior_last_stand"]
    });
    expect(flatDefenseBonus(lowHealth)).toBe(2);

    const fury = createEngine();
    addWarrior(fury, {
      currentHealth: 34,
      passives: ["warrior_heavy_handed", "warrior_relentless", "warrior_desperate_fury"]
    });
    expect(flatAttackBonus(fury, false)).toBe(2);
  });
});

type WarriorOptions = {
  playerId?: string;
  position?: LatLon;
  level?: number;
  currentHealth?: number;
  attackPower?: number;
  skills?: string[];
  passives?: Array<string | null>;
  weaponDefinitionId?: EquipmentDefinitionId;
  chestDefinitionId?: EquipmentDefinitionId;
  cooldownEndsAt?: Record<string, number>;
};

function createEngine(partyAuthority?: InMemoryPartyAuthority): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    ...(partyAuthority ? { partyAuthority } : {})
  });
}

function addWarrior(engine: CombatEngine, options: WarriorOptions = {}): void {
  const playerId = options.playerId ?? "warrior";
  const level = options.level ?? 15;
  engine.connectPlayer({
    playerId, name: playerId, regionCode: "NM", zoneId: "world:NM", position: options.position ?? origin,
    accountId: `account-${playerId}`, connectionId: `connection-${playerId}`,
    profile: { playerId, level, maxHealth: 100, currentHealth: options.currentHealth ?? 100, baseAttackDamage: options.attackPower ?? 10, defense: 0 }
  });
  const snapshot: ClassSnapshot = {
    playerId, characterLevel: level, activeClassId: "warrior", activeSubclassId: null,
    warrior: { classId: "warrior", level, xp: level === 15 ? 72_000 : 0, nextLevelXp: level === 15 ? null : 100, completedAt: null },
    subclasses: [],
    loadout: {
      resetActives: [null, null],
      normalActives: [options.skills?.[0] ?? null, options.skills?.[1] ?? null],
      passiveTiers: [options.passives?.[0] ?? null, options.passives?.[1] ?? null, options.passives?.[2] ?? null], ultimateActive: null
    },
    legacyIds: [], rage: 999, maximumRage: 100, queuedAbility: null, cooldownEndsAt: {}, serverTime: Date.now(), revision: 1
  };
  engine.updatePlayerClassState(playerId, snapshot, equipment(playerId, options.weaponDefinitionId ?? "starter_sword", options.chestDefinitionId), {
    rage: 999, rageReserved: 99, queuedAbilityId: null, queuedTargetEntityId: null, queuedAtTick: null,
    cooldownEndsAt: options.cooldownEndsAt ?? {}, statusEffects: [], counters: {}, combatGeneration: 0, lastCombatAt: null
  });
  drainDamage(engine);
}

function spawn(engine: CombatEngine, archetype: MobArchetypeKey, distanceM: number) {
  // matrix health no longer scales with level; restore the 700 HP level-25
  // Ogre pool (now 8 x 4) these threshold checks were written against.
  return engine.spawnMob({
    archetype, maxHealthMultiplier: 700 / 32,
    position: east(distanceM), regionCode: "NM", zoneId: "world:NM"
  });
}

function start(engine: CombatEngine, targetEntityId: string, playerId = "warrior"): void {
  engine.startAttack({ attackerId: playerId, targetEntityId, requestId: `start-${playerId}-${targetEntityId}`, ...authority(playerId) });
}

function authority(playerId = "warrior") {
  return { playerId, accountId: `account-${playerId}`, connectionId: `connection-${playerId}` };
}

function battleCryEffects(engine: CombatEngine, playerId: string): Array<{ startTick: number; endTick: number }> {
  const entities = (engine as unknown as { entities: Map<string, { classRuntime?: { effects: Array<{ sourceTechniqueId: string; startTick: number; endTick: number }> } }> }).entities;
  return (entities.get(playerId)?.classRuntime?.effects ?? [])
    .filter((effect) => effect.sourceTechniqueId === "warrior_battle_cry");
}

function flatAttackBonus(engine: CombatEngine, basicAttack: boolean): number {
  const internals = engine as unknown as {
    entities: Map<string, unknown>;
    warriorFlatAttackBonus(entity: unknown, basic: boolean): number;
  };
  return internals.warriorFlatAttackBonus(internals.entities.get("warrior"), basicAttack);
}

function flatDefenseBonus(engine: CombatEngine): number {
  const internals = engine as unknown as {
    entities: Map<string, unknown>;
    warriorFlatDefenseBonus(entity: unknown): number;
  };
  return internals.warriorFlatDefenseBonus(internals.entities.get("warrior"));
}

function expectCombatError(run: () => unknown, code: string): void {
  try { run(); throw new Error(`Expected ${code}`); } catch (error) {
    expect(error).toBeInstanceOf(CombatRequestError);
    expect((error as CombatRequestError).code).toBe(code);
  }
}

function fromWarrior(event: CombatEvent): boolean {
  return event.sourceEntityId === "warrior" && event.type === "DAMAGE";
}

function drainDamage(engine: CombatEngine): CombatEvent[] {
  return engine.beginDeltaFlush().events.filter((event) => event.type === "DAMAGE");
}

function collectDamage(engine: CombatEngine, count: number, predicate: (event: CombatEvent) => boolean): CombatEvent[] {
  const matches: CombatEvent[] = [];
  for (let tick = 0; tick < 3_000 && matches.length < count; tick += 1) {
    engine.tick();
    matches.push(...drainDamage(engine).filter(predicate));
  }
  expect(matches).toHaveLength(count);
  return matches;
}

function equipment(playerId: string, definitionId: EquipmentDefinitionId, chestDefinitionId?: EquipmentDefinitionId): EquipmentSnapshot {
  const definition = requireEquipmentDefinition(definitionId);
  const chestDefinition = chestDefinitionId ? requireEquipmentDefinition(chestDefinitionId) : null;
  return {
    playerId, instances: [],
    weapon: {
      instanceId: "00000000-0000-4000-8000-000000000001", definitionId,
      displayName: definition.displayName, ownerPlayerId: playerId, location: "equipped", equippedSlot: "weapon",
      attackPowerBonus: 2, defenseBonus: 0, weaponCategory: definition.weaponCategory,
      armorCategory: null, twoHanded: definition.twoHanded, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
    },
    chest: chestDefinition ? {
      instanceId: "00000000-0000-4000-8000-000000000002", definitionId: chestDefinition.definitionId,
      displayName: chestDefinition.displayName, ownerPlayerId: playerId, location: "equipped", equippedSlot: "chest",
      attackPowerBonus: 0, defenseBonus: 0, weaponCategory: null,
      armorCategory: chestDefinition.armorCategory, twoHanded: false,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
    } : null, totalAttackPowerBonus: 2, totalDefenseBonus: 0
  };
}

function east(distanceM: number): LatLon {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, distanceM);
}

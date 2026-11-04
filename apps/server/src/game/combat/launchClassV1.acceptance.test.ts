import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beatAlignedAmountScale,
  beatAlignedIntervalMs,
  moveToward,
  distanceMeters,
  requireEquipmentDefinition,
  type ClassId,
  type ClassSnapshot,
  type CombatEvent,
  type EquipmentDefinitionId,
  type EquipmentCombatStats,
  type EquipmentSnapshot,
  type LatLon,
} from "@ash-atlas/shared";

import { CombatEngine, CombatRequestError, type PlayerEquipmentCombatState } from "./combatEngine.js";
import { InMemoryPartyAuthority } from "../party/PartyAuthority.js";

const origin = { lat: 35.0844, lon: -106.6504 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("launch class V1 combat kits", () => {
  it.each([
    ["druid", "druid_nature_bolt", "starter_staff", 125],
    ["knight", "knight_heavy_slash", "starter_sword", 125]
  ] as const)("resolves %s's first active at its exact damage multiplier", (classId, abilityId, weaponId, expected) => {
    const engine = createEngine();
    addClass(engine, { classId, weaponId, skills: [abilityId], attackPower: 100, rank: 1 });
    const target = spawn(engine, 10);
    start(engine, target.entityId);
    engine.tick();
    engine.beginDeltaFlush();
    engine.useNormalAbility({ ...authority(), abilityId, targetMode: "hostile" });
    const damage = collectEvents(engine, 1, (event) => event.type === "DAMAGE" && event.sourceEntityId === "player");
    expect(damage.map((event) => event.amount)).toContain(expected);
  });

  it("resolves Retreat Volley as a basic without resetting the scheduled attack", () => {
    const engine = createEngine({ repositionPlayer: () => true });
    addClass(engine, { classId: "ranger", weaponId: "starter_bow", skills: ["ranger_v2_threefold_volley"], attackPower: 100, rank: 3 });
    const target = spawn(engine, 10);
    start(engine, target.entityId);
    engine.useNormalAbility({ ...authority(), abilityId: "ranger_v2_threefold_volley", targetMode: "hostile" });
    engine.tick();
    const hits = engine.beginDeltaFlush().events.filter((event) => event.type === "DAMAGE" && event.sourceEntityId === "player");
    expect(hits.map((event) => event.amount)).toEqual([100, 100]);
  });

  it.each([299, 300 - 1e-6, 301])("checks exact immediate hostile range at %im before committing", (distanceM) => {
    const engine = createEngine({ repositionPlayer: () => true });
    addClass(engine, { classId: "ranger", weaponId: "starter_bow", skills: ["ranger_v2_threefold_volley"], rank: 3 });
    const target = spawn(engine, distanceM);
    if (distanceM > 299 && distanceM < 300) expect(distanceMeters(origin, target)).toBeCloseTo(300, 5);
    const before = engine.entity("player")!;
    const cast = () => engine.useNormalAbility({ ...authority(), abilityId: "ranger_v2_threefold_volley", targetMode: "hostile", targetEntityId: target.entityId });
    if (distanceM <= 300) {
      expect(cast).not.toThrow();
    } else {
      expectCombatError(cast, "ABILITY_TARGET_OUT_OF_RANGE");
      expect(engine.entity("player")?.classCombat?.cooldownEndsAt).toEqual(before.classCombat?.cooldownEndsAt);
      expect(engine.entity("player")?.currentHealth).toBe(before.currentHealth);
      expect(engine.entity("player")?.lon).toBe(before.lon);
    }
  });
  it("keeps Druid Root distinct from stun and delivers Rejuvenation on the beat at its design heal rate", () => {
    const rooted = createEngine();
    addClass(rooted, { classId: "druid", weaponId: "starter_staff", skills: ["druid_nature_bolt"], rank: 1 });
    const target = spawn(rooted, 10);
    start(rooted, target.entityId);
    rooted.tick();
    rooted.useNormalAbility({ ...authority(), abilityId: "druid_nature_bolt", targetMode: "hostile" });
    const entities = (rooted as unknown as { entities: Map<string, { classRuntime?: { effects: Array<{ kind: string; startTick: number; endTick: number }> } }> }).entities;
    const internalTarget = entities.get(target.entityId);
    const effect = internalTarget?.classRuntime?.effects.find(({ kind }) => kind === "rooted");
    expect(effect).toBeDefined();
    expect(effect!.endTick - effect!.startTick).toBe(40);
    expect(collectEvents(rooted, 1, (event) => event.type === "DAMAGE" && event.sourceEntityId === target.entityId)[0]!.amount)
      .toBeGreaterThan(0);

    const healing = createEngine();
    addClass(healing, { classId: "druid", weaponId: "starter_staff", skills: ["druid_rejuvenation"], currentHealth: 50, rank: 3 });
    healing.useNormalAbility({ ...authority(), abilityId: "druid_rejuvenation", targetMode: "self" });
    // Design: 4 HP every 2 s for 10 s (5 ticks, 20 HP). On the beat: one tick per beat interval,
    // the per-second heal kept (fractions carry) and the nearest whole number of ticks.
    const intervalMs = beatAlignedIntervalMs(2_000);
    const pulses = Math.round(10_000 / intervalMs);
    const perTick = 4 * beatAlignedAmountScale(2_000);
    const expected: number[] = [];
    let carry = 0;
    for (let pulse = 0; pulse < pulses; pulse += 1) {
      const owed = perTick + carry;
      expected.push(Math.floor(owed + 1e-9));
      carry = owed - expected.at(-1)!;
    }
    const isRejuvenation = (event: CombatEvent) => event.type === "HEAL" && event.targetEntityId === "player";
    const ticks = collectEvents(healing, pulses, isRejuvenation);
    expect(ticks.map((event) => event.amount)).toEqual(expected);
    ticks.slice(1).forEach((event, index) => expect(event.tick - ticks[index]!.tick).toBe(intervalMs * 20 / 1_000));
    const total = expected.reduce((sum, amount) => sum + amount, 0);
    expect(Math.abs(total - 20)).toBeLessThanOrEqual(1);
    for (let tick = 0; tick < 3 * intervalMs * 20 / 1_000; tick += 1) {
      healing.tick();
      expect(healing.beginDeltaFlush().events.filter(isRejuvenation)).toEqual([]);
    }
    expect(healing.entity("player")?.currentHealth).toBe(50 + total);
  });

  it("makes universal Taunt Knight-only", () => {
    const warrior = createEngine();
    addClass(warrior, { classId: "warrior", weaponId: "starter_sword" });
    expectCombatError(() => warrior.useUniversalTaunt(authority()), "ABILITY_CLASS_INVALID");

    const knight = createEngine();
    addClass(knight, { classId: "knight", weaponId: "starter_sword", skills: ["knight_taunt"] });
    expect(() => knight.useUniversalTaunt(authority())).not.toThrow();
  });

  it("preserves flag arrival protection when a hostile ability target is rejected", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const engine = createEngine();
    addClass(engine, {
      classId: "ranger",
      weaponId: "starter_bow",
      skills: ["ranger_v2_marked_quarry"],
      rank: 8
    });
    const focus = spawn(engine, 10);
    const invalidTarget = spawn(engine, 326); // Rank 8 Bow mastery extends the base range to 325m.
    start(engine, focus.entityId);
    expect(engine.grantFlagArrivalProtection("player", 1)).toBe(400_000);

    expectCombatError(() => engine.useNormalAbility({
      ...authority(),
      abilityId: "ranger_v2_marked_quarry",
      targetEntityId: invalidTarget.entityId,
      targetMode: "hostile"
    }), "ABILITY_TARGET_OUT_OF_RANGE");

    expect(engine.flagArrivalProtectionUntil("player")).toBe(400_000);
  });

  it("preserves flag arrival protection when a PvP ability is rejected on cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const engine = createEngine({
      getAuthoritativeViewCircle: () => ({ center: origin, radiusM: 200, generation: 1 })
    });
    addClass(engine, {
      classId: "ranger",
      weaponId: "starter_bow",
      skills: ["ranger_v2_marked_quarry"],
      rank: 8
    });
    addPartyAlly(engine);
    start(engine, "ally");
    engine.useNormalAbility({
      ...authority(),
      abilityId: "ranger_v2_marked_quarry",
      targetEntityId: "ally",
      targetMode: "hostile"
    });
    engine.tick();
    expect(engine.grantFlagArrivalProtection("player", 1)).toBe(400_000);

    expectCombatError(() => engine.useNormalAbility({
      ...authority(),
      abilityId: "ranger_v2_marked_quarry",
      targetEntityId: "ally",
      targetMode: "hostile"
    }), "ABILITY_COOLDOWN");

    expect(engine.flagArrivalProtectionUntil("player")).toBe(400_000);
  });

  it("keeps a protected Knight out of Intervene redirection until the Knight moves", () => {
    const engine = createPartyEngine();
    addClass(engine, {
      classId: "knight",
      weaponId: "starter_sword",
      skills: ["knight_intervene"],
      rank: 11
    });
    addPartyAlly(engine);
    engine.useNormalAbility({
      ...authority(),
      abilityId: "knight_intervene",
      targetEntityId: "ally",
      targetMode: "friendly"
    });
    const mob = spawn(engine, 10);
    engine.grantFlagArrivalProtection("player", 1);

    expect(engine.applyScriptedDamage(mob.entityId, "ally", 20, "test-hit")).toBe(20);
    expect(engine.entity("ally")?.currentHealth).toBe(80);
    expect(engine.entity("player")?.currentHealth).toBe(100);

    engine.syncPlayer({
      playerId: "player",
      position: east(1),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    expect(engine.applyScriptedDamage(mob.entityId, "ally", 20, "test-hit")).toBe(15);
    expect(engine.entity("ally")?.currentHealth).toBe(80);
    expect(engine.entity("player")?.currentHealth).toBe(85);
  });

  it("casts a targeted heal on a visible party member outside combat and makes the healer Aggressive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const parties = new InMemoryPartyAuthority();
    parties.loadSnapshots([{
      partyId: "party:00000000-0000-4000-8000-000000000001",
      leaderPlayerId: "player",
      memberPlayerIds: ["ally", "player"],
      memberSlots: [
        { playerId: "player", slotIndex: 0 },
        { playerId: "ally", slotIndex: 1 }
      ],
      membershipRevision: 1,
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 1
    }]);
    const engine = new CombatEngine({
      tickRateHz: 20,
      playerMovementSpeedMps: 40,
      isPlayerAuthorityActive: () => true,
      partyAuthority: parties,
      getAuthoritativeViewCircle: () => ({ center: origin, radiusM: 200, generation: 1 })
    });
    addClass(engine, {
      classId: "druid",
      weaponId: "starter_staff",
      skills: ["druid_regrowth"],
      rank: 11
    });
    engine.connectPlayer({
      playerId: "ally",
      name: "ally",
      regionCode: "AZ",
      zoneId: "world:AZ",
      position: east(100),
      accountId: "account-ally",
      connectionId: "connection-ally",
      profile: {
        playerId: "ally",
        level: 25,
        maxHealth: 100,
        currentHealth: 40,
        baseAttackDamage: 10,
        defense: 0
      }
    });

    expect(engine.isInCombat("player")).toBe(false);
    engine.useNormalAbility({
      ...authority(),
      abilityId: "druid_regrowth",
      targetEntityId: "ally",
      targetMode: "friendly"
    });

    expect(engine.entity("ally")?.currentHealth).toBe(60);
    expect(engine.isInCombat("player")).toBe(false);
    expect(engine.aggressiveUntil("player")).toBe(110_000);
    expect(engine.isPlayerVisibleToPlayer("player", "ally")).toBe(true);
  });

  it("rejects a health-only cast at Full HP without cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const engine = createEngine();
    addClass(engine, {
      classId: "druid",
      weaponId: "starter_staff",
      skills: ["druid_regrowth"],
      rank: 11
    });

    expectCombatError(() => engine.useNormalAbility({
      ...authority(),
      abilityId: "druid_regrowth",
      targetEntityId: "player",
      targetMode: "self"
    }), "ABILITY_TARGET_FULL_HEALTH");
    expect(engine.aggressiveUntil("player")).toBeNull();
    expect(engine.entity("player")?.classCombat?.cooldownEndsAt.druid_regrowth ?? 0).toBe(0);
  });
});

describe("class system V2 combat authority", () => {
  it("arms the next scheduled attack without resolving off cadence and enforces the 0.8 second activation lockout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const engine = createEngine();
    addClass(engine, { classId: "warrior", weaponId: "training_axe",
      skills: ["warrior_v2_sundering_arc", "warrior_v2_iron_reversal"], attackPower: 10 });
    const target = spawn(engine, 10);
    start(engine, target.entityId);
    engine.useNormalAbility({ ...authority(), abilityId: "warrior_v2_sundering_arc" });
    expect(engine.entity(target.entityId)?.currentHealth).toBe(engine.entity(target.entityId)?.maxHealth);
    expectCombatError(() => engine.useNormalAbility({ ...authority(), abilityId: "warrior_v2_iron_reversal" }), "ABILITY_ACTIVATION_LOCKOUT");
    engine.tick();
    expect(engine.entity(target.entityId)?.currentHealth).toBeLessThan(engine.entity(target.entityId)!.maxHealth);
  });

  it("commits Shadowstep only after the authoritative position owner accepts it", () => {
    const repositionPlayer = vi.fn(() => false);
    const engine = createEngine({ repositionPlayer });
    addClass(engine, { classId: "ninja", weaponId: "starter_shuriken",
      skills: ["ninja_v2_shadowstep"], rank: 8 });
    expectCombatError(() => engine.useNormalAbility({ ...authority(), abilityId: "ninja_v2_shadowstep", targetPosition: east(20) }), "ABILITY_POSITION_REJECTED");
    expect(engine.entity("player")?.lat).toBe(origin.lat);
    vi.setSystemTime(Date.now() + 801);
    repositionPlayer.mockReturnValue(true);
    engine.useNormalAbility({ ...authority(), abilityId: "ninja_v2_shadowstep", targetPosition: east(20) });
    expect(engine.entity("player")?.lon).toBeCloseTo(east(20).lon);
  });

  it("publishes deterministic authoritative zone start and end events", () => {
    const engine = createEngine();
    addClass(engine, { classId: "ranger", weaponId: "starter_bow",
      skills: ["ranger_v2_snare_shot"], rank: 11 });
    engine.useNormalAbility({ ...authority(), abilityId: "ranger_v2_snare_shot", targetPosition: east(20) });
    const started = engine.beginDeltaFlush().events.find((event) => event.type === "CLASS_ABILITY_ZONE_STARTED")!;
    expect(started).toMatchObject({ eventId: "player:ranger_v2_snare_shot", abilityId: "ranger_v2_snare_shot", durationMs: 30_000 });
    const ended = collectEvents(engine, 1, (event) => event.type === "CLASS_ABILITY_ZONE_ENDED")[0]!;
    expect(ended.eventId).toBe(started.eventId);
  });
});

type AddClassOptions = {
  classId: ClassId;
  weaponId: EquipmentDefinitionId;
  skills?: string[];
  passives?: Array<string | null>;
  attackPower?: number;
  currentHealth?: number;
  rank?: number;
  resource?: number;
  ultimate?: string;
};

function createEngine(
  overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}
): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    ...overrides
  });
}

function createPartyEngine(): CombatEngine {
  const parties = new InMemoryPartyAuthority();
  parties.loadSnapshots([{
    partyId: "party:00000000-0000-4000-8000-000000000001",
    leaderPlayerId: "player",
    memberPlayerIds: ["ally", "player"],
    memberSlots: [
      { playerId: "player", slotIndex: 0 },
      { playerId: "ally", slotIndex: 1 }
    ],
    membershipRevision: 1,
    allowTravel: false,
    autoFollowPlayerIds: [],
    revision: 1
  }]);
  return createEngine({
    partyAuthority: parties,
    getAuthoritativeViewCircle: () => ({ center: origin, radiusM: 200, generation: 1 })
  });
}

function addPartyAlly(engine: CombatEngine, currentHealth = 100): void {
  engine.connectPlayer({
    playerId: "ally",
    name: "ally",
    regionCode: "NM",
    zoneId: "world:NM",
    position: east(5),
    accountId: "account-ally",
    connectionId: "connection-ally",
    profile: {
      playerId: "ally",
      level: 25,
      maxHealth: 100,
      currentHealth,
      baseAttackDamage: 10,
      defense: 0
    }
  });
}

function addClass(engine: CombatEngine, options: AddClassOptions): void {
  const resource = options.resource ?? 0;
  engine.connectPlayer({
    playerId: "player", name: "player", regionCode: "NM", zoneId: "world:NM", position: origin,
    accountId: "account-player", connectionId: "connection-player",
    profile: { playerId: "player", level: 25, maxHealth: 100, currentHealth: options.currentHealth ?? 100,
      baseAttackDamage: options.attackPower ?? 10, defense: 0 }
  });
  engine.syncPlayerEquipmentCombatState("player", equipmentRuntime(options.weaponId, options.attackPower ?? 10));
  const activeRank = options.rank ?? 15;
  const progress = (classId: ClassId) => ({ classId, level: classId === options.classId ? activeRank : 0,
    xp: 0, nextLevelXp: 1_193, completedAt: null });
  const snapshot: ClassSnapshot = {
    playerId: "player", characterLevel: 25, activeClassId: options.classId, activeSubclassId: null,
    unlockedClassIds: ["warrior", "ranger", "ninja", "knight", "druid"],
    warrior: progress("warrior"),
    classes: ["warrior", "druid", "ranger", "knight", "ninja"].map((id) => progress(id as ClassId)),
    subclasses: [], loadout: { resetActives: [null, null], normalActives: [options.skills?.[0] ?? null, options.skills?.[1] ?? null],
      passiveTiers: [options.passives?.[0] ?? null, options.passives?.[1] ?? null, options.passives?.[2] ?? null], ultimateActive: options.ultimate ?? null },
    legacyIds: [], rage: resource, maximumRage: resource > 0 ? 100 : 0,
    queuedAbility: null, cooldownEndsAt: {}, serverTime: Date.now(), revision: 1
  };
  engine.updatePlayerClassState("player", snapshot, equipment(options.weaponId), {
    rage: resource, rageReserved: 0, queuedAbilityId: null, queuedTargetEntityId: null, queuedAtTick: null,
    cooldownEndsAt: {}, statusEffects: [], counters: {}, combatGeneration: 0, lastCombatAt: null
  });
  engine.beginDeltaFlush();
}

function spawn(engine: CombatEngine, distanceM: number) {
  // A large generic target (the old 770 HP pool); the fixture weapon bypasses
  // the matrix, so these kit tests measure class multipliers on a flat attack.
  return engine.spawnMob({
    archetype: "squid", maxHealthMultiplier: 770 / 49,
    position: east(distanceM), regionCode: "NM", zoneId: "world:NM"
  });
}

function start(engine: CombatEngine, targetEntityId: string): void {
  engine.startAttack({ attackerId: "player", targetEntityId, requestId: `start-${targetEntityId}`, ...authority() });
}

function authority() {
  return { playerId: "player", accountId: "account-player", connectionId: "connection-player" };
}

function collectEvents(engine: CombatEngine, count: number, predicate: (event: CombatEvent) => boolean): CombatEvent[] {
  const matches: CombatEvent[] = [];
  for (let tick = 0; tick < 3_000 && matches.length < count; tick += 1) {
    engine.tick();
    matches.push(...engine.beginDeltaFlush().events.filter(predicate));
  }
  expect(matches).toHaveLength(count);
  return matches;
}

function expectCombatError(run: () => unknown, code: string): void {
  try { run(); throw new Error(`Expected ${code}`); } catch (error) {
    expect(error).toBeInstanceOf(CombatRequestError);
    expect((error as CombatRequestError).code).toBe(code);
  }
}

function equipment(definitionId: EquipmentDefinitionId): EquipmentSnapshot {
  const definition = requireEquipmentDefinition(definitionId);
  return {
    playerId: "player", instances: [],
    weapon: { instanceId: "00000000-0000-4000-8000-000000000001", definitionId,
      displayName: definition.displayName, ownerPlayerId: "player", location: "equipped", equippedSlot: "weapon",
      attackPowerBonus: 0, defenseBonus: 0, weaponCategory: definition.weaponCategory,
      armorCategory: null, twoHanded: definition.twoHanded, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
    chest: null, totalAttackPowerBonus: 0, totalDefenseBonus: 0
  };
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
    // Fixed-damage (defense-bypassing) fixture weapon: these kit tests measure
    // class multipliers, not the universal weapon x armor table.
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

function east(distanceM: number): LatLon {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, distanceM);
}

import { describe, expect, it } from "vitest";

import {
  beatAlignedAmountScale,
  beatAlignedIntervalMs,
  emptyEquipmentSlots,
  MELEE_ATTACK_RANGE_M,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  resolvePvpDamage,
  WEAPON_SWITCH_DELAY_MS,
  WEAPON_SWITCH_HYSTERESIS_M,
  type ActiveEquipmentLoadout,
  type ClassSnapshot,
  type EquipmentCombatStats,
  type EquipmentDefinitionId,
  type LatLon,
  type WeaponCategory
} from "@ash-atlas/shared";

import {
  CombatEngine,
  type PlayerEquipmentCombatState
} from "./combatEngine.js";
import { METAL_PROC_BALANCE } from "./metalProcs.js";
import { resolveMobCombatProfile } from "./mobDefinitions.js";

const ORIGIN = { lat: 35.0844, lon: -106.6504 };
/** The weapon switch delay (a quarter beat) in 20 Hz ticks. */
const SWITCH_TICKS = Math.round(WEAPON_SWITCH_DELAY_MS * 20 / 1_000);

describe("equipment combat tick integration", () => {
  it("never raises current health when a gear scroll swaps max-health gear back and forth", () => {
    const engine = createEngine();
    addPlayer(engine, "swapper", ORIGIN);
    const base = equipmentState({ activeKitIndex: null, characterLevel: 0, warriorRank: 0, itemLevel: 0, weaponCategory: "sword" });
    const boosted: PlayerEquipmentCombatState = {
      ...base,
      stats: { ...base.stats, maximumHealth: base.stats.maximumHealth + 50 }
    };
    engine.syncPlayerEquipmentCombatState("swapper", base);
    const player = internalPlayer(engine, "swapper");
    player.currentHealth = Math.floor(player.maxHealth / 2);
    const startHealth = player.currentHealth;
    const startMax = player.maxHealth;
    const swapTo = (requestId: string, up: boolean) => engine.stageEquipmentCombatUpdate("swapper", {
      requestId, kind: "gear_scroll", state: up ? boosted : base, maxHealth: up ? startMax + 50 : startMax
    });
    for (let swap = 0; swap < 6; swap += 1) {
      swapTo(`scroll-${swap}`, swap % 2 === 0);
      engine.beginTick();
      const after = internalPlayer(engine, "swapper");
      expect(after.maxHealth).toBe(swap % 2 === 0 ? startMax + 50 : startMax);
      expect(after.currentHealth).toBeLessThanOrEqual(startHealth);
    }
    // Dropping below current health clamps it, and swapping back up does not restore it.
    internalPlayer(engine, "swapper").currentHealth = startMax;
    swapTo("scroll-up", true);
    engine.beginTick();
    swapTo("scroll-down", false);
    engine.beginTick();
    expect(internalPlayer(engine, "swapper").currentHealth).toBe(startMax);
  });

  it("never heals when a stats refresh lands between a scroll swap and the tick", () => {
    const engine = createEngine();
    addPlayer(engine, "swapper", ORIGIN);
    const base = equipmentState({ activeKitIndex: null, characterLevel: 0, warriorRank: 0, itemLevel: 0, weaponCategory: "sword" });
    const boosted: PlayerEquipmentCombatState = {
      ...base,
      stats: { ...base.stats, maximumHealth: base.stats.maximumHealth + 50 }
    };
    engine.syncPlayerEquipmentCombatState("swapper", base);
    const startMax = internalPlayer(engine, "swapper").maxHealth;
    internalPlayer(engine, "swapper").currentHealth = Math.floor(startMax / 2);
    const startHealth = internalPlayer(engine, "swapper").currentHealth;
    engine.stageEquipmentCombatUpdate("swapper", {
      requestId: "scroll-up", kind: "gear_scroll", state: boosted, maxHealth: startMax + 50
    });
    // A refresh without preserveCurrentHealth would scale current health up with the new max.
    engine.updatePlayerPveStats("swapper", { level: 1, attackPower: 10, defense: 0, maxHealth: startMax + 50 });
    expect(internalPlayer(engine, "swapper").currentHealth).toBe(startHealth);
    engine.beginTick();
    expect(internalPlayer(engine, "swapper").maxHealth).toBe(startMax + 50);
    expect(internalPlayer(engine, "swapper").currentHealth).toBe(startHealth);
  });

  it("takes max health from the final gear when a later update in the same tick has none", () => {
    const engine = createEngine();
    addPlayer(engine, "swapper", ORIGIN);
    const base = equipmentState({ activeKitIndex: null, characterLevel: 0, warriorRank: 0, itemLevel: 0, weaponCategory: "sword" });
    const boosted: PlayerEquipmentCombatState = {
      ...base,
      stats: { ...base.stats, maximumHealth: base.stats.maximumHealth + 50 }
    };
    engine.syncPlayerEquipmentCombatState("swapper", base);
    const startMax = internalPlayer(engine, "swapper").maxHealth;
    engine.stageEquipmentCombatUpdate("swapper", {
      requestId: "scroll-up", kind: "gear_scroll", state: boosted, maxHealth: startMax + 50
    });
    // A later update back to the base gear carries no max health of its own.
    engine.stageEquipmentCombatUpdate("swapper", { requestId: "kit-base", kind: "kit_activation", state: base });
    engine.beginTick();
    expect(internalPlayer(engine, "swapper").maxHealth).toBe(startMax);
  });

  it("rebuilds max health from scratch on a scroll swap, so a stats refresh before the tick never doubles it", () => {
    const engine = createEngine();
    addPlayer(engine, "swapper", ORIGIN);
    const base = equipmentState({ activeKitIndex: null, characterLevel: 0, warriorRank: 0, itemLevel: 0, weaponCategory: "sword" });
    const boosted: PlayerEquipmentCombatState = {
      ...base,
      stats: { ...base.stats, maximumHealth: base.stats.maximumHealth + 50 }
    };
    engine.syncPlayerEquipmentCombatState("swapper", base);
    const startMax = internalPlayer(engine, "swapper").maxHealth;
    const stats = { level: 1, attackPower: 10, defense: 0 };
    engine.setPlayerMaxHealthPenalty("swapper", { penalty: 10, recoveryAnchorMs: 8.64e15 });
    expect(internalPlayer(engine, "swapper").maxHealth).toBe(startMax - 10);

    engine.stageEquipmentCombatUpdate("swapper", {
      requestId: "scroll-up", kind: "gear_scroll", state: boosted, maxHealth: startMax + 50
    });
    // A stats refresh for the new gear lands before the tick boundary.
    engine.updatePlayerPveStats("swapper", { ...stats, maxHealth: startMax + 50 }, { preserveCurrentHealth: true });
    engine.beginTick();
    expect(internalPlayer(engine, "swapper").maxHealth).toBe(startMax + 50 - 10);
    expect(engine.unpenalizedMaxHealth("swapper")).toBe(startMax + 50);

    // A level-up lands between a staged swap and the tick: the newer stats win over the staged value.
    engine.stageEquipmentCombatUpdate("swapper", {
      requestId: "scroll-same", kind: "gear_scroll", state: boosted, maxHealth: startMax + 50
    });
    engine.updatePlayerPveStats("swapper", { ...stats, level: 2, maxHealth: startMax + 60 }, { preserveCurrentHealth: true });
    engine.beginTick();
    expect(internalPlayer(engine, "swapper").maxHealth).toBe(startMax + 60 - 10);

    internalPlayer(engine, "swapper").currentHealth = startMax + 40;
    engine.stageEquipmentCombatUpdate("swapper", {
      requestId: "scroll-down", kind: "gear_scroll", state: base, maxHealth: startMax
    });
    engine.beginTick();
    expect(internalPlayer(engine, "swapper").maxHealth).toBe(startMax - 10);
    expect(internalPlayer(engine, "swapper").currentHealth).toBe(startMax - 10);
  });

  it("applies a staged complete state before due work without touching scheduling or combat state", () => {
    const applied: Array<{ activationTick: number; requestIds: string[] }> = [];
    const engine = createEngine((result) => applied.push({
      activationTick: result.activationTick,
      requestIds: result.updates.map((update) => update.requestId)
    }));
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "target", east(10));
    engine.syncPlayerEquipmentCombatState("attacker", equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    }));
    engine.syncPlayerEquipmentCombatState("target", equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    }));
    installWarriorRuntime(engine, "attacker");

    engine.startAttack(authority("attacker", "target", "start"));
    const before = internalPlayer(engine, "attacker");
    const preserved = {
      currentHealth: before.currentHealth,
      maxHealth: before.maxHealth,
      targetEntityId: before.targetEntityId,
      nextEligibleAttackTick: before.nextEligibleAttackTick,
      scheduledAttackTick: before.scheduledAttackTick,
      attackScheduleGeneration: before.attackScheduleGeneration,
      rage: before.classRuntime!.rage,
      reservedRage: before.classRuntime!.reservedRage,
      cooldownEndsAt: structuredClone(before.classRuntime!.cooldownEndsAt),
      effects: structuredClone(before.classRuntime!.effects),
      axeActions: before.classRuntime!.counters.axeActions,
      marker: before.classRuntime!.counters.marker,
      combatGeneration: before.classRuntime!.combatGeneration
    };

    engine.stageEquipmentCombatUpdate("attacker", {
      requestId: "kit-before-due-tick",
      kind: "kit_activation",
      state: equipmentState({
        activeKitIndex: 2,
        characterLevel: 25,
        warriorRank: 15,
        itemLevel: 25,
        weaponCategory: "axe"
      })
    });
    engine.beginTick();

    const afterBoundary = internalPlayer(engine, "attacker");
    expect({
      currentHealth: afterBoundary.currentHealth,
      maxHealth: afterBoundary.maxHealth,
      targetEntityId: afterBoundary.targetEntityId,
      nextEligibleAttackTick: afterBoundary.nextEligibleAttackTick,
      scheduledAttackTick: afterBoundary.scheduledAttackTick,
      attackScheduleGeneration: afterBoundary.attackScheduleGeneration,
      rage: afterBoundary.classRuntime!.rage,
      reservedRage: afterBoundary.classRuntime!.reservedRage,
      cooldownEndsAt: afterBoundary.classRuntime!.cooldownEndsAt,
      effects: afterBoundary.classRuntime!.effects,
      axeActions: afterBoundary.classRuntime!.counters.axeActions,
      marker: afterBoundary.classRuntime!.counters.marker,
      combatGeneration: afterBoundary.classRuntime!.combatGeneration
    }).toEqual(preserved);
    expect(afterBoundary.equipmentCombatState?.activeKitIndex).toBe(2);
    expect(engine.entity("target")?.currentHealth).toBe(100);

    engine.finishTick();
    // Axe/unarmored 10.1 +25 weapon + Warrior mastery rounds to 40.
    expect(engine.entity("target")?.currentHealth).toBe(60);
    expect(applied).toEqual([{
      activationTick: 1,
      requestIds: ["kit-before-due-tick"]
    }]);
    const landed = engine.beginDeltaFlush().events.filter((event) =>
      event.type === "ATTACK_LANDED" &&
      event.sourceEntityId === "attacker" &&
      event.targetEntityId === "target"
    );
    expect(landed).toHaveLength(1);
  });

  it("defers a request staged after beginTick until the following boundary", () => {
    const engine = createEngine();
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "target", east(10));
    const levelZero = equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    });
    engine.syncPlayerEquipmentCombatState("attacker", levelZero);
    engine.syncPlayerEquipmentCombatState("target", levelZero);
    engine.startAttack(authority("attacker", "target", "start-after-boundary"));

    engine.beginTick();
    engine.stageEquipmentCombatUpdate("attacker", {
      requestId: "kit-after-begin",
      kind: "kit_activation",
      state: equipmentState({
        activeKitIndex: 3,
        characterLevel: 25,
        warriorRank: 15,
        itemLevel: 25,
        weaponCategory: "axe"
      })
    });
    engine.finishTick();

    expect(engine.entity("target")?.currentHealth).toBe(91);
    expect(internalPlayer(engine, "attacker").equipmentCombatState?.activeKitIndex).toBe(1);
    const dueAfterFirstAttack = internalPlayer(engine, "attacker").nextEligibleAttackTick;

    engine.beginTick();
    expect(internalPlayer(engine, "attacker").equipmentCombatState?.activeKitIndex).toBe(3);
    expect(internalPlayer(engine, "attacker").nextEligibleAttackTick).toBe(dueAfterFirstAttack);
    expect(engine.entity("target")?.currentHealth).toBe(91);
    engine.finishTick();
    expect(engine.entity("target")?.currentHealth).toBe(91);
  });

  it("coalesces same-boundary equipment refreshes without creating an action", () => {
    const engine = createEngine();
    addPlayer(engine, "player", ORIGIN);
    const initial = equipmentState({
      activeKitIndex: 1,
      characterLevel: 25,
      warriorRank: 15,
      itemLevel: 0,
      weaponCategory: "axe"
    });
    engine.syncPlayerEquipmentCombatState("player", initial);
    const before = internalPlayer(engine, "player");

    engine.stageEquipmentCombatUpdate("player", {
      requestId: "upgrade-0-to-1",
      kind: "active_item_upgrade",
      state: equipmentState({
        activeKitIndex: 1,
        characterLevel: 25,
        warriorRank: 15,
        itemLevel: 1,
        weaponCategory: "axe"
      })
    });
    engine.stageEquipmentCombatUpdate("player", {
      requestId: "readied-confirm",
      kind: "readied_weapon",
      state: equipmentState({
        activeKitIndex: null,
        characterLevel: 25,
        warriorRank: 15,
        itemLevel: 1,
        weaponCategory: "axe"
      })
    });
    engine.beginTick();

    const after = internalPlayer(engine, "player");
    expect(after.equipmentCombatState?.stats.weaponItemLevel).toBe(1);
    expect(after.equipmentCombatState?.activeKitIndex).toBeNull();
    expect(after.nextEligibleAttackTick).toBe(before.nextEligibleAttackTick);
    expect(after.scheduledAttackTick).toBeNull();
    expect(engine.metricsSnapshot().dueAttacksProcessed).toBe(0);
    engine.finishTick();
    expect(engine.beginDeltaFlush().events.filter((event) =>
      event.type === "ATTACK_LANDED"
    )).toHaveLength(0);
  });

  it("uses the same V3 matrix for basics and Empowered Hit", () => {
    const basicEngine = createEngine();
    addPlayer(basicEngine, "attacker", ORIGIN);
    addPlayer(basicEngine, "target", east(10));
    const neutral = equipmentState({
      activeKitIndex: 1,
      characterLevel: 25,
      warriorRank: 15,
      itemLevel: 25,
      weaponCategory: "axe"
    });
    const neutralDefender = structuredClone(neutral);
    installAuthoritativeEquipment(basicEngine, "attacker", neutral);
    installAuthoritativeEquipment(basicEngine, "target", neutralDefender);
    installWarriorRuntime(basicEngine, "attacker");
    basicEngine.syncPlayerEquipmentCombatState("attacker", neutral);
    basicEngine.startAttack(authority("attacker", "target", "neutral-basic"));
    basicEngine.tick();
    expect(basicEngine.entity("target")?.currentHealth).toBe(60);

    const abilityEngine = createEngine();
    addPlayer(abilityEngine, "attacker", ORIGIN);
    addPlayer(abilityEngine, "target", east(10));
    installAuthoritativeEquipment(abilityEngine, "attacker", neutral);
    installAuthoritativeEquipment(abilityEngine, "target", neutralDefender);
    installWarriorRuntime(abilityEngine, "attacker", {
      normalActives: ["warrior_empowered_hit", null]
    });
    abilityEngine.syncPlayerEquipmentCombatState("attacker", neutral);
    abilityEngine.startAttack(authority("attacker", "target", "empowered-hit"));
    const scheduledTick = internalPlayer(abilityEngine, "attacker").scheduledAttackTick;

    const armed = abilityEngine.useNormalAbility({
      ...abilityAuthority("attacker"),
      abilityId: "warrior_empowered_hit",
      targetEntityId: "attacker",
      targetMode: "self"
    });

    expect(armed.pveCombat).toBeNull();
    expect(armed.classCombat?.resource).toBeUndefined();
    expect(armed.classCombat?.queuedAbility).toBeNull();
    expect(armed.classCombat?.cooldownEndsAt.warrior_empowered_hit).toBeGreaterThan(0);
    expect(internalPlayer(abilityEngine, "attacker").scheduledAttackTick).toBe(scheduledTick);
    expect(abilityEngine.entity("target")?.currentHealth).toBe(100);

    for (let tick = 0; tick < 40 && abilityEngine.entity("target")?.currentHealth === 100; tick += 1) {
      abilityEngine.tick();
    }

    // Basic damage 40 (unarmored 10.1 + 25 weapon + Warrior mastery), then Empowered Hit 1.23.
    const empoweredDamage = Math.round(40 * 1.23);
    expect(abilityEngine.entity("target")?.currentHealth).toBe(100 - empoweredDamage);
    expect(abilityEngine.hasQueuedAbility("attacker")).toBe(false);
    expect(abilityEngine.entity("attacker")?.classCombat?.resource).toBeUndefined();
    expect(abilityEngine.beginDeltaFlush().events.filter((event) =>
      event.type === "ATTACK_LANDED" &&
      event.sourceEntityId === "attacker" &&
      event.targetEntityId === "target"
    )).toHaveLength(1);
  });

  it("uses Damage Matrix V3 for direct PvP basics and class-skill multipliers", () => {
    const attackerEquipment = matrixEquipmentState({
      weaponDefinitionId: "starter_sword",
      weaponLevel: 12,
      ringDefinitionId: "attack_ring"
    });
    const defenderEquipment = matrixEquipmentState({
      weaponDefinitionId: "starter_sword",
      weaponLevel: 0,
      chestDefinitionId: requireEquipmentDefinition("breast_plate").definitionId,
      chestLevel: 10,
      shieldDefinitionId: "training_shield",
      shieldLevel: 5
    });

    const basicEngine = createEngine();
    addPlayer(basicEngine, "attacker", ORIGIN);
    addPlayer(basicEngine, "target", east(10));
    installAuthoritativeEquipment(basicEngine, "attacker", attackerEquipment);
    installAuthoritativeEquipment(basicEngine, "target", defenderEquipment);
    basicEngine.startAttack(authority("attacker", "target", "matrix-basic"));
    basicEngine.tick();
    // Sword/breastplate4 +12 weapon -10 armor +3 attack ring =9.
    expect(basicEngine.entity("target")?.currentHealth).toBe(91);
    expect(Number.isInteger(basicEngine.entity("target")!.currentHealth)).toBe(true);

    const abilityEngine = createEngine();
    addPlayer(abilityEngine, "attacker", ORIGIN);
    addPlayer(abilityEngine, "target", east(10));
    installAuthoritativeEquipment(abilityEngine, "attacker", attackerEquipment);
    installAuthoritativeEquipment(abilityEngine, "target", defenderEquipment);
    installWarriorRuntime(abilityEngine, "attacker", {
      normalActives: ["warrior_empowered_hit", null]
    });
    abilityEngine.startAttack(authority("attacker", "target", "matrix-ability"));
    abilityEngine.useNormalAbility({
      ...abilityAuthority("attacker"),
      abilityId: "warrior_empowered_hit",
      targetEntityId: "attacker",
      targetMode: "self"
    });
    for (let tick = 0; tick < 40 && abilityEngine.entity("target")?.currentHealth === 100; tick += 1) {
      abilityEngine.tick();
    }
    expect(abilityEngine.entity("target")?.currentHealth).toBe(89);
    expect(Number.isInteger(abilityEngine.entity("target")!.currentHealth)).toBe(true);
  });

  it("applies Concussive Blow without inventing direct PvP damage", () => {
    const engine = createEngine();
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "target", east(10));
    const attackerEquipment = equipmentState({
      activeKitIndex: 1,
      characterLevel: 25,
      warriorRank: 15,
      itemLevel: 25,
      weaponCategory: "axe"
    });
    const targetEquipment = equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    });
    installAuthoritativeEquipment(engine, "attacker", attackerEquipment);
    installAuthoritativeEquipment(engine, "target", targetEquipment);
    installWarriorRuntime(engine, "attacker", {
      normalActives: ["warrior_concussive_blow", null]
    });
    engine.startAttack(authority("attacker", "target", "public-normal"));
    const scheduledTick = internalPlayer(engine, "attacker").scheduledAttackTick;

    const queued = engine.useNormalAbility({
      ...abilityAuthority("attacker"),
      abilityId: "warrior_concussive_blow",
      targetEntityId: "target",
      targetMode: "hostile"
    });

    expect(queued.pveCombat).toBeNull();
    expect(queued.classCombat?.resource).toBeUndefined();
    expect(queued.classCombat?.queuedAbility).toMatchObject({
      abilityId: "warrior_concussive_blow",
      targetEntityId: "target"
    });
    expect(internalPlayer(engine, "attacker").scheduledAttackTick).toBe(scheduledTick);
    expect(engine.entity("target")?.currentHealth).toBe(100);

    engine.tick();

    expect(engine.entity("target")?.currentHealth).toBe(100);
    expect(engine.hasQueuedAbility("attacker")).toBe(false);
    expect(engine.entity("attacker")?.classCombat?.resource).toBeUndefined();
    expect(
      internalPlayer(engine, "attacker").classRuntime?.cooldownEndsAt.warrior_concussive_blow
    ).toBeGreaterThan(Date.now());
    expect(engine.beginDeltaFlush().events.filter((event) =>
      event.type === "ATTACK_LANDED" &&
      event.sourceEntityId === "attacker" &&
      event.targetEntityId === "target"
    )).toHaveLength(0);
  });

  it("finalizes a tick-boundary kit activation while the connected player is outside combat world", () => {
    const applied: string[] = [];
    const engine = createEngine((result) => {
      applied.push(...result.updates.map((update) => update.requestId));
    });
    engine.stageEquipmentCombatUpdate("manor-player", {
      requestId: "manor-kit-swap",
      kind: "kit_activation",
      state: equipmentState({
        activeKitIndex: 4,
        characterLevel: 25,
        warriorRank: 15,
        itemLevel: 25,
        weaponCategory: "axe"
      })
    });

    engine.tick();

    expect(applied).toEqual(["manor-kit-swap"]);
    expect(engine.entity("manor-player")).toBeNull();
  });

  it("cancels an unapplied equipment boundary when the player disconnects", () => {
    const applied: string[] = [];
    const engine = createEngine((result) => {
      applied.push(...result.updates.map((update) => update.requestId));
    });
    engine.stageEquipmentCombatUpdate("disconnecting-player", {
      requestId: "disconnect-before-boundary",
      kind: "kit_activation",
      state: equipmentState({
        activeKitIndex: 2,
        characterLevel: 0,
        warriorRank: 0,
        itemLevel: 0,
        weaponCategory: "sword"
      })
    });
    engine.cancelPendingEquipmentCombatUpdates("disconnecting-player");

    engine.tick();

    expect(applied).toEqual([]);
  });

  it("stores unscaled PvP bleed and brand damage and power-scales each tick exactly once", () => {
    const engine = createEngine();
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "target", east(10));
    installWarriorRuntime(engine, "attacker");

    const attackerEquipment = equipmentState({
      activeKitIndex: 1,
      characterLevel: 25,
      warriorRank: 15,
      itemLevel: 25,
      weaponCategory: "axe"
    });
    attackerEquipment.stats = {
      ...attackerEquipment.stats,
      pvpOffense: 15
    };
    const targetEquipment = equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    });
    targetEquipment.stats = {
      ...targetEquipment.stats,
      pvpGuard: 0
    };
    engine.syncPlayerEquipmentCombatState("attacker", attackerEquipment);
    engine.syncPlayerEquipmentCombatState("target", targetEquipment);

    const internals = periodicDamageInternals(engine);
    const attacker = internals.entities.get("attacker")!;
    const target = internals.entities.get("target")!;

    // Rending's direct hit has already been power-scaled to 30 here. Its
    // stored bleed base must instead derive from the unscaled ten damage.
    internals.applyHunterBleed(
      attacker,
      target,
      "stalker_rending_strike",
      30,
      10
    );
    const bleed = target.classRuntime!.effects.find((effect) =>
      effect.kind === "queue_bleed"
    )!;
    expect(bleed.amount).toBe(2);

    internals.resolveQueueBleedTurn(target);
    const expectedBleed = resolvePvpDamage({
      attackerOffense: attackerEquipment.stats.universalAttackPower,
      defenderGuard: targetEquipment.stats.universalDefense,
      damageBeforePowerScaling: 2
    }).finalDamage;
    expect(target.currentHealth).toBe(100 - expectedBleed);

  });

  it("applies Venomsteel weapon poison to a living mob after a successful server roll", () => {
    const engine = createEngine(undefined, () => 0.149999);
    addPlayer(engine, "attacker", ORIGIN);
    const state = equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    });
    state.activeWeaponEnchantmentIdentity = "enh:v1:opal:venomsteel";
    state.weaponSlots.melee.enchantmentIdentity = "enh:v1:opal:venomsteel";
    engine.syncPlayerEquipmentCombatState("attacker", state);
    const target = engine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const targetInternal = (engine as unknown as {
      entities: Map<string, { currentHealth: number; maxHealth: number }>;
    }).entities.get(target.entityId)!;
    targetInternal.currentHealth = 1_000;
    targetInternal.maxHealth = 1_000;

    engine.startAttack(authority("attacker", target.entityId, "venom-weapon-hit"));
    engine.tick();
    const healthAfterWeaponHit = engine.entity(target.entityId)!.currentHealth;
    expect(engine.entity(target.entityId)?.harmfulStatusIds).toEqual(["poison"]);
    engine.cancelAttack("attacker");
    // Venom: 2-6 damage per 3.5 s, ticking on the beat with the roll scaled to the beat interval
    // (the fixed roll lands the minimum of 2).
    const { tickMs, damageMin } = METAL_PROC_BALANCE.poison;
    for (let tick = 0; tick < beatAlignedIntervalMs(tickMs) * 20 / 1_000 + 4; tick += 1) engine.tick();

    expect(engine.entity(target.entityId)?.currentHealth)
      .toBe(healthAfterWeaponHit - Math.floor(damageMin * beatAlignedAmountScale(tickMs)));
  });

  it("settles a mob defeated by Venomsteel poison with the player's full contribution", () => {
    const settlements: Array<Parameters<NonNullable<
      ConstructorParameters<typeof CombatEngine>[0]["onDefeatSettlementCandidate"]
    >>[0]> = [];
    const engine = createEngine(undefined, () => 0.149999, (candidate) => {
      settlements.push(candidate);
      return true;
    });
    addPlayer(engine, "attacker", ORIGIN);
    const state = equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    });
    state.activeWeaponEnchantmentIdentity = "enh:v1:opal:venomsteel";
    state.weaponSlots.melee.enchantmentIdentity = "enh:v1:opal:venomsteel";
    engine.syncPlayerEquipmentCombatState("attacker", state);
    const target = engine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const targetInternal = (engine as unknown as {
      entities: Map<string, { currentHealth: number; maxHealth: number }>;
    }).entities.get(target.entityId)!;
    targetInternal.currentHealth = 11;
    targetInternal.maxHealth = 11;

    engine.startAttack(authority("attacker", target.entityId, "venom-lethal-tick"));
    engine.tick();
    engine.cancelAttack("attacker");
    for (let tick = 0; tick < 240; tick += 1) engine.tick();

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      defeatedEntityId: target.entityId,
      defeatingPlayerId: "attacker",
      eligibleParticipantIds: ["attacker"],
      contributions: [{ entityId: "attacker", damage: 11 }]
    });
    expect(engine.entity(target.entityId)).toBeNull();
  });

  it("uses one Venomsteel armor retaliation roll after direct damage", () => {
    const engine = createEngine(undefined, () => 0.099999);
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "defender", east(10));
    const attackerState = equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    });
    const defenderState = structuredClone(attackerState);
    defenderState.armorEnchantmentIdentities.chest = "enh:v1:ruby:venomsteel";
    defenderState.armorEnchantmentIdentities.gloves = "enh:v1:opal:venomsteel";
    defenderState.reactiveArmorEnhancements = [
      { instanceId: "chest", enchantmentIdentity: "enh:v1:ruby:venomsteel", itemLevel: 0 },
      { instanceId: "gloves", enchantmentIdentity: "enh:v1:opal:venomsteel", itemLevel: 0 }
    ];
    engine.syncPlayerEquipmentCombatState("attacker", attackerState);
    engine.syncPlayerEquipmentCombatState("defender", defenderState);

    engine.startAttack(authority("attacker", "defender", "venom-armor-hit"));
    engine.tick();

    expect(engine.entity("attacker")?.harmfulStatusIds).toEqual(["poison"]);
  });

  it("retaliates against a PvE mob (the mob level lowers the quality multiplier) from equipped Venomsteel armor", () => {
    const engine = createEngine(undefined, () => 0.05);
    addPlayer(engine, "defender", ORIGIN);
    const defenderState = equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    });
    defenderState.armorEnchantmentIdentities.chest = "enh:v1:ruby:venomsteel";
    defenderState.reactiveArmorEnhancements = [
      { instanceId: "chest", enchantmentIdentity: "enh:v1:ruby:venomsteel", itemLevel: 0 }
    ];
    engine.syncPlayerEquipmentCombatState("defender", defenderState);
    const mob = engine.spawnMob({
      archetype: "goblin",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const internal = engine as unknown as {
      entities: Map<string, unknown>;
      applyDamage(
        attacker: unknown,
        target: unknown,
        damage: number,
        techniqueId: string,
        direct: boolean
      ): number;
    };

    internal.applyDamage(
      internal.entities.get(mob.entityId),
      internal.entities.get("defender"),
      10,
      "enemy_basic_attack",
      true
    );

    expect(engine.entity(mob.entityId)?.harmfulStatusIds).toEqual(["poison"]);
  });

  it("keeps the God Sword readied for a ranged-priority basic attack", () => {
    const engine = createEngine();
    addPlayer(engine, "attacker", ORIGIN);
    const godSword = equipmentState({
      activeKitIndex: 1,
      characterLevel: 25,
      warriorRank: 1,
      itemLevel: 0,
      weaponCategory: "sword"
    });
    godSword.stats.weaponAttackPower.melee = 1_000;
    godSword.stats.universalAttackPower = 1_000;
    godSword.stats.pveAttackPower = 1_000;
    godSword.stats.bypassPveDefense = true;
    godSword.weaponSlots.melee.definitionId = "god_sword";
    godSword.weaponSlots.secondary = {
      instanceId: "secondary-bow",
      definitionId: "starter_bow",
      category: "bow",
      enchantmentIdentity: null
    };
    godSword.stats.weaponAttackPower.secondary = 30;
    godSword.stats.weaponCategories.secondary = "bow";
    godSword.switchPolicy = "ranged_priority";
    installAuthoritativeEquipment(engine, "attacker", godSword);
    const target = engine.spawnMob({
      archetype: "xoral",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM",
      worldAi: false,
      bossEventState: "active"
    });
    const targetInternal = (engine as unknown as {
      entities: Map<string, { currentHealth: number; maxHealth: number; defense: number }>;
    }).entities.get(target.entityId)!;
    targetInternal.currentHealth = 2_000;
    targetInternal.maxHealth = 2_000;
    targetInternal.defense = 50;

    engine.startAttack(authority("attacker", target.entityId, "god-sword-hit"));
    engine.tick();

    expect(engine.entity(target.entityId)?.currentHealth).toBe(1_000);
    expect(internalPlayer(engine, "attacker").equipmentCombatState).toMatchObject({
      activeWeaponSlot: "melee",
      switchingToSlot: null
    });
  });

  it("refreshes duplicate staged activation stats without adding another action", () => {
    const appliedLevels: number[] = [];
    const engine = createEngine((result) => {
      appliedLevels.push(result.state.stats.characterLevel);
    });
    const initial = engine.stageEquipmentCombatUpdate("context-player", {
      requestId: "same-kit-request",
      kind: "kit_activation",
      state: equipmentState({
        activeKitIndex: 1,
        characterLevel: 0,
        warriorRank: 0,
        itemLevel: 0,
        weaponCategory: "axe"
      })
    });
    const refreshed = engine.stageEquipmentCombatUpdate("context-player", {
      requestId: "same-kit-request",
      kind: "kit_activation",
      state: equipmentState({
        activeKitIndex: 1,
        characterLevel: 25,
        warriorRank: 15,
        itemLevel: 0,
        weaponCategory: "axe"
      })
    });

    engine.tick();

    expect(initial.staged).toBe(true);
    expect(refreshed.staged).toBe(false);
    expect(appliedLevels).toEqual([25]);
    expect(engine.metricsSnapshot().dueAttacksProcessed).toBe(0);
  });

  it("switches to ranged over exactly the switch delay and uses the ranged enhancement identity", () => {
    const engine = createEngine(undefined, () => 0.149999);
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "target", east(MELEE_ATTACK_RANGE_M + 20));
    const dualWeapons = dualWeaponEquipmentState();
    dualWeapons.weaponSlots.secondary.enchantmentIdentity = "enh:v1:opal:venomsteel";
    engine.syncPlayerEquipmentCombatState("attacker", dualWeapons);
    engine.syncPlayerEquipmentCombatState("target", equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    }));

    engine.startAttack(authority("attacker", "target", "automatic-ranged"));
    engine.tick();

    expect(engine.entity("target")?.currentHealth).toBe(100);
    expect(internalPlayer(engine, "attacker").equipmentCombatState).toMatchObject({
      activeWeaponSlot: "melee",
      switchingToSlot: "secondary",
      switchStartedAtTick: 1,
      switchCompletesAtTick: 1 + SWITCH_TICKS
    });
    expect(engine.beginDeltaFlush().events).toContainEqual(
      expect.objectContaining({
        type: "WEAPON_SWITCH_STARTED",
        tick: 1,
        sourceEntityId: "attacker",
        weaponSlot: "secondary",
        previousWeaponSlot: "melee"
      })
    );

    for (let tick = 2; tick < 1 + SWITCH_TICKS; tick += 1) {
      engine.tick();
      expect(engine.entity("target")?.currentHealth).toBe(100);
    }

    engine.tick();

    // PvP ranged rows use the tuned matrix values.
    expect(engine.entity("target")?.currentHealth).toBe(73);
    expect(engine.entity("target")?.harmfulStatusIds).toEqual(["poison"]);
    expect(internalPlayer(engine, "attacker").equipmentCombatState).toMatchObject({
      activeWeaponSlot: "secondary",
      switchingToSlot: null,
      switchStartedAtTick: null,
      switchCompletesAtTick: null
    });
    const completionEvents = engine.beginDeltaFlush().events;
    expect(completionEvents).toContainEqual(
      expect.objectContaining({
        type: "WEAPON_SWITCH_COMPLETED",
        tick: 1 + SWITCH_TICKS,
        sourceEntityId: "attacker",
        weaponSlot: "secondary",
        previousWeaponSlot: "melee"
      })
    );
    expect(completionEvents).toContainEqual(
      expect.objectContaining({
        type: "ATTACK_LANDED",
        tick: 1 + SWITCH_TICKS,
        sourceEntityId: "attacker",
        targetEntityId: "target",
        amount: 27
      })
    );
  });

  it("cancels and recomputes an in-progress switch when movement crosses hysteresis", () => {
    const engine = createEngine();
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "target", east(MELEE_ATTACK_RANGE_M + 20));
    engine.syncPlayerEquipmentCombatState("attacker", dualWeaponEquipmentState());
    engine.syncPlayerEquipmentCombatState("target", equipmentState({
      activeKitIndex: 1,
      characterLevel: 0,
      warriorRank: 0,
      itemLevel: 0,
      weaponCategory: "sword"
    }));

    engine.startAttack(authority("attacker", "target", "movement-recompute"));
    engine.tick();
    engine.beginDeltaFlush();

    engine.syncPlayer({
      playerId: "attacker",
      position: east(30),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    expect(engine.entity("target")?.currentHealth).toBe(100);
    expect(internalPlayer(engine, "attacker").equipmentCombatState).toMatchObject({
      activeWeaponSlot: "melee",
      switchingToSlot: null,
      switchStartedAtTick: null,
      switchCompletesAtTick: null
    });
    expect(engine.beginDeltaFlush().events).toContainEqual(
      expect.objectContaining({
        type: "WEAPON_SWITCH_CANCELLED",
        tick: 1,
        sourceEntityId: "attacker",
        weaponSlot: "secondary",
        previousWeaponSlot: "melee"
      })
    );

    engine.tick();
    expect(engine.entity("target")?.currentHealth).toBe(91);
  });

  it("uses the five-meter melee-priority hysteresis and never treats a shield as ranged", () => {
    const engine = createEngine();
    const desiredWeaponSlot = (
      engine as unknown as {
        desiredWeaponSlot(
          state: PlayerEquipmentCombatState,
          distanceM: number,
          requirement: "melee" | "ranged" | "shield" | "any"
        ): "melee" | "secondary" | null;
      }
    ).desiredWeaponSlot.bind(engine);
    const state = dualWeaponEquipmentState();

    expect(desiredWeaponSlot(state, MELEE_ATTACK_RANGE_M + WEAPON_SWITCH_HYSTERESIS_M, "any")).toBe("melee");
    expect(desiredWeaponSlot(state, MELEE_ATTACK_RANGE_M + WEAPON_SWITCH_HYSTERESIS_M + 0.01, "any")).toBe("secondary");

    state.activeWeaponSlot = "secondary";
    expect(desiredWeaponSlot(state, MELEE_ATTACK_RANGE_M + 0.01, "any")).toBe("secondary");
    expect(desiredWeaponSlot(state, MELEE_ATTACK_RANGE_M, "any")).toBe("melee");
    expect(desiredWeaponSlot(state, 200, "melee")).toBe("melee");
    expect(desiredWeaponSlot(state, 10, "ranged")).toBe("secondary");

    state.weaponSlots.melee.definitionId = "god_sword";
    state.switchPolicy = "ranged_priority";
    expect(desiredWeaponSlot(state, 200, "any")).toBe("melee");
    expect(desiredWeaponSlot(state, 10, "ranged")).toBe("secondary");

    state.weaponSlots.secondary = {
      instanceId: null,
      category: "shield",
      enchantmentIdentity: null
    };
    expect(desiredWeaponSlot(state, 200, "any")).toBe("melee");
    expect(desiredWeaponSlot(state, 200, "ranged")).toBeNull();

    state.weaponSlots.melee = {
      instanceId: null,
      category: null,
      enchantmentIdentity: null
    };
    state.weaponSlots.secondary = {
      instanceId: null,
      category: null,
      enchantmentIdentity: null
    };
    state.switchPolicy = "ranged_only";
    expect(desiredWeaponSlot(state, 200, "any")).toBe("melee");
    expect(desiredWeaponSlot(state, 200, "melee")).toBeNull();
    expect(desiredWeaponSlot(state, 10, "ranged")).toBeNull();
    expect(desiredWeaponSlot(state, 10, "shield")).toBeNull();
  });
});

describe("universal damage table with equipped gear", () => {
  it.each([
    ["starter_sword", 10, 8],
    ["starter_bow", 60, 4]
  ] as const)("lands %s into a level-10 Wolf at table + (weapon level - mob level)", (weaponDefinitionId, distanceM, expected) => {
    const engine = createEngine();
    addPlayer(engine, "attacker", ORIGIN);
    installAuthoritativeEquipment(engine, "attacker", matrixEquipmentState({
      weaponDefinitionId,
      weaponLevel: 10
    }));
    const wolf = engine.spawnMob({
      entityId: "mob:test:0", archetype: "wolf", combatProfile: resolveMobCombatProfile("wolf", 10),
      position: east(distanceM), regionCode: "NM", zoneId: "world:NM"
    });
    engine.startAttack(authority("attacker", wolf.entityId, `matrix-${weaponDefinitionId}`));
    let firstHit: number | null = null;
    for (let tick = 0; tick < 100 && firstHit === null; tick += 1) {
      engine.tick();
      firstHit = engine.beginDeltaFlush().events.find((event) =>
        event.type === "DAMAGE" && event.sourceEntityId === "attacker" &&
        event.targetEntityId === wolf.entityId)?.amount ?? null;
    }
    // Sword and Longbow into Tunic (the Wolf's Fur) are 8 and 4; levels match.
    expect(firstHit).toBe(expected);
  });
});

describe("damage matrix v4 flag (DAMAGE_MATRIX_V4_ENABLED)", () => {
  type Hit = readonly [source: string, target: string, amount: number];
  const breastplateAndShield = matrixEquipmentState({
    weaponDefinitionId: "starter_sword",
    weaponLevel: 0,
    chestDefinitionId: requireEquipmentDefinition("breast_plate").definitionId,
    chestLevel: 8,
    shieldDefinitionId: "training_shield",
    shieldLevel: 5
  });

  /** A sword player and a level-10 Wolf trade blows; a bow player shoots a level-12 Skeleton. Every DAMAGE event. */
  function pveFight(damageMatrixV4: boolean | undefined): Hit[] {
    const engine = createEngine(undefined, () => 0.5, undefined, damageMatrixV4);
    addPlayer(engine, "swordsman", ORIGIN);
    installAuthoritativeEquipment(engine, "swordsman", matrixEquipmentState({
      weaponDefinitionId: "starter_sword",
      weaponLevel: 10,
      chestDefinitionId: requireEquipmentDefinition("breast_plate").definitionId,
      chestLevel: 8,
      shieldDefinitionId: "training_shield",
      shieldLevel: 5
    }));
    addPlayer(engine, "archer", east(400));
    installAuthoritativeEquipment(engine, "archer", matrixEquipmentState({ weaponDefinitionId: "starter_bow", weaponLevel: 10 }));
    const wolf = engine.spawnMob({
      entityId: "mob:test:wolf", archetype: "wolf", combatProfile: resolveMobCombatProfile("wolf", 10),
      position: east(10), regionCode: "NM", zoneId: "world:NM"
    });
    const skeleton = engine.spawnMob({
      entityId: "mob:test:skeleton", archetype: "skeleton", combatProfile: resolveMobCombatProfile("skeleton", 12),
      position: east(460), regionCode: "NM", zoneId: "world:NM"
    });
    engine.startAttack(authority("swordsman", wolf.entityId, "v4-sword"));
    engine.startAttack(authority("archer", skeleton.entityId, "v4-bow"));
    const hits: Hit[] = [];
    for (let tick = 0; tick < 300; tick += 1) {
      engine.tick();
      for (const event of engine.beginDeltaFlush().events) {
        if (event.type === "DAMAGE") hits.push([event.sourceEntityId ?? "", event.targetEntityId ?? "", event.amount ?? 0]);
      }
    }
    return hits;
  }

  /** Sword +12 with an attack ring into breastplate 8 + shield 5: the first three PvP basics. */
  function pvpFight(damageMatrixV4: boolean | undefined): number[] {
    const engine = createEngine(undefined, () => 0.5, undefined, damageMatrixV4);
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "target", east(10));
    installAuthoritativeEquipment(engine, "attacker", matrixEquipmentState({
      weaponDefinitionId: "starter_sword", weaponLevel: 12, ringDefinitionId: "attack_ring"
    }));
    installAuthoritativeEquipment(engine, "target", breastplateAndShield);
    engine.startAttack(authority("attacker", "target", "v4-pvp"));
    const amounts: number[] = [];
    for (let tick = 0; tick < 200 && amounts.length < 3; tick += 1) {
      engine.tick();
      for (const event of engine.beginDeltaFlush().events) {
        if (event.type === "DAMAGE" && event.sourceEntityId === "attacker") amounts.push(event.amount ?? 0);
      }
    }
    return amounts;
  }

  it("flag off is today's damage, hit for hit (golden values recorded before v4 was wired)", () => {
    const today = pveFight(undefined);
    expect(pveFight(false)).toEqual(today);
    expect(today).toEqual(PVE_GOLDEN_HITS);
    expect(pvpFight(false)).toEqual(pvpFight(undefined));
    expect(pvpFight(false)).toEqual(PVP_GOLDEN_HITS);
  });

  it("flag on resolves the same fights on v4 (base x multiplier x 5%-per-level factor)", () => {
    const first = (hits: Hit[], source: string, target: string) =>
      hits.find(([from, to]) => from === source && to === target)?.[2];
    const v4 = pveFight(true);
    // Sword 10 into the level-10 Wolf (leather): 8 x 1.15 = 9.2.
    expect(first(v4, "swordsman", "mob:test:wolf")).toBe(9);
    // Bow 10 into the level-12 Skeleton (bone): 7 x 0.5 x 0.9 = 3.15.
    expect(first(v4, "archer", "mob:test:skeleton")).toBe(3);
    // Skeleton (low tier, base 7, slash) 12 into a bare archer (level 1): 7 x 1.5 x 1.5 (capped) = 15.75.
    expect(first(v4, "mob:test:skeleton", "archer")).toBe(16);
    // Wolf (low tier, base 7, slash) 10 into breastplate 8 + shield 5: min(7 x 0.6 x 1.1, 7 x 0.6 x 1.25) = 4.62.
    expect(first(v4, "mob:test:wolf", "swordsman")).toBe(5);
    // PvP: (sword 8 + attack ring 3) into breastplate 8 + shield 5: min(11 x 0.6 x 1.2, 11 x 0.6 x 1.35) = 7.92.
    expect(pvpFight(true)).toEqual([8, 8, 8]);
  });
});

const PVE_GOLDEN_HITS: readonly (readonly [string, string, number])[] = [
  ["swordsman", "mob:test:wolf", 8], ["archer", "mob:test:skeleton", 2], ["mob:test:skeleton", "archer", 20],
  ["mob:test:wolf", "swordsman", 11], ["archer", "mob:test:skeleton", 2], ["swordsman", "mob:test:wolf", 8],
  ["mob:test:skeleton", "archer", 20], ["mob:test:wolf", "swordsman", 13], ["archer", "mob:test:skeleton", 2],
  ["swordsman", "mob:test:wolf", 8], ["mob:test:skeleton", "archer", 20], ["mob:test:wolf", "swordsman", 13],
  ["archer", "mob:test:skeleton", 2], ["swordsman", "mob:test:wolf", 3], ["mob:test:skeleton", "archer", 20],
  ["archer", "mob:test:skeleton", 2], ["mob:test:skeleton", "archer", 20]
];
const PVP_GOLDEN_HITS: readonly number[] = [11, 11, 11];

function createEngine(
  onApplied?: NonNullable<
    ConstructorParameters<typeof CombatEngine>[0]["onEquipmentCombatUpdatesApplied"]
  >,
  random?: () => number,
  onDefeatSettlementCandidate?: NonNullable<
    ConstructorParameters<typeof CombatEngine>[0]["onDefeatSettlementCandidate"]
  >,
  damageMatrixV4?: boolean
): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    ...(damageMatrixV4 === undefined ? {} : { damageMatrixV4Enabled: () => damageMatrixV4 }),
    ...(random ? { random } : {}),
    ...(onDefeatSettlementCandidate ? { onDefeatSettlementCandidate } : {}),
    ...(onApplied ? { onEquipmentCombatUpdatesApplied: onApplied } : {})
  });
}

function addPlayer(engine: CombatEngine, playerId: string, position: LatLon): void {
  engine.connectPlayer({
    playerId,
    name: playerId,
    regionCode: "NM",
    zoneId: "world:NM",
    position,
    accountId: `account-${playerId}`,
    connectionId: `connection-${playerId}`,
    profile: {
      playerId,
      level: 0,
      maxHealth: 100,
      currentHealth: 100,
      baseAttackDamage: 10,
      defense: 0
    }
  });
}

function installAuthoritativeEquipment(
  engine: CombatEngine,
  playerId: string,
  state: PlayerEquipmentCombatState
): void {
  engine.updatePlayerPveStats(playerId, {
    level: state.stats.characterLevel,
    maxHealth: state.stats.maximumHealth,
    attackPower: state.stats.universalAttackPower,
    defense: state.stats.universalDefense
  });
  engine.syncPlayerEquipmentCombatState(playerId, state);
}

function installWarriorRuntime(
  engine: CombatEngine,
  playerId: string,
  options: {
    resetActives?: [string | null, string | null];
    normalActives?: [string | null, string | null];
    rage?: number;
    rageReserved?: number;
  } = {}
): void {
  const rage = options.rage ?? 73;
  const rageReserved = options.rageReserved ?? 11;
  const snapshot: ClassSnapshot = {
    playerId,
    characterLevel: 25,
    activeClassId: "warrior",
    activeSubclassId: null,
    warrior: {
      classId: "warrior",
      level: 15,
      xp: 0,
      nextLevelXp: null,
      completedAt: null
    },
    subclasses: [],
    loadout: {
      resetActives: options.resetActives ?? [null, null],
      normalActives: options.normalActives ?? [null, null],
      passiveTiers: [null, null, null], ultimateActive: null
    },
    legacyIds: [],
    rage,
    maximumRage: 100,
    queuedAbility: null,
    cooldownEndsAt: { warrior_cleave: 9_999_999 },
    serverTime: 0,
    revision: 1
  };
  engine.updatePlayerClassState(playerId, snapshot, {
    playerId,
    instances: [],
    weapon: null,
    chest: null,
    totalAttackPowerBonus: 0,
    totalDefenseBonus: 0
  }, {
    rage,
    rageReserved,
    queuedAbilityId: null,
    queuedTargetEntityId: null,
    queuedAtTick: null,
    cooldownEndsAt: { warrior_cleave: 9_999_999 },
    statusEffects: [],
    counters: { axeActions: 7, marker: true },
    combatGeneration: 4,
    lastCombatAt: 123
  });
}

function equipmentState(input: {
  activeKitIndex: number | null;
  characterLevel: number;
  warriorRank: number;
  itemLevel: number;
  weaponCategory: WeaponCategory;
}): PlayerEquipmentCombatState {
  const loadout: ActiveEquipmentLoadout = {
    active: emptyEquipmentSlots(null),
    readiedWeaponSlot: "melee"
  };
  loadout.active.melee = {
    instanceId: `weapon-${input.weaponCategory}-${input.itemLevel}`,
    itemLevel: input.itemLevel,
    definition: requireEquipmentDefinition(input.weaponCategory === "axe" ? "training_axe" : "starter_sword")
  };
  const stats: EquipmentCombatStats = resolveEquipmentCombatStats({
    context: "pve",
    characterLevel: input.characterLevel,
    classId: "warrior",
    classRank: input.warriorRank,
    loadout
  });
  return {
    activeKitIndex: input.activeKitIndex,
    inventoryRevision: input.itemLevel,
    activeRevision: input.itemLevel,
    stats,
    weaponCategory: input.weaponCategory,
    chestArmorCategory: null,
    heavyArmorPieces: 0,
    hasShield: false,
    activeWeaponInstanceId: loadout.active.melee?.instanceId ?? null,
    activeWeaponEnchantmentIdentity: null,
    armorEnchantmentIdentities: { head: null, chest: null, gloves: null, boots: null },
    weaponSlots: {
      melee: {
        instanceId: loadout.active.melee?.instanceId ?? null,
        definitionId: loadout.active.melee.definition.definitionId,
        category: input.weaponCategory,
        enchantmentIdentity: null
      },
      secondary: {
        instanceId: null,
        category: null,
        enchantmentIdentity: null
      }
    },
    activeWeaponSlot: "melee",
    switchPolicy: "melee_priority",
    switchingToSlot: null,
    switchStartedAtTick: null,
    switchCompletesAtTick: null
  };
}

function matrixEquipmentState(input: {
  weaponDefinitionId: EquipmentDefinitionId;
  weaponLevel: number;
  chestDefinitionId?: EquipmentDefinitionId;
  chestLevel?: number;
  shieldDefinitionId?: EquipmentDefinitionId;
  shieldLevel?: number;
  ringDefinitionId?: EquipmentDefinitionId;
}): PlayerEquipmentCombatState {
  const weapon = requireEquipmentDefinition(input.weaponDefinitionId);
  const weaponSlot = weapon.category === "ranged_weapon" ? "secondary" as const : "melee" as const;
  const loadout: ActiveEquipmentLoadout = {
    active: emptyEquipmentSlots(null),
    readiedWeaponSlot: weaponSlot
  };
  loadout.active[weaponSlot] = {
    instanceId: `matrix-weapon-${input.weaponDefinitionId}`,
    definition: weapon,
    itemLevel: input.weaponLevel
  };
  const weaponInstanceId = `matrix-weapon-${input.weaponDefinitionId}`;
  if (input.chestDefinitionId) {
    loadout.active.chest = {
      instanceId: `matrix-chest-${input.chestDefinitionId}`,
      definition: requireEquipmentDefinition(input.chestDefinitionId),
      itemLevel: input.chestLevel ?? 0
    };
  }
  if (input.shieldDefinitionId) {
    loadout.active.secondary = {
      instanceId: `matrix-shield-${input.shieldDefinitionId}`,
      definition: requireEquipmentDefinition(input.shieldDefinitionId),
      itemLevel: input.shieldLevel ?? 0
    };
  }
  if (input.ringDefinitionId) {
    loadout.active.ring = {
      instanceId: `matrix-ring-${input.ringDefinitionId}`,
      definition: requireEquipmentDefinition(input.ringDefinitionId),
      itemLevel: 0
    };
  }
  const stats = resolveEquipmentCombatStats({
    context: "pvp_open_world",
    characterLevel: 25,
    classId: "warrior",
    classRank: 0,
    loadout
  });
  return {
    activeKitIndex: 1,
    inventoryRevision: 1,
    activeRevision: 1,
    stats,
    weaponCategory: weapon.weaponCategory,
    chestArmorCategory: loadout.active.chest?.definition.armorCategory ?? null,
    chestDefinitionId: loadout.active.chest?.definition.definitionId ?? null,
    heavyArmorPieces: loadout.active.chest?.definition.armorCategory === "heavy" ? 1 : 0,
    hasShield: loadout.active.secondary?.definition.category === "shield",
    activeWeaponInstanceId: weaponInstanceId,
    activeWeaponEnchantmentIdentity: null,
    armorEnchantmentIdentities: { head: null, chest: null, gloves: null, boots: null },
    weaponSlots: {
      melee: weaponSlot === "melee"
        ? {
          instanceId: weaponInstanceId,
          definitionId: weapon.definitionId,
          category: weapon.weaponCategory,
          enchantmentIdentity: null
        }
        : { instanceId: null, definitionId: null, category: null, enchantmentIdentity: null },
      secondary: weaponSlot === "secondary"
        ? {
          instanceId: weaponInstanceId,
          definitionId: weapon.definitionId,
          category: weapon.weaponCategory,
          enchantmentIdentity: null
        }
        : { instanceId: null, definitionId: null, category: null, enchantmentIdentity: null }
    },
    activeWeaponSlot: weaponSlot,
    switchPolicy: "melee_priority",
    switchingToSlot: null,
    switchStartedAtTick: null,
    switchCompletesAtTick: null
  };
}

function dualWeaponEquipmentState(): PlayerEquipmentCombatState {
  const state = equipmentState({
    activeKitIndex: 1,
    characterLevel: 25,
    warriorRank: 0,
    itemLevel: 0,
    weaponCategory: "sword"
  });
  state.stats.weaponAttackPower.secondary = 30;
  state.stats.weaponCategories.secondary = "bow";
  state.stats.items.secondary = resolveEquipmentItemDerivedStats({
    item: {
      instanceId: "ranged-bow-20",
      definition: requireEquipmentDefinition("starter_bow"),
      itemLevel: 20
    },
    slot: "secondary",
    classId: "warrior"
  });
  state.weaponSlots.secondary = {
    instanceId: "ranged-bow-20",
    definitionId: "starter_bow",
    category: "bow",
    enchantmentIdentity: null
  };
  return state;
}

function internalPlayer(engine: CombatEngine, playerId: string): {
  currentHealth: number;
  maxHealth: number;
  targetEntityId: string | null;
  nextEligibleAttackTick: number;
  scheduledAttackTick: number | null;
  attackScheduleGeneration: number;
  equipmentCombatState: PlayerEquipmentCombatState | null;
  classRuntime: {
    rage: number;
    reservedRage: number;
    cooldownEndsAt: Record<string, number>;
    effects: unknown[];
    counters: Record<string, number | string | boolean>;
    combatGeneration: number;
  } | null;
} {
  return (engine as unknown as {
    entities: Map<string, ReturnType<typeof internalPlayer>>;
  }).entities.get(playerId)!;
}

type PeriodicDamageInternals = {
  currentTick: number;
  entities: Map<string, {
    attackDamage: number;
    currentHealth: number;
    classRuntime: {
      activeClassId: string;
      subclassId: string | null;
      effects: Array<{
        kind: string;
        amount: number;
        remainingAmount?: number;
        stacks: number;
        nextTick: number;
      }>;
    } | null;
  }>;
  applyHunterBleed(
    attacker: unknown,
    target: unknown,
    sourceTechniqueId: string,
    appliedDirectDamage: number,
    directDamageBeforePowerScaling: number
  ): void;
  resolveQueueBleedTurn(target: unknown): boolean;
  processClassRuntimeTick(): void;
};

function periodicDamageInternals(engine: CombatEngine): PeriodicDamageInternals {
  return engine as unknown as PeriodicDamageInternals;
}

function authority(
  attackerId: string,
  targetEntityId: string,
  requestId: string
): {
  attackerId: string;
  targetEntityId: string;
  requestId: string;
  accountId: string;
  connectionId: string;
} {
  return {
    attackerId,
    targetEntityId,
    requestId,
    accountId: `account-${attackerId}`,
    connectionId: `connection-${attackerId}`
  };
}

function abilityAuthority(playerId: string): {
  playerId: string;
  accountId: string;
  connectionId: string;
} {
  return {
    playerId,
    accountId: `account-${playerId}`,
    connectionId: `connection-${playerId}`
  };
}

function east(distanceM: number): LatLon {
  return {
    lat: ORIGIN.lat,
    lon: ORIGIN.lon + distanceM / 91_000
  };
}

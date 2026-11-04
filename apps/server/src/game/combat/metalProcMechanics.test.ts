import { describe, expect, it, vi } from "vitest";

import {
  beatAlignedAmountScale,
  beatAlignedIntervalMs,
  emptyEquipmentSlots,
  metalEquipmentEnhancement,
  resolveEquipmentCombatStats,
  serializeEquipmentEnhancement,
  type EquipmentMetal,
  type LatLon
} from "@ash-atlas/shared";

import {
  CombatEngine,
  type MetalExpelHandler,
  type PlayerEquipmentCombatState
} from "./combatEngine.js";
import { METAL_PROC_BALANCE } from "./metalProcs.js";

// The Training Dummy is now 10 equal-level sword hits into Unarmored (90 HP);
// these fixtures keep the original 100 HP pool.
const DUMMY_100_HP = 100 / 90;
const ORIGIN = { lat: 35.0844, lon: -106.6504 };
const TICKS_PER_SECOND = 20;
/** Beat-aligned metal tick spacing in ticks, and the pulses that fit in the status timer. */
const beatTicks = (baseTickMs: number) => beatAlignedIntervalMs(baseTickMs) * TICKS_PER_SECOND / 1_000;
const metalPulses = (durationMs: number, baseTickMs: number) =>
  Math.floor(durationMs / beatAlignedIntervalMs(baseTickMs));

describe("metal proc mechanics", () => {
  it("poisons a mob from a Venom weapon hit and ticks 3-6 per 3.2 s on the beat", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player", ORIGIN);
    engine.syncPlayerEquipmentCombatState("player", equipmentState("venomsteel", "weapon"));
    const mob = spawnDummy(engine, east(10));

    engine.startAttack(authority("player", mob.entityId, "venom-weapon"));
    engine.tick();
    engine.cancelCombat("player");

    const poison = effects(engine, mob.entityId).find((effect) => effect.kind === "poison")!;
    const { tickMs, durationMs, damageMin } = METAL_PROC_BALANCE.poison;
    const pulses = metalPulses(durationMs, tickMs);
    expect(poison).toMatchObject({ sourceEntityId: "player", stacks: pulses });
    expect(poison.endTick - poison.startTick).toBe(55 * TICKS_PER_SECOND);
    const health = () => internals(engine).entities.get(mob.entityId)!.currentHealth;
    const before = health();
    for (let tick = 0; tick < beatTicks(tickMs) + 2; tick += 1) engine.tick();
    // random() = 0 rolls the minimum of the 2-6 range, scaled to the beat (2 x 2.8/3.5 = 1.6).
    const perTick = damageMin * beatAlignedAmountScale(tickMs);
    expect(before - health()).toBe(Math.floor(perTick));
    expect(poison.stacks).toBe(pulses - 1);
    for (let tick = 0; tick < 55 * TICKS_PER_SECOND; tick += 1) engine.tick();
    // The fraction carries, so the whole poison deals its per-second rate over its duration.
    expect(before - health()).toBe(Math.floor(perTick * pulses));
    expect(Math.abs(perTick * pulses - damageMin * Math.floor(durationMs / tickMs))).toBeLessThan(damageMin);
  });

  it("refreshes a re-applied status instead of stacking it", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player", ORIGIN);
    const mob = spawnDummy(engine, east(10));
    const internal = internals(engine);
    const owner = internal.entities.get("player")!;
    const target = internal.entities.get(mob.entityId)!;

    internal.applyMetalEffect(owner, target, "poison", "weapon");
    const first = effects(engine, mob.entityId).find((effect) => effect.kind === "poison")!;
    const firstEnd = first.endTick;
    internal.currentTick += 40;
    first.stacks = 3;
    internal.applyMetalEffect(owner, target, "poison", "weapon");

    const poisons = effects(engine, mob.entityId).filter((effect) => effect.kind === "poison");
    expect(poisons).toHaveLength(1);
    expect(poisons[0]!.endTick).toBe(firstEnd + 40);
    expect(poisons[0]!.stacks).toBe(metalPulses(METAL_PROC_BALANCE.poison.durationMs, METAL_PROC_BALANCE.poison.tickMs));
    // Mob-sourced poison refreshes the same way and never shortens a longer metal poison.
    internal.applyHarmfulStatus(target, owner, "poison", 1);
    internal.applyHarmfulStatus(target, owner, "poison", 1);
    expect(effects(engine, owner.entityId).filter((effect) => effect.kind === "poison")).toHaveLength(1);
    internal.applyHarmfulStatus(owner, target, "poison", 1);
    expect(effects(engine, mob.entityId).filter((effect) => effect.kind === "poison")).toHaveLength(1);
    expect(effects(engine, mob.entityId).find((effect) => effect.kind === "poison")!.endTick)
      .toBeGreaterThanOrEqual(firstEnd + 40);
  });

  it("spreads Ember to the nearest unburned enemy for half the parent's full duration, never below 4 s", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player", ORIGIN);
    const chain = [10, 80, 150, 220, 290].map((distance) => spawnDummy(engine, east(distance)));
    const internal = internals(engine);
    internal.applyMetalEffect(
      internal.entities.get("player")!,
      internal.entities.get(chain[0]!.entityId)!,
      "burning",
      "weapon"
    );

    for (let tick = 0; tick < 10 * TICKS_PER_SECOND; tick += 1) engine.tick();

    const durations = chain.map((mob) => {
      const burn = effects(engine, mob.entityId).find((effect) => effect.kind === "burning");
      return burn ? (burn.endTick - burn.startTick) / TICKS_PER_SECOND : null;
    });
    // 27 s -> 12.15 s (x0.45). The third link (5.45 s, still above the 4.5 s floor for its own spread) lands or not
    // depending on where the 2.8 s burn pulses fall inside the 10 s window, so only the cutoff is asserted.
    expect(durations.slice(0, 2)).toEqual([27, 12.15]);
    expect([null, 5.45]).toContain(durations[2]);
    expect(durations.slice(3)).toEqual([null, null]);
    expect(effects(engine, chain[1]!.entityId).find((effect) => effect.kind === "burning")?.sourceEntityId)
      .toBe("player");
  });

  it("does not spread Ember outside the owner's combat authority", () => {
    const engine = createEngine({
      random: () => 0,
      getAuthoritativeViewCircle: () => ({
        center: ORIGIN, radiusM: 100, generation: 1, eligibleZoneIds: ["world:NM"]
      })
    });
    addPlayer(engine, "player", ORIGIN);
    const primary = spawnDummy(engine, east(10));
    const unauthorized = engine.spawnMob({
      archetype: "training_dummy", maxHealthMultiplier: DUMMY_100_HP, position: east(20),
      regionCode: "NM", zoneId: "other-layer"
    });
    const internal = internals(engine);
    internal.applyMetalEffect(internal.entities.get("player")!, internal.entities.get(primary.entityId)!, "burning", "weapon");

    for (let tick = 0; tick < 7 * TICKS_PER_SECOND; tick += 1) engine.tick();

    expect(effects(engine, unauthorized.entityId)).toEqual([]);
  });

  it("honors mob immunities", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player", ORIGIN);
    const golem = engine.spawnMob({
      archetype: "moss_golem", position: east(10), regionCode: "NM", zoneId: "world:NM"
    });
    const bird = engine.spawnMob({
      archetype: "fire_bird", position: east(20), regionCode: "NM", zoneId: "world:NM"
    });
    const internal = internals(engine);
    const owner = internal.entities.get("player")!;
    internal.applyMetalEffect(owner, internal.entities.get(golem.entityId)!, "poison", "weapon");
    internal.applyMetalEffect(owner, internal.entities.get(bird.entityId)!, "burning", "weapon");
    internal.applyMetalEffect(owner, internal.entities.get(bird.entityId)!, "poison", "weapon");

    expect(effects(engine, golem.entityId)).toEqual([]);
    expect(effects(engine, bird.entityId).map((effect) => effect.kind)).toEqual(["poison"]);
  });

  it("applies weapon and armor metals player-to-player, including the attacker's reactive Frost slow", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "defender", east(10));
    engine.syncPlayerEquipmentCombatState("attacker", equipmentState("venomsteel", "weapon"));
    engine.syncPlayerEquipmentCombatState("defender", equipmentState("ice", "armor"));

    engine.startAttack(authority("attacker", "defender", "pvp-metals"));
    engine.tick();

    expect(effects(engine, "defender")).toContainEqual(expect.objectContaining({
      kind: "poison", sourceEntityId: "attacker", sourceTechniqueId: "metal_venom_poison"
    }));
    expect(effects(engine, "attacker")).toContainEqual(expect.objectContaining({
      kind: "movement_slow", sourceEntityId: "defender", amount: 0.45
    }));
    expect(engine.entity("attacker")?.harmfulStatusIds).toContain("ice_slow");
    expect(engine.playerMovementMultiplier("attacker")).toBeLessThan(0.6);
  });

  it("refuses metal procs on players behind the trust shield or arrival protection", () => {
    const blocked = new Set<string>();
    const engine = createEngine({
      random: () => 0,
      isPvpBlocked: (attackerId, targetId) => blocked.has(`${attackerId}>${targetId}`)
    });
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "defender", east(10));
    const internal = internals(engine);
    const owner = internal.entities.get("attacker")!;
    const target = internal.entities.get("defender")!;

    blocked.add("attacker>defender");
    internal.applyMetalEffect(owner, target, "poison", "weapon");
    expect(effects(engine, "defender")).toEqual([]);
    blocked.clear();

    engine.grantFlagArrivalProtection("defender", 1);
    internal.applyMetalEffect(owner, target, "poison", "weapon");
    expect(effects(engine, "defender")).toEqual([]);
  });

  it("applies Frost slow and the dodge multiplier, Fleet steals speed, Whetted breaks defense", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player", ORIGIN);
    addPlayer(engine, "enemy", east(20));
    const mob = spawnDummy(engine, east(10));
    const internal = internals(engine);
    const owner = internal.entities.get("player")!;
    const enemy = internal.entities.get("enemy")!;
    const target = internal.entities.get(mob.entityId)!;

    internal.applyMetalEffect(owner, target, "slow", "weapon");
    expect(effects(engine, mob.entityId)[0]).toMatchObject({
      kind: "movement_slow", amount: METAL_PROC_BALANCE.frost.slowFraction
    });
    expect(internal.frostDodgeMultiplier(target)).toBe(0.88);
    internal.applyMetalEffect(owner, target, "steal_speed", "weapon");
    internal.applyMetalEffect(owner, target, "whetted", "weapon");
    internal.applyMetalEffect(owner, enemy, "whetted", "armor");
    expect(engine.entity(mob.entityId)?.harmfulStatusIds).toEqual(
      expect.arrayContaining(["ice_slow", "fleet_slow", "whetted_defense"])
    );
    expect(engine.entity("enemy")?.harmfulStatusIds).toContain("whetted_attack");
    expect(internal.effectTotal(owner, "out_of_combat_movement")).toBeCloseTo(0.22, 10);
    expect(internal.effectTotal(target, "whetted_defense")).toBe(5);
    expect(internal.effectTotal(enemy, "whetted_attack")).toBe(4);
  });

  it("Whetted lowers the defender's flat defense in PvP matrix damage, once", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "attacker", ORIGIN);
    addPlayer(engine, "defender", east(10));
    engine.syncPlayerEquipmentCombatState("attacker", equipmentState("whetted", "weapon"));
    const internal = internals(engine);
    const attacker = internal.entities.get("attacker")!;
    const defender = internal.entities.get("defender")!;
    const resolve = () => internal.resolveContextDamage(attacker, defender, {
      pveDamage: 10, pvpDamageBeforePowerScaling: 10, pvpDamageMultiplier: 1, pvpUseEquipmentMatrix: true
    }).finalDamage;

    const before = resolve();
    internal.applyMetalEffect(attacker, defender, "whetted", "weapon");
    expect(resolve()).toBe(before + METAL_PROC_BALANCE.whetted.defenseReduction);
  });

  it("Withered blocks Life healing", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player", ORIGIN);
    addPlayer(engine, "enemy", east(10));
    const internal = internals(engine);
    const player = internal.entities.get("player")!;
    const enemy = internal.entities.get("enemy")!;
    player.currentHealth = 50;

    internal.applyMetalEffect(player, enemy, "vitality", "weapon");
    expect(player.currentHealth).toBe(53);
    internal.applyMetalEffect(enemy, player, "withered", "weapon");
    expect(engine.entity("player")?.harmfulStatusIds).toContain("gloom");
    internal.applyMetalEffect(player, enemy, "vitality", "weapon");
    expect(player.currentHealth).toBe(53);
  });

  it("Storm pulses 4-7 per 4.5 s on the beat to electrified enemies within 230 m only", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player", ORIGIN);
    const near = spawnDummy(engine, east(200));
    const far = spawnDummy(engine, east(300));
    const internal = internals(engine);
    const owner = internal.entities.get("player")!;
    internal.applyMetalEffect(owner, internal.entities.get(near.entityId)!, "storm", "weapon");
    internal.applyMetalEffect(owner, internal.entities.get(far.entityId)!, "storm", "weapon");

    const { pulseMs, damageMin } = METAL_PROC_BALANCE.storm;
    for (let tick = 0; tick < beatTicks(pulseMs) + 2; tick += 1) engine.tick();

    expect(internal.entities.get(near.entityId)!.currentHealth)
      .toBe(100 - Math.floor(damageMin * beatAlignedAmountScale(pulseMs)));
    expect(internal.entities.get(far.entityId)!.currentHealth).toBe(100);
    expect(engine.entity(near.entityId)?.harmfulStatusIds).toContain("storm");
    expect((internal as { pendingLightningChains?: unknown }).pendingLightningChains).toBeUndefined();
  });

  it("Gale throws every enemy within 90 m back 55 m for 6 damage", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player", ORIGIN);
    const close = spawnDummy(engine, east(30));
    const outside = spawnDummy(engine, east(160));
    const internal = internals(engine);
    const owner = internal.entities.get("player")!;
    const closeMob = internal.entities.get(close.entityId)!;

    internal.applyMetalEffect(owner, closeMob, "knockback", "weapon");

    expect(closeMob.currentHealth).toBe(94);
    expect(distanceM(ORIGIN, closeMob.position)).toBeGreaterThan(80);
    expect(distanceM(ORIGIN, closeMob.position)).toBeLessThan(90);
    expect(internal.entities.get(outside.entityId)!.currentHealth).toBe(100);
  });

  it("Skyrise immobilizes once, then grants immunity so it cannot be chained", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player", ORIGIN);
    addPlayer(engine, "enemy", east(10));
    const internal = internals(engine);
    const owner = internal.entities.get("player")!;
    const enemy = internal.entities.get("enemy")!;

    internal.applyMetalEffect(owner, enemy, "immobilize", "weapon");
    expect(engine.isPlayerImmobilized("enemy")).toBe(true);
    internal.currentTick += 4 * TICKS_PER_SECOND + 1;
    expect(engine.isPlayerImmobilized("enemy")).toBe(false);
    internal.applyMetalEffect(owner, enemy, "immobilize", "weapon");
    expect(engine.isPlayerImmobilized("enemy")).toBe(false);
    internal.currentTick += 4 * TICKS_PER_SECOND;
    internal.applyMetalEffect(owner, enemy, "immobilize", "weapon");
    expect(engine.isPlayerImmobilized("enemy")).toBe(true);
  });

  it("Vengeance reflects the fixed damage on the marked combatant's next landed attack, once", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "owner", ORIGIN);
    addPlayer(engine, "marked", east(10));
    addPlayer(engine, "bystander", east(20));
    const internal = internals(engine);
    const owner = internal.entities.get("owner")!;
    const marked = internal.entities.get("marked")!;

    internal.applyMetalEffect(owner, marked, "vengeance", "weapon");
    expect(engine.entity("marked")?.harmfulStatusIds).toContain("vengeance_mark");
    engine.startAttack(authority("marked", "bystander", "marked-hit"));
    engine.tick();
    engine.cancelCombat("marked");

    expect(marked.currentHealth).toBe(89);
    expect(engine.entity("marked")?.harmfulStatusIds ?? []).not.toContain("vengeance_mark");
  });

  it("Mirage blinks within 45 m of the target and adds 6 damage to the next attack within 5 s", () => {
    let repositioned: LatLon | null = null;
    const engine = createEngine({
      random: () => 0.5,
      repositionPlayer: (_playerId, target) => { repositioned = target; return true; }
    });
    addPlayer(engine, "player", ORIGIN);
    const mob = spawnDummy(engine, east(200));
    const internal = internals(engine);
    const owner = internal.entities.get("player")!;
    const target = internal.entities.get(mob.entityId)!;

    internal.applyMetalEffect(owner, target, "blink", "weapon");

    expect(repositioned).not.toBeNull();
    expect(distanceM(repositioned!, target.position)).toBeLessThanOrEqual(45.5);
    expect(internal.consumeMirageBonus(owner, true)).toBe(6);
    expect(internal.consumeMirageBonus(owner, true)).toBe(0);
    internal.applyMetalEffect(owner, target, "blink", "weapon");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    expect(internal.consumeMirageBonus(owner, true)).toBe(0);
    vi.restoreAllMocks();
  });

  describe("Expel", () => {
    function expelFixture(handler: Partial<MetalExpelHandler> = {}) {
      const expel = vi.fn(() => true);
      const engine = createEngine({ random: () => 0 });
      engine.setExpelHandler({ canExpel: () => true, expel, ...handler });
      addPlayer(engine, "owner", ORIGIN);
      addPlayer(engine, "victim", east(10));
      const internal = internals(engine);
      return {
        engine, expel, internal,
        owner: internal.entities.get("owner")!,
        victim: internal.entities.get("victim")!
      };
    }

    it("teleports the victim through the host, then refuses a second expel for 55 s", () => {
      const { expel, internal, owner, victim } = expelFixture();
      const now = vi.spyOn(Date, "now");
      now.mockReturnValue(1_000_000);

      internal.applyMetalEffect(owner, victim, "expel", "weapon");
      expect(expel).toHaveBeenCalledWith("victim", false);
      now.mockReturnValue(1_000_000 + 54_000);
      internal.applyMetalEffect(owner, victim, "expel", "weapon");
      expect(expel).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + 55_001);
      internal.applyMetalEffect(owner, victim, "expel", "weapon");
      expect(expel).toHaveBeenCalledTimes(2);
      vi.restoreAllMocks();
    });

    it("expels the attacker from an armor proc and flags a killing blow as lethal", () => {
      const { expel, internal, owner, victim } = expelFixture();
      victim.currentHealth = 0;

      internal.applyMetalEffect(owner, victim, "expel", "weapon");
      expect(expel).toHaveBeenCalledWith("victim", true);

      // Armor: the wearer dies, so the (living) killer is expelled and is not flagged lethal.
      const armor = expelFixture();
      armor.owner.currentHealth = 0;
      armor.internal.applyMetalEffect(armor.owner, armor.victim, "expel", "armor");
      expect(armor.expel).toHaveBeenCalledWith("victim", false);
    });

    it("refuses inside dungeons (host veto) and interiors, and never starts immunity for a refusal", () => {
      const dungeon = expelFixture({ canExpel: () => false });
      dungeon.internal.applyMetalEffect(dungeon.owner, dungeon.victim, "expel", "weapon");
      expect(dungeon.expel).not.toHaveBeenCalled();
      expect(dungeon.internal.expelImmuneUntilMs.size).toBe(0);

      const interior = expelFixture();
      interior.victim.regionCode = "interior:cellar";
      interior.internal.applyMetalEffect(interior.owner, interior.victim, "expel", "weapon");
      expect(interior.expel).not.toHaveBeenCalled();
    });

    it("only expels players, and drops the immunity when the host fails", async () => {
      const failing = expelFixture({ expel: vi.fn(async () => false) });
      failing.internal.applyMetalEffect(failing.owner, failing.victim, "expel", "weapon");
      await Promise.resolve();
      await Promise.resolve();
      expect(failing.internal.expelImmuneUntilMs.size).toBe(0);

      const mobFixture = expelFixture();
      const mob = spawnDummy(mobFixture.engine, east(30));
      mobFixture.internal.applyMetalEffect(
        mobFixture.owner, mobFixture.internal.entities.get(mob.entityId)!, "expel", "weapon"
      );
      expect(mobFixture.expel).not.toHaveBeenCalled();
    });
  });

  it("rolls each distinct armor metal once per hit from the highest-level piece", () => {
    const random = vi.fn(() => 0.99);
    const engine = createEngine({ random });
    addPlayer(engine, "wearer", ORIGIN);
    addPlayer(engine, "attacker", east(10));
    const state = equipmentState("venomsteel", "armor");
    state.reactiveArmorEnhancements = [
      { instanceId: "helm", enchantmentIdentity: identity("venomsteel"), itemLevel: 3 },
      { instanceId: "chest", enchantmentIdentity: identity("venomsteel"), itemLevel: 8 },
      { instanceId: "shield", enchantmentIdentity: identity("fire"), itemLevel: 1 }
    ];
    engine.syncPlayerEquipmentCombatState("wearer", state);
    const internal = internals(engine);
    random.mockClear();

    internal.applyReactiveArmorProcs(
      internal.entities.get("wearer")!, internal.entities.get("attacker")!, 5
    );

    // Two distinct metals (venom, ember), each rolled exactly once.
    expect(random).toHaveBeenCalledTimes(2);
  });
});

function createEngine(
  overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}
): CombatEngine {
  return new CombatEngine({
    tickRateHz: TICKS_PER_SECOND,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    ...overrides
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
    profile: { playerId, maxHealth: 100, currentHealth: 100, baseAttackDamage: 10, defense: 0 }
  });
}

function spawnDummy(engine: CombatEngine, position: LatLon) {
  return engine.spawnMob({
    archetype: "training_dummy", maxHealthMultiplier: DUMMY_100_HP, position, regionCode: "NM", zoneId: "world:NM"
  });
}

function identity(metal: EquipmentMetal): string {
  return serializeEquipmentEnhancement(metalEquipmentEnhancement("ruby", metal));
}

function equipmentState(metal: EquipmentMetal, source: "weapon" | "armor"): PlayerEquipmentCombatState {
  const stats = resolveEquipmentCombatStats({
    context: "pve",
    characterLevel: 0,
    classId: "warrior",
    classRank: 0,
    loadout: { active: emptyEquipmentSlots(null), readiedWeaponSlot: "melee" }
  });
  const enchantment = identity(metal);
  return {
    activeKitIndex: 1,
    inventoryRevision: 1,
    activeRevision: 1,
    stats,
    weaponCategory: "sword",
    chestArmorCategory: source === "armor" ? "heavy" : null,
    heavyArmorPieces: source === "armor" ? 1 : 0,
    hasShield: false,
    activeWeaponInstanceId: "weapon",
    activeWeaponEnchantmentIdentity: source === "weapon" ? enchantment : null,
    armorEnchantmentIdentities: {
      head: null,
      chest: source === "armor" ? enchantment : null,
      gloves: null,
      boots: null
    },
    reactiveArmorEnhancements: source === "armor"
      ? [{ instanceId: "armor", enchantmentIdentity: enchantment, itemLevel: 0 }]
      : [],
    weaponSlots: {
      melee: {
        instanceId: "weapon",
        category: "sword",
        enchantmentIdentity: source === "weapon" ? enchantment : null
      },
      secondary: { instanceId: null, category: null, enchantmentIdentity: null }
    },
    activeWeaponSlot: "melee",
    switchPolicy: "melee_priority",
    switchingToSlot: null,
    switchStartedAtTick: null,
    switchCompletesAtTick: null
  };
}

type InternalEffect = {
  kind: string;
  sourceEntityId: string;
  sourceTechniqueId: string;
  stacks: number;
  startTick: number;
  endTick: number;
  amount: number;
};

type InternalCombatant = {
  entityId: string;
  currentHealth: number;
  maxHealth: number;
  regionCode: string;
  position: LatLon;
  classRuntime: { effects: InternalEffect[] } | null;
};

type MetalInternals = {
  engine: CombatEngine;
  currentTick: number;
  entities: Map<string, InternalCombatant>;
  expelImmuneUntilMs: Map<string, number>;
  applyMetalEffect(
    owner: InternalCombatant,
    opponent: InternalCombatant,
    effectId: string,
    procSource: "weapon" | "armor"
  ): void;
  applyHarmfulStatus(source: InternalCombatant, target: InternalCombatant, statusId: string, chance: number): boolean;
  applyReactiveArmorProcs(wearer: InternalCombatant, attacker: InternalCombatant, damage: number): void;
  consumeMirageBonus(attacker: InternalCombatant, eligible: boolean): number;
  frostDodgeMultiplier(target: InternalCombatant): number;
  effectTotal(entity: InternalCombatant, kind: string): number;
  resolveContextDamage(
    attacker: InternalCombatant,
    target: InternalCombatant,
    input: Record<string, number | boolean>
  ): { finalDamage: number };
};

function internals(engine: CombatEngine): MetalInternals {
  const internal = engine as unknown as MetalInternals;
  internal.engine = engine;
  return internal;
}

function effects(engine: CombatEngine, entityId: string): InternalEffect[] {
  return internals(engine).entities.get(entityId)?.classRuntime?.effects ?? [];
}

function authority(attackerId: string, targetEntityId: string, requestId: string) {
  return {
    attackerId,
    targetEntityId,
    requestId,
    accountId: `account-${attackerId}`,
    connectionId: `connection-${attackerId}`
  };
}

function east(distanceM: number): LatLon {
  return { lat: ORIGIN.lat, lon: ORIGIN.lon + distanceM / 91_000 };
}

function distanceM(left: LatLon, right: LatLon): number {
  const dLat = (right.lat - left.lat) * 111_000;
  const dLon = (right.lon - left.lon) * 91_000;
  return Math.hypot(dLat, dLon);
}

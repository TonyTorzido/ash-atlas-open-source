import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { destinationPoint, requireTechniqueDefinition } from "@ash-atlas/shared";

import { CombatEngine } from "./combatEngine.js";
import type { InMemoryPartyAuthority } from "../party/PartyAuthority.js";

const origin = { lat: 35.0844, lon: -106.6504 };

describe("permanent class innates", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(100_000));
  afterEach(() => vi.useRealTimers());

  it("uses mutually exclusive live Warrior damage tiers", () => {
    const engine = setup();
    connect(engine, "warrior", 100, 15);
    classed(engine, "warrior", "warrior", "training_axe");
    const internal = engine;
    const warrior = internal["entities"].get("warrior")!;
    warrior.currentHealth = 100;
    const baseline = internal["warriorFlatAttackBonus"](warrior, true);
    for (const [health, bonus] of [[70, 0], [69, 1], [45, 1], [44, 2], [20, 2], [19, 3], [80, 0]] as const) {
      warrior.currentHealth = health;
      expect(internal["warriorFlatAttackBonus"](warrior, true) - baseline).toBe(bonus);
    }
    expect(engine.entity("warrior")!.classCombat!.innate).toMatchObject({ maxHealthBonus: 36 });
  });

  it("resolves a Ranger Bow basic with Scout Drill mastery and no Focus multiplier", () => {
    const engine = setup();
    connect(engine, "ranger", 100, 10);
    classed(engine, "ranger", "ranger", "starter_bow");
    const mob = engine.spawnMob({ archetype: "training_dummy", position: destinationPoint(origin, 20, 90), regionCode: "NM", zoneId: "world:NM" });
    const internal = engine;
    const ranger = internal["entities"].get("ranger")!;
    const target = internal["entities"].get(mob.entityId)!;
    expect(internal["resolveBasicAttack"](ranger, target)).toBe(14);
    expect(engine.entity("ranger")!.classCombat!.cooldownEndsAt).toEqual({});
  });

  it("resolves a Ranger Bow basic against a player with the same Scout Drill mastery", () => {
    const engine = setup();
    connect(engine, "ranger", 100, 10);
    connect(engine, "opponent", 100, 10);
    classed(engine, "ranger", "ranger", "starter_bow");
    classed(engine, "opponent", "warrior", "training_axe");
    const internal = engine;
    expect(internal["resolveBasicAttack"](internal["entities"].get("ranger")!, internal["entities"].get("opponent")!)).toBe(8);
    expect(engine.entity("ranger")!.classCombat!.cooldownEndsAt).toEqual({});
  });

  it("dodges only ordinary basics in a Tunic and no longer vanishes on the low-HP crossing", () => {
    const engine = setup(undefined, () => 0);
    connect(engine, "ninja", 20, 15);
    classed(engine, "ninja", "ninja", "starter_shuriken", "padded_tunic");
    const mob = engine.spawnMob({ archetype: "wolf", position: destinationPoint(origin, 20, 90), regionCode: "NM", zoneId: "world:NM" });
    expect(engine.applyScriptedDamage(mob.entityId, "ninja", 5, "enemy_basic_attack")).toBe(0);
    expect(engine.entity("ninja")!.currentHealth).toBe(20);
    expect(engine.applyScriptedDamage(mob.entityId, "ninja", 6, "ground_zone")).toBe(6);
    expect(engine.entity("ninja")!.classCombat!.innate).toMatchObject({ armorActive: true, dodgeChance: 0.28, invisibleEndsAt: null });

    const runtime = engine["entities"].get("ninja")!.classRuntime!;
    runtime.chestDefinitionId = null;
    expect(engine.entity("ninja")!.classCombat!.innate).toMatchObject({ armorActive: false, dodgeChance: 0, invisibleEndsAt: null });
  });

  it.each([[1, 0.025], [5, 0.125], [15, 0.28], [25, 0.28]] as const)(
    "scales Tunic Dodge from character level %i to %f",
    (level, dodgeChance) => {
      const engine = setup();
      connect(engine, "ninja", 100, level);
      classed(engine, "ninja", "ninja", "starter_shuriken", "padded_tunic");
      expect(engine.entity("ninja")!.classCombat!.innate).toMatchObject({ armorActive: true, dodgeChance });
    }
  );

  it("withholds a Shadow Hide player from hostile visibility and new targets while keeping AoE damageable", () => {
    const engine = setup(undefined, () => 1);
    connect(engine, "ninja", 20, 10);
    connect(engine, "enemy-player", 100, 10);
    classed(engine, "ninja", "ninja", "starter_shuriken", "padded_tunic");
    classed(engine, "enemy-player", "warrior", "training_axe");
    const mob = engine.spawnMob({ archetype: "wolf", position: destinationPoint(origin, 20, 90), regionCode: "NM", zoneId: "world:NM" });
    expect(engine.grantPetShadowHide("ninja", 3_000)).toBe(true);
    expect(engine.isPlayerVisibleToPlayer("enemy-player", "ninja")).toBe(false);
    expect(engine.buildInterestFrame(["enemy-player"]).nearbyIdsByPlayer.get("enemy-player")?.has("ninja")).toBe(false);
    expect(() => engine.startAttack({ attackerId: "enemy-player", targetEntityId: "ninja", requestId: "hidden", accountId: "account:enemy-player", connectionId: "connection:enemy-player" })).toThrow(/not visible/i);
    expect(engine.applyScriptedDamage(mob.entityId, "ninja", 1, "ground_zone")).toBe(1);
  });

});

function setup(partyAuthority?: InMemoryPartyAuthority, random = () => 1): CombatEngine {
  return new CombatEngine({ tickRateHz: 20, playerMovementSpeedMps: 5, random,
    ...(partyAuthority ? { partyAuthority } : {}) });
}

function connect(engine: CombatEngine, id: string, hp: number, level = 1): void {
  engine.connectPlayer({ playerId: id, name: id, regionCode: "NM", zoneId: "world:NM", position: origin,
    accountId: `account:${id}`, connectionId: `connection:${id}`,
    profile: { playerId: id, level, maxHealth: 100, currentHealth: hp, baseAttackDamage: 10, defense: 0 } });
}

function classed(engine: CombatEngine, id: string, activeClassId: string, weaponDefinitionId: string, chestDefinitionId: string | null = null): void {
  const entity = engine["entities"].get(id)!;
  entity.classRuntime = {
    activeClassId, resourceId: "rage", weaponMode: weaponDefinitionId === "starter_bow" ? "ranged" : "melee",
    masteryRank: 25, subclassId: null, subclassMasteryRank: 0,
    learned: new Set(), equippedActives: new Set(), equippedPassives: new Set(), legacyIds: new Set(),
    weaponCategory: weaponDefinitionId === "starter_bow" ? "bow" : weaponDefinitionId === "starter_shuriken" ? "shuriken" : "sword",
    armorCategory: chestDefinitionId ? "light" : null, weaponDefinitionId, chestDefinitionId, hasShield: false,
    heavyArmorPieces: 0, rage: 0, reservedRage: 0, guard: 0, bloodlust: 0, queuedAbility: null,
    cooldownEndsAt: {}, effects: [], counters: {}, lastCombatAtMs: null, combatGeneration: 0, dirtyVersion: 0
  } as unknown as NonNullable<typeof entity.classRuntime>;
}

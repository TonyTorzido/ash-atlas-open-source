import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_TECHNIQUE_DEFINITIONS,
  destinationPoint,
  requireEquipmentDefinition,
  type ClassId,
  type ClassSnapshot,
  type EquipmentDefinitionId,
  type EquipmentSnapshot,
  type LatLon
} from "@ash-atlas/shared";

import { CombatEngine, CombatRequestError, type PlayerEquipmentCombatState } from "./combatEngine.js";
import { InMemoryPartyAuthority } from "../party/PartyAuthority.js";

const origin = { lat: 35.0844, lon: -106.6504 };
const authority = { playerId: "player", accountId: "account", connectionId: "connection" };

const ACTIVE_CASES = [
  ["warrior_v2_sundering_arc", "warrior", "training_axe", "armed"],
  ["warrior_v2_iron_reversal", "warrior", "training_axe", "self"],
  ["warrior_v2_faultline", "warrior", "training_axe", "hostile-reposition"],
  ["warrior_v2_rallying_roar", "warrior", "training_axe", "self"],
  ["ranger_v2_throughshot", "ranger", "starter_bow", "armed"],
  ["ranger_v2_threefold_volley", "ranger", "starter_bow", "hostile-reposition"],
  ["ranger_v2_marked_quarry", "ranger", "starter_bow", "hostile"],
  ["ranger_v2_snare_shot", "ranger", "starter_bow", "drag"],
  ["ninja_v2_twin_fang", "ninja", "starter_shuriken", "hostile"],
  ["ninja_v2_smoke_bomb", "ninja", "starter_shuriken", "self"],
  ["ninja_v2_shadowstep", "ninja", "starter_shuriken", "drag"],
  ["ninja_v2_shuriken_fan", "ninja", "starter_shuriken", "hostile"]
] as const satisfies ReadonlyArray<readonly [string, ClassId, EquipmentDefinitionId, string]>;

const PASSIVE_CASES = [
  ["warrior_v2_retaliation", "warrior", "incoming"], ["warrior_v2_battle_hardened", "warrior", "incoming"],
  ["warrior_v2_relentless", "warrior", "scheduled"], ["warrior_v2_battle_grit", "warrior", "incoming"],
  ["warrior_v2_berserker", "warrior", "incoming"], ["warrior_v2_juggernaut", "warrior", "incoming"],
  ["ranger_v2_broadheads", "ranger", "scheduled"], ["ranger_v2_clear_shot", "ranger", "scheduled"],
  ["ranger_v2_quick_draw", "ranger", "cast"], ["ranger_v2_keep_your_distance", "ranger", "incoming"],
  ["ranger_v2_deadeye", "ranger", "scheduled"], ["ranger_v2_suppressing_fire", "ranger", "scheduled"],
  ["ninja_v2_razor_edge", "ninja", "cast"], ["ninja_v2_light_feet", "ninja", "cast"],
  ["ninja_v2_quick_hands", "ninja", "cast"], ["ninja_v2_elusive", "ninja", "incoming"],
  ["ninja_v2_flow_state", "ninja", "cast"], ["ninja_v2_afterimage", "ninja", "cast"]
] as const satisfies ReadonlyArray<readonly [string, ClassId, "cast" | "incoming" | "scheduled" | "heal" | "benefit"]>;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Class System V2 active acceptance matrix", () => {
  it("covers every final V2 active catalog ID", () => {
    const catalog = ALL_TECHNIQUE_DEFINITIONS.filter((entry) => entry.id.includes("_v2_") && entry.kind === "normal")
      .map((entry) => entry.id).sort();
    expect(ACTIVE_CASES.map(([id]) => id).sort()).toEqual(catalog);
  });

  it.each(ACTIVE_CASES)("resolves %s through its authoritative activation boundary", (abilityId, classId, weaponId, mode) => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const repositionPlayer = vi.fn(() => true);
    const parties = new InMemoryPartyAuthority();
    parties.loadSnapshots([{ partyId: "party:test", leaderPlayerId: "player", memberPlayerIds: ["ally", "player"],
      memberSlots: [{ playerId: "player", slotIndex: 0 }, { playerId: "ally", slotIndex: 1 }], membershipRevision: 1,
      allowTravel: false, autoFollowPlayerIds: [], revision: 1 }]);
    const engine = createEngine({ repositionPlayer, partyAuthority: parties });
    configure(engine, classId, weaponId, abilityId, null, false);
    const enemy = spawn(engine, 10);
    const beforeEnemy = enemy.currentHealth;
    const beforePlayer = engine.entity("player")!.currentHealth;
    if (mode === "armed") {
      start(engine, enemy.entityId);
      engine.useNormalAbility({ ...authority, abilityId });
      expect(engine.entity(enemy.entityId)?.currentHealth).toBe(beforeEnemy);
      for (let tick = 0; tick < 40 && engine.entity(enemy.entityId)!.currentHealth === beforeEnemy; tick += 1) engine.tick();
      expect(engine.entity(enemy.entityId)!.currentHealth).toBeLessThan(beforeEnemy);
    } else {
      const input = {
        ...authority, abilityId,
        ...(["hostile", "hostile-reposition"].includes(mode) ? { targetEntityId: enemy.entityId, targetMode: "hostile" as const } : {}),
        ...(mode.includes("drag") ? { targetPosition: east(10) } : {})
      };
      engine.useNormalAbility(input);
      const events = engine.beginDeltaFlush().events;
      expect(
        engine.entity(enemy.entityId)!.currentHealth < beforeEnemy ||
        engine.entity("player")!.currentHealth !== beforePlayer ||
        repositionPlayer.mock.calls.length > 0 ||
        events.some((event) => event.type === "CLASS_ABILITY_ZONE_STARTED") ||
        (engine.entity("player")!.ward ?? 0) > 0 ||
        (engine.entity("ally")?.ward ?? 0) > 0 ||
        (engine.entity("ally")?.classCombat?.statusIndicators?.length ?? 0) > 0 ||
        (engine.entity(enemy.entityId)?.harmfulStatusIds?.length ?? 0) > 0 ||
        Object.keys(engine.entity("player")!.classCombat?.classCounters ?? {}).some((key) => key.startsWith("v2")) ||
        (engine.entity("player")!.classCombat?.statusIndicators?.length ?? 0) > 0
      ).toBe(true);
    }
    expect(engine.entity("player")!.classCombat?.cooldownEndsAt[abilityId]).toBeGreaterThan(100_000);
  });

});

describe("Class System V2 passive acceptance matrix", () => {
  it("covers every final V2 passive catalog ID", () => {
    const catalog = ALL_TECHNIQUE_DEFINITIONS.filter((entry) => entry.id.includes("_v2_") && entry.kind === "passive").map((entry) => entry.id).sort();
    expect(PASSIVE_CASES.map(([id]) => id).sort()).toEqual(catalog);
  });

  it("exercises every Warrior passive at its real trigger", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const blood = createEngine(); configure(blood, "warrior", "training_axe", "warrior_v2_iron_reversal", "warrior_v2_retaliation", false, 50);
    const bloodTarget = spawn(blood, 10); blood.applyScriptedDamage("player", bloodTarget.entityId, 1_000, "warrior_basic_attack");
    expect(blood.entity("player")!.currentHealth).toBe(55);

    const hardened = createEngine(); configure(hardened, "warrior", "training_axe", "warrior_v2_iron_reversal", "warrior_v2_battle_hardened", false);
    const hardenedEnemy = spawn(hardened, 10);
    expect(hardened.applyScriptedDamage(hardenedEnemy.entityId, "player", 20, "enemy_basic_attack")).toBe(17);

    const partingBlow = createEngine(); configure(partingBlow, "warrior", "training_axe", "warrior_v2_iron_reversal", "warrior_v2_relentless", false);
    const partingBlowTarget = spawn(partingBlow, 10); const splash = spawn(partingBlow, 11);
    partingBlow.applyScriptedDamage("player", partingBlowTarget.entityId, 1_000, "warrior_basic_attack");
    expect(partingBlow.entity(splash.entityId)!.currentHealth).toBe(splash.maxHealth - 4);

    const crowd = createEngine(); configure(crowd, "warrior", "training_axe", "warrior_v2_iron_reversal", "warrior_v2_battle_grit", false);
    const first = spawn(crowd, 10); const second = spawn(crowd, 11);
    queueEnemies(crowd, first.entityId, second.entityId);
    expect(defense(crowd, "player")).toBe(2);

    const frenzy = createEngine(); configure(frenzy, "warrior", "training_axe", "warrior_v2_iron_reversal", "warrior_v2_berserker", false);
    setCooldown(frenzy, "warrior_v2_sundering_arc", 120_000);
    setCooldown(frenzy, "warrior_v2_faultline", 125_000);
    const frenzyTarget = spawn(frenzy, 10); frenzy.applyScriptedDamage("player", frenzyTarget.entityId, 1_000, "warrior_basic_attack");
    expect(frenzy.entity("player")!.classCombat!.cooldownEndsAt.warrior_v2_sundering_arc).toBe(115_000);
    expect(frenzy.entity("player")!.classCombat!.cooldownEndsAt.warrior_v2_faultline).toBe(120_000);

    const juggernaut = createEngine(); configure(juggernaut, "warrior", "training_axe", "warrior_v2_iron_reversal", "warrior_v2_juggernaut", false, 20);
    const juggernautEnemy = spawn(juggernaut, 10);
    expect(juggernaut.applyScriptedDamage(juggernautEnemy.entityId, "player", 10, "enemy_basic_attack")).toBe(8);
    expect(juggernaut.applyScriptedDamage(juggernautEnemy.entityId, "player", 10, "ground_zone")).toBe(10);
  });

  it("exercises every Ranger passive at its real trigger", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const far = createEngine(); configure(far, "ranger", "starter_bow", "ranger_v2_marked_quarry", "ranger_v2_broadheads", false);
    expect(far.entity("player")!.attackRangeM).toBe(405);

    const trail = createEngine(); configure(trail, "ranger", "starter_bow", "ranger_v2_marked_quarry", "ranger_v2_clear_shot", false, 100, 25, undefined, undefined, "leather_armor" as EquipmentDefinitionId);
    expect(trail.playerMovementMultiplier("player")).toBeCloseTo(1.1);

    const clear = createEngine(); configure(clear, "ranger", "starter_bow", "ranger_v2_marked_quarry", "ranger_v2_quick_draw", false);
    const clearTarget = spawn(clear, 10); start(clear, clearTarget.entityId);
    tickUntil(clear, () => clear.entity(clearTarget.entityId)!.currentHealth < clearTarget.maxHealth);
    expect(clearTarget.maxHealth - clear.entity(clearTarget.entityId)!.currentHealth).toBeGreaterThanOrEqual(12);

    const trapper = createEngine(); configure(trapper, "ranger", "starter_bow", "ranger_v2_snare_shot", "ranger_v2_keep_your_distance", false);
    const trapTarget = spawn(trapper, 10);
    trapper.useNormalAbility({ ...authority, abilityId: "ranger_v2_snare_shot", targetPosition: east(10) });
    expect(trapper.entity(trapTarget.entityId)!.currentHealth).toBe(trapTarget.maxHealth - 8);

    const deadeye = createEngine(); configure(deadeye, "ranger", "starter_bow", "ranger_v2_marked_quarry", "ranger_v2_deadeye", false);
    const distant = spawn(deadeye, 200); start(deadeye, distant.entityId);
    tickUntil(deadeye, () => deadeye.entity(distant.entityId)!.currentHealth < distant.maxHealth);
    expect(distant.maxHealth - deadeye.entity(distant.entityId)!.currentHealth).toBeGreaterThanOrEqual(13);

    const bane = createEngine(); configure(bane, "ranger", "starter_bow", "ranger_v2_throughshot", "ranger_v2_suppressing_fire", false);
    const killed = spawn(bane, 10); bane.applyScriptedDamage("player", killed.entityId, 1_000, "ranger_basic_attack");
    const weaponTarget = spawn(bane, 11); bane.applyScriptedDamage("player", weaponTarget.entityId, 10, "ranger_basic_attack");
    expect(weaponTarget.maxHealth - bane.entity(weaponTarget.entityId)!.currentHealth).toBe(12);
    const otherSpecies = bane.spawnMob({ archetype: "wolf", position: east(13), regionCode: "NM", zoneId: "world:NM" });
    bane.applyScriptedDamage("player", otherSpecies.entityId, 10, "ranger_basic_attack");
    expect(otherSpecies.maxHealth - bane.entity(otherSpecies.entityId)!.currentHealth).toBe(10);
  });

  it("exercises every Ninja passive at its real trigger", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const packetDamage = (passiveId: string) => {
      const engine = createEngine(); configure(engine, "ninja", "starter_shuriken", "ninja_v2_twin_fang", passiveId, false);
      const target = spawn(engine, 10);
      engine.useNormalAbility({ ...authority, abilityId: "ninja_v2_twin_fang", targetEntityId: target.entityId, targetMode: "hostile" });
      return target.maxHealth - engine.entity(target.entityId)!.currentHealth;
    };
    expect(packetDamage("ninja_v2_razor_edge")).toBe(12);
    expect(packetDamage("ninja_v2_flow_state")).toBe(15);

    const light = createEngine(); configure(light, "ninja", "starter_shuriken", "ninja_v2_smoke_bomb", "ninja_v2_light_feet", false, 100, 25, undefined, undefined, "padded_tunic");
    expect(light.playerMovementMultiplier("player")).toBeCloseTo(1.1);

    const quick = createEngine(); configure(quick, "ninja", "starter_shuriken", "ninja_v2_twin_fang", "ninja_v2_quick_hands", false);
    const quickTarget = spawn(quick, 10); quick.useNormalAbility({ ...authority, abilityId: "ninja_v2_twin_fang", targetEntityId: quickTarget.entityId, targetMode: "hostile" });
    expect(quick.entity("player")!.classCombat!.cooldownEndsAt.ninja_v2_twin_fang).toBe(117_000);

    const fleet = createEngine(); configure(fleet, "ninja", "starter_shuriken", "ninja_v2_smoke_bomb", "ninja_v2_elusive", false);
    fleet.useNormalAbility({ ...authority, abilityId: "ninja_v2_smoke_bomb" });
    expect(fleet.entity("player")!.classCombat!.cooldownEndsAt.ninja_v2_smoke_bomb).toBe(122_000);

    const dodge = createEngine({ random: () => 0 }); configure(dodge, "ninja", "starter_shuriken", "ninja_v2_smoke_bomb", "ninja_v2_afterimage", false, 100, 25, undefined, undefined, "padded_tunic");
    const dodgeEnemy = spawn(dodge, 10);
    expect(dodge.applyScriptedDamage(dodgeEnemy.entityId, "player", 10, "enemy_basic_attack")).toBe(0);
    expect(dodge.playerMovementMultiplier("player")).toBeCloseTo(1.2);
  });

  it("keeps a readied Ninja Shuriken active for the first close-range attack", () => {
    const engine = createEngine();
    configure(engine, "ninja", "starter_shuriken", "ninja_v2_twin_fang", null, false);
    const target = spawn(engine, 10);

    start(engine, target.entityId);
    engine.tick();

    const equipmentCombatState = (engine as unknown as {
      entities: Map<string, { equipmentCombatState: PlayerEquipmentCombatState | null }>;
    }).entities.get("player")?.equipmentCombatState;
    expect(equipmentCombatState).toMatchObject({
      activeWeaponSlot: "secondary",
      switchingToSlot: null,
      switchStartedAtTick: null,
      switchCompletesAtTick: null
    });
    expect(engine.beginDeltaFlush().events).not.toContainEqual(
      expect.objectContaining({ type: "WEAPON_SWITCH_STARTED" })
    );
  });

});

describe("Class System V2 corrected authority and timing invariants", () => {
  it("rejects Ultimate input with ULTIMATE_DISABLED", () => {
    const engine = createEngine();
    configure(engine, "ranger", "starter_bow", "ranger_v2_throughshot", null, false);
    expectCombatError(() => engine.useUltimateAbility({
      ...authority, abilityId: "ranger_v2_black_rain", targetPosition: east(100)
    }), "ULTIMATE_DISABLED");
    expectCombatError(() => engine.useNormalAbility({
      ...authority, abilityId: "ranger_v2_black_rain", targetPosition: east(100)
    }), "ABILITY_NOT_EQUIPPED");
  });

  it("persists a targetless armed cast with its original action and consumes it on one scheduled attack", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const first = createEngine();
    configure(first, "warrior", "training_axe", "warrior_v2_sundering_arc", null, false);
    first.useNormalAbility({ ...authority, abilityId: "warrior_v2_sundering_arc" });
    expect(first.entity("player")!.classCombat).toMatchObject({
      classCounters: { actionSequence: 1, v2ArmedActionSequence: 1 },
      queuedAbility: { abilityId: "warrior_v2_sundering_arc", targetEntityId: null }
    });
    const persisted = first.peekDirtyClassRuntimes().at(-1)!;

    const restored = createEngine();
    configure(restored, "warrior", "training_axe", "warrior_v2_sundering_arc", null, false, 100, 25, persisted);
    expect(restored.entity("player")!.classCombat?.queuedAbility?.targetEntityId).toBeNull();
    const firstEnemy = spawn(restored, 10);
    const enemy = spawn(restored, 11);
    start(restored, firstEnemy.entityId);
    start(restored, enemy.entityId);
    expect(restored.entity("player")!.classCombat?.queuedAbility?.abilityId).toBe("warrior_v2_sundering_arc");
    tickUntil(restored, () => restored.entity(enemy.entityId)!.currentHealth < enemy.maxHealth);
    expect(restored.entity("player")!.classCombat?.queuedAbility).toBeNull();
    expect(restored.entity("player")!.classCombat?.classCounters?.actionSequence).toBe(2);
  });

  it("shows and resolves an armed attack without a PvE focus in PvP", () => {
    const engine = createEngine();
    configure(engine, "warrior", "training_axe", "warrior_v2_sundering_arc", null, false);
    connectOther(engine, "hostile", east(5));
    engine.useNormalAbility({ ...authority, abilityId: "warrior_v2_sundering_arc" });
    expect(engine.entity("player")!.classCombat?.queuedAbility).toMatchObject({
      abilityId: "warrior_v2_sundering_arc", targetEntityId: null
    });
    start(engine, "hostile");
    tickUntil(engine, () => engine.entity("hostile")!.currentHealth < 100);
    expect(engine.entity("player")!.classCombat?.queuedAbility).toBeNull();
  });

  it("explicitly cancels a restored targetless committed arm", () => {
    const engine = createEngine();
    configure(engine, "warrior", "training_axe", "warrior_v2_sundering_arc", null, false);
    engine.useNormalAbility({ ...authority, abilityId: "warrior_v2_sundering_arc" });
    expect(engine.cancelAttack("player")).toBe(true);
    expect(engine.entity("player")!.classCombat?.queuedAbility).toBeNull();
    expect(engine.cancelAttack("player")).toBe(false);
  });

  it("applies Ninja Shuriken mastery to authoritative PvP basic damage", () => {
    const damageAtRank = (rank: number) => {
      const engine = createEngine();
      configure(engine, "ninja", "starter_shuriken", "ninja_v2_smoke_bomb", null, false, 100, rank);
      connectOther(engine, "hostile", east(5));
      start(engine, "hostile");
      tickUntil(engine, () => engine.entity("hostile")!.currentHealth < 100);
      return 100 - engine.entity("hostile")!.currentHealth;
    };
    expect(damageAtRank(5)).toBe(damageAtRank(4) + 1);
  });

  it("uses authoritative range and directional geometry for Blood Rush, Piercing Arrow, and Razor Fan", () => {
    // Ogres keep the pre-matrix 700 HP pool (now 8 x 4) so these geometry probes never kill.
    const repositionPlayer = vi.fn(() => true);
    const rush = createEngine({ repositionPlayer }); configure(rush, "warrior", "training_axe", "warrior_v2_faultline", null, false);
    const rushTarget = rush.spawnMob({ archetype: "ogre", maxHealthMultiplier: 700 / 32, position: east(249), regionCode: "NM", zoneId: "world:NM" });
    rush.useNormalAbility({ ...authority, abilityId: "warrior_v2_faultline", targetEntityId: rushTarget.entityId, targetMode: "hostile" });
    expect(repositionPlayer).toHaveBeenCalledOnce();
    expect(rush.entity(rushTarget.entityId)!.currentHealth).toBeLessThan(rushTarget.maxHealth);

    const through = createEngine(); configure(through, "ranger", "starter_bow", "ranger_v2_throughshot", null, false);
    const primary = through.spawnMob({ archetype: "ogre", maxHealthMultiplier: 700 / 32, position: east(20), regionCode: "NM", zoneId: "world:NM" });
    const behind = through.spawnMob({ archetype: "ogre", maxHealthMultiplier: 700 / 32, position: east(169), regionCode: "NM", zoneId: "world:NM" });
    const offRay = through.spawnMob({ archetype: "ogre", maxHealthMultiplier: 700 / 32, position: destinationPoint(origin, 100, 20), regionCode: "NM", zoneId: "world:NM" });
    start(through, primary.entityId); through.useNormalAbility({ ...authority, abilityId: "ranger_v2_throughshot" });
    tickUntil(through, () => through.entity(primary.entityId)!.currentHealth < primary.maxHealth);
    expect(through.entity(behind.entityId)!.currentHealth).toBeLessThan(behind.maxHealth);
    expect(through.entity(offRay.entityId)!.currentHealth).toBe(offRay.maxHealth);

    const fan = createEngine(); configure(fan, "ninja", "starter_shuriken", "ninja_v2_shuriken_fan", null, false);
    const fanPrimary = fan.spawnMob({ archetype: "ogre", maxHealthMultiplier: 700 / 32, position: east(20), regionCode: "NM", zoneId: "world:NM" });
    const forward = fan.spawnMob({ archetype: "ogre", maxHealthMultiplier: 700 / 32, position: destinationPoint(origin, 35, 70), regionCode: "NM", zoneId: "world:NM" });
    const behindFan = fan.spawnMob({ archetype: "ogre", maxHealthMultiplier: 700 / 32, position: destinationPoint(origin, 35, 180), regionCode: "NM", zoneId: "world:NM" });
    fan.useNormalAbility({ ...authority, abilityId: "ninja_v2_shuriken_fan", targetEntityId: fanPrimary.entityId, targetMode: "hostile" });
    expect(fan.entity(forward.entityId)!.currentHealth).toBeLessThan(forward.maxHealth);
    expect(fan.entity(behindFan.entityId)!.currentHealth).toBe(behindFan.maxHealth);
  });

  it("breaks arrival protection for hostile immediate casts but preserves it for pure self utility", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const hostile = createEngine(); configure(hostile, "ranger", "starter_bow", "ranger_v2_marked_quarry", null, false);
    const enemy = spawn(hostile, 10); expect(hostile.grantFlagArrivalProtection("player", 1)).toBe(400_000);
    hostile.useNormalAbility({ ...authority, abilityId: "ranger_v2_marked_quarry", targetEntityId: enemy.entityId, targetMode: "hostile" });
    expect(hostile.flagArrivalProtectionUntil("player")).toBeNull();

    const utility = createEngine(); configure(utility, "ninja", "starter_shuriken", "ninja_v2_smoke_bomb", null, false);
    expect(utility.grantFlagArrivalProtection("player", 1)).toBe(400_000);
    utility.useNormalAbility({ ...authority, abilityId: "ninja_v2_smoke_bomb" });
    expect(utility.flagArrivalProtectionUntil("player")).toBe(400_000);
  });

  it.each([
    ["ninja_v2_twin_fang", false, 3, 3]
  ] as const)("resolves %s as ordered same-tick packets without extra action accounting", (abilityId, ultimate, count, amount) => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const engine = createEngine();
    configure(engine, "ninja", "starter_shuriken", abilityId, null, ultimate);
    const enemy = spawn(engine, 10);
    const beforeSequence = engine.entity("player")!.classCombat!.classCounters!.actionSequence ?? 0;
    const input = { ...authority, abilityId, targetEntityId: enemy.entityId, targetMode: "hostile" as const };
    if (ultimate) engine.useUltimateAbility(input); else engine.useNormalAbility(input);
    const events = engine.beginDeltaFlush().events.filter((event) =>
      event.type === "DAMAGE" && event.targetEntityId === enemy.entityId);
    expect(events).toHaveLength(count);
    expect(new Set(events.map(({ tick }) => tick)).size).toBe(1);
    expect(events.map(({ amount: value, packetIndex, packetCount, presentationDelayMs }) =>
      [value, packetIndex, packetCount, presentationDelayMs])).toEqual(
      Array.from({ length: count }, (_, index) => [amount, index + 1, count, index * 100]));
    expect(engine.entity("player")!.classCombat!.classCounters!.actionSequence).toBe(beforeSequence + 1);
  });

  it("publishes Quarry Sign through the harmful-status projection for its full mark", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const engine = createEngine();
    configure(engine, "ranger", "starter_bow", "ranger_v2_marked_quarry", null, false);
    const enemy = engine.spawnMob({ archetype: "ogre", position: east(10), regionCode: "NM", zoneId: "world:NM", defenseOverride: 5 });
    engine.useNormalAbility({ ...authority, abilityId: "ranger_v2_marked_quarry", targetEntityId: enemy.entityId, targetMode: "hostile" });
    expect(engine.entity(enemy.entityId)!.harmfulStatusIds).toContain("quarry_sign");
    expect(defense(engine, enemy.entityId)).toBe(3);
    vi.advanceTimersByTime(12_001);
    for (let tick = 0; tick < 241; tick += 1) engine.tick();
    expect(engine.entity(enemy.entityId)!.harmfulStatusIds ?? []).not.toContain("quarry_sign");
  });

  it("keeps Snare Trap visible and consumes it on exactly one trigger", () => {
    const engine = createEngine();
    configure(engine, "ranger", "starter_bow", "ranger_v2_snare_shot", null, false);
    const enemy = spawn(engine, 10);
    engine.useNormalAbility({ ...authority, abilityId: "ranger_v2_snare_shot", targetPosition: east(10) });
    const events = engine.beginDeltaFlush().events;
    expect(events.filter(({ type }) => type === "CLASS_ABILITY_ZONE_STARTED")).toHaveLength(1);
    expect(events.filter(({ type }) => type === "CLASS_ABILITY_ZONE_ENDED")).toHaveLength(1);
    expect(events.filter(({ type, targetEntityId }) => type === "DAMAGE" && targetEntityId === enemy.entityId)).toHaveLength(1);
    const health = engine.entity(enemy.entityId)!.currentHealth;
    for (let tick = 0; tick < 40; tick += 1) engine.tick();
    expect(engine.entity(enemy.entityId)!.currentHealth).toBe(health);
  });

  it("reduces Blood Rush cooldown when another party member defeats the watched target and keeps one embedded action", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const repositionPlayer = vi.fn(() => true);
    const engine = createEngine({ repositionPlayer, partyAuthority: partyAuthority() });
    configure(engine, "warrior", "training_axe", "warrior_v2_faultline", null, false);
    connectOther(engine, "ally", east(5));
    const enemy = spawn(engine, 200);
    const beforeSequence = engine.entity("player")!.classCombat!.classCounters!.actionSequence ?? 0;
    engine.useNormalAbility({ ...authority, abilityId: "warrior_v2_faultline", targetEntityId: enemy.entityId, targetMode: "hostile" });
    expect(engine.entity("player")!.classCombat!.classCounters!.actionSequence).toBe(beforeSequence + 1);
    expect(engine.entity("player")!.classCombat!.cooldownEndsAt.warrior_v2_faultline).toBe(125_000);
    engine.applyScriptedDamage("ally", enemy.entityId, 1_000, "ally_basic_attack");
    expect(engine.entity("player")!.classCombat!.cooldownEndsAt.warrior_v2_faultline).toBe(115_000);
  });

  it("makes Substitution miss once and requests its short authoritative relocation", () => {
    const repositionPlayer = vi.fn(() => true);
    const engine = createEngine({ repositionPlayer });
    configure(engine, "ninja", "starter_shuriken", "ninja_v2_smoke_bomb", null, false);
    const enemy = spawn(engine, 10);
    engine.useNormalAbility({ ...authority, abilityId: "ninja_v2_smoke_bomb" });
    expect(engine.applyScriptedDamage(enemy.entityId, "player", 10, "enemy_basic_attack")).toBe(0);
    expect(repositionPlayer).toHaveBeenCalledOnce();
    expect(engine.applyScriptedDamage(enemy.entityId, "player", 10, "enemy_basic_attack")).toBe(10);
  });

  it.each([
    ["warrior", "training_axe", "warrior_v2_iron_reversal"],
    ["ninja", "starter_shuriken", "ninja_v2_smoke_bomb"]
  ] as const)("makes %s avoidance suppress one complete targeted Shuriken packet bundle", (classId, weaponId, abilityId) => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const repositionPlayer = vi.fn(() => true);
    const engine = createEngine({ repositionPlayer });
    configure(engine, classId, weaponId, abilityId, null, false);
    configureOther(engine, "attacker", "ninja", "starter_shuriken", "ninja_v2_twin_fang", null, false);
    engine.useNormalAbility({ ...authority, abilityId });
    engine.useNormalAbility({ playerId: "attacker", accountId: "account:attacker", connectionId: "connection:attacker",
      abilityId: "ninja_v2_twin_fang", targetEntityId: "player", targetMode: "hostile" });
    expect(engine.entity("player")!.currentHealth).toBe(100);
    const packets = engine.beginDeltaFlush().events.filter((event) => event.type === "DAMAGE" && event.targetEntityId === "player");
    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ amount: 0, packetIndex: 1, packetCount: 3, presentationDelayMs: 0 });
  });

  it.each([
    ["ranger_v2_threefold_volley", "ranger", "starter_bow"],
    ["ranger_v2_snare_shot", "ranger", "starter_bow"],
    ["ninja_v2_twin_fang", "ninja", "starter_shuriken"],
    ["ninja_v2_shuriken_fan", "ninja", "starter_shuriken"]
  ] as const)("discards a stale persisted arm for former armed ability %s", (abilityId, classId, weaponId) => {
    const engine = createEngine();
    configure(engine, classId, weaponId, abilityId, null, false, 100, 25, {
      rage: 0, rageReserved: 0, queuedAbilityId: abilityId, queuedTargetEntityId: null, queuedAtTick: 10,
      cooldownEndsAt: {}, statusEffects: [], counters: {}, combatGeneration: 0, lastCombatAt: null
    });
    expect(engine.entity("player")!.classCombat!.queuedAbility).toBeNull();
  });

});

function createEngine(overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  return new CombatEngine({ tickRateHz: 20, isPlayerAuthorityActive: () => true, ...overrides });
}

function configure(engine: CombatEngine, classId: ClassId, weaponId: EquipmentDefinitionId, activeId: string, passiveId: string | null,
  ultimate: boolean, currentHealth = 100, rank = 25,
  persisted?: NonNullable<Parameters<CombatEngine["updatePlayerClassState"]>[3]>, extraUltimate?: string,
  chestId?: EquipmentDefinitionId): void {
  engine.connectPlayer({ playerId: "player", name: "player", regionCode: "NM", zoneId: "world:NM", position: origin,
    accountId: "account", connectionId: "connection", profile: { playerId: "player", level: 25, maxHealth: 100, currentHealth, baseAttackDamage: 10, defense: 0 } });
  const equipmentSnapshot = equipment(weaponId, chestId);
  engine.syncPlayerEquipmentCombatState("player", equipmentRuntime(weaponId, chestId));
  const progress = (id: ClassId) => ({ classId: id, level: id === classId ? rank : 0, xp: 0, nextLevelXp: null, completedAt: null });
  const snapshot: ClassSnapshot = { playerId: "player", characterLevel: 25, activeClassId: classId, activeSubclassId: null,
    unlockedClassIds: [classId as NonNullable<ClassSnapshot["unlockedClassIds"]>[number]], warrior: progress("warrior"), classes: ["warrior", "druid", "ranger", "knight", "ninja"].map((id) => progress(id as ClassId)), subclasses: [],
    loadout: { resetActives: [null, null], normalActives: ultimate ? [null, null] : [activeId, null], passiveTiers: [passiveId, null, null], ultimateActive: ultimate ? activeId : extraUltimate ?? null },
    legacyIds: [], rage: 0, maximumRage: 0, queuedAbility: null, cooldownEndsAt: {}, serverTime: Date.now(), revision: 1 };
  engine.updatePlayerClassState("player", snapshot, equipmentSnapshot, persisted ?? { rage: 0, rageReserved: 0, queuedAbilityId: null,
    queuedTargetEntityId: null, queuedAtTick: null, cooldownEndsAt: {}, statusEffects: [], counters: {}, combatGeneration: 0, lastCombatAt: null });
  engine.beginDeltaFlush();
}

function connectOther(engine: CombatEngine, playerId: string, position: LatLon, currentHealth = 100): void {
  engine.connectPlayer({ playerId, name: playerId, regionCode: "NM", zoneId: "world:NM", position,
    accountId: `account:${playerId}`, connectionId: `connection:${playerId}`,
    profile: { playerId, level: 25, maxHealth: 100, currentHealth, baseAttackDamage: 10, defense: 0 } });
}

function configureOther(engine: CombatEngine, playerId: string, classId: ClassId, weaponId: EquipmentDefinitionId,
  activeId: string, passiveId: string | null, ultimate: boolean, currentHealth = 100): void {
  connectOther(engine, playerId, east(5), currentHealth);
  const equipmentSnapshot = { ...equipment(weaponId), playerId };
  engine.syncPlayerEquipmentCombatState(playerId, equipmentRuntime(weaponId));
  const progress = (id: ClassId) => ({ classId: id, level: id === classId ? 25 : 0, xp: 0, nextLevelXp: null, completedAt: null });
  const snapshot: ClassSnapshot = { playerId, characterLevel: 25, activeClassId: classId, activeSubclassId: null,
    unlockedClassIds: [classId as NonNullable<ClassSnapshot["unlockedClassIds"]>[number]], warrior: progress("warrior"),
    classes: ["warrior", "druid", "ranger", "knight", "ninja"].map((id) => progress(id as ClassId)), subclasses: [],
    loadout: { resetActives: [null, null], normalActives: ultimate ? [null, null] : [activeId, null], passiveTiers: [passiveId, null, null], ultimateActive: ultimate ? activeId : null },
    legacyIds: [], rage: 0, maximumRage: 0, queuedAbility: null, cooldownEndsAt: {}, serverTime: Date.now(), revision: 1 };
  engine.updatePlayerClassState(playerId, snapshot, equipmentSnapshot, { rage: 0, rageReserved: 0, queuedAbilityId: null,
    queuedTargetEntityId: null, queuedAtTick: null, cooldownEndsAt: {}, statusEffects: [], counters: {}, combatGeneration: 0, lastCombatAt: null });
  engine.beginDeltaFlush();
}

function partyAuthority(): InMemoryPartyAuthority {
  const parties = new InMemoryPartyAuthority();
  parties.loadSnapshots([{ partyId: "party:test", leaderPlayerId: "player", memberPlayerIds: ["ally", "player"],
    memberSlots: [{ playerId: "player", slotIndex: 0 }, { playerId: "ally", slotIndex: 1 }], membershipRevision: 1,
    allowTravel: false, autoFollowPlayerIds: [], revision: 1 }]);
  return parties;
}

function expectCombatError(run: () => unknown, code: string): void {
  try { run(); throw new Error(`Expected ${code}`); } catch (error) {
    expect(error).toBeInstanceOf(CombatRequestError);
    expect((error as CombatRequestError).code).toBe(code);
  }
}

// Generic target: a Squid with the old 700 HP Ogre pool.
function spawn(engine: CombatEngine, meters: number) { return engine.spawnMob({ archetype: "squid", maxHealthMultiplier: 700 / 49, position: east(meters), regionCode: "NM", zoneId: "world:NM" }); }
function start(engine: CombatEngine, targetEntityId: string) { engine.startAttack({ attackerId: "player", targetEntityId, requestId: `start:${targetEntityId}`, ...authority }); }
function tickUntil(engine: CombatEngine, predicate: () => boolean, maximum = 80): void {
  for (let tick = 0; tick < maximum && !predicate(); tick += 1) engine.tick();
  expect(predicate()).toBe(true);
}
function defense(engine: CombatEngine, entityId: string): number {
  const internal = engine as unknown as { entities: Map<string, unknown>; effectiveDefense(target: unknown): number };
  return internal.effectiveDefense(internal.entities.get(entityId)!);
}
function setCooldown(engine: CombatEngine, abilityId: string, endsAt: number): void {
  const internal = engine as unknown as { entities: Map<string, { classRuntime?: { cooldownEndsAt: Record<string, number> } }> };
  internal.entities.get("player")!.classRuntime!.cooldownEndsAt[abilityId] = endsAt;
}
function queueEnemies(engine: CombatEngine, ...enemyIds: string[]): void {
  const internal = engine as unknown as {
    entities: Map<string, unknown>;
    ensurePveSession(player: unknown): unknown;
    claimMobAggro(mob: unknown, player: unknown, session: unknown): boolean;
    appendEnemy(session: unknown, enemyId: string): boolean;
  };
  const player = internal.entities.get("player")!;
  const session = internal.ensurePveSession(player);
  for (const enemyId of enemyIds) {
    internal.claimMobAggro(internal.entities.get(enemyId)!, player, session);
    internal.appendEnemy(session, enemyId);
  }
}
function east(meters: number): LatLon { return destinationPoint(origin, meters, 90); }

function equipment(definitionId: EquipmentDefinitionId, chestId?: EquipmentDefinitionId): EquipmentSnapshot {
  const definition = requireEquipmentDefinition(definitionId);
  const chest = chestId ? requireEquipmentDefinition(chestId) : null;
  return { playerId: "player", instances: [], weapon: { instanceId: "00000000-0000-4000-8000-000000000001", definitionId,
    displayName: definition.displayName, ownerPlayerId: "player", location: "equipped", equippedSlot: "weapon", attackPowerBonus: 0,
    defenseBonus: 0, weaponCategory: definition.weaponCategory, armorCategory: null, twoHanded: definition.twoHanded,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
    chest: chest ? { instanceId: "00000000-0000-4000-8000-000000000002", definitionId: chestId!,
      displayName: chest.displayName, ownerPlayerId: "player", location: "equipped", equippedSlot: "chest",
      attackPowerBonus: 0, defenseBonus: 0, weaponCategory: null, armorCategory: chest.armorCategory,
      twoHanded: false, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } : null,
    totalAttackPowerBonus: 0, totalDefenseBonus: 0 };
}

function equipmentRuntime(definitionId: EquipmentDefinitionId, chestId?: EquipmentDefinitionId): PlayerEquipmentCombatState {
  const definition = requireEquipmentDefinition(definitionId);
  const chest = chestId ? requireEquipmentDefinition(chestId) : null;
  const slot = definition.slot === "secondary" ? "secondary" : "melee";
  return { activeKitIndex: null, inventoryRevision: 1, activeRevision: 1,
    stats: { balanceVersion: 2, context: "pve", maximumHealth: 100, characterLevel: 25, classId: "warrior", classRank: 15,
      normalizedClassPower: 0, readiedWeaponSlot: slot, readiedWeaponCategory: definition.weaponCategory, weaponItemLevel: 0,
      effectiveWeaponLevel: 0, weightedArmorLevel: 0, shieldLevel: null, shieldGuardBonus: 0, pvpOffense: 0, pvpGuard: 0,
      pveAttackPower: 10, pveDefense: 0, pveWeaponProficiencyMultiplier: 1, universalAttackPower: 10, universalDefense: 0,
      weaponAttackPower: { melee: 10, secondary: 10 }, weaponCategories: { melee: slot === "melee" ? definition.weaponCategory : null,
        secondary: slot === "secondary" ? definition.weaponCategory : null }, resourceMaximumBonus: 0, resourceGenerationMultiplier: 1,
      actionDurationMultiplier: 1, choppingDurationMultiplier: 1, miningDurationMultiplier: 1, movementSpeedMultiplier: 1,
      crowdControlDurationMultiplier: 1, challengeProfile: { balanceVersion: 2, currentGearLevel: 0, unlockedGearLevel: 0,
        tier: "common", contributors: { melee: 0, chest: 0, secondary: 0 } }, attackIntervalMs: 1_600,
      // Fixed-damage (defense-bypassing) fixture weapon: passives are measured
      // against a flat attack, not the universal weapon x armor table.
      attackRangeM: slot === "secondary" ? 150 : 75, bypassPveDefense: true,
      items: { head: null, chest: null, gloves: null, boots: null, ring: null, ring_2: null, melee: null, secondary: null, tool_axe: null, tool_pickaxe: null, tool_fishing_pole: null } },
    weaponCategory: definition.weaponCategory, chestArmorCategory: chest?.armorCategory ?? null,
    chestDefinitionId: chestId ?? null, heavyArmorPieces: 0, hasShield: false,
    activeWeaponInstanceId: "00000000-0000-4000-8000-000000000001", activeWeaponEnchantmentIdentity: null,
    armorEnchantmentIdentities: { head: null, chest: null, gloves: null, boots: null }, weaponSlots: {
      melee: { instanceId: slot === "melee" ? "00000000-0000-4000-8000-000000000001" : null, definitionId: slot === "melee" ? definitionId : null, category: slot === "melee" ? definition.weaponCategory : null, enchantmentIdentity: null },
      secondary: { instanceId: slot === "secondary" ? "00000000-0000-4000-8000-000000000001" : null, definitionId: slot === "secondary" ? definitionId : null, category: slot === "secondary" ? definition.weaponCategory : null, enchantmentIdentity: null } },
    activeWeaponSlot: slot, switchPolicy: slot === "secondary" ? "ranged_only" : "melee_priority", switchingToSlot: null, switchStartedAtTick: null, switchCompletesAtTick: null };
}

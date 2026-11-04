import { describe, expect, it, vi } from "vitest";

import {
  applySkillSystemV3CombatStats,
  beatAlignedIntervalMs,
  moveToward,
  type GeneralSkillId,
  type LatLon,
  type SkillSystemV3Snapshot,
  type SpecializationId
} from "@ash-atlas/shared";
import { CombatEngine } from "./combatEngine.js";

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };

describe("Skill System V3 combat runtime", () => {
  it("plans Replenish with exact floor math and defers combat and disconnect until commit", () => {
    const engine = createEngine({
      partyAuthority: {
        partyForPlayer: () => ({
          partyId: "party", leaderPlayerId: "druid", memberPlayerIds: ["druid", "ally", "other"],
          allowTravel: true, autoFollowPlayerIds: [], revision: 1
        }),
        sameParty: () => true
      }
    });
    addPlayer(engine, "druid");
    addPlayer(engine, "ally", east(1), 10, 37);
    addPlayer(engine, "other", east(2));
    applySkills(engine, "druid", {}, "starter_staff", "staff", "druid", 1, true);
    applySkills(engine, "other", {}, null, null);
    const authority = {
      playerId: "druid", targetPlayerId: "ally",
      accountId: "account-druid", connectionId: "connection-druid"
    };
    const plan = engine.reserveReplenish(authority);
    expect(plan).toMatchObject({ casterAfter: 10, targetAfter: 100 });
    const ally = internals(engine).entities.get("ally")!;
    const other = internals(engine).entities.get("other")!;
    internals(engine).applyDamage(other, ally, 10, "test_area", false, {}, 0, false, "area");
    internals(engine).applyHealing(other, ally, 5, "test_heal", {});
    engine.updatePlayerPveStats("ally", { level: 25, maxHealth: 120, attackPower: 10, defense: 0 });
    engine.disconnectPlayer("ally");
    expect(engine.entity("ally")?.currentHealth).toBe(37);
    engine.completeReplenish(plan, { caster: 10, target: 10 });
    expect(engine.entity("druid")?.currentHealth).toBe(10);
    expect(engine.entity("ally")).toBeNull();
    expect(engine.peekDirtyProfiles().find((entry) => entry.playerId === "ally"))
      .toMatchObject({ maxHealth: 120, currentHealth: 114 });
    expect(engine.entity("other")?.currentHealth).toBe(100);
  });

  it("uses the Withered ratio at every Druid rank and never spends the final HP", () => {
    const engine = createEngine({
      partyAuthority: {
        partyForPlayer: () => ({ partyId: "party", leaderPlayerId: "druid",
          memberPlayerIds: ["druid", "ally"], allowTravel: true, autoFollowPlayerIds: [], revision: 1 }),
        sameParty: () => true
      }
    });
    addPlayer(engine, "druid", origin, 10, 50);
    addPlayer(engine, "ally", east(1), 10, 70);
    applySkills(engine, "druid", {}, "starter_staff", "staff", "druid", 5, true);
    applySkills(engine, "ally", {}, null, null);
    const ally = internals(engine).entities.get("ally")!;
    ally.classRuntime!.effects.push(effect("gloom", "gloom", "test_shade", 1));
    const plan = engine.reserveReplenish({
      playerId: "druid", targetPlayerId: "ally", accountId: "account-druid", connectionId: "connection-druid"
    });
    expect(plan).toMatchObject({ casterAfter: 1, targetAfter: 84 });
    engine.completeReplenish(plan);
    expect(engine.entity("druid")?.currentHealth).toBe(50);
  });
  it("exposes general ranks and preserves companion health ratios while persisting base health", () => {
    const onCompanionHealthChanged = vi.fn();
    const engine = createEngine({ onCompanionHealthChanged });
    addPlayer(engine, "player");
    engine.updatePlayerSkillState("player", snapshot("player", { companion_bond: 2 }, null, 0));
    expect(engine.generalSkillRank("player", "companion_bond")).toBe(2);
    expect(engine.generalSkillRank("missing", "companion_bond")).toBe(0);
    engine.spawnMob({
      entityId: "dog", archetype: "wolf", position: east(2), regionCode: "NM", zoneId: "world:NM",
      companion: { ownerPlayerId: "player", dogId: "dog-1", name: "Milo", species: "trail_hound", baseMaxHealth: 100, maxHealth: 150, currentHealth: 75, damage: 10, mode: "play" }
    });
    expect(engine.rescaleCompanionHealth("dog", 1.7)).toBe(true);
    expect(engine.entity("dog")).toMatchObject({ maxHealth: 170, currentHealth: 85 });
    expect(onCompanionHealthChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      currentHealth: 85, maxHealth: 170, baseMaxHealth: 100, defeated: false
    }));
    internals(engine).entities.get("dog")!.currentHealth = 80;
    expect(engine.healEntity("dog", 3)).toBe(3);
    expect(onCompanionHealthChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      currentHealth: 83, maxHealth: 170, baseMaxHealth: 100, defeated: false
    }));
  });

  it("never learns Ultimates and rejects forged execution without a cooldown or effect", () => {
    const engine = createEngine();
    addPlayer(engine, "player");
    const locked = snapshot("player", {}, "warrior", 5);
    engine.updatePlayerSkillState("player", {
      ...locked,
      ultimate: { id: "warrior_v2_worldbreaker", specializationId: "warrior", status: "ready" }
    });
    let runtime = internals(engine).entities.get("player")!.classRuntime!;
    expect(runtime.learned.has("warrior_v2_worldbreaker")).toBe(false);

    const completed = snapshot("player", {}, "warrior", 5, 2, true);
    engine.updatePlayerSkillState("player", {
      ...completed,
      ultimate: { id: "warrior_v2_worldbreaker", specializationId: "warrior", status: "ready" }
    });
    runtime = internals(engine).entities.get("player")!.classRuntime!;
    expect(runtime.learned.has("warrior_v2_worldbreaker")).toBe(false);
    expect(() => engine.useUltimateAbility({
      playerId: "player",
      abilityId: "warrior_v2_worldbreaker",
      accountId: "account-player",
      connectionId: "connection-player"
    })).toThrow(expect.objectContaining({ code: "ULTIMATE_DISABLED" }));
    expect(runtime.cooldownEndsAt).toEqual({});
    expect(runtime.effects).toEqual([]);
  });

  it("preserves live runtime state when the same skill snapshot revision is replayed", () => {
    const engine = createEngine();
    addPlayer(engine, "player");
    engine.updatePlayerSkillState("player", snapshot("player", { cleanse: 3 }, null, 0, 7));
    const runtime = internals(engine).entities.get("player")!.classRuntime!;
    runtime.cooldownEndsAt["v3:general:cleanse"] = 20_000;
    runtime.counters.skillV3TacticsValue = 1.4;
    runtime.effects.push(effect("retained", "flat_attack", "v3_test", 1));

    engine.updatePlayerSkillState("player", {
      ...snapshot("player", { cleanse: 3 }, null, 0, 7),
      cooldownEndsAt: { "v3:general:cleanse": 10_000 }
    });

    expect(runtime.cooldownEndsAt["v3:general:cleanse"]).toBe(20_000);
    expect(runtime.counters.skillV3TacticsValue).toBe(1.4);
    expect(runtime.effects.some((entry) => entry.id === "retained")).toBe(true);
  });

  it("resolves Cleave, Ricochet, and Quarry Sense once without PvP leakage", () => {
    const melee = createEngine({ random: () => 0 });
    addPlayer(melee, "player");
    applySkills(melee, "player", { cleave: 3, quarry_sense: 3 }, "starter_sword", "sword");
    const primary = mob(melee, "primary", east(10));
    const secondaryOne = mob(melee, "secondary-1", east(20));
    const secondaryTwo = mob(melee, "secondary-2", east(25));
    internals(melee).resolveBasicAttack(internals(melee).entities.get("player")!, primary);
    expect(secondaryOne.currentHealth).toBeLessThan(secondaryOne.maxHealth);
    expect(secondaryTwo.currentHealth).toBeLessThan(secondaryTwo.maxHealth);
    expect(primary.classRuntime?.effects.some((entry) => entry.kind === "quarry_exposure")).toBe(true);

    const cleaveDisallowed = createEngine({ random: () => 0 });
    addPlayer(cleaveDisallowed, "player");
    applySkills(cleaveDisallowed, "player", { cleave: 3 }, "starter_bow", "bow");
    const cleaveDisallowedPrimary = mob(cleaveDisallowed, "primary", east(10));
    const cleaveDisallowedSecondary = mob(cleaveDisallowed, "secondary", east(20));
    internals(cleaveDisallowed).resolveBasicAttack(internals(cleaveDisallowed).entities.get("player")!, cleaveDisallowedPrimary);
    expect(cleaveDisallowedSecondary.currentHealth).toBe(cleaveDisallowedSecondary.maxHealth);

    const ranged = createEngine({ random: () => 1 });
    addPlayer(ranged, "player");
    applySkills(ranged, "player", { ricochet: 3 }, "starter_bow", "bow");
    const rangedPrimary = mob(ranged, "primary", east(10));
    const bounceOne = mob(ranged, "bounce-1", east(20));
    const bounceTwo = mob(ranged, "bounce-2", east(30));
    internals(ranged).resolveBasicAttack(internals(ranged).entities.get("player")!, rangedPrimary);
    expect([bounceOne, bounceTwo].filter((entry) => entry.currentHealth < entry.maxHealth)).toHaveLength(1);

    const disallowed = createEngine({ random: () => 0 });
    addPlayer(disallowed, "player");
    applySkills(disallowed, "player", { ricochet: 3 }, "starter_sword", "sword");
    const disallowedPrimary = mob(disallowed, "primary", east(10));
    const disallowedSecondary = mob(disallowed, "secondary", east(20));
    internals(disallowed).resolveBasicAttack(internals(disallowed).entities.get("player")!, disallowedPrimary);
    expect(disallowedSecondary.currentHealth).toBe(disallowedSecondary.maxHealth);

    const pvp = createEngine({ random: () => 0 });
    addPlayer(pvp, "attacker");
    addPlayer(pvp, "target", east(10));
    applySkills(pvp, "attacker", { perfect_strike: 3, quarry_sense: 3, deathburst: 3 }, "starter_sword", "sword");
    const target = internals(pvp).entities.get("target")!;
    internals(pvp).resolveBasicAttack(internals(pvp).entities.get("attacker")!, target);
    expect(target.lifeState).toBe("alive");
    expect(target.classRuntime?.effects.some((entry) => entry.kind === "quarry_exposure") ?? false).toBe(false);
  });

  it("keeps Pierce Armor primed when weaker and isolates Concentration third-hit state", () => {
    const engine = createEngine({ random: () => 1 });
    addPlayer(engine, "player", origin, 50);
    applySkills(engine, "player", { pierce_armor: 3, concentration: 3 }, "starter_sword", "sword");
    const player = internals(engine).entities.get("player")!;
    const first = mob(engine, "first", east(10));
    first.maxHealth = first.currentHealth = 100;
    internals(engine).resolveBasicAttack(player, first);
    expect(player.classRuntime!.counters.skillV3PierceArmorReadyAt).toBeUndefined();

    player.attackDamage = 10;
    const second = mob(engine, "second", east(15));
    second.maxHealth = second.currentHealth = 100;
    internals(engine).resolveBasicAttack(player, second);
    expect(second.currentHealth).toBe(62);
    expect(Number(player.classRuntime!.counters.skillV3PierceArmorReadyAt)).toBeGreaterThan(Date.now());

    player.classRuntime!.counters.skillV3PierceArmorReadyAt = Date.now() + 180_000;
    const concentrated = mob(engine, "concentrated", east(20));
    concentrated.maxHealth = 200;
    concentrated.currentHealth = 150;
    const beforeOne = concentrated.currentHealth;
    internals(engine).resolveBasicAttack(player, concentrated);
    const firstHit = beforeOne - concentrated.currentHealth;
    const beforeTwo = concentrated.currentHealth;
    internals(engine).resolveBasicAttack(player, concentrated);
    const secondHit = beforeTwo - concentrated.currentHealth;
    const beforeThree = concentrated.currentHealth;
    internals(engine).resolveBasicAttack(player, concentrated);
    const thirdHit = beforeThree - concentrated.currentHealth;
    expect(firstHit).toBe(secondHit);
    expect(thirdHit).toBeGreaterThan(secondHit);
  });

  it("limits Pierce Armor to compatible melee basic or weapon hits against mobs", () => {
    const ranged = createEngine({ random: () => 1 });
    addPlayer(ranged, "player", origin, 10);
    applySkills(ranged, "player", { pierce_armor: 3 }, "starter_bow", "bow");
    const rangedPlayer = internals(ranged).entities.get("player")!;
    const rangedTarget = mob(ranged, "ranged-target", east(10));
    expect(internals(ranged).applyDamage(
      rangedPlayer, rangedTarget, 1, "ranger_basic_attack", true, {}, 0, true, "targeted"
    )).toBe(1);
    expect(rangedPlayer.classRuntime!.counters.skillV3PierceArmorReadyAt).toBeUndefined();

    const pvp = createEngine({ random: () => 1 });
    addPlayer(pvp, "attacker", origin, 10);
    addPlayer(pvp, "target", east(10));
    applySkills(pvp, "attacker", { pierce_armor: 3 }, "starter_sword", "sword");
    const attacker = internals(pvp).entities.get("attacker")!;
    const target = internals(pvp).entities.get("target")!;
    expect(internals(pvp).applyDamage(
      attacker, target, 1, "warrior_basic_attack", true, {}, 0, true, "targeted"
    )).toBe(1);
    expect(attacker.classRuntime!.counters.skillV3PierceArmorReadyAt).toBeUndefined();
  });

  it("arms Blight Strike by equipped rank and applies immunity-limited nonrecursive melee spread", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      const engine = createEngine({ random: () => 1 });
      addPlayer(engine, "player", origin, 10);
      const target = mob(engine, "target", east(10));
      engine.updatePlayerSkillState("player", {
        ...snapshot("player", { blight_strike: 2 }, null, 0),
        generalActiveLoadout: [null, null]
      });
      const player = internals(engine).entities.get("player")!;
      player.classRuntime!.weaponDefinitionId = "starter_bow";
      player.classRuntime!.weaponCategory = "bow";
      player.classRuntime!.weaponMode = "ranged";
      const activation = {
        playerId: "player", skillId: "blight_strike" as const,
        accountId: "account-player", connectionId: "connection-player",
        targetEntityId: target.entityId, targetMode: "hostile" as const
      };

      expect(() => engine.useGeneralActive(activation)).toThrow(expect.objectContaining({ code: "ABILITY_NOT_EQUIPPED" }));
      engine.updatePlayerSkillState("player", {
        ...snapshot("player", { blight_strike: 2 }, null, 0, 2),
        generalActiveLoadout: ["blight_strike", null]
      });
      engine.startAttack({
        attackerId: "player", targetEntityId: target.entityId, requestId: "start-blight",
        accountId: "account-player", connectionId: "connection-player"
      });
      engine.tick();
      expect(() => engine.useGeneralActive(activation)).not.toThrow();
      expect(player.classRuntime!.counters.skillV3BlightRank).toBe(2);
      expect(player.classRuntime!.cooldownEndsAt["v3:general:blight_strike"]).toBe(336_000);
      expect(() => engine.useGeneralActive(activation)).toThrow(expect.objectContaining({ code: "ABILITY_COOLDOWN" }));

      internals(engine).resolveBasicAttack(player, target);
      expect(player.classRuntime!.counters.skillV3BlightArmedUntil).toBeGreaterThan(Date.now());
      expect(target.classRuntime?.effects.some((effect) => effect.kind === "blight") ?? false).toBe(false);

      player.classRuntime!.weaponDefinitionId = "starter_sword";
      player.classRuntime!.weaponCategory = "sword";
      player.classRuntime!.weaponMode = "melee";
      internals(engine).resolveBasicAttack(player, target);
      const blight = target.classRuntime!.effects.find((effect) => effect.kind === "blight")!;
      expect(blight).toMatchObject({ amount: 0.14, remainingAmount: 31, spreadApplied: false });
      // 18 s of blight ticks once per beat interval: the nearest whole number of beats, same total damage.
      const blightBeatTicks = beatAlignedIntervalMs(1_000) * 18 / 1_000;
      expect(blight.stacks).toBe(Math.round(18_000 / beatAlignedIntervalMs(1_000)));
      expect(Math.abs(blight.endTick - blight.startTick - 360)).toBeLessThanOrEqual(blightBeatTicks);
      expect(player.classRuntime!.counters.skillV3BlightArmedUntil).toBeUndefined();
      expect(internals(engine).applyV3Blight(player, target, 3, false)).toBe(false);
      expect(target.classRuntime!.effects.filter((effect) => effect.kind === "blight")).toHaveLength(1);

      addPlayer(engine, "contact", east(15), 10);
      applySkills(engine, "contact", {}, "starter_sword", "sword");
      const contact = internals(engine).entities.get("contact")!;
      internals(engine).resolveBasicAttack(contact, target);
      const spread = contact.classRuntime!.effects.find((effect) => effect.kind === "blight")!;
      expect((spread as RuntimeEffect & { spreadApplied?: boolean }).spreadApplied).toBe(true);
      expect(Math.abs(spread.endTick - spread.startTick - 180)).toBeLessThanOrEqual(blightBeatTicks);

      const recursiveTarget = mob(engine, "recursive-target", east(20));
      internals(engine).spreadV3BlightOnContact(contact, recursiveTarget);
      expect(recursiveTarget.classRuntime?.effects.some((effect) => effect.kind === "blight") ?? false).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    const pvp = createEngine();
    addPlayer(pvp, "attacker");
    addPlayer(pvp, "opponent", east(10));
    const opponent = internals(pvp).entities.get("opponent")!;
    opponent.aggressiveUntilMs = Date.now() + 60_000;
    pvp.updatePlayerSkillState("attacker", {
      ...snapshot("attacker", { blight_strike: 1 }, null, 0),
      generalActiveLoadout: ["blight_strike", null]
    });
    expect(() => pvp.useGeneralActive({
      playerId: "attacker", skillId: "blight_strike",
      accountId: "account-attacker", connectionId: "connection-attacker",
      targetEntityId: "opponent", targetMode: "hostile"
    })).not.toThrow();
  });

  it("executes Perfect Strike only on qualifying mobs and accumulates Tactics by peaceful/aggressive time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      const engine = createEngine({ random: () => 0 });
      addPlayer(engine, "player");
      applySkills(engine, "player", { perfect_strike: 3, tactics: 2 }, "starter_sword", "sword", "druid", 5);
      const player = internals(engine).entities.get("player")!;
      const target = mob(engine, "perfect-target", east(10));
      internals(engine).resolveBasicAttack(player, target);
      expect(target.lifeState).toBe("defeated");

      player.aggressiveUntilMs = 0;
      engine.tick();
      vi.advanceTimersByTime(30_000);
      engine.tick();
      expect(player.classRuntime!.counters.skillV3TacticsValue).toBe(0.3);
      vi.advanceTimersByTime(870_000);
      engine.tick();
      expect(player.classRuntime!.counters.skillV3TacticsValue).toBe(7);
      player.aggressiveUntilMs = Date.now() + 100_000;
      engine.tick();
      vi.advanceTimersByTime(11_000);
      engine.tick();
      expect(player.classRuntime!.counters.skillV3TacticsValue).toBe(6.9);
      expect(internals(engine).v3AggressionDurationMs(player)).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds Tactics faster for an active Voyager only while no player building is visible", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      const engine = createEngine({ random: () => 0 });
      let buildingsNear = false;
      engine.setPlayerBuildingLookup(() => buildingsNear);
      addPlayer(engine, "player");
      applySkills(engine, "player", { tactics: 1 }, null, null, "voyager", 3);
      const player = internals(engine).entities.get("player")!;
      player.aggressiveUntilMs = 0;
      engine.tick();
      // Isolated, rank 3: 1.4x per 0.2 step, the remainder carried (+0.2 then +0.3).
      vi.advanceTimersByTime(30_000);
      engine.tick();
      expect(player.classRuntime!.counters.skillV3TacticsValue).toBe(0.2);
      vi.advanceTimersByTime(30_000);
      engine.tick();
      expect(player.classRuntime!.counters.skillV3TacticsValue).toBe(0.5);
      // A visible building returns to the plain rate.
      buildingsNear = true;
      vi.advanceTimersByTime(30_000);
      engine.tick();
      expect(player.classRuntime!.counters.skillV3TacticsValue).toBe(0.7);
      // Rank 5 doubles it; rank 2 (no isolation perk) and a non-Voyager never do.
      buildingsNear = false;
      applySkills(engine, "player", { tactics: 1 }, null, null, "voyager", 5);
      player.classRuntime!.counters.skillV3TacticsValue = 0;
      player.classRuntime!.counters.skillV3TacticsUpdatedAt = Date.now();
      vi.advanceTimersByTime(30_000);
      engine.tick();
      expect(player.classRuntime!.counters.skillV3TacticsValue).toBe(0.3);
      applySkills(engine, "player", { tactics: 1 }, null, null, "voyager", 2);
      player.classRuntime!.counters.skillV3TacticsValue = 0;
      player.classRuntime!.counters.skillV3TacticsUpdatedAt = Date.now();
      vi.advanceTimersByTime(30_000);
      engine.tick();
      expect(player.classRuntime!.counters.skillV3TacticsValue).toBe(0.2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies PvE kill momentum, healing, species state, and nonrecursive Deathburst", () => {
    const engine = createEngine({ random: () => 0, movePlayerToward: vi.fn() });
    addPlayer(engine, "player", origin, 10, 50);
    applySkills(engine, "player", {
      huntsmans_edge: 3, pursuit: 3, calm_mind: 3, second_wind: 3,
      deathburst: 3, heroism: 3
    }, "starter_sword", "sword");
    const player = internals(engine).entities.get("player")!;
    player.aggressiveUntilMs = 100_000;
    const defeated = mob(engine, "defeated", east(10));
    const nearby = mob(engine, "nearby", east(20));
    const nearbyBefore = nearby.currentHealth;
    internals(engine).onEnemyDefeated(player, defeated, false, "warrior_basic_attack");
    expect(player.currentHealth).toBe(54);
    expect(nearby.currentHealth).toBeLessThan(nearbyBefore);
    expect(player.classRuntime!.counters.skillV3HuntsmanSpecies).toBe(defeated.archetypeKey);
    expect(Number(player.classRuntime!.counters.skillV3PursuitEndsAt)).toBeGreaterThan(Date.now());
    expect(player.aggressiveUntilMs).toBeGreaterThan(Date.now());

    defeated.lifeState = "defeated";
    nearby.lifeState = "defeated";
    const isolated = mob(engine, "isolated", east(10));
    const isolatedAt = Date.now();
    internals(engine).onEnemyDefeated(player, isolated, false, "warrior_basic_attack");
    // Calm Mind rank 3: the last enemy dying ends aggression immediately.
    expect(player.aggressiveUntilMs).toBeLessThanOrEqual(isolatedAt);

    const boss = mob(engine, "boss", east(30), "xoral");
    internals(engine).onEnemyDefeated(player, boss, false, "warrior_basic_attack");
    expect(Number(player.classRuntime!.counters.skillV3HeroismEndsAt)).toBeGreaterThan(Date.now() + 71_000_000);
  });

  it("never bursts on a player kill and never damages players with Deathburst", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player");
    addPlayer(engine, "victim", east(10));
    addPlayer(engine, "bystander", east(20));
    applySkills(engine, "player", { deathburst: 3 }, "starter_sword", "sword");
    const player = internals(engine).entities.get("player")!;
    const bystander = internals(engine).entities.get("bystander")!;
    internals(engine).onEnemyDefeated(player, internals(engine).entities.get("victim")!, false, "warrior_basic_attack");
    expect(bystander.currentHealth).toBe(bystander.maxHealth);
    const defeated = mob(engine, "defeated", east(10));
    internals(engine).onEnemyDefeated(player, defeated, false, "warrior_basic_attack");
    expect(bystander.currentHealth).toBe(bystander.maxHealth);
  });

  it("keeps PvE-only attack bonuses and Quarry Sense off player-owned creatures", () => {
    const engine = createEngine({ random: () => 0 });
    addPlayer(engine, "player");
    applySkills(engine, "player", { tactics: 3, heroism: 3, quarry_sense: 3 }, "starter_sword", "sword");
    const player = internals(engine).entities.get("player")!;
    player.classRuntime!.counters.skillV3TacticsValue = 3;
    player.classRuntime!.counters.skillV3HeroismEndsAt = Date.now() + 60_000;
    const wild = mob(engine, "wild", east(10));
    engine.spawnMob({
      entityId: "pet", archetype: "wolf", position: east(12), regionCode: "NM", zoneId: "world:NM",
      companion: {
        ownerPlayerId: "other", dogId: "dog-1", name: "Milo", species: "trail_hound",
        baseMaxHealth: 100, maxHealth: 100, currentHealth: 100, damage: 10
      }
    });
    const pet = internals(engine).entities.get("pet")!;
    expect(internals(engine).v3PveContextualAttackBonus(player, wild)).toBeGreaterThanOrEqual(4);
    expect(internals(engine).v3PveContextualAttackBonus(player, pet)).toBe(0);
    expect(internals(engine).isPlayerOwnedCreature(pet)).toBe(true);
    expect(internals(engine).isPlayerOwnedCreature(wild)).toBe(false);
  });

  it("turns Provoke's Defense reduction into raw damage against that monster only", () => {
    const engine = createEngine({ random: () => 0.5 });
    addPlayer(engine, "player");
    addPlayer(engine, "other", east(5));
    applySkills(engine, "player", { provoke: 3 }, "starter_sword", "sword");
    const player = internals(engine).entities.get("player")!;
    const wolf = mob(engine, "wolf", east(10));
    const hit = (): number => {
      const before = wolf.currentHealth;
      internals(engine).applyDamage(player, wolf, 10, "test_hit", false, {}, 0, false, "targeted");
      return before - wolf.currentHealth;
    };
    const baseline = hit();
    internals(engine).addTimedEffect(player, wolf, "provoke_exposure", "v3_general_provoke", 10_000, 2);
    expect(hit()).toBe(baseline + 2);
    internals(engine).addTimedEffect(player, wolf, "defense_reduction", "some_other_source", 10_000, 2);
    expect(hit()).toBe(baseline + 2);
  });

  it("adds Tactics per chopped tree up to the rank cap", () => {
    const engine = createEngine();
    addPlayer(engine, "player");
    applySkills(engine, "player", { tactics: 2 }, null, null);
    for (let chops = 0; chops < 12; chops += 1) engine.recordTreeChopped("player");
    expect(internals(engine).entities.get("player")!.classRuntime!.counters.skillV3TacticsValue).toBe(2.5);
    engine.recordTreeChopped("missing");
  });

  it("scales Legionnaire formation Shield Defense by nearby shield-bearing players and party allies", () => {
    const engine = createEngine({
      partyAuthority: {
        partyForPlayer: () => ({ partyId: "party", leaderPlayerId: "legion", memberPlayerIds: ["legion", "ally"], allowTravel: true, autoFollowPlayerIds: [], revision: 1 }),
        sameParty: (left: string, right: string) => ["legion", "ally"].includes(left) && ["legion", "ally"].includes(right)
      }
    });
    addPlayer(engine, "legion");
    addPlayer(engine, "foe", east(5));
    addPlayer(engine, "ally", east(10));
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) addPlayer(engine, id, east(20));
    addPlayer(engine, "far", east(400));
    for (const id of ["foe", "ally", "s1", "s2", "s3", "s4", "s5", "far"]) applySkills(engine, id, {}, null, null);
    const entities = internals(engine).entities;
    for (const id of ["ally", "s1", "s2", "s3", "s4", "s5", "far"]) entities.get(id)!.classRuntime!.hasShield = true;
    const shieldDefense = (rank: number) => {
      applySkills(engine, "legion", {}, null, null, "legionnaire", rank);
      const legion = entities.get("legion")!;
      legion.classRuntime!.hasShield = true;
      return internals(engine).v3ClassDefenseBonuses(legion, entities.get("foe")!).shield;
    };
    // Rank 1: no shield bonus. Rank 2: 1 base + 6 entities * 0.4 capped at 2 + 1 ally * 0.2; rank 5 cap is 5.
    expect(shieldDefense(1)).toBe(0);
    expect(shieldDefense(2)).toBeCloseTo(1 + 2 + 0.2);
    expect(shieldDefense(4)).toBeCloseTo(2 + 3 + 0.2);
    expect(shieldDefense(5)).toBeCloseTo(2 + 5 + 0.2);
    // A shield-bearer attacking the Legionnaire, or out of range, does not count.
    entities.get("s1")!.targetEntityId = "legion";
    entities.get("s2")!.targetEntityId = "legion";
    entities.get("s3")!.targetEntityId = "legion";
    entities.get("s4")!.targetEntityId = "legion";
    entities.get("s5")!.targetEntityId = "legion";
    expect(shieldDefense(5)).toBeCloseTo(2 + 0.9 + 0.2);
  });

  it("validates and applies Merchant Maximize Tactics against the class cap", () => {
    const engine = createEngine();
    addPlayer(engine, "m");
    const state = () => engine.merchantMaximizeTacticsState("m", "account-m", "connection-m");
    applySkills(engine, "m", { tactics: 3 }, null, null);
    expect(state).toThrow("Merchant");
    applySkills(engine, "m", { tactics: 3 }, null, null, "merchant", 2);
    expect(state()).toMatchObject({ current: 0, maximum: 4.5 });
    engine.applyMerchantMaximizeTactics("m");
    expect(internals(engine).entities.get("m")!.classRuntime!.counters.skillV3TacticsValue).toBe(4.5);
    expect(state).toThrow("already at its maximum");
    applySkills(engine, "m", { tactics: 3 }, null, null, "merchant", 5);
    expect(state()).toMatchObject({ maximum: 7 });
  });

  it("honors Druid and Warrior thresholds and Ranger/Ninja movement projection", () => {
    const engine = createEngine({ playerMovementSpeedMps: 40 });
    addPlayer(engine, "target");
    addPlayer(engine, "attacker", east(10));
    applySkills(engine, "target", {}, null, null, "druid", 5);
    applySkills(engine, "attacker", {}, "crossbow", "crossbow");
    const target = internals(engine).entities.get("target")!;
    const attacker = internals(engine).entities.get("attacker")!;
    expect(target.classRuntime!.skillV3!.activeSpecializationId).toBe("druid");
    expect(attacker.classRuntime!.skillV3!.activeSpecializationId).toBeNull();
    expect(internals(engine).v3DodgeChance(target, attacker)).toBeCloseTo(0.27);
    attacker.classRuntime!.weaponDefinitionId = "starter_sword";
    attacker.classRuntime!.weaponCategory = "sword";
    expect(internals(engine).v3DodgeChance(target, attacker)).toBeCloseTo(0.27);
    applySkills(engine, "target", {}, null, null);
    attacker.classRuntime!.weaponDefinitionId = "crossbow";
    attacker.classRuntime!.weaponCategory = "crossbow";
    expect(internals(engine).v3DodgeChance(target, attacker)).toBe(0);

    applySkills(engine, "target", { martial_arts: 3 }, "starter_bow", "bow");
    expect(internals(engine).v3DodgeChance(target, attacker)).toBe(0);
    applySkills(engine, "target", {}, "starter_sword", "sword", "warrior", 4);
    target.currentHealth = 30;
    expect(internals(engine).v3ContextualAttackBonus(target)).toBe(1);
    target.classRuntime!.weaponDefinitionId = "training_axe";
    expect(internals(engine).v3ContextualAttackBonus(target)).toBe(2);
    target.classRuntime!.skillV3!.specializationRank = 5;
    target.currentHealth = 20;
    expect(internals(engine).v3ContextualAttackBonus(target)).toBe(3);

    for (const [specializationId, rank, expected] of [
      ["ranger", 2, 1.1], ["ninja", 5, 1.675]
    ] as const) {
      applySkills(engine, "target", {}, null, null, specializationId, rank);
      expect(engine.playerMovementMultiplier("target")).toBeCloseTo(expected);
    }
  });

  it("projects Warrior Max HP and Ranger V3 bow range without compounding replays", () => {
    const engine = createEngine();
    addPlayer(engine, "player");
    applySkills(engine, "player", {}, "training_axe", "axe", "warrior", 5, true);
    const player = internals(engine).entities.get("player")!;
    expect(player.maxHealth).toBe(145);
    engine.updatePlayerSkillState("player", snapshot("player", {}, "warrior", 5, 1, false, true));
    expect(player.maxHealth).toBe(145);
    applySkills(engine, "player", {}, "starter_bow", "bow", "ranger", 4, true);
    player.classRuntime!.weaponMode = "ranged";
    engine.updatePlayerSkillState("player", snapshot("player", {}, "ranger", 4, 2, false, true));
    expect(player.maxHealth).toBe(100);
    expect(player.attackRangeM).toBe(340);
  });

  it("counts skill Attack, Defense and Warrior Max HP exactly once after both PvE stat paths run", () => {
    const base = { maxHp: 100, attack: 10, defense: 0 };
    const runBothPaths = (
      engine: CombatEngine,
      snap: SkillSystemV3Snapshot,
      weaponProfile: "axe" | "unarmed" | "sword",
      bodyDefenseProfile: "unarmored" | "breastplate"
    ) => {
      // Path 1: the shared helper feeding the PROGRESSION pveStats the server hands to the engine.
      const resolved = applySkillSystemV3CombatStats({
        ...base, movementSpeed: 0, attackRangeM: 0, dodgeProbability: 0,
        directHealingMultiplier: 1, healingOverTimeMultiplier: 1
      }, snap, {
        weaponProfile, bodyDefenseProfile, shieldEquipped: false, martialArtsDodgeEligible: true
      });
      // Path 2: the engine's own skill runtime.
      engine.updatePlayerSkillState("player", snap);
      engine.updatePlayerPveStats("player", {
        level: 40, maxHealth: resolved.maxHp, attackPower: resolved.attack, defense: resolved.defense
      });
    };

    const warriorEngine = createEngine({ random: () => 0.5 });
    addPlayer(warriorEngine, "player");
    runBothPaths(warriorEngine, snapshot("player", {}, "warrior", 5, 1, false, true), "axe", "unarmored");
    const warrior = internals(warriorEngine).entities.get("player")!;
    warrior.classRuntime!.weaponDefinitionId = "training_axe";
    warrior.classRuntime!.weaponCategory = "axe";
    expect(warrior.maxHealth).toBe(145);
    expect(warrior.attackDamage).toBe(10);
    expect(internals(warriorEngine).v3StaticAttackBonus(warrior)).toBe(4);

    const martialEngine = createEngine({ random: () => 0.5 });
    addPlayer(martialEngine, "player");
    runBothPaths(martialEngine, snapshot("player", { martial_arts: 1 }, null, 0), "unarmed", "unarmored");
    const martial = internals(martialEngine).entities.get("player")!;
    martial.classRuntime!.weaponDefinitionId = null;
    martial.classRuntime!.weaponCategory = null;
    martial.classRuntime!.chestDefinitionId = null;
    martial.level = 40;
    expect(martial.attackDamage).toBe(10);
    expect(martial.defense).toBe(0);
    expect(internals(martialEngine).v3StaticAttackBonus(martial)).toBe(25);
    const foe = internals(martialEngine);
    addPlayer(martialEngine, "foe", east(10));
    expect(foe.v3ClassDefenseBonuses(martial, foe.entities.get("foe")!)).toEqual({ body: 25, shield: 0 });

    const knightEngine = createEngine({ random: () => 0.5 });
    addPlayer(knightEngine, "player");
    addPlayer(knightEngine, "foe", east(10));
    runBothPaths(knightEngine, snapshot("player", {}, "knight", 4, 1, false, true), "sword", "breastplate");
    const knight = internals(knightEngine).entities.get("player")!;
    knight.classRuntime!.chestDefinitionId = "breast_plate";
    expect(knight.defense).toBe(0);
    expect(internals(knightEngine).v3ClassDefenseBonuses(knight, internals(knightEngine).entities.get("foe")!).body).toBe(2);
  });

  it("keeps Ninja Dodge unchanged by an Ice weapon and never rolls Dodge for area damage", () => {
    const engine = createEngine();
    addPlayer(engine, "ninja");
    addPlayer(engine, "attacker", east(10));
    applySkills(engine, "ninja", { martial_arts: 3 }, null, null, "ninja", 5);
    applySkills(engine, "attacker", {}, "starter_sword", "sword");
    const ninja = internals(engine).entities.get("ninja")!;
    const attacker = internals(engine).entities.get("attacker")!;

    ninja.classRuntime!.chestDefinitionId = "padded_tunic";
    attacker.equipmentCombatState = equipmentEnhancementContext(null);
    expect(internals(engine).v3DodgeChance(ninja, attacker)).toBeCloseTo(0.39);
    attacker.equipmentCombatState = equipmentEnhancementContext("enh:v1:ruby:ice");
    // Frost no longer halves Ninja dodge by itself; its slow status scales dodge x0.85 instead.
    expect(internals(engine).v3DodgeChance(ninja, attacker)).toBeCloseTo(0.39);
    attacker.equipmentCombatState = equipmentEnhancementContext(null, "enh:v1:ruby:ice");
    expect(internals(engine).v3DodgeChance(ninja, attacker)).toBeCloseTo(0.39);

    const areaEngine = createEngine({ random: () => 0 });
    addPlayer(areaEngine, "area-target");
    applySkills(areaEngine, "area-target", { martial_arts: 3 }, null, null, "ninja", 5);
    const areaAttacker = mob(areaEngine, "area-attacker", east(10));
    const areaTarget = internals(areaEngine).entities.get("area-target")!;
    const dodgeResolver = vi.spyOn(internals(areaEngine), "v3DodgeChance");
    internals(areaEngine).applyDamage(areaAttacker, areaTarget, 10, "wolf_basic_attack", true, {}, 0, true, "area");
    expect(dodgeResolver).not.toHaveBeenCalled();
    expect(areaTarget.currentHealth).toBeLessThan(areaTarget.maxHealth);

    const healthAfterArea = areaTarget.currentHealth;
    internals(areaEngine).applyDamage(areaAttacker, areaTarget, 10, "ninja_v2_twin_fang", true, {}, 0, true, "targeted");
    expect(dodgeResolver).not.toHaveBeenCalled();
    expect(areaTarget.currentHealth).toBeLessThan(healthAfterArea);
  });

  it("requires Shield Charge to use a shield from a compatible melee stance", () => {
    const movePlayerToward = vi.fn();
    const engine = createEngine({ movePlayerToward });
    addPlayer(engine, "player");
    addPlayer(engine, "target", east(10));
    const target = internals(engine).entities.get("target")!;
    target.aggressiveUntilMs = Date.now() + 60_000;
    engine.updatePlayerSkillState("player", {
      ...snapshot("player", { shield_charge: 1 }, null, 0),
      generalActiveLoadout: [null, null]
    });
    const runtime = internals(engine).entities.get("player")!.classRuntime!;
    runtime.hasShield = true;
    expect(() => engine.useGeneralActive({
      playerId: "player",
      skillId: "shield_charge",
      accountId: "account-player",
      connectionId: "connection-player",
      targetEntityId: target.entityId,
      targetMode: "hostile"
    })).toThrow("not equipped");
    runtime.hasShield = false;
    engine.updatePlayerSkillState("player", {
      ...snapshot("player", { shield_charge: 1 }, null, 0, 2),
      generalActiveLoadout: ["shield_charge", null]
    });
    runtime.weaponMode = "ranged";

    expect(() => engine.useGeneralActive({
      playerId: "player",
      skillId: "shield_charge",
      accountId: "account-player",
      connectionId: "connection-player",
      targetEntityId: target.entityId,
      targetMode: "hostile"
    })).toThrow("equipped shield");
    expect(runtime.cooldownEndsAt["v3:general:shield_charge"]).toBeUndefined();

    runtime.hasShield = true;
    expect(() => engine.useGeneralActive({
      playerId: "player",
      skillId: "shield_charge",
      accountId: "account-player",
      connectionId: "connection-player",
      targetEntityId: target.entityId,
      targetMode: "hostile"
    })).toThrow("compatible melee stance");
    expect(runtime.cooldownEndsAt["v3:general:shield_charge"]).toBeUndefined();

    runtime.weaponMode = "melee";
    expect(() => engine.useGeneralActive({
      playerId: "player",
      skillId: "shield_charge",
      accountId: "account-player",
      connectionId: "connection-player",
      targetEntityId: target.entityId,
      targetMode: "hostile"
    })).not.toThrow();
    expect(movePlayerToward).toHaveBeenCalledWith("player", target.position);
    expect(runtime.cooldownEndsAt["v3:general:shield_charge"]).toBeGreaterThan(Date.now());

    const cooldown = runtime.cooldownEndsAt["v3:general:shield_charge"];
    engine.updatePlayerSkillState("player", {
      ...snapshot("player", { shield_charge: 1 }, null, 0, 3),
      generalActiveLoadout: ["shield_charge", null]
    });
    expect(runtime.cooldownEndsAt["v3:general:shield_charge"]).toBe(cooldown);
    expect(runtime.effects.some((entry) => entry.sourceTechniqueId === "v3_general_shield_charge")).toBe(true);
    expect(runtime.counters.skillV3ShieldChargeTarget).toBe("target");

    engine.updatePlayerSkillState("player", snapshot("player", {}, null, 0, 4));
    expect(runtime.cooldownEndsAt["v3:general:shield_charge"]).toBeUndefined();
    expect(runtime.effects.some((entry) => entry.sourceTechniqueId === "v3_general_shield_charge")).toBe(false);
    expect(runtime.counters.skillV3ShieldChargeTarget).toBeUndefined();

    engine.updatePlayerSkillState("player", snapshot("player", { cleanse: 1 }, null, 0, 5));
    expect(() => engine.useGeneralActive({
      playerId: "player",
      skillId: "cleanse",
      accountId: "account-player",
      connectionId: "connection-player",
      targetMode: "self"
    })).toThrow(expect.objectContaining({ code: "ABILITY_NOT_EQUIPPED" }));
  });

  it("keeps the V3 Taunt defense window at forty seconds", () => {
    const engine = createEngine();
    addPlayer(engine, "player");
    const target = mob(engine, "target", east(10));
    engine.startAttack({
      attackerId: "player", targetEntityId: target.entityId, requestId: "start-taunt",
      accountId: "account-player", connectionId: "connection-player"
    });
    engine.updatePlayerSkillState("player", {
      ...snapshot("player", { taunt: 1 }, null, 0),
      generalActiveLoadout: ["taunt", null]
    });
    expect(() => engine.useGeneralActive({
      playerId: "player", skillId: "taunt",
      accountId: "account-player", connectionId: "connection-player", targetMode: "self"
    })).not.toThrow();
    const tauntDefense = internals(engine).entities.get("player")!.classRuntime!.effects.find((entry) =>
      entry.sourceTechniqueId === "v3_general_taunt_defense"
    );
    expect(tauntDefense).toBeDefined();
    expect(tauntDefense!.endTick - tauntDefense!.startTick).toBe(720);
  });

  it("heals with Second Wind on every qualifying kill, with no cooldown", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      const engine = createEngine({ random: () => 0 });
      addPlayer(engine, "player", origin, 10, 50);
      applySkills(engine, "player", { second_wind: 3 }, "starter_sword", "sword");
      const player = internals(engine).entities.get("player")!;

      internals(engine).onEnemyDefeated(player, mob(engine, "first", east(10)), false, "warrior_basic_attack");
      expect(player.currentHealth).toBe(54);

      player.currentHealth = 50;
      internals(engine).onEnemyDefeated(player, mob(engine, "second", east(20)), false, "warrior_basic_attack");
      expect(player.currentHealth).toBe(54);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies exact Calm Mind, Archery, and Martial Arts rank boundaries", () => {
    const engine = createEngine();
    addPlayer(engine, "player");
    addPlayer(engine, "attacker", east(10));
    const player = internals(engine).entities.get("player")!;
    internals(engine).entities.get("attacker")!;

    for (const [rank, duration] of [[1, 8_800], [2, 7_300], [3, 5_800]] as const) {
      applySkills(engine, "player", { calm_mind: rank }, null, null);
      expect(internals(engine).v3AggressionDurationMs(player)).toBe(duration);
    }

    player.classRuntime!.weaponMode = "ranged";
    player.classRuntime!.weaponDefinitionId = "starter_bow";
    player.classRuntime!.weaponCategory = "bow";
    engine.updatePlayerSkillState("player", snapshot("player", { archery: 2 }, null, 0, 2));
    expect(player.attackRangeM).toBe(322);
    expect(internals(engine).v3StaticAttackBonus(player)).toBe(3);
    engine.updatePlayerSkillState("player", snapshot("player", { archery: 3 }, null, 0, 3));
    expect(player.attackRangeM).toBe(345);
    player.classRuntime!.weaponDefinitionId = "starter_sword";
    player.classRuntime!.weaponCategory = "sword";
    expect(internals(engine).v3StaticAttackBonus(player)).toBe(0);

    const dodgeEngine = createEngine();
    addPlayer(dodgeEngine, "player");
    addPlayer(dodgeEngine, "attacker", east(10));
    const dodgePlayer = internals(dodgeEngine).entities.get("player")!;
    const dodgeAttacker = internals(dodgeEngine).entities.get("attacker")!;
    for (const [rank, chance] of [[1, 0], [2, 0.14], [3, 0.28]] as const) {
      applySkills(dodgeEngine, "player", { martial_arts: rank }, null, null);
      dodgePlayer.classRuntime!.chestDefinitionId = "padded_tunic";
      expect(internals(dodgeEngine).v3DodgeChance(dodgePlayer, dodgeAttacker)).toBeCloseTo(chance);
    }
    dodgePlayer.classRuntime!.chestDefinitionId = null;
    expect(internals(dodgeEngine).v3DodgeChance(dodgePlayer, dodgeAttacker)).toBe(0);
    dodgePlayer.classRuntime!.chestDefinitionId = "padded_tunic";
    dodgePlayer.classRuntime!.hasShield = true;
    expect(internals(dodgeEngine).v3DodgeChance(dodgePlayer, dodgeAttacker)).toBe(0);

  });

  it("applies additive armor and shield movement penalties", () => {
    const engine = createEngine({ playerMovementSpeedMps: 40 });
    addPlayer(engine, "target");
    const target = internals(engine).entities.get("target")!;

    applySkills(engine, "target", {}, null, null);
    target.classRuntime!.chestDefinitionId = "padded_tunic";
    expect(engine.playerMovementMultiplier("target")).toBeCloseTo(1);
    target.classRuntime!.chestDefinitionId = "leather_armor";
    expect(engine.playerMovementMultiplier("target")).toBeCloseTo(0.95);
    target.classRuntime!.chestDefinitionId = "breast_plate";
    expect(engine.playerMovementMultiplier("target")).toBeCloseTo(0.90);
    target.classRuntime!.hasShield = true;
    expect(engine.playerMovementMultiplier("target")).toBeCloseTo(0.85);
    target.classRuntime!.chestDefinitionId = "chain_armor";
    expect(engine.playerMovementMultiplier("target")).toBeCloseTo(0.85);

  });

});

type RuntimeEffect = ReturnType<typeof effect>;
type Runtime = {
  skillV3: { activeSpecializationId: SpecializationId | null; specializationRank: number; ultimateId: string | null } | null;
  learned: Set<string>;
  generalSkillRanks?: never;
  weaponDefinitionId: string | null;
  weaponCategory: string | null;
  weaponMode: "melee" | "ranged" | "support" | null;
  chestDefinitionId: string | null;
  heavyArmorPieces: number;
  hasShield: boolean;
  cooldownEndsAt: Record<string, number>;
  counters: Record<string, number | string | boolean>;
  effects: RuntimeEffect[];
};
type Entity = {
  special?: { stunUntilTick: number };
  entityId: string;
  targetEntityId?: string | null;
  kind: "player" | "mob";
  archetypeKey: string | null;
  maxHealth: number;
  attackRangeM: number;
  level: number;
  currentHealth: number;
  attackDamage: number;
  defense: number;
  position: LatLon;
  lifeState: string;
  aggressiveUntilMs: number;
  classRuntime: Runtime | null;
  equipmentCombatState?: EquipmentEnhancementContext | null;
};

type EquipmentEnhancementContext = {
  activeWeaponEnchantmentIdentity: string | null;
  armorEnchantmentIdentities: Record<"head" | "chest" | "gloves" | "boots", string | null>;
};

function internals(engine: CombatEngine) {
  return engine as unknown as {
    entities: Map<string, Entity>;
    resolveBasicAttack(attacker: Entity, target: Entity): number;
    applyV3Blight(source: Entity, target: Entity, rank: number, spread: boolean): boolean;
    spreadV3BlightOnContact(left: Entity, right: Entity): void;
    applyDamage(
      attacker: Entity,
      target: Entity,
      damage: number,
      sourceTechniqueId: string,
      direct: boolean,
      defenseMitigation: Record<string, never>,
      defense: number,
      reactiveArmorHit: boolean,
      attackKind: "targeted" | "area",
      attackContext?: { fixedFinalDamage?: number }
    ): number;
    onEnemyDefeated(attacker: Entity, defeated: Entity, bleeding: boolean, sourceTechniqueId: string): void;
    applyHealing(
      source: Entity,
      target: Entity,
      requested: number,
      sourceTechniqueId: string,
      options: { direct?: boolean; healingOverTime?: boolean }
    ): { effective: number; overheal: number };
    applyWard(source: Entity, target: Entity, sourceTechniqueId: string, amount: number): void;
    v3DodgeChance(target: Entity, attacker: Entity): number;
    v3ContextualAttackBonus(attacker: Entity): number;
    v3AggressionDurationMs(player: Entity): number;
    v3ClassDefenseBonuses(target: Entity, attacker: Entity): { body: number; shield: number };
    addTimedEffect(source: Entity, target: Entity, kind: string, id: string, durationMs: number, amount: number): void;
    v3StaticAttackBonus(attacker: Entity): number;
    warriorFlatAttackBonus(attacker: Entity, basicAttack: boolean, target?: Entity): number;
    deepstoneCaveBonus(player: Entity, stat: "attack" | "defense"): number;
    rollMonkStun(attacker: Entity, target: Entity, appliedDamage: number): void;
    currentTick: number;
    v3PveContextualAttackBonus(attacker: Entity, target?: Entity): number;
    isPlayerOwnedCreature(entity: Entity): boolean;
    v3MercenaryMomentumAttackBonus(attacker: Entity, target?: Entity): number;
    v3AssassinSurpriseMultiplier(attacker: Entity, target: Entity, qualifyingAttack: boolean): number;
    v3MonkSlowAura(target: Entity): number;
    v3BalsamResinTickIntervalMs(player: Entity, now?: number): number;
  };
}

function equipmentEnhancementContext(
  activeWeaponEnchantmentIdentity: string | null,
  chest: string | null = null
): EquipmentEnhancementContext {
  return {
    activeWeaponEnchantmentIdentity,
    armorEnchantmentIdentities: { head: null, chest, gloves: null, boots: null }
  };
}

function createEngine(overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  return new CombatEngine({ tickRateHz: 20, isPlayerAuthorityActive: () => true, ...overrides });
}

function addPlayer(
  engine: CombatEngine,
  playerId: string,
  position = origin,
  damage = 10,
  currentHealth = 100
): void {
  engine.connectPlayer({
    playerId, name: playerId, regionCode: "NM", zoneId: "world:NM", position,
    accountId: `account-${playerId}`, connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth: 100, currentHealth, baseAttackDamage: damage }
  });
}

function applySkills(
  engine: CombatEngine,
  playerId: string,
  ranks: Partial<Record<GeneralSkillId, number>>,
  weaponDefinitionId: string | null,
  weaponCategory: string | null,
  specializationId: SpecializationId | null = null,
  specializationRank = 0,
  // The ranked classes are hidden on the launch roster (Ronin, Warrior); these tests keep their effects reachable.
  fullClassRosterEnabled = true
): void {
  engine.updatePlayerSkillState(
    playerId,
    snapshot(playerId, ranks, specializationId, specializationRank, 1, false, fullClassRosterEnabled)
  );
  const runtime = internals(engine).entities.get(playerId)!.classRuntime!;
  runtime.weaponDefinitionId = weaponDefinitionId;
  runtime.weaponCategory = weaponCategory;
}

function snapshot(
  playerId: string,
  ranks: Partial<Record<GeneralSkillId, number>>,
  specializationId: SpecializationId | null,
  specializationRank: number,
  revision = 1,
  masteryQuestCompleted = false,
  fullClassRosterEnabled = true,
  equippedClassTechniqueId: SkillSystemV3Snapshot["equippedClassTechniqueId"] = null
): SkillSystemV3Snapshot {
  return {
    fullClassRosterEnabled,
    ultimatesEnabled: false,
    fullBuildRespecAvailable: false,
    playerId,
    characterLevel: 25,
    pointState: { totalEarned: 25, totalSpent: 0, available: 25, revision },
    generalSkills: Object.entries(ranks).map(([skillId, rank]) => ({
      skillId: skillId as GeneralSkillId, rank: rank!, pointsSpent: 0
    })),
    specializations: specializationId
      ? [{ specializationId, rank: specializationRank, pointsSpent: 0, grandfathered: false, masteryQuestCompleted }]
      : [],
    committedSpecializationId: specializationId,
    activeSpecializationId: specializationId,
    equippedClassTechniqueId,
    generalActiveLoadout: [null, null],
    ultimate: null,
    cooldownEndsAt: {},
    worldKnowledge: [],
    serverTime: Date.now(),
    revision
  };
}

function mob(
  engine: CombatEngine,
  entityId: string,
  position: LatLon,
  archetype: "wolf" | "xoral" = "wolf"
): Entity {
  // Restore the pre-matrix health pools (level-5 Wolf 45, Xoral 17,500) these fixtures assume.
  engine.spawnMob({
    entityId, archetype, position, regionCode: "NM", zoneId: "world:NM",
    maxHealthMultiplier: archetype === "wolf" ? 45 / 24 : 17_500 / 5_000
  });
  return internals(engine).entities.get(entityId)!;
}

function effect(id: string, kind: string, sourceTechniqueId: string, amount: number) {
  return {
    id, kind, sourceTechniqueId, sourceEntityId: "player", startTick: 0,
    endTick: Number.MAX_SAFE_INTEGER, nextTick: Number.MAX_SAFE_INTEGER,
    stacks: 1, maximumStacks: 1, amount
  };
}

function east(distanceM: number): LatLon {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, distanceM);
}

describe("Skill System V3 eight-class roster rank effects", () => {
  const ranks = [1, 2, 3, 4, 5] as const;
  const tier = (rank: number) => (rank >= 5 ? 4 : rank >= 3 ? 2 : rank >= 1 ? 1 : 0);

  function setup(clock = { now: 1_000_000 }) {
    const engine = createEngine({ playerMovementSpeedMps: 40, now: () => clock.now });
    addPlayer(engine, "me");
    addPlayer(engine, "foe", east(50));
    return { engine, me: internals(engine).entities.get("me")!, foe: internals(engine).entities.get("foe")!, clock };
  }
  const withWeapon = (entity: Entity, definitionId: string, category: string) => {
    entity.classRuntime!.weaponDefinitionId = definitionId;
    entity.classRuntime!.weaponCategory = category;
  };

  it("applies Militia (sentinel) Crossbow Attack, ranged Breastplate Defense, anti-Dodge, and Breastplate speed at ranks 1-5", () => {
    const { engine, me, foe } = setup();
    for (const rank of ranks) {
      applySkills(engine, "me", {}, "training_crossbow", "crossbow", "sentinel", rank);
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(tier(rank));
      withWeapon(me, "starter_sword", "sword");
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(0);

      applySkills(engine, "foe", {}, null, null, "sentinel", rank);
      foe.classRuntime!.chestDefinitionId = "breast_plate";
      withWeapon(me, "training_crossbow", "crossbow");
      expect(internals(engine).v3ClassDefenseBonuses(foe, me).body).toBe(rank >= 5 ? 4 : rank >= 4 ? 3 : rank >= 2 ? 2 : 0);
      withWeapon(me, "starter_sword", "sword");
      expect(internals(engine).v3ClassDefenseBonuses(foe, me).body).toBe(0);
      expect(engine.playerMovementMultiplier("foe")).toBeCloseTo(1 - 0.10 * (1 - (rank >= 5 ? 0.60 : rank >= 4 ? 0.40 : rank >= 2 ? 0.20 : 0)));
    }
    // Attacks reduce target Dodge: 10 points at rank 3-4, 25 at rank 5.
    applySkills(engine, "foe", { martial_arts: 3 }, null, null);
    foe.classRuntime!.chestDefinitionId = "padded_tunic";
    for (const [rank, antiDodge] of [[1, 0], [2, 0], [3, 0.09], [4, 0.09], [5, 0.22]] as const) {
      applySkills(engine, "me", {}, "training_crossbow", "crossbow", "sentinel", rank);
      expect(internals(engine).v3DodgeChance(foe, me)).toBeCloseTo(0.28 - antiDodge);
    }
  });

  it("applies Monk Staff/Sling Attack, Tunic Defense, Sling Dodge, slow aura, and Giving Berry cadence at ranks 1-5", () => {
    const { engine, me, foe } = setup();
    for (const rank of ranks) {
      applySkills(engine, "me", {}, "training_sling", "sling", "monk", rank);
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(tier(rank));
      withWeapon(me, "starter_staff", "staff");
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(tier(rank));
      withWeapon(me, "starter_sword", "sword");
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(0);

      applySkills(engine, "foe", {}, null, null, "monk", rank);
      foe.classRuntime!.chestDefinitionId = "padded_tunic";
      expect(internals(engine).v3ClassDefenseBonuses(foe, me).body).toBe(rank >= 5 ? 4 : rank >= 4 ? 3 : rank >= 2 ? 2 : 0);
      foe.classRuntime!.chestDefinitionId = "leather_armor";
      expect(internals(engine).v3ClassDefenseBonuses(foe, me).body).toBe(0);

      // Giving Berry cadence: 1.3x/1.6x/2x faster while nonaggressive, normal while aggressive.
      foe.aggressiveUntilMs = 0;
      const calm = internals(engine).v3BalsamResinTickIntervalMs(foe, 1_000);
      foe.aggressiveUntilMs = 2_000;
      const normal = internals(engine).v3BalsamResinTickIntervalMs(foe, 1_000);
      expect(calm).toBe(Math.round(normal / (rank >= 5 ? 2 : rank >= 3 ? 1.6 : 1.3)));
    }
    // Sling grants Dodge only for the Monk (needs Martial Arts and a Tunic, no Shield).
    applySkills(engine, "foe", { martial_arts: 3 }, "training_sling", "sling", "monk", 1);
    foe.classRuntime!.chestDefinitionId = "padded_tunic";
    expect(internals(engine).v3DodgeChance(foe, me)).toBeCloseTo(0.28);
    applySkills(engine, "foe", { martial_arts: 3 }, "training_sling", "sling", "legionnaire", 1);
    foe.classRuntime!.chestDefinitionId = "padded_tunic";
    expect(internals(engine).v3DodgeChance(foe, me)).toBe(0);
    // Hostile movement slow aura within 180m: none at rank 1, then flat base Speed -8 / -16 / -26.
    for (const [rank, slow] of [[1, 0], [2, 8], [3, 8], [4, 16], [5, 26]] as const) {
      applySkills(engine, "me", {}, null, null, "monk", rank);
      expect(internals(engine).v3MonkSlowAura(foe)).toBeCloseTo(slow);
    }
  });

  it("applies Mercenary Spear/Crossbow Attack, Leather Defense, and sustained PvP Spear Attack at ranks 1-5", () => {
    const { engine, me, foe, clock } = setup();
    const spearAttacker = { ...me, classRuntime: { ...me.classRuntime!, weaponDefinitionId: "training_spear" } } as Entity;
    const crossbowAttacker = { ...me, classRuntime: { ...me.classRuntime!, weaponDefinitionId: "training_crossbow" } } as Entity;
    for (const rank of ranks) {
      applySkills(engine, "me", {}, "training_spear", "spear", "mercenary", rank);
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(rank >= 5 ? 3 : rank >= 4 ? 2 : 1);
      withWeapon(me, "training_crossbow", "crossbow");
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(rank >= 5 ? 3 : rank >= 3 ? 1 : 0);
      withWeapon(me, "starter_sword", "sword");
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(0);

      applySkills(engine, "foe", {}, null, null, "mercenary", rank);
      foe.classRuntime!.chestDefinitionId = "leather_armor";
      expect(internals(engine).v3ClassDefenseBonuses(foe, spearAttacker).body).toBe(rank >= 5 ? 2 : rank >= 3 ? 1 : 0);
      expect(internals(engine).v3ClassDefenseBonuses(foe, crossbowAttacker).body).toBe(rank >= 3 ? 1 : 0);
      foe.classRuntime!.hasShield = true;
      expect(internals(engine).v3ClassDefenseBonuses(foe, spearAttacker).body).toBe(0);
      foe.classRuntime!.hasShield = false;
    }
    // Sustained same-player hits: +1 Spear Attack per 90s, capped +2/+3/+4/+6; players only.
    for (const [rank, cap] of [[1, 2], [2, 2], [3, 3], [4, 4], [5, 6]] as const) {
      applySkills(engine, "me", {}, "training_spear", "spear", "mercenary", rank);
      me.classRuntime!.counters.skillV3MercenaryMomentumTarget = "foe";
      me.classRuntime!.counters.skillV3MercenaryMomentumStartedAt = clock.now - 6 * 90_000;
      me.classRuntime!.counters.skillV3MercenaryMomentumLastHitAt = clock.now - 1_000;
      expect(internals(engine).v3MercenaryMomentumAttackBonus(me, foe)).toBe(cap);
    }
    me.classRuntime!.counters.skillV3MercenaryMomentumLastHitAt = clock.now - 301_000;
    expect(internals(engine).v3MercenaryMomentumAttackBonus(me, foe)).toBe(0);
  });

  it("still applies Warrior, Ranger, Knight, Ninja, and Druid rank effects after the roster change", () => {
    const { engine, me, foe } = setup();
    for (const rank of ranks) {
      applySkills(engine, "me", {}, "training_axe", "axe", "warrior", rank);
      expect(me.maxHealth).toBe(100 + rank * 9);
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(tier(rank));
      applySkills(engine, "me", {}, "starter_bow", "bow", "ranger", rank);
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(tier(rank));
      expect(engine.playerMovementMultiplier("me")).toBeCloseTo(rank >= 5 ? 1.225 : rank >= 2 ? 1.1 : 1);
      applySkills(engine, "me", {}, "starter_sword", "sword", "knight", rank);
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(tier(rank));
      applySkills(engine, "foe", {}, null, null, "knight", rank);
      foe.classRuntime!.chestDefinitionId = "breast_plate";
      expect(internals(engine).v3ClassDefenseBonuses(foe, me).body).toBe(rank >= 5 ? 3 : rank >= 4 ? 2 : rank >= 2 ? 1 : 0);
      applySkills(engine, "me", {}, "starter_shuriken", "shuriken", "ninja", rank);
      expect(internals(engine).v3StaticAttackBonus(me)).toBe(tier(rank));
      expect(engine.playerMovementMultiplier("me")).toBeCloseTo(1 + (rank >= 5 ? 27 : rank >= 4 ? 18 : rank >= 2 ? 9 : 0) / 40);
    }
    applySkills(engine, "foe", {}, null, null, "druid", 5);
    expect(internals(engine).v3DodgeChance(foe, me)).toBeCloseTo(0.27);
  });
});

describe("Skill System V3 class technique boundary", () => {
  it("rejects retained custom class techniques without applying effects or cooldowns", () => {
    const engine = createEngine();
    addPlayer(engine, "warrior");
    engine.updatePlayerSkillState("warrior", snapshot("warrior", {}, "warrior", 3, 1, false, false));
    const runtime = internals(engine).entities.get("warrior")!.classRuntime!;
    expect(() => engine.useNormalAbility({
      playerId: "warrior", abilityId: "v3_warrior_is_that_it",
      accountId: "account-warrior", connectionId: "connection-warrior"
    })).toThrow(expect.objectContaining({ code: "CLASS_TECHNIQUES_DISABLED" }));
    expect(runtime.effects).toEqual([]);
    expect(runtime.cooldownEndsAt.v3_warrior_is_that_it).toBeUndefined();
  });
});

describe("Deepstone Lore cave bonus", () => {
  it("adds +2 Attack at rank 2 and +2 Defense at rank 3 only within 140 m of a cave, against players and monsters", () => {
    let rank = 0;
    let near = true;
    const radii: number[] = [];
    const engine = createEngine({
      deepstoneRank: () => rank,
      isNearCave: (_position, radiusM) => { radii.push(radiusM); return near; }
    });
    addPlayer(engine, "me");
    addPlayer(engine, "foe", east(50));
    applySkills(engine, "me", {}, "starter_sword", "sword");
    const me = internals(engine).entities.get("me")!;
    const foe = internals(engine).entities.get("foe")!;
    const wild = mob(engine, "wild", east(10));
    const attack = (target: Entity) => internals(engine).warriorFlatAttackBonus(me, true, target);
    const defense = () => internals(engine).deepstoneCaveBonus(me, "defense");
    const baseline = attack(foe);
    for (const [r, atk, def] of [[0, 0, 0], [1, 0, 0], [2, 2, 0], [3, 2, 2]] as const) {
      rank = r;
      expect(attack(foe) - baseline).toBe(atk);
      expect(attack(wild) - baseline).toBe(atk);
      expect(defense()).toBe(def);
    }
    expect(new Set(radii)).toEqual(new Set([140]));
    near = false;
    expect(attack(foe) - baseline).toBe(0);
    expect(defense()).toBe(0);
  });
});

describe("Monk Staff/Sling stun", () => {
  it("stuns on a Staff/Sling hit at 4% (ranks 2-3) and 7% (ranks 4-5), then grants 10 s of stun immunity", () => {
    let roll = 0.04;
    const engine = createEngine({ random: () => roll, playerMovementSpeedMps: 40 });
    addPlayer(engine, "me");
    addPlayer(engine, "foe", east(5));
    const wild = mob(engine, "wild", east(8));
    const api = internals(engine);
    const me = api.entities.get("me")!;
    const foe = api.entities.get("foe")!;
    const stunned = (entity: Entity) => entity.classRuntime?.effects.some((e) => e.kind === "stunned" && e.endTick >= api.currentTick) === true;
    const reset = () => {
      for (const entity of [foe, wild]) {
        if (entity.classRuntime) entity.classRuntime.effects = entity.classRuntime.effects.filter((e) => !e.kind.startsWith("stun") && e.kind !== "rooted");
      }
      if (wild.special) wild.special.stunUntilTick = 0;
    };
    const cases = [[2, "sling", false], [3, "staff", false], [4, "sling", true], [5, "staff", true], [4, "sword", false]] as const;
    for (const [rank, weapon, expected] of cases) {
      applySkills(engine, "me", {}, weapon === "sword" ? "starter_sword" : `training_${weapon}`, weapon, "monk", rank);
      api.rollMonkStun(me, foe, 5);
      expect(stunned(foe)).toBe(expected);
      reset();
    }
    // Rank 1 and a miss roll never stun; a hit that did no damage never stuns.
    applySkills(engine, "me", {}, "training_sling", "sling", "monk", 1);
    roll = 0;
    api.rollMonkStun(me, foe, 5);
    expect(stunned(foe)).toBe(false);
    applySkills(engine, "me", {}, "training_sling", "sling", "monk", 5);
    api.rollMonkStun(me, foe, 0);
    expect(stunned(foe)).toBe(false);

    // A stunned player is held in place and cannot attack; a stunned mob is rooted and cannot deal damage.
    api.rollMonkStun(me, foe, 5);
    api.rollMonkStun(me, wild, 5);
    expect(engine.isPlayerImmobilized("foe")).toBe(true);
    expect(() => engine.startAttack({
      attackerId: "foe", targetEntityId: "me", requestId: "r1", accountId: "account-foe", connectionId: "connection-foe"
    })).toThrowError(expect.objectContaining({ code: "PLAYER_STUNNED" }));
    expect(stunned(wild)).toBe(true);
    expect(wild.special!.stunUntilTick).toBeGreaterThan(api.currentTick);
    expect(wild.classRuntime!.effects.some((e) => e.kind === "rooted")).toBe(true);

    // Not re-stunnable while stunned or during the 10 s of immunity that follow; free again after 15 s total.
    const firstEnd = foe.classRuntime!.effects.find((e) => e.kind === "stunned")!.endTick;
    api.currentTick = firstEnd + 1;
    expect(stunned(foe)).toBe(false);
    expect(engine.isPlayerImmobilized("foe")).toBe(false);
    api.rollMonkStun(me, foe, 5);
    expect(stunned(foe)).toBe(false);
    api.currentTick = foe.classRuntime!.effects.find((e) => e.kind === "stun_immunity")!.endTick + 1;
    api.rollMonkStun(me, foe, 5);
    expect(stunned(foe)).toBe(true);
    const immunity = foe.classRuntime!.effects.find((e) => e.kind === "stun_immunity")!;
    expect((immunity.endTick - immunity.startTick) / 20).toBe(15);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  BALSAM_RESIN_EFFECT_DURATION_MS,
  BALSAM_RESIN_TICK_INTERVAL_MS,
  BASIC_ATTACK_INTERVAL_MS,
  BASIC_ATTACK_RANGE_M,
  CREATURE_BOOK_ROSTER,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  PVE_AGGRO_ABANDON_TIMEOUT_MS,
  PLAYER_RESPAWN_DELAY_MS,
  destinationPoint,
  distanceMeters,
  millisecondsToTicks,
  MELEE_ATTACK_RANGE_M,
  moveToward,
  planMilitaryGroupAttack,
  RANGED_ATTACK_RANGE_M,
  type LatLon
} from "@ash-atlas/shared";
import { PvpTimerService } from "../pvpTimers.js";
import { CombatEngine, CombatRequestError } from "./combatEngine.js";
import {
  COMBAT_ITEM_REWARD_POLICY_VERSION,
  MOB_DEFINITIONS,
  resolveMobCombatProfile
} from "./mobDefinitions.js";
import {
  packageIdForPosition,
  zoneIdForPosition
} from "../spatialZones.js";

const origin = { lat: 35.0844, lon: -106.6504 };

describe("CombatEngine cadence and authority", () => {
  it("grants 4 minutes of jump protection that ends when the player moves", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const engine = createEngine();
      addPlayer(engine, "p1", origin, 100);
      expect(engine.grantFlagArrivalProtection("p1", 1)).toBe(100_000 + 4 * 60_000);
      // Standing still (a resync at the same spot) keeps it.
      engine.syncPlayer({ playerId: "p1", position: { ...origin }, regionCode: "NM", zoneId: "world:NM" });
      expect(engine.flagArrivalProtectionUntil("p1")).toBe(100_000 + 4 * 60_000);
      // Any movement ends it at once.
      engine.syncPlayer({ playerId: "p1", position: east(5), regionCode: "NM", zoneId: "world:NM" });
      expect(engine.flagArrivalProtectionUntil("p1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawns every mob with the normal appearance", () => {
    const spawned = createEngine().spawnMob({
      entityId: "mob:test:40097", archetype: "deer", position: origin,
      regionCode: "NM", zoneId: "world:NM"
    });
    expect(spawned).toMatchObject({ appearanceVariant: "normal", name: "Deer" });
  });

  it("spawns every mob unscaled, ignoring a legacy Ashen override", () => {
    const engine = createEngine();
    const normal = engine.spawnMob({
      entityId: "mob:test:0", archetype: "deer", appearanceVariant: "normal",
      position: origin, regionCode: "NM", zoneId: "world:NM",
      maxHealthMultiplier: 1.5
    });
    const ashen = engine.spawnMob({
      entityId: "mob:test:40097", archetype: "deer", appearanceVariant: "ashen",
      position: east(10), regionCode: "NM", zoneId: "world:NM",
      maxHealthMultiplier: 1.5
    });
    const companion = engine.spawnMob({
      entityId: "mob:test:companion", archetype: "deer", position: east(20),
      regionCode: "NM", zoneId: "world:NM",
      companion: {
        ownerPlayerId: "player", dogId: "dog", name: "Doe", species: "trail_hound",
        baseMaxHealth: 10, maxHealth: 10, currentHealth: 7, damage: 3
      }
    });
    const systemActor = engine.spawnMob({
      entityId: "mob:test:system", archetype: "deer", position: east(30),
      regionCode: "NM", zoneId: "world:NM",
      npcFaction: {
        cityId: "city", cityName: "Goblin Village", culture: "goblin",
        role: "basic", presentationKey: "goblin_basic", invulnerable: true
      }
    });
    const internals = engine as unknown as {
      entities: Map<string, { attackDamage: number }>;
    };

    expect(normal).toMatchObject({
      appearanceVariant: "normal", maxHealth: 27, currentHealth: 27
    });
    expect(internals.entities.get(normal.entityId)?.attackDamage).toBe(12);
    expect(ashen).toMatchObject({
      appearanceVariant: "normal", name: "Deer", maxHealth: 27, currentHealth: 27
    });
    expect(internals.entities.get(ashen.entityId)?.attackDamage).toBe(12);
    expect(companion).toMatchObject({
      appearanceVariant: "normal", maxHealth: 10, currentHealth: 7
    });
    expect(internals.entities.get(companion.entityId)?.attackDamage).toBe(3);
    expect(systemActor).toMatchObject({ appearanceVariant: "normal", maxHealth: 18 });
    expect(internals.entities.get(systemActor.entityId)?.attackDamage).toBe(12);
  });

  it.each([
    // Wolf Bite (Dagger) into bare skin (defends at level 1): 9.5 + level - 1.
    // Health is three neutral hits (9) = 27.
    [0, "normal", 9, 27],
    [5, "normal", 14, 27],
    [25, "normal", 34, 27],
    [5, "ashen", 14, 27]
  ] as const)("lands resolved level %i %s Wolf damage", (level, appearanceVariant, damage, maxHealth) => {
    const engine = createEngine({ canMobProactivelyAcquire: () => true });
    addPlayer(engine, "p1", origin);
    const wolf = engine.spawnMob({
      entityId: "wolf:balance", archetype: "wolf", combatProfile: resolveMobCombatProfile("wolf", level), appearanceVariant,
      worldAi: true, position: east(1), regionCode: "NM", zoneId: "world:NM"
    });
    expect(wolf.maxHealth).toBe(maxHealth);
    for (let tick = 0; tick < 77; tick += 1) engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(100 - damage);
  });

  it("hits a naked player for table + (mob level - 1) and scales boss hits", () => {
    const firstHitOn = (archetype: "hog" | "fire_bird", level: number) => {
      const engine = createEngine();
      addPlayer(engine, "p1", origin);
      const mob = engine.spawnMob({
        entityId: "mob:test:0", archetype, combatProfile: resolveMobCombatProfile(archetype, level),
        position: east(10), regionCode: "NM", zoneId: "world:NM"
      });
      engine.startAttack(request("p1", mob.entityId, `matrix-${archetype}`));
      for (let tick = 0; tick < 200; tick += 1) {
        engine.tick();
        const hit = engine.beginDeltaFlush().events.find((event) =>
          event.type === "DAMAGE" && event.sourceEntityId === mob.entityId &&
          event.targetEntityId === "p1" && (event.amount ?? 0) > 0);
        if (hit) return hit.amount;
      }
      return null;
    };
    // Spear into Unarmored (11) at level 10 against bare skin's level 1. (A
    // wolf would howl when wounded and hit harder, so the hog keeps it plain.)
    expect(firstHitOn("hog", 10)).toBe(11 + 10 - 1);
    // Spear into Unarmored (11) at level 25, x1.5 for the Fire Bird boss.
    expect(firstHitOn("fire_bird", 25)).toBe(Math.round((11 + 25 - 1) * 1.5));
  });

  it("keeps special mobs and system actors normal even when asked for Ashen", () => {
    const engine = createEngine();
    expect(engine.spawnMob({
      archetype: "xoral", appearanceVariant: "ashen", position: origin,
      regionCode: "NM", zoneId: "world:NM"
    })).toMatchObject({ appearanceVariant: "normal", name: "The Xoral" });
    expect(engine.spawnMob({
      archetype: "goblin", appearanceVariant: "ashen", position: east(10),
      regionCode: "NM", zoneId: "world:NM"
    })).toMatchObject({ appearanceVariant: "normal", name: "Goblin" });
    expect(engine.spawnMob({
      archetype: "deer", appearanceVariant: "ashen", position: east(30),
      regionCode: "NM", zoneId: "world:NM",
      companion: { ownerPlayerId: "p", dogId: "d", name: "Doe", species: "trail_hound", baseMaxHealth: 10, maxHealth: 10, currentHealth: 10, damage: 1 }
    })).toMatchObject({ appearanceVariant: "normal", name: "Doe" });
  });
  it("starts, refreshes, expires, and preserves the authoritative Aggressive deadline", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const engine = createEngine();
      addPlayer(engine, "p1", origin);
      addPlayer(engine, "p2", east(10));
      engine.startAttack(request("p1", "p2", "aggressive-first"));
      engine.tick();
      expect(engine.aggressiveUntil("p1")).toBe(110_000);
      expect(engine.isPlayerAggressive("p1")).toBe(true);
      expect(engine.isPlayerAggressive("p2")).toBe(false);

      vi.setSystemTime(new Date(105_500));
      for (let index = 0; index < 32; index += 1) engine.tick();
      expect(engine.aggressiveUntil("p1")).toBe(115_500);
      expect(engine.aggressionRemainingMs("p1")).toBe(10_000);

      expect(engine.rotatePlayerAuthority("p1", "account-p1", "replacement")?.aggressiveUntil)
        .toBe(115_500);
      const remoteView = engine.snapshotForPlayer("p2").upserts.find((entry) => entry.entityId === "p1");
      expect(remoteView).not.toHaveProperty("aggressiveUntil");
      vi.setSystemTime(new Date(115_500));
      expect(engine.isPlayerAggressive("p1")).toBe(false);
      expect(engine.aggressiveUntil("p1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not tag a player when final applied damage is zero", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(10));
    const internal = engine as unknown as { entities: Map<string, { currentHealth: number }> };
    internal.entities.get("p2")!.currentHealth = 0;
    engine.startAttack(request("p1", "p2", "zero-applied"));
    engine.tick();
    expect(engine.isPlayerAggressive("p1")).toBe(false);
  });

  it("does not force a defending player to retaliate or become Aggressive", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(10));
    engine.startAttack(request("p1", "p2", "one"));

    engine.tick();
    expect(engine.entity("p2")?.currentHealth).toBeLessThan(100);
    expect(engine.entity("p1")?.currentHealth).toBe(100);
    for (let tick = 2; tick <= 40; tick += 1) {
      engine.tick();
    }
    expect(engine.entity("p1")?.currentHealth).toBe(100);
    expect(engine.entity("p2")?.targetEntityId).toBeNull();
    expect(engine.isPlayerAggressive("p2")).toBe(false);
    expect(engine.isPlayerAggressive("p1")).toBe(true);
    expect(millisecondsToTicks(BASIC_ATTACK_INTERVAL_MS, 20)).toBe(BASIC_ATTACK_INTERVAL_MS * 20 / 1_000);
  });

  it("lets an authorized shared boss chase, attack, and root without player-started aggro", () => {
    const stopPlayer = vi.fn();
    const bossEntityId = "xoral:test-event";
    const engine = createEngine({
      isSharedMobCombat: (entityId) => entityId === bossEntityId,
      isMobPlayerAttackAuthorized: (entityId, playerId) =>
        entityId === bossEntityId && playerId === "p1",
      stopPlayer
    });
    addPlayer(engine, "p1", east(400));
    const boss = engine.spawnMob({
      entityId: bossEntityId,
      archetype: "xoral",
      position: origin,
      homePosition: origin,
      regionCode: "NM",
      zoneId: "world:NM",
      worldAi: false,
      bossEventState: "active"
    });

    expect(engine.directMobTarget(boss.entityId, "p1")).toBe(true);
    expect(engine.applyScriptedRoot(boss.entityId, "p1", 3_000)).toBe(true);
    expect(stopPlayer).toHaveBeenCalledWith("p1");
    expect(engine.entity("p1")?.targetEntityId).toBeNull();
    expect(engine.entity("p1")?.controlEffects).toEqual([
      expect.objectContaining({ kind: "rooted", endsAt: expect.any(Number) })
    ]);
    expect(engine.entity(boss.entityId)?.attackRangeM).toBe(250);

    const startingDistance = distanceMeters(
      { lat: boss.lat, lon: boss.lon },
      { lat: engine.entity("p1")!.lat, lon: engine.entity("p1")!.lon }
    );
    // Stop at the first landed hit: the x2 Xoral axe would otherwise defeat
    // the unarmored player before the assertions.
    for (let tick = 0; tick < 140 && (engine.entity("p1")?.currentHealth ?? 100) >= 100; tick += 1) {
      engine.tick();
    }

    const movedBoss = engine.entity(boss.entityId)!;
    expect(distanceMeters(
      { lat: movedBoss.lat, lon: movedBoss.lon },
      { lat: engine.entity("p1")!.lat, lon: engine.entity("p1")!.lon }
    )).toBeLessThan(startingDistance);
    expect(movedBoss.targetEntityId).toBe("p1");
    expect(engine.entity("p1")?.currentHealth).toBeLessThan(100);
    expect(engine.entity("p1")?.targetEntityId).toBeNull();
  });

  it("applies the Sick Sewer Rat poison chance on the authoritative enemy hit", () => {
    const runHit = (random: number) => {
      const engine = createEngine({ random: () => random });
      addPlayer(engine, "p1", origin);
      const rat = engine.spawnMob({
        entityId: `sick-rat:${random}`,
        archetype: "sick_sewer_rat",
        position: east(30),
        homePosition: east(30),
        regionCode: "NM",
        zoneId: "world:NM",
        worldAi: false
      });
      engine.startAttack(request("p1", rat.entityId, `sick-rat-hit:${random}`));
      for (let tick = 0; tick <= 24; tick += 1) engine.tick();
      return engine.entity("p1")?.harmfulStatusIds ?? [];
    };

    expect(runHit(0.49)).toContain("poison");
    expect(runHit(0.5)).not.toContain("poison");
  });

  it("keeps an event legendary bird pursuing past ordinary abandonment and the old leash", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const engine = createEngine({
        getAuthoritativeViewCircle: () => ({
          anchorType: "flag",
          anchorId: "legendary-bird-flag",
          center: origin,
          radiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
          generation: 1,
          eligibleRegionCodes: ["NM"],
          eligibleZoneIds: ["world:NM"]
        })
      });
      addPlayer(engine, "p1", origin, 100);
      const bird = engine.spawnMob({
        entityId: "fire-bird:pursuit-regression",
        archetype: "fire_bird",
        position: east(10),
        homePosition: origin,
        regionCode: "NM",
        zoneId: "world:NM",
        worldAi: false,
        originFlagId: "legendary-bird-flag"
      });
      const initialBirdHealth = engine.entity(bird.entityId)!.currentHealth;

      engine.startAttack(request("p1", bird.entityId, "landed-bird-hit"));
      engine.tick();
      expect(engine.entity(bird.entityId)?.currentHealth).toBeLessThan(initialBirdHealth);
      engine.cancelAttack("p1");
      syncPlayerPosition(engine, "p1", east(600));
      vi.advanceTimersByTime(PVE_AGGRO_ABANDON_TIMEOUT_MS);
      engine.tick();

      expect(engine.entity("p1")?.pveCombat?.pursuingEnemyIds).toContain(bird.entityId);
      expect(engine.entity(bird.entityId)?.targetEntityId).toBe("p1");

      for (let tick = 0; tick < 300; tick += 1) engine.tick();

      const pursued = engine.entity(bird.entityId)!;
      const distanceFromHome = distanceMeters(origin, { lat: pursued.lat, lon: pursued.lon });
      expect(distanceFromHome).toBeGreaterThan(260);
      expect(distanceFromHome).toBeLessThanOrEqual(DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M);
      expect(pursued.targetEntityId).toBe("p1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes bounded authoritative PvP damage and defeat observations", () => {
    const onCombatAnalyticsEvent = vi.fn();
    const engine = createEngine({ onCombatAnalyticsEvent });
    addPlayer(engine, "p1", origin, 100);
    addPlayer(engine, "p2", east(10), 10, 4);

    engine.startAttack(request("p1", "p2", "telemetry-pvp"));
    engine.tick();

    expect(onCombatAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "damage_applied",
        context: "pvp_open_world",
        actorId: "p1",
        targetId: "p2",
        damageApplied: 4,
        targetHealthAfter: 0
      })
    );
    expect(onCombatAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "defeat",
        context: "pvp_open_world",
        actorId: "p1",
        targetId: "p2"
      })
    );
  });

  it("keeps repeated and duplicate starts idempotent", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(10));
    engine.startAttack(request("p1", "p2", "same"));
    engine.startAttack(request("p1", "p2", "same"));
    engine.startAttack(request("p1", "p2", "other"));
    engine.tick();
    expect(engine.entity("p2")?.currentHealth).toBe(96);
  });

  it("counts active PvE and PvP encounter pairs separately for telemetry", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(10));
    addPlayer(engine, "p3", east(20));
    const wolf = engine.spawnMob({
      archetype: "wolf",
      position: east(25),
      regionCode: "NM",
      zoneId: "world:NM",
      packId: "pack:telemetry"
    });
    engine.startAttack(request("p1", "p2", "pvp"));
    engine.startAttack(request("p3", wolf.entityId, "pve"));

    expect(engine.telemetryEncounterSnapshot()).toEqual({
      activeCombatEncounters: 2,
      activePveEncounters: 1,
      activePvpEncounters: 1
    });
  });

  it("does not reset cooldown after cancel/restart or target switching", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(10));
    addPlayer(engine, "p3", east(12));
    engine.startAttack(request("p1", "p2", "first"));
    engine.tick();
    engine.cancelCombat("p1");
    engine.startAttack(request("p1", "p2", "restart"));
    engine.startAttack(request("p1", "p3", "switch"));
    for (let tick = 2; tick < 1 + millisecondsToTicks(BASIC_ATTACK_INTERVAL_MS, 20); tick += 1) {
      engine.tick();
    }
    expect(engine.entity("p2")?.currentHealth).toBe(96);
    expect(engine.entity("p3")?.currentHealth).toBe(100);
    engine.tick();
    expect(engine.entity("p3")?.currentHealth).toBe(96);
  });

  it("coalesces cancel/restart spam onto the existing due attack", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(10));
    engine.startAttack(request("p1", "p2", "initial"));
    engine.tick();
    for (let index = 0; index < 500; index += 1) {
      engine.cancelCombat("p1");
      engine.startAttack(request("p1", "p2", `restart-${index}`));
    }
    expect(engine.metricsSnapshot().scheduledWorkCount).toBeLessThanOrEqual(2);
    for (let tick = 2; tick <= 33; tick += 1) engine.tick();
    expect(engine.entity("p2")?.currentHealth).toBe(92);
  });

  it("invalidates a defeated actor's later same-tick attack deterministically", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 100);
    addPlayer(engine, "p2", east(10), 100, 4);
    engine.startAttack(request("p1", "p2", "p1-first"));
    engine.startAttack(request("p2", "p1", "p2-second"));
    engine.tick();
    expect(engine.entity("p2")?.lifeState).toBe("respawning");
    expect(engine.entity("p1")?.currentHealth).toBe(100);
  });

  it("walks toward an out-of-range player without an engine chase and resumes one cadence attack on reentry", () => {
    const movePlayerToward = vi.fn();
    const engine = createEngine({
      movePlayerToward
    });
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(100));
    engine.startAttack(request("p1", "p2", "chase"));
    engine.tick();
    expect(engine.entity("p2")?.currentHealth).toBe(100);
    engine.tick();
    // Walk-to-attack: the player is sent to weapon range (by player movement, not an engine chase).
    expect(movePlayerToward).toHaveBeenCalled();
    for (const [, destination] of movePlayerToward.mock.calls) {
      expect(distanceMeters(destination as LatLon, east(100))).toBeLessThanOrEqual(BASIC_ATTACK_RANGE_M);
    }
    expect(engine.metricsSnapshot().activeChases).toBe(0);
    expect(engine.entity("p1")?.targetEntityId).toBe("p2");
    engine.syncPlayer({
      playerId: "p1",
      position: east(70),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.tick();
    // Readiness is preserved while out of range, so reentry resolves the one
    // waiting attack immediately without banking additional missed attacks.
    expect(engine.entity("p2")?.currentHealth).toBe(96);
    const attackIntervalTicks = millisecondsToTicks(BASIC_ATTACK_INTERVAL_MS, 20);
    for (let tick = 0; tick < attackIntervalTicks - 1; tick += 1) engine.tick();
    expect(engine.entity("p2")?.currentHealth).toBe(96);
    engine.tick();
    expect(engine.entity("p2")?.currentHealth).toBe(92);
  });

  it("repairs one missing waiting-player attack schedule without another start command", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const wolf = engine.spawnMob({
      archetype: "wolf",
      position: east(100),
      regionCode: "NM",
      zoneId: "world:NM",
      packId: "pack:cadence-repair"
    });
    engine.startAttack(request("p1", wolf.entityId, "initial"));
    engine.tick();

    const internals = engine as unknown as {
      entities: Map<string, {
        scheduledAttackTick: number | null;
        attackScheduleGeneration: number;
      }>;
    };
    const player = internals.entities.get("p1")!;
    player.scheduledAttackTick = null;
    player.attackScheduleGeneration += 1;

    engine.tick();
    expect(player.scheduledAttackTick).not.toBeNull();
    const healthBeforeReentry = engine.entity(wolf.entityId)!.currentHealth;
    engine.syncPlayer({
      playerId: "p1",
      position: engine.entity(wolf.entityId)!,
      regionCode: "NM",
      zoneId: "world:NM"
    });
    for (
      let tick = 0;
      tick < 10 && engine.entity(wolf.entityId)!.currentHealth === healthBeforeReentry;
      tick += 1
    ) engine.tick();

    expect(engine.entity(wolf.entityId)!.currentHealth).toBeLessThan(healthBeforeReentry);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(wolf.entityId);
  });

  it("approaches a distant Wolf once on Attack without continuing player pursuit", () => {
    const movePlayerToward = vi.fn();
    const engine = createEngine({
      movePlayerToward
    });
    addPlayer(engine, "p1", origin);
    const wolf = engine.spawnMob({
      archetype: "wolf",
      position: east(200),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    engine.startAttack(request("p1", wolf.entityId, "moving-wolf"));
    expect(movePlayerToward).toHaveBeenCalledOnce();
    expect(movePlayerToward).toHaveBeenCalledWith(
      "p1",
      moveToward(wolf, origin, BASIC_ATTACK_RANGE_M - 0.1)
    );
    expect(engine.metricsSnapshot().activeChases).toBe(0);
    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      focusTargetEntityId: wolf.entityId,
      enemyQueue: [],
      pursuingEnemyIds: [] // Selecting a distant target has not provoked it.
    });
    engine.tick();
    expect(movePlayerToward).toHaveBeenCalledOnce();

    const movedWolfPosition = east(220);
    const internals = engine as unknown as {
      entities: Map<string, { position: LatLon }>;
      grid: { update(entityId: string, position: LatLon): void };
    };
    internals.entities.get(wolf.entityId)!.position = movedWolfPosition;
    internals.grid.update(wolf.entityId, movedWolfPosition);
    for (let tick = 0; tick < 8; tick += 1) engine.tick();

    expect(movePlayerToward).toHaveBeenCalledOnce();
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(wolf.entityId);
    expect(engine.metricsSnapshot().activeChases).toBe(0);

    engine.startAttack(request("p1", wolf.entityId, "moving-wolf-reclick"));
    expect(movePlayerToward).toHaveBeenCalledTimes(2);
    expect(movePlayerToward).toHaveBeenLastCalledWith(
      "p1",
      moveToward(movedWolfPosition, origin, BASIC_ATTACK_RANGE_M - 0.1)
    );
  });

  it("uses the player's current ranged attack distance for the initial approach", () => {
    const movePlayerToward = vi.fn();
    const engine = createEngine({ movePlayerToward });
    addPlayer(engine, "p1", origin);
    const internals = engine as unknown as {
      entities: Map<string, { attackRangeM: number }>;
    };
    internals.entities.get("p1")!.attackRangeM = RANGED_ATTACK_RANGE_M;
    const dummy = engine.spawnMob({
      archetype: "training_dummy",
      position: east(500),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    engine.startAttack(request("p1", dummy.entityId, "ranged-approach"));

    expect(movePlayerToward).toHaveBeenCalledOnce();
    expect(movePlayerToward).toHaveBeenCalledWith(
      "p1",
      moveToward(dummy, origin, RANGED_ATTACK_RANGE_M - 0.1)
    );
  });

  it("resolves melee hits across the doubled range and rejects damage just outside it", () => {
    const insideEngine = createEngine();
    addPlayer(insideEngine, "p1", origin);
    addPlayer(insideEngine, "inside", east(BASIC_ATTACK_RANGE_M - 0.5));
    insideEngine.startAttack(request("p1", "inside", "inside-range"));
    insideEngine.tick();
    expect(insideEngine.entity("inside")?.currentHealth).toBe(96);

    const oldBoundaryEngine = createEngine();
    addPlayer(oldBoundaryEngine, "p1", origin);
    addPlayer(oldBoundaryEngine, "between", east(30));
    oldBoundaryEngine.startAttack(request("p1", "between", "between-ranges"));
    oldBoundaryEngine.tick();
    expect(oldBoundaryEngine.entity("between")?.currentHealth).toBe(96);

    const outsideEngine = createEngine();
    addPlayer(outsideEngine, "p1", origin);
    addPlayer(outsideEngine, "outside", east(BASIC_ATTACK_RANGE_M + 0.5));
    outsideEngine.startAttack(request("p1", "outside", "outside-range"));
    outsideEngine.tick();
    expect(outsideEngine.entity("outside")?.currentHealth).toBe(100);
    expect(outsideEngine.metricsSnapshot().activeChases).toBe(0);
  });

  it("uses the same resolver for a non-retaliating dummy and a retaliating goblin", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const dummy = engine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request("p1", dummy.entityId, "dummy"));
    engine.tick();
    // Training Dummy: ten equal-level sword hits into Unarmored (9) = 90 HP.
    expect(engine.entity(dummy.entityId)?.currentHealth).toBe(80);
    for (let tick = 2; tick <= 17; tick += 1) engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(100);

    const goblinEngine = createEngine();
    addPlayer(goblinEngine, "p1", origin);
    const goblin = goblinEngine.spawnMob({
      archetype: "goblin",
      position: east(30),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    goblinEngine.startAttack(request("p1", goblin.entityId, "goblin"));
    goblinEngine.tick();
    for (let tick = 1; tick <= 24; tick += 1) goblinEngine.tick();
    // Level 10 Goblin: Shiv (Dagger) into bare skin (level 1): 9.5 + 10 - 1.
    expect(goblinEngine.entity("p1")?.currentHealth).toBe(81);
  });

  it("applies City District bonuses only across the player-to-mob PvE boundary", () => {
    const baseline = createEngine();
    const benefited = createEngine({
      getCityDistrictCombatBenefits: () => ({
        directPveDamageBonus: 1,
        pveDefenseBonus: 1
      })
    });
    for (const engine of [baseline, benefited]) {
      addPlayer(engine, "p1", origin);
      const dummy = engine.spawnMob({
        entityId: "district-dummy",
        archetype: "training_dummy",
        position: east(10),
        regionCode: "NM",
        zoneId: "world:NM"
      });
      engine.startAttack(request("p1", dummy.entityId, "district-hit"));
      engine.tick();
    }
    expect(
      benefited.entity("district-dummy")!.currentHealth
    ).toBe(
      baseline.entity("district-dummy")!.currentHealth - 1
    );

    type DamageInternals = {
      entities: Map<string, unknown>;
      applyDamage(
        attacker: unknown,
        target: unknown,
        deterministicDamage: number,
        sourceTechniqueId: string,
        direct: boolean,
        defenseMitigation?: Record<string, number>,
        defense?: number
      ): number;
    };
    const baselineDefense = baseline as unknown as DamageInternals;
    const benefitedDefense = benefited as unknown as DamageInternals;
    const baselineGoblin = baseline.spawnMob({
      entityId: "district-goblin",
      archetype: "goblin",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const benefitedGoblin = benefited.spawnMob({
      entityId: "district-goblin",
      archetype: "goblin",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const baselineDamage = baselineDefense.applyDamage(
      baselineDefense.entities.get(baselineGoblin.entityId),
      baselineDefense.entities.get("p1"),
      10,
      "district-defense",
      true
    );
    const benefitedDamage = benefitedDefense.applyDamage(
      benefitedDefense.entities.get(benefitedGoblin.entityId),
      benefitedDefense.entities.get("p1"),
      10,
      "district-defense",
      true
    );
    expect(benefitedDamage).toBeLessThan(baselineDamage);
  });

  it("clears stale combat without stopping player-controlled movement", () => {
    const stopPlayer = vi.fn();
    const engine = createEngine({ stopPlayer });
    addPlayer(engine, "p1", origin);
    const mob = engine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request("p1", mob.entityId, "start"));
    expect(engine.cancelCombat("p1")).toBe(true);
    expect(engine.entity("p1")?.targetEntityId).toBeNull();
    engine.startAttack(request("p1", mob.entityId, "again"));
    engine.clearMobs();
    expect(engine.entity("p1")?.targetEntityId).toBeNull();
    expect(stopPlayer).not.toHaveBeenCalled();
  });

  it("stops an explicit mob approach when the first attack lands", () => {
    const movePlayerToward = vi.fn();
    const stopPlayer = vi.fn();
    const engine = createEngine({ movePlayerToward, stopPlayer });
    addPlayer(engine, "p1", origin);
    const mob = engine.spawnMob({
      archetype: "training_dummy",
      position: east(200),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    engine.startAttack(request("p1", mob.entityId, "approach"));
    expect(movePlayerToward).toHaveBeenCalledOnce();

    syncPlayerPosition(engine, "p1", east(130));
    engine.tick();

    expect(engine.entity(mob.entityId)?.currentHealth).toBeLessThan(mob.currentHealth);
    expect(stopPlayer).toHaveBeenCalledOnce();
    expect(stopPlayer).toHaveBeenCalledWith("p1");
  });

  it("keeps a target-scoped approach pending through owner-attributed companion damage", () => {
    const movePlayerToward = vi.fn();
    const stopPlayer = vi.fn();
    const engine = createEngine({ movePlayerToward, stopPlayer });
    addPlayer(engine, "p1", origin);
    const target = engine.spawnMob({
      archetype: "training_dummy",
      position: east(200),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const unrelated = engine.spawnMob({
      archetype: "training_dummy",
      position: east(210),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    engine.startAttack(request("p1", target.entityId, "approach-with-dog"));
    engine.beginDeltaFlush();
    const targetHealthBeforeAssist = engine.entity(target.entityId)!.currentHealth;
    expect(engine.applyScriptedDamage(
      "p1", target.entityId, 3, "dog_companion_assist", "dog-companion:dog-1"
    )).toBe(3);
    expect(engine.applyScriptedDamage(
      "p1", unrelated.entityId, 2, "warrior_basic_attack"
    )).toBe(2);
    expect(stopPlayer).not.toHaveBeenCalled();

    const assistEvents = engine.beginDeltaFlush().events;
    expect(assistEvents).toContainEqual(expect.objectContaining({
      type: "ATTACK_LANDED",
      sourceEntityId: "dog-companion:dog-1",
      targetEntityId: target.entityId
    }));
    expect(assistEvents).toContainEqual(expect.objectContaining({
      type: "DAMAGE",
      sourceEntityId: "p1",
      targetEntityId: target.entityId
    }));

    syncPlayerPosition(engine, "p1", east(130));
    engine.tick();

    expect(engine.entity(target.entityId)?.currentHealth).toBeLessThan(targetHealthBeforeAssist - 3);
    expect(stopPlayer).toHaveBeenCalledOnce();
    expect(stopPlayer).toHaveBeenCalledWith("p1");
  });

  it("preserves a newly requested distant target through an existing enemy opportunity", () => {
    const stopPlayer = vi.fn();
    const engine = createEngine({ movePlayerToward: vi.fn(), stopPlayer });
    addPlayer(engine, "p1", origin);
    const oldTarget = engine.spawnMob({
      archetype: "goblin",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM",
      packId: "pack:old-target"
    });
    const newTarget = engine.spawnMob({
      archetype: "training_dummy",
      position: east(200),
      regionCode: "NM",
      zoneId: "world:NM",
      packId: "pack:new-target"
    });

    engine.startAttack(request("p1", oldTarget.entityId, "establish-old-combat"));
    engine.tick();
    expect(engine.entity("p1")?.pveCombat?.phase).toBe("enemy_pending");
    stopPlayer.mockClear();

    engine.startAttack(request("p1", newTarget.entityId, "approach-new-target"));
    expect(engine.entity("p1")?.targetEntityId).toBe(newTarget.entityId);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(newTarget.entityId);
    const healthBeforeEnemyOpportunity = engine.entity("p1")!.currentHealth;
    for (let tick = 0; tick < 25; tick += 1) engine.tick();

    expect(engine.entity("p1")?.currentHealth).toBeLessThan(healthBeforeEnemyOpportunity);
    expect(engine.entity("p1")?.targetEntityId).toBe(newTarget.entityId);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(newTarget.entityId);
    expect(stopPlayer).not.toHaveBeenCalled();

    const newTargetHealthBefore = engine.entity(newTarget.entityId)!.currentHealth;
    syncPlayerPosition(engine, "p1", east(130));
    for (let tick = 0; tick < 12 && stopPlayer.mock.calls.length === 0; tick += 1) engine.tick();

    expect(engine.entity(newTarget.entityId)?.currentHealth).toBeLessThan(newTargetHealthBefore);
    expect(stopPlayer).toHaveBeenCalledOnce();
    expect(stopPlayer).toHaveBeenCalledWith("p1");
  });

  it("preserves that pending focus after manual movement cancels only the approach stop", () => {
    const stopPlayer = vi.fn();
    const engine = createEngine({ movePlayerToward: vi.fn(), stopPlayer });
    addPlayer(engine, "p1", origin);
    const oldTarget = engine.spawnMob({
      archetype: "goblin", position: east(10), regionCode: "NM", zoneId: "world:NM"
    });
    const newTarget = engine.spawnMob({
      archetype: "training_dummy", position: east(200), regionCode: "NM", zoneId: "world:NM"
    });

    engine.startAttack(request("p1", oldTarget.entityId, "establish-before-manual-move"));
    engine.tick();
    expect(engine.entity("p1")?.pveCombat?.phase).toBe("enemy_pending");
    stopPlayer.mockClear();
    engine.startAttack(request("p1", newTarget.entityId, "new-target-before-manual-move"));
    engine.cancelPlayerAttackApproach("p1");
    for (let tick = 0; tick < 25; tick += 1) engine.tick();

    expect(engine.entity("p1")?.targetEntityId).toBe(newTarget.entityId);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(newTarget.entityId);
    const newTargetHealthBefore = engine.entity(newTarget.entityId)!.currentHealth;
    syncPlayerPosition(engine, "p1", east(130));
    for (let tick = 0; tick < 12 && engine.entity(newTarget.entityId)!.currentHealth === newTargetHealthBefore; tick += 1) {
      engine.tick();
    }

    expect(engine.entity(newTarget.entityId)?.currentHealth).toBeLessThan(newTargetHealthBefore);
    expect(stopPlayer).not.toHaveBeenCalled();
  });

  it("does not stop a later manual move when it supersedes the attack approach", () => {
    const stopPlayer = vi.fn();
    const engine = createEngine({ movePlayerToward: vi.fn(), stopPlayer });
    addPlayer(engine, "p1", origin);
    const mob = engine.spawnMob({
      archetype: "training_dummy",
      position: east(200),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    engine.startAttack(request("p1", mob.entityId, "approach"));
    engine.cancelPlayerAttackApproach("p1");
    syncPlayerPosition(engine, "p1", east(130));
    engine.tick();

    expect(engine.entity(mob.entityId)?.currentHealth).toBeLessThan(mob.currentHealth);
    expect(stopPlayer).not.toHaveBeenCalled();
  });

  it("makes scheduled work harmless across disconnect and replacement generations", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(10));
    engine.startAttack(request("p1", "p2", "before-disconnect"));
    engine.tick();
    expect(engine.entity("p2")?.currentHealth).toBe(96);

    engine.disconnectPlayer("p1");
    addPlayer(engine, "p1", origin);
    for (let tick = 0; tick < 40; tick += 1) {
      engine.tick();
    }
    expect(engine.entity("p2")?.currentHealth).toBe(96);
    expect(engine.entity("p1")?.targetEntityId).toBeNull();
    expect(engine.metricsSnapshot().scheduledWorkCount).toBe(0);
  });

  it("keeps a link-dead player stationary and targetable while blocking outgoing actions", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(20));
    const goblin = engine.spawnMob({
      archetype: "goblin",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request("p1", goblin.entityId, "before-linkdead"));
    engine.tick();
    const goblinHealthAtSuspend = engine.entity(goblin.entityId)!.currentHealth;

    engine.suspendPlayerAuthority("p1");
    for (let tick = 0; tick < 80; tick += 1) engine.tick();

    expect(engine.entity("p1")).toMatchObject({ lat: origin.lat, lon: origin.lon });
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(100);
    expect(engine.entity(goblin.entityId)?.currentHealth).toBe(goblinHealthAtSuspend);

    engine.endLinkDeadWorldPresence("p1");
    expect(engine.snapshotForPlayer("p2").upserts.some((entry) => entry.entityId === "p1"))
      .toBe(false);
    expect(engine.rotatePlayerAuthority("p1", "account-p1", "replacement")).not.toBeNull();
  });

  it("stops a goblin chase when its target leaves the home leash", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const goblin = engine.spawnMob({
      archetype: "goblin",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request("p1", goblin.entityId, "leash"));
    engine.tick();
    engine.syncPlayer({
      playerId: "p1",
      position: east(300),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    for (let tick = 2; tick <= 26; tick += 1) engine.tick();
    expect(engine.entity(goblin.entityId)?.targetEntityId).toBeNull();
    expect(engine.entity(goblin.entityId)?.activityState).toBe("idle");
  });

  it("requires manual player respawn, preserves the callback position, and grants arrival protection", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const onDefeated = vi.fn();
      const onRespawn = vi.fn(() => origin);
      const playerEngine = createEngine({ onPlayerDefeated: onDefeated, onPlayerRespawn: onRespawn });
      addPlayer(playerEngine, "p1", origin, 100);
      addPlayer(playerEngine, "p2", east(10), 10, 1);
      playerEngine.startAttack(request("p1", "p2", "defeat"));
      playerEngine.tick();
      expect(playerEngine.entity("p2")).toMatchObject({
        lifeState: "respawning",
        respawnAvailableAt: 100_000 + PLAYER_RESPAWN_DELAY_MS
      });
      expect(playerEngine.snapshotForPlayer("p1").upserts.find(({ entityId }) => entityId === "p2"))
        .not.toHaveProperty("respawnAvailableAt");
      expect(playerEngine.deathPenaltyOperationKey("p2")).toMatch(/^player-death:/u);
      expect(playerEngine.respawnReadiness("p2")).toEqual({ ready: false, remainingMs: 10_000 });
      expect(playerEngine.respawnPlayer("p2")).toBeNull();
      for (let tick = 2; tick <= 101; tick += 1) playerEngine.tick();
      expect(playerEngine.entity("p2")?.lifeState).toBe("respawning");
      expect(onRespawn).not.toHaveBeenCalled();
      vi.setSystemTime(new Date(110_000));
      const respawned = playerEngine.respawnPlayer("p2");
      expect(respawned).toMatchObject(origin);
      expect(playerEngine.entity("p2")?.lifeState).toBe("alive");
      expect(playerEngine.entity("p2")?.currentHealth).toBe(100);
      expect(onDefeated).toHaveBeenCalledWith("p2", expect.any(String), "p1", { revenantArmor: false, goldEligible: true });
      expect(onRespawn).toHaveBeenCalledWith("p2");
      expect(playerEngine.flagArrivalProtectionUntil("p2")).not.toBeNull();
      expect(playerEngine.deathPenaltyOperationKey("p2")).toBeNull();
      expect(playerEngine.respawnReadiness("p2")).toBeNull();
      expect(playerEngine.respawnPlayer("p2")).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    const mobEngine = createEngine();
    addPlayer(mobEngine, "p1", origin, 100);
    const dummy = mobEngine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    mobEngine.snapshotForPlayer("p1");
    mobEngine.beginDeltaFlush();
    mobEngine.startAttack(request("p1", dummy.entityId, "remove"));
    mobEngine.tick();
    expect(mobEngine.entity(dummy.entityId)).toBeNull();
    expect(mobEngine.nearbyEntityIds(origin, 100)).not.toContain(dummy.entityId);
    const removalDelta = mobEngine.deltaForPlayer("p1", mobEngine.beginDeltaFlush());
    expect(removalDelta?.removedEntityIds).toContain(dummy.entityId);
    expect(removalDelta?.upserts.map((entity) => entity.entityId)).not.toContain(dummy.entityId);
    expect(mobEngine.snapshotForPlayer("p1").upserts.map((entity) => entity.entityId))
      .not.toContain(dummy.entityId);
    expect(() => mobEngine.startAttack(request("p1", dummy.entityId, "dead-target")))
      .toThrowError(/does not exist/i);
  });

  it("restores an explicit persisted respawning profile even when retained health is positive", () => {
    const playerEngine = createEngine();
    playerEngine.connectPlayer({
      playerId: "persisted-death",
      name: "Persisted Death",
      regionCode: "NM",
      zoneId: "world:NM",
      position: origin,
      accountId: "account-persisted-death",
      connectionId: "connection-persisted-death",
      profile: {
        playerId: "persisted-death",
        maxHealth: 100,
        currentHealth: 75,
        baseAttackDamage: 10,
        lifeState: "respawning",
        deathPenaltyOperationKey: "player-death:persisted",
        respawnAvailableAt: 250_000
      }
    });

    expect(playerEngine.entity("persisted-death")).toMatchObject({
      lifeState: "respawning",
      currentHealth: 0,
      respawnAvailableAt: 250_000
    });
    expect(playerEngine.deathPenaltyOperationKey("persisted-death"))
      .toBe("player-death:persisted");
  });

  it("brings a player who reconnects dead back respawning on a restarted stream, and lets them respawn", () => {
    // A dead player whose socket drops is re-registered from the persisted profile. The new combat stream starts again
    // at sequence 1 with a fresh entity revision; the client must take that snapshot (combatStore.applySnapshot), or it
    // keeps the old death card after this respawn and the next Respawn press is rejected.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const onRespawn = vi.fn(() => east(5));
      const engine = createEngine({ onPlayerRespawn: onRespawn });
      addPlayer(engine, "p1", origin, 100);
      addPlayer(engine, "p2", east(10), 10, 1);
      engine.startAttack(request("p1", "p2", "defeat-before-drop"));
      engine.tick();
      expect(engine.entity("p2")?.lifeState).toBe("respawning");
      for (let index = 0; index < 5; index += 1) engine.snapshotForPlayer("p2");
      const before = engine.snapshotForPlayer("p2");
      const deadRevision = before.upserts.find(({ entityId }) => entityId === "p2")!.revision;

      engine.disconnectPlayer("p2");
      const persisted = engine.peekDirtyProfiles().find(({ playerId }) => playerId === "p2")!;
      expect(persisted).toMatchObject({ lifeState: "respawning", currentHealth: 0 });
      engine.connectPlayer({
        playerId: "p2",
        name: "p2",
        regionCode: "NM",
        zoneId: "world:NM",
        position: east(10),
        accountId: "account-p2",
        connectionId: "connection-p2-reconnect",
        profile: persisted
      });

      const resumed = engine.snapshotForPlayer("p2");
      expect(resumed.sequence).toBeLessThan(before.sequence);
      const resumedPlayer = resumed.upserts.find(({ entityId }) => entityId === "p2")!;
      expect(resumedPlayer).toMatchObject({ lifeState: "respawning", currentHealth: 0 });
      expect(resumedPlayer.revision).toBeLessThan(deadRevision);

      vi.setSystemTime(new Date(100_000 + PLAYER_RESPAWN_DELAY_MS));
      expect(engine.respawnReadiness("p2")).toEqual({ ready: true, remainingMs: 0 });
      expect(engine.respawnPlayer("p2")).toMatchObject({ lifeState: "alive", currentHealth: 100, ...east(5) });
      expect(onRespawn).toHaveBeenCalledWith("p2");
      engine.tick();
      const delta = engine.deltaForPlayer("p2", engine.beginDeltaFlush());
      expect(delta?.sequence).toBe(resumed.sequence + 1);
      expect(delta?.upserts.find(({ entityId }) => entityId === "p2")).toMatchObject({ lifeState: "alive" });
      expect(engine.respawnPlayer("p2")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("despawns an expired generation wolf and clears its combat targeters", () => {
    const engine = createEngine({
      getAuthoritativeViewCircle: () => ({
        anchorType: "flag",
        anchorId: "flag-reset",
        center: origin,
        radiusM: 1_000,
        generation: 1
      })
    });
    addPlayer(engine, "p1", origin);
    const wolf = engine.spawnMob({
      entityId: "wolf:expired-generation",
      archetype: "wolf",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-reset"
    });
    engine.snapshotForPlayer("p1");
    engine.beginDeltaFlush();
    engine.startAttack(request("p1", wolf.entityId, "target-expiring-wolf"));

    expect(engine.despawnMob(wolf.entityId)).toBe(true);
    expect(engine.entity(wolf.entityId)).toBeNull();
    expect(engine.entity("p1")?.targetEntityId).toBeNull();
    expect(engine.deltaForPlayer("p1", engine.beginDeltaFlush())?.removedEntityIds)
      .toContain(wolf.entityId);
    expect(engine.despawnMob(wolf.entityId)).toBe(false);
  });

  it("makes a defeated mob's stale retaliation work harmless", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1_000);
    const goblin = engine.spawnMob({
      archetype: "goblin",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    engine.startAttack(request("p1", goblin.entityId, "provoke"));
    engine.tick();
    expect(engine.entity(goblin.entityId)).toBeNull();

    for (let tick = 0; tick < 20; tick += 1) {
      engine.tick();
    }
    expect(engine.entity("p1")?.currentHealth).toBe(100);
    expect(engine.entity(goblin.entityId)).toBeNull();
    expect(engine.nearbyEntityIds(origin, 100)).not.toContain(goblin.entityId);
  });

  it("rejects self attacks and stale connection authority", () => {
    const engine = createEngine({ isPlayerAuthorityActive: () => false });
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(10));
    expect(() => engine.startAttack(request("p1", "p1", "self"))).toThrow(CombatRequestError);
    try {
      engine.startAttack(request("p1", "p2", "stale"));
      throw new Error("expected stale authority rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CombatRequestError);
      expect((error as CombatRequestError).code).toBe("COMBAT_AUTHORITY_REJECTED");
    }
  });

  it("rejects an owner's attack request against their companion", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const companion = engine.spawnMob({
      entityId: "dog-companion:dog-1", archetype: "wolf", position: east(5),
      regionCode: "NM", zoneId: "world:NM", worldAi: false,
      companion: {
        ownerPlayerId: "p1", dogId: "dog-1", name: "Milo", species: "trail_hound",
        baseMaxHealth: 100, maxHealth: 100, currentHealth: 100, damage: 10, mode: "play",
      },
    });
    expect(() => engine.startAttack(request("p1", companion.entityId, "owner-attack")))
      .toThrow(CombatRequestError);
    expect(engine.entity("p1")?.targetEntityId).toBeNull();
  });

  it("keeps distant combat entities and events outside the recipient AOI", () => {
    const engine = createEngine({ interestRadiusM: 1_000 });
    addPlayer(engine, "near", origin);
    const nearby = engine.spawnMob({
      archetype: "training_dummy",
      position: east(100),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const distant = engine.spawnMob({
      archetype: "training_dummy",
      position: east(1_500),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const snapshot = engine.snapshotForPlayer("near");
    expect(snapshot.upserts.map((entity) => entity.entityId)).toContain(nearby.entityId);
    expect(snapshot.upserts.map((entity) => entity.entityId)).not.toContain(distant.entityId);
    engine.beginDeltaFlush();
    addPlayer(engine, "far-player", east(1_500));
    engine.startAttack(request("far-player", distant.entityId, "distant-fight"));
    engine.tick();
    const distantDelta = engine.deltaForPlayer("near", engine.beginDeltaFlush());
    expect(distantDelta?.events ?? []).toEqual([]);
    expect(distantDelta?.upserts.map((entity) => entity.entityId) ?? []).not.toContain(
      distant.entityId
    );
  });

  it("clamps combat snapshots to the authoritative 650m flag circle", () => {
    const engine = createEngine({
      interestRadiusM: 1_100,
      getAuthoritativeViewCircle: () => ({
        anchorType: "flag",
        anchorId: "flag-radius-contract",
        center: origin,
        radiusM: 650,
        generation: 1
      })
    });
    addPlayer(engine, "p1", origin);
    const inside = engine.spawnMob({
      entityId: "wolf:649",
      archetype: "wolf",
      position: east(649),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-radius-contract"
    });
    const outside = engine.spawnMob({
      entityId: "wolf:651",
      archetype: "wolf",
      position: east(651),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-radius-contract"
    });
    addPlayer(engine, "outside-player", east(651));

    const snapshot = engine.snapshotForPlayer("p1", engine.buildInterestFrame(["p1"]));
    const visibleIds = snapshot.upserts.map((entity) => entity.entityId);
    expect(visibleIds).toContain(inside.entityId);
    expect(visibleIds).not.toContain(outside.entityId);
    expect(visibleIds).not.toContain("outside-player");
  });

  it("rejects combat acquisition outside the authoritative view and releases enemies that leave it", () => {
    let viewGeneration = 1;
    const engine = createEngine({
      getAuthoritativeViewCircle: () => ({
        anchorType: "flag",
        anchorId: "flag-combat-view",
        center: origin,
        radiusM: 650,
        generation: viewGeneration,
        eligibleRegionCodes: ["NM"],
        eligibleZoneIds: ["world:NM"]
      })
    });
    addPlayer(engine, "p1", origin);
    const inside = engine.spawnMob({
      entityId: "wolf:inside-combat-view",
      archetype: "wolf",
      position: east(649),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-combat-view"
    });
    const outside = engine.spawnMob({
      entityId: "wolf:outside-combat-view",
      archetype: "wolf",
      position: east(651),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-combat-view"
    });

    expect(() => engine.startAttack(request("p1", outside.entityId, "outside-view")))
      .toThrowError(expect.objectContaining({
        code: "COMBAT_TARGET_OUTSIDE_AUTHORITY",
        details: expect.objectContaining({
          combatValidationPredicate: "pve-outside-authoritative-view"
        })
      }));

    engine.startAttack(request("p1", inside.entityId, "inside-view"));
    engine.applyScriptedDamage("p1", inside.entityId, 1, "fixture_claim");
    viewGeneration = 2;
    engine.tick();
    expect(engine.entity("p1")?.pveCombat).toBeNull();

    viewGeneration = 3;
    engine.startAttack(request("p1", inside.entityId, "inside-view-again"));
    engine.applyScriptedDamage("p1", inside.entityId, 1, "fixture_claim");
    moveMobForInterestTest(engine, inside.entityId, east(651));
    engine.tick();

    expect(engine.entity("p1")?.targetEntityId).toBeNull();
    expect(engine.entity("p1")?.pveCombat).toBeNull();

    const normalEngine = createEngine({
      getAuthoritativeViewCircle: () => ({
        anchorType: "normal",
        anchorId: "normal-area",
        center: origin,
        radiusM: 650,
        generation: 1,
        eligibleRegionCodes: ["NM"],
        eligibleZoneIds: ["world:NM"]
      })
    });
    addPlayer(normalEngine, "p1", origin);
    normalEngine.spawnMob({
      entityId: "wolf:hidden-normal-layer",
      archetype: "wolf",
      position: east(100),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "another-flag"
    });
    expect(() => normalEngine.startAttack(request("p1", "wolf:hidden-normal-layer", "hidden-layer")))
      .toThrowError(expect.objectContaining({
        code: "COMBAT_TARGET_OUTSIDE_AUTHORITY"
      }));
  });

  it("attacks and retaliates across a real computed package and zone boundary inside the authoritative view", () => {
    const playerPosition = { lat: 35.1, lon: -106.000_001 };
    const mobPosition = { lat: 35.1, lon: -105.999_999 };
    const playerZoneId = zoneIdForPosition(playerPosition);
    const mobZoneId = zoneIdForPosition(mobPosition);
    const playerRegionCode = packageIdForPosition(playerPosition);
    const mobRegionCode = packageIdForPosition(mobPosition);
    expect(distanceMeters(playerPosition, mobPosition)).toBeLessThan(1);
    expect(playerZoneId).not.toBe(mobZoneId);
    expect(playerRegionCode).not.toBe(mobRegionCode);

    const engine = createEngine({
      getAuthoritativeViewCircle: () => ({
        anchorType: "flag",
        anchorId: "flag-boundary",
        center: playerPosition,
        radiusM: 100,
        generation: 7,
        eligibleRegionCodes: [playerRegionCode, mobRegionCode],
        eligibleZoneIds: [playerZoneId, mobZoneId]
      })
    });
    addPlayer(engine, "p1", playerPosition);
    engine.syncPlayer({
      playerId: "p1",
      position: playerPosition,
      regionCode: playerRegionCode,
      zoneId: playerZoneId
    });
    const wolf = engine.spawnMob({
      entityId: "wolf:computed-boundary",
      archetype: "wolf",
      position: mobPosition,
      regionCode: mobRegionCode,
      zoneId: mobZoneId,
      originFlagId: "flag-boundary"
    });

    expect(() => engine.startAttack(
      request("p1", wolf.entityId, "cross-boundary")
    )).not.toThrow();
    for (let tick = 0; tick < 40; tick += 1) engine.tick();
    expect(engine.entity(wolf.entityId)?.currentHealth).toBeLessThan(100);
    expect(engine.entity("p1")?.currentHealth).toBeLessThan(100);
  });

  it("rejects a mob omitted from eligible zones or regions despite being physically nearby", () => {
    const playerZoneId = "world:eligible";
    const playerRegionCode = "eligible-region";
    const engine = createEngine({
      getAuthoritativeViewCircle: () => ({
        anchorType: "flag",
        anchorId: "flag-eligible",
        center: origin,
        radiusM: 100,
        generation: 2,
        eligibleRegionCodes: [playerRegionCode],
        eligibleZoneIds: [playerZoneId]
      })
    });
    addPlayer(engine, "p1", origin);
    engine.syncPlayer({
      playerId: "p1",
      position: origin,
      regionCode: playerRegionCode,
      zoneId: playerZoneId
    });
    const wrongZone = engine.spawnMob({
      entityId: "wolf:wrong-zone",
      archetype: "wolf",
      position: east(1),
      regionCode: playerRegionCode,
      zoneId: "world:omitted",
      originFlagId: "flag-eligible"
    });
    const wrongRegion = engine.spawnMob({
      entityId: "wolf:wrong-region-eligible",
      archetype: "wolf",
      position: east(2),
      regionCode: "omitted-region",
      zoneId: playerZoneId,
      originFlagId: "flag-eligible"
    });

    for (const mob of [wrongZone, wrongRegion]) {
      expect(() => engine.startAttack(
        request("p1", mob.entityId, `reject-${mob.entityId}`)
      )).toThrowError(expect.objectContaining({
        code: "COMBAT_TARGET_OUTSIDE_AUTHORITY"
      }));
    }
  });

  it("keeps PvP exact-zone eligibility unchanged across the same nearby boundary", () => {
    const engine = createEngine({
      getAuthoritativeViewCircle: () => ({
        anchorType: "flag",
        anchorId: "flag-pvp-boundary",
        center: origin,
        radiusM: 100,
        generation: 1,
        eligibleRegionCodes: ["NM"],
        eligibleZoneIds: ["world:left", "world:right"]
      })
    });
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(1));
    engine.syncPlayer({
      playerId: "p1",
      position: origin,
      regionCode: "NM",
      zoneId: "world:left"
    });
    engine.syncPlayer({
      playerId: "p2",
      position: east(1),
      regionCode: "NM",
      zoneId: "world:right"
    });

    expect(() => engine.startAttack(request("p1", "p2", "pvp-boundary")))
      .toThrowError(expect.objectContaining({
        code: "COMBAT_TARGET_INVALID",
        details: expect.objectContaining({
          combatValidationPredicate: "pvp-zone-mismatch"
        })
      }));
  });

  it("refuses PvP both ways through the trust shield and leaves other pairs untouched", () => {
    const shielded = new Set(["p2"]);
    const engine = createEngine({
      isPvpBlocked: (attackerId, targetId) => shielded.has(attackerId) || shielded.has(targetId)
    });
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(1));
    addPlayer(engine, "p3", east(2));

    for (const [attacker, target] of [["p1", "p2"], ["p2", "p1"]] as const) {
      expect(() => engine.startAttack(request(attacker, target, `shield-${attacker}`)))
        .toThrowError(expect.objectContaining({
          code: "COMBAT_TARGET_INVALID",
          details: expect.objectContaining({ combatValidationPredicate: "pvp-trust-shield" })
        }));
    }
    expect(() => engine.applyMilitaryAttack({
      attackerPlayerId: "p1",
      targetEntityId: "p2",
      damage: 5,
      rangeM: 500,
      attackOrigin: origin,
      sourceTechniqueId: "military_infantry_basic_attack"
    })).toThrowError(expect.objectContaining({ code: "COMBAT_TARGET_INVALID" }));
    expect(() => engine.startAttack(request("p1", "p3", "settled-pair"))).not.toThrow();
  });

  it("refuses a second swing inside the strike block with the player's name and time left, one way only", () => {
    const engine = createEngine({
      pvpStrikeBlockMs: (attackerId, targetId) =>
        attackerId === "p1" && targetId === "p2" ? 19 * 3_600_000 + 59 * 60_000 : null,
      pvpPlayerName: (playerId) => playerId === "p2" ? "DevFour" : null
    });
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(1));
    expect(() => engine.startAttack(request("p1", "p2", "blocked")))
      .toThrowError(expect.objectContaining({
        code: "PVP_PROTECTED",
        message: "You already struck DevFour; you can't attack them again for 19h 59m unless they fight back or turn aggressive",
        details: expect.objectContaining({ combatValidationPredicate: "pvp-strike-block" })
      }));
    expect(() => engine.startAttack(request("p2", "p1", "victim-strikes-back"))).not.toThrow();
  });

  it("lands one hit on a player who is not fighting back, then stops the auto-attack", () => {
    let now = 1_000_000;
    const timers = new PvpTimerService({ query: async () => ({ rows: [] }) } as never, { now: () => now });
    const engine = createEngine({
      now: () => now,
      pvpStrikeBlockMs: (a, b) => timers.strikeBlockMs(a, b),
      onPvpHit: (a, b, until) => timers.recordHit(a, b, until)
    });
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(1));
    addPlayer(engine, "p3", east(1.5));
    engine.startAttack(request("p1", "p2", "first-swing"));
    for (let tick = 0; tick < 40; tick += 1) { now += 50; engine.tick(); }
    const afterOneHit = engine.entity("p2")!.currentHealth;
    expect(afterOneHit).toBeLessThan(100);
    // Several attack intervals later, still exactly one hit.
    for (let tick = 0; tick < 200; tick += 1) { now += 50; engine.tick(); }
    expect(engine.entity("p2")!.currentHealth).toBe(afterOneHit);
    expect(engine.entity("p1")?.targetEntityId ?? null).toBeNull();
    expect(() => engine.startAttack(request("p1", "p2", "second-swing")))
      .toThrowError(expect.objectContaining({ code: "PVP_PROTECTED" }));
    // A second aggressor also lands exactly one hit.
    engine.startAttack(request("p3", "p2", "other-aggressor"));
    for (let tick = 0; tick < 40; tick += 1) { now += 50; engine.tick(); }
    const afterSecondAggressor = engine.entity("p2")!.currentHealth;
    expect(afterSecondAggressor).toBeLessThan(afterOneHit);
    for (let tick = 0; tick < 200; tick += 1) { now += 50; engine.tick(); }
    expect(engine.entity("p2")!.currentHealth).toBe(afterSecondAggressor);
  });

  it("lets the victim retaliate into a fight where both trade hits until aggression drops", () => {
    let now = 1_000_000;
    const timers = new PvpTimerService({ query: async () => ({ rows: [] }) } as never, { now: () => now });
    const engine = createEngine({
      now: () => now,
      pvpStrikeBlockMs: (a, b) => timers.strikeBlockMs(a, b),
      onPvpHit: (a, b, until) => timers.recordHit(a, b, until)
    });
    addPlayer(engine, "p1", origin, 5);
    addPlayer(engine, "p2", east(1), 5);
    engine.startAttack(request("p1", "p2", "first-swing"));
    for (let tick = 0; tick < 60; tick += 1) { now += 50; engine.tick(); }
    const afterOneHit = engine.entity("p2")!.currentHealth;
    expect(afterOneHit).toBeLessThan(100);
    // The victim strikes back: a fight starts and the aggressor may fight on.
    engine.startAttack(request("p2", "p1", "retaliate"));
    for (let tick = 0; tick < 20; tick += 1) { now += 50; engine.tick(); }
    expect(timers.isFighting("p1", "p2")).toBe(true);
    engine.startAttack(request("p1", "p2", "fight-back"));
    for (let tick = 0; tick < 200; tick += 1) { now += 50; engine.tick(); }
    // Several hits each way: well past one swing.
    expect(engine.entity("p2")!.currentHealth).toBeLessThan(afterOneHit - (100 - afterOneHit) * 2);
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(100 - (100 - afterOneHit) * 2);
    // The aggressor breaks off and runs out of range; aggression drops and the block returns.
    engine.cancelCombat("p1");
    engine.cancelCombat("p2");
    syncPlayerPosition(engine, "p1", east(450));
    now += 11_000;
    expect(timers.isFighting("p1", "p2")).toBe(false);
    expect(timers.strikeBlockMs("p1", "p2")).not.toBeNull();
    syncPlayerPosition(engine, "p1", east(2));
    expect(() => engine.startAttack(request("p1", "p2", "blocked-again")))
      .toThrowError(expect.objectContaining({ code: "PVP_PROTECTED" }));
    // The victim can re-engage at any time while the mark lasts.
    expect(() => engine.startAttack(request("p2", "p1", "re-engage"))).not.toThrow();
  });

  describe("Aggressive victims hit back automatically", () => {
    function pvpEngine() {
      const clock = { now: 1_000_000 };
      const timers = new PvpTimerService({ query: async () => ({ rows: [] }) } as never, { now: () => clock.now });
      const engine = createEngine({
        now: () => clock.now,
        pvpStrikeBlockMs: (a, b) => timers.strikeBlockMs(a, b),
        pvpIsFighting: (a, b) => timers.isFighting(a, b),
        pvpDefeatSafetyMs: (playerId) => timers.defeatSafetyMs(playerId),
        pvpPlayerName: (playerId) => playerId,
        onPvpHit: (a, b, until, targetAggressive) => timers.recordHit(a, b, until, targetAggressive)
      });
      const run = (ticks: number) => { for (let tick = 0; tick < ticks; tick += 1) { clock.now += 50; engine.tick(); } };
      const internal = (id: string) => (engine as unknown as {
        entities: Map<string, {
          aggressiveUntilMs: number;
          targetEntityId: string | null;
          classRuntime: { hasShield: boolean; weaponMode: string } | null;
        }>;
      }).entities.get(id)!;
      const makeAggressive = (id: string) => { internal(id).aggressiveUntilMs = clock.now + 10_000; };
      return { clock, timers, engine, run, internal, makeAggressive };
    }

    it("turns a strike on an Aggressive player into a fight, then leaves no block once aggression drops", () => {
      const { clock, timers, engine, run, internal, makeAggressive } = pvpEngine();
      addPlayer(engine, "p1", origin, 5);
      addPlayer(engine, "p2", east(1), 5);
      makeAggressive("p2");
      engine.startAttack(request("p1", "p2", "strike-aggressive"));
      run(40);
      const firstHit = 100 - engine.entity("p2")!.currentHealth;
      expect(firstHit).toBeGreaterThan(0);
      // No one-swing stop: the pair is fighting and the victim auto-targeted the attacker.
      expect(timers.isFighting("p1", "p2")).toBe(true);
      expect(timers.strikeBlockMs("p1", "p2")).toBeNull();
      expect(internal("p1").targetEntityId).toBe("p2");
      expect(internal("p2").targetEntityId).toBe("p1");
      run(160);
      expect(100 - engine.entity("p2")!.currentHealth).toBeGreaterThanOrEqual(firstHit * 3);
      expect(100 - engine.entity("p1")!.currentHealth).toBeGreaterThanOrEqual(firstHit * 2);
      // The attacker is marked; the victim's hits back do not mark the victim.
      expect(timers.timersFor("p2")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "aggressor", playerId: "p1" })]));
      expect(timers.timersFor("p1").some((entry) => entry.kind === "aggressor")).toBe(false);

      // The attacker breaks off and runs; aggression drops, the fight ends and the auto target is dropped.
      engine.cancelCombat("p1");
      syncPlayerPosition(engine, "p1", east(450));
      clock.now += 11_000;
      run(40);
      expect(timers.isFighting("p1", "p2")).toBe(false);
      expect(internal("p2").targetEntityId).toBeNull();
      // A fight begun through aggression leaves no strike block behind...
      expect(timers.strikeBlockMs("p1", "p2")).toBeNull();
      // ...so the next strike follows the rules afresh: the victim is calm now, so one swing, then the block.
      syncPlayerPosition(engine, "p1", east(2));
      const before = engine.entity("p2")!.currentHealth;
      engine.startAttack(request("p1", "p2", "strike-calm"));
      run(40);
      const afterOne = engine.entity("p2")!.currentHealth;
      expect(afterOne).toBeLessThan(before);
      run(200);
      expect(engine.entity("p2")!.currentHealth).toBe(afterOne);
      expect(internal("p2").targetEntityId).toBeNull();
      expect(() => engine.startAttack(request("p1", "p2", "strike-again")))
        .toThrowError(expect.objectContaining({ code: "PVP_PROTECTED" }));
    });

    it("lets an attacker with a strike block attack an Aggressive target, without a new block", () => {
      const { clock, timers, engine, run, internal, makeAggressive } = pvpEngine();
      addPlayer(engine, "p1", origin, 5);
      addPlayer(engine, "p2", east(1), 5);
      engine.startAttack(request("p1", "p2", "one-swing"));
      run(40);
      const blockEndsAt = clock.now + timers.strikeBlockMs("p1", "p2")!;
      expect(() => engine.startAttack(request("p1", "p2", "refused"))).toThrowError(expect.objectContaining({ code: "PVP_PROTECTED" }));
      // p2 turns Aggressive (any hit sets it): the block no longer refuses p1.
      clock.now += 60_000;
      makeAggressive("p2");
      const before = engine.entity("p2")!.currentHealth;
      expect(() => engine.startAttack(request("p1", "p2", "fair-game"))).not.toThrow();
      run(200);
      expect(timers.isFighting("p1", "p2")).toBe(true);
      expect(internal("p2").targetEntityId).toBe("p1");
      expect(before - engine.entity("p2")!.currentHealth).toBeGreaterThanOrEqual((100 - before) * 3);
      expect(engine.entity("p1")!.currentHealth).toBeLessThan(100);
      // No new 20h block: the original block still ends when it always did and returns once aggression drops.
      engine.cancelCombat("p1");
      syncPlayerPosition(engine, "p1", east(450));
      clock.now += 11_000;
      run(40);
      expect(timers.isFighting("p1", "p2")).toBe(false);
      expect(clock.now + timers.strikeBlockMs("p1", "p2")!).toBe(blockEndsAt);
      syncPlayerPosition(engine, "p1", east(2));
      expect(() => engine.startAttack(request("p1", "p2", "blocked-again"))).toThrowError(expect.objectContaining({ code: "PVP_PROTECTED" }));
    });

    it("keeps a player killed by a player safe from everyone for 20h, except while they are Aggressive", () => {
      const { clock, timers, engine, run, makeAggressive } = pvpEngine();
      addPlayer(engine, "p1", origin, 5);
      addPlayer(engine, "p2", east(1), 5);
      addPlayer(engine, "p3", east(1.5), 5);
      timers.recordDeath("p2", "p1");
      for (const attacker of ["p1", "p3"]) {
        expect(() => engine.startAttack(request(attacker, "p2", `refused-${attacker}`))).toThrowError(expect.objectContaining({
          code: "PVP_PROTECTED",
          message: "p2 was recently defeated and is safe for 20h unless they turn aggressive",
          details: expect.objectContaining({ combatValidationPredicate: "pvp-defeat-safety" })
        }));
      }
      // p2 may still attack others, and while Aggressive anyone may attack p2.
      clock.now += 60 * 60_000;
      makeAggressive("p2");
      expect(() => engine.startAttack(request("p3", "p2", "fair-game"))).not.toThrow();
      run(80);
      expect(engine.entity("p2")!.currentHealth).toBeLessThan(100);
      expect(timers.isFighting("p2", "p3")).toBe(true);
      // Aggression drops: the safety resumes for the rest of the 20h.
      engine.cancelCombat("p2");
      engine.cancelCombat("p3");
      syncPlayerPosition(engine, "p3", east(450));
      clock.now += 11_000;
      run(40);
      syncPlayerPosition(engine, "p3", east(1.5));
      expect(() => engine.startAttack(request("p3", "p2", "safe-again"))).toThrowError(expect.objectContaining({
        code: "PVP_PROTECTED", details: expect.objectContaining({ combatValidationPredicate: "pvp-defeat-safety" })
      }));
      expect(() => engine.startAttack(request("p1", "p2", "safe-again-p1"))).toThrowError(expect.objectContaining({ code: "PVP_PROTECTED" }));
      // After 20h it is over.
      clock.now += 20 * 60 * 60_000;
      expect(() => engine.startAttack(request("p1", "p2", "expired"))).not.toThrow();
    });

    it("never overrides the victim's own target", () => {
      const { timers, engine, run, internal } = pvpEngine();
      addPlayer(engine, "p1", origin, 1);
      addPlayer(engine, "p2", east(1), 1);
      addPlayer(engine, "p3", east(1.5), 1);
      // p3 strikes p2 and p2 fights back: p2 is Aggressive and targeting p3.
      engine.startAttack(request("p3", "p2", "p3-first"));
      run(40);
      engine.startAttack(request("p2", "p3", "p2-revenge"));
      run(40);
      expect(internal("p2").targetEntityId).toBe("p3");
      engine.startAttack(request("p1", "p2", "p1-joins"));
      run(40);
      // p1's strike started a fight (p2 was Aggressive), but p2 keeps fighting p3.
      expect(timers.isFighting("p1", "p2")).toBe(true);
      expect(internal("p2").targetEntityId).toBe("p3");
    });

    it("Shield Charge forces a fight on an Aggressive player and is the one swing on a calm one", () => {
      const { timers, engine, run, internal, makeAggressive } = pvpEngine();
      const grantShieldCharge = (id: string) => {
        engine.updatePlayerSkillState(id, {
          fullClassRosterEnabled: false, ultimatesEnabled: false, fullBuildRespecAvailable: false,
          playerId: id, characterLevel: 25,
          pointState: { totalEarned: 25, totalSpent: 1, available: 24, revision: 1 },
          generalSkills: [{ skillId: "shield_charge", rank: 1, pointsSpent: 1 }],
          specializations: [], committedSpecializationId: null, activeSpecializationId: null,
          equippedClassTechniqueId: null, generalActiveLoadout: ["shield_charge", null], ultimate: null,
          cooldownEndsAt: {}, worldKnowledge: [], serverTime: 0, revision: 1
        });
        internal(id).classRuntime!.hasShield = true;
        internal(id).classRuntime!.weaponMode = "melee";
      };
      const charge = (id: string, targetEntityId: string) => engine.useGeneralActive({
        playerId: id, skillId: "shield_charge", accountId: `account-${id}`, connectionId: `connection-${id}`,
        targetEntityId, targetMode: "hostile"
      });
      addPlayer(engine, "p1", origin, 5);
      addPlayer(engine, "p2", east(1), 5);
      addPlayer(engine, "p3", east(300), 5);
      addPlayer(engine, "p4", east(301), 5);
      grantShieldCharge("p1");
      grantShieldCharge("p3");
      makeAggressive("p2");

      charge("p1", "p2");
      charge("p3", "p4");
      run(200);
      // Aggressive target: the charge engaged them, they hit back and the fight ran.
      expect(timers.isFighting("p1", "p2")).toBe(true);
      expect(engine.entity("p1")!.currentHealth).toBeLessThan(100);
      expect(100 - engine.entity("p2")!.currentHealth).toBeGreaterThan(100 - engine.entity("p4")!.currentHealth);
      // Calm target: the charge's hit was the one swing.
      expect(engine.entity("p4")!.currentHealth).toBeLessThan(100);
      expect(engine.entity("p3")!.currentHealth).toBe(100);
      expect(internal("p3").targetEntityId).toBeNull();
      expect(timers.strikeBlockMs("p3", "p4")).not.toBeNull();
    });
  });

  it("names only the player who landed the killing blow as the gold-eligible killer", () => {
    let now = 1_000_000;
    const timers = new PvpTimerService({ query: async () => ({ rows: [] }) } as never, { now: () => now });
    const defeats: Array<{ playerId: string; killer: string | null; goldEligible: boolean | undefined }> = [];
    const engine = createEngine({
      now: () => now,
      pvpStrikeBlockMs: (a, b) => timers.strikeBlockMs(a, b),
      onPvpHit: (a, b, until) => timers.recordHit(a, b, until),
      onPlayerDefeated: (playerId, _deathId, killer, details) => {
        defeats.push({ playerId, killer, goldEligible: details?.goldEligible });
      }
    });
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(1));
    addPlayer(engine, "p3", east(1.5));
    engine.startAttack(request("p1", "p2", "chip"));
    for (let tick = 0; tick < 40; tick += 1) { now += 50; engine.tick(); }
    expect(defeats).toEqual([]);
    setCurrentHealth(engine, "p2", 1);
    engine.startAttack(request("p3", "p2", "finisher"));
    for (let tick = 0; tick < 40; tick += 1) { now += 50; engine.tick(); }
    expect(defeats).toEqual([{ playerId: "p2", killer: "p3", goldEligible: true }]);
  });

  it("never makes a military unit kill gold-eligible", () => {
    const defeats: Array<{ killer: string | null; goldEligible: boolean | undefined }> = [];
    const engine = createEngine({
      onPlayerDefeated: (_playerId, _deathId, killer, details) => {
        defeats.push({ killer, goldEligible: details?.goldEligible });
      }
    });
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(1));
    setCurrentHealth(engine, "p2", 1);
    engine.applyMilitaryAttack({
      attackerPlayerId: "p1",
      targetEntityId: "p2",
      damage: 5,
      rangeM: 500,
      attackOrigin: origin,
      sourceTechniqueId: "military_infantry_basic_attack"
    });
    expect(defeats).toEqual([{ killer: "p1", goldEligible: false }]);
  });

  it("walks a player to weapon range of a player target before swinging", () => {
    const moves: LatLon[] = [];
    const engine = createEngine({ movePlayerToward: (_playerId, target) => { moves.push(target); } });
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(BASIC_ATTACK_RANGE_M + 50));
    engine.startAttack(request("p1", "p2", "walk-up"));
    expect(moves).toHaveLength(1);
    expect(distanceMeters(moves[0]!, east(BASIC_ATTACK_RANGE_M + 50))).toBeLessThanOrEqual(BASIC_ATTACK_RANGE_M);
    // In range already: no walk.
    addPlayer(engine, "p3", east(10));
    engine.startAttack(request("p1", "p3", "in-range"));
    expect(moves).toHaveLength(1);
  });

  it("uses the fixed normal-area anchor for players and eligible mobs while the local player moves", () => {
    const engine = createEngine({
      interestRadiusM: 150,
      getAuthoritativeViewCircle: () => ({
        anchorType: "normal",
        anchorId: "open-area",
        center: origin,
        radiusM: 650,
        generation: 1
      })
    });
    addPlayer(engine, "p1", east(600));
    addPlayer(engine, "far-side-player", destinationPoint(origin, 649, 270));
    addPlayer(engine, "outside-near-player", east(651));
    const farSideMob = engine.spawnMob({
      entityId: "wolf:far-side-open-area",
      archetype: "wolf",
      position: destinationPoint(origin, 649, 270),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: null
    });
    const outsideMob = engine.spawnMob({
      entityId: "wolf:outside-open-area",
      archetype: "wolf",
      position: east(651),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: null
    });
    const incompatibleRegionMob = engine.spawnMob({
      entityId: "wolf:wrong-region",
      archetype: "wolf",
      position: north(100),
      regionCode: "CO",
      zoneId: "world:CO",
      originFlagId: null
    });
    const incompatibleLayerMob = engine.spawnMob({
      entityId: "wolf:flag-scoped",
      archetype: "wolf",
      position: north(100),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "another-flag"
    });

    const visible = engine.buildInterestFrame(["p1"]).nearbyIdsByPlayer.get("p1");
    expect(visible).toEqual(new Set(["p1", "far-side-player", farSideMob.entityId]));
    expect(visible).not.toContain("outside-near-player");
    expect(visible).not.toContain(outsideMob.entityId);
    expect(visible).not.toContain(incompatibleRegionMob.entityId);
    expect(visible).not.toContain(incompatibleLayerMob.entityId);
  });

  it("removes a known nearby mob from the recipient delta", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const mob = engine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.snapshotForPlayer("p1");
    engine.beginDeltaFlush();
    engine.clearMobs();
    const delta = engine.deltaForPlayer("p1", engine.beginDeltaFlush());
    expect(delta?.removedEntityIds).toContain(mob.entityId);
  });

  it("reuses one spatial candidate query for recipients sharing a cell", () => {
    const engine = createEngine({ interestRadiusM: 1_000 });
    for (let index = 0; index < 20; index += 1) {
      addPlayer(engine, `p${index}`, east(index));
    }

    const frame = engine.buildInterestFrame(
      Array.from({ length: 20 }, (_, index) => `p${index}`)
    );
    expect(frame.cacheMisses).toBe(1);
    expect(frame.cacheHits).toBe(19);
    expect(frame.nearbyIdsByPlayer.get("p0")?.size).toBe(20);
    expect(engine.metricsSnapshot()).toMatchObject({ aoiCacheMisses: 1, aoiCacheHits: 19 });
  });

  it("keeps every flag-scoped mob subscribed across repeated movement and replaces the set on flag change", () => {
    const flagBCenter = east(1_400);
    let view = { anchorType: "flag" as const, anchorId: "flag-1", center: origin, radiusM: 1_000, generation: 1 };
    const engine = createEngine({ interestRadiusM: 150, getAuthoritativeViewCircle: () => view });
    addPlayer(engine, "p1", origin);
    const northernWolf = engine.spawnMob({
      entityId: "wolf:north",
      archetype: "wolf",
      position: north(800),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-1"
    });
    const southernWolf = engine.spawnMob({
      entityId: "wolf:south",
      archetype: "wolf",
      position: south(800),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-1"
    });
    const overlappingWolf = engine.spawnMob({
      entityId: "wolf:overlap",
      archetype: "wolf",
      position: east(700),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-1"
    });
    const foreignOriginInsideFlagB = engine.spawnMob({
      entityId: "wolf:foreign-origin-inside-b",
      archetype: "wolf",
      position: east(1_600),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-1"
    });
    const flagBOwnedOutsideFlagB = engine.spawnMob({
      entityId: "wolf:b-owned-outside-b",
      archetype: "wolf",
      position: destinationPoint(flagBCenter, 1_100, 90),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-2"
    });
    let interest = engine.buildInterestFrame(["p1"]);
    const snapshot = engine.snapshotForPlayer("p1", interest);
    expect(snapshot.upserts.map((entity) => entity.entityId)).toEqual([
      "p1",
      northernWolf.entityId,
      southernWolf.entityId,
      overlappingWolf.entityId
    ].sort());
    engine.beginDeltaFlush();

    for (const position of [south(700), south(850), south(650)]) {
      engine.syncPlayer({ playerId: "p1", position, regionCode: "NM", zoneId: "world:NM" });
      interest = engine.buildInterestFrame(["p1"]);
      const delta = engine.deltaForPlayerWithInterest("p1", engine.beginDeltaFlush(), interest);
      expect(interest.nearbyIdsByPlayer.get("p1")).toEqual(
        new Set(["p1", northernWolf.entityId, southernWolf.entityId, overlappingWolf.entityId])
      );
      expect(delta?.removedEntityIds ?? []).toEqual([]);
      expect(delta?.upserts.map((entity) => entity.entityId) ?? []).toEqual(["p1"]);
    }

    view = { ...view, anchorId: "flag-2", center: flagBCenter, generation: 2 };
    interest = engine.buildInterestFrame(["p1"]);
    const changedFlagSnapshot = engine.snapshotForPlayer("p1", interest);
    expect(changedFlagSnapshot.upserts.map((entity) => entity.entityId).sort()).toEqual([
      "p1",
      foreignOriginInsideFlagB.entityId,
      overlappingWolf.entityId
    ].sort());
    expect(changedFlagSnapshot.upserts.map((entity) => entity.entityId)).not.toContain(
      flagBOwnedOutsideFlagB.entityId
    );

    const movingWolf = engine.spawnMob({
      entityId: "wolf:moving",
      archetype: "wolf",
      position: destinationPoint(flagBCenter, 1_050, 90),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: "flag-1"
    });
    engine.beginDeltaFlush();
    const insideFlagB = destinationPoint(flagBCenter, 950, 90);
    expect(distanceMeters(flagBCenter, insideFlagB)).toBeLessThan(view.radiusM);
    moveMobForInterestTest(engine, movingWolf.entityId, insideFlagB);
    expect(engine.nearbyEntityIds(flagBCenter, view.radiusM)).toContain(movingWolf.entityId);
    interest = engine.buildInterestFrame(["p1"]);
    expect(interest.nearbyIdsByPlayer.get("p1")).toContain(movingWolf.entityId);
    const entered = engine.deltaForPlayerWithInterest("p1", engine.beginDeltaFlush(), interest);
    expect(entered).not.toBeNull();
    expect(entered!.upserts.map((entity) => entity.entityId)).toContain(movingWolf.entityId);
    expect(entered!.removedEntityIds).not.toContain(movingWolf.entityId);

    moveMobForInterestTest(engine, movingWolf.entityId, destinationPoint(flagBCenter, 1_050, 90));
    interest = engine.buildInterestFrame(["p1"]);
    const left = engine.deltaForPlayerWithInterest("p1", engine.beginDeltaFlush(), interest);
    expect(left?.removedEntityIds).toContain(movingWolf.entityId);
  });

  it("includes shared environmental mobs with no flag owner in flag and reconnect snapshots", () => {
    const view = {
      anchorType: "flag" as const,
      anchorId: "flag-1",
      center: origin,
      radiusM: 1_000,
      generation: 1
    };
    const engine = createEngine({
      interestRadiusM: 150,
      getAuthoritativeViewCircle: () => view
    });
    addPlayer(engine, "p1", origin);
    const environmentalWolf = engine.spawnMob({
      entityId: "wolf:shared-environment",
      archetype: "wolf",
      position: north(800),
      regionCode: "NM",
      zoneId: "world:NM",
      originFlagId: null
    });

    const initial = engine.snapshotForPlayer("p1", engine.buildInterestFrame(["p1"]));
    expect(initial.upserts.map((entity) => entity.entityId)).toContain(environmentalWolf.entityId);
    const reconnect = engine.snapshotForPlayer("p1", engine.buildInterestFrame(["p1"]));
    expect(reconnect.upserts.map((entity) => entity.entityId)).toContain(environmentalWolf.entityId);
  });

  it("isolates dense fight deltas while reusing nearby-recipient AOI candidates", () => {
    const engine = createEngine({ interestRadiusM: 1_000 });
    addPlayer(engine, "near-a", origin, 100);
    addPlayer(engine, "near-b", east(5));
    addPlayer(engine, "far", east(2_000));
    const mob = engine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const initialInterest = engine.buildInterestFrame(["near-a", "near-b", "far"]);
    engine.snapshotForPlayer("near-a", initialInterest);
    engine.snapshotForPlayer("near-b", initialInterest);
    engine.snapshotForPlayer("far", initialInterest);
    engine.beginDeltaFlush();

    engine.startAttack(request("near-a", mob.entityId, "near-fight"));
    engine.tick();
    const interest = engine.buildInterestFrame(["near-a", "near-b", "far"]);
    const frame = engine.beginDeltaFlush();
    const nearby = engine.deltaForPlayerWithInterest("near-b", frame, interest);
    const distant = engine.deltaForPlayerWithInterest("far", frame, interest);

    expect(interest.cacheHits).toBeGreaterThan(0);
    expect(nearby?.events.some((event) => event.targetEntityId === mob.entityId)).toBe(true);
    expect(distant?.events ?? []).toEqual([]);
    expect(distant?.upserts.map((entity) => entity.entityId) ?? []).not.toContain(mob.entityId);
  });

  it("emits one replay-safe reward settlement candidate without granting rewards", () => {
    const onDefeatSettlementCandidate = vi.fn();
    const engine = createEngine({ onDefeatSettlementCandidate });
    addPlayer(engine, "p1", origin, 100);
    const mob = engine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request("p1", mob.entityId, "settlement"));
    engine.tick();

    expect(onDefeatSettlementCandidate).toHaveBeenCalledTimes(1);
    expect(onDefeatSettlementCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementKey: `${mob.entityId}:defeat:1`,
        defeatedEntityId: mob.entityId,
        defeatGeneration: 1,
        eligibleParticipantIds: ["p1"],
        contributions: [{ entityId: "p1", damage: 90 }],
        defeatingPlayerId: "p1",
        serverTick: 1,
        mobArchetype: "training_dummy",
        xpPolicyVersion: 3,
        itemRewardPolicyVersion: COMBAT_ITEM_REWARD_POLICY_VERSION,
        targetBasicHitCount: 10,
        baseXpPool: 0,
        lootLocation: {
          regionCode: packageIdForPosition({ lat: mob.lat, lon: mob.lon }),
          zoneId: zoneIdForPosition({ lat: mob.lat, lon: mob.lon }),
          position: { lat: mob.lat, lon: mob.lon }
        }
      })
    );
  });

  it("continues a rehydrated mob's durable life generation", () => {
    const onDefeatSettlementCandidate = vi.fn();
    const engine = createEngine({ onDefeatSettlementCandidate });
    addPlayer(engine, "p1", origin, 100);
    const mob = engine.spawnMob({
      entityId: "00000000-0000-8000-8000-000000000001",
      archetype: "training_dummy",
      position: east(10),
      lifeGeneration: 7,
      populationAuthority: {
        ownerToken: "00000000-0000-4000-8000-000000000777",
        fencingGeneration: 3,
        cutoverRevision: 2
      },
      regionCode: "NM",
      zoneId: "world:NM"
    });

    engine.startAttack(request("p1", mob.entityId, "rehydrated-settlement"));
    engine.tick();

    expect(onDefeatSettlementCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementKey: `${mob.entityId}:defeat:8`,
        defeatedEntityId: mob.entityId,
        defeatGeneration: 8,
        populationAuthority: {
          ownerToken: "00000000-0000-4000-8000-000000000777",
          fencingGeneration: 3,
          cutoverRevision: 2
        }
      })
    );
  });

  it("preserves the combat actor instance across a population lease rebind", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 100);
    const mob = engine.spawnMob({
      entityId: "00000000-0000-8000-8000-000000000009",
      archetype: "training_dummy",
      position: east(10),
      lifeGeneration: 7,
      populationAuthority: {
        ownerToken: "00000000-0000-4000-8000-000000000777",
        fencingGeneration: 3,
        cutoverRevision: 2
      },
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request("p1", mob.entityId, "rebind-target"));
    const internalEntities = (engine as unknown as {
      entities: Map<string, { targetEntityId: string | null }>;
    }).entities;
    const actorBefore = internalEntities.get(mob.entityId);
    const snapshotBefore = engine.entity(mob.entityId);

    expect(engine.rebindPopulationAuthority(mob.entityId, {
      ownerToken: "00000000-0000-4000-8000-000000000778",
      fencingGeneration: 4,
      cutoverRevision: 3
    })).toBe(true);

    expect(internalEntities.get(mob.entityId)).toBe(actorBefore);
    expect(engine.entity(mob.entityId)).toEqual(snapshotBefore);
    expect(engine.entity("p1")?.targetEntityId).toBe(mob.entityId);
  });

  it("retires only Population-managed mobs through the reconciliation seam", () => {
    const engine = createEngine();
    const ordinary = engine.spawnMob({
      entityId: "ordinary-mob",
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const population = engine.spawnMob({
      entityId: "population-mob",
      archetype: "training_dummy",
      position: east(20),
      populationAuthority: {
        ownerToken: "00000000-0000-4000-8000-000000000777",
        fencingGeneration: 3,
        cutoverRevision: 2
      },
      regionCode: "NM",
      zoneId: "world:NM"
    });

    expect(engine.despawnPopulationManagedMob(ordinary.entityId)).toBe(false);
    expect(engine.entity(ordinary.entityId)).not.toBeNull();
    expect(engine.despawnPopulationManagedMob(population.entityId)).toBe(true);
    expect(engine.entity(population.entityId)).toBeNull();
  });

  it("rejects invalid durable life generations", () => {
    const engine = createEngine();
    expect(() => engine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      lifeGeneration: -1,
      regionCode: "NM",
      zoneId: "world:NM"
    })).toThrow("mob life generation must be a non-negative safe integer");
  });

  it("does not finalize a reward-bearing defeat until durable acceptance resolves", async () => {
    let resolveAcceptance!: (accepted: boolean) => void;
    const acceptance = new Promise<boolean>((resolve) => {
      resolveAcceptance = resolve;
    });
    const engine = createEngine({ onDefeatSettlementCandidate: () => acceptance });
    addPlayer(engine, "p1", origin, 100);
    const mob = engine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.startAttack(request("p1", mob.entityId, "durable-acceptance"));
    engine.tick();

    expect(engine.entity(mob.entityId)).toMatchObject({ currentHealth: 0, lifeState: "alive" });
    expect(engine.beginDeltaFlush().events.map((event) => event.type)).not.toContain("DEFEATED");

    resolveAcceptance(false);
    await acceptance;
    await Promise.resolve();
    expect(engine.entity(mob.entityId)).toMatchObject({ currentHealth: 1, lifeState: "alive" });

    let acceptDurably!: () => void;
    const accepted = new Promise<boolean>((resolve) => {
      acceptDurably = () => resolve(true);
    });
    const acceptedEngine = createEngine({ onDefeatSettlementCandidate: () => accepted });
    addPlayer(acceptedEngine, "p1", origin, 100);
    const acceptedMob = acceptedEngine.spawnMob({
      archetype: "training_dummy",
      position: east(10),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    acceptedEngine.startAttack(request("p1", acceptedMob.entityId, "durable-accepted"));
    acceptedEngine.tick();
    acceptDurably();
    await accepted;
    await Promise.resolve();
    expect(acceptedEngine.entity(acceptedMob.entityId)).toBeNull();
  });
});

describe("CombatEngine dense deterministic simulation", () => {
  it("runs 50 players and 150 mobs for thousands of ticks without timer or entity growth", () => {
    const engine = createEngine({ interestRadiusM: 1_200 });
    for (let index = 0; index < 50; index += 1) {
      addPlayer(engine, `p${index}`, east(index));
    }
    const mobs = [];
    for (let index = 0; index < 150; index += 1) {
      mobs.push(engine.spawnMob({
        archetype: "training_dummy",
        position: east(index < 50 ? index + 8 : 8 + (index % 40)),
        regionCode: "NM",
        zoneId: "world:NM"
      }));
    }
    for (let index = 0; index < 50; index += 1) {
      engine.startAttack(request(`p${index}`, mobs[index]!.entityId, `dense-${index}`));
    }
    for (let tick = 0; tick < 2_000; tick += 1) {
      engine.tick();
      if (tick % 2 === 0) {
        const frame = engine.beginDeltaFlush();
        engine.deltaForPlayer("p0", frame);
      }
    }
    const metrics = engine.metricsSnapshot();
    expect(metrics.activeCombatants).toBeLessThanOrEqual(200);
    expect(metrics.scheduledWorkCount).toBeLessThanOrEqual(200);
    expect(metrics.activeEngagements).toBe(0);
    expect(metrics.activeChases).toBe(0);
  });

  it("runs a dense 100-player 300-mob neighboring-cell fight through lifecycle churn", () => {
    let settlementCount = 0;
    let respawnCount = 0;
    const engine = createEngine({
      interestRadiusM: 1_200,
      onPlayerRespawn: () => {
        respawnCount += 1;
        return origin;
      },
      onDefeatSettlementCandidate: () => {
        settlementCount += 1;
      }
    });
    for (let index = 0; index < 100; index += 1) {
      addPlayer(engine, `dense-player-${index}`, east(index % 80), 100);
    }
    const mobs = Array.from({ length: 300 }, (_, index) =>
      engine.spawnMob({
        archetype: index % 3 === 0 ? "goblin" : "training_dummy",
        position: east(8 + (index % 96)),
        regionCode: "NM",
        zoneId: "world:NM"
      })
    );
    for (let index = 0; index < 100; index += 1) {
      engine.startAttack(
        request(`dense-player-${index}`, mobs[index]!.entityId, `dense-start-${index}`)
      );
    }
    engine.startAttack(
      request("dense-player-98", "dense-player-99", "dense-player-defeat")
    );

    for (let tick = 0; tick < 3_000; tick += 1) {
      if (tick > 0 && tick % 200 === 0) {
        for (let index = 0; index < 100; index += 10) {
          const target = mobs[(tick + index) % mobs.length];
          if (target && engine.entity(target.entityId)?.lifeState === "alive") {
            engine.startAttack(
              request(`dense-player-${index}`, target.entityId, `switch-${tick}-${index}`)
            );
          }
        }
      }
      if (tick === 1_000) {
        engine.disconnectPlayer("dense-player-99");
        addPlayer(engine, "dense-player-99", east(20), 100);
      }
      if (tick === 2_500) {
        engine.clearMobs();
      }
      engine.tick();
      if (tick % 2 === 0) {
        const interest = engine.buildInterestFrame(["dense-player-0", "dense-player-50"]);
        const frame = engine.beginDeltaFlush();
        engine.deltaForPlayerWithInterest("dense-player-0", frame, interest);
        engine.deltaForPlayerWithInterest("dense-player-50", frame, interest);
      }
    }

    const metrics = engine.metricsSnapshot();
    expect(metrics.activeCombatants).toBe(100);
    expect(metrics.activeEngagements).toBe(0);
    expect(metrics.activeChases).toBe(0);
    expect(metrics.scheduledWorkCount).toBe(0);
    expect(engine.entity("dense-player-99")).toMatchObject({
      lifeState: "alive",
      currentHealth: 100
    });
    expect(respawnCount).toBe(0);
    expect(settlementCount).toBeGreaterThan(0);
  }, 10_000);
});

describe("Giving Tree and Balsam Resin healing", () => {
  it("heals only near Giving Trees", () => {
    for (const treeId of ["tree-0", "tree-204", "tree-200"]) {
      const engine = createEngine();
      addPlayer(engine, "p1", origin, 10, 90);
      engine.replaceGivingTreeSource("zone", [{ id: treeId, ...origin }]);

      engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(treeId === "tree-0" ? 93 : 90);
    }
  });

  it("heals at the 50m chopping boundary with immediate entry and a one-beat cadence", () => {
    const boundaryPosition = destinationPoint(origin, 49.999_999_9, 90);
    expect(distanceMeters(origin, boundaryPosition)).toBeCloseTo(50, 5);
    expect(distanceMeters(origin, boundaryPosition)).toBeLessThanOrEqual(50);

    for (const resinAvailable of [true, false]) {
      const engine = createEngine();
      addPlayer(engine, "p1", east(51), 10, 90);
      const trees = [
        { id: "tree-a", ...origin, resinAvailable },
        { id: "tree-b", ...north(5), resinAvailable }
      ];
      engine.replaceGivingTreeSource("zone", trees);

      engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(90);

      syncPlayerPosition(engine, "p1", boundaryPosition);
      engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(93);

      for (let tick = 0; tick < millisecondsToTicks(BASIC_ATTACK_INTERVAL_MS, 20) - 1; tick += 1) engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(93);
      engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(96);

      syncPlayerPosition(engine, "p1", east(51));
      engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(96);

      syncPlayerPosition(engine, "p1", boundaryPosition);
      engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(99);

      syncPlayerPosition(engine, "p1", east(51));
      engine.tick();
      setCurrentHealth(engine, "p1", 90);
      syncPlayerPosition(engine, "p1", east(45));
      engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(93);
    }
  });

  it("reconciles same-source coordinate corrections without increasing references", () => {
    const engine = createEngine();
    const correctedPosition = east(200);
    addPlayer(engine, "p1", origin, 10, 90);
    engine.replaceGivingTreeSource("zone", [{ id: "tree-a", ...origin }]);

    engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(93);

    syncPlayerPosition(engine, "p1", correctedPosition);
    engine.tick();
    setCurrentHealth(engine, "p1", 90);
    engine.replaceGivingTreeSource("zone", [
      { id: "tree-a", ...correctedPosition }
    ]);
    engine.replaceGivingTreeSource("zone", [
      { id: "tree-a", ...correctedPosition }
    ]);
    engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(93);

    const state = givingTreeState(engine);
    expect(state.givingTreeReferenceCounts.get("tree-a")).toBe(1);
    expect(state.givingTreePositions.get("tree-a")).toEqual(correctedPosition);
    expect(state.givingTreeGrid.size).toBe(1);

    setCurrentHealth(engine, "p1", 90);
    syncPlayerPosition(engine, "p1", origin);
    engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(90);
  });

  it("adds and removes single trees in one source without touching the rest, and player trees heal", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 10, 90);
    engine.replaceGivingTreeSource("zone", [{ id: "tree-0", ...east(300) }]);
    engine.upsertGivingTreeInSource("player-saplings", { id: "sapling:abc", ...origin });
    engine.upsertGivingTreeInSource("player-saplings", { id: "sapling:abc", ...origin });
    let state = givingTreeState(engine);
    expect(state.givingTreeReferenceCounts.get("sapling:abc")).toBe(1);
    expect(state.givingTreeGrid.size).toBe(2);

    engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(93);

    // A sick or chopped tree is removed alone: the other source and its tree are untouched.
    engine.removeGivingTreeFromSource("player-saplings", "sapling:abc");
    engine.removeGivingTreeFromSource("player-saplings", "sapling:abc");
    state = givingTreeState(engine);
    expect(state.givingTreeGrid.size).toBe(1);
    expect(state.givingTreePositions.has("sapling:abc")).toBe(false);
    expect(state.givingTreePositions.has("tree-0")).toBe(true);
    setCurrentHealth(engine, "p1", 90);
    for (let tick = 0; tick < 40; tick += 1) engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(90);

    // A tree shared with another source survives one source dropping it.
    engine.upsertGivingTreeInSource("player-saplings", { id: "tree-0", ...east(300) });
    engine.removeGivingTreeFromSource("player-saplings", "tree-0");
    expect(givingTreeState(engine).givingTreePositions.has("tree-0")).toBe(true);
  });

  it("keeps one global tree until the final source reference releases", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 10, 90);
    engine.replaceGivingTreeSource("source-a", [{ id: "tree-a", ...origin }]);
    engine.replaceGivingTreeSource("source-b", [{ id: "tree-a", ...origin }]);

    let state = givingTreeState(engine);
    expect(state.givingTreeReferenceCounts.get("tree-a")).toBe(2);
    expect(state.givingTreeGrid.size).toBe(1);
    engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(93);

    engine.replaceGivingTreeSource("source-a", []);
    state = givingTreeState(engine);
    expect(state.givingTreeReferenceCounts.get("tree-a")).toBe(1);
    expect(state.givingTreeGrid.size).toBe(1);
    syncPlayerPosition(engine, "p1", east(51));
    engine.tick();
    setCurrentHealth(engine, "p1", 90);
    syncPlayerPosition(engine, "p1", origin);
    engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(93);

    engine.replaceGivingTreeSource("source-b", []);
    state = givingTreeState(engine);
    expect(state.givingTreeReferenceCounts.has("tree-a")).toBe(false);
    expect(state.givingTreePositions.has("tree-a")).toBe(false);
    expect(state.givingTreeGrid.size).toBe(0);
    setCurrentHealth(engine, "p1", 90);
    engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(90);
  });

  it("heals immediately once, skips missed resin intervals, and clears on death", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
      const finished = vi.fn();
      const engine = createEngine({ onBalsamResinEffectFinished: finished });
      addPlayer(engine, "p1", origin, 10, 80);
      engine.stageBalsamResinEffect({
        effectId: "effect-1",
        playerId: "p1",
        startedAt: "2026-07-23T00:00:00.000Z",
        endsAt: new Date(Date.parse("2026-07-23T00:00:00.000Z") + BALSAM_RESIN_EFFECT_DURATION_MS).toISOString(),
        resinConsumed: true,
        huntingDistrictPreserved: false
      }, { fresh: true });
      engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(84);

      vi.advanceTimersByTime(5_000);
      engine.tick();
      expect(engine.entity("p1")?.currentHealth).toBe(88);

      const runtime = engine as unknown as {
        entities: Map<string, { lifeState: string }>;
      };
      runtime.entities.get("p1")!.lifeState = "respawning";
      engine.tick();
      expect(finished).toHaveBeenCalledWith("p1", "effect-1", "death");
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules resin ticks at startedAt + k * interval despite a laggy engine loop", () => {
    vi.useFakeTimers();
    try {
      const start = Date.parse("2026-07-23T00:00:00.000Z");
      vi.setSystemTime(start);
      const engine = createEngine();
      addPlayer(engine, "p1", origin, 10, 1);
      const resin = engine as unknown as { balsamResinEffects: Map<string, { nextTickAtMs: number }> };
      engine.stageBalsamResinEffect({
        effectId: "effect-lag",
        playerId: "p1",
        startedAt: "2026-07-23T00:00:00.000Z",
        endsAt: new Date(Date.parse("2026-07-23T00:00:00.000Z") + BALSAM_RESIN_EFFECT_DURATION_MS).toISOString(),
        resinConsumed: true,
        huntingDistrictPreserved: false
      }, { fresh: true });
      const processedAt: number[] = [];
      let lastHealth = engine.entity("p1")?.currentHealth ?? 0;
      // Engine passes land 0 to 49ms late, drifting like a real loop.
      for (let elapsed = 0; elapsed <= 9_800; elapsed += 50) {
        vi.setSystemTime(start + elapsed + (elapsed % 7) * 7);
        engine.tick();
        const health = engine.entity("p1")?.currentHealth ?? 0;
        if (health !== lastHealth) {
          processedAt.push(Date.now() - start);
          lastHealth = health;
          const next = resin.balsamResinEffects.get("p1")?.nextTickAtMs;
          if (next !== undefined) expect(next - start).toBe(BALSAM_RESIN_TICK_INTERVAL_MS * processedAt.length);
        }
      }
      expect(processedAt).toHaveLength(6);
      processedAt.forEach((at, index) => {
        expect(at).toBeGreaterThanOrEqual(BALSAM_RESIN_TICK_INTERVAL_MS * index);
        expect(at).toBeLessThan(BALSAM_RESIN_TICK_INTERVAL_MS * index + 100);
      });
      expect(engine.entity("p1")?.currentHealth).toBe(1 + 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("protects goblin defenders and isolates enemy relations by player", () => {
    const engine = createEngine();
    addPlayer(engine, "enemy", origin);
    addPlayer(engine, "neutral", destinationPoint(origin, 5, 180));
    const defender = engine.spawnMob({
      archetype: "goblin",
      position: destinationPoint(origin, 5, 90),
      regionCode: "NM",
      zoneId: "world:NM",
      packId: "goblin-city:one",
      npcFaction: {
        cityId: "city-one",
        cityName: "Goblin Village",
        culture: "goblin",
        role: "warrior",
        presentationKey: "goblin_warrior",
        invulnerable: true
      }
    });

    expect(() => engine.startAttack(request("enemy", defender.entityId, "unconfirmed")))
      .toThrow(/Confirm hostility/);
    engine.markNpcCityPlayerEnemy("city-one", "enemy");
    expect(() => engine.startAttack(request("enemy", defender.entityId, "confirmed")))
      .not.toThrow();
    expect(() => engine.startAttack(request("neutral", defender.entityId, "isolated")))
      .toThrow(/Confirm hostility/);
    for (let tick = 0; tick < 80; tick += 1) engine.tick();
    expect(engine.entity(defender.entityId)?.currentHealth).toBe(
      engine.entity(defender.entityId)?.maxHealth
    );
  });

  it("lets durable Goblin defenders reacquire enemies, close as a pack, and survive clear", () => {
    const engine = createEngine({
      canMobProactivelyAcquire: () => true,
      canMobContinueIntent: () => true
    });
    const playerPosition = destinationPoint(origin, 220, 90);
    addPlayer(engine, "enemy", playerPosition);
    const melee = engine.spawnMob({
      archetype: "goblin",
      position: origin,
      homePosition: origin,
      regionCode: "NM",
      zoneId: "world:NM",
      packId: "goblin-city:one",
      worldAi: true,
      npcFaction: {
        cityId: "city-one", cityName: "Goblin Village", culture: "goblin",
        role: "warrior", presentationKey: "goblin_warrior", invulnerable: true,
        annexRadiusM: 130
      }
    });
    const towerPosition = destinationPoint(origin, 500, 270);
    const towerArcher = engine.spawnMob({
      archetype: "goblin",
      position: towerPosition,
      homePosition: towerPosition,
      regionCode: "NM",
      zoneId: "world:NM",
      packId: "goblin-city:one",
      worldAi: true,
      movementSpeedMpsOverride: 0,
      attackRangeMOverride: 1_000,
      npcFaction: {
        cityId: "city-one", cityName: "Goblin Village", culture: "goblin",
        role: "archer", presentationKey: "goblin_archer", invulnerable: true,
        annexRadiusM: 500
      }
    });

    engine.tick();
    expect(engine.entity(melee.entityId)?.targetEntityId).toBeNull();
    expect(engine.entity(towerArcher.entityId)?.targetEntityId).toBeNull();

    engine.markNpcCityPlayerEnemy("city-one", "enemy");
    engine.tick();
    expect(engine.entity(melee.entityId)?.targetEntityId).toBe("enemy");
    expect(engine.entity(towerArcher.entityId)?.targetEntityId).toBe("enemy");
    const before = engine.entity(melee.entityId)!;
    for (let tick = 0; tick < 120; tick += 1) engine.tick();
    const after = engine.entity(melee.entityId)!;
    expect(distanceMeters({ lat: after.lat, lon: after.lon }, playerPosition))
      .toBeLessThan(distanceMeters({ lat: before.lat, lon: before.lon }, playerPosition));
    expect(engine.entity("enemy")!.currentHealth).toBeLessThan(100);
    expect(engine.entity(towerArcher.entityId)?.targetEntityId).toBe("enemy");

    expect(engine.clearMobs()).toBe(0);
    expect(engine.entity(melee.entityId)).not.toBeNull();
    expect(engine.entity(towerArcher.entityId)).not.toBeNull();
  });
});

describe("CombatEngine ordinary military attacks", () => {
  it("applies fused infantry damage once for each surviving member", () => {
    const engine = createEngine();
    addPlayer(engine, "owner", origin);
    addPlayer(engine, "target", east(50));
    const plan = planMilitaryGroupAttack("infantry", 6)!;

    expect(engine.applyMilitaryAttack({
      attackerPlayerId: "owner",
      targetEntityId: "target",
      damage: plan.damage,
      rangeM: plan.rangeM,
      attackOrigin: origin,
      sourceTechniqueId: plan.sourceTechniqueId
    })).toBe(66);
    expect(engine.entity("target")?.currentHealth).toBe(34);
  });

  it("uses melee and ranged profiles while preserving target legality", () => {
    const engine = createEngine();
    addPlayer(engine, "owner", origin);
    addPlayer(engine, "melee-target", east(101));
    addPlayer(engine, "archer-target", east(250));
    addPlayer(engine, "far-target", east(301));

    expect(() => engine.applyMilitaryAttack({
      attackerPlayerId: "owner",
      targetEntityId: "melee-target",
      damage: 11,
      rangeM: MELEE_ATTACK_RANGE_M,
      attackOrigin: origin,
      sourceTechniqueId: "military_infantry_basic_attack"
    })).toThrowError(expect.objectContaining({ code: "COMBAT_TARGET_OUT_OF_RANGE" }));
    expect(engine.applyMilitaryAttack({
      attackerPlayerId: "owner",
      targetEntityId: "archer-target",
      damage: 9,
      rangeM: RANGED_ATTACK_RANGE_M,
      attackOrigin: origin,
      sourceTechniqueId: "military_archer_basic_attack"
    })).toBe(9);
    expect(() => engine.applyMilitaryAttack({
      attackerPlayerId: "owner",
      targetEntityId: "far-target",
      damage: 9,
      rangeM: RANGED_ATTACK_RANGE_M,
      attackOrigin: origin,
      sourceTechniqueId: "military_archer_basic_attack"
    })).toThrowError(expect.objectContaining({ code: "COMBAT_TARGET_OUT_OF_RANGE" }));
    expect(() => engine.applyMilitaryAttack({
      attackerPlayerId: "owner",
      targetEntityId: "owner",
      damage: 11,
      rangeM: MELEE_ATTACK_RANGE_M,
      attackOrigin: origin,
      sourceTechniqueId: "military_infantry_basic_attack"
    })).toThrowError(expect.objectContaining({ code: "COMBAT_TARGET_INVALID" }));
  });

  it("keeps ordinary Bomber damage available while Ballistas stay structure-only", () => {
    const engine = createEngine();
    addPlayer(engine, "owner", origin);
    addPlayer(engine, "target", east(50));
    const plan = planMilitaryGroupAttack("bomber", 1)!;

    expect(engine.applyMilitaryAttack({
      attackerPlayerId: "owner",
      targetEntityId: "target",
      damage: plan.damage,
      rangeM: plan.rangeM,
      attackOrigin: origin,
      sourceTechniqueId: plan.sourceTechniqueId
    })).toBe(2);
    expect(planMilitaryGroupAttack("field_ballista", 1)).toBeNull();
  });
});

describe("CombatEngine mob combat modifier provider", () => {
  const bossOwnership = {
    bossId: "test_boss", bossRevision: 1, encounterHandlerId: "dungeon", hostKind: "dungeon" as const,
    hostInstanceId: "dungeon:test", encounterInstanceId: "dungeon:test:run:boss:1:s1", lifeGeneration: 1
  };

  it("absorbs hits while a non-boss mob's incoming multiplier is zero, and stops when it clears", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const mob = engine.spawnMob({ archetype: "wolf", position: east(5), regionCode: "NM", zoneId: "world:NM" });
    let shielded = true;
    engine.setMobCombatModifierProvider((id) => id === mob.entityId && shielded ? { incomingDamageMultiplier: 0 } : null);
    expect(engine.applyScriptedDamage("p1", mob.entityId, 2, "warrior_basic_attack")).toBe(0);
    expect(engine.entity(mob.entityId)!.currentHealth).toBe(mob.maxHealth);
    shielded = false;
    expect(engine.applyScriptedDamage("p1", mob.entityId, 2, "warrior_basic_attack")).toBeGreaterThan(0);
  });

  it("scales a non-boss mob's outgoing damage by the provider multiplier", () => {
    const hitOnPlayer = (multiplier: number | null) => {
      const engine = createEngine();
      addPlayer(engine, "p1", origin);
      const mob = engine.spawnMob({ archetype: "hog", position: east(5), regionCode: "NM", zoneId: "world:NM" });
      engine.setMobCombatModifierProvider(multiplier === null ? null : () => ({ outgoingDamageMultiplier: multiplier }));
      return engine.applyScriptedDamage(mob.entityId, "p1", 10, "enemy_basic_attack");
    };
    const base = hitOnPlayer(null);
    expect(base).toBeGreaterThan(0);
    expect(hitOnPlayer(1.4)).toBeGreaterThan(base);
  });

  it("leaves boss mobs on the boss provider only", () => {
    const run = (withMobProvider: boolean) => {
      const engine = createEngine();
      addPlayer(engine, "p1", origin);
      const boss = engine.spawnMob({
        archetype: "wolf", position: east(5), regionCode: "NM", zoneId: "world:NM",
        bossLifecycleState: "active", bossOwnership
      });
      engine.setBossCombatModifierProvider(() => ({ incomingDamageMultiplier: 0.5, outgoingDamageMultiplier: 2 }));
      if (withMobProvider) engine.setMobCombatModifierProvider(() => ({ incomingDamageMultiplier: 0, outgoingDamageMultiplier: 0 }));
      return {
        taken: engine.applyScriptedDamage("p1", boss.entityId, 4, "warrior_basic_attack"),
        dealt: engine.applyScriptedDamage(boss.entityId, "p1", 10, "enemy_basic_attack")
      };
    };
    const without = run(false);
    expect(without.taken).toBeGreaterThan(0);
    expect(without.dealt).toBeGreaterThan(0);
    expect(run(true)).toEqual(without);
  });
});

it("records real tick durations in the rolling history", () => {
  const engine = createEngine();
  expect(engine.tickHistorySnapshot().tickMs.count).toBe(0);
  engine.tick();
  engine.tick();
  expect(engine.tickHistorySnapshot().tickMs.count).toBe(2);
  expect(engine.tickHistorySnapshot().tickMs.max).toBeGreaterThanOrEqual(0);
});

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

function addPlayer(
  engine: CombatEngine,
  playerId: string,
  position: LatLon,
  damage = 10,
  currentHealth = 100
): void {
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
      maxHealth: 100,
      currentHealth,
      baseAttackDamage: damage
    }
  });
}

function syncPlayerPosition(
  engine: CombatEngine,
  playerId: string,
  position: LatLon
): void {
  engine.syncPlayer({
    playerId,
    position,
    regionCode: "NM",
    zoneId: "world:NM"
  });
}

function setCurrentHealth(
  engine: CombatEngine,
  entityId: string,
  currentHealth: number
): void {
  const state = engine as unknown as {
    entities: Map<string, { currentHealth: number }>;
  };
  state.entities.get(entityId)!.currentHealth = currentHealth;
}

function givingTreeState(engine: CombatEngine): {
  givingTreeReferenceCounts: Map<string, number>;
  givingTreePositions: Map<string, LatLon>;
  givingTreeGrid: { size: number };
} {
  return engine as unknown as {
    givingTreeReferenceCounts: Map<string, number>;
    givingTreePositions: Map<string, LatLon>;
    givingTreeGrid: { size: number };
  };
}

function request(attackerId: string, targetEntityId: string, requestId: string) {
  return {
    attackerId,
    targetEntityId,
    requestId,
    accountId: `account-${attackerId}`,
    connectionId: `connection-${attackerId}`
  };
}

function east(distanceM: number): LatLon {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, distanceM);
}

function north(distanceM: number): LatLon {
  return destinationPoint(origin, distanceM, 0);
}

function south(distanceM: number): LatLon {
  return destinationPoint(origin, distanceM, 180);
}

function moveMobForInterestTest(engine: CombatEngine, entityId: string, position: LatLon): void {
  const runtime = engine as unknown as {
    entities: Map<string, { position: LatLon; revision: number }>;
    grid: { update(id: string, next: LatLon): void };
    dirtyEntityIds: Set<string>;
  };
  const entity = runtime.entities.get(entityId)!;
  entity.position = position;
  entity.revision += 1;
  runtime.grid.update(entityId, position);
  runtime.dirtyEntityIds.add(entityId);
}

import {
  BASIC_ATTACK_INTERVAL_MS,
  PVE_AGGRO_ABANDON_TIMEOUT_MS,
  destinationPoint,
  distanceMeters,
  type CombatEvent,
  type LatLon,
  type MobArchetypeKey
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { CombatEngine } from "./combatEngine.js";
import { MOB_AI_PROFILES } from "./mobDefinitions.js";

const origin = { lat: 35.0844, lon: -106.6504 };
/** One full player+enemy beat and its half (the enemy phase offset), in 20 Hz ticks. */
const BEAT = BASIC_ATTACK_INTERVAL_MS * 20 / 1_000;
const HALF = BEAT / 2;

describe("configuration-driven world mob AI", () => {
  it("protects a flag arrival from proactive mobs until movement or expiry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const engine = harness({ canMobProactivelyAcquire: () => true });
      addPlayer(engine);
      const wolf = spawn(engine, "wolf", east(1));

      expect(engine.grantFlagArrivalProtection("player", 1)).toBe(400_000);
      engine.tick();

      expect(engine.entity(wolf.entityId)).toMatchObject({
        targetEntityId: null,
        activityState: "idle"
      });
      expect(engine.applyScriptedDamage(wolf.entityId, "player", 10, "test-hit")).toBe(0);
      expect(engine.applyScriptedRoot(wolf.entityId, "player", 3_000)).toBe(false);
      expect(engine.entity("player")?.currentHealth).toBe(100);

      engine.syncPlayer({
        playerId: "player",
        position: origin,
        regionCode: "NM",
        zoneId: "world:NM"
      });
      expect(engine.flagArrivalProtectionUntil("player")).toBe(400_000);

      engine.syncPlayer({
        playerId: "player",
        position: east(1),
        regionCode: "NM",
        zoneId: "world:NM"
      });
      expect(engine.flagArrivalProtectionUntil("player")).toBeNull();
      expect(engine.grantFlagArrivalProtection("player", 1)).toBeNull();

      expect(engine.grantFlagArrivalProtection("player", 2)).toBe(400_000);
      vi.advanceTimersByTime(300_000);
      expect(engine.flagArrivalProtectionUntil("player")).toBeNull();
      for (let tick = 0; tick < 61; tick += 1) engine.tick();
      expect(engine.entity(wolf.entityId)?.targetEntityId).toBe("player");
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches an already-engaged proactive mob when flag protection begins", () => {
    const engine = harness({ canMobProactivelyAcquire: () => true });
    addPlayer(engine);
    const wolf = spawn(engine, "wolf", east(1));
    for (let tick = 0; tick < 61; tick += 1) engine.tick();
    expect(engine.entity(wolf.entityId)?.targetEntityId).toBe("player");

    engine.grantFlagArrivalProtection("player", 1);

    expect(engine.entity(wolf.entityId)).toMatchObject({
      targetEntityId: null,
      activityState: "returning"
    });
    expect(engine.entity("player")?.pveCombat).toBeNull();
  });

  it("does not let a protected jellyfish hit apply harmful statuses", () => {
    const engine = harness();
    addPlayer(engine);
    const jellyfish = spawn(engine, "jellyfish", east(1));
    engine.grantFlagArrivalProtection("player", 1);

    expect(engine.applyScriptedDamage(
      jellyfish.entityId,
      "player",
      10,
      "enemy_basic_attack"
    )).toBe(0);
    expect(engine.entity("player")?.harmfulStatusIds).toEqual([]);
  });

  it("ends flag arrival protection when the player starts a valid attack", () => {
    const engine = harness();
    addPlayer(engine);
    const hog = spawn(engine, "hog", east(1));
    engine.grantFlagArrivalProtection("player", 1);

    engine.startAttack(request(hog.entityId));

    expect(engine.flagArrivalProtectionUntil("player")).toBeNull();
  });

  it("keeps an unprovoked Deer stationary at any player distance", () => {
    const engine = harness({ canMobProactivelyAcquire: () => true });
    addPlayer(engine);
    const deer = spawn(engine, "deer", east(1));
    const before = position(engine, deer.entityId);

    for (let tick = 0; tick < 200; tick += 1) engine.tick();

    expect(position(engine, deer.entityId)).toEqual(before);
    expect(engine.entity(deer.entityId)).toMatchObject({
      targetEntityId: null,
      activityState: "idle",
      aiPresentation: null
    });
    expect(engine.entity("player")?.pveCombat).toBeNull();
  });

  it.each(["deer", "sap_crawler", "wolf"] satisfies MobArchetypeKey[])(
    "waits for a landed hit before the %s exact pack retaliates",
    (archetype) => {
      const engine = harness({ canMobProactivelyAcquire: () => true });
      addPlayer(engine, 1);
      const pack = spawnPack(engine, archetype, `${archetype}-pack`, 3, east(20));
      const unrelated = spawnPack(engine, archetype, `other-${archetype}-pack`, 2, east(40));

      engine.tick();
      engine.startAttack(request(pack[1]!.entityId));
      expect(engine.entity("player")?.pveCombat?.enemyQueue).toEqual([]);
      expect(pack.every((mob) =>
        engine.entity(mob.entityId)?.targetEntityId === null
      )).toBe(true);
      engine.tick();

      expect(new Set(engine.entity("player")?.pveCombat?.enemyQueue))
        .toEqual(new Set(pack.map((mob) => mob.entityId)));
      expect(pack.every((mob) =>
        engine.entity(mob.entityId)?.targetEntityId === "player"
      )).toBe(true);
      expect(unrelated.every((mob) =>
        engine.entity(mob.entityId)?.targetEntityId === null
      )).toBe(true);
      expect(pack.every((mob) =>
        engine.entity(mob.entityId)?.activityState !== "fleeing"
      )).toBe(true);
    }
  );

  it("refreshes a solo mob's abandonment timeout from the latest landed player hit", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const engine = harness();
      addPlayer(engine, 1);
      const hog = spawn(engine, "hog", east(1));

      engine.startAttack(request(hog.entityId));
      engine.tick();
      engine.cancelAttack("player");

      vi.advanceTimersByTime(PVE_AGGRO_ABANDON_TIMEOUT_MS - 1);
      expect(engine.applyScriptedDamage("player", hog.entityId, 1, "test-hit")).toBe(1);
      vi.advanceTimersByTime(1);
      engine.tick();

      expect(engine.entity("player")?.pveCombat).not.toBeNull();
      expect(engine.entity(hog.entityId)?.targetEntityId).toBe("player");

      vi.advanceTimersByTime(PVE_AGGRO_ABANDON_TIMEOUT_MS);
      engine.tick();

      expect(engine.entity("player")?.pveCombat).toBeNull();
      expect(engine.entity(hog.entityId)).toMatchObject({
        targetEntityId: null,
        activityState: "returning"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes every surviving group member when one queued mob is hit", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const engine = harness();
      addPlayer(engine, 1);
      const pack = spawnPack(engine, "sap_crawler", "aggro-refresh-pack", 3, east(1));

      engine.startAttack(request(pack[1]!.entityId));
      engine.tick();
      expect(engine.applyScriptedDamage("player", pack[2]!.entityId, 100, "group-test-defeat"))
        .toBeGreaterThan(0);
      engine.cancelAttack("player");
      const survivors = pack.slice(0, 2);
      expect(new Set(engine.entity("player")?.pveCombat?.enemyQueue))
        .toEqual(new Set(survivors.map((mob) => mob.entityId)));

      vi.advanceTimersByTime(PVE_AGGRO_ABANDON_TIMEOUT_MS - 1);
      expect(engine.applyScriptedDamage("player", pack[0]!.entityId, 1, "group-test-hit"))
        .toBe(1);
      vi.advanceTimersByTime(1);
      engine.tick();

      expect(new Set(engine.entity("player")?.pveCombat?.enemyQueue))
        .toEqual(new Set(survivors.map((mob) => mob.entityId)));
      expect(survivors.every((mob) => engine.entity(mob.entityId)?.targetEntityId === "player"))
        .toBe(true);

      vi.advanceTimersByTime(PVE_AGGRO_ABANDON_TIMEOUT_MS);
      engine.tick();

      expect(engine.entity("player")?.pveCombat).toBeNull();
      expect(survivors.every((mob) => engine.entity(mob.entityId)?.targetEntityId === null))
        .toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not refresh mob aggro when either side hits a player", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const engine = harness();
      addPlayer(engine, 1);
      engine.connectPlayer({
        playerId: "other-player",
        name: "Other Player",
        regionCode: "NM",
        zoneId: "world:NM",
        position: east(2),
        accountId: "account-other-player",
        connectionId: "connection-other-player",
        profile: {
          playerId: "other-player",
          maxHealth: 100,
          currentHealth: 100,
          baseAttackDamage: 1
        }
      });
      const hog = spawn(engine, "hog", east(1));

      engine.startAttack(request(hog.entityId));
      engine.tick();
      engine.cancelAttack("player");

      vi.advanceTimersByTime(PVE_AGGRO_ABANDON_TIMEOUT_MS - 1);
      expect(engine.applyScriptedDamage("player", "other-player", 1, "player-test-hit"))
        .toBe(1);
      expect(engine.applyScriptedDamage(hog.entityId, "player", 1, "mob-test-hit"))
        .toBe(1);
      vi.advanceTimersByTime(1);
      engine.tick();

      expect(engine.entity("player")?.pveCombat).toBeNull();
      expect(engine.entity(hog.entityId)).toMatchObject({
        targetEntityId: null,
        activityState: "returning"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an attacked Deer where combat expires instead of returning it home", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const engine = harness({
        getAuthoritativeViewCircle: () => ({ center: origin, radiusM: 650, generation: 1 })
      });
      addPlayer(engine, 1);
      const deer = engine.spawnMob({
        archetype: "deer",
        worldAi: true,
        position: east(200),
        homePosition: east(250),
        regionCode: "NM",
        zoneId: "world:NM"
      });

      engine.startAttack(request(deer.entityId));
      engine.syncPlayer({
        playerId: "player",
        position: east(150),
        regionCode: "NM",
        zoneId: "world:NM"
      });
      engine.tick();

      vi.advanceTimersByTime(PVE_AGGRO_ABANDON_TIMEOUT_MS);
      engine.tick();
      const stoppedPosition = position(engine, deer.entityId);
      engine.tick();

      expect(engine.entity("player")?.pveCombat).toBeNull();
      expect(engine.entity(deer.entityId)).toMatchObject({
        targetEntityId: null,
        activityState: "idle",
        aiPresentation: null
      });
      expect(position(engine, deer.entityId)).toEqual(stoppedPosition);
      expect(distanceMeters(stoppedPosition, east(250))).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "hog",
    "frog",
    "alligator",
    "squid",
    "jellyfish"
  ] satisfies MobArchetypeKey[])("keeps %s attacked-only and single-target", (archetype) => {
    const engine = harness();
    addPlayer(engine, 1);
    const [first, second] = spawnPack(engine, archetype, `${archetype}-pack`, 2, east(10));

    engine.tick();
    expect(engine.entity(first!.entityId)?.targetEntityId).toBeNull();
    engine.startAttack(request(first!.entityId));
    expect(engine.entity(first!.entityId)?.targetEntityId).toBeNull();
    expect(engine.entity("player")?.pveCombat?.enemyQueue).toEqual([]);
    engine.tick();

    expect(engine.entity(first!.entityId)?.targetEntityId).toBe("player");
    expect(engine.entity(second!.entityId)?.targetEntityId).toBeNull();
  });

  it("rolls the ogre swamp shout once per acquisition start", () => {
    const roll = (value: number) => {
      const random = vi.fn(() => value);
      const engine = harness({ canMobProactivelyAcquire: () => true, random });
      addPlayer(engine);
      const ogre = spawn(engine, "ogre", east(200));
      engine.tick();
      const acquiredAt = Date.now();
      const speech = engine.entity(ogre.entityId)?.ambientSpeech;
      const rolls = random.mock.calls.length;
      for (let tick = 0; tick < 5; tick += 1) engine.tick();
      expect(engine.entity(ogre.entityId)?.aiPresentation?.phase).toBe("acquiring");
      expect(random.mock.calls.length).toBe(rolls);
      return { speech, acquiredAt };
    };
    const hit = roll(0.005);
    expect(hit.speech?.text).toBe("THIS IS MY SWAMP!");
    expect(hit.speech!.expiresAt).toBeGreaterThan(hit.acquiredAt + 2_000);
    expect(hit.speech!.expiresAt).toBeLessThanOrEqual(hit.acquiredAt + 3_100);
    expect(roll(0.5).speech).toBeUndefined();
  });

  it("warns for three seconds before the nearest Wolf exact pack acquires inside 150m", () => {
    const engine = harness({ canMobProactivelyAcquire: () => true });
    addPlayer(engine);
    const near = spawnPack(engine, "wolf", "near-wolves", 3, east(140));
    const far = spawnPack(engine, "wolf", "far-wolves", 3, east(170));

    const warningStartedAt = Date.now();
    engine.tick();
    expect(engine.entity(near[0]!.entityId)).toMatchObject({
      targetEntityId: null,
      aiPresentation: { phase: "acquiring", intent: "combat", deadlineAt: expect.any(Number) }
    });
    const deadlineAt = engine.entity(near[0]!.entityId)!.aiPresentation!.deadlineAt!;
    expect(deadlineAt).toBeGreaterThanOrEqual(warningStartedAt + 3_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 3_000);
    for (let tick = 0; tick < 59; tick += 1) engine.tick();
    expect(near.every((mob) => engine.entity(mob.entityId)?.targetEntityId === null)).toBe(true);
    expect(engine.entity("player")?.currentHealth).toBe(100);
    engine.tick();

    expect(near.every((mob) =>
      engine.entity(mob.entityId)?.targetEntityId === "player"
    )).toBe(true);
    expect(far.every((mob) =>
      engine.entity(mob.entityId)?.targetEntityId === null
    )).toBe(true);
    expect(engine.entity("player")?.targetEntityId).toBeNull();
    expect(engine.entity("player")?.pveCombat?.enemyQueue).toEqual([]);
  });

  it("acquires a nearby player across an outdoor package boundary", () => {
    const engine = harness({ canMobProactivelyAcquire: () => true });
    addPlayer(engine);
    const bear = engine.spawnMob({
      archetype: "bear",
      worldAi: true,
      position: east(10),
      homePosition: east(10),
      regionCode: "adjacent-package",
      zoneId: "world:adjacent-package"
    });

    engine.tick();

    expect(engine.entity(bear.entityId)?.targetEntityId).toBe("player");
  });

  it("continues mob intent when the player crosses an outdoor package boundary", () => {
    const engine = harness({
      canMobProactivelyAcquire: () => true,
      canMobContinueIntent: () => true
    });
    addPlayer(engine);
    const bear = spawn(engine, "bear", east(10));
    engine.tick();
    engine.syncPlayer({
      playerId: "player",
      position: origin,
      regionCode: "adjacent-package",
      zoneId: "world:adjacent-package"
    });

    engine.tick();

    expect(engine.entity(bear.entityId)?.targetEntityId).toBe("player");
  });

  it("rotates proximity Wolves through one passive enemy opportunity every beat", () => {
    const engine = harness({ canMobProactivelyAcquire: () => true });
    addPlayer(engine);
    const wolves = spawnPack(engine, "wolf", "passive-player-wolves", 3, east(10));
    const initialHealth = engine.entity("player")!.currentHealth;
    engine.beginDeltaFlush();
    const events: CombatEvent[] = [];

    for (let tick = 0; tick < 125; tick += 1) {
      engine.tick();
      events.push(...engine.beginDeltaFlush().events);
      if (tick === 59) expect(engine.entity("player")!.currentHealth).toBe(initialHealth);
    }

    expect(engine.entity("player")!.currentHealth).toBeLessThan(initialHealth);
    expect(engine.entity("player")?.targetEntityId).toBeNull();
    expect(engine.entity("player")?.pveCombat?.enemyQueue).toEqual(wolves.map((wolf) => wolf.entityId));
    expect(engine.isPlayerAggressive("player")).toBe(false);
    const hits = enemyDamage(events);
    expect(hits.map((event) => event.tick)).toEqual([61 + HALF, 61 + HALF + BEAT]);
    expect(hits.map((event) => event.sourceEntityId)).toEqual([
      wolves[0]!.entityId,
      wolves[1]!.entityId
    ]);
  });

  it("skips an out-of-range Wolf and lets the next queued Wolf use the opportunity", () => {
    const engine = harness({ canMobProactivelyAcquire: () => true });
    addPlayer(engine);
    const packId = "fallback-wolves";
    const wolves = [east(10), west(60), east(60)].map((at, index) =>
      engine.spawnMob({
        entityId: `${packId}:${index}`,
        archetype: "wolf",
        worldAi: true,
        packId,
        position: at,
        homePosition: at,
        regionCode: "NM",
        zoneId: "world:NM"
      })
    );
    for (let tick = 0; tick < 61; tick += 1) engine.tick();
    expect(engine.entity("player")?.pveCombat?.enemyQueue).toEqual(wolves.map((wolf) => wolf.entityId));
    for (let tick = 0; tick < HALF - 1; tick += 1) engine.tick();
    engine.syncPlayer({ playerId: "player", position: west(130), regionCode: "NM", zoneId: "world:NM" });
    expect(distanceMeters(position(engine, wolves[0]!.entityId), west(130))).toBeGreaterThan(100);
    expect(distanceMeters(position(engine, wolves[1]!.entityId), west(130))).toBeLessThan(100);
    engine.beginDeltaFlush();

    engine.tick();

    expect(enemyDamage(engine.beginDeltaFlush().events).map((event) => event.sourceEntityId))
      .toEqual([wolves[1]!.entityId]);
  });

  it("ends a bounded enemy scan without damage when no queued Wolf can hit", () => {
    const engine = harness({ canMobProactivelyAcquire: () => true });
    addPlayer(engine);
    const wolves = spawnPack(engine, "wolf", "bounded-wolves", 3, east(10));
    for (let tick = 0; tick < 61; tick += 1) engine.tick();
    for (let tick = 0; tick < HALF - 1; tick += 1) engine.tick();
    engine.syncPlayer({ playerId: "player", position: west(100), regionCode: "NM", zoneId: "world:NM" });
    engine.beginDeltaFlush();

    engine.tick();

    expect(enemyDamage(engine.beginDeltaFlush().events)).toEqual([]);
    expect(engine.entity("player")?.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: wolves.map((wolf) => wolf.entityId)
    });
  });

  it.each([
    ["wolf", 140, 60],
    ["ogre", 250, 100]
  ] as const)("resets the full %s warning when the player leaves and reenters range", (archetype, distanceM, delayTicks) => {
    const engine = harness({ canMobProactivelyAcquire: () => true });
    addPlayer(engine);
    const mob = spawn(engine, archetype, east(distanceM));

    for (let tick = 0; tick < delayTicks; tick += 1) engine.tick();
    expect(engine.entity(mob.entityId)).toMatchObject({
      targetEntityId: null,
      aiPresentation: { phase: "acquiring", intent: "combat" }
    });
    engine.syncPlayer({
      playerId: "player",
      position: east(600),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.tick();
    expect(engine.entity(mob.entityId)?.aiPresentation).toBeNull();

    engine.syncPlayer({
      playerId: "player",
      position: origin,
      regionCode: "NM",
      zoneId: "world:NM"
    });
    for (let tick = 0; tick < delayTicks; tick += 1) engine.tick();
    expect(engine.entity(mob.entityId)?.targetEntityId).toBeNull();
    engine.tick();
    expect(engine.entity(mob.entityId)?.targetEntityId).toBe("player");
  });

  it("makes a Bear attack immediately and disengage after five seconds outside 300m", () => {
    const engine = harness({
      canMobProactivelyAcquire: () => true,
      getAuthoritativeViewCircle: () => ({ center: origin, radiusM: 2_000, generation: 1 })
    });
    addPlayer(engine);
    const bear = spawn(engine, "bear", east(250));
    engine.tick();
    expect(engine.entity(bear.entityId)?.targetEntityId).toBe("player");

    engine.syncPlayer({
      playerId: "player",
      position: east(600),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    for (let tick = 0; tick < 50; tick += 1) {
      engine.syncPlayer({
        playerId: "player",
        position: east(600 + tick * 2),
        regionCode: "NM",
        zoneId: "world:NM"
      });
      engine.tick();
    }
    expect(engine.entity(bear.entityId)).toMatchObject({
      targetEntityId: "player",
      aiPresentation: { phase: "disengaging", intent: "combat" }
    });

    engine.syncPlayer({
      playerId: "player",
      position: position(engine, bear.entityId),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.tick();
    expect(engine.entity(bear.entityId)).toMatchObject({
      targetEntityId: "player",
      aiPresentation: null
    });

    for (let tick = 0; tick < 99; tick += 1) {
      engine.syncPlayer({
        playerId: "player",
        position: east(1_200 + tick * 2),
        regionCode: "NM",
        zoneId: "world:NM"
      });
      engine.tick();
    }
    expect(engine.entity(bear.entityId)).toMatchObject({
      targetEntityId: "player",
      aiPresentation: { phase: "disengaging", intent: "combat" }
    });
    engine.tick();
    engine.tick();
    expect(engine.entity(bear.entityId)).toMatchObject({
      targetEntityId: null,
      activityState: "returning"
    });
  });

  it.each(["wolf", "ogre"] satisfies MobArchetypeKey[])(
    "lets a player run out %s aggro, then returns the mob home",
    (archetype) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(100_000));
        const engine = harness({
          canMobProactivelyAcquire: () => true,
          getAuthoritativeViewCircle: () => ({ center: origin, radiusM: 650, generation: 1 })
        });
        addPlayer(engine);
        const mob = archetype === "wolf"
          ? spawnPack(engine, "wolf", "timeout-pack", 2, east(100))[0]!
          : spawn(engine, "ogre", east(100));
        if (archetype === "ogre") {
          for (let tick = 0; tick < 101; tick += 1) engine.tick();
        } else {
          for (let tick = 0; tick < 61; tick += 1) engine.tick();
        }
        expect(engine.entity(mob.entityId)?.targetEntityId).toBe("player");

        engine.syncPlayer({
          playerId: "player",
          position: east(600),
          regionCode: "NM",
          zoneId: "world:NM"
        });
        vi.advanceTimersByTime(PVE_AGGRO_ABANDON_TIMEOUT_MS);
        engine.tick();
        expect(engine.entity("player")?.pveCombat).toBeNull();
        expect(engine.entity(mob.entityId)).toMatchObject({
          targetEntityId: null,
          activityState: "returning"
        });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("keeps combat aggro active through a soft disconnect", () => {
    const engine = harness({ canMobProactivelyAcquire: () => true });
    addPlayer(engine);
    const wolf = spawnPack(engine, "wolf", "linkdead-pack", 2, east(10))[0]!;
    for (let tick = 0; tick < 61; tick += 1) engine.tick();
    engine.suspendPlayerAuthority("player");
    const before = engine.entity("player")!.currentHealth;
    for (let tick = 0; tick < 20; tick += 1) engine.tick();

    expect(engine.entity(wolf.entityId)?.targetEntityId).toBe("player");
    expect(engine.entity("player")?.pveCombat).not.toBeNull();
    expect(engine.entity("player")!.currentHealth).toBeLessThan(before);
  });

  it("has the Mysterious Traveler watch from 300m without opening combat", () => {
    let valid = true;
    const engine = harness({
      canMobProactivelyAcquire: () => valid,
      canMobContinueIntent: () => valid
    });
    addPlayer(engine);
    const traveler = spawn(engine, "mysterious_traveler", east(350));
    engine.tick();
    expect(engine.entity(traveler.entityId)).toMatchObject({
      targetEntityId: null,
      aiPresentation: { phase: "observing", intent: "observe" }
    });
    expect(engine.entity("player")?.pveCombat).toBeNull();

    engine.suspendPlayerAuthority("player");
    engine.tick();
    expect(engine.entity(traveler.entityId)?.aiPresentation).toMatchObject({
      phase: "observing",
      intent: "observe"
    });

    engine.syncPlayer({
      playerId: "player",
      position: east(500),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const before = position(engine, traveler.entityId);
    engine.tick();
    expect(distanceMeters(before, position(engine, traveler.entityId))).toBeGreaterThan(0);
    expect(engine.entity("player")?.pveCombat).toBeNull();

    valid = false;
    engine.invalidateMobAiPlayer("player");
    expect(engine.entity(traveler.entityId)).toMatchObject({
      targetEntityId: null,
      activityState: "idle",
      aiPresentation: null
    });
  });

  it("keeps Traveler observation inside the authoritative gameplay view", () => {
    const engine = harness({
      canMobProactivelyAcquire: () => true,
      canMobContinueIntent: () => true,
      getAuthoritativeViewCircle: () => ({ center: origin, radiusM: 650, generation: 1 })
    });
    addPlayer(engine);
    engine.syncPlayer({
      playerId: "player",
      position: east(600),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const traveler = spawn(engine, "mysterious_traveler", east(620));

    for (let tick = 0; tick < 40; tick += 1) engine.tick();

    expect(distanceMeters(origin, position(engine, traveler.entityId))).toBeLessThanOrEqual(650.1);
    expect(engine.entity(traveler.entityId)).toMatchObject({
      targetEntityId: null,
      aiPresentation: { phase: "observing", intent: "observe" }
    });
    expect(engine.entity("player")?.pveCombat).toBeNull();
  });

  it("makes Traveler observation yield to retaliation and resume afterward", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const engine = harness({
        canMobProactivelyAcquire: () => true,
        canMobContinueIntent: () => true
      });
      addPlayer(engine, 1);
      const traveler = spawn(engine, "mysterious_traveler", east(100));
      engine.tick();
      engine.syncPlayer({
        playerId: "player",
        position: position(engine, traveler.entityId),
        regionCode: "NM",
        zoneId: "world:NM"
      });
      engine.startAttack(request(traveler.entityId));
      engine.tick();
      expect(engine.entity(traveler.entityId)?.targetEntityId).toBe("player");

      vi.advanceTimersByTime(PVE_AGGRO_ABANDON_TIMEOUT_MS);
      engine.tick();
      expect(engine.entity(traveler.entityId)).toMatchObject({
        targetEntityId: null,
        aiPresentation: { phase: "observing", intent: "observe" }
      });
      expect(engine.entity("player")?.pveCombat).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps behavior selection in profiles instead of archetype branches", () => {
    expect(MOB_AI_PROFILES.deer.proactive).toBeNull();
    expect(MOB_AI_PROFILES.deer.onAttacked?.group).toBe("exact_pack");
    expect(MOB_AI_PROFILES.deer.endDisposition).toBe("idle_current");
    expect(MOB_AI_PROFILES.wolf.proactive).toEqual({
      intent: "combat",
      radiusM: 150,
      acquisitionDelayMs: 3_000
    });
    expect(MOB_AI_PROFILES.wolf.countdown).toBe("acquisition");
    expect(MOB_AI_PROFILES.wolf.endDisposition).toBe("return_home");
    expect(MOB_AI_PROFILES.ogre.proactive).toEqual({
      intent: "combat",
      radiusM: 300,
      acquisitionDelayMs: 5_000
    });
    expect(MOB_AI_PROFILES.ogre.endDisposition).toBe("return_home");
    expect(MOB_AI_PROFILES.bear.proactive).toEqual({
      intent: "combat",
      radiusM: 300,
      acquisitionDelayMs: 0
    });
    expect(MOB_AI_PROFILES.bear.disengagement).toEqual({
      kind: "outside_radius",
      radiusM: 300,
      graceMs: 5_000
    });
    expect(MOB_AI_PROFILES.bear.endDisposition).toBe("return_home");
    expect(MOB_AI_PROFILES.sap_crawler.onAttacked?.group).toBe("exact_pack");
    expect(MOB_AI_PROFILES.sap_crawler.proactive).toBeNull();
    expect(MOB_AI_PROFILES.hog.proactive).toBeNull();
    expect(MOB_AI_PROFILES.frog.proactive).toBeNull();
    expect(MOB_AI_PROFILES.alligator.proactive).toBeNull();
    expect(MOB_AI_PROFILES.squid.proactive).toBeNull();
    expect(MOB_AI_PROFILES.jellyfish.proactive).toBeNull();
    expect(MOB_AI_PROFILES.mysterious_traveler.proactive).toEqual({
      intent: "observe",
      radiusM: 400,
      acquisitionDelayMs: 0
    });
    expect(MOB_AI_PROFILES.mysterious_traveler.movement).toEqual({
      kind: "standoff",
      distanceM: 300,
      deadbandM: 25
    });
    expect(MOB_AI_PROFILES.mysterious_traveler.endDisposition).toBe("idle_current");
  });
});

function harness(
  overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}
): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    ...overrides
  });
}

function addPlayer(engine: CombatEngine, baseAttackDamage = 10): void {
  engine.connectPlayer({
    playerId: "player",
    name: "Player",
    regionCode: "NM",
    zoneId: "world:NM",
    position: origin,
    accountId: "account-player",
    connectionId: "connection-player",
    profile: {
      playerId: "player",
      maxHealth: 100,
      currentHealth: 100,
      baseAttackDamage
    }
  });
}

function spawn(
  engine: CombatEngine,
  archetype: MobArchetypeKey,
  at: LatLon
) {
  return engine.spawnMob({
    archetype,
    worldAi: true,
    position: at,
    homePosition: at,
    regionCode: "NM",
    zoneId: "world:NM"
  });
}

function spawnPack(
  engine: CombatEngine,
  archetype: MobArchetypeKey,
  packId: string,
  count: number,
  anchor: LatLon
) {
  return Array.from({ length: count }, (_, index) => spawnAtPackPosition(
    engine,
    archetype,
    packId,
    index,
    anchor
  ));
}

function spawnAtPackPosition(
  engine: CombatEngine,
  archetype: MobArchetypeKey,
  packId: string,
  index: number,
  anchor: LatLon
) {
  const at = destinationPoint(anchor, index * 4, 90);
  return engine.spawnMob({
    entityId: `${packId}:${index}`,
    archetype,
    worldAi: true,
    packId,
    position: at,
    homePosition: at,
    regionCode: "NM",
    zoneId: "world:NM"
  });
}

function request(targetEntityId: string) {
  return {
    attackerId: "player",
    targetEntityId,
    requestId: `attack:${targetEntityId}`,
    accountId: "account-player",
    connectionId: "connection-player"
  };
}

function east(distanceM: number): LatLon {
  return destinationPoint(origin, distanceM, 90);
}

function west(distanceM: number): LatLon {
  return destinationPoint(origin, distanceM, 270);
}

function position(engine: CombatEngine, entityId: string): LatLon {
  const entity = engine.entity(entityId)!;
  return { lat: entity.lat, lon: entity.lon };
}

function enemyDamage(events: CombatEvent[]) {
  return events.filter((event) =>
    event.type === "DAMAGE" && event.targetEntityId === "player"
  );
}

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BASIC_ATTACK_INTERVAL_MS,
  CLASS_ABILITY_ACTIVATION_LOCKOUT_MS,
  moveToward,
  type ClassSnapshot,
  type CombatEvent,
  type EquipmentSnapshot,
  type LatLon
} from "@ash-atlas/shared";

import { CombatEngine, CombatRequestError } from "./combatEngine.js";
import { newMobSpecialState } from "./mobSpecialBehaviors.js";

const origin = { lat: 35.0844, lon: -106.6504 };
/** One full player+enemy beat and its half (the enemy phase offset), in 20 Hz ticks. */
const BEAT = BASIC_ATTACK_INTERVAL_MS * 20 / 1_000;
const HALF = BEAT / 2;

afterEach(() => vi.useRealTimers());

describe("authoritative PvE enemy-action queue", () => {
  it("keeps focus stable while Taunt-eligible enemies rotate after player actions", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const mobs = [5, 7, 9, 11, 13].map((distance) => spawnGoblin(engine, distance));
    const tauntedMobs = mobs.slice(0, 3);

    engine.startAttack(request("p1", mobs[0]!.entityId, "focus"));
    const taunt = engine.useUniversalTaunt(authority("p1"));
    // The reduced Taunt radius includes the 5/7/9 m mobs and deliberately leaves
    // the 11/13 m mobs outside the owned combat rotation.
    expect(taunt.pveCombat).toMatchObject({
      focusTargetEntityId: mobs[0]!.entityId,
      enemyQueue: tauntedMobs.map((mob) => mob.entityId),
      queueCursor: 0,
      phase: "enemy_pending"
    });

    const enemySources: string[] = [];
    for (let tick = 0; tick < 180 && enemySources.length < tauntedMobs.length; tick += 1) {
      engine.tick();
      const frame = engine.beginDeltaFlush();
      enemySources.push(...frame.events
        .filter((event) => event.type === "DAMAGE" && event.targetEntityId === "p1")
        .map((event) => event.sourceEntityId!)
      );
    }

    expect(enemySources).toEqual(tauntedMobs.map((mob) => mob.entityId));
    expect(enemySources).not.toContain(mobs[3]!.entityId);
    expect(enemySources).not.toContain(mobs[4]!.entityId);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(mobs[0]!.entityId);
  });

  it("does not reorder the queue on focus switch and selects the first living fallback", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1_000);
    const mobs = [5, 7, 9].map((distance) => spawnGoblin(engine, distance));
    engine.startAttack(request("p1", mobs[0]!.entityId, "first"));
    engine.useUniversalTaunt(authority("p1"));
    const originalOrder = engine.entity("p1")!.pveCombat!.enemyQueue;

    engine.startAttack(request("p1", mobs[2]!.entityId, "switch"));
    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      focusTargetEntityId: mobs[2]!.entityId,
      enemyQueue: originalOrder
    });

    for (let tick = 0; tick < 2 * BEAT && engine.entity(mobs[2]!.entityId); tick += 1) engine.tick();
    expect(engine.entity(mobs[2]!.entityId)).toBeNull();
    expect(engine.entity("p1")?.pveCombat?.enemyQueue).toEqual(originalOrder.slice(0, 2));
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(originalOrder[0]);
  });

  it("moves an out-of-range enemy continuously without keeping it in the active rotation", () => {
    const engine = createEngine(650);
    addPlayer(engine, "p1", origin);
    const mob = spawnGoblin(engine, 10);
    engine.startAttack(request("p1", mob.entityId, "start"));
    engine.tick();
    engine.syncPlayer({ playerId: "p1", position: east(150), regionCode: "NM", zoneId: "world:NM" });

    for (let tick = 0; tick < HALF + 1; tick += 1) engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBe(100);
    expect(engine.entity(mob.entityId)?.activityState).toBe("chasing");
    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: [mob.entityId],
      queueCursor: 0
    });
  });

  it("resolves normal actives without displacing the scheduled basic or duplicating the enemy response", () => {
    vi.useFakeTimers();
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const mob = spawnGoblin(engine, 10);
    configureWarrior(engine, "p1", [], ["warrior_anger_explosion", "warrior_battle_cry"], 100);
    engine.startAttack(request("p1", mob.entityId, "start"));

    const explosion = engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_anger_explosion" });
    expect(explosion.classCombat?.rage).toBe(0);
    expect(explosion.pveCombat?.phase).toBe("enemy_pending");
    vi.advanceTimersByTime(CLASS_ABILITY_ACTIVATION_LOCKOUT_MS);
    const battleCry = engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_battle_cry" });
    expect(battleCry.pveCombat?.pendingNormalAbilityId).toBeNull();
    expect(battleCry.classCombat?.rage).toBe(0);

    for (let tick = 0; tick < HALF; tick += 1) engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBeLessThan(100);
    expect(engine.entity("p1")?.pveCombat?.pendingNormalAbilityId).toBeNull();
  });

  it("arms one next-attack empowerment and resolves it once", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const mob = spawnGoblin(engine, 10);
    configureWarrior(
      engine,
      "p1",
      [],
      ["warrior_empowered_hit"],
      100
    );
    engine.startAttack(request("p1", mob.entityId, "start"));

    const buffered = engine.useNormalAbility({
      ...authority("p1"),
      abilityId: "warrior_empowered_hit"
    });
    expect(buffered.classCombat?.rage).toBe(0);

    engine.beginDeltaFlush();
    engine.tick();
    const playerDamage = engine.beginDeltaFlush().events.filter((event) =>
      event.type === "DAMAGE" && event.sourceEntityId === "p1"
    );
    expect(playerDamage).toHaveLength(1);
    expect(engine.entity("p1")?.classCombat?.rage).toBe(0);
    expect(engine.entity("p1")?.classCombat?.cooldownEndsAt.warrior_empowered_hit).toBeGreaterThan(Date.now());
    expect(engine.entity("p1")?.pveCombat?.phase).toBe("enemy_pending");

    expect(() => engine.useNormalAbility({
      ...authority("p1"),
      abilityId: "warrior_empowered_hit"
    })).toThrowError(CombatRequestError);
    for (let tick = 0; tick < HALF; tick += 1) engine.tick();
    expect(engine.entity("p1")?.currentHealth).toBeLessThan(100);
  });

  it("accepts an empowerment anywhere between beats without moving the scheduled attack", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const mob = spawnGoblin(engine, 10);
    configureWarrior(engine, "p1", [], ["warrior_empowered_hit"], 100);
    engine.startAttack(request("p1", mob.entityId, "start"));
    engine.tick();
    engine.beginDeltaFlush();
    const before = pveDeadlines(engine)?.nextBasicAttackTick;
    tickAndCollect(engine, 8);
    engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_empowered_hit" });
    expect(pveDeadlines(engine)?.nextBasicAttackTick).toBe(before);
    const hits = tickAndCollect(engine, 2 * BEAT - 8).filter((event) =>
      event.type === "DAMAGE" && event.sourceEntityId === "p1"
    );
    expect(hits.map((event) => event.tick)).toEqual([1 + BEAT, 1 + 2 * BEAT]);
    expect(hits[0]?.amount).toBeGreaterThan(hits[1]?.amount ?? 0);
  });

  it("Taunt preserves focus, appends eligible mobs by distance then id, excludes players, and enforces cooldown", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "other-player", east(6));
    const focus = spawnGoblin(engine, 10);
    const near = spawnGoblin(engine, 5);
    const tiedA = spawnGoblin(engine, 8);
    const tiedB = spawnGoblin(engine, 8);
    const outside = spawnGoblin(engine, 25);
    engine.startAttack(request("p1", focus.entityId, "focus"));
    engine.tick(); // Ownership begins with the first landed hit.

    const result = engine.useUniversalTaunt(authority("p1"));
    const tied = [tiedA.entityId, tiedB.entityId].sort();
    expect(result.pveCombat?.focusTargetEntityId).toBe(focus.entityId);
    expect(result.pveCombat?.enemyQueue).toEqual([
      focus.entityId,
      near.entityId,
      ...tied
    ]);
    expect(result.pveCombat?.enemyQueue).not.toContain(outside.entityId);
    expect(result.pveCombat?.enemyQueue).not.toContain("other-player");
    expect(() => engine.useUniversalTaunt(authority("p1"))).toThrow(/cooling down/i);
  });

  it("assigns first-aggro ownership so a shared mob cannot attack from two player queues", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(2));
    const mob = spawnGoblin(engine, 8);
    engine.startAttack(request("p1", mob.entityId, "p1-start"));
    engine.tick(); // Ownership begins with the first landed hit.
    expect(() => engine.startAttack(request("p2", mob.entityId, "p2-start")))
      .toThrowError(/owned by another player/i);

    expect(engine.entity("p1")?.pveCombat?.enemyQueue).toEqual([mob.entityId]);
    expect(engine.entity("p2")?.pveCombat).toBeNull();
    for (let tick = 0; tick < HALF + 1; tick += 1) engine.tick();
    // Level 10 Goblin: Dagger row into bare skin (level 1), 9.5 + 10 - 1.
    expect(engine.entity("p1")?.currentHealth).toBe(81);
    expect(engine.entity("p2")?.currentHealth).toBe(100);
  });

  it("does not let an unrelated player's Taunt steal an already-owned mob", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    addPlayer(engine, "p2", east(2));
    const mob = spawnGoblin(engine, 8);
    engine.startAttack(request("p1", mob.entityId, "p1-owns"));
    engine.tick(); // Ownership begins with the first landed hit.

    const result = engine.useUniversalTaunt(authority("p2"));

    expect(result.pveCombat).toBeNull();
    expect(engine.entity(mob.entityId)?.targetEntityId).toBe("p1");
    expect(engine.entity("p1")?.pveCombat?.enemyQueue).toEqual([mob.entityId]);
    expect(engine.entity("p2")?.pveCombat).toBeNull();
  });

  it("holds an exact 20 Hz player/enemy metronome for several rounds without drift", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 10);
    const mob = spawnGoblin(engine, 10);
    engine.startAttack(request("p1", mob.entityId, "metronome"));
    engine.beginDeltaFlush();

    const events = tickAndCollect(engine, 1 + 2 * BEAT);
    expect(damageTicks(events, "p1", mob.entityId)).toEqual([1, 1 + BEAT, 1 + 2 * BEAT]);
    expect(damageTicks(events, mob.entityId, "p1")).toEqual([1 + HALF, 1 + HALF + BEAT]);
    expect(events.some((event) => event.type === "DAMAGE" && event.tick === 2)).toBe(false);
  });

  it("keeps three enemies on one deterministic opportunity every enemy phase", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1);
    const mobs = [5, 7, 9].map((distance) => spawnGoblin(engine, distance));
    engine.startAttack(request("p1", mobs[0]!.entityId, "multi-focus"));
    engine.useUniversalTaunt(authority("p1"));
    engine.beginDeltaFlush();

    const events = tickAndCollect(engine, 3 * BEAT + HALF);
    const enemyHits = events.filter((event) =>
      event.type === "DAMAGE" && event.targetEntityId === "p1"
    );
    expect(enemyHits.map((event) => event.tick)).toEqual([HALF, 1 + HALF + BEAT, 1 + HALF + 2 * BEAT]);
    expect(enemyHits.map((event) => event.sourceEntityId)).toEqual([
      mobs[0]!.entityId,
      mobs[1]!.entityId,
      mobs[2]!.entityId
    ]);
  });

  it("keeps every between-beat empowerment activation anchored to the same deadlines", () => {
    for (const offset of [0, 7, 15, 23] as const) {
      const engine = createEngine();
      addPlayer(engine, "p1", origin);
      const mob = spawnGoblin(engine, 10);
      configureWarrior(engine, "p1", [], ["warrior_empowered_hit"], 100);
      engine.startAttack(request("p1", mob.entityId, `empower-${offset}`));
      engine.tick();
      const anchored = pveDeadlines(engine);
      expect(anchored).toEqual({ playerTurnAnchorTick: 1, enemyActionAtTick: 1 + HALF, nextBasicAttackTick: 1 + BEAT });
      tickAndCollect(engine, offset);
      engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_empowered_hit" });
      expect(pveDeadlines(engine)?.nextBasicAttackTick).toBe(anchored?.nextBasicAttackTick);
    }
  });

  it("keeps damaging, support, and Taunt actions from moving the next basic beat", () => {
    const actions = ["damage", "support", "taunt"] as const;
    for (const action of actions) {
      const engine = createEngine();
      addPlayer(engine, "p1", origin);
      const mob = spawnGoblin(engine, 10);
      engine.startAttack(request("p1", mob.entityId, `action-${action}`));
      engine.tick();
      if (action === "taunt") {
        engine.useUniversalTaunt(authority("p1"));
      } else {
        const abilityId = action === "damage" ? "warrior_anger_explosion" : "warrior_battle_cry";
        configureWarrior(engine, "p1", [], [abilityId], 100);
        engine.useNormalAbility({ ...authority("p1"), abilityId });
      }
      expect(pveDeadlines(engine)).toEqual({
        playerTurnAnchorTick: 1,
        enemyActionAtTick: 1 + HALF,
        nextBasicAttackTick: 1 + BEAT
      });
    }
  });

  it.each([
    "warrior_empowered_hit",
    "warrior_anger_explosion",
    "warrior_concussive_blow",
    "warrior_battle_cry"
  ])("continues scheduled basic attacks after using %s between beats", (abilityId) => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1);
    const mob = spawnGoblin(engine, 10);
    configureWarrior(engine, "p1", [], [abilityId], 100);
    engine.startAttack(request("p1", mob.entityId, `cadence-${abilityId}`));
    engine.tick();
    engine.beginDeltaFlush();
    tickAndCollect(engine, 8);

    engine.useNormalAbility({ ...authority("p1"), abilityId });
    engine.beginDeltaFlush();

    const events = tickAndCollect(engine, 2 * BEAT - 8);
    expect(damageTicks(events, "p1", mob.entityId)).toEqual([1 + BEAT, 1 + 2 * BEAT]);
  });

  it("repairs a missing basic timer when a Warrior skill resolves between beats", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1);
    const mob = spawnGoblin(engine, 10);
    configureWarrior(engine, "p1", [], ["warrior_battle_cry"], 100);
    engine.startAttack(request("p1", mob.entityId, "repair-cadence"));
    engine.tick();
    engine.beginDeltaFlush();
    tickAndCollect(engine, HALF + 1);
    clearScheduledAttack(engine, "p1");

    engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_battle_cry" });
    engine.beginDeltaFlush();

    const events = tickAndCollect(engine, 2 * BEAT - HALF - 1);
    expect(damageTicks(events, "p1", mob.entityId)).toEqual([1 + BEAT, 1 + 2 * BEAT]);
  });

  it("cancels before the enemy deadline without resolving stale enemy work", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin);
    const mob = spawnGoblin(engine, 10);
    engine.startAttack(request("p1", mob.entityId, "cancel-before-enemy"));
    engine.tick();
    engine.beginDeltaFlush();
    expect(engine.cancelCombat("p1")).toBe(true);
    const events = tickAndCollect(engine, BEAT + 8);
    expect(damageTicks(events, mob.entityId, "p1")).toEqual([]);
    expect(engine.entity("p1")?.pveCombat).toBeNull();
  });
});

function createEngine(viewRadiusM = 20): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    getAuthoritativeViewCircle: () => ({
      center: origin,
      radiusM: viewRadiusM,
      generation: 1
    }),
    isPlayerAuthorityActive: () => true
  });
}

function addPlayer(engine: CombatEngine, playerId: string, position: LatLon, damage = 10): void {
  engine.connectPlayer({
    playerId,
    name: playerId,
    regionCode: "NM",
    zoneId: "world:NM",
    position,
    accountId: `account-${playerId}`,
    connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth: 100, currentHealth: 100, baseAttackDamage: damage }
  });
  configureKnight(engine, playerId);
}

function spawnGoblin(engine: CombatEngine, distanceM: number) {
  const snapshot = engine.spawnMob({
    archetype: "goblin",
    position: east(distanceM),
    regionCode: "NM",
    zoneId: "world:NM"
  });
  // These cadence tests measure the shared 1.6s attack rhythm, so keep the goblin bomb out of the event stream.
  const raw = (engine as unknown as { entities: Map<string, { special?: unknown }> }).entities.get(snapshot.entityId)!;
  raw.special = { ...newMobSpecialState(), nextGimmickTick: Number.MAX_SAFE_INTEGER };
  return snapshot;
}

function clearScheduledAttack(engine: CombatEngine, entityId: string): void {
  const entity = (engine as unknown as {
    entities: Map<string, { scheduledAttackTick: number | null; attackScheduleGeneration: number }>;
  }).entities.get(entityId);
  if (!entity) throw new Error(`missing combat entity ${entityId}`);
  entity.scheduledAttackTick = null;
  entity.attackScheduleGeneration += 1;
}

function configureKnight(engine: CombatEngine, playerId: string): void {
  const snapshot: ClassSnapshot = {
    playerId,
    characterLevel: 25,
    activeClassId: "knight",
    activeSubclassId: null,
    unlockedClassIds: ["warrior"],
    warrior: {
      classId: "warrior",
      level: 0,
      xp: 0,
      nextLevelXp: 1_193,
      completedAt: null
    },
    knight: {
      classId: "knight",
      level: 3,
      xp: 4_257,
      nextLevelXp: 6_212,
      completedAt: null
    },
    classes: [
      { classId: "warrior", level: 0, xp: 0, nextLevelXp: 1_193, completedAt: null },
      { classId: "knight", level: 3, xp: 4_257, nextLevelXp: 6_212, completedAt: null }
    ],
    subclasses: [],
    loadout: {
      resetActives: [null, null],
      normalActives: ["knight_taunt", null],
      passiveTiers: [null, null, null], ultimateActive: null
    },
    legacyIds: [],
    rage: 0,
    maximumRage: 0,
    queuedAbility: null,
    cooldownEndsAt: {},
    serverTime: Date.now(),
    revision: 1
  };
  engine.updatePlayerClassState(playerId, snapshot, equipment(playerId), {
    rage: 0,
    rageReserved: 0,
    queuedAbilityId: null,
    queuedTargetEntityId: null,
    queuedAtTick: null,
    cooldownEndsAt: {},
    statusEffects: [],
    counters: {},
    combatGeneration: 0,
    lastCombatAt: null
  });
}

function configureWarrior(
  engine: CombatEngine,
  playerId: string,
  resetActives: string[],
  normalActives: string[],
  rage: number
): void {
  const snapshot: ClassSnapshot = {
    playerId,
    characterLevel: 25,
    activeClassId: "warrior",
    activeSubclassId: null,
    warrior: { classId: "warrior", level: 25, xp: 38_000, nextLevelXp: null, completedAt: null },
    subclasses: [
      { subclassId: "reaver", unlocked: false },
      { subclassId: "warden", unlocked: false }
    ],
    loadout: {
      resetActives: [resetActives[0] ?? null, resetActives[1] ?? null],
      normalActives: [normalActives[0] ?? null, normalActives[1] ?? null],
      passiveTiers: [null, null, null], ultimateActive: null
    },
    legacyIds: [],
    rage,
    maximumRage: 100,
    queuedAbility: null,
    cooldownEndsAt: {},
    serverTime: Date.now(),
    revision: 1
  };
  engine.updatePlayerClassState(playerId, snapshot, equipment(playerId), {
    rage,
    rageReserved: 0,
    queuedAbilityId: null,
    queuedTargetEntityId: null,
    queuedAtTick: null,
    cooldownEndsAt: {},
    statusEffects: [],
    counters: {},
    combatGeneration: 0,
    lastCombatAt: null
  });
}

function equipment(playerId: string): EquipmentSnapshot {
  return {
    playerId,
    instances: [],
    weapon: {
      instanceId: "00000000-0000-4000-8000-000000000001",
      definitionId: "starter_sword",
      displayName: "Starter Sword",
      ownerPlayerId: playerId,
      location: "equipped",
      equippedSlot: "weapon",
      attackPowerBonus: 2,
      defenseBonus: 0,
      weaponCategory: "sword",
      armorCategory: null,
      twoHanded: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    },
    chest: null,
    totalAttackPowerBonus: 2,
    totalDefenseBonus: 0
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

function authority(playerId: string) {
  return {
    playerId,
    accountId: `account-${playerId}`,
    connectionId: `connection-${playerId}`
  };
}

function east(distanceM: number): LatLon {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, distanceM);
}

function tickAndCollect(engine: CombatEngine, ticks: number): CombatEvent[] {
  const events: CombatEvent[] = [];
  for (let index = 0; index < ticks; index += 1) {
    engine.tick();
    events.push(...engine.beginDeltaFlush().events);
  }
  return events;
}

function damageTicks(events: CombatEvent[], sourceEntityId: string, targetEntityId: string): number[] {
  return events.filter((event) =>
    event.type === "DAMAGE" &&
    event.sourceEntityId === sourceEntityId &&
    event.targetEntityId === targetEntityId
  ).map((event) => event.tick);
}

function pveDeadlines(engine: CombatEngine): {
  playerTurnAnchorTick: number | null;
  enemyActionAtTick: number | null;
  nextBasicAttackTick: number | null;
} | null {
  const internal = engine as unknown as {
    pveSessions: Map<string, {
      playerTurnAnchorTick: number | null;
      enemyActionAtTick: number | null;
      nextBasicAttackTick: number | null;
    }>;
  };
  const session = internal.pveSessions.get("p1");
  return session ? {
    playerTurnAnchorTick: session.playerTurnAnchorTick,
    enemyActionAtTick: session.enemyActionAtTick,
    nextBasicAttackTick: session.nextBasicAttackTick
  } : null;
}

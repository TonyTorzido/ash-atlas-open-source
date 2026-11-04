import { describe, expect, it, vi } from "vitest";

import {
  BASIC_ATTACK_INTERVAL_MS,
  MELEE_ATTACK_RANGE_M,
  MAX_PVE_ENEMY_QUEUE_SIZE,
  RANGED_ATTACK_RANGE_M,
  distanceMeters,
  moveToward,
  universalTauntRadiusM,
  type ClassSnapshot,
  type CombatEvent,
  type EquipmentSnapshot,
  type LatLon
} from "@ash-atlas/shared";

import { loadConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { ConnectionRegistry, type SocketLike } from "../../realtime/connectionRegistry.js";
import { GameState } from "../state.js";
import { packageIdForPosition, zoneIdForPosition } from "../spatialZones.js";
import { WorldRuntime } from "../worldRuntime.js";
import { CombatEngine, CombatRequestError } from "./combatEngine.js";
import { newMobSpecialState } from "./mobSpecialBehaviors.js";
import type { CombatBalanceSummary } from "./combatTelemetry.js";

/** One full player+enemy beat and its half (the enemy phase offset), in 20 Hz ticks. */
const BEAT = BASIC_ATTACK_INTERVAL_MS * 20 / 1_000;
const HALF = BEAT / 2;

const origin = { lat: 35.0844, lon: -106.6504 };

describe("PvE queue acceptance: removal, settlement, and ownership", () => {
  it.each([
    { relation: "before", targetIndex: 0, expectedCursor: 0, expectedNextIndex: 1, expectedFocusIndex: 1 },
    { relation: "at", targetIndex: 1, expectedCursor: 1, expectedNextIndex: 2, expectedFocusIndex: 0 },
    { relation: "after", targetIndex: 2, expectedCursor: 1, expectedNextIndex: 1, expectedFocusIndex: 0 }
  ])(
    "repairs removal $relation the cursor and gives the next stable enemy exactly one turn",
    ({ targetIndex, expectedCursor, expectedNextIndex, expectedFocusIndex }) => {
      const engine = createEngine();
      addPlayer(engine, "p1", origin, { maxHealth: 1_000, damage: 10 });
      const mobs = [5, 7, 9, 11].map((distance) => spawnGoblin(engine, distance));
      engine.startAttack(request("p1", mobs[0]!.entityId, "initial-focus"));
      engine.useUniversalTaunt(authority("p1"));
      engine.beginDeltaFlush();

      for (let tick = 0; tick < 16; tick += 1) engine.tick();
      expect(enemyDamage(engine.beginDeltaFlush().events, "p1").map((event) => event.sourceEntityId))
        .toEqual([mobs[0]!.entityId]);
      expect(engine.entity("p1")?.pveCombat?.queueCursor).toBe(1);

      engine.updatePlayerPveStats("p1", {
        level: 25,
        maxHealth: 1_000,
        attackPower: 1_000,
        defense: 0
      });
      const removed = mobs[targetIndex]!;
      engine.startAttack(request("p1", removed.entityId, `remove-${targetIndex}`));
      tickUntil(engine, () => engine.entity(removed.entityId) === null, 30);

      const expectedQueue = mobs
        .filter((_, index) => index !== targetIndex)
        .map((mob) => mob.entityId);
      expect(engine.entity("p1")?.pveCombat).toMatchObject({
        enemyQueue: expectedQueue,
        queueCursor: expectedCursor,
        focusTargetEntityId: mobs[expectedFocusIndex]!.entityId,
        phase: "enemy_pending"
      });

      const response = tickUntil(
        engine,
        (events) => enemyDamage(events, "p1").length > 0,
        40
      );
      expect(enemyDamage(response, "p1").map((event) => event.sourceEntityId))
        .toEqual([mobs[expectedNextIndex]!.entityId]);
    }
  );

  it("wraps the queue without changing focus or duplicating enemy turns", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000, damage: 1 });
    const mobs = [5, 7, 9].map((distance) => spawnGoblin(engine, distance));
    engine.startAttack(request("p1", mobs[0]!.entityId, "focus"));
    engine.useUniversalTaunt(authority("p1"));
    engine.beginDeltaFlush();

    const events = tickUntil(
      engine,
      (all) => enemyDamage(all, "p1").length >= 4,
      120
    );
    expect(enemyDamage(events, "p1").slice(0, 4).map((event) => event.sourceEntityId)).toEqual([
      mobs[0]!.entityId,
      mobs[1]!.entityId,
      mobs[2]!.entityId,
      mobs[0]!.entityId
    ]);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(mobs[0]!.entityId);
  });

  it("selects the first living stable fallback when the focused enemy dies", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000, damage: 1_000 });
    const mobs = [5, 7, 9].map((distance) => spawnGoblin(engine, distance));
    engine.useUniversalTaunt(authority("p1"));
    engine.startAttack(request("p1", mobs[0]!.entityId, "focus"));
    engine.beginDeltaFlush();

    tickUntil(engine, () => engine.entity(mobs[0]!.entityId) === null, 60);
    expect(engine.entity(mobs[0]!.entityId)).toBeNull();
    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      enemyQueue: [mobs[1]!.entityId, mobs[2]!.entityId],
      focusTargetEntityId: mobs[1]!.entityId
    });
    expect(engine.entity("p1")?.targetEntityId).toBe(mobs[1]!.entityId);
  });

  it("continues ranged basic attacks through in-range pursuers from the focused pack", () => {
    const engine = createEngineWithView(origin, 400);
    addPlayer(engine, "p1", origin, { maxHealth: 1_000, damage: 1_000 });
    setPlayerAttackRange(engine, "p1", RANGED_ATTACK_RANGE_M);
    const pack = spawnDeerPack(engine, "ranged-deer", [200, 220, 240]);
    engine.startAttack(request("p1", pack[0]!.entityId, "ranged-focus"));
    engine.beginDeltaFlush();

    engine.tick();
    expect(engine.beginDeltaFlush().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "DAMAGE",
        sourceEntityId: "p1",
        targetEntityId: pack[0]!.entityId
      })
    ]));
    expect(engine.entity(pack[0]!.entityId)).toBeNull();
    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: [pack[1]!.entityId, pack[2]!.entityId],
      focusTargetEntityId: pack[1]!.entityId
    });
    expect(engine.entity("p1")?.targetEntityId).toBe(pack[1]!.entityId);
    expect(distanceMeters(engine.entity("p1")!, engine.entity(pack[1]!.entityId)!))
      .toBeGreaterThan(MELEE_ATTACK_RANGE_M);

    const followup = tickUntil(
      engine,
      (events) => playerDamage(events, "p1").some((event) =>
        event.targetEntityId === pack[1]!.entityId
      ),
      40
    );
    expect(playerDamage(followup, "p1").at(-1)?.targetEntityId).toBe(pack[1]!.entityId);
    expect(engine.entity(pack[1]!.entityId)).toBeNull();
    expect(engine.entity("p1")?.targetEntityId).toBe(pack[2]!.entityId);
  });

  it("lets a manual attack change the preferred pack before falling back to other aggro", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000, damage: 1_000 });
    const firstPack = spawnDeerPack(engine, "first-pack", [5, 7]);
    const chosenPack = spawnDeerPack(engine, "chosen-pack", [10, 12]);
    engine.useUniversalTaunt(authority("p1"));

    engine.startAttack(request("p1", firstPack[0]!.entityId, "initial-pack"));
    engine.startAttack(request("p1", chosenPack[0]!.entityId, "manual-pack-change"));
    expect(engine.entity("p1")?.targetEntityId).toBe(chosenPack[0]!.entityId);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(chosenPack[0]!.entityId);
    engine.beginDeltaFlush();

    tickUntil(engine, () => engine.entity(chosenPack[0]!.entityId) === null, 40);
    expect(engine.entity("p1")?.targetEntityId).toBe(chosenPack[1]!.entityId);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(chosenPack[1]!.entityId);

    tickUntil(engine, () => engine.entity(chosenPack[1]!.entityId) === null, 80);
    expect(engine.entity("p1")?.targetEntityId).toBe(firstPack[0]!.entityId);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(firstPack[0]!.entityId);
  });

  it.each(["despawn", "invalid"] as const)(
    "does not let a %s enemy entry stall an owed queue action",
    (mode) => {
      const engine = createEngine();
      addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
      const mobs = [5, 7].map((distance) => spawnGoblin(engine, distance));
      engine.startAttack(request("p1", mobs[0]!.entityId, "focus"));
      engine.useUniversalTaunt(authority("p1"));
      engine.beginDeltaFlush();

      if (mode === "despawn") {
        expect(engine.clearMobs()).toBe(2);
      } else {
        engine.syncPlayer({
          playerId: "p1",
          position: east(100),
          regionCode: "NM",
          zoneId: "world:NM"
        });
      }

      for (let tick = 0; tick < 16; tick += 1) engine.tick();
      expect(enemyDamage(engine.beginDeltaFlush().events, "p1")).toHaveLength(0);
      expect(engine.entity("p1")?.pveCombat).toBeNull();
      if (mode === "invalid") {
        for (const mob of mobs) {
          expect(engine.entity(mob.entityId)?.targetEntityId).toBeNull();
        }
      }
    }
  );

  it("cancels before the enemy deadline without settling an old enemy action", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const mobs = [5, 7].map((distance) => spawnGoblin(engine, distance));
    engine.startAttack(request("p1", mobs[0]!.entityId, "focus"));
    engine.useUniversalTaunt(authority("p1"));
    engine.beginDeltaFlush();

    expect(engine.cancelCombat("p1")).toBe(true);
    expect(engine.entity("p1")?.pveCombat).toBeNull();
    for (let tick = 0; tick < 20; tick += 1) engine.tick();

    expect(enemyDamage(engine.beginDeltaFlush().events, "p1").map((event) => event.sourceEntityId))
      .toEqual([]);
    expect(engine.entity("p1")?.pveCombat).toBeNull();
  });

  it("cancels only the player's outgoing attack without releasing enemy aggro", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const mob = spawnGoblin(engine, 5);
    engine.startAttack(request("p1", mob.entityId, "focus"));
    engine.tick();
    engine.beginDeltaFlush();

    expect(engine.cancelAttack("p1")).toBe(true);
    expect(engine.entity("p1")).toMatchObject({
      targetEntityId: null,
      pveCombat: { enemyQueue: [mob.entityId] }
    });
    expect(engine.entity(mob.entityId)?.targetEntityId).toBe("p1");

    for (let tick = 0; tick < 16; tick += 1) engine.tick();
    expect(enemyDamage(engine.beginDeltaFlush().events, "p1")).toHaveLength(1);
    expect(engine.entity("p1")?.pveCombat).not.toBeNull();
  });

  it("keeps combat active without settling an early enemy action when movement starts", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.combat.spawnMob({
      archetype: "goblin",
      position: east(10),
      regionCode: packageIdForPosition(origin),
      zoneId: zoneIdForPosition(origin)
    });
    setup.combat.beginDeltaFlush();
    const connectionId = setup.connectionIds.get("p1")!;

    expect(setup.runtime.enqueue({
      kind: "universal-taunt",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "taunt"
    })).toMatchObject({ accepted: true });
    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "move",
      target: east(50)
    })).toMatchObject({ accepted: true });

    setup.runtime.tick(0);
    expect(enemyDamage(setup.combat.beginDeltaFlush().events, "p1").map((event) => event.sourceEntityId))
      .toEqual([]);
    expect(setup.combat.entity("p1")?.pveCombat).toMatchObject({
      enemyQueue: [expect.any(String)],
      phase: "enemy_pending"
    });
  });

  it("does not settle an old enemy action during disconnect removal", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const mob = spawnGoblin(engine, 5);
    engine.startAttack(request("p1", mob.entityId, "focus"));
    engine.useUniversalTaunt(authority("p1"));
    engine.beginDeltaFlush();

    engine.disconnectPlayer("p1");
    expect(enemyDamage(engine.beginDeltaFlush().events, "p1").map((event) => event.sourceEntityId))
      .toEqual([]);
    expect(engine.entity("p1")).toBeNull();
    expect(engine.entity(mob.entityId)?.targetEntityId).toBeNull();
  });

  it("rejects repeated attacks on a foreign-owned mob without queueing or dealing damage", () => {
    const engine = createEngine();
    addPlayer(engine, "owner", origin, { maxHealth: 1_000 });
    addPlayer(engine, "intruder", east(2), { maxHealth: 1_000, damage: 1_000 });
    const mob = spawnGoblin(engine, 8);
    engine.startAttack(request("owner", mob.entityId, "claim"));
    engine.tick();
    engine.beginDeltaFlush();
    const healthBefore = engine.entity(mob.entityId)!.currentHealth;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expectCombatError(
        () => engine.startAttack(request("intruder", mob.entityId, `steal-${attempt}`)),
        "MOB_AGGRO_OWNED"
      );
    }

    expect(engine.entity(mob.entityId)?.currentHealth).toBe(healthBefore);
    expect(engine.entity("intruder")?.pveCombat).toBeNull();
    expect(engine.entity("owner")?.pveCombat?.enemyQueue).toEqual([mob.entityId]);
    expect(playerDamage(engine.beginDeltaFlush().events, "intruder")).toHaveLength(0);
  });

  it("settles simultaneous claims on the first landed hit", () => {
    const engine = createEngine();
    addPlayer(engine, "first", origin, { maxHealth: 1_000 });
    addPlayer(engine, "second", east(2), { maxHealth: 1_000 });
    const mob = spawnGoblin(engine, 8);
    const healthBefore = mob.currentHealth;

    engine.startAttack(request("first", mob.entityId, "first-claim"));
    engine.startAttack(request("second", mob.entityId, "second-claim"));
    engine.beginDeltaFlush();
    engine.tick();

    const events = engine.beginDeltaFlush().events;
    expect(engine.entity(mob.entityId)?.currentHealth).toBe(healthBefore - 10);
    expect(playerDamage(events, "first")).toHaveLength(1);
    expect(playerDamage(events, "second")).toHaveLength(0);
    expect(engine.entity("first")?.pveCombat?.enemyQueue).toEqual([mob.entityId]);
    expect(engine.entity("second")?.pveCombat).toBeNull();
  });

  it("releases the exact session claim after abandonment and invalid spam cannot extend it", () => {
    vi.useFakeTimers();
    const engine = createEngine();
    addPlayer(engine, "owner", origin, { maxHealth: 1_000 });
    addPlayer(engine, "intruder", east(2), { maxHealth: 1_000 });
    const mob = spawnGoblin(engine, 8);
    engine.startAttack(request("owner", mob.entityId, "claim"));
    engine.tick();

    vi.advanceTimersByTime(9_999);
    expectCombatError(
      () => engine.startAttack(request("intruder", mob.entityId, "invalid-spam")),
      "MOB_AGGRO_OWNED"
    );
    vi.advanceTimersByTime(1);
    for (let tick = 0; tick < 16; tick += 1) engine.tick();
    expect(engine.entity("owner")?.pveCombat).toBeNull();
    expect(engine.entity(mob.entityId)?.targetEntityId).toBeNull();
    expect(() => engine.startAttack(request("intruder", mob.entityId, "claim-after-timeout"))).not.toThrow();
    expect(engine.entity("intruder")?.pveCombat?.enemyQueue).toEqual([]);
    engine.tick();
    expect(engine.entity("intruder")?.pveCombat?.enemyQueue).toEqual([mob.entityId]);
    vi.useRealTimers();
  });
});

describe("PvE queue acceptance: Warrior empowerment and command replay", () => {
  it("holds an activated empowerment at an out-of-range scheduled beat without moving cadence", () => {
    const engine = createEngineWithView(origin, 650);
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const mob = spawnGoblin(engine, 10);
    configureWarrior(
      engine,
      "p1",
      [],
      ["warrior_empowered_hit"],
      100
    );
    engine.startAttack(request("p1", mob.entityId, "focus"));
    engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_empowered_hit" });
    engine.beginDeltaFlush();

    engine.syncPlayer({
      playerId: "p1",
      position: east(150),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.tick();
    expect(playerDamage(engine.beginDeltaFlush().events, "p1")).toHaveLength(0);
    engine.tick();
    expect(engine.entity("p1")?.classCombat?.rage).toBe(0);

    engine.syncPlayer({
      playerId: "p1",
      position: origin,
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const events = tickUntil(engine, (all) => playerDamage(all, "p1").length > 0, 80);
    expect(playerDamage(events, "p1")).toHaveLength(1);
    expect(engine.entity("p1")?.classCombat?.cooldownEndsAt.warrior_empowered_hit).toBeGreaterThan(Date.now());
  });

  it("uses canonical focus when focus switches after an empowerment was armed", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const first = spawnGoblin(engine, 8);
    const second = spawnGoblin(engine, 10);
    configureWarrior(engine, "p1", [], ["warrior_empowered_hit"], 100);
    engine.startAttack(request("p1", first.entityId, "first"));
    engine.startAttack(request("p1", second.entityId, "second-queued"));
    engine.startAttack(request("p1", first.entityId, "first-focus"));
    engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_empowered_hit" });
    engine.startAttack(request("p1", second.entityId, "switch-after-buffer"));
    engine.beginDeltaFlush();

    engine.tick();
    const damage = playerDamage(engine.beginDeltaFlush().events, "p1");
    expect(damage).toHaveLength(1);
    expect(damage.every((event) => event.targetEntityId === second.entityId)).toBe(true);
    expect(engine.entity(first.entityId)?.currentHealth).toBe(first.currentHealth);
    expect(engine.entity("p1")?.pveCombat?.focusTargetEntityId).toBe(second.entityId);
  });

  it("spends on activation and consumes the empowered basic when it kills the last target", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000, damage: 1_000 });
    const mob = spawnGoblin(engine, 8);
    configureWarrior(engine, "p1", [], ["warrior_empowered_hit"], 100);
    engine.startAttack(request("p1", mob.entityId, "focus"));
    engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_empowered_hit" });
    engine.beginDeltaFlush();

    engine.tick();
    expect(playerDamage(engine.beginDeltaFlush().events, "p1")).toHaveLength(1);
    expect(engine.entity(mob.entityId)).toBeNull();
    expect(engine.entity("p1")?.pveCombat).toBeNull();
    expect(engine.entity("p1")?.classCombat?.rage).toBe(0);
    expect(engine.entity("p1")?.classCombat?.cooldownEndsAt.warrior_empowered_hit).toBeGreaterThan(Date.now());
  });

  it("rejects a second empowerment while the skill is cooling down", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const mob = spawnGoblin(engine, 8);
    configureWarrior(engine, "p1", [], ["warrior_empowered_hit"], 100);
    engine.startAttack(request("p1", mob.entityId, "focus"));
    engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_empowered_hit" });
    expect(engine.entity("p1")?.classCombat?.rage).toBe(0);
    expectCombatError(
      () => engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_empowered_hit" }),
      "EMPOWERMENT_ALREADY_ARMED"
    );
    expect(engine.entity("p1")?.classCombat?.rage).toBe(0);

    engine.tick();
    expectCombatError(() => engine.useNormalAbility({ ...authority("p1"), abilityId: "warrior_empowered_hit" }), "ABILITY_COOLDOWN");
  });

  it("rejects a duplicate world-command request before it can grant a second action", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const mob = setup.combat.spawnMob({
      archetype: "goblin",
      position: east(10),
      regionCode: packageIdForPosition(origin),
      zoneId: zoneIdForPosition(origin)
    });
    setup.combat.beginDeltaFlush();
    const command = {
      kind: "start-attack" as const,
      playerId: "p1",
      accountId: "account-p1",
      connectionId: setup.connectionIds.get("p1")!,
      requestId: "same-request",
      targetEntityId: mob.entityId
    };

    expect(setup.runtime.enqueue(command)).toMatchObject({ accepted: true });
    expect(setup.runtime.enqueue(command)).toEqual({ accepted: false, reason: "duplicate" });
    setup.runtime.tick(0);

    expect(playerDamage(setup.combat.beginDeltaFlush().events, "p1")).toHaveLength(1);
    expect(setup.combat.entity("p1")?.pveCombat?.enemyQueue).toEqual([mob.entityId]);
  });
});

describe("PvE queue acceptance: universal Taunt and safety cap", () => {
  it("rejects Taunt for a defeated player", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { currentHealth: 0 });

    expectCombatError(() => engine.useUniversalTaunt(authority("p1")), "COMBAT_ACTOR_INVALID");
    expect(engine.entity("p1")?.pveCombat).toBeNull();
    expect(engine.beginDeltaFlush().events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TAUNT_ACTIVATED" })
    ]));
  });

  it("targets from the player at half the active radius with deterministic inclusive boundaries", () => {
    const boundaryPosition = east(150);
    const boundaryDistanceM = distanceMeters(origin, boundaryPosition);
    const activeRadiusM = boundaryDistanceM * 2;
    const engine = createEngineWithView(origin, activeRadiusM);
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const inside = spawnWolf(engine, east(boundaryDistanceM - 0.01));
    const boundary = spawnWolf(engine, boundaryPosition);
    const outside = spawnWolf(engine, east(boundaryDistanceM + 0.01));

    const result = engine.useUniversalTaunt(authority("p1"));

    expect(universalTauntRadiusM(activeRadiusM)).toBe(boundaryDistanceM);
    expect(result.pveCombat?.pursuingEnemyIds).toEqual([inside.entityId, boundary.entityId]);
    for (const mob of [inside, boundary]) {
      expect(engine.entity(mob.entityId)).toMatchObject({
        targetEntityId: "p1",
        activityState: "chasing"
      });
    }
    expect(engine.entity(outside.entityId)).toMatchObject({
      targetEntityId: null,
      activityState: "idle"
    });
    expect(engine.beginDeltaFlush().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "TAUNT_ACTIVATED",
        sourceEntityId: "p1",
        position: origin,
        radiusM: boundaryDistanceM
      })
    ]));
  });

  it("targets from the player at half the active radius and emits the temporary pulse", () => {
    const boundaryPosition = east(150);
    const boundaryDistanceM = distanceMeters(origin, boundaryPosition);
    const activeRadiusM = boundaryDistanceM * 2;
    const engine = createEngineWithView(origin, activeRadiusM);
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const inside = spawnWolf(engine, east(boundaryDistanceM - 0.01));
    const boundary = spawnWolf(engine, boundaryPosition);
    const outside = spawnWolf(engine, east(boundaryDistanceM + 0.01));

    const result = engine.useUniversalTaunt(authority("p1"));

    expect(universalTauntRadiusM(activeRadiusM)).toBe(boundaryDistanceM);
    expect(result.pveCombat?.pursuingEnemyIds).toEqual([inside.entityId, boundary.entityId]);
    expect(engine.entity(outside.entityId)?.targetEntityId).toBeNull();
    expect(engine.beginDeltaFlush().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TAUNT_ACTIVATED", sourceEntityId: "p1", position: origin, radiusM: boundaryDistanceM })
    ]));
  });

  it("preserves order and focus, deduplicates discoveries, excludes outside targets, and enforces cooldown", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    addPlayer(engine, "human", east(6), { maxHealth: 1_000 });
    const focus = spawnGoblin(engine, 10);
    const near = spawnGoblin(engine, 5);
    const tiedA = spawnGoblin(engine, 8);
    const tiedB = spawnGoblin(engine, 8);
    const outside = spawnGoblin(engine, 21);
    engine.startAttack(request("p1", focus.entityId, "focus"));

    const result = engine.useUniversalTaunt(authority("p1"));
    const tied = [tiedA.entityId, tiedB.entityId].sort();
    expect(result.pveCombat).toMatchObject({
      focusTargetEntityId: focus.entityId,
      enemyQueue: [focus.entityId, near.entityId, ...tied],
      phase: "enemy_pending"
    });
    expect(new Set(result.pveCombat!.enemyQueue).size).toBe(result.pveCombat!.enemyQueue.length);
    expect(result.pveCombat!.enemyQueue).not.toContain(outside.entityId);
    expect(result.pveCombat!.enemyQueue).not.toContain("human");
    for (const mobId of [focus.entityId, near.entityId, ...tied]) {
      expect(engine.entity(mobId)?.targetEntityId).toBe("p1");
    }
    expect(engine.entity(outside.entityId)?.targetEntityId).toBeNull();
    expect(engine.entity("human")?.targetEntityId).toBeNull();
    expectCombatError(() => engine.useUniversalTaunt(authority("p1")), "ABILITY_COOLDOWN");
    expect(engine.entity("p1")?.pveCombat?.enemyQueue).toEqual([
      focus.entityId,
      near.entityId,
      ...tied
    ]);
  });

  it("keeps a distant Taunted enemy pursuing outside the active rotation", () => {
    const engine = createEngineWithView(origin, 650);
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const pursued = spawnGoblin(engine, 10);
    const outside = spawnGoblin(engine, 400);
    engine.useUniversalTaunt(authority("p1"));
    engine.beginDeltaFlush();
    engine.syncPlayer({
      playerId: "p1",
      position: east(150),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    for (let tick = 0; tick < 16; tick += 1) engine.tick();
    expect(enemyDamage(engine.beginDeltaFlush().events, "p1")).toHaveLength(0);
    expect(engine.entity(pursued.entityId)).toMatchObject({
      targetEntityId: "p1",
      activityState: "chasing"
    });
    expect(engine.entity(outside.entityId)?.targetEntityId).toBeNull();
    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: [pursued.entityId]
    });
  });

  it("uses the authoritative view only for discovery and chases the idle player's live position", () => {
    const flagCenter = east(200);
    const playerPosition = east(40);
    const view = { center: flagCenter, radiusM: 300, generation: 7 };
    const engine = new CombatEngine({
      tickRateHz: 20,
      playerMovementSpeedMps: 40,
      getAuthoritativeViewCircle: () => view,
      isPlayerAuthorityActive: () => true
    });
    addPlayer(engine, "p1", playerPosition, { maxHealth: 1_000 });
    const wolf = engine.spawnMob({
      archetype: "wolf",
      position: east(150),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const outside = engine.spawnMob({
      archetype: "wolf",
      position: moveToward(flagCenter, { lat: flagCenter.lat, lon: flagCenter.lon + 0.02 }, 300.5),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    const result = engine.useUniversalTaunt({ ...authority("p1"), viewGeneration: 7 });
    expect(result.pveCombat).toMatchObject({
      focusTargetEntityId: null,
      enemyQueue: [],
      pursuingEnemyIds: [wolf.entityId],
      activeViewCenter: flagCenter,
      activeViewRadiusM: 300,
      activeViewGeneration: 7
    });
    expect(result.pveCombat?.enemyQueue).not.toContain(outside.entityId);
    expect(engine.entity(wolf.entityId)).toMatchObject({
      targetEntityId: "p1",
      activityState: "chasing"
    });
    const beforeSnapshot = engine.entity(wolf.entityId)!;
    const beforePosition = { lat: beforeSnapshot.lat, lon: beforeSnapshot.lon };
    engine.tick();
    const afterSnapshot = engine.entity(wolf.entityId)!;
    const afterPosition = { lat: afterSnapshot.lat, lon: afterSnapshot.lon };
    expect(distanceMeters(afterPosition, playerPosition)).toBeLessThan(
      distanceMeters(beforePosition, playerPosition)
    );
    expect(distanceMeters(afterPosition, flagCenter)).toBeGreaterThan(
      distanceMeters(beforePosition, flagCenter)
    );

    const movedPlayerPosition = east(20);
    engine.syncPlayer({
      playerId: "p1",
      position: movedPlayerPosition,
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.tick();
    const afterPlayerMove = engine.entity(wolf.entityId)!;
    expect(distanceMeters(
      { lat: afterPlayerMove.lat, lon: afterPlayerMove.lon },
      movedPlayerPosition
    )).toBeLessThan(distanceMeters(afterPosition, movedPlayerPosition));
  });

  it("keeps an empty-queue Taunt session alive while an in-view wolf crosses its normal home leash", () => {
    const engine = createEngineWithView(origin, 620);
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const wolf = spawnWolf(engine, east(300));

    const taunt = engine.useUniversalTaunt(authority("p1"));
    expect(taunt.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: [wolf.entityId],
      phase: "waiting_player"
    });
    expect(engine.metricsSnapshot().activeChases).toBe(1);

    const initialWolfPosition = { lat: wolf.lat, lon: wolf.lon };
    engine.tick();
    const afterFirstTick = engine.entity(wolf.entityId)!;
    expect(distanceMeters({ lat: afterFirstTick.lat, lon: afterFirstTick.lon }, origin)).toBeLessThan(
      distanceMeters(initialWolfPosition, origin)
    );
    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: [wolf.entityId]
    });

    const movedPlayerPosition = moveToward(
      origin,
      { lat: origin.lat, lon: origin.lon - 0.02 },
      100
    );
    engine.syncPlayer({
      playerId: "p1",
      position: movedPlayerPosition,
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const beforeFollowingMove = engine.entity(wolf.entityId)!;
    const beforeFollowingPosition = { lat: beforeFollowingMove.lat, lon: beforeFollowingMove.lon };
    engine.tick();
    const afterFollowingMove = engine.entity(wolf.entityId)!;
    expect(distanceMeters(
      { lat: afterFollowingMove.lat, lon: afterFollowingMove.lon },
      movedPlayerPosition
    )).toBeLessThan(distanceMeters(beforeFollowingPosition, movedPlayerPosition));

    let queueJoinTick = 0;
    for (let tick = 1; tick <= 360; tick += 1) {
      engine.tick();
      if (engine.entity("p1")?.pveCombat?.enemyQueue.includes(wolf.entityId)) {
        queueJoinTick = tick;
        break;
      }
      expect(engine.entity("p1")?.pveCombat?.pursuingEnemyIds).toContain(wolf.entityId);
    }
    expect(queueJoinTick).toBeGreaterThan(0);
  });

  it("queues an in-range idle wolf but does not let it attack before the first enemy beat", () => {
    const engine = createEngineWithView(origin, 200);
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const wolf = spawnWolf(engine, east(50));

    const taunt = engine.useUniversalTaunt(authority("p1"));
    expect(taunt.pveCombat).toMatchObject({
      focusTargetEntityId: null,
      enemyQueue: [wolf.entityId],
      phase: "enemy_pending"
    });
    expect(engine.entity(wolf.entityId)?.targetEntityId).toBe("p1");
    engine.beginDeltaFlush();

    const beforeBeat: CombatEvent[] = [];
    for (let tick = 0; tick < HALF - 1; tick += 1) {
      engine.tick();
      beforeBeat.push(...engine.beginDeltaFlush().events);
    }
    expect(enemyDamage(beforeBeat, "p1")).toEqual([]);

    engine.tick();
    const firstBeat = enemyDamage(engine.beginDeltaFlush().events, "p1");
    expect(firstBeat).toHaveLength(1);
    expect(firstBeat[0]).toMatchObject({ tick: HALF, sourceEntityId: wolf.entityId });
  });

  it("lets an out-of-range wolf approach outside the scheduler and attack only on a later anchored beat", () => {
    const engine = createEngineWithView(origin, 270);
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const wolf = spawnWolf(engine, east(125));

    engine.useUniversalTaunt(authority("p1"));
    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: [wolf.entityId],
      phase: "waiting_player"
    });
    expect(engine.entity(wolf.entityId)).toMatchObject({
      targetEntityId: "p1",
      activityState: "chasing"
    });
    engine.beginDeltaFlush();

    const events: CombatEvent[] = [];
    for (let tick = 0; tick < HALF; tick += 1) {
      engine.tick();
      events.push(...engine.beginDeltaFlush().events);
    }
    expect(enemyDamage(events, "p1")).toEqual([]);
    expect(engine.entity(wolf.entityId)?.activityState).toBe("chasing");

    events.push(...tickUntil(engine, (collected) => enemyDamage(collected, "p1").length > 0, 160));
    for (let tick = 0; tick < HALF; tick += 1) {
      engine.tick();
      events.push(...engine.beginDeltaFlush().events);
    }
    const firstPlayerHit = playerDamage(events, "p1")[0];
    const firstEnemyHit = enemyDamage(events, "p1")[0];
    expect(firstPlayerHit).toBeDefined();
    expect(firstEnemyHit).toBeDefined();
    expect(firstPlayerHit!.tick).toBe(firstEnemyHit!.tick + HALF);
    expect(firstEnemyHit!.tick).toBeGreaterThan(HALF);
  });

  it("promotes staggered Taunted wolves into a growing deterministic rotation without cadence resets", () => {
    const engine = createEngineWithView(origin, 370);
    addPlayer(engine, "p1", origin, { maxHealth: 10_000, damage: 1 });
    const wolves = [115, 145, 175].map((distance) => spawnWolf(engine, east(distance)));

    const taunt = engine.useUniversalTaunt(authority("p1"));
    expect(taunt.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: wolves.map((wolf) => wolf.entityId),
      phase: "waiting_player"
    });
    for (const wolf of wolves) {
      expect(engine.entity(wolf.entityId)).toMatchObject({
        targetEntityId: "p1",
        activityState: "chasing"
      });
    }
    engine.beginDeltaFlush();

    const queueTransitions: Array<{ tick: number; queue: string[]; pursuing: string[] }> = [];
    const events: CombatEvent[] = [];
    const initialWolfPositions = new Map(wolves.map((wolf) => [
      wolf.entityId,
      { lat: wolf.lat, lon: wolf.lon }
    ]));
    let previousQueueLength = 0;
    let stateAtFirstEnemyPhase: ReturnType<CombatEngine["entity"]> | null = null;
    for (let tick = 1; tick <= 112; tick += 1) {
      engine.tick();
      const frameEvents = engine.beginDeltaFlush().events;
      events.push(...frameEvents);
      const state = engine.entity("p1")!;
      if (tick === 1) {
        for (const wolf of wolves) {
          const moved = engine.entity(wolf.entityId)!;
          expect(distanceMeters({ lat: moved.lat, lon: moved.lon }, origin)).toBeLessThan(
            distanceMeters(initialWolfPositions.get(wolf.entityId)!, origin)
          );
        }
      }
      const queue = state.pveCombat?.enemyQueue ?? [];
      if (queue.length !== previousQueueLength) {
        queueTransitions.push({
          tick,
          queue: [...queue],
          pursuing: [...(state.pveCombat?.pursuingEnemyIds ?? [])]
        });
        const newlyJoined = queue.at(-1)!;
        expect(enemyDamage(frameEvents, "p1").some((event) => event.sourceEntityId === newlyJoined)).toBe(false);
        previousQueueLength = queue.length;
      }
      if (tick === 16) stateAtFirstEnemyPhase = state;
    }

    expect(queueTransitions.map((transition) => transition.queue)).toEqual([
      [wolves[0]!.entityId],
      [wolves[0]!.entityId, wolves[1]!.entityId],
      wolves.map((wolf) => wolf.entityId)
    ]);
    expect(queueTransitions.map((transition) => transition.tick)).toEqual([13, 38, 63]);
    expect(queueTransitions.map((transition) => transition.pursuing.length)).toEqual([2, 1, 0]);
    expect(stateAtFirstEnemyPhase?.pveCombat).toMatchObject({
      enemyQueue: [wolves[0]!.entityId],
      pursuingEnemyIds: [wolves[1]!.entityId, wolves[2]!.entityId]
    });
    const enemyHits = enemyDamage(events, "p1").slice(0, 3);
    const firstJoin = queueTransitions[0]!.tick;
    expect(enemyHits.map((event) => event.tick)).toEqual([
      firstJoin + HALF, firstJoin + HALF + BEAT, firstJoin + HALF + 2 * BEAT
    ]);
    expect(enemyHits.map((event) => event.sourceEntityId)).toEqual([
      wolves[0]!.entityId,
      wolves[0]!.entityId,
      wolves[1]!.entityId
    ]);
  });

  it("admits simultaneous arrivals once by id and never grants an arrival-tick attack", () => {
    const engine = createEngineWithView(origin, 270);
    addPlayer(engine, "p1", origin, { maxHealth: 10_000, damage: 1 });
    const wolves = [spawnWolf(engine, east(125)), spawnWolf(engine, east(125))];
    const expectedOrder = wolves.map((wolf) => wolf.entityId).sort();

    engine.useUniversalTaunt(authority("p1"));
    engine.beginDeltaFlush();
    let arrivalTick = 0;
    const events: CombatEvent[] = [];
    for (let tick = 1; tick <= 80; tick += 1) {
      engine.tick();
      const frameEvents = engine.beginDeltaFlush().events;
      events.push(...frameEvents);
      if (arrivalTick === 0 && engine.entity("p1")?.pveCombat?.enemyQueue.length === 2) {
        arrivalTick = tick;
        expect(enemyDamage(frameEvents, "p1")).toEqual([]);
      }
    }

    expect(arrivalTick).toBeGreaterThan(0);
    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      enemyQueue: expectedOrder,
      pursuingEnemyIds: []
    });
    const hits = enemyDamage(events, "p1").slice(0, 2);
    expect(hits.map((event) => event.tick)).toEqual([arrivalTick + HALF, arrivalTick + HALF + BEAT]);
    expect(hits.map((event) => event.sourceEntityId)).toEqual(expectedOrder);
  });

  it("keeps an in-view pursuer past its home leash, then cleans it up outside the gameplay view", () => {
    const engine = createEngineWithView(origin, 500);
    addPlayer(engine, "p1", origin, { maxHealth: 1_000 });
    const wolf = spawnWolf(engine, east(150));
    const dummy = engine.spawnMob({
      archetype: "training_dummy",
      position: east(50),
      regionCode: "NM",
      zoneId: "world:NM"
    });

    const taunt = engine.useUniversalTaunt(authority("p1"));
    expect(taunt.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: [wolf.entityId]
    });
    expect(engine.entity(dummy.entityId)).toMatchObject({
      targetEntityId: null,
      activityState: "idle"
    });

    engine.syncPlayer({
      playerId: "p1",
      position: east(400),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.tick();

    expect(engine.entity("p1")?.pveCombat).toMatchObject({
      enemyQueue: [],
      pursuingEnemyIds: [wolf.entityId]
    });
    expect(engine.entity(wolf.entityId)).toMatchObject({
      targetEntityId: "p1",
      activityState: "chasing"
    });

    engine.syncPlayer({
      playerId: "p1",
      position: east(600),
      regionCode: "NM",
      zoneId: "world:NM"
    });
    engine.tick();

    expect(engine.entity("p1")?.pveCombat).toBeNull();
    expect(engine.entity(wolf.entityId)).toMatchObject({
      targetEntityId: null,
      activityState: "idle"
    });
    expect(engine.entity(dummy.entityId)).toMatchObject({
      targetEntityId: null,
      activityState: "idle",
      currentHealth: dummy.currentHealth
    });
  });

  it("queues three idle wolves once and rotates only one attacker through each enemy phase", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    try {
      const engine = createEngineWithView(origin, 200);
      addPlayer(engine, "p1", origin, { maxHealth: 10_000, damage: 1 });
      const wolves = [30, 40, 50].map((distance) => spawnWolf(engine, east(distance)));

      engine.useUniversalTaunt(authority("p1"));
      expect(engine.entity("p1")?.pveCombat?.enemyQueue).toEqual(
        wolves.map((wolf) => wolf.entityId)
      );
      vi.advanceTimersByTime(12_000);
      engine.useUniversalTaunt(authority("p1"));
      const events = tickUntil(
        engine,
        (collected) => enemyDamage(collected, "p1").length >= 4,
        140
      );

      const queue = engine.entity("p1")!.pveCombat!.enemyQueue;
      expect(queue).toHaveLength(3);
      expect(new Set(queue).size).toBe(3);
      const hits = enemyDamage(events, "p1").slice(0, 4);
      expect(hits.map((event) => event.tick)).toEqual([HALF, HALF + BEAT, HALF + 2 * BEAT, HALF + 3 * BEAT]);
      expect(hits.map((event) => event.sourceEntityId)).toEqual([
        wolves[0]!.entityId,
        wolves[1]!.entityId,
        wolves[2]!.entityId,
        wolves[0]!.entityId
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects stale and unavailable authoritative view circles", () => {
    const stale = new CombatEngine({
      tickRateHz: 20,
      getAuthoritativeViewCircle: () => ({ center: origin, radiusM: 100, generation: 2 }),
      isPlayerAuthorityActive: () => true
    });
    addPlayer(stale, "p1", origin);
    expectCombatError(
      () => stale.useUniversalTaunt({ ...authority("p1"), viewGeneration: 1 }),
      "TAUNT_VIEW_GENERATION_STALE"
    );

    const unavailable = new CombatEngine({
      tickRateHz: 20,
      getAuthoritativeViewCircle: () => null,
      isPlayerAuthorityActive: () => true
    });
    addPlayer(unavailable, "p1", origin);
    expectCombatError(() => unavailable.useUniversalTaunt(authority("p1")), "TAUNT_VIEW_CIRCLE_UNAVAILABLE");
  });

  it("enforces the centralized 128-entry queue safety cap without partially claiming entry 129", () => {
    expect(MAX_PVE_ENEMY_QUEUE_SIZE).toBe(128);
    const summaries: CombatBalanceSummary[] = [];
    const engine = createEngine((summary) => summaries.push(summary));
    addPlayer(engine, "p1", origin, { maxHealth: 10_000 });
    const mobs = Array.from({ length: MAX_PVE_ENEMY_QUEUE_SIZE + 1 }, (_, index) =>
      spawnGoblin(engine, 5 + index * 0.01)
    );
    const taunt = engine.useUniversalTaunt(authority("p1"));
    const queue = taunt.pveCombat!.enemyQueue;
    expect(queue).toHaveLength(MAX_PVE_ENEMY_QUEUE_SIZE);
    expect(new Set(queue).size).toBe(MAX_PVE_ENEMY_QUEUE_SIZE);
    expect(queue).not.toContain(mobs[MAX_PVE_ENEMY_QUEUE_SIZE]!.entityId);
    expect(engine.entity(mobs[MAX_PVE_ENEMY_QUEUE_SIZE]!.entityId)?.targetEntityId).toBeNull();
    expect(taunt.pveCombat?.lastTauntExcludedByCap).toBe(1);
    engine.cancelCombat("p1");
    engine.clearMobs();
    expect(summaries[0]).toMatchObject({
      tauntUses: 1,
      tauntEligibleCandidates: MAX_PVE_ENEMY_QUEUE_SIZE + 1,
      tauntEnemiesAdded: MAX_PVE_ENEMY_QUEUE_SIZE,
      tauntEnemiesExcludedByCap: 1
    });
  });
});

function createEngine(onCombatSummary?: (summary: CombatBalanceSummary) => void): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    getAuthoritativeViewCircle: () => ({ center: origin, radiusM: 40, generation: 1 }),
    isPlayerAuthorityActive: () => true,
    ...(onCombatSummary ? { onCombatSummary } : {})
  });
}

function createEngineWithView(center: LatLon, radiusM: number): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    getAuthoritativeViewCircle: () => ({ center, radiusM, generation: 1 }),
    isPlayerAuthorityActive: () => true
  });
}

function addPlayer(
  engine: CombatEngine,
  playerId: string,
  position: LatLon,
  options: { maxHealth?: number; currentHealth?: number; damage?: number } = {}
): void {
  const maxHealth = options.maxHealth ?? 100;
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
      maxHealth,
      currentHealth: options.currentHealth ?? maxHealth,
      baseAttackDamage: options.damage ?? 10
    }
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

function spawnWolf(engine: CombatEngine, position: LatLon) {
  return engine.spawnMob({
    archetype: "wolf",
    position,
    regionCode: "NM",
    zoneId: "world:NM"
  });
}

function spawnDeerPack(engine: CombatEngine, packId: string, distancesM: number[]) {
  return distancesM.map((distanceM, index) => engine.spawnMob({
    entityId: `${packId}:${index}`,
    archetype: "deer",
    worldAi: true,
    packId,
    position: east(distanceM),
    homePosition: east(distanceM),
    regionCode: "NM",
    zoneId: "world:NM"
  }));
}

function setPlayerAttackRange(engine: CombatEngine, playerId: string, attackRangeM: number): void {
  const player = (engine as unknown as {
    entities: Map<string, { attackRangeM: number }>;
  }).entities.get(playerId);
  if (!player) throw new Error(`missing player ${playerId}`);
  player.attackRangeM = attackRangeM;
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

function tickUntil(
  engine: CombatEngine,
  done: (events: CombatEvent[]) => boolean,
  maximumTicks: number
): CombatEvent[] {
  const events: CombatEvent[] = [];
  for (let tick = 0; tick < maximumTicks; tick += 1) {
    engine.tick();
    events.push(...engine.beginDeltaFlush().events);
    if (done(events)) return events;
  }
  throw new Error(`condition did not resolve within ${maximumTicks} combat ticks`);
}

function playerDamage(events: CombatEvent[], playerId: string): CombatEvent[] {
  return events.filter((event) => event.type === "DAMAGE" && event.sourceEntityId === playerId);
}

function enemyDamage(events: CombatEvent[], playerId: string): CombatEvent[] {
  return events.filter((event) =>
    event.type === "DAMAGE" &&
    event.targetEntityId === playerId &&
    event.sourceEntityId !== playerId
  );
}

function expectCombatError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CombatRequestError);
    expect((error as CombatRequestError).code).toBe(code);
    return;
  }
  throw new Error(`expected CombatRequestError ${code}`);
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
    warrior: {
      classId: "warrior",
      level: 25,
      xp: 38_000,
      nextLevelXp: null,
      completedAt: null
    },
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

function createRuntime() {
  const config = loadConfig({ NODE_ENV: "test" });
  const logger = createLogger("test");
  const registry = new ConnectionRegistry();
  const gameState = new GameState(config, logger);
  const combat = new CombatEngine({
    tickRateHz: config.SERVER_TICK_HZ,
    interestRadiusM: config.COMBAT_INTEREST_RADIUS_M,
    getAuthoritativeViewCircle: (playerId) => gameState.getGameplayViewCircle(playerId),
    isPlayerAuthorityActive: (playerId, accountId, connectionId) =>
      registry.isActiveConnection(accountId, connectionId) &&
      registry.isActivePlayerConnection(playerId, connectionId),
    movePlayerToward: (playerId, target) => gameState.setCombatTarget(playerId, target),
    stopPlayer: (playerId) => gameState.stopPlayer(playerId)
  });
  const runtime = new WorldRuntime(config, registry, gameState, combat, logger);
  const connectionIds = new Map<string, string>();
  return {
    combat,
    runtime,
    connectionIds,
    addPlayer(playerId: string, position: LatLon) {
      gameState.helloPlayer(playerId, playerId);
      gameState.teleportPlayer(playerId, position);
      const connectionId = registry.add({
        accountId: `account-${playerId}`,
        playerId,
        username: playerId,
        regionCode: packageIdForPosition(position),
        zoneId: zoneIdForPosition(position),
        socket: socket()
      });
      connectionIds.set(playerId, connectionId);
      combat.connectPlayer({
        playerId,
        name: playerId,
        regionCode: packageIdForPosition(position),
        zoneId: zoneIdForPosition(position),
        position,
        accountId: `account-${playerId}`,
        connectionId,
        profile: {
          playerId,
          maxHealth: 1_000,
          currentHealth: 1_000,
          baseAttackDamage: 10,
          persistenceVersion: 0
        }
      });
      configureKnight(combat, playerId);
    }
  };
}

function socket(): SocketLike {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn()
  };
}

import { describe, expect, it } from "vitest";

import {
  AGGRESSIVE_FLAG_TRAVEL_LOCK_MS,
  BASIC_ATTACK_INTERVAL_MS,
  PVE_TURN_STEP_MS,
  BASIC_ATTACK_APPROACH_M,
  BASIC_ATTACK_RANGE_M,
  beatAlignedAmountScale,
  beatAlignedIntervalMs,
  DEFAULT_PLAYER_BASIC_DAMAGE,
  DEFAULT_PLAYER_MAX_HEALTH,
  harmfulStatusDisplayName,
  HARMFUL_STATUS_DISPLAY_NAMES,
  millisecondsToTicks
} from "./combat.js";
import { COLLECTIBLE_PICKUP_RADIUS_M } from "./collectibles.js";
import { DROPPED_ITEM_PICKUP_RADIUS_M } from "./droppedItems.js";
import {
  combatServerMessageSchema,
  parseClientMessage,
  parseServerMessage
} from "./protocol.js";

describe("combat contract", () => {
  it("uses standardized harmful-status names while retaining status identities", () => {
    expect(harmfulStatusDisplayName("poison")).toBe("Poisoned");
    expect(harmfulStatusDisplayName("gloom")).toBe("Withered");
    expect(harmfulStatusDisplayName("burning")).toBe("Burning");
    expect(harmfulStatusDisplayName("storm")).toBe("Electrified");
    expect(harmfulStatusDisplayName("ice_slow")).toBe("Slowed");
    expect(HARMFUL_STATUS_DISPLAY_NAMES.gloom).toBe("Withered");
  });

  it.each([
    // Design interval -> whole beats (nearest, ties to the shorter, minimum one).
    { designMs: 3_500, beats: 2 },
    { designMs: 3_000, beats: 2 },
    { designMs: 5_000, beats: 4 },
    { designMs: 2_000, beats: 1 },
    { designMs: 1_000, beats: 1 },
    { designMs: 100, beats: 1 }
  ])("rounds a $designMs ms periodic interval to $beats beat(s) and keeps its rate per second", ({ designMs, beats }) => {
    expect(beatAlignedIntervalMs(designMs)).toBe(beats * BASIC_ATTACK_INTERVAL_MS);
    expect(beatAlignedIntervalMs(designMs) / BASIC_ATTACK_INTERVAL_MS % 1).toBe(0);
    // Scaling one tick's amount keeps amount-per-second identical on the new interval.
    const perSecond = 4 / designMs;
    expect(4 * beatAlignedAmountScale(designMs) / beatAlignedIntervalMs(designMs)).toBeCloseTo(perSecond, 12);
  });

  it.each([
    { tickRateHz: 10, sameSideTicks: 14, turnStepTicks: 7 },
    { tickRateHz: 20, sameSideTicks: 28, turnStepTicks: 14 },
    { tickRateHz: 30, sameSideTicks: 42, turnStepTicks: 21 }
  ])("converts the canonical cadence at $tickRateHz Hz", ({ tickRateHz, sameSideTicks, turnStepTicks }) => {
    expect(millisecondsToTicks(BASIC_ATTACK_INTERVAL_MS, tickRateHz)).toBe(sameSideTicks);
    expect(millisecondsToTicks(PVE_TURN_STEP_MS, tickRateHz)).toBe(turnStepTicks);
    expect(BASIC_ATTACK_RANGE_M).toBe(100);
    expect(BASIC_ATTACK_APPROACH_M).toBe(98);
    expect(AGGRESSIVE_FLAG_TRAVEL_LOCK_MS).toBe(10_000);
    expect(DEFAULT_PLAYER_MAX_HEALTH).toBe(100);
    expect(DEFAULT_PLAYER_BASIC_DAMAGE).toBe(10);
    expect(COLLECTIBLE_PICKUP_RADIUS_M).toBe(50);
    expect(DROPPED_ITEM_PICKUP_RADIUS_M).toBe(20);
  });

  it("accepts strict intent-only combat requests", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "START_ATTACK",
      requestId: "attack-1",
      targetEntityId: "mob-1"
    }))).toMatchObject({ type: "START_ATTACK", targetEntityId: "mob-1" });
  });

  it("accepts only a self-scoped development class cooldown reset intent", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "RESET_OWN_DEV_CLASS_COOLDOWNS",
      requestId: "cooldowns-1"
    }))).toEqual({ type: "RESET_OWN_DEV_CLASS_COOLDOWNS", requestId: "cooldowns-1" });
    expect(() => parseClientMessage(JSON.stringify({
      type: "RESET_OWN_DEV_CLASS_COOLDOWNS",
      requestId: "cooldowns-2",
      playerId: "other-player"
    }))).toThrow();
    expect(parseServerMessage(JSON.stringify({
      type: "DEV_CLASS_COOLDOWNS_RESET",
      requestId: "cooldowns-1",
      serverTime: 123
    }))).toMatchObject({ type: "DEV_CLASS_COOLDOWNS_RESET", serverTime: 123 });
  });

  it.each(["attackerEntityId", "damage", "health", "attackRangeM", "mobStats"])(
    "rejects client authority field %s",
    (field) => {
      expect(() => parseClientMessage(JSON.stringify({
        type: "START_ATTACK",
        requestId: "attack-1",
        targetEntityId: "mob-1",
        [field]: field === "damage" ? 999 : "forged"
      }))).toThrow();
    }
  );

  it("rejects unrecognized mob archetypes and extra spawn stats", () => {
    expect(() => parseClientMessage(JSON.stringify({
      type: "DEV_SPAWN_MOB",
      requestId: "spawn-1",
      archetype: "dragon",
      lat: 35.0844,
      lon: -106.6504
    }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      type: "DEV_SPAWN_MOB",
      requestId: "spawn-2",
      archetype: "goblin",
      lat: 35.0844,
      lon: -106.6504,
      health: 999
    }))).toThrow();
  });

  it("accepts only canonical developer Ashen overrides and reports the authoritative variant", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "DEV_SPAWN_MOB", requestId: "spawn-ashen", archetype: "deer",
      appearanceVariant: "ashen", lat: 35.0844, lon: -106.6504
    }))).toMatchObject({ appearanceVariant: "ashen" });
    expect(() => parseClientMessage(JSON.stringify({
      type: "DEV_SPAWN_MOB", requestId: "spawn-invalid", archetype: "deer",
      appearanceVariant: "charred", lat: 35.0844, lon: -106.6504
    }))).toThrow();
    expect(combatServerMessageSchema.parse({
      type: "DEV_MOB_SPAWNED", requestId: "spawn-ashen", mobEntityId: "mob:1",
      archetype: "deer", appearanceVariant: "ashen"
    })).toMatchObject({ appearanceVariant: "ashen" });
  });

  it("strictly validates batched server combat state", () => {
    const message = {
      type: "COMBAT_DELTA",
      state: {
        serverTick: 16,
        serverTime: 1000,
        sequence: 2,
        upserts: [],
        removedEntityIds: ["mob:1"],
        events: [{
          eventId: "16:1",
          type: "HEAL",
          tick: 16,
          sourceEntityId: "ally:1",
          targetEntityId: "player:1",
          amount: 8,
          currentHealth: 42
        }]
      }
    };
    expect(combatServerMessageSchema.parse(message)).toEqual(message);
    expect(() => combatServerMessageSchema.parse({ ...message, damage: 999 })).toThrow();
  });

  it("accepts canonical dungeon location identities in combat snapshots and deltas", () => {
    const dungeonPlayer = {
      entityId: "player:1",
      kind: "player",
      archetypeKey: null,
      name: "Dungeon Player",
      level: 1,
      regionCode: "interior:dungeon:cistern_warrens_world_entrance",
      zoneId: "interior:dungeon:cistern_warrens_world_entrance:sewer_entrance",
      lat: 0,
      lon: 0,
      maxHealth: 100,
      currentHealth: 100,
      lifeState: "alive",
      activityState: "idle",
      targetEntityId: null,
      revision: 1
    };
    const state = {
      serverTick: 1,
      serverTime: 1_000,
      sequence: 1,
      upserts: [dungeonPlayer],
      removedEntityIds: [],
      events: []
    };

    for (const type of ["COMBAT_SNAPSHOT", "COMBAT_DELTA"] as const) {
      expect(combatServerMessageSchema.parse({ type, state })).toEqual({ type, state });
    }
  });

  it("accepts deterministic class ability zone lifecycle events", () => {
    const base = {
      eventId: "player:1:ninja_v2_smoke_bomb",
      tick: 20,
      sourceEntityId: "player:1",
      targetEntityId: null,
      abilityId: "ninja_v2_smoke_bomb",
      position: { lat: 35.0844, lon: -106.6504 },
      radiusM: 100
    };
    const state = {
      serverTick: 20, serverTime: 1_000, sequence: 1, upserts: [], removedEntityIds: [],
      events: [
        { ...base, type: "CLASS_ABILITY_ZONE_STARTED", durationMs: 6_000 },
        { ...base, type: "CLASS_ABILITY_ZONE_ENDED" }
      ]
    };
    const parsed = combatServerMessageSchema.parse({ type: "COMBAT_DELTA", state });
    expect(parsed.type).toBe("COMBAT_DELTA");
    if (parsed.type !== "COMBAT_DELTA") throw new Error("Expected COMBAT_DELTA");
    expect(parsed.state.events).toEqual(state.events);
  });

  it("accepts a class ability activation with authoritative presentation metadata", () => {
    const event = {
      eventId: "20:1",
      type: "CLASS_ABILITY_ACTIVATED",
      tick: 20,
      sourceEntityId: "player:1",
      targetEntityId: null,
      abilityId: "ranger_v2_black_rain",
      position: { lat: 35.0844, lon: -106.6504 },
      radiusM: 300
    };
    const message = {
      type: "COMBAT_DELTA",
      state: {
        serverTick: 20,
        serverTime: 1_000,
        sequence: 1,
        upserts: [],
        removedEntityIds: [],
        events: [event]
      }
    };

    expect(combatServerMessageSchema.parse(message)).toEqual(message);
    expect(() => combatServerMessageSchema.parse({
      ...message,
      state: {
        ...message.state,
        events: [{ ...event, position: undefined }]
      }
    })).toThrow();
  });

  it("accepts the Warrior rework's resource-free combat snapshot", () => {
    const warrior = {
      entityId: "player:warrior",
      kind: "player",
      archetypeKey: null,
      name: "Warrior",
      level: 1,
      regionCode: "NM",
      zoneId: "world:NM",
      lat: 35.0844,
      lon: -106.6504,
      maxHealth: 100,
      currentHealth: 100,
      lifeState: "alive",
      activityState: "idle",
      targetEntityId: null,
      revision: 1,
      classCombat: {
        activeClassId: "warrior",
        weaponMode: "melee",
        rage: 0,
        maximumRage: 0,
        reservedRage: 0,
        guard: 0,
        bloodlust: 0,
        queuedAbility: null,
        cooldownEndsAt: {}
      }
    };
    const message = {
      type: "COMBAT_SNAPSHOT",
      state: {
        serverTick: 1,
        serverTime: 1_000,
        sequence: 1,
        upserts: [warrior],
        removedEntityIds: [],
        events: []
      }
    };

    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
    expect(() => combatServerMessageSchema.parse({
      ...message,
      state: {
        ...message.state,
        upserts: [{
          ...warrior,
          classCombat: { ...warrior.classCombat, maximumRage: 1 }
        }]
      }
    })).toThrow();
  });

  it("accepts a Ranger bootstrap snapshot with class combat status", () => {
    const message = {
      type: "COMBAT_SNAPSHOT",
      state: {
        serverTick: 40,
        serverTime: 2_000,
        sequence: 1,
        upserts: [{
          entityId: "player:ranger",
          kind: "player",
          archetypeKey: null,
          name: "Ranger",
          level: 14,
          regionCode: "NM",
          zoneId: "world:NM",
          lat: 35.0844,
          lon: -106.6504,
          maxHealth: 100,
          currentHealth: 82,
          lifeState: "alive",
          activityState: "attacking",
          targetEntityId: "mob:1",
          revision: 3,
          classCombat: {
            activeClassId: "ranger",
            weaponMode: "ranged",
            rage: 0,
            maximumRage: 0,
            reservedRage: 0,
            guard: 0,
            bloodlust: 0,
            classCounters: { v2MarkedQuarryEndsAt: 5_000 },
            statusIndicators: [{
              id: "ranger_v2_marked_quarry",
              label: "quarry sign",
              stacks: 2,
              endsAt: 8_000
            }],
            queuedAbility: null,
            cooldownEndsAt: { ranger_v2_throughshot: 12_000 },
            cooldownGroupEndsAt: { basic_attack_reset: 0 }
          }
        }],
        removedEntityIds: [],
        events: []
      }
    };

    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it("accepts an armed Ninja ability without an entity target", () => {
    const message = {
      type: "COMBAT_SNAPSHOT",
      state: {
        serverTick: 40,
        serverTime: 2_000,
        sequence: 1,
        upserts: [{
          entityId: "player:ninja",
          kind: "player",
          archetypeKey: null,
          name: "Ninja",
          level: 1,
          regionCode: "NM",
          zoneId: "world:NM",
          lat: 35.0844,
          lon: -106.6504,
          maxHealth: 100,
          currentHealth: 100,
          lifeState: "alive",
          activityState: "idle",
          targetEntityId: null,
          revision: 1,
          classCombat: {
            activeClassId: "ninja",
            weaponMode: "ranged",
            rage: 0,
            maximumRage: 0,
            reservedRage: 0,
            guard: 0,
            bloodlust: 0,
            classCounters: {},
            statusIndicators: [],
            queuedAbility: {
              abilityId: "ninja_v2_twin_fang",
              targetEntityId: null,
              queuedAtTick: 40
            },
            cooldownEndsAt: {},
            cooldownGroupEndsAt: { basic_attack_reset: 0 }
          }
        }],
        removedEntityIds: [],
        events: []
      }
    };

    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it("accepts generic boss metadata in strict combat snapshots", () => {
    const xoral = {
      entityId: "xoral:event-1",
      kind: "mob",
      archetypeKey: "xoral",
      name: "The Xoral",
      level: 25,
      regionCode: "NM",
      zoneId: "world:NM",
      lat: 35.0844,
      lon: -106.6504,
      maxHealth: 17_500,
      currentHealth: 17_500,
      lifeState: "alive",
      activityState: "idle",
      targetEntityId: null,
      boss: true,
      bossEventState: "active",
      revision: 1
    };
    const message = {
      type: "COMBAT_SNAPSHOT",
      state: {
        serverTick: 1,
        serverTime: 1_000,
        sequence: 1,
        upserts: [xoral],
        removedEntityIds: [],
        events: []
      }
    };

    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it("accepts generic harmful statuses and blocked-healing events", () => {
    const message = {
      type: "COMBAT_DELTA",
      state: {
        serverTick: 40,
        serverTime: 2_000,
        sequence: 4,
        upserts: [{
          entityId: "player:1",
          kind: "player",
          archetypeKey: null,
          name: "Player",
          level: 1,
          regionCode: "NM",
          zoneId: "world:NM",
          lat: 35.0844,
          lon: -106.6504,
          maxHealth: 100,
          currentHealth: 50,
          lifeState: "alive",
          activityState: "idle",
          targetEntityId: null,
          harmfulStatusIds: ["poison", "gloom", "quarry_sign"],
          flagArrivalProtectionUntil: 12_000,
          revision: 2
        }],
        removedEntityIds: [],
        events: [{
          eventId: "40:1",
          type: "HEAL_BLOCKED",
          tick: 40,
          sourceEntityId: "player:1",
          targetEntityId: "player:1",
          amount: 0,
          currentHealth: 50,
          harmfulStatusId: "gloom"
        }]
      }
    };

    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
    expect(() => combatServerMessageSchema.parse({
      ...message,
      state: {
        ...message.state,
        upserts: [{ ...message.state.upserts[0], harmfulStatusIds: ["burn"] }]
      }
    })).toThrow();
  });

  it("strictly validates bounded world resynchronization requests", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "REQUEST_WORLD_RESYNC",
      requestId: "resync-1",
      combatSequence: 7,
      playerSequence: 3
    }))).toMatchObject({ type: "REQUEST_WORLD_RESYNC", combatSequence: 7 });
    expect(() => parseClientMessage(JSON.stringify({
      type: "REQUEST_WORLD_RESYNC",
      requestId: "resync-2",
      combatSequence: 7,
      playerSequence: 3,
      force: true
    }))).toThrow();
  });
});

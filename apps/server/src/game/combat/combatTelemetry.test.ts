import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  CombatTelemetryAccumulator,
  CombatTelemetryService,
  MAX_COMBAT_ACTION_TRACE_ENTRIES,
  combatBalanceSummarySchema,
  parseCombatBalanceSummary,
  combatTelemetryPayloadHash,
  type CombatBalanceSummary
} from "./combatTelemetry.js";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../../db/migrations/0303_combat_balance_telemetry.sql", import.meta.url)),
  "utf8"
);

describe("combat balance telemetry", () => {
  it("accepts intentional developer combat power without terminating session creation", () => {
    const accumulator = new CombatTelemetryAccumulator({
      combatSessionId: "combat:developer-power",
      playerId: "player-1",
      activeClassId: "warrior",
      activeSubclassId: null,
      warriorLevel: 8,
      activeKitIndex: 1,
      readiedWeaponSlot: "melee",
      weaponCategory: "sword",
      weaponItemLevel: 0,
      effectiveWeaponLevel: 0,
      weightedArmorLevel: 0,
      shieldLevel: null,
      pvpOffense: 1_003,
      pvpGuard: 0,
      equippedResetActives: [null, null],
      equippedNormalActives: [null, null],
      selectedTierPassives: { tier0: null, tier10: null, tier20: null },
      initialEnemyQueueSize: 0,
      enemyArchetypeCounts: {},
      startedAtMs: STARTED_AT
    });

    expect(accumulator.finish({
      endedAtMs: STARTED_AT + 1,
      playerSurvived: true,
      combatEndReason: "cancelled"
    }).pvpOffense).toBe(1_003);
  });

  it("captures the first established enemy queue size exactly once", () => {
    const accumulator = createAccumulator("combat:initial-queue", "player-1", STARTED_AT, 0);
    accumulator.captureInitialQueueSize(3);
    accumulator.captureInitialQueueSize(1);
    const summary = accumulator.finish({
      endedAtMs: STARTED_AT + 1_000,
      playerSurvived: true,
      combatEndReason: "cancelled"
    });
    expect(summary.initialEnemyQueueSize).toBe(3);
    expect(summary.maximumEnemyQueueSize).toBe(3);
  });

  it("aggregates the requested authoritative session metrics without private event fields", () => {
    const accumulator = createAccumulator();
    accumulator.recordQueueInsertion("goblin", 2, STARTED_AT + 10);
    accumulator.recordPlayerAction({ action: "basic_attack", atMs: STARTED_AT + 100, damage: 12, rageDelta: 10 });
    accumulator.recordPlayerAction({ action: "reset_strike", abilityId: "warrior_punishing_strike", atMs: STARTED_AT + 120, damage: 20, rageDelta: -20 });
    accumulator.recordPlayerAction({ action: "normal_active", abilityId: "warrior_cleave", atMs: STARTED_AT + 500, damage: 30, rageDelta: -25 });
    accumulator.recordPlayerAction({ action: "taunt", atMs: STARTED_AT + 800 });
    accumulator.recordTauntResult({ eligibleCandidates: 5, enemiesAdded: 3, excludedByCap: 1 });
    accumulator.recordEnemyAction({ action: "attack", enemyArchetype: "wolf", atMs: STARTED_AT + 200, damage: 7 });
    accumulator.recordEnemyAction({ action: "approach", enemyArchetype: "goblin", atMs: STARTED_AT + 900 });
    accumulator.recordResetWindow("pre_auto_success");
    accumulator.recordResetWindow("missed");
    accumulator.recordRage({ generated: 18, spent: 45, wastedAtCap: 3 });
    accumulator.recordDamageDealt("basic_attack", 12);
    accumulator.recordDamageDealt("warrior_cleave", 30);
    accumulator.recordDamageReceived(7, { armor: 2, queue_discipline: 1, crowd_breaker: 1 });
    accumulator.recordBloodPriceHealthSpent(8);
    accumulator.recordReaverHealing(5);
    accumulator.recordExecutionerRefund();
    accumulator.recordFocusSwitch(STARTED_AT + 1_000);
    accumulator.recordKitActivation({
      activationTick: 40,
      atMs: STARTED_AT + 1_020,
      equipment: {
        activeKitIndex: 2,
        readiedWeaponSlot: "secondary",
        weaponCategory: "bow",
        weaponItemLevel: 0,
        effectiveWeaponLevel: 0,
        weightedArmorLevel: 3,
        shieldLevel: null,
        pvpOffense: 11.5,
        pvpGuard: 9.25
      }
    });
    accumulator.recordPowerResolution({
      damageBeforePowerScaling: 9,
      powerMultiplier: 1.07,
      finalPowerScaledDamage: 10,
      resolvedTick: 43
    });
    accumulator.recordInvalidKitActivation();
    accumulator.recordQueueRemoval(1, STARTED_AT + 1_100);
    accumulator.recordEnemyDefeated("wolf", STARTED_AT + 1_200);

    const summary = accumulator.finish({
      endedAtMs: STARTED_AT + 2_000,
      playerSurvived: true,
      combatEndReason: "victory"
    });

    expect(summary).toMatchObject({
      initialEnemyQueueSize: 1,
      maximumEnemyQueueSize: 2,
      enemyArchetypeCounts: { wolf: 1, goblin: 1 },
      playerActionCount: 4,
      enemyActionCount: 2,
      enemyApproachActionCount: 1,
      basicAttacks: 1,
      resetStrikesByAbility: { warrior_punishing_strike: 1 },
      normalActivesByAbility: { warrior_cleave: 1 },
      tauntUses: 1,
      tauntEligibleCandidates: 5,
      tauntEnemiesAdded: 3,
      tauntEnemiesExcludedByCap: 1,
      resetWindowOpportunities: 2,
      resetWindowSuccesses: 1,
      preAutoResetBufferSuccesses: 1,
      rageGenerated: 18,
      rageSpent: 45,
      rageWastedAtCap: 3,
      damageBySource: { basic_attack: 12, warrior_cleave: 30 },
      damageReceived: 7,
      mitigationBySource: { armor: 2, queue_discipline: 1, crowd_breaker: 1 },
      bloodPriceHealthSpent: 8,
      reaverHealing: 5,
      executionerRefunds: 1,
      focusSwitches: 1,
      activeKitIndex: 2,
      readiedWeaponSlot: "secondary",
      weaponCategory: "bow",
      weaponItemLevel: 0,
      effectiveWeaponLevel: 0,
      weightedArmorLevel: 3,
      pvpOffense: 11.5,
      pvpGuard: 9.25,
      kitSwitchCount: 1,
      latestKitActivationTick: 40,
      timeFromKitActivationToNextResolvedActionTicks: 3,
      invalidKitActivationAttempts: 1,
      damageBeforePowerScaling: 9,
      powerMultiplier: 1.07,
      finalPowerScaledDamage: 10,
      queueInsertions: 1,
      queueRemovals: 1,
      enemiesDefeated: 1,
      playerSurvived: true,
      combatEndReason: "victory"
    });
    expect(summary.actionTrace.every((entry) =>
      !("lat" in entry) && !("lon" in entry) && !("targetEntityId" in entry)
    )).toBe(true);
    expect(() => combatBalanceSummarySchema.parse({ ...summary, accessToken: "secret" })).toThrow();
  });

  it("validates Taunt aggregates and defaults stored schema-version-1 summaries", () => {
    const accumulator = createAccumulator("combat:taunt-aggregate");
    expect(() => accumulator.recordTauntResult({
      eligibleCandidates: 1,
      enemiesAdded: 2,
      excludedByCap: 0
    })).toThrow(/cannot exceed/i);
    expect(() => accumulator.recordTauntResult({
      eligibleCandidates: -1,
      enemiesAdded: 0,
      excludedByCap: 0
    })).toThrow(/nonnegative integer/i);
    accumulator.recordPlayerAction({ action: "taunt", atMs: STARTED_AT + 10 });
    accumulator.recordTauntResult({ eligibleCandidates: 5, enemiesAdded: 5, excludedByCap: 0 });
    accumulator.recordPlayerAction({ action: "taunt", atMs: STARTED_AT + 20 });
    accumulator.recordTauntResult({ eligibleCandidates: 5, enemiesAdded: 0, excludedByCap: 0 });
    const summary = accumulator.finish({
      endedAtMs: STARTED_AT + 100,
      playerSurvived: true,
      combatEndReason: "cancelled"
    });
    expect(summary).toMatchObject({
      tauntUses: 2,
      tauntEligibleCandidates: 10,
      tauntEnemiesAdded: 5,
      tauntEnemiesExcludedByCap: 0
    });
    const storedVersionOne = { ...summary } as Record<string, unknown>;
    delete storedVersionOne.tauntEligibleCandidates;
    delete storedVersionOne.tauntEnemiesAdded;
    delete storedVersionOne.tauntEnemiesExcludedByCap;
    expect(combatBalanceSummarySchema.parse(storedVersionOne)).toMatchObject({
      tauntEligibleCandidates: 0,
      tauntEnemiesAdded: 0,
      tauntEnemiesExcludedByCap: 0
    });
  });

  it("retains only the first 500 privacy-safe trace entries", () => {
    const accumulator = createAccumulator();
    for (let index = 0; index < MAX_COMBAT_ACTION_TRACE_ENTRIES + 7; index += 1) {
      accumulator.recordFocusSwitch(STARTED_AT + index);
    }
    const summary = accumulator.finish({
      endedAtMs: STARTED_AT + 1_000,
      playerSurvived: true,
      combatEndReason: "cancelled"
    });
    expect(summary.actionTrace).toHaveLength(MAX_COMBAT_ACTION_TRACE_ENTRIES);
    expect(summary.traceEntriesObserved).toBe(MAX_COMBAT_ACTION_TRACE_ENTRIES + 7);
    expect(summary.actionTraceTruncated).toBe(true);
    expect(summary.actionTrace.at(-1)?.sequence).toBe(MAX_COMBAT_ACTION_TRACE_ENTRIES - 1);
  });

  it("persists once, verifies idempotent replays, retries failures, and reads only one player's recent summaries", async () => {
    vi.useFakeTimers();
    const database = createTelemetryDatabase();
    const service = new CombatTelemetryService(database.pool, 2);
    const first = completedSummary("combat:first", "player-1", STARTED_AT);
    const second = completedSummary("combat:second", "player-1", STARTED_AT + 10_000);
    const other = completedSummary("combat:other", "player-2", STARTED_AT + 20_000);

    expect(service.enqueue(first)).toEqual({ accepted: true, duplicate: false });
    expect(service.enqueue(first)).toEqual({ accepted: true, duplicate: true });
    database.failNextInsert();
    await expect(service.flush()).resolves.toBe(0);
    expect(service.metricsSnapshot().queueDepth).toBe(1);
    vi.advanceTimersByTime(1_000);
    await expect(service.flush()).resolves.toBe(1);

    expect(service.enqueue(first)).toEqual({ accepted: true, duplicate: false });
    expect(service.enqueue(second)).toEqual({ accepted: true, duplicate: false });
    expect(service.enqueue(other)).toEqual({ accepted: false, reason: "capacity" });
    await expect(service.flush()).resolves.toBe(2);
    await service.persistSummary(other);

    const recent = await service.recentForPlayer("player-1", 500);
    expect(recent.map((summary) => summary.combatSessionId)).toEqual(["combat:second", "combat:first"]);
    expect(recent.every((summary) => summary.playerId === "player-1")).toBe(true);
    const exported = await service.exportRecentForPlayer("player-1", 2, new Date("2026-01-01T00:00:00.000Z"));
    expect(JSON.parse(exported)).toMatchObject({
      schemaVersion: 3,
      generatedAt: "2026-01-01T00:00:00.000Z",
      playerId: "player-1"
    });
    expect(exported).not.toContain("player-2");
    expect(service.metricsSnapshot()).toMatchObject({ persisted: 3, replayed: 1, failures: 1, droppedAtCapacity: 1 });

    await expect(service.persistSummary({ ...first, damageReceived: 99 })).rejects.toThrow(/collides/i);
    vi.useRealTimers();
  });

  it("drains work requested while a bounded flush is already active", async () => {
    const database = createTelemetryDatabase();
    const service = new CombatTelemetryService(database.pool, 4);
    service.enqueue(completedSummary("combat:drain-1", "player-1", STARTED_AT));
    service.enqueue(completedSummary("combat:drain-2", "player-1", STARTED_AT + 2_000));
    service.enqueue(completedSummary("combat:drain-3", "player-1", STARTED_AT + 4_000));

    const firstBatch = service.flush(1);
    const remaining = service.flush();
    await expect(firstBatch).resolves.toBe(1);
    await expect(remaining).resolves.toBe(2);
    expect(service.metricsSnapshot().queueDepth).toBe(0);
  });

  it("lets later summaries pass a failed head record and quarantines permanent failures safely", async () => {
    vi.useFakeTimers();
    const database = createTelemetryDatabase();
    const logger = { error: vi.fn() };
    const service = new CombatTelemetryService(database.pool, 4, logger);
    const poison = completedSummary("combat:poison", "player-sensitive", STARTED_AT);
    const valid = completedSummary("combat:valid", "player-1", STARTED_AT + 2_000);
    service.enqueue(poison);
    service.enqueue(valid);
    database.failNextInsert(new Error("temporary network failure"));

    await expect(service.flush()).resolves.toBe(1);
    expect(service.metricsSnapshot()).toMatchObject({ queueDepth: 1, retried: 1, transientFailures: 1 });
    vi.advanceTimersByTime(1_000);
    await expect(service.flush()).resolves.toBe(1);
    expect(service.metricsSnapshot().queueDepth).toBe(0);

    service.enqueue(completedSummary("combat:bad", "private-player", STARTED_AT + 4_000));
    const permanent = Object.assign(new Error("invalid database constraint"), { code: "23514" });
    database.failNextInsert(permanent);
    await expect(service.flush()).resolves.toBe(0);
    expect(service.metricsSnapshot()).toMatchObject({ queueDepth: 0, quarantined: 1, permanentFailures: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain("combat:bad");
    expect(logged).not.toContain("private-player");
    expect(service.enqueue(completedSummary("combat:bad", "private-player", STARTED_AT + 4_000)))
      .toEqual({ accepted: true, duplicate: false });
    vi.useRealTimers();
  });

  it("enforces the transient retry limit and releases the queued hash", async () => {
    vi.useFakeTimers();
    const database = createTelemetryDatabase();
    const logger = { error: vi.fn() };
    const service = new CombatTelemetryService(database.pool, 1, logger);
    const summary = completedSummary("combat:retry-limit", "player-1", STARTED_AT);
    service.enqueue(summary);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 0]) {
      database.failNextInsert(new Error("temporary network failure"));
      await expect(service.flush()).resolves.toBe(0);
      vi.advanceTimersByTime(delay);
    }
    expect(service.metricsSnapshot()).toMatchObject({
      queueDepth: 0,
      retried: 4,
      quarantined: 1,
      transientFailures: 5
    });
    expect(service.enqueue(summary)).toEqual({ accepted: true, duplicate: false });
    expect(logger.error).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("hashes semantically identical summaries independently of object key insertion order", () => {
    const summary = completedSummary("combat:hash", "player-1", STARTED_AT);
    const reordered = {
      ...summary,
      damageBySource: { warrior_cleave: 5, basic_attack: 10 }
    };
    const oppositeOrder = {
      ...summary,
      damageBySource: { basic_attack: 10, warrior_cleave: 5 }
    };
    expect(combatTelemetryPayloadHash(reordered)).toBe(combatTelemetryPayloadHash(oppositeOrder));
  });

  it("emits schema-version-3 equipment telemetry and reads version-1/2 rows", () => {
    const hunter = new CombatTelemetryAccumulator({
      combatSessionId: "combat:hunter-v2", playerId: "hunter-1",
      activeClassId: "hunter", activeSubclassId: "sharpshooter",
      activeClassLevel: 25, primaryResourceId: "focus", weaponMode: "ranged", warriorLevel: 25,
      equippedResetActives: ["sharpshooter_deadeye_shot", "hunter_cull"],
      equippedNormalActives: ["hunter_sweep", "hunter_snare_trap"],
      selectedTierPassives: { tier0: "hunter_keen_focus", tier10: "hunter_lone_hunter", tier20: "hunter_killer_instinct" },
      initialEnemyQueueSize: 1, enemyArchetypeCounts: { ogre: 1 }, startedAtMs: STARTED_AT
    });
    hunter.recordResource({ generated: 12, spent: 30, wastedAtCap: 2 });
    hunter.recordClassMetric("focus_regenerated", 7);
    hunter.recordClassMetric("deadeye_long_range_hits");
    const v2 = hunter.finish({ endedAtMs: STARTED_AT + 1_000, playerSurvived: true, combatEndReason: "victory" });
    expect(v2).toMatchObject({
      schemaVersion: 3,
      activeClassId: "hunter",
      activeClassLevel: 25,
      primaryResourceId: "focus",
      weaponMode: "ranged",
      characterLevel: 25,
      warriorRank: 15,
      activeKitIndex: null,
      weaponItemLevel: null,
      resourceGenerated: 12,
      resourceSpent: 30,
      resourceWastedAtCap: 2,
      classMetrics: { focus_regenerated: 7, deadeye_long_range_hits: 1 }
    });

    const current = completedSummary("combat:legacy", "player-1", STARTED_AT) as unknown as Record<string, unknown>;
    const legacy: Record<string, unknown> = { ...current, schemaVersion: 1 };
    for (const key of ["activeClassLevel", "primaryResourceId", "weaponMode", "resourceGenerated", "resourceSpent", "resourceWastedAtCap", "classMetrics"]) delete legacy[key];
    expect(parseCombatBalanceSummary(legacy)).toMatchObject({
      schemaVersion: 3,
      activeClassId: "warrior",
      activeClassLevel: 8,
      primaryResourceId: "rage",
      characterLevel: 8,
      warriorRank: 8,
      activeKitIndex: null
    });
    expect(parseCombatBalanceSummary({ ...current, schemaVersion: 2 })).toMatchObject({
      schemaVersion: 3,
      activeClassId: "warrior",
      warriorRank: 8
    });
  });
});

describe("0303 combat telemetry migration", () => {
  it("creates one bounded aggregate row per session and a per-player recent index", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS combat_balance_summaries");
    expect(migration).toContain("combat_session_id text PRIMARY KEY");
    expect(migration).toContain("jsonb_array_length(action_trace) <= 500");
    expect(migration).toContain("pg_column_size(summary) <= 262144");
    expect(migration).toContain("combat_balance_summaries_player_ended_idx");
    expect(migration).not.toMatch(/latitude|longitude|email_address|access_token|ip_address/i);
  });
});

const STARTED_AT = 1_800_000_000_000;

function createAccumulator(
  combatSessionId = "combat:test",
  playerId = "player-1",
  startedAtMs = STARTED_AT,
  initialEnemyQueueSize = 1
): CombatTelemetryAccumulator {
  return new CombatTelemetryAccumulator({
    combatSessionId,
    playerId,
    activeClassId: "warrior",
    activeSubclassId: null,
    warriorLevel: 8,
    equippedResetActives: ["warrior_punishing_strike", null],
    equippedNormalActives: ["warrior_cleave", null],
    selectedTierPassives: { tier0: "warrior_rageborn", tier10: null, tier20: null },
    initialEnemyQueueSize,
    enemyArchetypeCounts: initialEnemyQueueSize > 0 ? { wolf: 1 } : {},
    startedAtMs
  });
}

function completedSummary(combatSessionId: string, playerId: string, startedAtMs: number): CombatBalanceSummary {
  const accumulator = createAccumulator(combatSessionId, playerId, startedAtMs);
  accumulator.recordDamageDealt("basic_attack", 10);
  accumulator.recordDamageDealt("warrior_cleave", 5);
  accumulator.recordPlayerAction({ action: "basic_attack", atMs: startedAtMs + 100, damage: 10 });
  accumulator.recordEnemyDefeated("wolf", startedAtMs + 900);
  return accumulator.finish({ endedAtMs: startedAtMs + 1_000, playerSurvived: true, combatEndReason: "victory" });
}

type StoredTelemetry = {
  playerId: string;
  payloadHash: string;
  summary: Record<string, unknown>;
  actionTrace: unknown[];
  endedAt: string;
};

function createTelemetryDatabase(): { pool: pg.Pool; failNextInsert(error?: Error): void } {
  const stored = new Map<string, StoredTelemetry>();
  let nextInsertError: Error | null = null;
  const pool = {
    query: async <T>(text: string, values: readonly unknown[] = []) => {
      if (text.includes("INSERT INTO combat_balance_summaries")) {
        if (nextInsertError) {
          const error = nextInsertError;
          nextInsertError = null;
          throw error;
        }
        const combatSessionId = String(values[0]);
        if (stored.has(combatSessionId)) return queryResult<T>([]);
        stored.set(combatSessionId, {
          playerId: String(values[1]),
          payloadHash: String(values[15]),
          summary: JSON.parse(String(values[16])) as Record<string, unknown>,
          actionTrace: JSON.parse(String(values[17])) as unknown[],
          endedAt: String(values[8])
        });
        return queryResult<T>([{ combat_session_id: combatSessionId } as T]);
      }
      if (text.includes("SELECT player_id, payload_sha256")) {
        const row = stored.get(String(values[0]));
        return queryResult<T>(row ? [{ player_id: row.playerId, payload_sha256: row.payloadHash } as T] : []);
      }
      if (text.includes("SELECT summary, action_trace")) {
        const playerId = String(values[0]);
        const limit = Number(values[1]);
        const rows = [...stored.values()]
          .filter((row) => row.playerId === playerId)
          .sort((left, right) => right.endedAt.localeCompare(left.endedAt))
          .slice(0, limit)
          .map((row) => ({ summary: row.summary, action_trace: row.actionTrace }) as T);
        return queryResult<T>(rows);
      }
      throw new Error(`Unhandled telemetry test query: ${text}`);
    }
  } as unknown as pg.Pool;
  return {
    pool,
    failNextInsert: (error = new Error("temporary telemetry failure")) => {
      nextInsertError = error;
    }
  };
}

function queryResult<T>(rows: T[]): pg.QueryResult<T & pg.QueryResultRow> {
  return { rows, rowCount: rows.length, command: "TEST", oid: 0, fields: [] } as pg.QueryResult<T & pg.QueryResultRow>;
}

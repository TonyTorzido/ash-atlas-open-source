import type pg from "pg";
import { describe, expect, it } from "vitest";
import { levelForTotalXp } from "@ash-atlas/shared";

import {
  ProgressionService,
  calculateDeathXpPenalty,
  calculateXpTransition,
  enchantmentStoneVariantForRoll,
  resolveEnchantmentStoneVariant,
  type XpGrantInput
} from "./progression.js";

describe("ProgressionService replay safety", () => {
  it("uses three percent of the current level requirement without crossing the permanent level floor", () => {
    // Beginner protection: levels 0-3 lose nothing.
    expect([0, 9, 7_193, 7_200, 20_000, 24_336, 24_400, 30_000, 34_516].map(calculateDeathXpPenalty))
      .toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(calculateDeathXpPenalty(34_517)).toBe(0);
    expect(calculateDeathXpPenalty(34_600)).toBe(83);
    expect(calculateDeathXpPenalty(40_000)).toBe(342);
    expect(calculateDeathXpPenalty(1_000_000)).toBe(0);
    expect(calculateDeathXpPenalty(1_000_010)).toBe(10);
    expect(calculateDeathXpPenalty(1_025_000)).toBe(7_500);
    expect(calculateDeathXpPenalty(1_750_010)).toBe(7_500);
  });

  it("applies one transactional death penalty, replays it, and reconciles subtraction", async () => {
    const database = createProgressionDatabase();
    const service = new ProgressionService(database.pool);
    await service.grantXp(grant("seed:death", 40_000));
    await expect(service.deathPenaltyPresentation({
      operationKey: "death:one",
      playerId: "player-1",
      currentTotalXp: 40_000
    })).resolves.toEqual({ operationKey: "death:one", xpLost: 342 });
    const first = await service.applyDeathPenalty({ operationKey: "death:one", playerId: "player-1" });
    const replay = await service.applyDeathPenalty({ operationKey: "death:one", playerId: "player-1" });
    await expect(service.deathPenaltyPresentation({
      operationKey: "death:one",
      playerId: "player-1",
      currentTotalXp: 39_658
    })).resolves.toEqual({ operationKey: "death:one", xpLost: 342 });
    expect(first).toMatchObject({ penaltyBasisPoints: 300, previousXp: 40_000, penaltyBasisXp: 11_429, levelFloorXp: 34_517, xpLost: 342, resultingXp: 39_658, previousLevel: 4, resultingLevel: 4, replayed: false });
    expect(replay).toMatchObject({ resultingXp: 39_658, levelFloorXp: 34_517, replayed: true, progression: { totalXp: 39_658 } });
    expect(database.penaltyCount()).toBe(1);
    expect(await service.reconcilePlayer("player-1")).toEqual({ totalXp: 39_658, ledgerXp: 39_658, ok: true });
  });

  it("loses partial progress once and then remains at the same level floor", async () => {
    const database = createProgressionDatabase(34_600);
    const service = new ProgressionService(database.pool);
    const first = await service.applyDeathPenalty({ operationKey: "death:partial", playerId: "player-1" });
    const atFloor = await service.applyDeathPenalty({ operationKey: "death:floor", playerId: "player-1" });
    expect(first).toMatchObject({ previousXp: 34_600, resultingXp: 34_517, xpLost: 83, previousLevel: 4, resultingLevel: 4 });
    expect(atFloor).toMatchObject({ previousXp: 34_517, resultingXp: 34_517, xpLost: 0, previousLevel: 4, resultingLevel: 4 });
  });
  it("grants once, replays the durable result, and reconciles the ledger", async () => {
    const database = createProgressionDatabase();
    const service = new ProgressionService(database.pool);
    const input = grant("op:one", 1_667);
    const first = await service.grantXp(input);
    const replay = await service.grantXp(input);
    expect(first).toMatchObject({ grantedXp: 1_667, resultingLevel: 0, replayed: false });
    expect(replay).toMatchObject({ grantedXp: 1_667, resultingLevel: 0, replayed: true });
    expect(await service.reconcilePlayer("player-1")).toEqual({
      totalXp: 1_667,
      ledgerXp: 1_667,
      ok: true
    });
    expect(database.operationCount()).toBe(1);
  });

  it("serializes concurrent duplicate operations to one winner", async () => {
    const database = createProgressionDatabase();
    const service = new ProgressionService(database.pool);
    const results = await Promise.all([
      service.grantXp(grant("op:concurrent", 10_000)),
      service.grantXp(grant("op:concurrent", 10_000))
    ]);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.every((result) => result.resultingXp === 10_000)).toBe(true);
    expect(database.operationCount()).toBe(1);
  });

  it("retains XP beyond the level cap and returns it on replay", async () => {
    const database = createProgressionDatabase(999_990);
    const service = new ProgressionService(database.pool);
    const first = await service.grantXp(grant("op:cap", 50));
    const replay = await service.grantXp(grant("op:cap", 50));
    expect(first).toMatchObject({
      grantedXp: 50,
      discardedXp: 0,
      resultingXp: 1_000_040,
      resultingLevel: 25
    });
    expect(replay).toMatchObject({ grantedXp: 50, discardedXp: 0, replayed: true });
  });

  it("identifies every completed post-cap reward cycle across one grant", () => {
    expect(calculateXpTransition(1_249_990, 500_020)).toMatchObject({
      resultingXp: 1_750_010,
      grantedXp: 500_020,
      discardedXp: 0,
      postCapRewardCycles: [1, 2, 3]
    });
  });

  it("uses the exact 4/6/8/10/12/16/20/24 rarity bands deterministically", () => {
    const counts = new Map<string, number>();
    for (let roll = 0; roll < 100; roll += 1) {
      const variant = enchantmentStoneVariantForRoll(roll);
      counts.set(variant, (counts.get(variant) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      diamond: 4,
      onyx: 6,
      opal: 8,
      amethyst: 10,
      topaz: 12,
      sapphire: 16,
      ruby: 20,
      emerald: 24
    });
    expect(resolveEnchantmentStoneVariant("same-operation", 1))
      .toBe(resolveEnchantmentStoneVariant("same-operation", 1));
  });

  it("keeps historical grant fields but reprojects the live replay snapshot", async () => {
    const database = createProgressionDatabase(100_000);
    const service = new ProgressionService(database.pool);
    const first = await service.grantXp(grant("op:curve-transition", 0));
    database.replaceStoredProjection("op:curve-transition", {
      ...first.progression,
      level: 11,
      curveVersion: 1
    });

    const replay = await service.grantXp(grant("op:curve-transition", 0));
    expect(replay).toMatchObject({
      requestedXp: first.requestedXp,
      grantedXp: first.grantedXp,
      resultingXp: first.resultingXp,
      resultingLevel: first.resultingLevel,
      replayed: true,
      progression: {
        totalXp: 100_000,
        level: 8,
        curveVersion: 3
      }
    });
  });

  it("rejects malformed grants and conflicting operation-key reuse", async () => {
    const service = new ProgressionService(createProgressionDatabase().pool);
    await expect(service.grantXp(grant("bad", -1))).rejects.toThrow(/nonnegative/i);
    await service.grantXp(grant("same-key", 10));
    await expect(service.grantXp(grant("same-key", 11))).rejects.toThrow(/conflicts/i);
  });
});

function grant(operationKey: string, requestedXp: number): XpGrantInput {
  return {
    operationKey,
    playerId: "player-1",
    sourceType: "development",
    sourceId: "test",
    requestedXp
  };
}

type Profile = { totalXp: number; level: number; version: number; curveVersion: number };
type Operation = {
  playerId: string;
  sourceType: string;
  sourceId: string | null;
  requestedXp: number;
  grantedXp: number;
  replayResult: unknown;
};
type Penalty = { playerId: string; basisPoints: number; basisXp: number; floorXp: number; xpLost: number; replayResult: unknown };
type State = { profile: Profile; operations: Map<string, Operation>; penalties: Map<string, Penalty> };

function createProgressionDatabase(initialXp = 0): {
  pool: pg.Pool;
  operationCount(): number;
  penaltyCount(): number;
  replaceStoredProjection(operationKey: string, projection: unknown): void;
} {
  let committed: State = {
    profile: {
      totalXp: initialXp,
      level: levelForTotalXp(initialXp),
      version: 0,
      curveVersion: 3
    },
    operations: new Map(),
    penalties: new Map()
  };
  let tail = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = tail;
    tail = previous.then(() => gate);
    await previous;
    return release;
  };
  const pool = {
    query: async <T>(text: string, values?: readonly unknown[]) =>
      queryState<T>(committed, text, values),
    connect: async () => {
      let transaction: State | null = null;
      let release: (() => void) | null = null;
      return {
        query: async <T>(text: string, values?: readonly unknown[]) => {
          if (text === "BEGIN") {
            release = await acquire();
            transaction = cloneState(committed);
            return empty<T>();
          }
          if (text === "COMMIT") {
            if (!transaction) throw new Error("No transaction");
            committed = cloneState(transaction);
            transaction = null;
            release?.();
            release = null;
            return empty<T>();
          }
          if (text === "ROLLBACK") {
            transaction = null;
            release?.();
            release = null;
            return empty<T>();
          }
          if (!transaction) throw new Error("Query outside transaction");
          return queryState<T>(transaction, text, values);
        },
        release: () => undefined
      };
    }
  } as unknown as pg.Pool;
  return {
    pool,
    operationCount: () => committed.operations.size,
    penaltyCount: () => committed.penalties.size,
    replaceStoredProjection: (operationKey, projection) => {
      const operation = committed.operations.get(operationKey);
      if (!operation || typeof operation.replayResult !== "object" || !operation.replayResult) {
        throw new Error("Stored progression replay does not exist");
      }
      operation.replayResult = {
        ...operation.replayResult,
        progression: projection
      };
    }
  };
}

async function queryState<T>(
  state: State,
  text: string,
  values?: readonly unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  if (text.includes("INSERT INTO player_progression_profiles")) return empty<T>();
  if (text.includes("FROM xp_operations WHERE operation_key")) {
    const operation = state.operations.get(String(values?.[0]));
    return operation
      ? one<T>({
          player_id: operation.playerId,
          source_type: operation.sourceType,
          source_id: operation.sourceId,
          requested_xp: operation.requestedXp,
          replay_result: operation.replayResult
        })
      : empty<T>();
  }
  if (text.includes("FROM player_death_xp_penalties") && text.includes("WHERE operation_key")) {
    const penalty = state.penalties.get(String(values?.[0]));
    return penalty ? one<T>({
      player_id: penalty.playerId,
      penalty_basis_points: penalty.basisPoints,
      xp_lost: penalty.xpLost,
      replay_result: penalty.replayResult
    }) : empty<T>();
  }
  if (text.trimStart().startsWith("SELECT") && text.includes("FROM player_progression_profiles WHERE player_id")) {
    return one<T>(profileRow(state.profile));
  }
  if (text.includes("UPDATE player_progression_profiles")) {
    const expectedVersion = Number(values?.[4]);
    if (state.profile.version !== expectedVersion) return empty<T>();
    state.profile = {
      totalXp: Number(values?.[1]),
      level: Number(values?.[2]),
      version: expectedVersion + 1,
      curveVersion: Number(values?.[3])
    };
    return one<T>(profileRow(state.profile));
  }
  if (text.includes("INSERT INTO xp_operations")) {
    const operationKey = String(values?.[1]);
    state.operations.set(operationKey, {
      playerId: String(values?.[2]),
      sourceType: String(values?.[3]),
      sourceId: values?.[4] === null ? null : String(values?.[4]),
      requestedXp: Number(values?.[5]),
      grantedXp: Number(values?.[6]),
      replayResult: JSON.parse(String(values?.[12]))
    });
    return empty<T>();
  }
  if (text.includes("INSERT INTO xp_events")) return empty<T>();
  // The test player is in no kingdom: the kingdom member XP feed credits nothing.
  if (text.includes("INSERT INTO kingdom_member_xp_days")) return empty<T>();
  if (text.includes("INSERT INTO player_death_xp_penalties")) {
    state.penalties.set(String(values?.[1]), {
      playerId: String(values?.[2]),
      basisPoints: Number(values?.[3]),
      xpLost: Number(values?.[6]),
      basisXp: Number(values?.[7]),
      floorXp: Number(values?.[8]),
      replayResult: JSON.parse(String(values?.[11]))
    });
    return empty<T>();
  }
  if (text.includes("dev_progression_operations")) {
    const granted = [...state.operations.values()].reduce((sum, operation) => sum + operation.grantedXp, 0);
    const lost = [...state.penalties.values()].reduce((sum, penalty) => sum + penalty.xpLost, 0);
    const ledger = granted - lost;
    return one<T>({ total_xp: state.profile.totalXp, ledger_xp: String(ledger) });
  }
  throw new Error(`Unhandled progression test query: ${text}`);
}

function profileRow(profile: Profile) {
  return {
    player_id: "player-1",
    total_xp: profile.totalXp,
    level: profile.level,
    curve_version: profile.curveVersion,
    persistence_version: profile.version
  };
}

function cloneState(state: State): State {
  return {
    profile: { ...state.profile },
    operations: new Map([...state.operations].map(([key, value]) => [key, structuredClone(value)])),
    penalties: new Map([...state.penalties].map(([key, value]) => [key, structuredClone(value)]))
  };
}

function one<T>(row: unknown): { rows: T[]; rowCount: number } {
  return { rows: [row as T], rowCount: 1 };
}

function empty<T>(): { rows: T[]; rowCount: number } {
  return { rows: [], rowCount: 0 };
}

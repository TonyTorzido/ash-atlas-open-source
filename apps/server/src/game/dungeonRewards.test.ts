import {
  DUNGEON_CATALOG,
  DUNGEON_TORCH_CHANCE_BONUS_CAP_PCT,
  dungeonRewardRollSeed,
  dungeonTorchBonusSlots,
  dungeonTorchChanceBonusPct,
  resolveDungeonChestLoot,
  type DungeonCatalog
} from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { MOB_DEFINITIONS } from "./combat/mobDefinitions.js";
import { InventoryCapacityError } from "./inventory.js";
import { DungeonRewardService } from "./dungeonRewards.js";

describe("DungeonRewardService", () => {
  it("commits one durable inventory and wallet grant under replay", async () => {
    const claimedRuns = new Set<string>();
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("FROM dungeon_reward_claims")) return { rows: claimedRuns.has(String(parameters?.[0])) ? [{
        dungeon_id: "cistern_warrens", reward_table_id: "basic_dungeon_chest",
        reward_revision: "basic-dungeon-chest-v1"
      }] : [] };
      if (sql.includes("SELECT account_id")) return { rows: [{ account_id: "account-1" }] };
      if (sql.includes("INSERT INTO dungeon_reward_claims")) claimedRuns.add(String(parameters?.[1]));
      return { rows: [] };
    });
    const inventorySnapshot = { playerId: "player-1", revision: 1, items: [], totals: {} };
    const walletSnapshot = { playerId: "player-1", gold: "25", revision: "1" };
    const inventory = {
      grantItemsForOperationInTransaction: vi.fn(async () => ({ applied: true, inventory: inventorySnapshot })),
      snapshotInTransaction: vi.fn(async () => inventorySnapshot)
    };
    const wallet = {
      creditForOperationInTransaction: vi.fn(async () => ({ applied: true })),
      snapshotInTransaction: vi.fn(async () => walletSnapshot)
    };
    const service = new DungeonRewardService(fakePool(query), rewardCatalog(), {
      inventory: inventory as never, wallet: wallet as never
    });
    const input = { instanceId: "dungeon:cave-a:player:player-1",
      runId: "00000000-0000-4000-8000-000000000001", playerId: "player-1",
      dungeonId: "cistern_warrens", rewardSourceId: "chest-a", rewardTableId: "basic_dungeon_chest" };
    const first = await service.grant(input);
    expect(first).toMatchObject({ applied: true, inventory: inventorySnapshot, wallet: walletSnapshot });
    // The settled grant list mirrors what was actually granted for the client to present.
    const grantCall = inventory.grantItemsForOperationInTransaction.mock.calls[0] as unknown as
      [unknown, { grants: Array<{ itemId: string; quantity: number }> }];
    expect(first.items).toEqual(grantCall[1].grants.map(({ itemId, quantity }) => ({ itemId, quantity })));
    // An idempotent replay never re-announces loot.
    await expect(service.grant(input)).resolves.toEqual({
      applied: false, inventory: inventorySnapshot, wallet: walletSnapshot, items: [], gold: 0
    });
    await expect(service.grant({ ...input,
      runId: "00000000-0000-4000-8000-000000000002" })).resolves.toMatchObject({ applied: true });
    expect(inventory.grantItemsForOperationInTransaction).toHaveBeenCalledTimes(2);
    expect(wallet.creditForOperationInTransaction).toHaveBeenCalledTimes(2);
  });

  it("rolls back without consuming the claim when a non-partial item grant exceeds capacity", async () => {
    let claimed = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM dungeon_reward_claims")) return { rows: [] };
      if (sql.includes("SELECT account_id")) return { rows: [{ account_id: "account-1" }] };
      if (sql.includes("INSERT INTO dungeon_reward_claims")) claimed = true;
      return { rows: [] };
    });
    const inventory = { grantItemsForOperationInTransaction: vi.fn(async () => {
      throw new InventoryCapacityError([]);
    }) };
    const wallet = { creditForOperationInTransaction: vi.fn() };
    const service = new DungeonRewardService(fakePool(query), rewardCatalog(), {
      inventory: inventory as never, wallet: wallet as never
    });
    await expect(service.grant({ instanceId: "dungeon:cave-a:player:player-1",
      runId: "00000000-0000-4000-8000-000000000001", playerId: "player-1",
      dungeonId: "cistern_warrens", rewardSourceId: "chest-a",
      rewardTableId: "basic_dungeon_chest" })).rejects.toBeInstanceOf(InventoryCapacityError);
    expect(claimed).toBe(false);
    expect(wallet.creditForOperationInTransaction).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });
});

function rewardCatalog(): DungeonCatalog {
  const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
  catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!.rewardTableIds = ["basic_dungeon_chest"];
  return catalog;
}

function fakePool(query: ReturnType<typeof vi.fn>): pg.Pool {
  return {
    connect: vi.fn(async () => ({ query, release: vi.fn() }))
  } as unknown as pg.Pool;
}

describe("live dungeon boss tokens", () => {
  // Boss mob archetype, its dungeon's boss encounter, and the token each member gets per clear.
  const BOSSES = [
    { mob: "brood_matriarch", dungeonId: "cistern_warrens", encounterId: "brood-boss", token: "brood_silk", chancePct: 35, min: 1, max: 1 },
    { mob: "raptor_chieftain", dungeonId: "fangrock_cavern", encounterId: "raptor_chieftain", token: "raptor_scale", chancePct: 30, min: 1, max: 1 },
    { mob: "thunderwing", dungeonId: "the_eyrie", encounterId: "thunderwing", token: "giant_egg", chancePct: 25, min: 1, max: 1 },
    { mob: "hollow_elder", dungeonId: "blightwood_grove", encounterId: "hollow_elder", token: "elder_acorn", chancePct: 35, min: 1, max: 3 }
  ] as const;

  it("rolls the token per member from the completion reward, never from the boss mob", () => {
    for (const boss of BOSSES) {
      const rewards = MOB_DEFINITIONS[boss.mob].rewards;
      expect(rewards.items.some((item) => item.itemId === boss.token), boss.mob).toBe(false);
      expect(rewards.gold, boss.mob).toBeGreaterThan(0);
      const dungeon = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === boss.dungeonId)!;
      const payouts = dungeon.triggers.filter((trigger) => !trigger.retired && trigger.enabled &&
        trigger.event.type === "encounter_state" && trigger.event.encounterId === boss.encounterId &&
        trigger.event.state === "completed")
        .flatMap((trigger) => trigger.actions.flatMap((action) => action.type === "grant_run_reward"
          ? [{ trigger, action }] : []));
      expect(payouts, boss.dungeonId).toHaveLength(1);
      expect(payouts[0]!.trigger).toMatchObject({ scope: "instance", repetition: "once" });
      expect(payouts[0]!.action.recipients).toBe("present");
      const table = DUNGEON_CATALOG.rewardTables.find((candidate) => candidate.id === payouts[0]!.action.rewardTableId)!;
      expect(dungeon.rewardTableIds).toContain(table.id);
      expect(table.items.some((item) => item.itemId === boss.token), table.id).toBe(false);
      expect(table.chanceItems).toEqual([{ itemId: boss.token, chancePct: boss.chancePct,
        minQuantity: boss.min, maxQuantity: boss.max, torchScaling: true }]);
      // No other live reward table guarantees the token; only the Fangrock vault adds a small extra chance.
      for (const other of DUNGEON_CATALOG.rewardTables.filter((candidate) => candidate.id !== table.id)) {
        expect(other.items.some((item) => item.itemId === boss.token), other.id).toBe(false);
        expect(other.chanceItems?.some((entry) => entry.itemId === boss.token) ?? false, other.id)
          .toBe(other.id === "fangrock_cavern_vault_chest_reward" && boss.token === "raptor_scale");
        expect(other.chestLoot?.rarities.some((row) => row.loot.some((loot) => loot.itemId === boss.token)) ?? false, other.id).toBe(false);
      }
    }
  });

  it("never pays a token for certain, and a claim seed always resolves the same way", () => {
    for (const boss of BOSSES) {
      const table = DUNGEON_CATALOG.rewardTables.find((candidate) => candidate.id === `${boss.dungeonId}_completion_reward`)!;
      const runs = 2_000;
      let hits = 0;
      for (let run = 0; run < runs; run += 1) {
        const seed = dungeonRewardRollSeed(`run-${run}`, "boss:reward:0", table);
        const loot = resolveDungeonChestLoot(table, seed, 0, { torchTotal: 1, memberId: "player-1" });
        expect(resolveDungeonChestLoot(table, seed, 0, { torchTotal: 1, memberId: "player-1" })).toEqual(loot);
        const token = loot.items.find((item) => item.itemId === boss.token);
        if (token) {
          hits += 1;
          expect(token.quantity).toBeGreaterThanOrEqual(boss.min);
          expect(token.quantity).toBeLessThanOrEqual(boss.max);
        }
      }
      expect(hits, boss.token).toBeGreaterThan(0);
      expect(hits / runs, boss.token).toBeCloseTo(boss.chancePct / 100, 1);
    }
  });

  it("rolls each party member independently from the same run seed", () => {
    const table = DUNGEON_CATALOG.rewardTables.find((candidate) => candidate.id === "cistern_warrens_completion_reward")!;
    const seed = dungeonRewardRollSeed("run-party", "brood-boss:reward:0", table);
    const outcomes = new Set(Array.from({ length: 40 }, (_, member) =>
      resolveDungeonChestLoot(table, seed, 0, { torchTotal: 1, memberId: `player-${member}` }).items.length));
    expect(outcomes).toEqual(new Set([0, 1]));
  });

  it("adds five points of token chance per torch beyond the first, capped at plus 25", () => {
    expect([1, 2, 3, 6, 7, 20].map((torches) => dungeonTorchChanceBonusPct(torches))).toEqual([0, 5, 10, 25, 25, 25]);
    expect(dungeonTorchChanceBonusPct(undefined)).toBe(0);
    expect(DUNGEON_TORCH_CHANCE_BONUS_CAP_PCT).toBe(25);
    const table = DUNGEON_CATALOG.rewardTables.find((candidate) => candidate.id === "fangrock_cavern_completion_reward")!;
    const rate = (torchTotal: number) => {
      let hits = 0;
      for (let run = 0; run < 4_000; run += 1) {
        const seed = dungeonRewardRollSeed(`run-${run}`, "boss:reward:0", table);
        if (resolveDungeonChestLoot(table, seed, 0, { torchTotal, memberId: "player-1" }).items.length > 0) hits += 1;
      }
      return hits / 4_000;
    };
    expect(rate(1)).toBeCloseTo(0.30, 1);
    expect(rate(6)).toBeCloseTo(0.55, 1);
    expect(rate(6)).toBeGreaterThan(rate(1));
    // The vault's extra chance does not scale with torches.
    const vault = DUNGEON_CATALOG.rewardTables.find((candidate) => candidate.id === "fangrock_cavern_vault_chest_reward")!;
    expect(vault.chanceItems).toEqual([{ itemId: "raptor_scale", chancePct: 10, minQuantity: 1, maxQuantity: 1 }]);
  });

  it("adds one completion-chest slot per torch beyond the first", () => {
    const table = DUNGEON_CATALOG.rewardTables.find((candidate) => candidate.id === "fangrock_cavern_throne_chest_reward")!;
    expect(table.torchBonusSlots).toBe(true);
    expect(dungeonTorchBonusSlots(table, 1)).toBe(0);
    expect(dungeonTorchBonusSlots(table, 4)).toBe(3);
    expect(dungeonTorchBonusSlots({ torchBonusSlots: undefined }, 4)).toBe(0);
    const seed = dungeonRewardRollSeed("00000000-0000-4000-8000-000000000001", "throne_chest_reward:reward:0", table);
    const base = resolveDungeonChestLoot(table, seed);
    const boosted = resolveDungeonChestLoot(table, seed, dungeonTorchBonusSlots(table, 3));
    const count = (loot: typeof base) => loot.items.length === 0 ? 0 : loot.items.reduce((sum, item) => sum + item.quantity, 0);
    expect(boosted.rarity).toBe(base.rarity);
    expect(count(boosted)).toBeGreaterThan(count(base));
  });
});

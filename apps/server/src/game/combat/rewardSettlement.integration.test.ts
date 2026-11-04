import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PLAYER_BASE_INVENTORY_SLOTS,
  RESOURCE_STACK_LIMITS
} from "@ash-atlas/shared";

import { runMigrations } from "../../db/migrate.js";
import { createLogger } from "../../logger.js";
import { ClassService } from "../classes/classService.js";
import { InventoryService } from "../inventory.js";
import { MasteryService } from "../masteries.js";
import { ProgressionService } from "../progression.js";
import { WalletService } from "../wallet.js";
import type { CombatDefeatSettlementCandidate } from "./combatEngine.js";
import {
  COMBAT_ITEM_REWARD_POLICY_VERSION,
  MOB_DEFINITIONS
} from "./mobDefinitions.js";
import {
  CombatRewardSettlementService,
  resolveChanceBasedItemRewards,
  scaledMobGoldReward,
  type CombatSettlementResult
} from "./rewardSettlement.js";

const LEGACY_V2_DEER_CHANCE_REWARDS = [
  { itemId: "deer_hide", quantity: 1, probability: 0.5, rollId: "deer_hide_quantity" },
  { itemId: "deer_hide", quantity: 2, probability: 0.3, rollId: "deer_hide_quantity" },
  { itemId: "deer_hide", quantity: 3, probability: 0.2, rollId: "deer_hide_quantity" }
] as const;

const databaseUrl = process.env.COMBAT_REWARD_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("durable combat reward inbox PostgreSQL integration", () => {
  let pool: pg.Pool;
  let progression: ProgressionService;
  let prefix: string;
  let accountId: string;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    progression = new ProgressionService(pool);
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    accountId = randomUUID();
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES (
         'reward-player',$1,'RewardPlayer','GLOBAL',40,-105,40,-105,100,true,
         ST_SetSRID(ST_MakePoint(-105,40),4326)
       )`
      ,
      [accountId]
    );
    prefix = `reward-${randomUUID()}`;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("claims distinct durable rows across two services and grants XP exactly once", async () => {
    const first = service();
    const second = service();
    const candidates = Array.from({ length: 20 }, (_, index) => candidate(index));
    await Promise.all(candidates.map((entry) => first.accept(entry)));
    await Promise.all([first.flush(), second.flush()]);

    const settlements = await pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM combat_reward_settlements
       WHERE settlement_key LIKE $1
       GROUP BY status`,
      [`${prefix}%`]
    );
    expect(settlements.rows).toEqual([{ status: "completed", count: "20" }]);
    const operations = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM xp_operations WHERE source_id LIKE $1`,
      [`${prefix}%`]
    );
    expect(operations.rows[0]?.count).toBe("20");

    await Promise.all(candidates.map((entry) => second.accept(entry)));
    await second.flush();
    expect((await pool.query(
      `SELECT 1 FROM xp_operations WHERE source_id LIKE $1`,
      [`${prefix}%`]
    )).rowCount).toBe(20);
  });

  it("reconciles a candidate accepted before a simulated process crash", async () => {
    const beforeCrash = service();
    await beforeCrash.accept(candidate(0));
    expect((await pool.query(
      `SELECT candidate->>'settlementKey' AS key
       FROM combat_reward_settlements WHERE settlement_key = $1`,
      [candidate(0).settlementKey]
    )).rows[0]?.key).toBe(candidate(0).settlementKey);

    const restarted = service();
    await expect(restarted.recoverIncomplete()).resolves.toBe(1);
    expect((await pool.query(
      `SELECT status FROM combat_reward_settlements WHERE settlement_key = $1`,
      [candidate(0).settlementKey]
    )).rows[0]?.status).toBe("completed");
  });

  it("replays a failed wolf settlement without duplicating XP, Wolf Pelt, or Gold rewards", async () => {
    const settlement = candidate(99);
    settlement.settlementKey = `mob:wolf-slot:${randomUUID()}:defeat:1`;
    settlement.defeatedEntityId = settlement.settlementKey.replace(/:defeat:1$/, "");
    const first = service(true);
    await first.accept(settlement);
    await first.flush();

    const beforeReplay = await rewardState(settlement.settlementKey);
    expect(beforeReplay).toMatchObject({
      character_operations: 1,
      hunter_operations: 0,
      hunter_xp: null,
      wolf_pelt: 1
    });
    expect(await groundDropCount(settlement.settlementKey)).toBe(0);
    await pool.query(
      `UPDATE combat_reward_settlements
       SET status = 'failed', result = NULL, completed_at = NULL, next_retry_at = now()
       WHERE settlement_key = $1`,
      [settlement.settlementKey]
    );

    const restarted = service(true);
    await expect(restarted.recoverIncomplete()).resolves.toBe(1);
    expect(await rewardState(settlement.settlementKey)).toEqual(beforeReplay);
    expect((await pool.query(
      `SELECT status FROM combat_reward_settlements WHERE settlement_key = $1`,
      [settlement.settlementKey]
    )).rows[0]?.status).toBe("completed");
  });

  it("grants no retired Hunter XP for an alligator, including on replay", async () => {
    const settlement = candidate(101);
    settlement.settlementKey = `mob:alligator:${randomUUID()}:defeat:1`;
    settlement.defeatedEntityId = settlement.settlementKey.replace(/:defeat:1$/, "");
    settlement.mobArchetype = "alligator";
    const rewards = service(true);
    await rewards.accept(settlement);
    await rewards.flush();

    const beforeReplay = await rewardState(settlement.settlementKey);
    expect(beforeReplay).toMatchObject({ character_operations: 1, hunter_operations: 0, hunter_xp: null });
    await pool.query(
      `UPDATE combat_reward_settlements
       SET status = 'failed', result = NULL, completed_at = NULL, next_retry_at = now()
       WHERE settlement_key = $1`,
      [settlement.settlementKey]
    );

    await expect(service(true).recoverIncomplete()).resolves.toBe(1);
    expect(await rewardState(settlement.settlementKey)).toEqual(beforeReplay);
  });

  it("replays Bear rewards without duplicating one Bear Hide, XP, or Gold", async () => {
    const settlement = candidate(102);
    settlement.settlementKey = `mob:bear:${randomUUID()}:defeat:1`;
    settlement.defeatedEntityId =
      settlement.settlementKey.replace(/:defeat:1$/, "");
    settlement.mobArchetype = "bear";
    const rewards = service(true);
    await rewards.accept(settlement);
    await rewards.flush();

    const beforeReplay = await rewardState(settlement.settlementKey);
    expect(beforeReplay).toMatchObject({
      character_operations: 1,
      item_operations: 1,
      gold_operations: 1,
      bear_hide: 1
    });
    expect(await groundDropCount(settlement.settlementKey)).toBe(0);
    await pool.query(
      `UPDATE combat_reward_settlements
       SET status = 'failed', result = NULL, completed_at = NULL,
           next_retry_at = now()
       WHERE settlement_key = $1`,
      [settlement.settlementKey]
    );

    await expect(service(true).recoverIncomplete()).resolves.toBe(1);
    expect(await rewardState(settlement.settlementKey)).toEqual(beforeReplay);
  });

  it("awards guaranteed Jellyfish Venom directly to inventory and replays it exactly once", async () => {
    const settlement = candidate(103);
    settlement.settlementKey = `mob:jellyfish-ground:${randomUUID()}:defeat:1`;
    settlement.defeatedEntityId = settlement.settlementKey.replace(/:defeat:1$/, "");
    settlement.mobArchetype = "jellyfish";
    settlement.lootLocation = {
      regionCode: "test-package",
      zoneId: "test-zone",
      position: { lat: 40.12345, lon: -105.54321 }
    };
    const rewards = service(true);
    await rewards.accept(settlement);
    await rewards.flush();

    expect((await new InventoryService(pool).getInventorySnapshot("reward-player"))
      .totals.jellyfish_venom).toBe(1);
    expect(await groundDropCount(settlement.settlementKey)).toBe(0);

    await pool.query(
      `UPDATE combat_reward_settlements
       SET status='failed',result=NULL,completed_at=NULL,next_retry_at=now()
       WHERE settlement_key=$1`,
      [settlement.settlementKey]
    );
    await expect(service(true).recoverIncomplete()).resolves.toBe(1);
    expect((await new InventoryService(pool).getInventorySnapshot("reward-player"))
      .totals.jellyfish_venom).toBe(1);
  });

  it("preserves a queued V2 Deer Hide payout and replays it exactly once", async () => {
    const settlement = candidate(100);
    settlement.settlementKey = `mob:deer:${randomUUID()}:defeat:1`;
    settlement.defeatedEntityId =
      settlement.settlementKey.replace(/:defeat:1$/, "");
    settlement.mobArchetype = "deer";
    const inventory = new InventoryService(pool);
    const before = await inventory.getInventorySnapshot("reward-player");
    const rewards = service(true);
    const gold = scaledMobGoldReward({
      baseGold: MOB_DEFINITIONS.deer.rewards.gold,
      mobLevel: MOB_DEFINITIONS.deer.level,
      settlementKey: settlement.settlementKey
    });
    const expectedQuantity = resolveChanceBasedItemRewards({
      settlementKey: settlement.settlementKey,
      mobArchetype: "deer",
      mobBalanceVersion: MOB_DEFINITIONS.deer.balanceVersion,
      rewards: LEGACY_V2_DEER_CHANCE_REWARDS
    })[0]!.quantity;

    await rewards.accept(settlement);
    await rewards.flush();

    const completed = await pool.query<{
      status: string;
      result: CombatSettlementResult;
    }>(
      `SELECT status,result
       FROM combat_reward_settlements
       WHERE settlement_key=$1`,
      [settlement.settlementKey]
    );
    const after = await inventory.getInventorySnapshot("reward-player");
    expect(completed.rows[0]).toMatchObject({
      status: "completed",
      result: {
        mobArchetype: "deer",
        mobReward: {
          items: [{ itemId: "deer_hide", quantity: expectedQuantity }],
          gold,
          walletGold: String(gold),
          walletVersion: "1",
          inventory: {
            totals: { deer_hide: expectedQuantity },
            revision: before.revision + 1
          }
        }
      }
    });
    expect(after).toMatchObject({
      totals: { deer_hide: expectedQuantity },
      revision: before.revision + 1
    });
    expect(await walletState()).toEqual({ gold: String(gold), version: "1" });
    const firstLedger = await deerLedgerState(settlement.settlementKey);
    expect(firstLedger).toEqual({
      item_operations: 1,
      deer_hide_events: 1,
      deer_hide_delta: expectedQuantity,
      gold_operations: 1
    });

    await pool.query(
      `UPDATE combat_reward_settlements
       SET status='failed',result=NULL,completed_at=NULL,next_retry_at=now()
       WHERE settlement_key=$1`,
      [settlement.settlementKey]
    );
    await expect(service(true).recoverIncomplete()).resolves.toBe(1);

    expect(await deerLedgerState(settlement.settlementKey))
      .toEqual(firstLedger);
    expect(await inventory.getInventorySnapshot("reward-player"))
      .toMatchObject({
        totals: { deer_hide: expectedQuantity },
        revision: before.revision + 1
      });
  });

  it("replays V3 Deer Leather and Deer Hide without duplicating either item", async () => {
    const settlement = candidate(104);
    settlement.settlementKey = "mob:deer-v3-replay:299569:defeat:1";
    settlement.defeatedEntityId = "mob:deer-v3-replay:299569";
    settlement.mobArchetype = "deer";
    settlement.itemRewardPolicyVersion = 3;
    const expectedItems = resolveChanceBasedItemRewards({
      settlementKey: settlement.settlementKey,
      mobArchetype: "deer",
      mobBalanceVersion: MOB_DEFINITIONS.deer.balanceVersion,
      rewards: MOB_DEFINITIONS.deer.rewards.chanceItems
    });
    expect(expectedItems).toEqual([
      { itemId: "leather", quantity: 3 },
      { itemId: "deer_hide", quantity: 1 }
    ]);

    const rewards = service(true);
    await rewards.accept(settlement);
    await rewards.flush();

    const beforeReplay = await deerV3LedgerState(settlement.settlementKey);
    expect(beforeReplay).toEqual({
      item_operations: 1,
      leather_events: 1,
      leather_delta: 3,
      deer_hide_events: 1,
      deer_hide_delta: 1,
      leather_total: 3,
      deer_hide_total: 1
    });
    await pool.query(
      `UPDATE combat_reward_settlements
       SET status='failed',result=NULL,completed_at=NULL,next_retry_at=now()
       WHERE settlement_key=$1`,
      [settlement.settlementKey]
    );

    await expect(service(true).recoverIncomplete()).resolves.toBe(1);
    expect(await deerV3LedgerState(settlement.settlementKey)).toEqual(beforeReplay);
  });

  it("keeps a nonzero wallet unchanged for an item-only zero-Gold reward", async () => {
    await seedWallet(47n);
    const settlement = candidate(101);
    settlement.settlementKey = `mob:deer:${randomUUID()}:defeat:1`;
    settlement.defeatedEntityId = settlement.settlementKey.replace(/:defeat:1$/, "");
    settlement.mobArchetype = "deer";
    settlement.itemRewardPolicyVersion = 3;
    const expectedItems = resolveChanceBasedItemRewards({
      settlementKey: settlement.settlementKey,
      mobArchetype: "deer",
      mobBalanceVersion: MOB_DEFINITIONS.deer.balanceVersion,
      rewards: MOB_DEFINITIONS.deer.rewards.chanceItems
    });
    const originalGold = MOB_DEFINITIONS.deer.rewards.gold;
    MOB_DEFINITIONS.deer.rewards.gold = 0;
    try {
      const completed: CombatSettlementResult[] = [];
      const masteries = new MasteryService(pool);
      const rewards = new CombatRewardSettlementService(
        pool,
        progression,
        createLogger("test"),
        (result) => completed.push(result),
        new ClassService(pool, masteries),
        new InventoryService(pool),
        masteries,
        new WalletService()
      );
      await rewards.accept(settlement);
      await rewards.flush();

      expect(await walletState()).toEqual({ gold: "47", version: "1" });
      expect((await pool.query(
        `SELECT 1 FROM wallet_events
         WHERE operation_key=$1`,
        [`combat-gold:${settlement.settlementKey}`]
      )).rowCount).toBe(0);
      expect(completed).toHaveLength(1);
      expect(completed[0]?.mobReward).toMatchObject({
        items: expectedItems,
        gold: 0
      });
      expect(completed[0]?.mobReward).not.toHaveProperty("walletGold");
      expect(completed[0]?.mobReward).not.toHaveProperty("walletVersion");

      const reconnected = new pg.Pool({ connectionString: databaseUrl!, max: 1 });
      try {
        const snapshot = await reconnected.query<{ gold_balance: string }>(
          `SELECT gold_balance::text
           FROM player_wallets
           WHERE player_id='reward-player'`
        );
        expect(snapshot.rows[0]?.gold_balance).toBe("47");
      } finally {
        await reconnected.end();
      }
    } finally {
      MOB_DEFINITIONS.deer.rewards.gold = originalGold;
    }
  });

  it("stores one deterministic ogre shard roll per death and preserves existing ogre rewards", async () => {
    const rolls = [0, 0.5, 0.9];
    const settlements = [0, 1, 2].map((index) => {
      const entry = candidate(200 + index);
      entry.mobArchetype = "ogre";
      return entry;
    });
    const rewards = service(true, () => rolls.shift()!);
    for (const settlement of settlements) await rewards.accept(settlement);
    await rewards.accept(settlements[2]!);
    await rewards.flush();

    const durable = await pool.query<{
      settlement_key: string;
      atlas_shrine_shard_quantity: number;
    }>(
      `SELECT settlement_key,atlas_shrine_shard_quantity
       FROM combat_reward_settlements
       WHERE settlement_key = ANY($1::text[])
       ORDER BY settlement_key`,
      [settlements.map(({ settlementKey }) => settlementKey)]
    );
    expect(durable.rows.map(({ atlas_shrine_shard_quantity }) =>
      Number(atlas_shrine_shard_quantity)
    )).toEqual([0, 1, 2]);
    const inventory = await new InventoryService(pool).getInventorySnapshot("reward-player");
    expect(inventory.totals.atlas_shrine_shard).toBe(3);
    expect(inventory.totals.stone).toBeGreaterThan(0);
    const twoShardResult = await pool.query<{ result: CombatSettlementResult }>(
      `SELECT result FROM combat_reward_settlements WHERE settlement_key=$1`,
      [settlements[2]!.settlementKey]
    );
    expect([...(twoShardResult.rows[0]?.result.mobReward?.items ?? [])]
      .sort((left, right) => left.itemId.localeCompare(right.itemId))).toEqual([
        { itemId: "atlas_shrine_shard", quantity: 2 },
        { itemId: "stone", quantity: 1 }
      ]);
    expect(await groundDropCount(settlements[2]!.settlementKey)).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM inventory_operations
       WHERE operation_key = $1`,
      [`combat-items:${settlements[2]!.settlementKey}`]
    )).rowCount).toBe(1);
  });

  it("uses ground delivery only when the reward definition explicitly requests it", async () => {
    const settlement = candidate(300);
    settlement.mobArchetype = "jellyfish";
    settlement.itemRewardPolicyVersion = COMBAT_ITEM_REWARD_POLICY_VERSION;
    const rewards = MOB_DEFINITIONS.jellyfish.rewards;
    rewards.itemDelivery = "ground";
    try {
      const settlementService = service(true);
      await settlementService.accept(settlement);
      await settlementService.flush();
      expect((await new InventoryService(pool).getInventorySnapshot("reward-player"))
        .totals.jellyfish_venom).toBe(0);
      const expectedItems = [
        ...rewards.items,
        ...resolveChanceBasedItemRewards({
          settlementKey: settlement.settlementKey,
          mobArchetype: "jellyfish",
          mobBalanceVersion: MOB_DEFINITIONS.jellyfish.balanceVersion,
          rewards: rewards.chanceItems
        })
      ].map(({ itemId, quantity }) => ({ item_id: itemId, quantity }))
        .sort((left, right) => left.item_id.localeCompare(right.item_id));
      expect((await pool.query(
        `SELECT item_id, remaining_quantity::int AS quantity
         FROM world_item_drops WHERE pile_id=$1 ORDER BY item_id`,
        [`combat:${settlement.settlementKey}`]
      )).rows).toEqual(expectedItems);
    } finally {
      delete rewards.itemDelivery;
    }
  });

  it("falls back to durable ground loot when a direct reward cannot fit", async () => {
    await new InventoryService(pool).grantItemsForOperation({
      operationKey: `${prefix}:fill-inventory`,
      playerId: "reward-player",
      source: "test",
      grants: [{
        itemId: "wood",
        variant: null,
        quantity: DEFAULT_PLAYER_BASE_INVENTORY_SLOTS * RESOURCE_STACK_LIMITS.wood
      }]
    });
    const settlement = candidate(301);
    const settlementService = service(true);
    await settlementService.accept(settlement);
    await settlementService.flush();
    const inventory = await new InventoryService(pool).getInventorySnapshot("reward-player");
    const completed = await pool.query<{ result: CombatSettlementResult }>(
      `SELECT result FROM combat_reward_settlements WHERE settlement_key=$1`,
      [settlement.settlementKey]
    );
    expect(inventory.totals.wolf_pelt).toBe(0);
    expect(completed.rows[0]?.result.mobReward).toMatchObject({
      items: [],
      drops: [{ itemId: "wolf_pelt", quantity: 1 }]
    });
    expect(await groundDropCount(settlement.settlementKey)).toBe(1);
    expect((await pool.query(
      `SELECT item_id,remaining_quantity::integer AS quantity
       FROM world_item_drops WHERE pile_id=$1`,
      [`combat:${settlement.settlementKey}`]
    )).rows).toEqual([{ item_id: "wolf_pelt", quantity: 1 }]);
  });

  it("reports only the inventory-delivered portion of partial combat loot", async () => {
    const inventoryService = new InventoryService(pool);
    await inventoryService.grantItemsForOperation({
      operationKey: `${prefix}:seed-nearly-full-hide`,
      playerId: "reward-player",
      source: "test",
      grants: [{
        itemId: "deer_hide",
        variant: null,
        quantity: RESOURCE_STACK_LIMITS.deer_hide - 1
      }]
    });
    await inventoryService.grantItemsForOperation({
      operationKey: `${prefix}:fill-other-slots`,
      playerId: "reward-player",
      source: "test",
      allowPartial: true,
      grants: [{
        itemId: "wood",
        variant: null,
        quantity: (DEFAULT_PLAYER_BASE_INVENTORY_SLOTS - 1) * RESOURCE_STACK_LIMITS.wood
      }]
    });
    const partialCandidate = Array.from({ length: 32 }, (_, offset) => {
      const settlement = candidate(303 + offset);
      settlement.mobArchetype = "deer";
      const quantity = resolveChanceBasedItemRewards({
        settlementKey: settlement.settlementKey,
        mobArchetype: "deer",
        mobBalanceVersion: MOB_DEFINITIONS.deer.balanceVersion,
        rewards: LEGACY_V2_DEER_CHANCE_REWARDS
      })[0]!.quantity;
      return { settlement, quantity };
    }).find(({ quantity }) => quantity > 1);
    expect(partialCandidate).toBeDefined();
    const { settlement, quantity: expectedQuantity } = partialCandidate!;

    const settlementService = service(true);
    await settlementService.accept(settlement);
    await settlementService.flush();

    const completed = await pool.query<{ result: CombatSettlementResult }>(
      `SELECT result FROM combat_reward_settlements WHERE settlement_key=$1`,
      [settlement.settlementKey]
    );
    expect(completed.rows[0]?.result.mobReward).toMatchObject({
      items: [{ itemId: "deer_hide", quantity: 1 }],
      drops: [{ itemId: "deer_hide", quantity: expectedQuantity - 1 }]
    });
    expect((await inventoryService.getInventorySnapshot("reward-player"))
      .totals.deer_hide).toBe(RESOURCE_STACK_LIMITS.deer_hide);
  });

  it("preserves queued version-one Leather rewards and their historical ground delivery", async () => {
    const settlement = candidate(302);
    delete settlement.itemRewardPolicyVersion;
    const settlementService = service(true);
    await settlementService.accept(settlement);
    await settlementService.flush();
    expect((await new InventoryService(pool).getInventorySnapshot("reward-player"))
      .totals.leather).toBe(0);
    expect((await pool.query(
      `SELECT item_id,remaining_quantity::integer AS quantity
       FROM world_item_drops WHERE pile_id=$1`,
      [`combat:${settlement.settlementKey}`]
    )).rows).toEqual([{ item_id: "leather", quantity: 2 }]);
  });

  function service(
    withAllRewards = false,
    random: () => number = Math.random
  ): CombatRewardSettlementService {
    if (!withAllRewards) return new CombatRewardSettlementService(pool, progression, createLogger("test"));
    const masteries = new MasteryService(pool);
    return new CombatRewardSettlementService(
      pool,
      progression,
      createLogger("test"),
      undefined,
      new ClassService(pool, masteries),
      new InventoryService(pool),
      masteries,
      new WalletService(),
      undefined,
      random
    );
  }

  async function rewardState(settlementKey: string): Promise<Record<string, number>> {
    const result = await pool.query<Record<string, number>>(
      `SELECT
         (SELECT COUNT(*)::int FROM xp_operations WHERE operation_key =
           'combat-settlement:' || $1 || ':reward-player') AS character_operations,
         (SELECT COUNT(*)::int FROM class_progression_operations WHERE operation_key =
           'class-combat-settlement:' || $1 || ':reward-player') AS warrior_operations,
         (SELECT COUNT(*)::int FROM mastery_progression_operations WHERE operation_key =
           'profession-xp:combat:' || $1 || ':reward-player:hunter') AS hunter_operations,
         (SELECT COUNT(*)::int FROM inventory_operations WHERE operation_key =
           'combat-items:' || $1) AS item_operations,
         (SELECT COUNT(*)::int FROM wallet_events WHERE operation_key =
           'combat-gold:' || $1) AS gold_operations,
         (SELECT total_xp::int FROM player_progression_profiles WHERE player_id = 'reward-player') AS character_xp,
         (SELECT mastery_xp::int FROM player_class_progress
           WHERE player_id = 'reward-player' AND class_id = 'warrior') AS warrior_xp,
         (SELECT xp::int FROM player_profession_progress
           WHERE player_id = 'reward-player' AND profession_id = 'hunter') AS hunter_xp,
         COALESCE((SELECT quantity::int FROM player_inventory
           WHERE player_id = 'reward-player' AND resource_type = 'wolf_pelt' AND variant = 'default'), 0) AS wolf_pelt,
         COALESCE((SELECT quantity::int FROM player_inventory
           WHERE player_id = 'reward-player' AND resource_type = 'bear_hide' AND variant = 'default'), 0) AS bear_hide,
         COALESCE((SELECT gold_balance::int FROM player_wallets
           WHERE player_id = 'reward-player'), 0) AS gold`
      ,
      [settlementKey]
    );
    return result.rows[0]!;
  }

  async function deerLedgerState(
    settlementKey: string
  ): Promise<Record<string, number>> {
    const result = await pool.query<Record<string, number>>(
      `SELECT
         (SELECT COUNT(*)::int
          FROM inventory_operations
          WHERE operation_key='combat-items:' || $1) AS item_operations,
         (SELECT COUNT(*)::int
          FROM inventory_events
          WHERE operation_key='combat-items:' || $1
            AND item_id='deer_hide') AS deer_hide_events,
         COALESCE((
           SELECT SUM(delta_quantity)::int
           FROM inventory_events
           WHERE operation_key='combat-items:' || $1
             AND item_id='deer_hide'
         ),0) AS deer_hide_delta,
         (SELECT COUNT(*)::int
          FROM wallet_events
          WHERE operation_key='combat-gold:' || $1) AS gold_operations`,
      [settlementKey]
    );
    return result.rows[0]!;
  }

  async function deerV3LedgerState(
    settlementKey: string
  ): Promise<Record<string, number>> {
    const result = await pool.query<Record<string, number>>(
      `SELECT
         (SELECT COUNT(*)::int
          FROM inventory_operations
          WHERE operation_key='combat-items:' || $1) AS item_operations,
         (SELECT COUNT(*)::int
          FROM inventory_events
          WHERE operation_key='combat-items:' || $1
            AND item_id='leather') AS leather_events,
         COALESCE((SELECT SUM(delta_quantity)::int
          FROM inventory_events
          WHERE operation_key='combat-items:' || $1
            AND item_id='leather'),0) AS leather_delta,
         (SELECT COUNT(*)::int
          FROM inventory_events
          WHERE operation_key='combat-items:' || $1
            AND item_id='deer_hide') AS deer_hide_events,
         COALESCE((SELECT SUM(delta_quantity)::int
          FROM inventory_events
          WHERE operation_key='combat-items:' || $1
            AND item_id='deer_hide'),0) AS deer_hide_delta,
         COALESCE((SELECT quantity::int
          FROM player_inventory
          WHERE player_id='reward-player'
            AND resource_type='leather' AND variant='default'),0) AS leather_total,
         COALESCE((SELECT quantity::int
          FROM player_inventory
          WHERE player_id='reward-player'
            AND resource_type='deer_hide' AND variant='default'),0) AS deer_hide_total`,
      [settlementKey]
    );
    return result.rows[0]!;
  }

  async function seedWallet(amount: bigint): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await new WalletService().creditForOperationInTransaction(client, {
        playerId: "reward-player",
        accountId,
        amount,
        operationKey: `${prefix}:opening-wallet`,
        reason: "test_opening_wallet"
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function walletState(): Promise<{ gold: string; version: string }> {
    const result = await pool.query<{ gold: string; version: string }>(
      `SELECT gold_balance::text AS gold,version::text
       FROM player_wallets
       WHERE player_id='reward-player'`
    );
    return result.rows[0]!;
  }

  function candidate(index: number): CombatDefeatSettlementCandidate {
    return {
      settlementKey: `${prefix}:mob:${index}:defeat:1`,
      defeatedEntityId: `${prefix}:mob:${index}`,
      defeatGeneration: 1,
      eligibleParticipantIds: ["reward-player"],
      contributions: [{ entityId: "reward-player", damage: 100 }],
      serverTick: index + 1,
      mobArchetype: "wolf",
      itemRewardPolicyVersion: 2,
      lootLocation: {
        regionCode: "test-package",
        zoneId: "test-zone",
        position: { lat: 40.12345, lon: -105.54321 }
      }
    };
  }

  async function groundDropCount(settlementKey: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM world_item_drops WHERE pile_id=$1",
      [`combat:${settlementKey}`]
    );
    return result.rows[0]?.count ?? 0;
  }
});

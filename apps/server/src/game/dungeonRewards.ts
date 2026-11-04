import { createHash } from "node:crypto";

import {
  DUNGEON_CATALOG,
  dungeonRewardRollSeed,
  dungeonTorchBonusSlots,
  resolveDungeonChestLoot,
  type DungeonCatalog,
  type DungeonRewardTableDefinition,
  type PlayerInventorySnapshot,
  type PlayerWalletSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import { InventoryService } from "./inventory.js";
import { requireItemDefinition } from "./items.js";
import { WalletService } from "./wallet.js";

export type DungeonRewardGrant = Readonly<{
  instanceId: string;
  runId: string;
  playerId: string;
  dungeonId: string;
  rewardSourceId: string;
  rewardTableId: string;
  /** Torches the run burned; a `torchBonusSlots` table adds one chest slot per torch beyond the first. */
  torchTotal?: number;
}>;

export type DungeonRewardGrantResult = Readonly<{
  applied: boolean;
  inventory: PlayerInventorySnapshot;
  wallet: PlayerWalletSnapshot;
  /** Settled grant list for this claim; empty on an idempotent replay. */
  items: ReadonlyArray<Readonly<{ itemId: string; quantity: number }>>;
  gold: number;
}>;

export class DungeonRewardService {
  private readonly inventory: InventoryService;
  private readonly wallet: WalletService;

  constructor(
    private readonly pool: pg.Pool,
    private readonly catalog: DungeonCatalog = DUNGEON_CATALOG,
    authorities: Readonly<{ inventory?: InventoryService; wallet?: WalletService }> = {}
  ) {
    this.inventory = authorities.inventory ?? new InventoryService(pool);
    this.wallet = authorities.wallet ?? new WalletService(pool);
  }

  async grant(input: DungeonRewardGrant): Promise<DungeonRewardGrantResult> {
    const dungeon = this.catalog.dungeons.find((candidate) =>
      candidate.id === input.dungeonId && !candidate.retired);
    const reward = this.catalog.rewardTables.find((candidate) =>
      candidate.id === input.rewardTableId && !candidate.retired);
    if (!dungeon || !dungeon.rewardTableIds.includes(input.rewardTableId) || !reward) {
      throw new Error("Dungeon reward table is unavailable");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ account_id: string }>(
        "SELECT account_id::text FROM players WHERE id=$1 FOR UPDATE",
        [input.playerId]
      );
      const accountId = account.rows[0]?.account_id;
      if (!accountId) throw new Error("Dungeon reward player is unavailable");
      const existing = await client.query<{
        dungeon_id: string; reward_table_id: string; reward_revision: string;
      }>(`SELECT dungeon_id,reward_table_id,reward_revision
          FROM dungeon_reward_claims
          WHERE run_id=$1::uuid AND player_id=$2 AND reward_source_id=$3
          FOR UPDATE`, [input.runId, input.playerId, input.rewardSourceId]);
      if (existing.rows[0]) {
        assertSameReward(existing.rows[0], input, reward);
        const inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
        const wallet = await this.wallet.snapshotInTransaction(client, input.playerId, accountId);
        await client.query("COMMIT");
        return { applied: false, inventory, wallet, items: [], gold: 0 };
      }
      const operationStem = rewardOperationStem(input);
      const resolvedLoot = resolveDungeonChestLoot(
        reward,
        dungeonRewardRollSeed(input.runId, input.rewardSourceId, reward),
        dungeonTorchBonusSlots(reward, input.torchTotal),
        { torchTotal: input.torchTotal, memberId: input.playerId }
      );
      let inventory: PlayerInventorySnapshot;
      if (resolvedLoot.items.length > 0) {
        inventory = (await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `${operationStem}:items`,
          playerId: input.playerId,
          source: "dungeon_reward",
          sourceEntityType: "dungeon_reward_source",
          sourceEntityId: input.rewardSourceId,
          metadata: { dungeonId: input.dungeonId, instanceId: input.instanceId, runId: input.runId,
            rewardTableId: input.rewardTableId, rewardRevision: reward.revision },
          grants: resolvedLoot.items.map((item) => ({
            itemId: requireItemDefinition(item.itemId).itemId,
            variant: null,
            quantity: item.quantity
          })),
          allowPartial: false
        })).inventory;
      } else {
        inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
      }
      if ((reward.gold ?? 0) > 0) {
        await this.wallet.creditForOperationInTransaction(client, {
          operationKey: `${operationStem}:gold`,
          playerId: input.playerId,
          accountId,
          amount: BigInt(reward.gold!),
          reason: "dungeon_reward",
          metadata: { dungeonId: input.dungeonId, instanceId: input.instanceId, runId: input.runId,
            rewardSourceId: input.rewardSourceId, rewardTableId: input.rewardTableId,
            rewardRevision: reward.revision }
        });
      }
      await client.query(
        `INSERT INTO dungeon_reward_claims
           (instance_id,run_id,player_id,reward_source_id,dungeon_id,reward_table_id,reward_revision)
         VALUES ($1,$2::uuid,$3,$4,$5,$6,$7)`,
        [input.instanceId, input.runId, input.playerId, input.rewardSourceId, input.dungeonId,
          input.rewardTableId, reward.revision]
      );
      const wallet = await this.wallet.snapshotInTransaction(client, input.playerId, accountId);
      await client.query("COMMIT");
      return {
        applied: true,
        inventory,
        wallet,
        items: resolvedLoot.items.map((item) => ({ itemId: item.itemId, quantity: item.quantity })),
        gold: reward.gold ?? 0
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function rewardOperationStem(input: DungeonRewardGrant): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `dungeon-reward:${digest}`;
}

function assertSameReward(
  row: Readonly<{ dungeon_id: string; reward_table_id: string; reward_revision: string }>,
  input: DungeonRewardGrant,
  reward: DungeonRewardTableDefinition
): void {
  if (row.dungeon_id !== input.dungeonId || row.reward_table_id !== input.rewardTableId ||
      row.reward_revision !== reward.revision) {
    throw new Error("Dungeon reward source was reused with different intent");
  }
}

/**
 * HUD line for a dungeon claim the loot card does not already show: replays and empty chests.
 * A claim that granted something returns null; the client reveals it as a loot card with item art.
 */
export function dungeonRewardAnnouncement(
  result: Pick<DungeonRewardGrantResult, "applied" | "items" | "gold">
): string | null {
  if (!result.applied) return "You have already claimed this reward.";
  return result.gold > 0 || result.items.some((item) => item.quantity > 0) ? null : "The chest is empty.";
}

/** Snapshot sent right after a grant: notice-free for a claim the loot card shows, a HUD line otherwise. */
export function dungeonRewardSnapshot<Snapshot>(
  runtime: {
    snapshotForSession(playerId: string, sessionId: string): Snapshot;
    announceToPlayer(playerId: string, sessionId: string, text: string, tone: "info"): Snapshot;
  },
  playerId: string,
  sessionId: string,
  result: Pick<DungeonRewardGrantResult, "applied" | "items" | "gold">
): Snapshot {
  const text = dungeonRewardAnnouncement(result);
  return text === null
    ? runtime.snapshotForSession(playerId, sessionId)
    : runtime.announceToPlayer(playerId, sessionId, text, "info");
}

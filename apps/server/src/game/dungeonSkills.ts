import {
  ZEPHYR_ALTAR_TURN_IN,
  DEEPSTONE_RARE_FIND_POOL,
  HARVEST_RARE_FINDS,
  DUNGEON_SKILL_IDS,
  DUNGEON_SKILL_TURN_INS,
  GENERAL_SKILL_DEFINITIONS,
  GENERAL_SKILL_OFFERINGS,
  EDICT_STRIDE,
  WORLD_KNOWLEDGE_OVERWORLD_PARTS,
  offeringSummary,
  deepstoneRareFindChance,
  dungeonSkillName,
  harvestDoubleYieldChance,
  type DungeonSkillId,
  type DungeonSkillRanks,
  type DungeonTurnInId,
  type PlayerInventorySnapshot,
  type ResourceType,
  type SkillSystemV3Snapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";
import { SkillRequestError } from "./skills/skillAuthority.js";
import { OFFERING_ITEMS_REQUIRED, debitOfferingInTransaction } from "./skills/skillOfferings.js";
import type { SkillService } from "./skills/skillService.js";

export type DungeonSkillTurnInResult =
  | Readonly<{ status: "discovered"; skillId: DungeonTurnInId; message: string; inventory: PlayerInventorySnapshot; snapshot: SkillSystemV3Snapshot }>
  | Readonly<{ status: "already_discovered"; skillId: DungeonTurnInId; message: string }>
  | Readonly<{ status: "insufficient"; skillId: DungeonTurnInId; message: string; have: number; need: number }>;

/** What a harvest rolled for the player's dungeon skills when its session started. */
export type HarvestSkillRoll = Readonly<{ extraUnit: boolean; rareItemId: string | null }>;
export const NO_HARVEST_SKILL_ROLL: HarvestSkillRoll = Object.freeze({ extraUnit: false, rareItemId: null });

type SkillInventory = Pick<InventoryService, "debitItemsForOperationInTransaction" | "getInventorySnapshot" | "snapshotInTransaction">;
type DiscoveryAuthority = Pick<SkillService, "discoverWorldKnowledge" | "discoverGeneralSkill">;

const RANK_CACHE_MS = 5_000;
const NO_RANKS: DungeonSkillRanks = Object.freeze({});

/**
 * Dungeon tokens discover World Knowledge skills. The turn-in reveals the skill (the existing
 * `player_skill_world_unlocks` authority) in one transaction with the token debit; ranks are then
 * bought with General Skill Points through the normal skill flow. This service also caches the ranks
 * the synchronous effect hooks (harvest rolls, aura) need, refreshed at most every few seconds.
 */
export class DungeonSkillService {
  private readonly cache = new Map<string, { ranks: DungeonSkillRanks; loadedAt: number }>();
  private readonly loading = new Map<string, Promise<void>>();
  private ringYieldPoints: (playerId: string) => number = () => 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: SkillInventory,
    private readonly skills: DiscoveryAuthority,
    private readonly random: () => number = Math.random,
    private readonly now: () => number = Date.now
  ) {}

  /** Deepstone yield rings: extra double-yield points, read from the worn-ring stats. */
  setRingYieldSource(source: (playerId: string) => number): void {
    this.ringYieldPoints = source;
  }

  /** Loads the player's ranks if missing or older than a few seconds. */
  ensureLoaded(playerId: string): Promise<void> {
    const cached = this.cache.get(playerId);
    if (cached && this.now() - cached.loadedAt < RANK_CACHE_MS) return Promise.resolve();
    let pending = this.loading.get(playerId);
    if (!pending) {
      pending = this.pool.query<{ skill_id: string; rank: number }>(
        "SELECT skill_id, rank FROM player_skill_ranks WHERE player_id=$1 AND skill_id = ANY($2::text[])",
        [playerId, [...DUNGEON_SKILL_IDS]]
      ).then((result) => {
        this.cache.set(playerId, {
          ranks: Object.fromEntries(result.rows.map((row) => [row.skill_id, Number(row.rank)])),
          loadedAt: this.now()
        });
      }).finally(() => { this.loading.delete(playerId); });
      this.loading.set(playerId, pending);
    }
    return pending;
  }

  /** True once the player has discovered the World Knowledge skill (rank 0 or higher). */
  async hasDiscovered(playerId: string, skillId: DungeonSkillId): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM player_skill_world_unlocks WHERE player_id=$1 AND skill_id=$2",
      [playerId, skillId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Ranks already in the cache (possibly a few seconds old); empty until loaded. */
  ranksOf(playerId: string): DungeonSkillRanks {
    return this.cache.get(playerId)?.ranks ?? NO_RANKS;
  }

  rankOf(playerId: string, skillId: DungeonSkillId): number {
    return this.ranksOf(playerId)[skillId] ?? 0;
  }

  /** Rolls Deepstone / Grove double-yield and the Deepstone rare find for a harvest of `resourceType`. */
  async rollHarvestBonus(playerId: string, resourceType: string): Promise<HarvestSkillRoll> {
    await this.ensureLoaded(playerId);
    const ranks = this.ranksOf(playerId);
    // A Deepstone yield ring adds to the Deepstone Lore chance (only with the skill, on mined resources).
    const deepstoneApplies = harvestDoubleYieldChance({ deepstone_lore: ranks.deepstone_lore ?? 0 }, resourceType) > 0;
    const ringPoints = deepstoneApplies ? Math.max(0, this.ringYieldPoints(playerId)) : 0;
    const doubleChance = Math.min(1, harvestDoubleYieldChance(ranks, resourceType) + ringPoints / 100);
    const extraUnit = doubleChance > 0 && this.random() < doubleChance;
    const rareChance = deepstoneRareFindChance(ranks, resourceType);
    const rare = rareChance > 0 && this.random() < rareChance;
    const pool = DEEPSTONE_RARE_FIND_POOL;
    const deepstoneItem = rare && pool.length > 0
      ? pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))]!
      : null;
    const harvestFind = HARVEST_RARE_FINDS[resourceType];
    const ordinaryItem = harvestFind && this.random() < harvestFind.chance ? harvestFind.itemId : null;
    return { extraUnit, rareItemId: deepstoneItem ?? ordinaryItem };
  }

  /** Edict Stride rank, read fresh so a point spent a moment ago counts. */
  async edictStrideRank(playerId: string): Promise<number> {
    this.cache.delete(playerId);
    await this.ensureLoaded(playerId);
    return this.rankOf(playerId, "edict_stride");
  }

  /** Takes the Edict Seals one Edict Stride use costs (idempotent per request). Throws SkillRequestError when short. */
  async chargeEdictSeal(playerId: string, requestId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `edict-stride:${playerId}:${requestId}`,
        playerId,
        source: "edict_stride",
        sourceEntityType: "world_knowledge",
        sourceEntityId: "edict_stride",
        metadata: {},
        debits: [{ itemId: "edict_seal" as ResourceType, variant: null, quantity: EDICT_STRIDE.sealCost }]
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof Error && /enough items/iu.test(error.message)) {
        throw new SkillRequestError("EDICT_SEAL_REQUIRED", `Edict Stride costs ${EDICT_STRIDE.sealCost} Edict Seals.`);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async turnIn(playerId: string, skillId: DungeonTurnInId, requestId: string): Promise<DungeonSkillTurnInResult> {
    // The Zephyr Altar makes Perfect Strike's discovery offering (the same one the Skills panel takes).
    const zephyrAltar = skillId === ZEPHYR_ALTAR_TURN_IN.skillId;
    const turnIn = zephyrAltar ? ZEPHYR_ALTAR_TURN_IN : DUNGEON_SKILL_TURN_INS[skillId as DungeonSkillId];
    const name = zephyrAltar ? GENERAL_SKILL_DEFINITIONS.perfect_strike.displayName : dungeonSkillName(skillId as DungeonSkillId);
    // The dungeon token plus the overworld part (MOB-VALUE-AND-UNLOCKS 4.2), debited together.
    const parts = zephyrAltar
      ? GENERAL_SKILL_OFFERINGS.perfect_strike?.parts ?? []
      : [
        { kind: "item" as const, itemId: turnIn.tokenItemId, quantity: turnIn.tokenCost },
        ...(WORLD_KNOWLEDGE_OVERWORLD_PARTS[skillId as DungeonSkillId]?.parts ?? [])
      ];
    try {
      const result = zephyrAltar
        ? await this.skills.discoverGeneralSkill(playerId, ZEPHYR_ALTAR_TURN_IN.skillId, requestId, (client) =>
          debitOfferingInTransaction(this.inventory, client, {
            operationKey: `skill-offering:${playerId}:${ZEPHYR_ALTAR_TURN_IN.skillId}`,
            playerId,
            source: "skill_unlock_offering",
            sourceEntityType: "general_skill",
            sourceEntityId: ZEPHYR_ALTAR_TURN_IN.skillId,
            name,
            parts
          })
        )
        : await this.skills.discoverWorldKnowledge(playerId, skillId as DungeonSkillId, requestId, (client) =>
          debitOfferingInTransaction(this.inventory, client, {
            operationKey: `world-knowledge:${playerId}:${skillId}`,
            playerId,
            source: "world_knowledge_discovery",
            sourceEntityType: "world_knowledge",
            sourceEntityId: skillId,
            name,
            parts
          })
        );
      this.cache.delete(playerId);
      return {
        status: "discovered", skillId, snapshot: result.snapshot,
        inventory: await this.inventory.getInventorySnapshot(playerId),
        message: zephyrAltar
          ? `You offered ${offeringSummary(parts)} and discovered ${name}! Spend Skill Points to learn it.`
          : `You offered ${offeringSummary(parts)} and discovered ${name}! Spend Skill Points to rank it up.`
      };
    } catch (error) {
      if (error instanceof SkillRequestError && error.code === "SKILL_WORLD_ALREADY_REVEALED") {
        return { status: "already_discovered", skillId, message: `You have already discovered ${name}.` };
      }
      const missingParts = error instanceof SkillRequestError && error.code === OFFERING_ITEMS_REQUIRED;
      if (missingParts || (error instanceof Error && /enough items/iu.test(error.message))) {
        const snapshot = await this.inventory.getInventorySnapshot(playerId);
        const have = Number((snapshot.totals as Record<string, number | undefined>)[turnIn.tokenItemId] ?? 0);
        return {
          status: "insufficient", skillId, have, need: turnIn.tokenCost,
          message: missingParts ? error.message : `${name} needs ${offeringSummary(parts)}.`
        };
      }
      throw error;
    }
  }

}

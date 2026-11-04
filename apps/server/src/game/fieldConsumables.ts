import { createHash } from "node:crypto";

import {
  FIELD_BUFF_DURATION_MS,
  VIGOR_SERUM_DURATION_MS,
  FIELD_BUFF_FOR_ITEM,
  FIELD_CONSUMABLE_NAMES,
  FIELD_CONSUMABLE_RECIPES,
  FIELD_CONSUMABLE_SKILL_REQUIREMENTS,
  FIELD_CRAFT_TRADE_GATES,
  ALCHEMY_DURATION_MIN_RANK,
  ALCHEMY_DURATION_MULTIPLIER,
  LEATHERWORKING_NET_RETURN_CHANCE,
  LEATHERWORKING_NET_RETURN_MIN_RANK,
  WORLD_KNOWLEDGE_SKILL_DEFINITIONS,
  tidewaterDraughtDurationMs,
  type FieldBuffItemId,
  type FieldBuffSnapshot,
  type FieldConsumableItemId,
  type FieldPersistentBuffId,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import { DEFAULT_INVENTORY_VARIANT, type InventoryService } from "./inventory.js";
import { requireTradeSkillGate, tradeSkillRank } from "./skills/tradeSkillRank.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type BuffRow = {
  buff_id: FieldPersistentBuffId;
  started_at: Date | string;
  ends_at: Date | string;
};

export class FieldConsumableError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FieldConsumableError";
  }
}

export type ConsumeFieldConsumableResult = Readonly<{
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

export type ConsumeFieldBuffResult = ConsumeFieldConsumableResult & Readonly<{
  buffs: FieldBuffSnapshot[];
}>;

const NOT_ENOUGH_ITEMS = "Inventory does not contain enough items";

/** Whether the Spark Tonic is running; read-only, safe inside any reward transaction. */
export async function inspirationActive(queryable: Queryable, playerId: string): Promise<boolean> {
  const result = await queryable.query(
    `SELECT 1 FROM player_field_buffs
     WHERE player_id = $1 AND buff_id = 'inspiration' AND ends_at > now()`,
    [playerId]
  );
  return (result.rowCount ?? 0) > 0;
}

export class FieldConsumableService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: InventoryService,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * A timed buff: debit exactly one and start (or restart) its buff. Tonics last
   * one hour (the Vigor Serum 75 minutes); the Tidewater Draught lasts by the drinker's Tidecraft rank.
   */
  async consumeBuff(
    playerId: string,
    requestId: string,
    itemId: FieldBuffItemId,
    stackId?: string
  ): Promise<ConsumeFieldBuffResult> {
    const operationKey = operationKeyFor(playerId, requestId);
    const buffId = FIELD_BUFF_FOR_ITEM[itemId];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [playerId]);
      const debit = await this.debit(client, playerId, requestId, itemId, stackId);
      if (debit.applied) {
        const now = this.now();
        const baseDurationMs = itemId === "vigor_serum" ? VIGOR_SERUM_DURATION_MS : FIELD_BUFF_DURATION_MS;
        // Alchemy rank 2: the tonics last 40% longer.
        const durationMs = itemId === "tidewater_draught"
          ? tidewaterDraughtDurationMs(await skillRank(client, playerId, "tidecraft"))
          : (await tradeSkillRank(client, playerId, "alchemy")) >= ALCHEMY_DURATION_MIN_RANK
            ? baseDurationMs * ALCHEMY_DURATION_MULTIPLIER
            : baseDurationMs;
        await client.query(
          `INSERT INTO player_field_buffs (player_id, buff_id, operation_key, started_at, ends_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (player_id, buff_id) DO UPDATE SET
             operation_key = EXCLUDED.operation_key,
             started_at = EXCLUDED.started_at,
             ends_at = EXCLUDED.ends_at,
             updated_at = now()`,
          [playerId, buffId, operationKey, now, new Date(now.getTime() + durationMs)]
        );
      }
      const buffs = await this.activeBuffs(playerId, client);
      await client.query("COMMIT");
      return { inventory: debit.inventory, replayed: !debit.applied, buffs };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateShortage(error, itemId);
    } finally {
      client.release();
    }
  }

  /** Items whose effect lives in the combat engine: debit exactly one, replay-safe. */
  async consumeInstant(
    playerId: string,
    requestId: string,
    itemId: FieldConsumableItemId,
    stackId?: string
  ): Promise<ConsumeFieldConsumableResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [playerId]);
      const debit = await this.debit(client, playerId, requestId, itemId, stackId);
      await client.query("COMMIT");
      return { inventory: debit.inventory, replayed: !debit.applied };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateShortage(error, itemId);
    } finally {
      client.release();
    }
  }

  /**
   * Mason's Tome: halves the rest of the player's active building repair. The
   * channel is re-based so the health already earned stays the same and the
   * remaining time halves; one tome per repair. Debit and change commit together.
   */
  async applyMasonsTome(
    playerId: string,
    requestId: string,
    stackId?: string
  ): Promise<ConsumeFieldConsumableResult & Readonly<{ flagId: string | null }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [playerId]);
      const debit = await this.debit(client, playerId, requestId, "masons_tome", stackId);
      if (!debit.applied) {
        await client.query("COMMIT");
        return { inventory: debit.inventory, replayed: true, flagId: null };
      }
      const repair = await client.query<{ operation_id: string; flag_id: string; masons_tome_applied_at: Date | null }>(
        `SELECT operation_id, flag_id, masons_tome_applied_at
         FROM flag_repair_operations
         WHERE owner_player_id = $1 AND status = 'active' AND repair_mode = 'progressive'
         ORDER BY started_at DESC
         LIMIT 1
         FOR UPDATE`,
        [playerId]
      );
      const row = repair.rows[0];
      if (!row) throw new FieldConsumableError("MASONS_TOME_NO_REPAIR", "Start repairing a building first, then use the tome.");
      if (row.masons_tome_applied_at !== null) {
        throw new FieldConsumableError("MASONS_TOME_ALREADY_USED", "This repair already has a Mason's Tome.");
      }
      await client.query(
        `UPDATE flag_repair_operations
         SET full_repair_ms = GREATEST(1, full_repair_ms / 2),
             started_at = clock_timestamp() - (clock_timestamp() - started_at) / 2,
             completes_at = GREATEST(
               clock_timestamp() - (clock_timestamp() - started_at) / 2,
               clock_timestamp() + GREATEST(interval '0', completes_at - clock_timestamp()) / 2
             ),
             masons_tome_applied_at = clock_timestamp()
         WHERE operation_id = $1`,
        [row.operation_id]
      );
      await client.query("COMMIT");
      return { inventory: debit.inventory, replayed: false, flagId: row.flag_id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateShortage(error, "masons_tome");
    } finally {
      client.release();
    }
  }

  /** Active members of the player's kingdom (Tidecraft rank 3 ally filter). */
  async kingdomAllyIds(playerId: string): Promise<string[]> {
    const result = await this.pool.query<{ player_id: string }>(
      `SELECT member.player_id
       FROM kingdom_memberships own
       JOIN kingdom_memberships member ON member.kingdom_id = own.kingdom_id AND member.status = 'active'
       WHERE own.player_id = $1 AND own.status = 'active'`,
      [playerId]
    );
    return result.rows.map((row) => row.player_id);
  }

  /** Ends the Tidewater Draught (lost on death). */
  async clearTidewater(playerId: string): Promise<void> {
    await this.pool.query("DELETE FROM player_field_buffs WHERE player_id = $1 AND buff_id = 'tidewater'", [playerId]);
  }

  /** Ends Vigor Serum (lost on death). */
  async clearVigorSerum(playerId: string): Promise<void> {
    await this.pool.query("DELETE FROM player_field_buffs WHERE player_id = $1 AND buff_id = 'vigor_serum'", [playerId]);
  }

  /** Whether this request already debited an item (a replay of an applied use). */
  async operationApplied(playerId: string, requestId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM inventory_operations WHERE operation_key = $1 AND player_id = $2",
      [operationKeyFor(playerId, requestId), playerId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Leatherworking rank 3: a used Field Net comes back 70% of the time. The roll is derived from the
   * request, so a repeated request gets the same answer, and the give-back is idempotent. Null when
   * the net is not returned.
   */
  async returnNetOnUse(playerId: string, requestId: string): Promise<PlayerInventorySnapshot | null> {
    if ((await tradeSkillRank(this.pool, playerId, "leatherworking")) < LEATHERWORKING_NET_RETURN_MIN_RANK) return null;
    const unit = Number.parseInt(
      createHash("sha256").update(`field-net-return:${playerId}:${requestId}`).digest("hex").slice(0, 13),
      16
    ) / 0x10_0000_0000_0000;
    return unit < LEATHERWORKING_NET_RETURN_CHANCE ? this.refundInstant(playerId, requestId, "field_net") : null;
  }

  /** Gives the item back when its effect could not land after the debit committed. Idempotent. */
  async refundInstant(
    playerId: string,
    requestId: string,
    itemId: FieldConsumableItemId
  ): Promise<PlayerInventorySnapshot> {
    const result = await this.inventory.grantItemsForOperation({
      operationKey: `${operationKeyFor(playerId, requestId)}:refund`,
      playerId,
      source: "field_consumable_refund",
      sourceEntityType: "item_definition",
      sourceEntityId: itemId,
      allowPartial: true,
      grants: [{ itemId, variant: DEFAULT_INVENTORY_VARIANT, quantity: 1 }]
    });
    return result.inventory;
  }

  async activeBuffs(playerId: string, queryable: Queryable = this.pool): Promise<FieldBuffSnapshot[]> {
    const result = await queryable.query<BuffRow>(
      `SELECT buff_id, started_at, ends_at
       FROM player_field_buffs
       WHERE player_id = $1 AND ends_at > $2
       ORDER BY buff_id`,
      [playerId, this.now()]
    );
    return result.rows.map((row) => ({
      buffId: row.buff_id,
      startedAt: toMs(row.started_at),
      endsAt: toMs(row.ends_at)
    }));
  }

  /** One craft from the personal Crafting panel; materials and output commit together. */
  async craft(
    playerId: string,
    requestId: string,
    itemId: FieldConsumableItemId
  ): Promise<Readonly<{ inventory: PlayerInventorySnapshot; quantity: number; replayed: boolean }>> {
    const recipe = FIELD_CONSUMABLE_RECIPES[itemId];
    const requirement = FIELD_CONSUMABLE_SKILL_REQUIREMENTS[itemId];
    const operationKey = `field-craft:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (requirement && await skillRank(client, playerId, requirement.skillId) < requirement.rank) {
        const skillName = WORLD_KNOWLEDGE_SKILL_DEFINITIONS[requirement.skillId].displayName;
        throw new FieldConsumableError(
          "FIELD_CRAFT_SKILL_REQUIRED",
          `${FIELD_CONSUMABLE_NAMES[itemId]} needs ${skillName} rank ${requirement.rank}.`
        );
      }
      const tradeGate = FIELD_CRAFT_TRADE_GATES[itemId];
      if (tradeGate) {
        await requireTradeSkillGate(client, playerId, tradeGate, (message) => new FieldConsumableError("FIELD_CRAFT_SKILL_REQUIRED", message));
      }
      const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:materials`,
        playerId,
        source: "field_consumable_craft",
        sourceEntityType: "field_consumable_recipe",
        sourceEntityId: itemId,
        debits: recipe.inputs.map((input) => ({ ...input, variant: DEFAULT_INVENTORY_VARIANT }))
      });
      const granted = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:output`,
        playerId,
        source: "field_consumable_craft",
        sourceEntityType: "field_consumable_recipe",
        sourceEntityId: itemId,
        grants: [{ itemId, variant: DEFAULT_INVENTORY_VARIANT, quantity: recipe.output }]
      });
      await client.query("COMMIT");
      return {
        inventory: granted.inventory,
        quantity: recipe.output,
        replayed: !debited.applied && !granted.applied
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && error.message === NOT_ENOUGH_ITEMS) {
        throw new FieldConsumableError("FIELD_CRAFT_MATERIALS", "You are missing materials for that recipe.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private debit(
    client: pg.PoolClient,
    playerId: string,
    requestId: string,
    itemId: FieldConsumableItemId,
    stackId: string | undefined
  ) {
    return this.inventory.debitItemsForOperationInTransaction(client, {
      operationKey: operationKeyFor(playerId, requestId),
      playerId,
      source: "consumable-use",
      sourceEntityType: "item_definition",
      sourceEntityId: itemId,
      metadata: { requestId },
      ...(stackId ? { preferredStackId: stackId } : {}),
      debits: [{ itemId, variant: null, quantity: 1 }]
    });
  }
}

/** A World Knowledge rank read inside the caller's transaction (0 when not learned). */
export async function skillRank(queryable: Queryable, playerId: string, skillId: string): Promise<number> {
  const result = await queryable.query<{ rank: number }>(
    "SELECT rank FROM player_skill_ranks WHERE player_id = $1 AND skill_id = $2",
    [playerId, skillId]
  );
  return Number(result.rows[0]?.rank ?? 0);
}

function operationKeyFor(playerId: string, requestId: string): string {
  return `use-field-consumable:${playerId}:${requestId}`;
}

function translateShortage(error: unknown, itemId: FieldConsumableItemId): unknown {
  if (error instanceof Error && error.message === NOT_ENOUGH_ITEMS) {
    return new FieldConsumableError("FIELD_CONSUMABLE_NOT_OWNED", `You do not have any ${FIELD_CONSUMABLE_NAMES[itemId]}.`);
  }
  return error;
}

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

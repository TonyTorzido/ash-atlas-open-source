import { createHash } from "node:crypto";

import {
  HUNGER_BASE_CAPACITY,
  clampHungerForOrdinaryWrite,
  hungerSnapshot,
  type HungerSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";

type ConsumptionRow = {
  operation_key: string;
  player_id: string;
  request_id: string;
  request_hash: string;
  hunger_before: number;
  hunger_after: number;
  restored_quantity: number;
};

export class SimpleFoodError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SimpleFoodError";
  }
}

export type SimpleFoodConsumptionResult = Readonly<{
  hunger: HungerSnapshot;
  inventory: PlayerInventorySnapshot;
  restoredQuantity: number;
  replayed: boolean;
}>;

export type SimpleFoodHungerResult = Readonly<{
  hungerBefore: number;
  hungerAfter: number;
  restoredQuantity: number;
}>;

/** Calculate the ordinary +100 restoration without allowing an over-cap write. */
export function simpleFoodHungerResult(current: number): SimpleFoodHungerResult {
  const hungerBefore = clampHungerForOrdinaryWrite(current);
  const restoredQuantity = Math.min(
    SimpleFoodService.RESTORATION_QUANTITY,
    HUNGER_BASE_CAPACITY - hungerBefore
  );
  return {
    hungerBefore,
    hungerAfter: hungerBefore + restoredQuantity,
    restoredQuantity
  };
}

export class SimpleFoodService {
  static readonly RESTORATION_QUANTITY = 100;

  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: InventoryService
  ) {}

  async consume(
    playerId: string,
    requestId: string,
    stackId?: string
  ): Promise<SimpleFoodConsumptionResult> {
    if (!requestId || requestId.length > 128) {
      throw new SimpleFoodError("SIMPLE_FOOD_INVALID_REQUEST", "A valid request ID is required.");
    }
    const operationKey = `use-simple-food:${playerId}:${requestId}`;
    const hash = requestHash(stackId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
      const existing = await client.query<ConsumptionRow>(
        `SELECT operation_key,player_id,request_id,request_hash,hunger_before,hunger_after,restored_quantity
         FROM simple_food_consumption_operations WHERE operation_key=$1`,
        [operationKey]
      );
      const replay = existing.rows[0];
      if (replay) {
        if (replay.player_id !== playerId || replay.request_hash !== hash) {
          throw new SimpleFoodError("SIMPLE_FOOD_REPLAY_CONFLICT", "That request ID was already used for different food.");
        }
        const player = await playerHunger(client, playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return {
          hunger: hungerSnapshot(replay.hunger_after, player.baseCapacity),
          inventory,
          restoredQuantity: replay.restored_quantity,
          replayed: true
        };
      }
      const player = await playerHunger(client, playerId);
      const hungerResult = simpleFoodHungerResult(player.current);
      if (hungerResult.restoredQuantity <= 0) {
        throw new SimpleFoodError("SIMPLE_FOOD_FULL", "You're already full.");
      }
      const { hungerBefore: current, hungerAfter, restoredQuantity } = hungerResult;
      const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey,
        playerId,
        source: "consumable-use",
        sourceEntityType: "item_definition",
        sourceEntityId: "simple_food",
        metadata: { requestId, hungerBefore: current, hungerAfter, restoredQuantity },
        ...(stackId ? { preferredStackId: stackId } : {}),
        debits: [{ itemId: "simple_food", variant: null, quantity: 1 }]
      });
      if (!debit.applied) throw new Error("Simple Food debit replay had no durable effect");
      await client.query(
        `UPDATE players SET hunger=$2,hunger_base_capacity=$3,updated_at=clock_timestamp() WHERE id=$1`,
        [playerId, hungerAfter, player.baseCapacity]
      );
      await client.query(
        `INSERT INTO simple_food_consumption_operations
          (operation_key,player_id,request_id,request_hash,hunger_before,hunger_after,restored_quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [operationKey, playerId, requestId, hash, current, hungerAfter, restoredQuantity]
      );
      await client.query("COMMIT");
      return {
        hunger: hungerSnapshot(hungerAfter, player.baseCapacity),
        inventory: debit.inventory,
        restoredQuantity,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
        throw new SimpleFoodError("SIMPLE_FOOD_NOT_OWNED", "You do not have any Simple Food.");
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function playerHunger(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string
): Promise<{ current: number; baseCapacity: number }> {
  const result = await queryable.query<{ hunger: number | string | null; hunger_base_capacity: number | string | null }>(
    "SELECT hunger,hunger_base_capacity FROM players WHERE id=$1 FOR UPDATE",
    [playerId]
  );
  const row = result.rows[0];
  if (!row) throw new SimpleFoodError("SIMPLE_FOOD_PLAYER_UNAVAILABLE", "Your player record is unavailable.");
  return {
    current: Number(row.hunger ?? HUNGER_BASE_CAPACITY),
    baseCapacity: Number(row.hunger_base_capacity ?? HUNGER_BASE_CAPACITY)
  };
}

function requestHash(stackId?: string): string {
  return createHash("sha256").update(JSON.stringify(["simple_food", stackId ?? null])).digest("hex");
}

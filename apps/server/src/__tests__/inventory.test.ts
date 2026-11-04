import type pg from "pg";
import { getItemWeightGrams } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { InventoryService } from "../game/inventory.js";

const PLAYER_ID = "inventory-player";

describe("InventoryService", () => {
  it("grants into an empty inventory and writes an audit event", async () => {
    const database = createInventoryDatabase();
    const service = new InventoryService(database.pool);

    const result = await service.grantItemsForOperation(
      operation("grant:wood:1", "wood", 2)
    );

    expect(result.applied).toBe(true);
    expect(result.inventory.totals.wood).toBe(2);
    expect(database.events()).toEqual([
      expect.objectContaining({
        operationKey: "grant:wood:1",
        playerId: PLAYER_ID,
        itemId: "wood",
        deltaQuantity: 2,
        quantityAfter: 2
      })
    ]);
  });

  it("increments an existing stack for different operations", async () => {
    const database = createInventoryDatabase();
    const service = new InventoryService(database.pool);

    await service.grantItemsForOperation(operation("grant:stone:1", "stone", 2));
    const result = await service.grantItemsForOperation(
      operation("grant:stone:2", "stone", 3)
    );

    expect(result.inventory.totals.stone).toBe(5);
    expect(database.events().map((event) => event.quantityAfter)).toEqual([2, 5]);
  });

  it("returns the authoritative snapshot without duplicating a repeated operation", async () => {
    const database = createInventoryDatabase();
    const service = new InventoryService(database.pool);
    const input = operation("grant:food:repeat", "food", 4);

    const first = await service.grantItemsForOperation(input);
    const replay = await service.grantItemsForOperation(input);

    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(replay.inventory.totals.food).toBe(4);
    expect(database.events()).toHaveLength(1);
  });

  it("serializes concurrent retries of the same operation", async () => {
    const database = createInventoryDatabase();
    const service = new InventoryService(database.pool);
    const input = operation("grant:ore:concurrent", "ore", 2);

    const results = await Promise.all([
      service.grantItemsForOperation(input),
      service.grantItemsForOperation(input)
    ]);

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(results.every((result) => result.inventory.totals.ore === 2)).toBe(true);
    expect(database.events()).toHaveLength(1);
  });

  it("serializes different operations without losing increments", async () => {
    const database = createInventoryDatabase();
    const service = new InventoryService(database.pool);

    const results = await Promise.all([
      service.grantItemsForOperation(operation("grant:wood:a", "wood", 2)),
      service.grantItemsForOperation(operation("grant:wood:b", "wood", 3))
    ]);

    expect(results.at(-1)?.inventory.totals.wood).toBe(5);
    expect((await service.getInventorySnapshot(PLAYER_ID)).totals.wood).toBe(5);
    expect(database.events()).toHaveLength(2);
  });

  it("rejects unknown, zero, negative, and conflicting grants", async () => {
    const database = createInventoryDatabase();
    const service = new InventoryService(database.pool);

    await expect(
      service.grantItemsForOperation(operation("invalid:unknown", "unknown", 1))
    ).rejects.toThrow(/Unknown inventory item/);
    await expect(
      service.grantItemsForOperation(operation("invalid:zero", "wood", 0))
    ).rejects.toThrow(/positive integer/);
    await expect(
      service.grantItemsForOperation(operation("invalid:negative", "wood", -1))
    ).rejects.toThrow(/positive integer/);

    await service.grantItemsForOperation(operation("conflict:key", "wood", 1));
    await expect(
      service.grantItemsForOperation(operation("conflict:key", "wood", 2))
    ).rejects.toThrow(/different grants/);
    expect((await service.getInventorySnapshot(PLAYER_ID)).totals.wood).toBe(1);
  });

  it("rejects an aggregate item total across variants above the safe protocol range", async () => {
    const pool = {
      query: async (text: string) => {
        if (text.includes("lock_player_inventory_carry")) return {rows:[{maximum_weight_grams:"100000"}],rowCount:1};
        if (text.includes("player_inventory_weight_grams")) return {rows:[{current_weight:"2251799813685248000",maximum_weight:"100000",allowed_weight:"100000"}],rowCount:1};
        if (text.includes("player_inventory_capacities")) return {
          rows: [{ base_slots: 40, backpack_bonus_slots: 0, unlocked_slots: 40, inventory_revision: "0" }], rowCount: 1
        };
        if (!text.includes("SELECT inventory.player_id")) return { rows: [], rowCount: 0 };
        return {
        rows: [
          {
            player_id: PLAYER_ID,
            resource_type: "water",
            variant: "fresh",
            entry_id:"water-fresh",unit_weight_grams:250,quantity: "9007199254740991"
          },
          {
            player_id: PLAYER_ID,
            resource_type: "water",
            variant: "salt",
            entry_id:"water-salt",unit_weight_grams:250,quantity: "1"
          }
        ],
        rowCount: 2
        };
      }
    } as unknown as pg.Pool;

    await expect(new InventoryService(pool).snapshotInTransaction(pool, PLAYER_ID))
      .rejects.toThrow(/safe protocol range/);
  });
});

function operation(
  operationKey: string,
  itemId: string,
  quantity: number
) {
  return {
    operationKey,
    playerId: PLAYER_ID,
    source: "test-grant",
    sourceEntityType: "test",
    sourceEntityId: operationKey,
    grants: [
      {
        itemId: itemId as "wood",
        variant: null,
        quantity
      }
    ]
  };
}

type OperationRow = {
  operationKey: string;
  playerId: string;
  source: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
};

type EventRow = {
  operationKey: string;
  playerId: string;
  itemId: string;
  variant: string;
  deltaQuantity: number;
  quantityAfter: number;
};

type DatabaseState = {
  operations: Map<string, OperationRow>;
  stacks: Map<string, number>;
  events: EventRow[];
};

function createInventoryDatabase(): {
  pool: pg.Pool;
  events(): EventRow[];
} {
  let committed = emptyState();
  let transactionTail = Promise.resolve();

  const acquireTransaction = async (): Promise<() => void> => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = transactionTail;
    transactionTail = previous.then(() => gate);
    await previous;
    return release;
  };

  const pool = {
    query: async <T>(text: string, values?: readonly unknown[]) =>
      queryState<T>(committed, text, values),
    connect: async () => {
      let transaction: DatabaseState | null = null;
      let releaseTransaction: (() => void) | null = null;
      return {
        query: async <T>(text: string, values?: readonly unknown[]) => {
          if (text === "BEGIN") {
            releaseTransaction = await acquireTransaction();
            transaction = cloneState(committed);
            return emptyResult<T>();
          }
          if (text === "COMMIT") {
            if (!transaction || !releaseTransaction) {
              throw new Error("No inventory transaction to commit");
            }
            committed = cloneState(transaction);
            transaction = null;
            releaseTransaction();
            releaseTransaction = null;
            return emptyResult<T>();
          }
          if (text === "ROLLBACK") {
            transaction = null;
            releaseTransaction?.();
            releaseTransaction = null;
            return emptyResult<T>();
          }
          if (!transaction) {
            throw new Error("Inventory query must run in a transaction");
          }
          return queryState<T>(transaction, text, values);
        },
        release: () => undefined
      };
    }
  } as unknown as pg.Pool;

  return {
    pool,
    events: () => committed.events.map((event) => ({ ...event }))
  };
}

async function queryState<T>(
  state: DatabaseState,
  text: string,
  values: readonly unknown[] | undefined
): Promise<{ rows: T[]; rowCount: number }> {
  if (text.includes("lock_player_inventory_carry")) return result<T>({maximum_weight_grams:"100000"});
  if (text.includes("player_inventory_weight_grams")) {
    const current=[...state.stacks].reduce((total,[key,quantity])=>total+BigInt(quantity)*BigInt(getItemWeightGrams(key.split("\u0000")[1]!)),0n);
    return result<T>({current_weight:current.toString(),maximum_weight:"100000",allowed_weight:"100000"});
  }
  if (text.includes("player_inventory_capacities")) {
    return result<T>({ base_slots: 40, backpack_bonus_slots: 0, unlocked_slots: 40, inventory_revision: "0" });
  }
  if (text.includes("AS occupied_slots")) {
    return result<T>({ occupied_slots: String(state.stacks.size) });
  }
  if (text.includes("FROM player_backpack_instances")) return emptyResult<T>();
  if (text.includes("INSERT INTO inventory_operations")) {
    const operationKey = String(values?.[0]);
    if (state.operations.has(operationKey)) {
      return emptyResult<T>();
    }
    const row: OperationRow = {
      operationKey,
      playerId: String(values?.[1]),
      source: String(values?.[2]),
      sourceEntityType: nullableString(values?.[3]),
      sourceEntityId: nullableString(values?.[4])
    };
    state.operations.set(operationKey, row);
    return result<T>(operationDbRow(row));
  }
  if (text.includes("FROM inventory_operations")) {
    const operation = state.operations.get(String(values?.[0]));
    if (!operation || (values?.[1] !== undefined && operation.playerId !== values[1])) {
      return emptyResult<T>();
    }
    return result<T>(operationDbRow(operation));
  }
  if (text.includes("INSERT INTO player_inventory")) {
    const playerId = String(values?.[0]);
    const itemId = String(values?.[1]);
    const variant = String(values?.[2]);
    const quantity = Number(values?.[3]);
    const key = stackKey(playerId, itemId, variant);
    const nextQuantity = (state.stacks.get(key) ?? 0) + quantity;
    if (nextQuantity < 0) {
      return emptyResult<T>();
    }
    state.stacks.set(key, nextQuantity);
    return result<T>({
      player_id: playerId,
      resource_type: itemId,
      variant,
      quantity: nextQuantity
    });
  }
  if (text.includes("INSERT INTO inventory_events")) {
    state.events.push({
      operationKey: String(values?.[0]),
      playerId: String(values?.[1]),
      itemId: String(values?.[2]),
      variant: String(values?.[3]),
      deltaQuantity: Number(values?.[4]),
      quantityAfter: Number(values?.[5])
    });
    return emptyResult<T>();
  }
  if (text.includes("FROM inventory_events")) {
    const rows = state.events
      .filter((event) => event.operationKey === values?.[0])
      .map((event) => ({
        item_id: event.itemId,
        variant: event.variant,
        delta_quantity: event.deltaQuantity
      }));
    return { rows: rows as T[], rowCount: rows.length };
  }
  if (text.includes("FROM player_inventory")) {
    const playerId = String(values?.[0]);
    const rows = [...state.stacks.entries()]
      .filter(([key]) => key.startsWith(`${playerId}\u0000`))
      .map(([key, quantity], slotIndex) => {
        const [, itemId, variant] = key.split("\u0000");
        return {
          entry_id: `entry-${slotIndex}`, unit_weight_grams: getItemWeightGrams(itemId!),
          player_id: playerId,
          resource_type: itemId,
          variant,
          quantity
        };
      })
      .sort(
        (left, right) =>
          String(left.resource_type).localeCompare(String(right.resource_type)) ||
          String(left.variant).localeCompare(String(right.variant))
      );
    return { rows: rows as T[], rowCount: rows.length };
  }
  throw new Error(`Unhandled inventory test query: ${text}`);
}

function operationDbRow(row: OperationRow) {
  return {
    operation_key: row.operationKey,
    player_id: row.playerId,
    source: row.source,
    source_entity_type: row.sourceEntityType,
    source_entity_id: row.sourceEntityId
  };
}

function result<T>(row: unknown): { rows: T[]; rowCount: number } {
  return { rows: [row as T], rowCount: 1 };
}

function emptyResult<T>(): { rows: T[]; rowCount: number } {
  return { rows: [], rowCount: 0 };
}

function emptyState(): DatabaseState {
  return {
    operations: new Map(),
    stacks: new Map(),
    events: []
  };
}

function cloneState(state: DatabaseState): DatabaseState {
  return {
    operations: new Map(
      [...state.operations].map(([key, value]) => [key, { ...value }])
    ),
    stacks: new Map(state.stacks),
    events: state.events.map((event) => ({ ...event }))
  };
}

function stackKey(playerId: string, itemId: string, variant: string): string {
  return `${playerId}\u0000${itemId}\u0000${variant}`;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}


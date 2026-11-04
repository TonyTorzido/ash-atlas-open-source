import {
  CITY_WAREHOUSE_INTERACTION_RADIUS_M,
  CITY_WAREHOUSE_CAPACITY_GRAMS,
  CITY_WAREHOUSE_SLOTS_BY_TIER,
  requireInventoryCatalogItem,
  type CityWarehouseSnapshot,
  type PlayerInventorySnapshot,
  type ResourceType
} from "@ash-atlas/shared";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";
import { requireItemDefinition, requireRuntimeItemDefinition } from "./items.js";
import { planAutomaticStackConsolidation } from "./stackConsolidation.js";
import { CityGoldService } from "./cityGold.js";
import {
  lockInventoryProtection,
  materialProtectionAllocation
} from "./inventoryProtection.js";

type Position = { lat: number; lon: number };
type WarehouseAccess = {
  city_id: string;
  city_name: string;
  structure_id: string;
  tier: 1 | 2 | 3;
  mayor_player_id: string | null;
  mayor_confirmed: boolean;
};

export class CityWarehouseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CityWarehouseError";
  }
}

export type CityWarehouseMutationResult = {
  warehouse: CityWarehouseSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
  donatedQuantity: number;
};

export class CityWarehouseService {
  private readonly gold: CityGoldService;

  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: Pick<
      InventoryService,
      "debitItemsForOperationInTransaction" | "snapshotInTransaction"
    >
  ) {
    this.gold = new CityGoldService(pool);
  }

  async open(
    playerId: string,
    structureId: string,
    position: Position
  ): Promise<CityWarehouseSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const access = await requireWarehouseAccess(client, playerId, structureId, position, false);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `city-warehouse:${access.city_id}`
      ]);
      await normalizeWarehouseStacks(client, access);
      const snapshot = await warehouseSnapshot(client, access, playerId, this.gold);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async donate(
    playerId: string,
    structureId: string,
    position: Position,
    requestId: string,
    stackId: string,
    quantity: number
  ): Promise<CityWarehouseMutationResult> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new CityWarehouseError(
        "CITY_WAREHOUSE_QUANTITY_INVALID",
        "Donation quantity must be a positive whole number"
      );
    }
    return this.runDonation(
      playerId,
      structureId,
      position,
      requestId,
      "donate",
      { stackId, quantity },
      async (client, access, operationKey) => {
        await lockInventoryProtection(client, playerId);
        const protectedInventory = await materialProtectionAllocation(client, playerId);
        const allocation = protectedInventory.byStackId.get(stackId);
        if (!allocation) {
          throw new CityWarehouseError(
            "CITY_WAREHOUSE_STACK_NOT_FOUND",
            "That inventory stack is no longer available"
          );
        }
        if (quantity > allocation.movableQuantity) {
          throw new CityWarehouseError(
            "CITY_WAREHOUSE_PROTECTED_QUANTITY",
            allocation.reason ?? "That quantity is protected"
          );
        }
        const source = await client.query<{
          resource_type: ResourceType;
          variant: string;
          quantity: string;
        }>(
          `SELECT resource_type,variant,quantity::text
           FROM player_inventory
           WHERE player_id=$1 AND entry_id=$2::uuid
           FOR UPDATE`,
          [playerId, stackId]
        );
        const row = source.rows[0];
        if (!row || BigInt(row.quantity) < BigInt(quantity)) {
          throw new CityWarehouseError(
            "CITY_WAREHOUSE_STACK_CHANGED",
            "That inventory stack changed before donation"
          );
        }
        assertDonatableResource(row.resource_type);
        await addWarehouseItems(
          client,
          access,
          row.resource_type,
          row.variant,
          BigInt(quantity)
        );
        const inventory = await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:inventory`,
          playerId,
          source: "city_warehouse_donation",
          sourceEntityType: "city_warehouse",
          sourceEntityId: access.structure_id,
          preferredStackId: stackId,
          metadata: { cityId: access.city_id, warehouseStructureId: access.structure_id },
          debits: [{ itemId: row.resource_type, variant: row.variant, quantity: BigInt(quantity) }]
        });
        await writeWarehouseEvent(client, {
          operationKey,
          cityId: access.city_id,
          playerId,
          eventType: "donated",
          itemId: row.resource_type,
          variant: row.variant,
          quantity
        });
        return { inventory: inventory.inventory, donatedQuantity: quantity };
      }
    );
  }

  async donateAllEligible(
    playerId: string,
    structureId: string,
    position: Position,
    requestId: string
  ): Promise<CityWarehouseMutationResult> {
    return this.runDonation(
      playerId,
      structureId,
      position,
      requestId,
      "donate_all",
      {},
      async (client, access, operationKey) => {
        await lockInventoryProtection(client, playerId);
        const protectedInventory = await materialProtectionAllocation(client, playerId);
        const eligible = protectedInventory.allocations.flatMap((allocation) => {
          if (allocation.movableQuantity <= 0) return [];
          const definition = requireInventoryCatalogItem(allocation.itemId);
          return definition.kind === "resource"
            ? [{ ...allocation, itemId: allocation.itemId as ResourceType }]
            : [];
        });
        if (eligible.length === 0) {
          return {
            inventory: await this.inventory.snapshotInTransaction(client, playerId),
            donatedQuantity: 0
          };
        }
        let donatedQuantity = 0;
        for (const allocation of eligible) {
          const variant = allocation.variant ?? "default";
          await addWarehouseItems(
            client,
            access,
            allocation.itemId,
            variant,
            BigInt(allocation.movableQuantity)
          );
          donatedQuantity += allocation.movableQuantity;
          await writeWarehouseEvent(client, {
            operationKey,
            cityId: access.city_id,
            playerId,
            eventType: "donated",
            itemId: allocation.itemId,
            variant,
            quantity: allocation.movableQuantity
          });
        }
        const inventory = await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:inventory`,
          playerId,
          source: "city_warehouse_bulk_donation",
          sourceEntityType: "city_warehouse",
          sourceEntityId: access.structure_id,
          metadata: { cityId: access.city_id, warehouseStructureId: access.structure_id },
          debits: eligible.map((allocation) => ({
            itemId: allocation.itemId,
            variant: allocation.variant ?? "default",
            quantity: BigInt(allocation.movableQuantity)
          }))
        });
        return { inventory: inventory.inventory, donatedQuantity };
      }
    );
  }

  async move(
    playerId: string,
    structureId: string,
    position: Position,
    requestId: string,
    stackId: string,
    targetSlot: number
  ): Promise<CityWarehouseMutationResult> {
    if (!Number.isSafeInteger(targetSlot) || targetSlot < 0) {
      throw new CityWarehouseError("CITY_WAREHOUSE_TARGET_INVALID", "That Warehouse slot is invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const access = await requireWarehouseAccess(client, playerId, structureId, position, true);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `city-warehouse:${access.city_id}`
      ]);
      const operationKey = `city-warehouse:${playerId}:${requestId}`;
      const replay = await reserveOperation(client, {
        operationKey,
        playerId,
        requestId,
        cityId: access.city_id,
        action: "move",
        intent: { structureId, stackId, targetSlot }
      });
      if (!replay) {
        await normalizeWarehouseStacks(client, access);
        const source = await client.query<{ slot_index: number }>(
          `SELECT slot_index FROM city_warehouse_stacks
           WHERE city_id=$1 AND stack_id=$2::uuid FOR UPDATE`,
          [access.city_id, stackId]
        );
        if (!source.rows[0]) {
          throw new CityWarehouseError("CITY_WAREHOUSE_STACK_NOT_FOUND", "That Warehouse stack is unavailable");
        }
        const target = await client.query<{ stack_id: string }>(
          `SELECT stack_id::text FROM city_warehouse_stacks
           WHERE city_id=$1 AND slot_index=$2 FOR UPDATE`,
          [access.city_id, targetSlot]
        );
        if (target.rows[0]) {
          await client.query(
            `UPDATE city_warehouse_stacks
             SET slot_index=CASE WHEN stack_id=$2::uuid THEN $3 ELSE $4 END,
                 version=version+1,updated_at=now()
             WHERE city_id=$1 AND stack_id IN ($2::uuid,$5::uuid)`,
            [access.city_id, stackId, targetSlot, source.rows[0].slot_index, target.rows[0].stack_id]
          );
        } else {
          await client.query(
            `UPDATE city_warehouse_stacks
             SET slot_index=$3,version=version+1,updated_at=now()
             WHERE city_id=$1 AND stack_id=$2::uuid`,
            [access.city_id, stackId, targetSlot]
          );
        }
        await writeWarehouseEvent(client, {
          operationKey,
          cityId: access.city_id,
          playerId,
          eventType: "moved"
        });
      }
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      const warehouse = await warehouseSnapshot(client, access, playerId, this.gold);
      await completeOperation(client, operationKey, { warehouse, donatedQuantity: 0 });
      await client.query("COMMIT");
      return { warehouse, inventory, replayed: replay, donatedQuantity: 0 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reorganize(
    playerId: string,
    structureId: string,
    position: Position,
    requestId: string
  ): Promise<CityWarehouseMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const access = await requireWarehouseAccess(client, playerId, structureId, position, true);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `city-warehouse:${access.city_id}`
      ]);
      const operationKey = `city-warehouse:${playerId}:${requestId}`;
      const replay = await reserveOperation(client, {
        operationKey,
        playerId,
        requestId,
        cityId: access.city_id,
        action: "reorganize",
        intent: { structureId }
      });
      if (!replay) {
        await normalizeWarehouseStacks(client, access);
        await consolidateWarehouseStacks(client, access.city_id);
        await client.query(
          `WITH ordered AS (
             SELECT stack_id, row_number() OVER (ORDER BY slot_index, stack_id) - 1 AS target_slot
             FROM city_warehouse_stacks
             WHERE city_id=$1
           )
           UPDATE city_warehouse_stacks stack
           SET slot_index=ordered.target_slot,
               version=stack.version+1,
               updated_at=now()
           FROM ordered
           WHERE stack.stack_id=ordered.stack_id
             AND stack.slot_index<>ordered.target_slot`,
          [access.city_id]
        );
        await writeWarehouseEvent(client, {
          operationKey,
          cityId: access.city_id,
          playerId,
          eventType: "moved"
        });
      }
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      const warehouse = await warehouseSnapshot(client, access, playerId, this.gold);
      await completeOperation(client, operationKey, { warehouse, donatedQuantity: 0 });
      await client.query("COMMIT");
      return { warehouse, inventory, replayed: replay, donatedQuantity: 0 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeInTransaction(
    client: pg.PoolClient,
    input: {
      operationKey: string;
      playerId: string;
      cityId: string;
      materials: readonly { itemId: ResourceType; quantity: number }[];
    }
  ): Promise<void> {
    const replayed = await reserveOperation(client, {
      operationKey: input.operationKey,
      playerId: input.playerId,
      requestId: input.operationKey,
      cityId: input.cityId,
      action: "consume",
      intent: {
        materials: input.materials.map((material) => ({
          itemId: material.itemId,
          quantity: material.quantity
        }))
      }
    });
    if (replayed) return;
    for (const material of input.materials) {
      let remaining = BigInt(material.quantity);
      const stacks = await client.query<{
        stack_id: string;
        quantity: string;
        variant: string;
      }>(
        `SELECT stack_id::text,quantity::text,variant
         FROM city_warehouse_stacks
         WHERE city_id=$1 AND item_id=$2
         ORDER BY slot_index FOR UPDATE`,
        [input.cityId, material.itemId]
      );
      if (stacks.rows.reduce((total, row) => total + BigInt(row.quantity), 0n) < remaining) {
        throw new CityWarehouseError(
          "CITY_WAREHOUSE_MATERIALS_INSUFFICIENT",
          `The City Warehouse needs ${material.quantity} ${requireInventoryCatalogItem(material.itemId).displayName}`
        );
      }
      for (const stack of stacks.rows) {
        const moved = remaining < BigInt(stack.quantity) ? remaining : BigInt(stack.quantity);
        if (moved === BigInt(stack.quantity)) {
          await client.query(
            "DELETE FROM city_warehouse_stacks WHERE stack_id=$1::uuid",
            [stack.stack_id]
          );
        } else {
          await client.query(
            `UPDATE city_warehouse_stacks
             SET quantity=quantity-$2::bigint,version=version+1,updated_at=now()
             WHERE stack_id=$1::uuid`,
            [stack.stack_id, moved.toString()]
          );
        }
        remaining -= moved;
        if (remaining === 0n) break;
      }
      await writeWarehouseEvent(client, {
        operationKey: input.operationKey,
        cityId: input.cityId,
        playerId: input.playerId,
        eventType: "consumed",
        itemId: material.itemId,
        variant: "default",
        quantity: material.quantity
      });
    }
    await completeOperation(client, input.operationKey, {
      consumed: input.materials
    });
  }

  async grantDestructionRefundInTransaction(
    client: pg.PoolClient,
    input: {
      cityId: string;
      materials: readonly {
        itemId: ResourceType;
        variant: string;
        quantity: number;
      }[];
    }
  ): Promise<Array<{
    itemId: ResourceType;
    variant: string;
    requestedQuantity: number;
    grantedQuantity: number;
    remainderQuantity: number;
  }>> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `city-warehouse:${input.cityId}`
    ]);
    const warehouse = await client.query<WarehouseAccess>(
      `SELECT structure.city_id,city.name AS city_name,structure.structure_id::text,
              structure.tier,city.mayor_player_id,
              (city.mayor_confirmed_at IS NOT NULL) AS mayor_confirmed
       FROM city_structures structure
       JOIN cities city ON city.id=structure.city_id AND city.active
       WHERE structure.city_id=$1
         AND structure.structure_type='warehouse'
         AND structure.state='active'
       FOR UPDATE OF structure,city`,
      [input.cityId]
    );
    const access = warehouse.rows[0];
    if (!access) {
      return input.materials.map((material) => ({
        ...material,
        requestedQuantity: material.quantity,
        grantedQuantity: 0,
        remainderQuantity: material.quantity
      }));
    }
    await normalizeWarehouseStacks(client, access);
    const results = [];
    for (const material of input.materials) {
      const grantedQuantity = await addWarehouseItemsWithinCapacity(
        client,
        access,
        material.itemId,
        material.variant,
        BigInt(material.quantity)
      );
      results.push({
        itemId: material.itemId,
        variant: material.variant,
        requestedQuantity: material.quantity,
        grantedQuantity: Number(grantedQuantity),
        remainderQuantity: material.quantity - Number(grantedQuantity)
      });
    }
    return results;
  }

  private async runDonation(
    playerId: string,
    structureId: string,
    position: Position,
    requestId: string,
    action: "donate" | "donate_all",
    intent: Record<string, unknown>,
    apply: (
      client: pg.PoolClient,
      access: WarehouseAccess,
      operationKey: string
    ) => Promise<{ inventory: PlayerInventorySnapshot; donatedQuantity: number }>
  ): Promise<CityWarehouseMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const access = await requireWarehouseAccess(client, playerId, structureId, position, false);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `city-warehouse:${access.city_id}`
      ]);
      const operationKey = `city-warehouse:${playerId}:${requestId}`;
      const replay = await reserveOperation(client, {
        operationKey,
        playerId,
        requestId,
        cityId: access.city_id,
        action,
        intent: { structureId, ...intent }
      });
      if (replay) {
        const stored = await client.query<{ result: CityWarehouseMutationResult }>(
          "SELECT result FROM city_warehouse_operations WHERE operation_key=$1",
          [operationKey]
        );
        if (!stored.rows[0]?.result) {
          throw new CityWarehouseError(
            "CITY_WAREHOUSE_OPERATION_INCOMPLETE",
            "The prior Warehouse operation did not complete"
          );
        }
        await client.query("COMMIT");
        return { ...stored.rows[0].result, replayed: true };
      }
      await normalizeWarehouseStacks(client, access);
      const mutation = await apply(client, access, operationKey);
      const warehouse = await warehouseSnapshot(client, access, playerId, this.gold);
      const result = { warehouse, ...mutation, replayed: false };
      await completeOperation(client, operationKey, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function requireWarehouseAccess(
  client: pg.PoolClient,
  playerId: string,
  structureId: string,
  position: Position,
  requireMayor: boolean
): Promise<WarehouseAccess> {
  const result = await client.query<WarehouseAccess>(
    `SELECT structure.city_id,city.name AS city_name,structure.structure_id::text,
            structure.tier,city.mayor_player_id,
            (city.mayor_confirmed_at IS NOT NULL) AS mayor_confirmed
     FROM city_structures structure
     JOIN cities city ON city.id=structure.city_id AND city.active
     JOIN city_memberships membership
       ON membership.city_id=structure.city_id
      AND membership.player_id=$2
      AND membership.left_at IS NULL
      AND membership.house_structure_id IS NOT NULL
     JOIN city_structures house
       ON house.structure_id=membership.house_structure_id
      AND house.state='active'
      AND house.structure_type IN ('city_house','mayor_house')
     WHERE structure.structure_id=$1::uuid
       AND structure.structure_type='warehouse'
       AND structure.state='active'
       AND ST_DWithin(
         structure.geom::geography,
         ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
         $5
       )
     FOR SHARE OF structure,city,membership,house`,
    [
      structureId,
      playerId,
      position.lon,
      position.lat,
      CITY_WAREHOUSE_INTERACTION_RADIUS_M
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new CityWarehouseError(
      "CITY_WAREHOUSE_ACCESS_DENIED",
      "You must be an active city member standing near this City Warehouse"
    );
  }
  if (requireMayor && (row.mayor_player_id !== playerId || !row.mayor_confirmed)) {
    throw new CityWarehouseError(
      "CITY_MAYOR_PERMISSION_DENIED",
      "Only the confirmed Mayor may reorganize the City Warehouse"
    );
  }
  return row;
}

async function warehouseSnapshot(
  queryable: Pick<pg.PoolClient, "query">,
  access: WarehouseAccess,
  playerId: string,
  goldService: CityGoldService
): Promise<CityWarehouseSnapshot> {
  const stacks = await queryable.query<{
    stack_id: string;
    slot_index: number;
    item_id: ResourceType;
    variant: string;
    quantity: string;
    version: string;
  }>(
    `SELECT stack_id::text,slot_index,item_id,variant,quantity::text,version::text
     FROM city_warehouse_stacks WHERE city_id=$1 ORDER BY slot_index`,
    [access.city_id]
  );
  const revision = stacks.rows.reduce((total, row) => total + BigInt(row.version), 0n);
  const gold = await goldService.snapshotInTransaction(
    queryable,
    access.city_id,
    playerId
  );
  return {
    cityId: access.city_id,
    structureId: access.structure_id,
    cityName: access.city_name,
    tier: access.tier,
    currentWeightGrams: (await warehouseWeightGrams(queryable, access.city_id)).toString(),
    maximumWeightGrams: CITY_WAREHOUSE_CAPACITY_GRAMS.toString(),
    usedSlots: stacks.rows.length,
    totalSlots: CITY_WAREHOUSE_SLOTS_BY_TIER[access.tier],
    revision: revision.toString(),
    canReorganize: access.mayor_player_id === playerId && access.mayor_confirmed,
    stacks: stacks.rows.map((row) => ({
      stackId: row.stack_id,
      slotIndex: row.slot_index,
      itemId: row.item_id,
      variant: row.variant === "default" ? null : row.variant,
      quantity: Number(row.quantity),
      maxStack: requireItemDefinition(row.item_id).maxStack ?? Number.MAX_SAFE_INTEGER,
      version: row.version
    })),
    gold
  };
}

async function normalizeWarehouseStacks(
  client: pg.PoolClient,
  access: WarehouseAccess
): Promise<void> {
  const stacks = await client.query<{
    stack_id: string;
    item_id: ResourceType;
    variant: string;
    quantity: string;
  }>(
    `SELECT stack_id::text,item_id,variant,quantity::text
     FROM city_warehouse_stacks
     WHERE city_id=$1 AND quantity > 0
     ORDER BY slot_index
     FOR UPDATE`,
    [access.city_id]
  );
  for (const stack of stacks.rows) {
    const maximum = BigInt(
      requireItemDefinition(stack.item_id).maxStack ?? Number.MAX_SAFE_INTEGER
    );
    let quantity = BigInt(stack.quantity);
    if (quantity <= maximum) continue;
    while (quantity > maximum) {
      const free = await nextWarehousePosition(client, access.city_id);
      const moved = quantity - maximum < maximum ? quantity - maximum : maximum;
      await client.query(
        `INSERT INTO city_warehouse_stacks
           (city_id,slot_index,item_id,variant,quantity)
         VALUES ($1,$2,$3,$4,$5::bigint)`,
        [access.city_id, free, stack.item_id, stack.variant, moved.toString()]
      );
      quantity -= moved;
    }
    if (quantity !== BigInt(stack.quantity)) {
      await client.query(
        `UPDATE city_warehouse_stacks
         SET quantity=$3::bigint,version=version+1,updated_at=now()
         WHERE city_id=$1 AND stack_id=$2::uuid`,
        [access.city_id, stack.stack_id, quantity.toString()]
      );
    }
  }
}

async function consolidateWarehouseStacks(
  client: pg.PoolClient,
  cityId: string
): Promise<void> {
  const stacks = await client.query<{
    stack_id: string;
    slot_index: number;
    item_id: ResourceType;
    variant: string;
    quantity: string;
  }>(
    `SELECT stack_id::text,slot_index,item_id,variant,quantity::text
     FROM city_warehouse_stacks
     WHERE city_id=$1 AND quantity > 0
     ORDER BY slot_index
     FOR UPDATE`,
    [cityId]
  );
  const plan = planAutomaticStackConsolidation(stacks.rows.map((stack) => ({
    stackId: stack.stack_id,
    slotIndex: stack.slot_index,
    itemId: stack.item_id,
    variant: stack.variant,
    quantity: stack.quantity,
    manualSplit: false
  })));
  for (const update of plan.updates) {
    await client.query(
      `UPDATE city_warehouse_stacks
       SET quantity=$3::bigint,version=version+1,updated_at=now()
       WHERE city_id=$1 AND stack_id=$2::uuid`,
      [cityId, update.stackId, update.quantity.toString()]
    );
  }
  for (const stackId of plan.deletions) {
    await client.query(
      "DELETE FROM city_warehouse_stacks WHERE city_id=$1 AND stack_id=$2::uuid",
      [cityId, stackId]
    );
  }
}

async function addWarehouseItems(
  client: pg.PoolClient,
  access: WarehouseAccess,
  itemId: ResourceType,
  variant: string,
  quantity: bigint
): Promise<void> {
  const definition = assertDonatableResource(itemId);
  const unitWeight = BigInt(requireRuntimeItemDefinition(itemId).unitWeightGrams);
  const availableQuantity = (await warehouseWeightRemaining(client, access.city_id)) / unitWeight;
  if (availableQuantity < quantity) {
    throw new CityWarehouseError("CITY_WAREHOUSE_FULL", "The City Warehouse is full");
  }
  let remaining = quantity;
  const maximum = BigInt(definition.maxStack ?? Number.MAX_SAFE_INTEGER);
  const partial = await client.query<{ stack_id: string; quantity: string }>(
    `SELECT stack_id::text,quantity::text
     FROM city_warehouse_stacks
     WHERE city_id=$1 AND item_id=$2 AND variant=$3 AND quantity<$4::bigint
     ORDER BY slot_index FOR UPDATE`,
    [access.city_id, itemId, variant, maximum.toString()]
  );
  for (const stack of partial.rows) {
    const moved = remaining < maximum - BigInt(stack.quantity)
      ? remaining
      : maximum - BigInt(stack.quantity);
    await client.query(
      `UPDATE city_warehouse_stacks
       SET quantity=quantity+$2::bigint,version=version+1,updated_at=now()
       WHERE stack_id=$1::uuid`,
      [stack.stack_id, moved.toString()]
    );
    remaining -= moved;
    if (remaining === 0n) return;
  }
  while (remaining > 0n) {
    const free = await nextWarehousePosition(client, access.city_id);
    const moved = remaining < maximum ? remaining : maximum;
    await client.query(
      `INSERT INTO city_warehouse_stacks
         (city_id,slot_index,item_id,variant,quantity)
       VALUES ($1,$2,$3,$4,$5::bigint)`,
      [access.city_id, free, itemId, variant, moved.toString()]
    );
    remaining -= moved;
  }
}

async function addWarehouseItemsWithinCapacity(
  client: pg.PoolClient,
  access: WarehouseAccess,
  itemId: ResourceType,
  variant: string,
  quantity: bigint
): Promise<bigint> {
  const definition = assertDonatableResource(itemId);
  const unitWeight = BigInt(requireRuntimeItemDefinition(itemId).unitWeightGrams);
  const availableQuantity = (await warehouseWeightRemaining(client, access.city_id)) / unitWeight;
  const grantable = quantity < availableQuantity
    ? quantity
    : availableQuantity;
  if (grantable === 0n) return 0n;
  let remaining = grantable;
  const maximum = BigInt(definition.maxStack ?? Number.MAX_SAFE_INTEGER);
  const partial = await client.query<{ stack_id: string; quantity: string }>(
    `SELECT stack_id::text,quantity::text
     FROM city_warehouse_stacks
     WHERE city_id=$1 AND item_id=$2 AND variant=$3 AND quantity<$4::bigint
     ORDER BY slot_index FOR UPDATE`,
    [access.city_id, itemId, variant, maximum.toString()]
  );
  for (const stack of partial.rows) {
    const moved = remaining < maximum - BigInt(stack.quantity)
      ? remaining
      : maximum - BigInt(stack.quantity);
    await client.query(
      `UPDATE city_warehouse_stacks
       SET quantity=quantity+$2::bigint,version=version+1,updated_at=now()
       WHERE stack_id=$1::uuid`,
      [stack.stack_id, moved.toString()]
    );
    remaining -= moved;
    if (remaining === 0n) return grantable;
  }
  while (remaining > 0n) {
    const free = await nextWarehousePosition(client, access.city_id);
    const moved = remaining < maximum ? remaining : maximum;
    await client.query(
      `INSERT INTO city_warehouse_stacks
         (city_id,slot_index,item_id,variant,quantity)
       VALUES ($1,$2,$3,$4,$5::bigint)`,
      [access.city_id, free, itemId, variant, moved.toString()]
    );
    remaining -= moved;
  }
  return quantity - remaining;
}

async function nextWarehousePosition(
  client: pg.PoolClient,
  cityId: string
): Promise<number> {
  const result = await client.query<{ slot_index: number }>(
    `SELECT (COALESCE(MAX(slot_index), -1) + 1)::integer AS slot_index
     FROM city_warehouse_stacks WHERE city_id=$1`,
    [cityId]
  );
  return result.rows[0]?.slot_index ?? 0;
}

async function warehouseWeightRemaining(
  queryable: Pick<pg.PoolClient, "query">,
  cityId: string
): Promise<bigint> {
  const current = await warehouseWeightGrams(queryable, cityId);
  return current >= BigInt(CITY_WAREHOUSE_CAPACITY_GRAMS)
    ? 0n
    : BigInt(CITY_WAREHOUSE_CAPACITY_GRAMS) - current;
}

async function warehouseWeightGrams(
  queryable: Pick<pg.PoolClient, "query">,
  cityId: string
): Promise<bigint> {
  const result = await queryable.query<{ weight: string }>(
    `SELECT COALESCE(sum(stack.quantity::numeric * definition.unit_weight_grams),0)::text AS weight
     FROM city_warehouse_stacks stack
     JOIN item_definitions definition ON definition.item_id=stack.item_id
     WHERE stack.city_id=$1`,
    [cityId]
  );
  return BigInt(result.rows[0]?.weight ?? "0");
}

function assertDonatableResource(itemId: ResourceType) {
  const definition = requireItemDefinition(itemId);
  if (definition.category !== "resource") {
    throw new CityWarehouseError(
      "CITY_WAREHOUSE_RESOURCE_REQUIRED",
      "Only materials and resources may be donated"
    );
  }
  return definition;
}

async function reserveOperation(
  client: pg.PoolClient,
  input: {
    operationKey: string;
    playerId: string;
    requestId: string;
    cityId: string;
    action: string;
    intent: Record<string, unknown>;
  }
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO city_warehouse_operations
       (operation_key,actor_player_id,request_id,city_id,action,intent)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (operation_key) DO NOTHING
     RETURNING operation_key`,
    [
      input.operationKey,
      input.playerId,
      input.requestId,
      input.cityId,
      input.action,
      JSON.stringify(input.intent)
    ]
  );
  if (inserted.rowCount) return false;
  const existing = await client.query<{
    actor_player_id: string;
    city_id: string;
    action: string;
    intent_matches: boolean;
    completed_at: Date | null;
  }>(
    `SELECT actor_player_id,city_id,action,completed_at,
            intent=$2::jsonb AS intent_matches
     FROM city_warehouse_operations WHERE operation_key=$1`,
    [input.operationKey, JSON.stringify(input.intent)]
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.actor_player_id !== input.playerId ||
    row.city_id !== input.cityId ||
    row.action !== input.action ||
    !row.intent_matches
  ) {
    throw new CityWarehouseError(
      "CITY_WAREHOUSE_IDEMPOTENCY_CONFLICT",
      "Warehouse request ID was reused with different intent"
    );
  }
  if (!row.completed_at) {
    throw new CityWarehouseError(
      "CITY_WAREHOUSE_OPERATION_INCOMPLETE",
      "The prior Warehouse operation did not complete"
    );
  }
  return true;
}

async function completeOperation(
  client: pg.PoolClient,
  operationKey: string,
  result: unknown
): Promise<void> {
  await client.query(
    `UPDATE city_warehouse_operations
     SET result=$2::jsonb,completed_at=now()
     WHERE operation_key=$1 AND completed_at IS NULL`,
    [operationKey, JSON.stringify(result)]
  );
}

async function writeWarehouseEvent(
  client: pg.PoolClient,
  input: {
    operationKey: string;
    cityId: string;
    playerId: string;
    eventType: "donated" | "moved" | "consumed";
    itemId?: ResourceType;
    variant?: string;
    quantity?: number;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO city_warehouse_events
       (operation_key,city_id,actor_player_id,event_type,item_id,variant,quantity)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING`,
    [
      input.operationKey,
      input.cityId,
      input.playerId,
      input.eventType,
      input.itemId ?? null,
      input.variant ?? null,
      input.quantity ?? null
    ]
  );
}

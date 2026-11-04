import {
  DEFAULT_MANOR_TYPE_ID,
  emptyInventoryTotals,
  FACE_MASK_ITEM_ID,
  MANOR_SKIN_ITEM_ID,
  projectMaterialProtection,
  type InventoryProtectionSnapshot,
  type InventoryStackProtection,
  type GreenhouseItemType,
  type InventoryItemType,
  type ResourceType
} from "@ash-atlas/shared";
import { createHash } from "node:crypto";
import type pg from "pg";

import {
  DEFAULT_INVENTORY_VARIANT,
  faceMaskWornReason,
  inventoryQuantityToSafeNumber,
  manorSkinEquippedReason
} from "./inventory.js";
import { requireRuntimeItemDefinition, supportsInventoryItemVariant } from "./items.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type ProtectionStateRow = {
  revision: string;
};

type StackRow = {
  stack_id: string;
  resource_type: string;
  variant: string;
  quantity: string;
};

type PolicyRow = {
  item_id: string;
  variant: string;
  keep_quantity: string;
};

type UniqueRow = {
  instance_id: string;
  definition_id: string;
  location: "inventory" | "equipped" | "manor_storage" | "destroyed";
  manor_storable: boolean;
  protected: boolean;
  saved_kit_count: string;
};

type OperationRow = {
  request_hash: string;
  original_result: ProtectionOperationResult | null;
};

export type ProtectionOperationResult = {
  protection: InventoryProtectionSnapshot;
  replayed: boolean;
  message: string;
};

export class InventoryProtectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type MaterialProtectionAllocation = {
  allocations: InventoryStackProtection[];
  byStackId: Map<string, InventoryStackProtection>;
};

export async function lockInventoryProtection(
  queryable: Queryable,
  playerId: string
): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 741))",
    [`inventory-protection:${playerId}`]
  );
}

export async function materialProtectionAllocation(
  queryable: Queryable,
  playerId: string
): Promise<MaterialProtectionAllocation> {
  const stacks = await queryable.query<StackRow>(
    `SELECT entry_id::text AS stack_id,resource_type,variant,quantity::text
     FROM player_inventory
     WHERE player_id=$1
     ORDER BY resource_type,variant,entry_id
     FOR UPDATE`,
    [playerId]
  );
  const policies = await queryable.query<PolicyRow>(
    `SELECT item_id,variant,keep_quantity::text
     FROM player_item_keep_policies
     WHERE player_id=$1`,
    [playerId]
  );
  // The skin equipped on the owner's Manor is held back like a keep amount of one.
  // The equipped skin copy and the worn mask copy (1202) are held back like a keep amount of one.
  const manor = await queryable.query<{ manor_type_id: string; skin_copy_id: string | null }>(
    "SELECT manor_type_id,skin_copy_id FROM player_manors WHERE owner_player_id=$1",
    [playerId]
  );
  const equippedSkin = manor.rows[0]?.manor_type_id;
  const equippedSkinCopy = equippedSkin && equippedSkin !== DEFAULT_MANOR_TYPE_ID ? manor.rows[0]?.skin_copy_id ?? null : null;
  const worn = (await queryable.query<{ mask_appearance_id: string | null; mask_copy_id: string | null }>(
    "SELECT mask_appearance_id,mask_copy_id FROM players WHERE id=$1",
    [playerId]
  )).rows[0];
  const wornMask = worn?.mask_appearance_id ?? null;
  const wornMaskCopy = wornMask ? worn?.mask_copy_id ?? null : null;
  for (const [itemId, copyId] of [[MANOR_SKIN_ITEM_ID, equippedSkinCopy], [FACE_MASK_ITEM_ID, wornMaskCopy]] as const) {
    if (!copyId) continue;
    const existing = policies.rows.find((row) => row.item_id === itemId && row.variant === copyId);
    if (existing) {
      if (BigInt(existing.keep_quantity) < 1n) existing.keep_quantity = "1";
    } else {
      policies.rows.push({ item_id: itemId, variant: copyId, keep_quantity: "1" });
    }
  }
  const projected = projectMaterialProtection(
    {
      playerId,
      revision: 0,
      items: stacks.rows.map((row) => ({
        playerId,
        resourceType: row.resource_type as InventoryItemType,
        variant: protocolVariant(row.variant),
        quantity: inventoryQuantityToSafeNumber(row.quantity),
        stackId: row.stack_id,
        entryId: row.stack_id
      })),
      totals: emptyInventoryTotals()
    },
    policies.rows.map((row) => ({
      itemId: row.item_id,
      variant: protocolVariant(row.variant),
      keepQuantity: inventoryQuantityToSafeNumber(row.keep_quantity),
      currentTotal: 0
    }))
  ).stackAllocations;
  const allocations = projected.map((allocation) => {
    if (allocation.protectedQuantity <= 0) return allocation;
    if (equippedSkin && equippedSkinCopy &&
      allocation.itemId === MANOR_SKIN_ITEM_ID && allocation.variant === equippedSkinCopy) {
      return { ...allocation, reason: manorSkinEquippedReason(equippedSkin) };
    }
    if (wornMask && wornMaskCopy && allocation.itemId === FACE_MASK_ITEM_ID && allocation.variant === wornMaskCopy) {
      return { ...allocation, reason: faceMaskWornReason(wornMask) };
    }
    return allocation;
  });
  return {
    allocations,
    byStackId: new Map(allocations.map((allocation) => [
      allocation.stackId,
      allocation
    ]))
  };
}

export class InventoryProtectionService {
  constructor(private readonly pool: pg.Pool) {}

  async snapshot(playerId: string): Promise<InventoryProtectionSnapshot> {
    return protectionSnapshot(this.pool, playerId);
  }

  setMaterialKeep(input: {
    playerId: string;
    requestId: string;
    itemId: ResourceType | GreenhouseItemType;
    variant: string | null;
    keepQuantity: number;
    expectedRevision: number;
  }): Promise<ProtectionOperationResult> {
    if (!supportsInventoryItemVariant(input.itemId, input.variant ?? DEFAULT_INVENTORY_VARIANT)) {
      throw new InventoryProtectionError(
        "INVENTORY_PROTECTION_ITEM_INVALID",
        "That item variant cannot have a keep amount."
      );
    }
    const definition = requireRuntimeItemDefinition(input.itemId);
    if (!Number.isSafeInteger(input.keepQuantity) || input.keepQuantity < 0) {
      throw new InventoryProtectionError(
        "INVENTORY_PROTECTION_QUANTITY_INVALID",
        "Keep quantity must be a nonnegative whole number."
      );
    }
    return this.runOperation({
      playerId: input.playerId,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      action: "set_keep",
      payload: {
        itemId: input.itemId,
        variant: input.variant,
        keepQuantity: input.keepQuantity
      },
      work: async (client, operationKey, revision) => {
        const variant = input.variant ?? DEFAULT_INVENTORY_VARIANT;
        const previous = await client.query<{ keep_quantity: string }>(
          `SELECT keep_quantity::text
           FROM player_item_keep_policies
           WHERE player_id=$1 AND item_id=$2 AND variant=$3
           FOR UPDATE`,
          [input.playerId, input.itemId, variant]
        );
        if (input.keepQuantity === 0) {
          await client.query(
            `DELETE FROM player_item_keep_policies
             WHERE player_id=$1 AND item_id=$2 AND variant=$3`,
            [input.playerId, input.itemId, variant]
          );
        } else {
          await client.query(
            `INSERT INTO player_item_keep_policies
               (player_id,item_id,variant,keep_quantity,revision)
             VALUES ($1,$2,$3,$4::bigint,$5::bigint)
             ON CONFLICT (player_id,item_id,variant) DO UPDATE SET
               keep_quantity=EXCLUDED.keep_quantity,
               revision=EXCLUDED.revision,
               updated_at=now()`,
            [input.playerId, input.itemId, variant, input.keepQuantity, revision]
          );
        }
        await this.writeEvent(client, {
          operationKey,
          playerId: input.playerId,
          action: "set_keep",
          itemId: input.itemId,
          variant,
          previousValue: previous.rows[0]
            ? { keepQuantity: inventoryQuantityToSafeNumber(previous.rows[0].keep_quantity) }
            : null,
          nextValue: { keepQuantity: input.keepQuantity },
          revision
        });
      },
      message: input.keepQuantity === 0
        ? `${definition.displayName} protection cleared.`
        : `Keeping ${input.keepQuantity.toLocaleString()} ${definition.displayName} in Inventory.`
    });
  }

  setUniqueProtection(input: {
    playerId: string;
    requestId: string;
    equipmentInstanceId: string;
    protected: boolean;
    expectedRevision: number;
  }): Promise<ProtectionOperationResult> {
    return this.runOperation({
      playerId: input.playerId,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      action: "set_unique",
      payload: {
        equipmentInstanceId: input.equipmentInstanceId,
        protected: input.protected
      },
      work: async (client, operationKey, revision) => {
        const owned = await client.query<{ protected: boolean | null }>(
          `SELECT protection.protected
           FROM equipment_instances equipment
           LEFT JOIN player_unique_item_protections protection
             ON protection.player_id=equipment.owner_player_id
            AND protection.equipment_instance_id=equipment.instance_id
           WHERE equipment.owner_player_id=$1
             AND equipment.instance_id=$2::uuid
             AND equipment.location<>'destroyed'
           FOR UPDATE OF equipment`,
          [input.playerId, input.equipmentInstanceId]
        );
        if (!owned.rows[0]) {
          throw new InventoryProtectionError(
            "INVENTORY_PROTECTION_ITEM_NOT_OWNED",
            "That equipment instance is not owned."
          );
        }
        if (input.protected) {
          await client.query(
            `INSERT INTO player_unique_item_protections
               (player_id,equipment_instance_id,protected,revision)
             VALUES ($1,$2::uuid,true,$3::bigint)
             ON CONFLICT (player_id,equipment_instance_id) DO UPDATE SET
               protected=true,revision=EXCLUDED.revision,updated_at=now()`,
            [input.playerId, input.equipmentInstanceId, revision]
          );
        } else {
          await client.query(
            `DELETE FROM player_unique_item_protections
             WHERE player_id=$1 AND equipment_instance_id=$2::uuid`,
            [input.playerId, input.equipmentInstanceId]
          );
        }
        await this.writeEvent(client, {
          operationKey,
          playerId: input.playerId,
          action: "set_unique",
          equipmentInstanceId: input.equipmentInstanceId,
          previousValue: { protected: owned.rows[0].protected === true },
          nextValue: { protected: input.protected },
          revision
        });
      },
      message: input.protected ? "Equipment protected." : "Equipment protection cleared."
    });
  }

  private async runOperation(input: {
    playerId: string;
    requestId: string;
    expectedRevision: number;
    action: "set_keep" | "set_unique";
    payload: Record<string, unknown>;
    work(
      client: pg.PoolClient,
      operationKey: string,
      revision: number
    ): Promise<void>;
    message: string;
  }): Promise<ProtectionOperationResult> {
    if (!input.requestId || input.requestId.length > 128) {
      throw new InventoryProtectionError(
        "INVENTORY_PROTECTION_REQUEST_INVALID",
        "A valid request ID is required."
      );
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new InventoryProtectionError(
        "INVENTORY_PROTECTION_REVISION_INVALID",
        "Protection revision is invalid."
      );
    }
    const operationKey = `inventory-protection:${createHash("sha256")
      .update(`${input.playerId}\0${input.requestId}`)
      .digest("hex")}`;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({
        playerId: input.playerId,
        action: input.action,
        expectedRevision: input.expectedRevision,
        ...input.payload
      }))
      .digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockInventoryProtection(client, input.playerId);
      const replay = await client.query<OperationRow>(
        `SELECT request_hash,original_result
         FROM inventory_protection_operations
         WHERE player_id=$1 AND request_id=$2
         FOR UPDATE`,
        [input.playerId, input.requestId]
      );
      if (replay.rows[0]) {
        if (
          replay.rows[0].request_hash !== requestHash ||
          !replay.rows[0].original_result
        ) {
          throw new InventoryProtectionError(
            "INVENTORY_PROTECTION_REPLAY_CONFLICT",
            "That request ID was already used for a different protection update."
          );
        }
        await client.query("COMMIT");
        return { ...replay.rows[0].original_result, replayed: true };
      }
      await client.query(
        `INSERT INTO player_inventory_protection_state (player_id)
         VALUES ($1)
         ON CONFLICT (player_id) DO NOTHING`,
        [input.playerId]
      );
      const state = await client.query<ProtectionStateRow>(
        `SELECT revision::text
         FROM player_inventory_protection_state
         WHERE player_id=$1
         FOR UPDATE`,
        [input.playerId]
      );
      const currentRevision = inventoryQuantityToSafeNumber(
        state.rows[0]?.revision ?? "0"
      );
      if (currentRevision !== input.expectedRevision) {
        throw new InventoryProtectionError(
          "INVENTORY_PROTECTION_STALE_REVISION",
          "Protection settings changed in another session. Review the latest policy and try again."
        );
      }
      await client.query(
        `INSERT INTO inventory_protection_operations
           (operation_key,player_id,request_id,action,request_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [operationKey, input.playerId, input.requestId, input.action, requestHash]
      );
      const revision = currentRevision + 1;
      await input.work(client, operationKey, revision);
      await client.query(
        `UPDATE player_inventory_protection_state
         SET revision=$2::bigint,updated_at=now()
         WHERE player_id=$1`,
        [input.playerId, revision]
      );
      const result: ProtectionOperationResult = {
        protection: await protectionSnapshot(client, input.playerId),
        replayed: false,
        message: input.message
      };
      await client.query(
        `UPDATE inventory_protection_operations
         SET original_result=$2::jsonb,completed_at=now()
         WHERE operation_key=$1`,
        [operationKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeEvent(client: pg.PoolClient, input: {
    operationKey: string;
    playerId: string;
    action: "set_keep" | "set_unique";
    itemId?: string;
    variant?: string;
    equipmentInstanceId?: string;
    previousValue: Record<string, unknown> | null;
    nextValue: Record<string, unknown>;
    revision: number;
  }): Promise<void> {
    await client.query(
      `INSERT INTO inventory_protection_events
       (operation_key,player_id,action,item_id,variant,equipment_instance_id,
        previous_value,next_value,revision)
       VALUES ($1,$2,$3,$4,$5,$6::uuid,$7::jsonb,$8::jsonb,$9::bigint)`,
      [
        input.operationKey,
        input.playerId,
        input.action,
        input.itemId ?? null,
        input.variant ?? null,
        input.equipmentInstanceId ?? null,
        input.previousValue ? JSON.stringify(input.previousValue) : null,
        JSON.stringify(input.nextValue),
        input.revision
      ]
    );
  }
}

async function protectionSnapshot(
  queryable: Queryable,
  playerId: string
): Promise<InventoryProtectionSnapshot> {
  await queryable.query(
    `INSERT INTO player_inventory_protection_state (player_id)
     SELECT id FROM players WHERE id=$1
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
  const state = await queryable.query<ProtectionStateRow>(
    `SELECT revision::text
     FROM player_inventory_protection_state
     WHERE player_id=$1`,
    [playerId]
  );
  const policies = await queryable.query<PolicyRow & { current_total: string }>(
    `SELECT policy.item_id,policy.variant,policy.keep_quantity::text,
            COALESCE(sum(stack.quantity),0)::text AS current_total
     FROM player_item_keep_policies policy
     LEFT JOIN player_inventory stack
       ON stack.player_id=policy.player_id
      AND stack.resource_type=policy.item_id
      AND stack.variant=policy.variant
     WHERE policy.player_id=$1
     GROUP BY policy.item_id,policy.variant,policy.keep_quantity
     ORDER BY policy.item_id,policy.variant`,
    [playerId]
  );
  const uniqueItems = await queryable.query<UniqueRow>(
    `SELECT equipment.instance_id::text,equipment.definition_id,equipment.location,
            definition.manor_storable,
            COALESCE(protection.protected,false) AS protected,
            count(kit.instance_id)::text AS saved_kit_count
     FROM equipment_instances equipment
     JOIN item_definitions definition
       ON definition.item_id=equipment.definition_id
     LEFT JOIN player_unique_item_protections protection
       ON protection.player_id=equipment.owner_player_id
      AND protection.equipment_instance_id=equipment.instance_id
     LEFT JOIN combat_kit_items kit
       ON kit.player_id=equipment.owner_player_id
      AND kit.instance_id=equipment.instance_id
     WHERE equipment.owner_player_id=$1
       AND equipment.location<>'destroyed'
     GROUP BY equipment.instance_id,equipment.definition_id,equipment.location,
              definition.manor_storable,protection.protected
     ORDER BY equipment.definition_id,equipment.instance_id`,
    [playerId]
  );
  const allocation = await materialProtectionAllocation(queryable, playerId);
  return {
    playerId,
    revision: inventoryQuantityToSafeNumber(state.rows[0]?.revision ?? "0"),
    materialPolicies: policies.rows.map((row) => ({
      itemId: row.item_id,
      variant: protocolVariant(row.variant),
      keepQuantity: inventoryQuantityToSafeNumber(row.keep_quantity),
      currentTotal: inventoryQuantityToSafeNumber(row.current_total)
    })),
    uniqueItems: uniqueItems.rows.map((row) => ({
      equipmentInstanceId: row.instance_id,
      protected: row.protected,
      systemReason: row.location === "equipped"
        ? "Equipped — cannot be stored"
        : row.location === "manor_storage"
          ? "Already stored in Manor Storage"
          : Number(row.saved_kit_count) > 0
            ? "Referenced by a saved combat kit"
            : !row.manor_storable
              ? "This item cannot be stored"
              : null
    })),
    stackAllocations: allocation.allocations
  };
}

function protocolVariant(variant: string): string | null {
  return variant === DEFAULT_INVENTORY_VARIANT ? null : variant;
}

import type { ResourceType } from "@ash-atlas/shared";
import type pg from "pg";

import type { DungeonRuntimeAuthorities } from "./dungeon.js";
import { DEFAULT_INVENTORY_VARIANT, type InventoryService } from "./inventory.js";

const CHARGE_SOURCE = "dungeon_entry_cost";
const REFUND_SOURCE = "dungeon_entry_refund";

/** One charge per (run, player); a shared run's admissions (re-entries) are each their own charge. */
export function dungeonEntryChargeKey(runId: string, playerId: string, admissionId?: string): string {
  return admissionId
    ? `dungeon-entry-cost:${runId}:${playerId}:admission:${admissionId}`
    : `dungeon-entry-cost:${runId}:${playerId}`;
}

export function dungeonEntryRefundKey(runId: string, playerId: string, admissionId?: string): string {
  return admissionId
    ? `dungeon-entry-refund:${runId}:${playerId}:admission:${admissionId}`
    : `dungeon-entry-refund:${runId}:${playerId}`;
}

/**
 * Dungeon torch payments through the inventory ledger. The charge debits a run's torches from one player,
 * idempotent per (run, player). The refund reads those charges back from the ledger and grants each payer
 * exactly what was debited, idempotent per (run, player), in the caller's transaction.
 */
export function dungeonEntryCostAuthorities(
  inventory: Pick<InventoryService, "debitItemsForOperationInTransaction" | "grantItemsForOperationInTransaction">
): Required<Pick<DungeonRuntimeAuthorities, "chargeEntryCost" | "refundEntryCosts" | "refundAdmission">> {
  return {
    refundAdmission: async (client, context) => {
      const chargeKey = dungeonEntryChargeKey(context.runId, context.playerId, context.admissionId);
      const charged = await (client as Pick<pg.PoolClient, "query">).query<{ item_id: string; variant: string; delta_quantity: number | string }>(
        `SELECT event.item_id, event.variant, event.delta_quantity
           FROM inventory_operations operation
           JOIN inventory_events event ON event.operation_key = operation.operation_key
          WHERE operation.operation_key = $1 AND operation.player_id = $2 AND operation.source = $3
          ORDER BY event.item_id, event.variant`,
        [chargeKey, context.playerId, CHARGE_SOURCE]
      );
      const grants = charged.rows.flatMap((row) => {
        const quantity = -Number(row.delta_quantity);
        return Number.isSafeInteger(quantity) && quantity > 0
          ? [{ itemId: row.item_id as ResourceType, variant: row.variant === DEFAULT_INVENTORY_VARIANT ? null : row.variant, quantity }]
          : [];
      });
      // A zero-torch admission (or one paid entirely by a Cinder Lantern) has nothing to give back.
      if (grants.length === 0) return;
      await inventory.grantItemsForOperationInTransaction(client, {
        operationKey: dungeonEntryRefundKey(context.runId, context.playerId, context.admissionId),
        playerId: context.playerId,
        source: REFUND_SOURCE,
        sourceEntityType: "dungeon",
        sourceEntityId: context.dungeonId,
        metadata: { instanceId: context.instanceId, runId: context.runId, admissionId: context.admissionId,
          chargeOperationKey: chargeKey },
        grants
      });
    },
    chargeEntryCost: async (client, playerId, items, context) => {
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey: dungeonEntryChargeKey(context.runId, playerId, context.admissionId),
        playerId,
        source: CHARGE_SOURCE,
        sourceEntityType: "dungeon",
        sourceEntityId: context.dungeonId,
        metadata: { instanceId: context.instanceId, runId: context.runId,
          ...(context.admissionId ? { admissionId: context.admissionId } : {}) },
        debits: items.map((item) => ({ itemId: item.itemId as ResourceType, variant: null, quantity: item.quantity }))
      });
    },
    refundEntryCosts: async (client, context) => {
      const charges = await (client as Pick<pg.PoolClient, "query">).query<{
        operation_key: string; player_id: string; item_id: string; variant: string; delta_quantity: number | string;
      }>(
        `SELECT operation.operation_key, operation.player_id, event.item_id, event.variant, event.delta_quantity
           FROM inventory_operations operation
           JOIN inventory_events event ON event.operation_key = operation.operation_key
          WHERE operation.source_entity_type = 'dungeon' AND operation.source_entity_id = $1
            AND operation.source = $2 AND operation.metadata->>'runId' = $3
          ORDER BY operation.player_id, event.item_id, event.variant`,
        [context.dungeonId, CHARGE_SOURCE, context.runId]
      );
      const byPlayer = new Map<string, Array<{ itemId: ResourceType; variant: string | null; quantity: number }>>();
      for (const row of charges.rows) {
        if (row.operation_key !== dungeonEntryChargeKey(context.runId, row.player_id)) continue;
        const quantity = -Number(row.delta_quantity);
        if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
        const items = byPlayer.get(row.player_id) ?? [];
        items.push({
          itemId: row.item_id as ResourceType,
          variant: row.variant === DEFAULT_INVENTORY_VARIANT ? null : row.variant,
          quantity
        });
        byPlayer.set(row.player_id, items);
      }
      for (const [playerId, grants] of byPlayer) {
        await inventory.grantItemsForOperationInTransaction(client, {
          operationKey: dungeonEntryRefundKey(context.runId, playerId),
          playerId,
          source: REFUND_SOURCE,
          sourceEntityType: "dungeon",
          sourceEntityId: context.dungeonId,
          metadata: {
            instanceId: context.instanceId, runId: context.runId,
            chargeOperationKey: dungeonEntryChargeKey(context.runId, playerId)
          },
          grants
        });
      }
    }
  };
}

import type pg from "pg";

import type { InventoryOperationResult, InventoryService } from "./inventory.js";

/**
 * Delver's Lore rank 1: leaving a dungeon voluntarily returns the entry torch, but only to the player
 * whose debit opened the run (`dungeon-entry-cost:<run>:<player>`; a Cinder Lantern charge leaves
 * no torch debit). One credit per run and payer, so a repeated leave pays nothing.
 */
export async function refundDungeonEntryTorch(
  pool: Pick<pg.Pool, "query">,
  inventory: Pick<InventoryService, "grantItemsForOperation">,
  input: Readonly<{ playerId: string; runId: string; dungeonId: string; instanceId: string }>
): Promise<InventoryOperationResult | null> {
  const paid = await pool.query(
    `SELECT 1 FROM inventory_events e JOIN inventory_operations o USING (operation_key)
     WHERE o.operation_key = $1 AND o.player_id = $2 AND o.source = 'dungeon_entry_cost'
       AND e.item_id = 'torch' AND e.delta_quantity < 0`,
    [`dungeon-entry-cost:${input.runId}:${input.playerId}`, input.playerId]
  );
  if (!paid.rowCount) return null;
  const result = await inventory.grantItemsForOperation({
    operationKey: `dungeon-reentry-torch:${input.runId}:${input.playerId}`,
    playerId: input.playerId,
    source: "dungeon_reentry_torch",
    sourceEntityType: "dungeon",
    sourceEntityId: input.dungeonId,
    metadata: { instanceId: input.instanceId, runId: input.runId },
    grants: [{ itemId: "torch", variant: null, quantity: 1 }]
  });
  return result.applied ? result : null;
}

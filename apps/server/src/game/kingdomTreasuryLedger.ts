import { randomUUID } from "node:crypto";

import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type KingdomTreasuryLedgerSource =
  | "brick_deposit"
  | "kingdom_structure_build"
  | "brick_furnace_upgrade"
  | "brick_furnace_package"
  | "war_surrender_transfer"
  | "war_surrender_destroyed"
  | "war_death_loss"
  | "kingdom_perk_choose"
  | "kingdom_perk_change"
  | "command_board_upgrade"
  | "war_structure_build"
  | "kingdom_perk_payout"
  | "kingdom_structure_downgrade"
  | "castle_rebuild";

const DEFAULT_VARIANT = "default";

/**
 * Locks (creating at zero if missing) one kingdom treasury balance row and
 * returns its quantity. Callers lock treasury rows only after the flag row
 * (structure builds) or the kingdom row (kingdom mutations).
 */
export async function lockKingdomTreasuryBalance(
  client: Queryable,
  kingdomId: string,
  resourceType: string
): Promise<number> {
  await client.query(
    `INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
     VALUES ($1,$2,$3,0) ON CONFLICT (kingdom_id, resource_type, variant) DO NOTHING`,
    [kingdomId, resourceType, DEFAULT_VARIANT]
  );
  const result = await client.query<{ quantity: string | number }>(
    `SELECT quantity FROM kingdom_treasury_balances
     WHERE kingdom_id = $1 AND resource_type = $2 AND variant = $3 FOR UPDATE`,
    [kingdomId, resourceType, DEFAULT_VARIANT]
  );
  return Number(result.rows[0]?.quantity ?? 0);
}

/**
 * Moves one treasury balance and appends the ledger row in the caller's
 * transaction. The ledger's (operation_key, resource, direction) key makes a
 * second move for the same operation fail instead of applying twice.
 * Returns null (and changes nothing) when a debit exceeds the balance.
 */
export async function moveKingdomTreasuryInTransaction(
  client: Queryable,
  input: Readonly<{
    kingdomId: string;
    actorPlayerId: string | null;
    resourceType: string;
    direction: "credit" | "debit";
    quantity: number;
    sourceType: KingdomTreasuryLedgerSource;
    operationKey: string;
    sourceId?: string | null;
    metadata?: Record<string, unknown>;
  }>
): Promise<{ before: number; after: number } | null> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw new Error("Kingdom treasury movement quantity must be a positive whole number");
  }
  const before = await lockKingdomTreasuryBalance(client, input.kingdomId, input.resourceType);
  const after = input.direction === "credit" ? before + input.quantity : before - input.quantity;
  if (after < 0) return null;
  await client.query(
    `UPDATE kingdom_treasury_balances SET quantity = $4, updated_at = now()
     WHERE kingdom_id = $1 AND resource_type = $2 AND variant = $3`,
    [input.kingdomId, input.resourceType, DEFAULT_VARIANT, after]
  );
  await client.query(
    `INSERT INTO kingdom_treasury_ledger (
       id, kingdom_id, actor_player_id, resource_type, variant, direction, quantity,
       balance_before, balance_after, source_type, operation_key, source_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [randomUUID(), input.kingdomId, input.actorPlayerId, input.resourceType, DEFAULT_VARIANT,
      input.direction, input.quantity, before, after, input.sourceType, input.operationKey,
      input.sourceId ?? null, JSON.stringify(input.metadata ?? {})]
  );
  return { before, after };
}

/**
 * Credits a structure downgrade's refund lines to the treasury under one
 * operation key (the ledger key makes a replay fail instead of paying twice).
 */
export async function creditKingdomDowngradeRefundInTransaction(
  client: Queryable,
  input: Readonly<{
    kingdomId: string;
    actorPlayerId: string;
    operationKey: string;
    refund: readonly Readonly<{ itemId: string; quantity: number }>[];
    sourceId?: string | null;
    metadata: Record<string, unknown>;
  }>
): Promise<void> {
  for (const line of input.refund) {
    await moveKingdomTreasuryInTransaction(client, {
      kingdomId: input.kingdomId,
      actorPlayerId: input.actorPlayerId,
      resourceType: line.itemId,
      direction: "credit",
      quantity: line.quantity,
      sourceType: "kingdom_structure_downgrade",
      operationKey: input.operationKey,
      sourceId: input.sourceId ?? null,
      metadata: input.metadata
    });
  }
}

/** Appends a kingdom activity row (same table and shape as the kingdom service's audit). */
export async function insertKingdomAuditEvent(
  client: Queryable,
  input: Readonly<{
    kingdomId: string;
    actorPlayerId: string | null;
    eventType: string;
    entityType?: string | null;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  }>
): Promise<void> {
  await client.query(
    `INSERT INTO kingdom_audit_events (
       id, kingdom_id, actor_player_id, target_player_id, event_type,
       entity_type, entity_id, metadata
     ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7::jsonb)`,
    [randomUUID(), input.kingdomId, input.actorPlayerId, input.eventType,
      input.entityType ?? null, input.entityId ?? null, JSON.stringify(input.metadata ?? {})]
  );
}

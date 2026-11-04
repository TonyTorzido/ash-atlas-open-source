import {
  BRICKS_ITEM_ID,
  type PlayerInventorySnapshot,
  WAR_DEATH_KINGDOM_BRICK_LOSS,
  WAR_DEATH_KINGDOM_LEADER_BRICK_LOSS,
  warDeathCarriedBrickLoss
} from "@ash-atlas/shared";
import type pg from "pg";

import { DEFAULT_INVENTORY_VARIANT, type InventoryService } from "./inventory.js";
import { lockKingdomTreasuryBalance, moveKingdomTreasuryInTransaction } from "./kingdomTreasuryLedger.js";
import { loadPlayerOrganizations, type OrganizationRef } from "./warStructures.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type WarDeathLossResult = Readonly<{
  warId: string;
  carriedBefore: number;
  carriedLost: number;
  treasuryLost: number;
  /** False when this death was already settled (replay). */
  applied: boolean;
  /** The victim's pack after the loss; null on a replay or when nothing left it. */
  inventory: PlayerInventorySnapshot | null;
  /** The victim's kingdom when it was the side at war (a leader death boosts its revolt vote). */
  victimKingdomId?: string | null;
  victimWasLeader?: boolean;
}>;

type WarDeathInventory = Pick<
  InventoryService, "debitItemsForOperationInTransaction" | "lockPlayerInventoryForOperationInTransaction"
>;

function organizationsOf(organizations: Readonly<{ cityId: string | null; kingdomId: string | null }>): OrganizationRef[] {
  return [
    ...(organizations.kingdomId ? [{ kind: "kingdom" as const, id: organizations.kingdomId }] : []),
    ...(organizations.cityId ? [{ kind: "city" as const, id: organizations.cityId }] : [])
  ];
}

/**
 * The active war between any of the victim's sides and any of the killer's,
 * preferring one fought by the victim's kingdom (only that war costs the
 * kingdom treasury).
 */
async function findWarBetween(
  queryable: Queryable,
  victimSides: readonly OrganizationRef[],
  killerSides: readonly OrganizationRef[]
): Promise<{ warId: string; victimSide: OrganizationRef } | null> {
  for (const victimSide of victimSides) {
    for (const killerSide of killerSides) {
      if (victimSide.kind === killerSide.kind && victimSide.id === killerSide.id) continue;
      const result = await queryable.query<{ war_id: string }>(
        `SELECT war_id::text FROM organization_wars
         WHERE status = 'active'
           AND ((side_a_kind = $1 AND side_a_id = $2::uuid AND side_b_kind = $3 AND side_b_id = $4::uuid)
             OR (side_a_kind = $3 AND side_a_id = $4::uuid AND side_b_kind = $1 AND side_b_id = $2::uuid))
         LIMIT 1`,
        [victimSide.kind, victimSide.id, killerSide.kind, killerSide.id]
      );
      if (result.rows[0]) return { warId: result.rows[0].war_id, victimSide };
    }
  }
  return null;
}

/**
 * War-death losses for one player death: killed by a
 * member of a side at war with one of the victim's sides, the victim loses
 * 9% of their carried Bricks (destroyed; player deaths drop no items) and,
 * when the victim's kingdom is the side at war, its treasury loses 115
 * Bricks (1,150 for the leader), floored at an empty treasury.
 *
 * Idempotent per death: an advisory lock on the death's operation key
 * serializes replays, and the recorded row makes a repeat return the first
 * result without moving anything. Lock order: the victim's inventory rows
 * and carry lock (player), then the kingdom treasury row.
 */
export async function applyWarDeathLosses(
  pool: pg.Pool,
  inventory: WarDeathInventory,
  input: Readonly<{ deathOperationKey: string; victimPlayerId: string; killerPlayerId: string }>
): Promise<WarDeathLossResult | null> {
  if (input.victimPlayerId === input.killerPlayerId) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`war-death:${input.deathOperationKey}`]);
    const prior = await client.query<{
      war_id: string;
      carried_before: string;
      carried_lost: string;
      treasury_lost: string;
    }>(
      `SELECT war_id::text, carried_before::text, carried_lost::text, treasury_lost::text
       FROM organization_war_death_losses WHERE operation_key = $1`,
      [input.deathOperationKey]
    );
    if (prior.rows[0]) {
      await client.query("COMMIT");
      const row = prior.rows[0];
      return {
        warId: row.war_id,
        carriedBefore: Number(row.carried_before),
        carriedLost: Number(row.carried_lost),
        treasuryLost: Number(row.treasury_lost),
        applied: false,
        inventory: null
      };
    }
    const [victim, killer] = await Promise.all([
      loadPlayerOrganizations(client, input.victimPlayerId),
      loadPlayerOrganizations(client, input.killerPlayerId)
    ]);
    const war = await findWarBetween(client, organizationsOf(victim), organizationsOf(killer));
    if (!war) {
      await client.query("COMMIT");
      return null;
    }
    const operationKey = `war-death:${input.deathOperationKey}`;
    // The inventory carry lock first, then the Bricks row: the order every inventory writer uses.
    await inventory.lockPlayerInventoryForOperationInTransaction(client, input.victimPlayerId);
    const stack = await client.query<{ quantity: string | number }>(
      `SELECT quantity FROM player_inventory
       WHERE player_id = $1 AND resource_type = $2 AND variant = $3 FOR UPDATE`,
      [input.victimPlayerId, BRICKS_ITEM_ID, DEFAULT_INVENTORY_VARIANT]
    );
    const carriedBefore = stack.rows.reduce((total, row) => total + Number(row.quantity), 0);
    const carriedLost = warDeathCarriedBrickLoss(carriedBefore);
    let snapshot: PlayerInventorySnapshot | null = null;
    if (carriedLost > 0) {
      const debited = await inventory.debitItemsForOperationInTransaction(client, {
        operationKey,
        playerId: input.victimPlayerId,
        source: "war_death_destroyed",
        sourceEntityType: "organization_war",
        sourceEntityId: war.warId,
        metadata: { killerPlayerId: input.killerPlayerId, carriedBefore },
        debits: [{ itemId: BRICKS_ITEM_ID, variant: null, quantity: carriedLost }]
      });
      snapshot = debited.inventory;
    }
    let treasuryLost = 0;
    let victimKingdomId: string | null = null;
    let victimWasLeader = false;
    if (war.victimSide.kind === "kingdom") {
      victimKingdomId = war.victimSide.id;
      // The leader role, not kingdoms.leader_player_id: a deposed leader keeps
      // that column through anarchy but leads nobody.
      const leader = await client.query(
        `SELECT 1 FROM kingdom_memberships
         WHERE kingdom_id = $1::uuid AND player_id = $2 AND status = 'active' AND role = 'leader'`,
        [victimKingdomId, input.victimPlayerId]
      );
      victimWasLeader = Boolean(leader.rowCount);
      const penalty = victimWasLeader ? WAR_DEATH_KINGDOM_LEADER_BRICK_LOSS : WAR_DEATH_KINGDOM_BRICK_LOSS;
      const balance = await lockKingdomTreasuryBalance(client, victimKingdomId, BRICKS_ITEM_ID);
      treasuryLost = Math.min(balance, penalty);
      if (treasuryLost > 0) {
        const moved = await moveKingdomTreasuryInTransaction(client, {
          kingdomId: victimKingdomId,
          actorPlayerId: null,
          resourceType: BRICKS_ITEM_ID,
          direction: "debit",
          quantity: treasuryLost,
          sourceType: "war_death_loss",
          operationKey,
          sourceId: war.warId,
          metadata: { victimPlayerId: input.victimPlayerId, killerPlayerId: input.killerPlayerId, victimWasLeader }
        });
        if (!moved) throw new Error("War-death treasury loss exceeded the locked balance");
      }
    }
    await client.query(
      `INSERT INTO organization_war_death_losses (
         operation_key, war_id, victim_player_id, killer_player_id, victim_kingdom_id,
         victim_was_leader, carried_before, carried_lost, treasury_lost
       ) VALUES ($1,$2::uuid,$3,$4,$5::uuid,$6,$7,$8,$9)`,
      [input.deathOperationKey, war.warId, input.victimPlayerId, input.killerPlayerId, victimKingdomId,
        victimWasLeader, carriedBefore, carriedLost, treasuryLost]
    );
    await client.query("COMMIT");
    return {
      warId: war.warId, carriedBefore, carriedLost, treasuryLost, applied: true, inventory: snapshot,
      victimKingdomId, victimWasLeader
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

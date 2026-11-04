import { createHash } from "node:crypto";

import {
  BRICKS_ITEM_ID,
  KINGDOM_PERK_PRISM_KNIGHTS_TREASURY_CRYSTAL,
  KINGDOM_PERK_PRISM_HOLDINGS_CHANCE,
  KINGDOM_PERK_MORTAR_GUARD_TREASURY_BRICKS,
  KINGDOM_PERK_CACHE_HUNTERS_GOLD,
  type KingdomPerkId
} from "@ash-atlas/shared";
import type pg from "pg";

import type { GroundPlacement } from "./droppedItems.js";
import { kingdomPerksForPlayer } from "./kingdomPerks.js";
import { moveKingdomTreasuryInTransaction } from "./kingdomTreasuryLedger.js";
import { grantRingFindInTransaction, type RingFindEquipment, type RingFindResult } from "./ringFinds.js";
import type { WalletOperationResult, WalletService } from "./wallet.js";

type Queryable = Pick<pg.PoolClient, "query">;

const CRYSTAL_ITEM_ID = "crystal";

/** The level 7 perks: each pays once when a member receives a ring from a Legendary mob. */
export const KINGDOM_LEGENDARY_RING_PERK_IDS = [
  "arcane_reavers",
  "mortar_guard",
  "prism_knights",
  "cache_hunters"
] as const satisfies readonly KingdomPerkId[];
export type KingdomLegendaryRingPerkId = (typeof KINGDOM_LEGENDARY_RING_PERK_IDS)[number];

/** Deterministic roll in [0, 1) for one kill, so a retried settlement rolls the same. */
export function kingdomRewardPerkRoll(rollKey: string): number {
  const digest = createHash("sha256").update(`kingdom-reward-perk-v1:${rollKey}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/** Prism Holdings: true for the ~1.2% of a member's kills that give Crystal. */
export function prismHoldingsHit(rollKey: string): boolean {
  return kingdomRewardPerkRoll(`prism-holdings:${rollKey}`) < KINGDOM_PERK_PRISM_HOLDINGS_CHANCE;
}

export type KingdomLegendaryRingPayout = Readonly<{
  perkId: KingdomLegendaryRingPerkId;
  /** Arcane Reavers: the Peerless Ring grant. */
  ring?: RingFindResult;
  /** Cache Hunters: the member's wallet after the credit. */
  wallet?: WalletOperationResult;
}>;

/**
 * Pays the member's kingdom level 7 perk for one legendary ring receipt, in
 * the caller's transaction (the one that granted the ring). Every payout is
 * keyed by the ring grant's operation key, so a replayed reward pays nothing
 * more. Returns null when the player has no level 7 perk in effect.
 */
export async function payKingdomLegendaryRingPerkInTransaction(
  client: Queryable,
  deps: Readonly<{
    equipment: RingFindEquipment;
    wallet: Pick<WalletService, "creditForOperationInTransaction">;
  }>,
  input: Readonly<{
    playerId: string;
    accountId: string;
    /** The legendary ring grant's operation key. */
    ringOperationKey: string;
    /** Where a Peerless Ring lands when the bag is full. */
    ground: GroundPlacement | null;
    now?: Date;
  }>
): Promise<KingdomLegendaryRingPayout | null> {
  const perks = await kingdomPerksForPlayer(client, input.playerId, input.now);
  const perkId = KINGDOM_LEGENDARY_RING_PERK_IDS.find((id) => perks?.perkIds.has(id));
  if (!perks || !perkId) return null;
  const operationKey = `kingdom-perk:${perkId}:${input.ringOperationKey}`;
  switch (perkId) {
    case "arcane_reavers":
      return {
        perkId,
        ring: await grantRingFindInTransaction(client, deps.equipment, {
          operationKey,
          playerId: input.playerId,
          tier: "peerless",
          source: "kingdom_perk_arcane_reavers",
          ground: input.ground
        })
      };
    case "cache_hunters":
      return {
        perkId,
        wallet: await deps.wallet.creditForOperationInTransaction(client, {
          playerId: input.playerId,
          accountId: input.accountId,
          amount: BigInt(KINGDOM_PERK_CACHE_HUNTERS_GOLD),
          operationKey,
          reason: "kingdom_perk_cache_hunters"
        })
      };
    case "mortar_guard":
    case "prism_knights": {
      const [resourceType, quantity] = perkId === "mortar_guard"
        ? [BRICKS_ITEM_ID, KINGDOM_PERK_MORTAR_GUARD_TREASURY_BRICKS]
        : [CRYSTAL_ITEM_ID, KINGDOM_PERK_PRISM_KNIGHTS_TREASURY_CRYSTAL];
      // The ledger's operation key is unique: a replay must skip, not abort the reward.
      const prior = await client.query(
        `SELECT 1 FROM kingdom_treasury_ledger
         WHERE operation_key = $1 AND resource_type = $2 AND variant = 'default' AND direction = 'credit'`,
        [operationKey, resourceType]
      );
      if ((prior.rowCount ?? 0) === 0) {
        await moveKingdomTreasuryInTransaction(client, {
          kingdomId: perks.kingdomId,
          actorPlayerId: input.playerId,
          resourceType,
          direction: "credit",
          quantity,
          sourceType: "kingdom_perk_payout",
          operationKey,
          sourceId: input.ringOperationKey,
          metadata: { perkId }
        });
      }
      return { perkId };
    }
  }
}

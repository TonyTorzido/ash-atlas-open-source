import type { DungeonServerMessage, PlayerInventorySnapshot, PlayerWalletSnapshot } from "@ash-atlas/shared";

import { chestLootCard, type LootCard, type LootItemLookup } from "../../combat/lootCards.js";

type DungeonRewardGranted = Extract<DungeonServerMessage, { type: "DUNGEON_REWARD_GRANTED" }>;

/**
 * Installs the authoritative inventory/wallet and reveals a freshly claimed chest as one loot card
 * (the same card mob kills use). Replays and empty claims show nothing here: the server already put
 * "already looted" / "The chest is empty." on the dungeon notice lane, so no second message appears.
 */
export function applyDungeonRewardResult(
  frame: DungeonRewardGranted,
  consumers: Readonly<{
    receiveInventory(snapshot: PlayerInventorySnapshot): void;
    receiveWallet(snapshot: PlayerWalletSnapshot): void;
    presentLootCard?(card: LootCard): void;
    itemLookup: LootItemLookup;
    nowMs: number;
  }>
): void {
  consumers.receiveInventory(frame.inventory);
  consumers.receiveWallet(frame.wallet);
  const card = chestLootCard(frame, consumers.itemLookup, consumers.nowMs);
  if (card) consumers.presentLootCard?.(card);
}

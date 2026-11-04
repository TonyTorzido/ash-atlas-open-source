import { INVENTORY_CATALOG } from "@ash-atlas/shared";

import { resourceDisplayName } from "../collectibles/harvest.js";
import { droppedItemDisplayName } from "../droppedItems/droppedItemModel.js";
import type { LootItemLookup } from "./lootCards.js";

type DropItemId = Parameters<typeof droppedItemDisplayName>[0]["itemId"];

/** Player-facing item name for the loot feed, or null when the id is unknown to the client. */
export function lootItemName(itemId: string): string | null {
  try {
    return droppedItemDisplayName({ itemId: itemId as DropItemId, variant: null });
  } catch {
    try { return resourceDisplayName(itemId as Parameters<typeof resourceDisplayName>[0]); } catch { return null; }
  }
}

/** Name and catalog rarity for loot cards. */
export const lootCardItemLookup: LootItemLookup = (itemId) => ({
  name: lootItemName(itemId) ?? itemId,
  rarity: (INVENTORY_CATALOG as Readonly<Record<string, { rarity: "common" | "uncommon" | "rare" | "epic" | "legendary" } | undefined>>)[itemId]?.rarity ?? "common"
});

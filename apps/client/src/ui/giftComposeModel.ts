import {
  isGiftableItem,
  requireEquipmentDefinition,
  type EquipmentInstanceV2,
  type EquipmentSnapshotV2,
  type PlayerGiftStatus,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";

import { inventoryPanelRows, type InventoryPanelRow } from "../inventory/inventoryPanelModel.js";

/** Carried giftable stacks, merged per item and variant (the server debits by item, not stack). */
export function giftableInventoryRows(inventory: PlayerInventorySnapshot): InventoryPanelRow[] {
  const merged = new Map<string, InventoryPanelRow>();
  for (const row of inventoryPanelRows(inventory)) {
    if (!isGiftableItem(row.itemId) || row.quantity < 1) continue;
    const key = `${row.itemId}|${row.variant ?? ""}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, quantity: existing.quantity + row.quantity } : row);
  }
  return [...merged.values()];
}

/** Equipment sitting in the carried inventory, never worn pieces. */
export function giftableEquipment(equipment: EquipmentSnapshotV2 | null): EquipmentInstanceV2[] {
  return (equipment?.instances ?? []).filter((instance) =>
    instance.location === "inventory" && instance.equippedSlot === null && instance.droppable !== false &&
    isMarketTradableEquipment(instance.definitionId)
  );
}

function isMarketTradableEquipment(definitionId: EquipmentInstanceV2["definitionId"]): boolean {
  try {
    return requireEquipmentDefinition(definitionId).marketTradable;
  } catch {
    return false;
  }
}

export function giftBoxesCarried(inventory: PlayerInventorySnapshot): number {
  return inventory.items
    .filter((item) => String(item.resourceType) === "gift_box")
    .reduce((total, item) => total + Math.max(0, item.quantity), 0);
}

export function canAffordGiftBox(walletGold: string | null, priceGold: string): boolean {
  try {
    return walletGold !== null && BigInt(walletGold) >= BigInt(priceGold);
  } catch {
    return false;
  }
}

/** Null means the gift can be sent; otherwise a player-ready reason ("" when the gift is simply empty, which needs no explanation). */
export function giftSendBlockedReason(
  status: PlayerGiftStatus | null,
  boxesCarried: number,
  lineCount: number
): string | null {
  if (!status) return "Checking your gift allowance...";
  if (!status.levelOk) return `Reach level ${status.minSenderLevel} to send gifts.`;
  if (!status.settledOk) return "Your account is not settled yet, so gifting is locked.";
  if (status.sentToday >= status.maxSentPerDay) return "You have reached today's gift limit.";
  if (boxesCarried < 1) return "You need a Gift Box to send a gift.";
  if (lineCount < 1) return "";
  if (lineCount > status.maxLines) return `A gift holds at most ${status.maxLines} items.`;
  return null;
}

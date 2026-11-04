import { z } from "zod";

import { INVENTORY_CATALOG } from "./inventoryCatalog.js";
import { PLAYER_PACKAGE_LIMITS } from "./playerPackages.js";

/** Player gifting: one Gift Box (bought for Gold) wraps up to 8 lines for another player. */
export const GIFT_BOX_ITEM_ID = "gift_box" as const;
export const GIFT_BOX_PRICE_GOLD = 250;
export const GIFT_BOX_MAX_PURCHASE_QUANTITY = 5;
/** Unopened and partially opened gifts both hold one of the recipient's slots. */
export const GIFT_MAX_HELD = 5;
/** Fungible lines plus equipment instances. */
export const GIFT_MAX_LINES = 8;
export const GIFT_MAX_SENT_PER_DAY = 10;
export const GIFT_MAX_PER_PAIR_PER_DAY = 3;
export const GIFT_MIN_SENDER_LEVEL = 5;
export const GIFT_MAX_MESSAGE_LENGTH = PLAYER_PACKAGE_LIMITS.maximumMessageLength;

export const PLAYER_GIFT_ERROR_CODES = [
  "PLAYER_GIFT_INVALID",
  "PLAYER_GIFT_EMPTY",
  "PLAYER_GIFT_TOO_MANY_LINES",
  "PLAYER_GIFT_SELF",
  "PLAYER_GIFT_RECIPIENT_NOT_FOUND",
  "PLAYER_GIFT_SAME_ACCOUNT",
  "PLAYER_GIFT_BLOCKED",
  "PLAYER_GIFT_SENDER_UNSETTLED",
  "PLAYER_GIFT_SENDER_LEVEL",
  "PLAYER_GIFT_DAILY_LIMIT",
  "PLAYER_GIFT_PAIR_LIMIT",
  "PLAYER_GIFT_RECIPIENT_FULL",
  "PLAYER_GIFT_ITEM_NOT_GIFTABLE",
  "PLAYER_GIFT_ITEMS_UNAVAILABLE",
  "PLAYER_GIFT_NO_GIFT_BOX",
  "PLAYER_GIFT_EQUIPMENT_NOT_ELIGIBLE",
  "PLAYER_GIFT_IDEMPOTENCY_CONFLICT",
  "PLAYER_GIFT_FAILED",
  "GIFT_BOX_INVALID_QUANTITY",
  "GIFT_BOX_INSUFFICIENT_GOLD",
  "GIFT_BOX_OVER_WEIGHT",
  "GIFT_BOX_IDEMPOTENCY_CONFLICT",
  "GIFT_BOX_PURCHASE_FAILED"
] as const;
export type PlayerGiftErrorCode = (typeof PLAYER_GIFT_ERROR_CODES)[number];

/**
 * Fungible items a player may put in a gift: tradable, droppable inventory
 * resources/consumables. Lumen is allowed (it is a material); Gold, City Coins
 * and Glimmer are never items here. Gift Boxes and durable rods are excluded.
 */
export function isGiftableItem(itemId: string): boolean {
  const item = INVENTORY_CATALOG[itemId];
  if (!item || item.itemId !== itemId) return false;
  if (item.kind !== "resource" && item.kind !== "consumable") return false;
  if (itemId === GIFT_BOX_ITEM_ID || itemId === "fishing_rod") return false;
  return item.marketTradable && item.droppable;
}

const giftItemLineSchema = z.object({
  itemKind: z.enum(["resource", "consumable"]),
  itemId: z.string().min(1).max(120),
  variant: z.string().min(1).max(80).nullable().optional(),
  quantity: z.number().int().positive().max(PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine)
}).strict();
export type PlayerGiftItemLineInput = z.infer<typeof giftItemLineSchema>;

export const buyGiftBoxMessageSchema = z.object({
  type: z.literal("BUY_GIFT_BOX"),
  requestId: z.string().uuid(),
  quantity: z.number().int().min(1).max(GIFT_BOX_MAX_PURCHASE_QUANTITY)
}).strict();

export const sendPlayerGiftMessageSchema = z.object({
  type: z.literal("SEND_PLAYER_GIFT"),
  requestId: z.string().uuid(),
  recipientPlayerId: z.string().min(1).max(160),
  message: z.string().trim().max(GIFT_MAX_MESSAGE_LENGTH).optional(),
  items: z.array(giftItemLineSchema).max(GIFT_MAX_LINES),
  equipmentInstanceIds: z.array(z.string().uuid()).max(GIFT_MAX_LINES)
}).strict();
export type SendPlayerGiftInput = Omit<z.infer<typeof sendPlayerGiftMessageSchema>, "type">;

export const requestGiftStatusMessageSchema = z.object({
  type: z.literal("REQUEST_GIFT_STATUS"),
  requestId: z.string().uuid()
}).strict();

export type PlayerGiftStatus = Readonly<{
  giftBoxPriceGold: string;
  giftBoxesOwned: number;
  sentToday: number;
  maxSentPerDay: number;
  maxPerRecipientPerDay: number;
  minSenderLevel: number;
  senderLevel: number;
  levelOk: boolean;
  settledOk: boolean;
  heldCount: number;
  maxHeld: number;
  maxLines: number;
}>;

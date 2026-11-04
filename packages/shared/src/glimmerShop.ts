import { z } from "zod";

import type { PlayerInventorySnapshot } from "./collectibles.js";
import type { EquipmentSnapshotV2 } from "./equipment.js";
import type { PremiumWalletSnapshot } from "./premiumCurrency.js";

/**
 * Glimmer Shop (docs/design/GLIMMER_SHOP.md): the one store for everything bought with Glimmer.
 * The catalog lives in `glimmer_shop_catalog` (1200) and is admin-editable without a deploy; the
 * server re-reads prices on every purchase.
 */
export const GLIMMER_SHOP_KINDS = ["weapon", "armour", "mask", "manor_skin"] as const;
export type GlimmerShopKind = (typeof GLIMMER_SHOP_KINDS)[number];

/** Weapons/armour only: `craft` = craftable and not sold, `shop` = sold and not craftable. Nothing craftable is ever sold. */
export const GLIMMER_SHOP_SOURCES = ["craft", "shop"] as const;
export type GlimmerShopSource = (typeof GLIMMER_SHOP_SOURCES)[number];

export const GLIMMER_SHOP_MAX_LINES = 20;
export const GLIMMER_SHOP_MAX_QUANTITY = 99;
/** Upper bound of one catalog price (matches the 1200 CHECK). */
export const GLIMMER_SHOP_MAX_PRICE = 10_000_000;

export const GLIMMER_SHOP_SKU_PATTERN = /^[a-z0-9]+([-_.][a-z0-9]+)*$/;

export type GlimmerShopCatalogItem = Readonly<{
  sku: string;
  kind: GlimmerShopKind;
  /** What a purchase grants: an equipment definition id (weapon/armour) or an inventory item id. */
  grantItemId: string;
  /** Inventory variant (mask appearance id, manor type id); "default" for equipment. */
  grantVariant: string;
  displayName: string;
  priceGlimmer: number;
  /** Weapons/armour only; null for masks and manor skins. */
  source: GlimmerShopSource | null;
  featured: boolean;
  onSale: boolean;
  isNew: boolean;
  sortOrder: number;
  /** When the row was added to the shop (ISO time); the Featured tab shows the newest. */
  addedAt: string;
}>;

export type GlimmerShopCatalogSnapshot = Readonly<{
  /** Items on sale, in display order. */
  items: readonly GlimmerShopCatalogItem[];
  /** Equipment definitions whose Smithing recipe is hidden and refused (source = 'shop'). */
  shopOnlyDefinitionIds: readonly string[];
}>;

export type GlimmerShopPurchaseLine = Readonly<{
  sku: string;
  quantity: number;
  priceGlimmer: number;
}>;

export type GlimmerShopPurchaseResult = Readonly<{
  requestId: string;
  replayed: boolean;
  totalGlimmer: number;
  lines: readonly GlimmerShopPurchaseLine[];
  message: string;
  inventory: PlayerInventorySnapshot;
  equipment: EquipmentSnapshotV2;
  premiumWallet: PremiumWalletSnapshot;
}>;

export const GLIMMER_SHOP_ERROR_CODES = [
  "SHOP_INVALID_REQUEST",
  "SHOP_ITEM_UNAVAILABLE",
  "SHOP_PRICE_CHANGED",
  "SHOP_INSUFFICIENT_GLIMMER",
  "SHOP_INVENTORY_FULL",
  "SHOP_IDEMPOTENCY_CONFLICT",
  "SHOP_UNAVAILABLE",
  "SHOP_FAILED"
] as const;
export type GlimmerShopErrorCode = (typeof GLIMMER_SHOP_ERROR_CODES)[number];

const shopLineSchema = z.object({
  sku: z.string().min(1).max(80).regex(GLIMMER_SHOP_SKU_PATTERN),
  quantity: z.number().int().min(1).max(GLIMMER_SHOP_MAX_QUANTITY)
}).strict();

/** One request for a single item or a whole cart; all lines are bought or none. */
export const buyShopItemsMessageSchema = z.object({
  type: z.literal("BUY_SHOP_ITEMS"),
  requestId: z.string().uuid(),
  lines: z.array(shopLineSchema).min(1).max(GLIMMER_SHOP_MAX_LINES),
  expectedTotalGlimmer: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict();
export type BuyShopItemsInput = Omit<z.infer<typeof buyShopItemsMessageSchema>, "type">;

export const requestShopCatalogMessageSchema = z.object({
  type: z.literal("REQUEST_SHOP_CATALOG"),
  requestId: z.string().uuid()
}).strict();

/** Admin edit of one catalog row (Developer App -> Shop catalog). Omitted fields stay. */
export const glimmerShopCatalogEditSchema = z.object({
  operationKey: z.string().uuid(),
  priceGlimmer: z.number().int().min(1).max(GLIMMER_SHOP_MAX_PRICE).optional(),
  source: z.enum(GLIMMER_SHOP_SOURCES).optional(),
  featured: z.boolean().optional(),
  onSale: z.boolean().optional(),
  isNew: z.boolean().optional(),
  sortOrder: z.number().int().min(-100_000).max(100_000).optional()
}).strict();
export type GlimmerShopCatalogEdit = z.infer<typeof glimmerShopCatalogEditSchema>;

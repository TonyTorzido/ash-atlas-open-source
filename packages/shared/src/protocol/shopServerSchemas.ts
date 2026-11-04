import { z } from "zod";

import {
  GLIMMER_SHOP_KINDS,
  GLIMMER_SHOP_MAX_PRICE,
  GLIMMER_SHOP_SOURCES
} from "../glimmerShop.js";
import { premiumWalletSnapshotSchema } from "../premiumCurrency.js";
import { equipmentSnapshotSchema } from "./combatEquipmentServerSchemas.js";
import {
  inventoryServerSchema,
  optionalRequestIdSchema,
  requestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";
import type { ShopServerMessage } from "./shopMessages.js";

const price = z.number().int().positive().max(GLIMMER_SHOP_MAX_PRICE);

const catalogItem = z.object({
  sku: wireStringSchema,
  kind: z.enum(GLIMMER_SHOP_KINDS),
  grantItemId: wireStringSchema,
  grantVariant: wireStringSchema,
  displayName: wireStringSchema,
  priceGlimmer: price,
  source: z.enum(GLIMMER_SHOP_SOURCES).nullable(),
  featured: wireBooleanSchema,
  onSale: wireBooleanSchema,
  isNew: wireBooleanSchema,
  sortOrder: z.number().int(),
  addedAt: z.string().min(1).max(40)
}).strict();

const purchaseLine = z.object({
  sku: wireStringSchema,
  quantity: z.number().int().positive(),
  priceGlimmer: price
}).strict();

export const shopServerMessageSchemas = {
  SHOP_CATALOG: serverFrame("SHOP_CATALOG", {
    requestId: optionalRequestIdSchema,
    items: z.array(catalogItem),
    shopOnlyDefinitionIds: z.array(wireStringSchema)
  }),
  SHOP_PURCHASE_RESULT: serverFrame("SHOP_PURCHASE_RESULT", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    totalGlimmer: z.number().int().positive(),
    lines: z.array(purchaseLine),
    message: wireStringSchema,
    inventory: inventoryServerSchema,
    equipment: equipmentSnapshotSchema,
    premiumWallet: premiumWalletSnapshotSchema
  }),
  SHOP_ERROR: serverFrame("SHOP_ERROR", {
    requestId: requestIdSchema,
    code: wireStringSchema,
    message: wireStringSchema
  })
} satisfies Record<ShopServerMessage["type"], z.ZodTypeAny>;

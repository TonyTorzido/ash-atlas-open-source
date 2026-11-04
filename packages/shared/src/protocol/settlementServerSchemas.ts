import { z } from "zod";

import type { SettlementServerMessage } from "./settlementMessages.js";
import { premiumWalletSnapshotSchema } from "../premiumCurrency.js";
import { backpackSnapshotSchema } from "./backpackServerSchemas.js";
import { equipmentSnapshotSchema } from "./combatEquipmentServerSchemas.js";
import {
  cityAppSnapshotServerSchema,
  cityMarketDailyServerSchema,
  cityInfoServerSchema,
  cityMembershipServerSchema,
  citySnapshotServerSchema,
  flagSnapshotServerSchema,
  inventoryServerSchema,
  latLonServerSchema,
  requestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireNumberSchema,
  wireObjectArraySchema,
  wireObjectSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

const goblinMarketLineSchema = z.object({
  kind: z.enum(["resource", "equipment", "backpack"]),
  identity: z.string().min(1).max(160),
  displayName: z.string().min(1).max(200),
  quantity: z.number().int().positive(),
  offerGold: z.string().regex(/^[1-9]\d*$/)
}).strict();

const goblinMarketBuyLineSchema = z.object({
  kind: z.literal("resource"),
  itemId: z.literal("wheat_seed"),
  identity: z.literal("wheat_seed"),
  displayName: z.string().min(1).max(200),
  quantity: z.number().int().positive(),
  unitPriceGold: z.string().regex(/^[1-9]\d*$/)
}).strict();

const goblinMarketSnapshotSchema = z.object({
  cityId: z.string().uuid(),
  cityName: z.string().min(1).max(200),
  marketStructureId: z.string().uuid(),
  relation: z.enum(["neutral", "enemy"]),
  lines: z.array(goblinMarketLineSchema).max(1_000),
  buyLines: z.array(goblinMarketBuyLineSchema).max(100)
}).strict();

const hollinShopSnapshotSchema = z.object({
  hutId: z.string().min(1).max(80),
  stockRefreshesAt: z.string(),
  heal: z.object({
    costGold: z.string(),
    currentHealth: z.number(),
    maxHealth: z.number(),
    canHeal: z.boolean()
  }).strict(),
  eggs: z.object({
    have: z.number().int().min(0),
    need: z.number().int().positive(),
    discovered: z.boolean()
  }).strict(),
  name: z.string().min(1).max(120),
  rank: z.number().int().min(0).max(3),
  discountPercent: z.number().int().min(0).max(100),
  tradeBannedUntil: z.string().nullable(),
  banReason: z.enum(["orchard", "raid"]).nullable(),
  canPacify: z.boolean(),
  walletGold: z.string(),
  lines: z.array(z.object({
    itemId: z.string().min(1).max(80),
    displayName: z.string().min(1).max(200),
    baseUnitPriceGold: z.string(),
    unitPriceGold: z.string(),
    maxQuantity: z.number().int().positive()
  }).strict()).max(100)
}).strict();

const wanderingMerchantShopSnapshotSchema = z.object({
  merchantId: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  dungeonName: z.string().min(1).max(200),
  expiresAt: z.string(),
  rank: z.number().int().min(0).max(8),
  discountPercent: z.number().int().min(0).max(100),
  walletGold: z.string(),
  lines: z.array(z.object({
    itemId: z.string().min(1).max(80),
    displayName: z.string().min(1).max(200),
    baseUnitPriceGold: z.string(),
    unitPriceGold: z.string(),
    remaining: z.number().int().nonnegative()
  }).strict()).max(20)
}).strict();

const militarySiegeVolleyCueSchema = z.object({
  groupId: wireStringSchema,
  occurredAt: wireNumberSchema
}).strict();
const militaryBomberDetonationCueSchema = z.object({
  requestId: requestIdSchema,
  groupId: wireStringSchema,
  occurredAt: wireNumberSchema,
  position: latLonServerSchema,
  targetPosition: latLonServerSchema
}).strict();

export const settlementServerMessageSchemas = {
  MILITARY_INDUSTRY_STATE: serverFrame("MILITARY_INDUSTRY_STATE", {
    requestId: requestIdSchema,
    snapshot: wireObjectSchema,
    siegeVolleys: z.array(militarySiegeVolleyCueSchema).max(100).optional(),
    bomberDetonations: z.array(militaryBomberDetonationCueSchema).max(100).optional()
  }),
  MILITARY_INDUSTRY_CHANGED: serverFrame("MILITARY_INDUSTRY_CHANGED", {
    requestId: requestIdSchema,
    snapshot: wireObjectSchema,
    replayed: wireBooleanSchema,
    inventory: inventoryServerSchema.optional(),
    walletGold: wireStringSchema.optional(),
    walletVersion: wireStringSchema.optional(),
    damage: wireNonnegativeIntegerSchema.optional(),
    siegeVolleys: z.array(militarySiegeVolleyCueSchema).max(100).optional(),
    bomberDetonations: z.array(militaryBomberDetonationCueSchema).max(100).optional()
  }),
  GOBLIN_VILLAGE_REMOVED: serverFrame("GOBLIN_VILLAGE_REMOVED", {
    cityId: z.string().uuid(),
    structureIds: z.array(z.string().uuid())
  }),
  GOBLIN_MARKET_ERROR: serverFrame("GOBLIN_MARKET_ERROR", {
    requestId: requestIdSchema,
    code: wireStringSchema,
    message: wireStringSchema
  }),
  GOBLIN_MARKET_SNAPSHOT: serverFrame("GOBLIN_MARKET_SNAPSHOT", {
    requestId: requestIdSchema,
    snapshot: goblinMarketSnapshotSchema
  }),
  GOBLIN_MARKET_SOLD: serverFrame("GOBLIN_MARKET_SOLD", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    offerGold: wireStringSchema,
    snapshot: goblinMarketSnapshotSchema,
    inventory: inventoryServerSchema,
    equipment: equipmentSnapshotSchema,
    backpacks: backpackSnapshotSchema,
    walletGold: wireStringSchema,
    walletVersion: wireStringSchema
  }),
  GOBLIN_MARKET_PURCHASED: serverFrame("GOBLIN_MARKET_PURCHASED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    itemId: z.literal("wheat_seed"),
    quantity: z.number().int().positive(),
    totalGold: wireStringSchema,
    snapshot: goblinMarketSnapshotSchema,
    inventory: inventoryServerSchema,
    walletGold: wireStringSchema,
    walletVersion: wireStringSchema
  }),
  HOLLIN_HUT_SHOP: serverFrame("HOLLIN_HUT_SHOP", {
    requestId: requestIdSchema,
    snapshot: hollinShopSnapshotSchema
  }),
  HOLLIN_HUT_ERROR: serverFrame("HOLLIN_HUT_ERROR", {
    requestId: requestIdSchema,
    code: wireStringSchema,
    message: wireStringSchema
  }),
  HOLLIN_HUT_SERVICED: serverFrame("HOLLIN_HUT_SERVICED", {
    requestId: requestIdSchema,
    hutId: wireStringSchema,
    service: z.enum(["heal", "turn_in_eggs"]),
    message: wireStringSchema,
    snapshot: hollinShopSnapshotSchema,
    inventory: inventoryServerSchema.optional(),
    walletGold: wireStringSchema.optional(),
    walletVersion: wireStringSchema.optional()
  }),
  HOLLIN_HUT_PACIFIED: serverFrame("HOLLIN_HUT_PACIFIED", {
    requestId: requestIdSchema,
    hutId: wireStringSchema,
    message: wireStringSchema,
    snapshot: hollinShopSnapshotSchema,
    inventory: inventoryServerSchema
  }),
  HOLLIN_HUT_PURCHASED: serverFrame("HOLLIN_HUT_PURCHASED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    itemId: wireStringSchema,
    quantity: z.number().int().positive(),
    totalGold: wireStringSchema,
    snapshot: hollinShopSnapshotSchema,
    inventory: inventoryServerSchema,
    walletGold: wireStringSchema,
    walletVersion: wireStringSchema
  }),
  WANDERING_MERCHANTS: serverFrame("WANDERING_MERCHANTS", {
    merchants: z.array(z.object({
      merchantId: z.string().min(1).max(80),
      name: z.string().min(1).max(120),
      dungeonName: z.string().min(1).max(200),
      regionCode: z.string().min(1).max(80),
      lat: z.number(),
      lon: z.number(),
      expiresAt: z.string()
    }).strict()).max(50)
  }),
  WANDERING_MERCHANT_SHOP: serverFrame("WANDERING_MERCHANT_SHOP", {
    requestId: requestIdSchema,
    snapshot: wanderingMerchantShopSnapshotSchema
  }),
  WANDERING_MERCHANT_ERROR: serverFrame("WANDERING_MERCHANT_ERROR", {
    requestId: requestIdSchema,
    code: wireStringSchema,
    message: wireStringSchema
  }),
  WANDERING_MERCHANT_PURCHASED: serverFrame("WANDERING_MERCHANT_PURCHASED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    itemId: wireStringSchema,
    quantity: z.number().int().positive(),
    totalGold: wireStringSchema,
    snapshot: wanderingMerchantShopSnapshotSchema,
    inventory: inventoryServerSchema,
    walletGold: wireStringSchema,
    walletVersion: wireStringSchema
  }),
  CINDER_LANTERN_CRAFTED: serverFrame("CINDER_LANTERN_CRAFTED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    charges: z.number().int().nonnegative(),
    message: wireStringSchema,
    inventory: inventoryServerSchema
  }),
  KINGDOM_STATE: serverFrame("KINGDOM_STATE", { state: wireObjectSchema }),
  KINGDOM_STATE_CHANGED: serverFrame("KINGDOM_STATE_CHANGED", { playerId: wireStringSchema }),
  KINGDOM_SPATIAL_CHANGES: serverFrame("KINGDOM_SPATIAL_CHANGES", { changes: wireObjectArraySchema }),
  KINGDOM_CHAT_MESSAGE: serverFrame("KINGDOM_CHAT_MESSAGE", { message: wireObjectSchema }),
  CITIES_SNAPSHOT: serverFrame("CITIES_SNAPSHOT", { cities: z.array(citySnapshotServerSchema) }),
  CITY_MEMBERSHIP_SNAPSHOT: serverFrame("CITY_MEMBERSHIP_SNAPSHOT", { membership: cityMembershipServerSchema.nullable() }),
  CITY_APP: serverFrame("CITY_APP", {
    requestId: requestIdSchema,
    snapshot: cityAppSnapshotServerSchema
  }),
  CITY_STRUCTURES_SNAPSHOT: serverFrame("CITY_STRUCTURES_SNAPSHOT", { structures: wireObjectArraySchema }),
  OWNER_OIL_WELL_PROJECTION: serverFrame("OWNER_OIL_WELL_PROJECTION", { structure: wireObjectSchema.nullable() }),
  CITY_HOUSE_CHANGED: serverFrame("CITY_HOUSE_CHANGED", { requestId: requestIdSchema, structure: wireObjectSchema, membership: cityMembershipServerSchema.nullable(), replayed: wireBooleanSchema }),
  CITY_FACILITY_CHANGED: serverFrame("CITY_FACILITY_CHANGED", { requestId: requestIdSchema, structure: wireObjectSchema }),
  CITY_STRUCTURE_WARFARE_CHANGED: serverFrame("CITY_STRUCTURE_WARFARE_CHANGED", {
    requestId: requestIdSchema,
    action: z.enum(["attack", "repair_started", "repair_stopped"]),
    structureId: wireStringSchema,
    damage: wireNonnegativeIntegerSchema.optional(),
    replayed: wireBooleanSchema
  }),
  LIBRARY_STATE: serverFrame("LIBRARY_STATE", {
    requestId: requestIdSchema,
    library: wireObjectSchema,
    result: wireObjectSchema.optional(),
    walletGold: wireStringSchema.optional(),
    walletVersion: wireStringSchema.optional()
  }),
  OIL_WELL_OPENED: serverFrame("OIL_WELL_OPENED", { requestId: requestIdSchema, well: wireObjectSchema }),
  OIL_WELL_HARVESTED: serverFrame("OIL_WELL_HARVESTED", { requestId: requestIdSchema, well: wireObjectSchema, inventory: wireObjectSchema, harvestedQuantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema, message: wireStringSchema }),
  CITY_WAREHOUSE_OPENED: serverFrame("CITY_WAREHOUSE_OPENED", { requestId: requestIdSchema, warehouse: wireObjectSchema }),
  CITY_WAREHOUSE_UPDATED: serverFrame("CITY_WAREHOUSE_UPDATED", { requestId: requestIdSchema, warehouse: wireObjectSchema, inventory: wireObjectSchema, replayed: wireBooleanSchema, donatedQuantity: wireNonnegativeIntegerSchema }),
  CITY_GOLD_DONATED: serverFrame("CITY_GOLD_DONATED", {
    requestId: requestIdSchema,
    warehouse: wireObjectSchema,
    walletGold: wireStringSchema,
    walletVersion: wireStringSchema,
    replayed: wireBooleanSchema,
    donatedGold: wireStringSchema
  }),
  CITY_MARKET_DAILY_PURCHASED: serverFrame("CITY_MARKET_DAILY_PURCHASED", {
    requestId: requestIdSchema,
    cityId: wireStringSchema,
    marketDaily: cityMarketDailyServerSchema,
    treasuryBalance: wireStringSchema,
    premiumWallet: premiumWalletSnapshotSchema,
    replayed: wireBooleanSchema
  }),
  CITY_FOUNDING_PREVIEW: serverFrame("CITY_FOUNDING_PREVIEW", { requestId: requestIdSchema, preview: wireObjectSchema }),
  CITY_INFO: serverFrame("CITY_INFO", { requestId: requestIdSchema, info: cityInfoServerSchema }),
  CITY_FOUNDED: serverFrame("CITY_FOUNDED", { requestId: requestIdSchema, city: citySnapshotServerSchema, seatFlag: flagSnapshotServerSchema, territoryFlags: z.array(flagSnapshotServerSchema).length(6), replayed: wireBooleanSchema, materialCost: z.literal(0) }),
  CITY_CONSTRUCTION_ADVANCED: serverFrame("CITY_CONSTRUCTION_ADVANCED", {
    requestId: requestIdSchema,
    action: z.enum(["build_foundation", "build_frames", "finish"]),
    city: citySnapshotServerSchema,
    replayed: wireBooleanSchema,
    inventory: wireObjectSchema.optional(),
    walletGold: wireStringSchema.optional(),
    walletVersion: wireStringSchema.optional()
  }),
  CITY_TERRITORY_SYNC: serverFrame("CITY_TERRITORY_SYNC", { cityId: wireStringSchema, flags: z.array(flagSnapshotServerSchema).length(6) }),
  CITY_JOINED: serverFrame("CITY_JOINED", { requestId: requestIdSchema, info: cityInfoServerSchema, membership: cityMembershipServerSchema, replayed: wireBooleanSchema }),
  CITY_LEFT: serverFrame("CITY_LEFT", { requestId: requestIdSchema, info: cityInfoServerSchema, cityId: wireStringSchema, replayed: wireBooleanSchema }),
  CITY_MEMBERSHIP_UPDATED: serverFrame("CITY_MEMBERSHIP_UPDATED", {
    cityId: wireStringSchema,
    playerId: wireStringSchema,
    memberCount: wireNonnegativeIntegerSchema,
    expansionFlagCount: wireNonnegativeIntegerSchema,
    expansionFlagLimit: wireNonnegativeIntegerSchema,
    action: z.enum(["joined", "left", "flag_converted"])
  }),
  CITY_MAYOR_UPDATED: serverFrame("CITY_MAYOR_UPDATED", { requestId: requestIdSchema, city: citySnapshotServerSchema, actorPlayerId: wireStringSchema, action: z.enum(["claimed", "relinquished"]), replayed: wireBooleanSchema }),
  CITY_FLAG_CONVERSION_STARTED: serverFrame("CITY_FLAG_CONVERSION_STARTED", {
    conversionId: requestIdSchema,
    requestId: requestIdSchema,
    flagId: wireStringSchema,
    flagName: wireStringSchema,
    cityId: wireStringSchema,
    cityName: wireStringSchema,
    position: latLonServerSchema,
    startedAt: wireNumberSchema,
    completesAt: wireNumberSchema,
    durationMs: wireNumberSchema.positive(),
    serverTime: wireNumberSchema
  }),
  CITY_FLAG_CONVERTED: serverFrame("CITY_FLAG_CONVERTED", {
    conversionId: requestIdSchema,
    requestId: requestIdSchema,
    flag: flagSnapshotServerSchema,
    expansionFlagCount: wireNonnegativeIntegerSchema,
    expansionFlagLimit: wireNonnegativeIntegerSchema,
    replayed: wireBooleanSchema
  }),
} satisfies Record<SettlementServerMessage["type"], z.ZodTypeAny>;

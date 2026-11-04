import { z } from "zod";

import { RESOURCE_TYPES } from "../collectibles.js";
import { FIELD_CONSUMABLE_ITEM_IDS } from "../fieldConsumables.js";
import { WATER_SITE_KINDS } from "../tidecraft.js";
import { HARVEST_ACCESS_MODES, HARVEST_TOLL_TYPES } from "../harvestAccess.js";
import { equipmentSnapshotSchema } from "./combatEquipmentServerSchemas.js";
import { backpackSnapshotSchema } from "./backpackServerSchemas.js";
import type { HarvestingServerMessage } from "./harvestingMessages.js";
import {
  collectibleNodeServerSchema,
  harvestSessionServerSchema,
  inventoryServerSchema,
  optionalRequestIdSchema,
  repeatableNodeServerSchema,
  requestIdSchema,
  resourceVisionServerSchema,
  resourceVisionStatusServerSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireNumberSchema,
  wireObjectArraySchema,
  wireObjectSchema,
  wireStringSchema,
  worldViewAuthorityServerSchema
} from "./serverSchemaPrimitives.js";

const fieldBuffServerSchema = z.object({
  buffId: z.enum(["anti_venom", "inspiration", "tidewater", "vigor_serum", "battle_draught"]),
  startedAt: wireNumberSchema,
  endsAt: wireNumberSchema.nullable()
}).strict();

const waterSitePointSchema = { lat: wireNumberSchema, lon: wireNumberSchema };
const waterSiteServerSchema = z.object({
  siteId: wireStringSchema,
  kind: z.enum(WATER_SITE_KINDS),
  ...waterSitePointSchema,
  destination: z.object({ ...waterSitePointSchema, distanceM: wireNumberSchema }).strict().optional(),
  diveReadyAt: wireNumberSchema.optional()
}).strict();

const inventoryProtectionSchema = z.object({
  playerId: wireStringSchema,
  revision: wireNonnegativeIntegerSchema,
  materialPolicies: z.array(z.object({
    itemId: wireStringSchema,
    variant: wireStringSchema.nullable(),
    keepQuantity: wireNonnegativeIntegerSchema,
    currentTotal: wireNonnegativeIntegerSchema
  }).strict()),
  uniqueItems: z.array(z.object({
    equipmentInstanceId: z.string().uuid(),
    protected: wireBooleanSchema,
    systemReason: wireStringSchema.nullable()
  }).strict()),
  stackAllocations: z.array(z.object({
    stackId: z.string().uuid(),
    itemId: wireStringSchema,
    variant: wireStringSchema.nullable(),
    protectedQuantity: wireNonnegativeIntegerSchema,
    movableQuantity: wireNonnegativeIntegerSchema,
    status: z.enum(["none", "partial", "protected", "system"]),
    reason: wireStringSchema.nullable()
  }).strict())
}).strict();

const collectibleSnapshotAuthoritySchema = z.object({
  snapshotId: wireStringSchema,
  snapshotGeneration: wireNonnegativeIntegerSchema,
  gameplayViewGeneration: wireNonnegativeIntegerSchema,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("flag"), id: wireStringSchema }).strict(),
    z.object({ kind: z.literal("kingdom-seat"), id: wireStringSchema }).strict(),
    z.object({ kind: z.literal("open-area"), id: wireStringSchema }).strict(),
    z.object({ kind: z.literal("player-anchor"), id: wireStringSchema }).strict()
  ]),
  includedDomains: z.array(z.enum([
    "population",
    "repeatable-resource",
    "resource-vision"
  ])),
  completeness: z.enum(["complete", "partial", "loading", "failed"]),
  ordinaryNodesTruncated: wireBooleanSchema,
  returnedCount: wireNonnegativeIntegerSchema,
  authoritativeTotalCount: wireNonnegativeIntegerSchema.nullable()
}).strict();

export const harvestingServerMessageSchemas = {
  COLLECTIBLES_SNAPSHOT: serverFrame("COLLECTIBLES_SNAPSHOT", { playerId: wireStringSchema, relocationRevision: wireNonnegativeIntegerSchema, resourceVisionRevision: wireNonnegativeIntegerSchema, authority: collectibleSnapshotAuthoritySchema, worldViewAuthority: worldViewAuthorityServerSchema.optional(), serverTime: wireNumberSchema, visibleRadiusM: wireNumberSchema, activationRadiusM: wireNumberSchema, resourceVision: resourceVisionServerSchema.nullable(), resourceVisionStatus: resourceVisionStatusServerSchema.nullable().optional(), waterHighlights: wireObjectArraySchema, nodes: z.array(collectibleNodeServerSchema), repeatableNodes: z.array(repeatableNodeServerSchema) }),
  RESOURCE_VISION_LOADING: serverFrame("RESOURCE_VISION_LOADING", { serverTime: wireNumberSchema, resourceVision: resourceVisionServerSchema, status: resourceVisionStatusServerSchema.nullable(), message: wireStringSchema }),
  RESOURCE_VISION_READY: serverFrame("RESOURCE_VISION_READY", { serverTime: wireNumberSchema, resourceVision: resourceVisionServerSchema, status: resourceVisionStatusServerSchema }),
  HARVEST_STARTED: serverFrame("HARVEST_STARTED", { requestId: requestIdSchema, session: harvestSessionServerSchema, serverTime: wireNumberSchema }),
  HARVEST_COMPLETED: serverFrame("HARVEST_COMPLETED", { requestId: requestIdSchema, session: harvestSessionServerSchema, nodeId: wireStringSchema, playerId: wireStringSchema, inventory: inventoryServerSchema, node: collectibleNodeServerSchema.optional(), nodeRemoved: wireBooleanSchema.optional(), replayed: wireBooleanSchema, professionResults: wireObjectSchema.optional(), serverTime: wireNumberSchema }),
  HARVEST_CANCELLED: serverFrame("HARVEST_CANCELLED", { requestId: requestIdSchema, session: harvestSessionServerSchema, serverTime: wireNumberSchema }),
  REPEATABLE_RESOURCE_HARVESTED: serverFrame("REPEATABLE_RESOURCE_HARVESTED", { requestId: requestIdSchema, node: repeatableNodeServerSchema, playerId: wireStringSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, professionResults: wireObjectSchema.optional(), serverTime: wireNumberSchema }),
  REPEATABLE_RESOURCE_UPDATED: serverFrame("REPEATABLE_RESOURCE_UPDATED", { node: repeatableNodeServerSchema, serverTime: wireNumberSchema }),
  MINE_CLAIMED: serverFrame("MINE_CLAIMED", { requestId: requestIdSchema, node: repeatableNodeServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, message: wireStringSchema, serverTime: wireNumberSchema }),
  HARVEST_ACCESS_CHANGED: serverFrame("HARVEST_ACCESS_CHANGED", {
    ownerPlayerId: wireStringSchema,
    harvestType: z.enum(HARVEST_TOLL_TYPES),
    assetId: wireStringSchema.nullable(),
    accessMode: z.enum(HARVEST_ACCESS_MODES).nullable(),
    accessRevision: wireStringSchema.nullable(),
    tollGold: wireStringSchema,
    serverTime: wireNumberSchema
  }),
  RESOURCE_GAINED: serverFrame("RESOURCE_GAINED", { playerId: wireStringSchema, gain: z.object({ eventId: wireStringSchema, itemId: z.enum(RESOURCE_TYPES), quantity: wireNonnegativeIntegerSchema }).passthrough(), serverTime: wireNumberSchema }),
  COLLECTIBLE_REMOVED: serverFrame("COLLECTIBLE_REMOVED", { nodeId: wireStringSchema, playerId: wireStringSchema, stateRevision: wireNonnegativeIntegerSchema.optional(), serverTime: wireNumberSchema }),
  COLLECTIBLE_UPDATED: serverFrame("COLLECTIBLE_UPDATED", { node: collectibleNodeServerSchema, playerId: wireStringSchema, serverTime: wireNumberSchema }),
  COLLECTIBLE_PICKED_UP: serverFrame("COLLECTIBLE_PICKED_UP", { requestId: optionalRequestIdSchema, nodeId: wireStringSchema, playerId: wireStringSchema, inventory: inventoryServerSchema, serverTime: wireNumberSchema }),
  PLAYER_RESOURCES_UPDATED: serverFrame("PLAYER_RESOURCES_UPDATED", { playerId: wireStringSchema, inventory: inventoryServerSchema, walletGold: wireStringSchema.optional(), walletVersion: wireStringSchema.optional(), serverTime: wireNumberSchema }),
  WATER_COLLECTED: serverFrame("WATER_COLLECTED", { requestId: requestIdSchema, playerId: wireStringSchema, waterKind: z.enum(["fresh", "salt", "unknown"]), inventory: inventoryServerSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
  ITEM_DROP_RESULT: serverFrame("ITEM_DROP_RESULT", { requestId: requestIdSchema, drop: wireObjectSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
  EQUIPMENT_DROP_RESULT: serverFrame("EQUIPMENT_DROP_RESULT", { requestId: requestIdSchema, drop: wireObjectSchema, equipment: equipmentSnapshotSchema, replayed: wireBooleanSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
  INVENTORY_STACK_UPDATED: serverFrame("INVENTORY_STACK_UPDATED", { requestId: requestIdSchema, action: z.enum(["split", "restack", "move", "reorganize"]), inventory: inventoryServerSchema, equipment: equipmentSnapshotSchema.optional(), serverTime: wireNumberSchema, message: wireStringSchema, walletGold: wireStringSchema.optional(), walletVersion: wireStringSchema.optional() }),
  INVENTORY_PROTECTION_SNAPSHOT: serverFrame("INVENTORY_PROTECTION_SNAPSHOT", { protection: inventoryProtectionSchema }),
  INVENTORY_PROTECTION_UPDATED: serverFrame("INVENTORY_PROTECTION_UPDATED", { requestId: requestIdSchema, protection: inventoryProtectionSchema, replayed: wireBooleanSchema, message: wireStringSchema }),
  DROPPED_ITEM_PICKUP_RESULT: serverFrame("DROPPED_ITEM_PICKUP_RESULT", { requestId: requestIdSchema, itemId: z.enum(RESOURCE_TYPES), requestedQuantity: wireNonnegativeIntegerSchema, drop: wireObjectSchema, pickedUpQuantity: wireNonnegativeIntegerSchema, remainingQuantity: wireNonnegativeIntegerSchema, removed: wireBooleanSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
  DROPPED_EQUIPMENT_PICKUP_RESULT: serverFrame("DROPPED_EQUIPMENT_PICKUP_RESULT", { requestId: requestIdSchema, itemId: wireStringSchema, drop: wireObjectSchema, equipment: equipmentSnapshotSchema, replayed: wireBooleanSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
  DROPPED_BACKPACK_PICKUP_RESULT: serverFrame("DROPPED_BACKPACK_PICKUP_RESULT", { requestId: requestIdSchema, itemId: wireStringSchema, drop: wireObjectSchema, backpacks: backpackSnapshotSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
  DROPPED_ITEMS_SNAPSHOT: serverFrame("DROPPED_ITEMS_SNAPSHOT", { drops: wireObjectArraySchema, serverTime: wireNumberSchema }),
  CONSUMABLE_USED: serverFrame("CONSUMABLE_USED", { requestId: requestIdSchema, itemId: z.literal("giving_berry"), playerId: wireStringSchema, inventory: inventoryServerSchema, effect: z.object({ effectId: wireStringSchema, playerId: wireStringSchema, startedAt: wireStringSchema, endsAt: wireStringSchema, resinConsumed: wireBooleanSchema, huntingDistrictPreserved: wireBooleanSchema }).strict(), replayed: wireBooleanSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
  SIMPLE_FOOD_CONSUMED: serverFrame("SIMPLE_FOOD_CONSUMED", { requestId: requestIdSchema, itemId: z.literal("simple_food"), playerId: wireStringSchema, inventory: inventoryServerSchema, hunger: z.object({ current: wireNonnegativeIntegerSchema, baseCapacity: wireNonnegativeIntegerSchema }).strict(), restoredQuantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
  FIELD_CONSUMABLE_USED: serverFrame("FIELD_CONSUMABLE_USED", { requestId: requestIdSchema, itemId: z.enum(FIELD_CONSUMABLE_ITEM_IDS), playerId: wireStringSchema, inventory: inventoryServerSchema, buffs: z.array(fieldBuffServerSchema), replayed: wireBooleanSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
  FIELD_CONSUMABLE_CRAFTED: serverFrame("FIELD_CONSUMABLE_CRAFTED", { requestId: requestIdSchema, itemId: z.enum(FIELD_CONSUMABLE_ITEM_IDS), quantity: wireNonnegativeIntegerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, message: wireStringSchema }),
  FIELD_BUFFS: serverFrame("FIELD_BUFFS", { buffs: z.array(fieldBuffServerSchema), serverTime: wireNumberSchema }),
  WATER_SITES: serverFrame("WATER_SITES", { requestId: optionalRequestIdSchema, sites: z.array(waterSiteServerSchema), tidecraftRank: wireNonnegativeIntegerSchema, tidecraftDiscovered: wireBooleanSchema, serverTime: wireNumberSchema }),
  PEARL_DIVE_RESULT: serverFrame("PEARL_DIVE_RESULT", { requestId: requestIdSchema, siteId: wireStringSchema, pearls: wireNonnegativeIntegerSchema, diveReadyAt: wireNumberSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, serverTime: wireNumberSchema, message: wireStringSchema }),
} satisfies Record<HarvestingServerMessage["type"], z.ZodTypeAny>;

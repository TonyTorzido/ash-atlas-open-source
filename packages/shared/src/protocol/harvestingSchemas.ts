import { z } from "zod";

import { GREENHOUSE_ITEM_TYPES, RESOURCE_TYPES } from "../collectibles.js";
import { FIELD_CONSUMABLE_ITEM_IDS } from "../fieldConsumables.js";

const requestIdSchema = z.string().min(1).max(128);
const MATERIAL_PROTECTION_ITEM_TYPES = [...RESOURCE_TYPES, ...GREENHOUSE_ITEM_TYPES] as const;

export const requestNearbyCollectiblesMessageSchema = z.object({
  type: z.literal("REQUEST_NEARBY_COLLECTIBLES"),
  requestId: requestIdSchema
});

export const surveyAreaMessageSchema = z.object({
  type: z.literal("SURVEY_AREA"),
  requestId: requestIdSchema
});

export const startHarvestMessageSchema = z.object({
  type: z.literal("START_HARVEST"),
  requestId: requestIdSchema,
  nodeId: z.string().min(1).max(160),
  action: z.enum(["primary", "resin"]).optional(),
  expectedPresentationOwner: z.enum([
    "population",
    "repeatable-resource",
    "resource-vision"
  ]),
  expectedEntityRevision: z.number().int().nonnegative().safe(),
  expectedRelocationRevision: z.number().int().nonnegative().safe(),
  expectedResourceVisionRevision: z.number().int().nonnegative().safe(),
  expectedGameplayViewGeneration: z.number().int().nonnegative().safe()
}).strict();

export const claimMineMessageSchema = z.object({
  type: z.literal("CLAIM_MINE"),
  requestId: requestIdSchema,
  nodeId: z.string().uuid(),
  expectedAuthorityRevision: z.number().int().nonnegative().safe()
}).strict();

export const useConsumableMessageSchema = z.object({
  type: z.literal("USE_CONSUMABLE"),
  requestId: requestIdSchema,
  itemId: z.enum(["giving_berry", "simple_food", ...FIELD_CONSUMABLE_ITEM_IDS]),
  stackId: z.string().uuid().optional(),
  /** Net only: the monster to hold. */
  targetEntityId: z.string().min(1).max(128).optional()
}).strict();

export const craftFieldConsumableMessageSchema = z.object({
  type: z.literal("CRAFT_FIELD_CONSUMABLE"),
  requestId: requestIdSchema,
  itemId: z.enum(FIELD_CONSUMABLE_ITEM_IDS)
}).strict();

/** Water sites (Pearl Beds, whirlpools, Drowned City sites) near the player. */
export const requestWaterSitesMessageSchema = z.object({
  type: z.literal("REQUEST_WATER_SITES"),
  requestId: requestIdSchema
}).strict();

const waterSiteIdSchema = z.string().min(1).max(200);

export const divePearlBedMessageSchema = z.object({
  type: z.literal("DIVE_PEARL_BED"),
  requestId: requestIdSchema,
  siteId: waterSiteIdSchema
}).strict();

export const enterWhirlpoolMessageSchema = z.object({
  type: z.literal("ENTER_WHIRLPOOL"),
  requestId: requestIdSchema,
  siteId: waterSiteIdSchema
}).strict();

export const presentAbyssalOrbsMessageSchema = z.object({
  type: z.literal("PRESENT_ABYSSAL_ORBS"),
  requestId: requestIdSchema,
  siteId: waterSiteIdSchema
}).strict();

export const completeHarvestMessageSchema = z.object({
  type: z.literal("COMPLETE_HARVEST"),
  requestId: requestIdSchema,
  sessionId: z.string().uuid()
}).strict();

export const cancelHarvestMessageSchema = z.object({
  type: z.literal("CANCEL_HARVEST"),
  requestId: requestIdSchema,
  sessionId: z.string().uuid()
}).strict();

export const dropItemMessageSchema = z.object({
  type: z.literal("DROP_ITEM"),
  requestId: requestIdSchema,
  itemId: z.enum(RESOURCE_TYPES),
  variant: z.string().trim().min(1).max(80).nullable(),
  quantity: z.number().int().positive(),
  stackId: z.string().uuid().optional(),
  manorSessionId: z.string().uuid().optional()
}).strict();

export const dropEquipmentMessageSchema = z.object({
  type: z.literal("DROP_EQUIPMENT"),
  requestId: requestIdSchema,
  equipmentInstanceId: z.string().uuid(),
  expectedEquipmentRevision: z.number().int().nonnegative().safe(),
  manorSessionId: z.string().uuid().optional()
}).strict();

export const updateMaterialKeepMessageSchema = z.object({
  type: z.literal("UPDATE_MATERIAL_KEEP"),
  requestId: requestIdSchema,
  itemId: z.enum(MATERIAL_PROTECTION_ITEM_TYPES),
  variant: z.string().trim().min(1).max(80).nullable(),
  keepQuantity: z.number().int().nonnegative().safe(),
  expectedRevision: z.number().int().nonnegative().safe()
}).strict();

export const updateUniqueItemProtectionMessageSchema = z.object({
  type: z.literal("UPDATE_UNIQUE_ITEM_PROTECTION"),
  requestId: requestIdSchema,
  equipmentInstanceId: z.string().uuid(),
  protected: z.boolean(),
  expectedRevision: z.number().int().nonnegative().safe()
}).strict();

export const splitInventoryStackMessageSchema = z.object({
  type: z.literal("SPLIT_INVENTORY_STACK"),
  requestId: requestIdSchema,
  stackId: z.string().uuid(),
  quantity: z.number().int().positive()
}).strict();

export const restackInventoryStackMessageSchema = z.object({
  type: z.literal("RESTACK_INVENTORY_STACK"),
  requestId: requestIdSchema,
  stackId: z.string().uuid()
}).strict();

export const moveInventoryStackMessageSchema = z.object({
  type: z.literal("MOVE_INVENTORY_STACK"),
  requestId: requestIdSchema,
  stackId: z.string().uuid(),
  targetSlot: z.number().int().nonnegative()
}).strict();

export const reorganizeInventoryMessageSchema = z.object({
  type: z.literal("REORGANIZE_INVENTORY"),
  requestId: requestIdSchema
}).strict();

export const pickupDroppedItemMessageSchema = z.object({
  type: z.literal("PICKUP_DROPPED_ITEM"),
  requestId: requestIdSchema,
  dropId: z.string().uuid(),
  manorSessionId: z.string().uuid().optional(),
  pickup: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }).strict(),
    z.object({
      mode: z.literal("quantity"),
      quantity: z.number().int().positive()
    }).strict()
  ])
}).strict();

export const collectWaterAtCoordinateMessageSchema = z.object({
  type: z.literal("COLLECT_WATER_AT_COORDINATE"),
  requestId: requestIdSchema,
  lat: z.number().finite(),
  lon: z.number().finite()
}).strict();

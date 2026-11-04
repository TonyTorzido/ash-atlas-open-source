import { z } from "zod";

const requestIdSchema = z.string().min(1).max(128);
const visibleFlagAuthoritySchema = z.object({
  expectedConnectionGeneration: z.number().int().nonnegative(),
  expectedGameplayViewGeneration: z.number().int().nonnegative(),
  expectedResourceVisionRevision: z.number().int().nonnegative(),
  expectedFlagSetRevision: z.number().int().nonnegative()
});

export const visibleFlagDestinationAuthoritySchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  claimRadiusM: z.number().finite().nonnegative(),
  resourceVisionRadiusM: z.number().finite().positive().optional(),
  personalFlagId: z.string().uuid().optional()
}).strict();

export type VisibleFlagDestinationAuthority = z.infer<
  typeof visibleFlagDestinationAuthoritySchema
>;

export const placeFlagMessageSchema = z.object({
  type: z.literal("PLACE_FLAG"),
  requestId: requestIdSchema,
  anchorKind: z.enum(["flag", "buoy"]).optional(),
  name: z.string().min(1).max(64).optional(),
  quoteId: z.string().uuid().optional()
}).strict();

export const cancelFlagBuildMessageSchema = z.object({
  type: z.literal("CANCEL_FLAG_BUILD"),
  requestId: requestIdSchema,
  buildId: z.string().uuid()
}).strict();

export const reinforceFlagMessageSchema = z.object({
  type: z.literal("REINFORCE_FLAG"),
  requestId: requestIdSchema,
  flagId: z.string().uuid(),
  targetTier: z.enum(["stone", "tower", "tower_level", "city_tower", "kingdom_tower", "obelisk"]).optional().default("stone"),
  /**
   * The level being built: required for "tower_level" (Guard Tower 2..25),
   * "kingdom_tower" and "obelisk" (1..5, where 1 builds it on a Kingdom Flag).
   */
  targetTowerLevel: z.number().int().min(1).max(25).optional()
}).strict();

export const startFlagBurnMessageSchema = z.object({
  type: z.literal("START_FLAG_BURN"),
  requestId: requestIdSchema,
  flagId: z.string().uuid()
}).strict();

export const attackFlagMessageSchema = z.object({
  type: z.literal("ATTACK_FLAG"),
  requestId: requestIdSchema,
  flagId: z.string().uuid()
}).strict();

export const startFlagRepairMessageSchema = z.object({
  type: z.literal("START_FLAG_REPAIR"),
  requestId: requestIdSchema,
  flagId: z.string().uuid()
}).strict();

export const cancelFlagRepairMessageSchema = z.object({
  type: z.literal("CANCEL_FLAG_REPAIR"),
  requestId: requestIdSchema,
  flagId: z.string().uuid(),
  operationId: z.string().uuid()
}).strict();

export const startFlagRepairDisruptMessageSchema = z.object({
  type: z.literal("START_FLAG_REPAIR_DISRUPT"),
  requestId: requestIdSchema,
  flagId: z.string().uuid(),
  repairOperationId: z.string().uuid()
}).strict();

export const cancelFlagRepairDisruptMessageSchema = z.object({
  type: z.literal("CANCEL_FLAG_REPAIR_DISRUPT"),
  requestId: requestIdSchema,
  flagId: z.string().uuid(),
  operationId: z.string().uuid()
}).strict();

export const craftTorchesMessageSchema = z.object({
  type: z.literal("CRAFT_TORCH"),
  requestId: requestIdSchema
}).strict();

export const visitFlagMessageSchema = z.object({
  type: z.literal("VISIT_FLAG"),
  requestId: requestIdSchema,
  flagId: z.string().uuid(),
  source: z.literal("visible_map").optional(),
  expectedTollGold: z.string().regex(/^(0|[1-9][0-9]{0,15})$/).optional()
}).strict();

export const prepareVisibleFlagVisitMessageSchema = z.object({
  type: z.literal("PREPARE_VISIBLE_FLAG_VISIT"),
  requestId: requestIdSchema,
  flagId: z.string().uuid(),
  expectedTollGold: z.string().regex(/^(0|[1-9][0-9]{0,15})$/).optional(),
  expectedDestination: visibleFlagDestinationAuthoritySchema.optional(),
  ...visibleFlagAuthoritySchema.shape
}).strict();

export const commitVisibleFlagVisitMessageSchema = z.object({
  type: z.literal("COMMIT_VISIBLE_FLAG_VISIT"),
  requestId: requestIdSchema,
  preparationId: requestIdSchema.optional(),
  flagId: z.string().uuid(),
  expectedTollGold: z.string().regex(/^(0|[1-9][0-9]{0,15})$/).optional(),
  expectedDestination: visibleFlagDestinationAuthoritySchema.optional(),
  ...visibleFlagAuthoritySchema.shape
}).strict();

export const cancelVisibleFlagVisitMessageSchema = z.object({
  type: z.literal("CANCEL_VISIBLE_FLAG_VISIT"),
  requestId: requestIdSchema
}).strict();

export const visitWorldMapKingdomMessageSchema = z.object({
  type: z.literal("VISIT_WORLD_MAP_KINGDOM"),
  requestId: requestIdSchema,
  seatId: z.string().uuid()
}).strict();

export const visitWorldMapAtlasShrineMessageSchema = z.object({
  type: z.literal("VISIT_WORLD_MAP_ATLAS_SHRINE"),
  requestId: requestIdSchema,
  flagId: z.string().uuid()
}).strict();

/** Find Open Land: travel to the spot the Trail Hound just found (held server-side, one use). */
export const visitOpenLandMessageSchema = z.object({
  type: z.literal("VISIT_OPEN_LAND"),
  requestId: requestIdSchema
}).strict();

/** Voyager: travel to one of the player's recorded locations. */
export const visitRecordedLocationMessageSchema = z.object({
  type: z.literal("VISIT_RECORDED_LOCATION"),
  requestId: requestIdSchema,
  locationId: z.string().uuid()
}).strict();

export const visitWorldMapHollinHutMessageSchema = z.object({
  type: z.literal("VISIT_WORLD_MAP_HOLLIN_HUT"),
  requestId: requestIdSchema,
  hutId: z.string().regex(/^hollin-hut:[0-9a-f-]{36}$/u)
}).strict();

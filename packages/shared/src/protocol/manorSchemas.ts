import { z } from "zod";

import { ENCHANTMENT_STONE_VARIANTS } from "../progression.js";
import {
  KITCHEN_COOK_ANY_MAX_QUANTITY,
  KITCHEN_COOK_ANY_RECIPE_ID,
  KITCHEN_RECIPE_IDS
} from "../kitchen.js";
import {
  FURNACE_BREAKDOWN_INPUT_IDS,
  FURNACE_BREAKDOWN_MAX_QUANTITY,
  FURNACE_GLIMMER_OIL_MAX_QUANTITY,
  FURNACE_RECIPE_IDS
} from "../furnace.js";
import { TANNERY_RECIPE_IDS } from "../tannery.js";
import { LOOM_RECIPE_IDS } from "../loom.js";
import { EQUIPMENT_METAL_IDS } from "../equipmentEnhancements.js";
import { GREENHOUSE_CROP_ID_REGEX } from "../greenhouse.js";
import {
  FISHING_SPECIALIZATION_TYPES,
  FISHING_UPGRADE_TRACKS
} from "../fishing.js";

const requestIdSchema = z.string().min(1).max(128);
/** Category picks the player saw (or chose), one list per category input (R6/R7). */
const categoryPicksSchema = z.array(z.array(z.object({
  itemId: z.string().min(1).max(64),
  quantity: z.number().int().positive().safe()
}).strict()).max(16)).max(4);
const manorQuantitySchema = z.number().int().positive().safe();
const manorStackIdSchema = z.string().uuid();
// Positions are ordering metadata only. Storage capacity is weight based.
const manorSlotSchema = z.number().int().nonnegative().safe();

export const enterManorMessageSchema = z.object({
  type: z.literal("ENTER_MANOR"),
  requestId: requestIdSchema,
  manorId: z.string().uuid()
}).strict();

export const jumpToManorMessageSchema = z.object({
  type: z.literal("JUMP_TO_MANOR"),
  requestId: requestIdSchema,
  manorId: z.string().uuid()
}).strict();

export const cancelManorEntryMessageSchema = z.object({
  type: z.literal("CANCEL_MANOR_ENTRY"),
  requestId: requestIdSchema
}).strict();

export const requestManorGuestsMessageSchema = z.object({
  type: z.literal("REQUEST_MANOR_GUESTS"),
  requestId: requestIdSchema,
  manorId: z.string().uuid()
}).strict();

export const kickManorGuestMessageSchema = z.object({
  type: z.literal("KICK_MANOR_GUEST"),
  requestId: requestIdSchema,
  manorId: z.string().uuid(),
  targetPlayerId: z.string().min(1).max(128)
}).strict();

export const banManorGuestMessageSchema = z.object({
  type: z.literal("BAN_MANOR_GUEST"),
  requestId: requestIdSchema,
  manorId: z.string().uuid(),
  targetPlayerId: z.string().min(1).max(128)
}).strict();

export const unbanManorGuestMessageSchema = z.object({
  type: z.literal("UNBAN_MANOR_GUEST"),
  requestId: requestIdSchema,
  manorId: z.string().uuid(),
  targetPlayerId: z.string().min(1).max(128)
}).strict();

export const buildManorMessageSchema = z.object({
  type: z.literal("BUILD_MANOR"),
  requestId: requestIdSchema
}).strict();

export const openManorUpgradesMessageSchema = z.object({
  type: z.literal("OPEN_MANOR_UPGRADES"),
  requestId: requestIdSchema
}).strict();

export const upgradeManorStorageMessageSchema = z.object({
  type: z.literal("UPGRADE_MANOR_STORAGE"),
  requestId: requestIdSchema,
  targetLevel: z.number().int().min(1).max(3)
}).strict();

export const destroyManorMessageSchema = z.object({
  type: z.literal("DESTROY_MANOR"),
  requestId: requestIdSchema
}).strict();

/** Manor warfare (houses): hand attack by another player, owner repair start / stop. */
export const attackManorMessageSchema = z.object({
  type: z.literal("ATTACK_MANOR"),
  requestId: requestIdSchema,
  manorId: z.string().uuid()
}).strict();

export const startManorRepairMessageSchema = z.object({
  type: z.literal("START_MANOR_REPAIR"),
  requestId: requestIdSchema,
  manorId: z.string().uuid()
}).strict();

export const stopManorRepairMessageSchema = z.object({
  type: z.literal("STOP_MANOR_REPAIR"),
  requestId: requestIdSchema
}).strict();

const manorTypeIdSchema = z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u).max(128);

/** Owner-only: install the skin item of a Manor type on the built Manor (the default type uninstalls). */
export const installManorSkinMessageSchema = z.object({
  type: z.literal("INSTALL_MANOR_SKIN"),
  requestId: requestIdSchema,
  manorTypeId: manorTypeIdSchema,
  /** The manor_skin copy (its inventory variant) to equip; omitted/null only to unequip (manor_lobby). */
  copyId: z.string().uuid().nullable().optional()
}).strict();

export const buildFurnaceMessageSchema = z.object({
  type: z.literal("BUILD_FURNACE"),
  requestId: requestIdSchema
}).strict();

export const openFurnaceMessageSchema = z.object({
  type: z.literal("OPEN_FURNACE"),
  requestId: requestIdSchema,
  furnaceId: z.string().uuid()
}).strict();

export const startFurnaceSmeltMessageSchema = z.object({
  type: z.literal("START_FURNACE_SMELT"),
  requestId: requestIdSchema,
  furnaceId: z.string().uuid(),
  /** A smelt recipe, or a breakdown input id for the Furnace's instant breakdown. */
  recipeId: z.enum([...FURNACE_RECIPE_IDS, ...FURNACE_BREAKDOWN_INPUT_IDS] as [string, ...string[]]),
  quantity: z.number().int().min(1).max(FURNACE_BREAKDOWN_MAX_QUANTITY),
  categoryPicks: categoryPicksSchema.optional(),
  confirmHighGrade: z.boolean().optional()
}).strict();

export const collectFurnaceOutputMessageSchema = z.object({
  type: z.literal("COLLECT_FURNACE_OUTPUT"),
  requestId: requestIdSchema,
  furnaceId: z.string().uuid()
}).strict();

export const refineFurnaceGlimmerOilMessageSchema = z.object({
  type: z.literal("REFINE_FURNACE_GLIMMER_OIL"),
  requestId: requestIdSchema,
  furnaceId: z.string().uuid(),
  quantity: z.number().int().min(1).max(FURNACE_GLIMMER_OIL_MAX_QUANTITY)
}).strict();

export const buildTanneryMessageSchema = z.object({
  type: z.literal("BUILD_TANNERY"),
  requestId: requestIdSchema
}).strict();

export const openTanneryMessageSchema = z.object({
  type: z.literal("OPEN_TANNERY"),
  requestId: requestIdSchema,
  tanneryId: z.string().uuid()
}).strict();

export const startTanneryBatchMessageSchema = z.object({
  type: z.literal("START_TANNERY_BATCH"),
  requestId: requestIdSchema,
  tanneryId: z.string().uuid(),
  recipeId: z.enum(TANNERY_RECIPE_IDS),
  quantity: z.number().int().min(1).max(25),
  confirmHighGrade: z.boolean().optional()
}).strict();

export const collectTanneryOutputMessageSchema = z.object({
  type: z.literal("COLLECT_TANNERY_OUTPUT"),
  requestId: requestIdSchema,
  tanneryId: z.string().uuid()
}).strict();

export const buildLoomMessageSchema = z.object({
  type: z.literal("BUILD_LOOM"),
  requestId: requestIdSchema
}).strict();

export const openLoomMessageSchema = z.object({
  type: z.literal("OPEN_LOOM"),
  requestId: requestIdSchema,
  loomId: z.string().uuid()
}).strict();

export const startLoomBatchMessageSchema = z.object({
  type: z.literal("START_LOOM_BATCH"),
  requestId: requestIdSchema,
  loomId: z.string().uuid(),
  recipeId: z.enum(LOOM_RECIPE_IDS),
  quantity: z.number().int().min(1).max(25),
  confirmHighGrade: z.boolean().optional()
}).strict();

export const collectLoomOutputMessageSchema = z.object({
  type: z.literal("COLLECT_LOOM_OUTPUT"),
  requestId: requestIdSchema,
  loomId: z.string().uuid()
}).strict();

export const buildKitchenMessageSchema = z.object({
  type: z.literal("BUILD_KITCHEN"),
  requestId: requestIdSchema
}).strict();

export const buildGreenhouseMessageSchema = z.object({
  type: z.literal("BUILD_GREENHOUSE"),
  requestId: requestIdSchema
}).strict();

export const previewGreenhouseBuildMessageSchema = z.object({
  type: z.literal("PREVIEW_GREENHOUSE_BUILD"),
  requestId: requestIdSchema
}).strict();

export const cancelGreenhouseBuildMessageSchema = z.object({
  type: z.literal("CANCEL_GREENHOUSE_BUILD"),
  requestId: requestIdSchema
}).strict();

export const destroyGreenhouseMessageSchema = z.object({
  type: z.literal("DESTROY_GREENHOUSE"),
  requestId: requestIdSchema,
  greenhouseId: z.string().uuid()
}).strict();

export const openGreenhouseMessageSchema = z.object({
  type: z.literal("OPEN_GREENHOUSE"),
  requestId: requestIdSchema,
  greenhouseId: z.string().uuid()
}).strict();

export const greenhouseMoveToMessageSchema = z.object({
  type: z.literal("GREENHOUSE_MOVE_TO"),
  requestId: requestIdSchema,
  greenhouseSessionId: z.string().uuid(),
  x: z.number().finite(),
  y: z.number().finite()
}).strict();

export const placeGreenhouseMessageSchema = z.object({
  type: z.literal("PLACE_GREENHOUSE"),
  requestId: requestIdSchema,
  greenhouseSessionId: z.string().uuid(),
  placementKind: z.enum(["pot", "water_tank"]),
  anchorId: z.string().min(1).max(256).optional(),
  x: z.number().finite(),
  y: z.number().finite()
}).strict();

const greenhouseAnchorIdSchema = z.string().min(1).max(256);

export const plantGreenhouseMessageSchema = z.object({
  type: z.literal("PLANT_GREENHOUSE"),
  requestId: requestIdSchema,
  greenhouseSessionId: z.string().uuid(),
  anchorId: greenhouseAnchorIdSchema,
  cropId: z.string().regex(GREENHOUSE_CROP_ID_REGEX),
  packId: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export const waterGreenhouseMessageSchema = z.object({
  type: z.literal("WATER_GREENHOUSE"),
  requestId: requestIdSchema,
  greenhouseSessionId: z.string().uuid(),
  anchorId: greenhouseAnchorIdSchema
}).strict();

export const clipGreenhouseMessageSchema = z.object({
  type: z.literal("CLIP_GREENHOUSE"),
  requestId: requestIdSchema,
  greenhouseSessionId: z.string().uuid(),
  anchorId: greenhouseAnchorIdSchema
}).strict();

export const harvestGreenhouseMessageSchema = z.object({
  type: z.literal("HARVEST_GREENHOUSE"),
  requestId: requestIdSchema,
  greenhouseSessionId: z.string().uuid(),
  anchorId: greenhouseAnchorIdSchema
}).strict();

export const tapGreenhouseTreeMessageSchema = z.object({
  type: z.literal("TAP_GREENHOUSE_TREE"),
  requestId: requestIdSchema,
  greenhouseSessionId: z.string().uuid(),
  anchorId: greenhouseAnchorIdSchema
}).strict();

export const craftWaterBucketMessageSchema = z.object({
  type: z.literal("CRAFT_WATER_BUCKET"),
  requestId: requestIdSchema
}).strict();

export const craftFertilizerMessageSchema = z.object({
  type: z.literal("CRAFT_FERTILIZER"),
  requestId: requestIdSchema
}).strict();

export const fillWaterBucketMessageSchema = z.object({
  type: z.literal("FILL_WATER_BUCKET"),
  requestId: requestIdSchema,
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  gallons: z.number().int().min(1).max(5)
}).strict();

export const cancelWaterBucketFillMessageSchema = z.object({
  type: z.literal("CANCEL_WATER_BUCKET_FILL"),
  requestId: requestIdSchema
}).strict();

export const depositGreenhouseWaterMessageSchema = z.object({
  type: z.literal("DEPOSIT_GREENHOUSE_WATER"),
  requestId: requestIdSchema,
  greenhouseSessionId: z.string().uuid()
}).strict();

export const refillGardeningBucketMessageSchema = z.object({
  type: z.literal("REFILL_GARDENING_BUCKET"),
  requestId: requestIdSchema,
  greenhouseSessionId: z.string().uuid()
}).strict();

export const openKitchenMessageSchema = z.object({
  type: z.literal("OPEN_KITCHEN"),
  requestId: requestIdSchema,
  kitchenId: z.string().uuid()
}).strict();

export const startKitchenBatchMessageSchema = z.object({
  type: z.literal("START_KITCHEN_BATCH"),
  requestId: requestIdSchema,
  kitchenId: z.string().uuid(),
  /** A per-item recipe, or "cook_any" to cook any Meat / Fish lowest grade first. */
  recipeId: z.enum([...KITCHEN_RECIPE_IDS, KITCHEN_COOK_ANY_RECIPE_ID]),
  quantity: z.number().int().min(1).max(KITCHEN_COOK_ANY_MAX_QUANTITY),
  categoryPicks: categoryPicksSchema.optional(),
  confirmHighGrade: z.boolean().optional()
}).strict();

export const collectKitchenOutputMessageSchema = z.object({
  type: z.literal("COLLECT_KITCHEN_OUTPUT"),
  requestId: requestIdSchema,
  kitchenId: z.string().uuid()
}).strict();

export const buildFishingHutMessageSchema = z.object({
  type: z.literal("BUILD_FISHING_HUT"),
  requestId: requestIdSchema
}).strict();

export const openFishingHutMessageSchema = z.object({
  type: z.literal("OPEN_FISHING_HUT"),
  requestId: requestIdSchema,
  fishingHutId: z.string().uuid().optional()
}).strict();

export const collectFishingHutMessageSchema = z.object({
  type: z.literal("COLLECT_FISHING_HUT"),
  requestId: requestIdSchema,
  fishingHutId: z.string().uuid()
}).strict();

export const requestFishingRecordsMessageSchema = z.object({
  type: z.literal("REQUEST_FISHING_RECORDS"),
  requestId: requestIdSchema,
  fishingHutId: z.string().uuid().optional()
}).strict();

export const startFishingMessageSchema = z.object({
  type: z.literal("START_FISHING"),
  requestId: requestIdSchema,
  fishingRodId: z.string().uuid(),
  fishingHutId: z.string().uuid().optional()
}).strict();

export const craftFishingRodMessageSchema = z.object({
  type: z.literal("CRAFT_FISHING_ROD"),
  requestId: requestIdSchema,
  fishingHutId: z.string().uuid()
}).strict();

export const upgradeFishingTrainingMessageSchema = z.object({
  type: z.literal("UPGRADE_FISHING_TRAINING"),
  requestId: requestIdSchema,
  fishingHutId: z.string().uuid(),
  track: z.enum(FISHING_UPGRADE_TRACKS)
}).strict();

export const selectFishingSpecializationMessageSchema = z.object({
  type: z.literal("SELECT_FISHING_SPECIALIZATION"),
  requestId: requestIdSchema,
  fishingHutId: z.string().uuid(),
  specializationType: z.enum(FISHING_SPECIALIZATION_TYPES)
}).strict();

export const fishingCastMessageSchema = z.object({
  type: z.literal("FISHING_CAST"),
  requestId: requestIdSchema,
  encounterId: z.string().uuid(),
  timing: z.number().finite().min(0).max(1),
  waterbody: z.object({
    kind: z.enum(["river", "lake", "ocean"]),
    sourceId: z.string().min(1).max(256).nullable()
  }).strict().optional(),
  castPoint: z.object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180)
  }).strict()
}).strict();

export const fishingHookMessageSchema = z.object({
  type: z.literal("FISHING_HOOK"),
  requestId: requestIdSchema,
  encounterId: z.string().uuid()
}).strict();

export const fishingControlMessageSchema = z.object({
  type: z.literal("FISHING_CONTROL"),
  requestId: requestIdSchema,
  encounterId: z.string().uuid(),
  direction: z.enum(["left", "right", "neutral"]),
  reeling: z.boolean()
}).strict();

export const fishingLandMessageSchema = z.object({
  type: z.literal("FISHING_LAND"),
  requestId: requestIdSchema,
  encounterId: z.string().uuid()
}).strict();

export const fishingCancelMessageSchema = z.object({
  type: z.literal("FISHING_CANCEL"),
  requestId: requestIdSchema,
  encounterId: z.string().uuid()
}).strict();

export const openJewelStationMessageSchema = z.object({
  type: z.literal("OPEN_JEWEL_STATION"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  movementSequence: z.number().int().nonnegative().safe()
}).strict();

export const prepareJewelEquipmentMessageSchema = z.object({
  type: z.literal("PREPARE_JEWEL_EQUIPMENT"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  movementSequence: z.number().int().nonnegative().safe(),
  instanceId: z.string().uuid(),
  gemstone: z.enum(ENCHANTMENT_STONE_VARIANTS)
}).strict();

export const imbueJewelEquipmentMessageSchema = z.object({
  type: z.literal("IMBUE_JEWEL_EQUIPMENT"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  movementSequence: z.number().int().nonnegative().safe(),
  instanceId: z.string().uuid(),
  metal: z.enum(EQUIPMENT_METAL_IDS).optional().default("venomsteel")
}).strict();

export const reforgeJewelEquipmentMessageSchema = z.object({
  type: z.literal("REFORGE_JEWEL_EQUIPMENT"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  movementSequence: z.number().int().nonnegative().safe(),
  instanceId: z.string().uuid(),
  /** Replacement gem (1 Enchantment Stone). Omit to keep the current gem. */
  gemstone: z.enum(ENCHANTMENT_STONE_VARIANTS).optional(),
  /** Strip the metal. Defaults to true unless a replacement gem is sent alone. */
  changeMetal: z.boolean().optional()
}).strict();

export const exitManorMessageSchema = z.object({
  type: z.literal("EXIT_MANOR"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid()
}).strict();

export const manorMoveToMessageSchema = z.object({
  type: z.literal("MANOR_MOVE_TO"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  x: z.number().finite(),
  y: z.number().finite()
}).strict();

const manorDecorationDefinitionIdSchema = z.string().regex(
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u,
  "decoration definition id must be a safe lowercase ID"
);

export const requestManorDecorationsMessageSchema = z.object({
  type: z.literal("REQUEST_MANOR_DECORATIONS"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid()
}).strict();

export const placeManorDecorationMessageSchema = z.object({
  type: z.literal("PLACE_MANOR_DECORATION"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  definitionId: manorDecorationDefinitionIdSchema,
  x: z.number().finite().optional(),
  y: z.number().finite().optional()
}).strict();

export const moveManorDecorationMessageSchema = z.object({
  type: z.literal("MOVE_MANOR_DECORATION"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  placementId: z.string().uuid(),
  x: z.number().finite(),
  y: z.number().finite()
}).strict();

export const removeManorDecorationMessageSchema = z.object({
  type: z.literal("REMOVE_MANOR_DECORATION"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  placementId: z.string().uuid()
}).strict();

export const openManorStorageMessageSchema = z.object({
  type: z.literal("OPEN_MANOR_STORAGE"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid()
}).strict();

export const requestManorStorageViewMessageSchema = z.object({
  type: z.literal("REQUEST_MANOR_STORAGE_VIEW"),
  requestId: requestIdSchema
}).strict();

export const moveManorStackMessageSchema = z.object({
  type: z.literal("MOVE_MANOR_STACK"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  stackId: manorStackIdSchema,
  targetSlot: manorSlotSchema
}).strict();

export const splitManorStackMessageSchema = z.object({
  type: z.literal("SPLIT_MANOR_STACK"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  stackId: manorStackIdSchema,
  quantity: manorQuantitySchema
}).strict();

export const restackManorStackMessageSchema = z.object({
  type: z.literal("RESTACK_MANOR_STACK"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  stackId: manorStackIdSchema
}).strict();

export const reorganizeManorStorageMessageSchema = z.object({
  type: z.literal("REORGANIZE_MANOR_STORAGE"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid()
}).strict();

export const transferManorStackMessageSchema = z.object({
  type: z.literal("TRANSFER_MANOR_STACK"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  direction: z.enum(["deposit", "withdrawal"]),
  sourceStackId: manorStackIdSchema,
  quantity: manorQuantitySchema
}).strict();

export const transferManorEquipmentMessageSchema = z.object({
  type: z.literal("TRANSFER_MANOR_EQUIPMENT"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  direction: z.enum(["deposit", "withdrawal"]),
  equipmentInstanceId: z.string().uuid()
}).strict();

export const transferManorBackpackMessageSchema = z.object({
  type: z.literal("TRANSFER_MANOR_BACKPACK"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  direction: z.enum(["deposit", "withdrawal"]),
  backpackInstanceId: z.string().uuid()
}).strict();

export const bulkStoreManorItemsMessageSchema = z.object({
  type: z.literal("BULK_STORE_MANOR_ITEMS"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid()
}).strict();

export const bulkTakeManorItemsMessageSchema = z.object({
  type: z.literal("BULK_TAKE_MANOR_ITEMS"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid()
}).strict();

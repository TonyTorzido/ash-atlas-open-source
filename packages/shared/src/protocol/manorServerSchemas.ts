import { z } from "zod";

import type { ManorServerMessage } from "./manorMessages.js";
import { playerAppearanceSnapshotSchema } from "../appearance.js";
import { RESOURCE_TYPES } from "../collectibles.js";
import { KITCHEN_RECIPES, KITCHEN_JOB_RECIPE_IDS, type KitchenRecipeId } from "../kitchen.js";
import { ENCHANTMENT_STONE_VARIANTS } from "../progression.js";
import { FURNACE_RECIPE_IDS } from "../furnace.js";
import { TANNERY_OUTPUT_ITEM_IDS, TANNERY_RECIPE_IDS } from "../tannery.js";
import { LOOM_OUTPUT_ITEM_IDS, LOOM_RECIPE_IDS } from "../loom.js";
import { premiumWalletSnapshotSchema } from "../premiumCurrency.js";
import { EQUIPMENT_METAL_IDS } from "../equipmentEnhancements.js";
import { equipmentInstanceSchema, equipmentSnapshotSchema } from "./combatEquipmentServerSchemas.js";
import { FISHING_BASE_CAST_RANGE_M, FISHING_MAX_CAST_RANGE_M } from "../fishing.js";
import { GREENHOUSE_CROP_ID_REGEX } from "../greenhouse.js";
import { backpackServerMessageSchemas } from "./backpackServerSchemas.js";
import {
  inventoryServerSchema,
  manorPositionServerSchema,
  manorWorldServerSchema,
  optionalRequestIdSchema,
  playerSnapshotServerSchema,
  requestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireNumberSchema,
  wireObjectArraySchema,
  wireObjectSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

const manorStackServerSchema = z.object({
  stackId: z.string().uuid(),
  slotIndex: wireNonnegativeIntegerSchema,
  itemId: z.enum(RESOURCE_TYPES),
  variant: wireStringSchema.nullable(),
  quantity: wireNonnegativeIntegerSchema,
  manualSplit: wireBooleanSchema,
  version: wireNonnegativeIntegerSchema
}).passthrough();

const manorEquipmentServerSchema = z.object({
  equipmentInstanceId: z.string().uuid(),
  slotIndex: wireNonnegativeIntegerSchema,
  equipment: equipmentInstanceSchema
}).passthrough();

const suggestedPositionSchema = z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).strict().optional();

const greenhouseBuildServerSchema = z.object({
  buildId: wireStringSchema,
  position: z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).strict(),
  eligibility: wireObjectSchema,
  startedAt: wireNumberSchema,
  completesAt: wireNumberSchema,
  durationMs: wireNumberSchema
}).passthrough();
const greenhouseSnapshotServerSchema = z.object({
  greenhouseId: wireStringSchema,
  ownerPlayerId: wireStringSchema,
  ownerUsername: wireStringSchema.optional(),
  regionCode: wireStringSchema,
  lat: wireNumberSchema,
  lon: wireNumberSchema,
  builtAt: wireStringSchema,
  placementRevision: wireNonnegativeIntegerSchema,
  roomCount: wireNonnegativeIntegerSchema,
  planterCapacity: wireNonnegativeIntegerSchema,
  tankWaterTenths: wireNonnegativeIntegerSchema,
  tankCapacityTenths: wireNonnegativeIntegerSchema,
  eligibility: wireObjectSchema,
  anchors: z.array(wireObjectSchema)
}).passthrough();
const greenhouseStateServerSchema = z.object({
  greenhouse: greenhouseSnapshotServerSchema,
  serverTime: wireNumberSchema,
  waterBucketGallons: wireNumberSchema,
  gardeningBucketGallons: wireNumberSchema,
  inventory: inventoryServerSchema,
  cropCatalog: z.object({
    packId: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
    crops: z.array(z.object({
      cropId: z.string().regex(GREENHOUSE_CROP_ID_REGEX),
      displayName: wireStringSchema,
      seedDisplayName: wireStringSchema,
      seed: z.object({
        itemId: z.enum(["seed", "wheat_seed", "giving_berry"]),
        variant: wireStringSchema.nullable()
      }).strict(),
      maxStage: z.number().int().min(1).max(4),
      harvestQuantity: wireNonnegativeIntegerSchema,
      clippingStages: z.array(z.number().int().min(1).max(4)),
      plantingAvailable: wireBooleanSchema,
      stageArtIds: z.tuple([wireStringSchema, wireStringSchema, wireStringSchema, wireStringSchema])
    }).strict())
  }).strict().optional()
}).passthrough();

const backpackSnapshotSchema =
  backpackServerMessageSchemas.BACKPACK_SNAPSHOT.shape.backpacks;
const backpackInstanceSchema = backpackSnapshotSchema.shape.instances.element;
const manorBackpackServerSchema = z.object({
  backpackInstanceId: z.string().uuid(),
  slotIndex: wireNonnegativeIntegerSchema,
  backpack: backpackInstanceSchema
}).passthrough();

const manorStorageServerSchema = z.object({
  manorId: wireStringSchema,
  currentWeightGrams: z.string().regex(/^\d+$/u).optional(),
  maximumWeightGrams: z.string().regex(/^\d+$/u).optional(),
  stacks: z.array(manorStackServerSchema),
  equipment: z.array(manorEquipmentServerSchema),
  backpacks: z.array(manorBackpackServerSchema),
  slots: z.array(z.discriminatedUnion("kind", [
    manorStackServerSchema.extend({ kind: z.literal("stack") }),
    manorEquipmentServerSchema.extend({ kind: z.literal("equipment") }),
    manorBackpackServerSchema.extend({ kind: z.literal("backpack") })
  ])),
  overflowStacks: z.array(z.object({
    stackId: z.string().uuid(),
    sourceOrder: wireNonnegativeIntegerSchema,
    itemId: z.enum(RESOURCE_TYPES),
    variant: wireStringSchema.nullable(),
    quantity: wireNonnegativeIntegerSchema
  }).passthrough()),
  unlockedSlots: z.literal(60)
}).passthrough();

const manorStorageUpgradeServerSchema = z.object({
  level: z.number().int().min(1).max(3),
  capacityBonusGrams: z.number().int().positive(),
  capacityGrams: z.number().int().positive(),
  materials: z.array(z.object({
    itemId: z.enum(["wood", "stone"]),
    quantity: z.number().int().positive()
  }).strict()),
  gold: z.number().int().positive()
}).strict();

const manorStorageUpgradeSnapshotServerSchema = z.object({
  manorId: wireStringSchema,
  level: z.number().int().min(0).max(3),
  maximumLevel: z.literal(3),
  capacityGrams: z.string().regex(/^\d+$/u),
  upgrades: z.array(manorStorageUpgradeServerSchema),
  inventory: inventoryServerSchema,
  walletGold: z.string().regex(/^-?\d+$/u),
  walletVersion: z.string().regex(/^\d+$/u)
}).passthrough();

const manorDecorationTransformServerSchema = z.object({
  x: wireNumberSchema,
  y: wireNumberSchema,
  width: wireNumberSchema,
  height: wireNumberSchema,
  rotationDeg: wireNumberSchema,
  scaleX: wireNumberSchema,
  scaleY: wireNumberSchema,
  anchorX: wireNumberSchema,
  anchorY: wireNumberSchema
}).passthrough();
const manorDecorationDefinitionServerSchema = z.object({
  id: wireStringSchema,
  retired: wireBooleanSchema,
  name: wireStringSchema,
  itemId: wireStringSchema.nullable(),
  assetKey: wireStringSchema,
  roomId: wireStringSchema,
  surfaceId: wireStringSchema,
  layer: z.enum(["behind", "in_front", "rug"]),
  placementMode: z.enum(["permanent", "movable"]),
  transform: manorDecorationTransformServerSchema,
  footprint: z.array(z.object({ x: wireNumberSchema, y: wireNumberSchema }).passthrough()),
  collision: wireBooleanSchema,
  zIndex: wireNonnegativeIntegerSchema,
  mirrorX: wireBooleanSchema
}).passthrough();
const manorDecorationPlacementServerSchema = z.object({
  placementId: z.string().uuid(),
  definitionId: wireStringSchema,
  itemId: wireStringSchema.nullable(),
  itemVariant: wireStringSchema.nullable(),
  roomId: wireStringSchema,
  surfaceId: wireStringSchema,
  transform: manorDecorationTransformServerSchema,
  authoredDefault: wireBooleanSchema.optional()
}).passthrough();
const manorDecorationSnapshotServerSchema = z.object({
  manorId: wireStringSchema,
  roomWidth: wireNumberSchema,
  roomHeight: wireNumberSchema,
  definitions: z.array(z.object({
    definition: manorDecorationDefinitionServerSchema,
    ownedQuantity: wireNonnegativeIntegerSchema,
    availableQuantity: wireNonnegativeIntegerSchema
  }).passthrough()),
  placements: z.array(manorDecorationPlacementServerSchema)
}).passthrough();

const furnaceWorldServerSchema = z.object({
  furnaceId: z.string().uuid(),
  manorId: z.string().uuid(),
  ownerPlayerId: wireStringSchema,
  ownerUsername: wireStringSchema,
  regionCode: wireStringSchema,
  lat: wireNumberSchema,
  lon: wireNumberSchema,
  builtAt: wireStringSchema,
  placementRevision: wireNonnegativeIntegerSchema
}).passthrough();

const furnaceJobServerSchema = z.object({
  jobId: z.string().uuid(),
  recipeId: z.enum(FURNACE_RECIPE_IDS),
  outputItemId: z.enum(FURNACE_RECIPE_IDS),
  outputDisplayName: wireStringSchema,
  requestedQuantity: z.number().int().min(1).max(5),
  completedQuantity: wireNonnegativeIntegerSchema,
  collectedQuantity: wireNonnegativeIntegerSchema,
  readyQuantity: wireNonnegativeIntegerSchema,
  readySuccessQuantity: wireNonnegativeIntegerSchema.optional(),
  readyFailureQuantity: wireNonnegativeIntegerSchema.optional(),
  startedAt: wireStringSchema,
  nextCompletesAt: wireStringSchema.nullable(),
  productionFinished: wireBooleanSchema
}).passthrough();

const furnaceStateServerSchema = z.object({
  furnace: furnaceWorldServerSchema,
  jobs: z.array(furnaceJobServerSchema),
  queueCapacity: z.literal(5),
  occupiedSlots: z.number().int().min(0).max(5),
  metallurgyRank: wireNonnegativeIntegerSchema.optional(),
  serverTime: wireNumberSchema
}).passthrough();

const furnaceBuildServerSchema = z.object({
  buildId: wireStringSchema,
  position: z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).passthrough(),
  startedAt: wireNumberSchema,
  completesAt: wireNumberSchema,
  durationMs: wireNumberSchema
}).passthrough();

const tanneryWorldServerSchema = z.object({
  tanneryId: z.string().uuid(), manorId: z.string().uuid(), ownerPlayerId: wireStringSchema,
  ownerUsername: wireStringSchema, regionCode: wireStringSchema, lat: wireNumberSchema,
  lon: wireNumberSchema, builtAt: wireStringSchema, placementRevision: wireNonnegativeIntegerSchema
}).passthrough();

const tanneryJobServerSchema = z.object({
  jobId: z.string().uuid(),
  recipeId: z.enum(TANNERY_RECIPE_IDS),
  inputItemId: z.enum(TANNERY_RECIPE_IDS),
  outputItemId: z.enum(TANNERY_OUTPUT_ITEM_IDS), outputDisplayName: wireStringSchema,
  requestedInputQuantity: z.number().int().min(1).max(25),
  outputQuantity: wireNonnegativeIntegerSchema, collectedQuantity: wireNonnegativeIntegerSchema,
  readyQuantity: wireNonnegativeIntegerSchema, startedAt: wireStringSchema,
  completesAt: wireStringSchema, productionFinished: wireBooleanSchema
}).passthrough();

const tanneryStateServerSchema = z.object({
  tannery: tanneryWorldServerSchema, jobs: z.array(tanneryJobServerSchema),
  queueCapacity: z.literal(5), occupiedSlots: z.number().int().min(0).max(5),
  serverTime: wireNumberSchema
}).passthrough();

const tanneryBuildServerSchema = z.object({
  buildId: wireStringSchema,
  position: z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).passthrough(),
  startedAt: wireNumberSchema, completesAt: wireNumberSchema, durationMs: wireNumberSchema
}).passthrough();

const loomWorldServerSchema = z.object({
  loomId: z.string().uuid(), manorId: z.string().uuid(), ownerPlayerId: wireStringSchema,
  ownerUsername: wireStringSchema, regionCode: wireStringSchema, lat: wireNumberSchema,
  lon: wireNumberSchema, builtAt: wireStringSchema, placementRevision: wireNonnegativeIntegerSchema
}).passthrough();

const loomJobServerSchema = z.object({
  jobId: z.string().uuid(),
  recipeId: z.enum(LOOM_RECIPE_IDS),
  inputItemId: z.enum(LOOM_RECIPE_IDS),
  outputItemId: z.enum(LOOM_OUTPUT_ITEM_IDS), outputDisplayName: wireStringSchema,
  requestedInputQuantity: z.number().int().min(1).max(25),
  outputQuantity: wireNonnegativeIntegerSchema, collectedQuantity: wireNonnegativeIntegerSchema,
  readyQuantity: wireNonnegativeIntegerSchema, startedAt: wireStringSchema,
  completesAt: wireStringSchema, productionFinished: wireBooleanSchema
}).passthrough();

const loomStateServerSchema = z.object({
  loom: loomWorldServerSchema, jobs: z.array(loomJobServerSchema),
  queueCapacity: z.literal(5), occupiedSlots: z.number().int().min(0).max(5),
  serverTime: wireNumberSchema
}).passthrough();

const loomBuildServerSchema = z.object({
  buildId: wireStringSchema,
  position: z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).passthrough(),
  startedAt: wireNumberSchema, completesAt: wireNumberSchema, durationMs: wireNumberSchema
}).passthrough();

const kitchenWorldServerSchema = z.object({
  kitchenId: z.string().uuid(), manorId: z.string().uuid(), ownerPlayerId: wireStringSchema,
  ownerUsername: wireStringSchema, regionCode: wireStringSchema, lat: wireNumberSchema,
  lon: wireNumberSchema, builtAt: wireStringSchema, placementRevision: wireNonnegativeIntegerSchema
}).passthrough();

const kitchenJobServerSchema = z.object({
  jobId: z.string().uuid(),
  recipeId: z.enum(KITCHEN_JOB_RECIPE_IDS),
  inputItemId: z.enum(KITCHEN_JOB_RECIPE_IDS),
  outputItemId: z.enum(["simple_food", "crude_oil"]), outputDisplayName: wireStringSchema,
  requestedInputQuantity: z.number().int().min(1).max(50),
  outputQuantity: wireNonnegativeIntegerSchema, collectedQuantity: wireNonnegativeIntegerSchema,
  readyQuantity: wireNonnegativeIntegerSchema, startedAt: wireStringSchema,
  completesAt: wireStringSchema, productionFinished: wireBooleanSchema
}).passthrough().superRefine((job, context) => {
  const recipe = KITCHEN_RECIPES[job.recipeId as KitchenRecipeId];
  if (!recipe) return;
  if (
    job.requestedInputQuantity < recipe.minimumQuantity
    || job.requestedInputQuantity % recipe.inputPerOutput !== 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requestedInputQuantity"],
      message: `Kitchen quantity must be a multiple of ${recipe.inputPerOutput} between ${recipe.minimumQuantity} and ${recipe.maximumQuantity}.`
    });
  }
});

const kitchenStateServerSchema = z.object({
  kitchen: kitchenWorldServerSchema, jobs: z.array(kitchenJobServerSchema),
  queueCapacity: z.literal(5), occupiedSlots: z.number().int().min(0).max(5),
  serverTime: wireNumberSchema
}).passthrough();

const kitchenBuildServerSchema = z.object({
  buildId: wireStringSchema,
  position: z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).passthrough(),
  startedAt: wireNumberSchema, completesAt: wireNumberSchema, durationMs: wireNumberSchema
}).passthrough();

const fishingWaterbodyServerSchema = z.object({
  kind: z.enum(["lake", "river", "ocean"]),
  sourceId: wireStringSchema.nullable(),
  displayName: wireStringSchema,
  distanceM: wireNumberSchema,
  sourceRevision: wireStringSchema.nullable().optional()
}).passthrough();

const fishingWaterbodyCandidateServerSchema = fishingWaterbodyServerSchema;
const fishingUpgradeServerSchema = z.object({
  track: z.enum(["cast_range", "reel_power", "line_control"]),
  rank: z.number().int().min(0).max(3),
  maxRank: z.literal(3),
  nextRank: z.number().int().min(1).max(3).nullable(),
  nextCostGold: z.number().int().nonnegative().nullable(),
  effect: z.number().finite(),
  nextEffect: z.number().finite().nullable()
}).passthrough();
const fishingSpecializationServerSchema = z.object({
  selectedType: z.enum(["lake", "river", "ocean"]).nullable(),
  selectedAt: wireStringSchema.nullable(),
  unlocksAt: wireStringSchema.nullable(),
  canChange: wireBooleanSchema
}).passthrough();

const fishingHutServerSchema = z.object({
  fishingHutId: z.string().uuid(), ownerPlayerId: wireStringSchema, ownerUsername: wireStringSchema,
  worldId: wireStringSchema, regionCode: wireStringSchema, lat: wireNumberSchema, lon: wireNumberSchema,
  builtAt: wireStringSchema, placementRevision: wireNonnegativeIntegerSchema,
  waterbody: fishingWaterbodyServerSchema, passiveStoredQuantity: wireNonnegativeIntegerSchema,
  passiveCapacity: wireNonnegativeIntegerSchema, passiveReadyQuantity: wireNonnegativeIntegerSchema
}).passthrough();

const fishingBuildServerSchema = z.object({
  buildId: wireStringSchema,
  position: z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).passthrough(),
  waterbody: fishingWaterbodyServerSchema,
  startedAt: wireNumberSchema, completesAt: wireNumberSchema, durationMs: wireNumberSchema
}).passthrough();

const fishingCatchServerSchema = z.object({
  catchId: wireStringSchema, encounterId: wireStringSchema,
  player: z.object({ playerId: wireStringSchema, username: wireStringSchema }).passthrough().optional(),
  fishItemId: z.enum(["freshwater_fish", "ashen_fish"]), ashen: wireBooleanSchema,
  behaviorProfile: z.enum(["runner", "darter", "tank", "feinter"]), difficulty: wireNumberSchema,
  lengthIn: wireNumberSchema, weightLb: wireNumberSchema, score: wireNonnegativeIntegerSchema,
  perfect: wireBooleanSchema, durationMs: wireNonnegativeIntegerSchema,
  waterbody: fishingWaterbodyServerSchema, caughtAt: wireStringSchema,
  rodId: wireStringSchema.optional(), fishSpecies: wireStringSchema.optional(),
  percentile: wireNumberSchema.optional(),
  geography: z.object({ region: wireStringSchema, country: wireStringSchema }).passthrough().optional(),
  source: z.enum(["active", "passive"]).optional()
}).passthrough();

const fishingEncounterServerSchema = z.object({
  encounterId: wireStringSchema, fishingHutId: wireStringSchema.nullable(),
  rodId: wireStringSchema.optional(), rodUsesRemaining: wireNonnegativeIntegerSchema.optional(),
  castRangeM: wireNumberSchema.min(FISHING_BASE_CAST_RANGE_M).max(FISHING_MAX_CAST_RANGE_M).optional(),
  phase: z.enum(["cast", "bite", "hooked", "fighting", "landed", "escaped", "expired", "cancelled"]),
  waterbody: fishingWaterbodyServerSchema.nullable(),
  waterbodyCandidates: z.array(fishingWaterbodyCandidateServerSchema).optional(),
  castPoint: z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).nullable(),
  behaviorProfile: z.enum(["runner", "darter", "tank", "feinter"]), difficulty: wireNumberSchema,
  ashen: wireBooleanSchema, castQuality: wireNumberSchema.nullable(), biteAt: wireNumberSchema,
  biteEvent: z.object({
    kind: z.enum(["nibble", "fake_nibble", "true_strike"]),
    startedAt: wireNumberSchema,
    endsAt: wireNumberSchema
  }).nullable(),
  serverTime: wireNumberSchema, tension: wireNumberSchema, distance: wireNumberSchema,
  stamina: wireNumberSchema, slackMs: wireNonnegativeIntegerSchema, criticalMs: wireNonnegativeIntegerSchema,
  fishDirection: z.enum(["left", "right", "neutral"]), fishPull: wireNumberSchema,
  executionQuality: wireNumberSchema, catch: fishingCatchServerSchema.nullable(), reconnectDeadlineAt: wireNumberSchema
}).passthrough();

const fishingStateServerSchema = z.object({
  hut: fishingHutServerSchema.nullable(), encounter: fishingEncounterServerSchema.nullable(),
  personalBestWeightLb: wireNumberSchema.nullable(), personalBestScore: wireNumberSchema.nullable(),
  weeklyBestFiveScore: wireNonnegativeIntegerSchema, serverTime: wireNumberSchema,
  upgrades: z.array(fishingUpgradeServerSchema).optional(),
  specialization: fishingSpecializationServerSchema.optional()
}).passthrough();

const fishingRecordServerSchema = z.object({
  waterbody: fishingWaterbodyServerSchema.nullable(),
  heaviest: fishingCatchServerSchema.nullable(), highestScore: fishingCatchServerSchema.nullable(),
  personalBestWeight: fishingCatchServerSchema.nullable(), personalBestScore: fishingCatchServerSchema.nullable(),
  personalBestPerfect: fishingCatchServerSchema.nullable(), ashenCatches: z.array(fishingCatchServerSchema),
  weeklyBestFiveScore: wireNonnegativeIntegerSchema,
  weeklyTopAnglers: z.array(z.object({
    playerId: wireStringSchema, username: wireStringSchema,
    score: wireNonnegativeIntegerSchema, catchCount: wireNonnegativeIntegerSchema
  }).passthrough()),
  recentCatches: z.array(fishingCatchServerSchema)
}).passthrough();

export const manorServerMessageSchemas = {
  MANOR_STATUS: serverFrame("MANOR_STATUS", { manor: manorWorldServerSchema.nullable() }),
  MANOR_SKIN_RESULT: serverFrame("MANOR_SKIN_RESULT", { requestId: requestIdSchema, action: z.enum(["install", "purchase"]), manor: manorWorldServerSchema.nullable(), inventory: inventoryServerSchema, premiumWallet: premiumWalletSnapshotSchema.optional(), replayed: wireBooleanSchema, message: wireStringSchema }),
  MANOR_BUILD_RESULT: serverFrame("MANOR_BUILD_RESULT", { requestId: requestIdSchema, manor: manorWorldServerSchema, inventory: inventoryServerSchema.optional(), replayed: wireBooleanSchema }),
  MANOR_UPGRADES_SNAPSHOT: serverFrame("MANOR_UPGRADES_SNAPSHOT", { requestId: requestIdSchema, snapshot: manorStorageUpgradeSnapshotServerSchema }),
  MANOR_UPGRADE_RESULT: serverFrame("MANOR_UPGRADE_RESULT", {
    requestId: requestIdSchema,
    targetLevel: z.number().int().min(1).max(3),
    snapshot: manorStorageUpgradeSnapshotServerSchema,
    replayed: wireBooleanSchema,
    message: wireStringSchema
  }),
  MANOR_DESTROY_RESULT: serverFrame("MANOR_DESTROY_RESULT", { requestId: requestIdSchema, manorId: wireStringSchema, placementRevision: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  MANORS_SNAPSHOT: serverFrame("MANORS_SNAPSHOT", { manors: z.array(manorWorldServerSchema) }),
  MANOR_WARFARE_CHANGED: serverFrame("MANOR_WARFARE_CHANGED", {
    requestId: requestIdSchema,
    action: z.enum(["attack", "repair_started", "repair_stopped"]),
    manorId: wireStringSchema,
    damage: wireNonnegativeIntegerSchema.optional(),
    replayed: wireBooleanSchema
  }),
  MANOR_WORLD_UPDATED: serverFrame("MANOR_WORLD_UPDATED", { manor: manorWorldServerSchema }),
  FURNACES_SNAPSHOT: serverFrame("FURNACES_SNAPSHOT", { furnaces: z.array(furnaceWorldServerSchema) }),
  FURNACE_BUILD_STARTED: serverFrame("FURNACE_BUILD_STARTED", { requestId: requestIdSchema, build: furnaceBuildServerSchema, inventory: inventoryServerSchema, serverTime: wireNumberSchema, replayed: wireBooleanSchema }),
  FURNACE_BUILD_RESULT: serverFrame("FURNACE_BUILD_RESULT", { requestId: requestIdSchema, furnace: furnaceWorldServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  FURNACE_BUILD_CANCELLED: serverFrame("FURNACE_BUILD_CANCELLED", { requestId: requestIdSchema, buildId: wireStringSchema, inventory: inventoryServerSchema, droppedItems: wireObjectArraySchema, message: wireStringSchema }),
  FURNACE_STATE: serverFrame("FURNACE_STATE", { requestId: optionalRequestIdSchema, state: furnaceStateServerSchema }),
  FURNACE_SMELT_STARTED: serverFrame("FURNACE_SMELT_STARTED", { requestId: requestIdSchema, state: furnaceStateServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  FURNACE_OUTPUT_COLLECTED: serverFrame("FURNACE_OUTPUT_COLLECTED", { requestId: requestIdSchema, state: furnaceStateServerSchema, inventory: inventoryServerSchema, collectedQuantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  FURNACE_GLIMMER_OIL_REFINED: serverFrame("FURNACE_GLIMMER_OIL_REFINED", { requestId: requestIdSchema, state: furnaceStateServerSchema, inventory: inventoryServerSchema, premiumWallet: premiumWalletSnapshotSchema, refinedQuantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  FURNACE_ERROR: serverFrame("FURNACE_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema, suggestedPosition: suggestedPositionSchema }),
  TANNERIES_SNAPSHOT: serverFrame("TANNERIES_SNAPSHOT", { tanneries: z.array(tanneryWorldServerSchema) }),
  TANNERY_BUILD_STARTED: serverFrame("TANNERY_BUILD_STARTED", { requestId: requestIdSchema, build: tanneryBuildServerSchema, inventory: inventoryServerSchema, serverTime: wireNumberSchema, replayed: wireBooleanSchema }),
  TANNERY_BUILD_RESULT: serverFrame("TANNERY_BUILD_RESULT", { requestId: requestIdSchema, tannery: tanneryWorldServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  TANNERY_BUILD_CANCELLED: serverFrame("TANNERY_BUILD_CANCELLED", { requestId: requestIdSchema, buildId: wireStringSchema, inventory: inventoryServerSchema, droppedItems: wireObjectArraySchema, message: wireStringSchema }),
  TANNERY_STATE: serverFrame("TANNERY_STATE", { requestId: optionalRequestIdSchema, state: tanneryStateServerSchema }),
  TANNERY_BATCH_STARTED: serverFrame("TANNERY_BATCH_STARTED", { requestId: requestIdSchema, state: tanneryStateServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  TANNERY_OUTPUT_COLLECTED: serverFrame("TANNERY_OUTPUT_COLLECTED", { requestId: requestIdSchema, state: tanneryStateServerSchema, inventory: inventoryServerSchema, collectedQuantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  TANNERY_ERROR: serverFrame("TANNERY_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema, suggestedPosition: suggestedPositionSchema }),
  LOOMS_SNAPSHOT: serverFrame("LOOMS_SNAPSHOT", { looms: z.array(loomWorldServerSchema) }),
  LOOM_BUILD_STARTED: serverFrame("LOOM_BUILD_STARTED", { requestId: requestIdSchema, build: loomBuildServerSchema, inventory: inventoryServerSchema, serverTime: wireNumberSchema, replayed: wireBooleanSchema }),
  LOOM_BUILD_RESULT: serverFrame("LOOM_BUILD_RESULT", { requestId: requestIdSchema, loom: loomWorldServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  LOOM_BUILD_CANCELLED: serverFrame("LOOM_BUILD_CANCELLED", { requestId: requestIdSchema, buildId: wireStringSchema, inventory: inventoryServerSchema, droppedItems: wireObjectArraySchema, message: wireStringSchema }),
  LOOM_STATE: serverFrame("LOOM_STATE", { requestId: optionalRequestIdSchema, state: loomStateServerSchema }),
  LOOM_BATCH_STARTED: serverFrame("LOOM_BATCH_STARTED", { requestId: requestIdSchema, state: loomStateServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  LOOM_OUTPUT_COLLECTED: serverFrame("LOOM_OUTPUT_COLLECTED", { requestId: requestIdSchema, state: loomStateServerSchema, inventory: inventoryServerSchema, collectedQuantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  LOOM_ERROR: serverFrame("LOOM_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema, suggestedPosition: suggestedPositionSchema }),
  KITCHENS_SNAPSHOT: serverFrame("KITCHENS_SNAPSHOT", { kitchens: z.array(kitchenWorldServerSchema) }),
  KITCHEN_BUILD_STARTED: serverFrame("KITCHEN_BUILD_STARTED", { requestId: requestIdSchema, build: kitchenBuildServerSchema, inventory: inventoryServerSchema, serverTime: wireNumberSchema, replayed: wireBooleanSchema }),
  KITCHEN_BUILD_RESULT: serverFrame("KITCHEN_BUILD_RESULT", { requestId: requestIdSchema, kitchen: kitchenWorldServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  KITCHEN_BUILD_CANCELLED: serverFrame("KITCHEN_BUILD_CANCELLED", { requestId: requestIdSchema, buildId: wireStringSchema, inventory: inventoryServerSchema, droppedItems: wireObjectArraySchema, message: wireStringSchema }),
  KITCHEN_STATE: serverFrame("KITCHEN_STATE", { requestId: optionalRequestIdSchema, state: kitchenStateServerSchema }),
  KITCHEN_BATCH_STARTED: serverFrame("KITCHEN_BATCH_STARTED", { requestId: requestIdSchema, state: kitchenStateServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, leftoverQuantity: wireNonnegativeIntegerSchema.optional() }),
  KITCHEN_OUTPUT_COLLECTED: serverFrame("KITCHEN_OUTPUT_COLLECTED", { requestId: requestIdSchema, state: kitchenStateServerSchema, inventory: inventoryServerSchema, collectedQuantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  KITCHEN_ERROR: serverFrame("KITCHEN_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema, suggestedPosition: suggestedPositionSchema }),
  GREENHOUSES_SNAPSHOT: serverFrame("GREENHOUSES_SNAPSHOT", { greenhouses: z.array(greenhouseSnapshotServerSchema) }),
  GREENHOUSE_BUILD_PREVIEW: serverFrame("GREENHOUSE_BUILD_PREVIEW", { requestId: requestIdSchema, preview: wireObjectSchema }),
  GREENHOUSE_BUILD_STARTED: serverFrame("GREENHOUSE_BUILD_STARTED", { requestId: requestIdSchema, build: greenhouseBuildServerSchema, inventory: inventoryServerSchema, serverTime: wireNumberSchema, replayed: wireBooleanSchema }),
  GREENHOUSE_BUILD_RESULT: serverFrame("GREENHOUSE_BUILD_RESULT", { requestId: requestIdSchema, greenhouse: greenhouseSnapshotServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  GREENHOUSE_BUILD_CANCELLED: serverFrame("GREENHOUSE_BUILD_CANCELLED", { requestId: requestIdSchema, buildId: wireStringSchema, inventory: inventoryServerSchema, droppedItems: wireObjectArraySchema, message: wireStringSchema }),
  GREENHOUSE_DESTROY_RESULT: serverFrame("GREENHOUSE_DESTROY_RESULT", { requestId: requestIdSchema, greenhouseId: wireStringSchema, placementRevision: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  GREENHOUSE_STATE: serverFrame("GREENHOUSE_STATE", { requestId: optionalRequestIdSchema, state: greenhouseStateServerSchema }),
  GREENHOUSE_POSITION: serverFrame("GREENHOUSE_POSITION", { greenhouseSessionId: wireStringSchema, position: manorPositionServerSchema, movementSequence: wireNonnegativeIntegerSchema, serverTime: wireNumberSchema }),
  GREENHOUSE_MUTATION_RESULT: serverFrame("GREENHOUSE_MUTATION_RESULT", { requestId: requestIdSchema, action: z.enum(["plant", "water", "clip", "harvest", "tap", "deposit", "refill", "place"]), state: greenhouseStateServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, message: wireStringSchema, yieldQuantity: wireNonnegativeIntegerSchema.optional(), placementKind: z.enum(["pot", "water_tank"]).optional(), placedAnchorId: wireStringSchema.optional() }),
  GREENHOUSE_BUCKET_RESULT: serverFrame("GREENHOUSE_BUCKET_RESULT", { requestId: requestIdSchema, inventory: inventoryServerSchema, waterBucketGallons: wireNumberSchema, gardeningBucketGallons: wireNumberSchema, replayed: wireBooleanSchema }),
  GREENHOUSE_FERTILIZER_RESULT: serverFrame("GREENHOUSE_FERTILIZER_RESULT", { requestId: requestIdSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  GREENHOUSE_WATER_FILL_STARTED: serverFrame("GREENHOUSE_WATER_FILL_STARTED", { requestId: requestIdSchema, gallons: wireNumberSchema, completesAt: wireNumberSchema, rangeM: wireNumberSchema, message: wireStringSchema }),
  GREENHOUSE_WATER_FILL_RESULT: serverFrame("GREENHOUSE_WATER_FILL_RESULT", { requestId: requestIdSchema, gallons: wireNumberSchema, waterBucketGallons: wireNumberSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  GREENHOUSE_ERROR: serverFrame("GREENHOUSE_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema, suggestedPosition: suggestedPositionSchema }),
  FISHING_HUTS_SNAPSHOT: serverFrame("FISHING_HUTS_SNAPSHOT", { fishingHuts: z.array(fishingHutServerSchema) }),
  FISHING_HUT_BUILD_STARTED: serverFrame("FISHING_HUT_BUILD_STARTED", { requestId: requestIdSchema, build: fishingBuildServerSchema, inventory: inventoryServerSchema, serverTime: wireNumberSchema, replayed: wireBooleanSchema }),
  FISHING_HUT_BUILD_RESULT: serverFrame("FISHING_HUT_BUILD_RESULT", { requestId: requestIdSchema, fishingHut: fishingHutServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema }),
  FISHING_HUT_BUILD_CANCELLED: serverFrame("FISHING_HUT_BUILD_CANCELLED", { requestId: requestIdSchema, buildId: wireStringSchema, inventory: inventoryServerSchema, droppedItems: wireObjectArraySchema, message: wireStringSchema }),
  FISHING_STATE: serverFrame("FISHING_STATE", { requestId: optionalRequestIdSchema, state: fishingStateServerSchema }),
  FISHING_PROGRESS_RESULT: serverFrame("FISHING_PROGRESS_RESULT", { requestId: requestIdSchema, state: fishingStateServerSchema, inventory: inventoryServerSchema, upgrades: z.array(fishingUpgradeServerSchema), specialization: fishingSpecializationServerSchema, replayed: wireBooleanSchema, rodId: wireStringSchema.optional(), walletGold: wireStringSchema.optional(), walletVersion: wireStringSchema.optional() }),
  FISHING_PASSIVE_COLLECTED: serverFrame("FISHING_PASSIVE_COLLECTED", { requestId: requestIdSchema, state: fishingStateServerSchema, inventory: inventoryServerSchema, collectedQuantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  FISHING_ENCOUNTER_STARTED: serverFrame("FISHING_ENCOUNTER_STARTED", { requestId: requestIdSchema, state: fishingStateServerSchema, replayed: wireBooleanSchema }),
  FISHING_ENCOUNTER_STATE: serverFrame("FISHING_ENCOUNTER_STATE", { requestId: optionalRequestIdSchema, state: fishingStateServerSchema }),
  FISHING_CAST_RESULT: serverFrame("FISHING_CAST_RESULT", { requestId: requestIdSchema, state: fishingStateServerSchema, replayed: wireBooleanSchema }),
  FISHING_HOOK_RESULT: serverFrame("FISHING_HOOK_RESULT", { requestId: requestIdSchema, state: fishingStateServerSchema, replayed: wireBooleanSchema }),
  FISHING_CONTROL_RESULT: serverFrame("FISHING_CONTROL_RESULT", { requestId: requestIdSchema, state: fishingStateServerSchema, replayed: wireBooleanSchema }),
  FISHING_CATCH_LANDED: serverFrame("FISHING_CATCH_LANDED", { requestId: requestIdSchema, state: fishingStateServerSchema, catch: fishingCatchServerSchema.nullable(), inventory: inventoryServerSchema.optional(), collectedQuantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  FISHING_RECORDS: serverFrame("FISHING_RECORDS", { requestId: requestIdSchema, records: fishingRecordServerSchema }),
  FISHING_ERROR: serverFrame("FISHING_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema, suggestedPosition: suggestedPositionSchema }),
  JEWEL_STATION_STATE: serverFrame("JEWEL_STATION_STATE", { requestId: requestIdSchema, state: wireObjectSchema }),
  JEWEL_STATION_RESULT: serverFrame("JEWEL_STATION_RESULT", {
    requestId: requestIdSchema,
    action: z.enum(["prepare", "imbue", "reforge"]),
    metal: z.enum(EQUIPMENT_METAL_IDS).optional(),
    instanceId: z.string().uuid(),
    gemstone: z.enum(ENCHANTMENT_STONE_VARIANTS).nullable(),
    premiumWallet: premiumWalletSnapshotSchema.optional(),
    replayed: wireBooleanSchema,
    state: wireObjectSchema
  }),
  JEWEL_STATION_ERROR: serverFrame("JEWEL_STATION_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema }),
  MANOR_ENTERED: serverFrame("MANOR_ENTERED", { requestId: optionalRequestIdSchema, manorId: wireStringSchema, spaceId: wireStringSchema, manorTypeId: wireStringSchema.optional(), manorSessionId: wireStringSchema, displayColor: wireStringSchema.nullable(), appearance: playerAppearanceSnapshotSchema.optional(), position: manorPositionServerSchema, movementSequence: wireNonnegativeIntegerSchema, serverTime: wireNumberSchema, accessSource: z.enum(["OWNER", "PARTY", "TRAVEL_INVITE"]), storage: manorStorageServerSchema.nullable(), decorations: manorDecorationSnapshotServerSchema.optional(), droppedItems: wireObjectArraySchema.optional() }),
  MANOR_ENTRY_PENDING: serverFrame("MANOR_ENTRY_PENDING", { requestId: requestIdSchema, manorId: wireStringSchema, message: wireStringSchema }),
  MANOR_GUESTS: serverFrame("MANOR_GUESTS", { requestId: optionalRequestIdSchema, snapshot: wireObjectSchema }),
  MANOR_OCCUPANTS: serverFrame("MANOR_OCCUPANTS", {
    manorId: wireStringSchema,
    occupants: z.array(z.object({
      playerId: wireStringSchema,
      displayName: wireStringSchema,
      displayColor: wireStringSchema.nullable(),
      appearance: wireObjectSchema.optional(),
      spaceId: wireStringSchema,
      accessSource: z.enum(["PARTY", "TRAVEL_INVITE"]),
      position: manorPositionServerSchema,
      movementSequence: wireNonnegativeIntegerSchema
    }).passthrough()),
    serverTime: wireNumberSchema
  }),
  MANOR_EXITED: serverFrame("MANOR_EXITED", { requestId: optionalRequestIdSchema, reason: wireStringSchema.optional(), player: playerSnapshotServerSchema, resourceVisionRevision: wireNonnegativeIntegerSchema.optional() }),
  MANOR_POSITION: serverFrame("MANOR_POSITION", { manorSessionId: wireStringSchema, spaceId: wireStringSchema, position: manorPositionServerSchema, movementSequence: wireNonnegativeIntegerSchema, serverTime: wireNumberSchema }),
  MANOR_STORAGE_SNAPSHOT: serverFrame("MANOR_STORAGE_SNAPSHOT", { requestId: requestIdSchema, manorSessionId: wireStringSchema, storage: manorStorageServerSchema }),
  MANOR_STORAGE_VIEW_SNAPSHOT: serverFrame("MANOR_STORAGE_VIEW_SNAPSHOT", { requestId: requestIdSchema, storage: manorStorageServerSchema }),
  MANOR_STORAGE_UPDATED: serverFrame("MANOR_STORAGE_UPDATED", {
    requestId: requestIdSchema,
    action: z.enum(["move", "split", "restack", "reorganize", "transfer", "bulk_store", "bulk_take"]),
    inventory: inventoryServerSchema,
    equipment: equipmentSnapshotSchema.optional(),
    backpacks: backpackSnapshotSchema.optional(),
    storage: manorStorageServerSchema,
    transfer: z.object({
      direction: z.enum(["deposit", "withdrawal"]),
      stacksRequested: wireNonnegativeIntegerSchema,
      quantityRequested: wireNonnegativeIntegerSchema,
      stacksMoved: wireNonnegativeIntegerSchema,
      quantityMoved: wireNonnegativeIntegerSchema,
      stacksRemaining: wireNonnegativeIntegerSchema,
      quantityRemaining: wireNonnegativeIntegerSchema,
      partial: wireBooleanSchema,
      capacityReason: wireStringSchema.nullable(),
      skipped: z.array(z.object({
        sourceId: wireStringSchema,
        kind: z.enum(["stack", "equipment", "backpack"]),
        reason: wireStringSchema,
        quantity: wireNonnegativeIntegerSchema
      }).strict())
    }).nullable(),
    replayed: wireBooleanSchema,
    message: wireStringSchema
  }),
  MANOR_DECORATIONS_SNAPSHOT: serverFrame("MANOR_DECORATIONS_SNAPSHOT", {
    requestId: z.union([requestIdSchema, z.literal("broadcast")]),
    snapshot: manorDecorationSnapshotServerSchema
  }),
  MANOR_DECORATION_UPDATED: serverFrame("MANOR_DECORATION_UPDATED", {
    requestId: requestIdSchema,
    action: z.enum(["place", "move", "remove"]),
    snapshot: manorDecorationSnapshotServerSchema,
    inventory: inventoryServerSchema,
    placement: manorDecorationPlacementServerSchema.nullable(),
    replayed: wireBooleanSchema,
    message: wireStringSchema
  }),
  MANOR_EQUIPMENT_DROPS_UPDATED: serverFrame("MANOR_EQUIPMENT_DROPS_UPDATED", {
    manorId: wireStringSchema,
    drops: wireObjectArraySchema,
    serverTime: wireNumberSchema
  }),
  MANOR_ERROR: serverFrame("MANOR_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema }),
} satisfies Record<ManorServerMessage["type"], z.ZodTypeAny>;

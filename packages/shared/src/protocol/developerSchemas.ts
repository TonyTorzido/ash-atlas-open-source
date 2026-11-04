import { z } from "zod";

import { DEV_PROGRESSION_TYPES, SUBCLASS_IDS } from "../classes.js";
import { CURRENT_LEVEL_CAP } from "../progression.js";
import { EQUIPMENT_METAL_IDS } from "../equipmentEnhancements.js";
import { INVENTORY_ITEM_TYPES } from "../collectibles.js";
import { MOB_APPEARANCE_VARIANTS, MOB_ARCHETYPE_KEYS } from "../combat.js";
import { PLANT_BOOK_ROSTER, type PlantBookKey } from "../creatureBook.js";

export const DEVELOPER_TEST_FLAG_KINDS = [
  "soft_flag",
  "bastion_flag",
  "tower"
] as const;
export type DeveloperTestFlagKind = typeof DEVELOPER_TEST_FLAG_KINDS[number];

export const DEVELOPER_TEST_UNIT_TYPES = [
  "field_ballista",
  "bomber",
  "archer",
  "infantry"
] as const;
export type DeveloperTestUnitType = typeof DEVELOPER_TEST_UNIT_TYPES[number];

const requestIdSchema = z.string().min(1).max(128);
const plantBookKeySchema = z.enum(
  PLANT_BOOK_ROSTER.map(({ plantKey }) => plantKey) as [PlantBookKey, ...PlantBookKey[]]
);

export const devSpawnMobMessageSchema = z.object({
  type: z.literal("DEV_SPAWN_MOB"),
  requestId: requestIdSchema,
  archetype: z.enum(MOB_ARCHETYPE_KEYS),
  appearanceVariant: z.enum(MOB_APPEARANCE_VARIANTS).optional(),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180)
}).strict();

export const devSpawnGoblinVillageMessageSchema = z.object({
  type: z.literal("DEV_SPAWN_GOBLIN_VILLAGE"),
  requestId: requestIdSchema,
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180)
}).strict();

/**
 * One-shot developer command that founds the Albuquerque hub city for the caller.
 * dryRun returns the full plan without committing anything.
 */
export const devFoundCapitalMessageSchema = z.object({
  type: z.literal("DEV_FOUND_CAPITAL"),
  requestId: z.string().min(1).max(96),
  dryRun: z.boolean(),
  leaveCurrentCity: z.boolean()
}).strict();

/**
 * Developer command that ends a city or kingdom and starts its territory
 * collapse wave. Without targetId it targets the developer's own city / kingdom.
 */
export const devCollapseTerritoryMessageSchema = z.object({
  type: z.literal("DEV_COLLAPSE_TERRITORY"),
  requestId: z.string().min(1).max(96),
  kind: z.enum(["city", "kingdom"]),
  targetId: z.string().uuid().optional()
}).strict();

export const devSpawnDungeonEntranceMessageSchema = z.object({
  type: z.literal("DEV_SPAWN_DUNGEON_ENTRANCE"),
  requestId: requestIdSchema,
  templateId: z.string().min(1).max(128),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180)
}).strict();

export const devListDungeonEntrancesMessageSchema = z.object({
  type: z.literal("DEV_LIST_DUNGEON_ENTRANCES"),
  requestId: requestIdSchema
}).strict();

export const devDeleteDungeonEntranceMessageSchema = z.object({
  type: z.literal("DEV_DELETE_DUNGEON_ENTRANCE"),
  requestId: requestIdSchema,
  entranceId: z.string().min(1).max(128)
}).strict();

export const devListGoblinVillagesMessageSchema = z.object({
  type: z.literal("DEV_LIST_GOBLIN_VILLAGES"),
  requestId: requestIdSchema
}).strict();

export const devDeleteGoblinVillageMessageSchema = z.object({
  type: z.literal("DEV_DELETE_GOBLIN_VILLAGE"),
  requestId: requestIdSchema,
  cityId: z.string().uuid()
}).strict();

/** Developer only: reset the dev-entrance dungeon run the sender is in (seals, doors, flags, completion) and send them to its entry room. */
export const devResetDungeonRunMessageSchema = z.object({
  type: z.literal("DEV_RESET_DUNGEON_RUN"),
  requestId: requestIdSchema
}).strict();

export const devClearMobsMessageSchema = z.object({
  type: z.literal("DEV_CLEAR_MOBS"),
  requestId: requestIdSchema
}).strict();

export const devSpawnPlantMessageSchema = z.object({
  type: z.literal("DEV_SPAWN_PLANT"),
  requestId: requestIdSchema,
  plantKey: plantBookKeySchema,
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180)
}).strict();

export const devSpawnTestFlagMessageSchema = z.object({
  type: z.literal("DEV_SPAWN_TEST_FLAG"),
  requestId: requestIdSchema,
  targetKind: z.enum(DEVELOPER_TEST_FLAG_KINDS),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180)
}).strict();

export const devSpawnTestUnitMessageSchema = z.object({
  type: z.literal("DEV_SPAWN_TEST_UNIT"),
  requestId: requestIdSchema,
  unitType: z.enum(DEVELOPER_TEST_UNIT_TYPES),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180)
}).strict();

export const devClearPlantsMessageSchema = z.object({
  type: z.literal("DEV_CLEAR_PLANTS"),
  requestId: requestIdSchema
}).strict();

export const resetOwnDevClassCooldownsMessageSchema = z.object({
  type: z.literal("RESET_OWN_DEV_CLASS_COOLDOWNS"),
  requestId: requestIdSchema
}).strict();

export const devTeleportMessageSchema = z.object({
  type: z.literal("DEV_TELEPORT"),
  requestId: requestIdSchema,
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180)
}).strict();

export const devVisitMineMessageSchema = z.object({
  type: z.literal("DEV_VISIT_MINE"),
  requestId: requestIdSchema,
  mineId: z.string().uuid()
}).strict();

export const adjustOwnDevProgressionMessageSchema = z.object({
  type: z.literal("ADJUST_OWN_DEV_PROGRESSION"),
  operationId: requestIdSchema,
  progressionType: z.enum(DEV_PROGRESSION_TYPES),
  // Character level follows the cap; Hunter/class ranks top out at 25.
  targetRank: z.number().int().min(0).max(Math.max(25, CURRENT_LEVEL_CAP))
}).strict();

export const setOwnDevSubclassUnlockMessageSchema = z.object({
  type: z.literal("SET_OWN_DEV_SUBCLASS_UNLOCK"),
  operationId: requestIdSchema,
  subclassId: z.enum(SUBCLASS_IDS),
  unlocked: z.boolean()
}).strict();

const developmentGrantIntegerSchema = z.string().regex(/^[1-9]\d{0,6}$/).refine(
  (value) => BigInt(value) <= 1_000_000n
);

export const grantOwnDevAssetsMessageSchema = z.object({
  type: z.literal("GRANT_OWN_DEV_ASSETS"),
  requestId: requestIdSchema,
  gold: developmentGrantIntegerSchema.optional(),
  cityCoins: developmentGrantIntegerSchema.optional(),
  glimmer: developmentGrantIntegerSchema.optional(),
  lumen: developmentGrantIntegerSchema.optional(),
  materials: z.array(z.object({
    itemId: z.enum(INVENTORY_ITEM_TYPES),
    quantity: developmentGrantIntegerSchema
  }).strict()).max(INVENTORY_ITEM_TYPES.length).optional()
}).strict();

export const DEV_METAL_EQUIPMENT_KINDS = ["sword", "chest"] as const;

export const devGrantMetalEquipmentMessageSchema = z.object({
  type: z.literal("DEV_GRANT_METAL_EQUIPMENT"),
  requestId: requestIdSchema,
  kind: z.enum(DEV_METAL_EQUIPMENT_KINDS),
  metal: z.enum(EQUIPMENT_METAL_IDS)
}).strict();

export const devAdvanceAllGreenhouseCropsMessageSchema = z.object({
  type: z.literal("DEV_ADVANCE_ALL_GREENHOUSE_CROPS"),
  requestId: requestIdSchema
}).strict();

/** Developer App: build the caller's manor at their position with no territory or wood needed (verifies interiors). */
export const devBuildManorMessageSchema = z.object({
  type: z.literal("DEV_BUILD_MANOR"),
  requestId: requestIdSchema
}).strict();

/** Developer App: an active Salon in the city the caller stands in (no Mayor, materials or build time; verifies interiors). */
export const devBuildSalonMessageSchema = z.object({
  type: z.literal("DEV_BUILD_SALON"),
  requestId: requestIdSchema
}).strict();

export const devWaterAllGreenhouseCropsMessageSchema = z.object({
  type: z.literal("DEV_WATER_ALL_GREENHOUSE_CROPS"),
  requestId: requestIdSchema
}).strict();

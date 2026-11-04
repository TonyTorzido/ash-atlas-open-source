import { z } from "zod";

const requestIdSchema = z.string().min(1).max(128);
const cityDistrictSchema = z.enum(["mining", "forestry", "hunting"]);

export const openGoblinMarketMessageSchema = z.object({
  type: z.literal("OPEN_GOBLIN_MARKET"),
  requestId: requestIdSchema,
  marketStructureId: z.string().uuid()
}).strict();

export const sellToGoblinMarketMessageSchema = z.object({
  type: z.literal("SELL_TO_GOBLIN_MARKET"),
  requestId: requestIdSchema,
  marketStructureId: z.string().uuid(),
  itemKind: z.enum(["resource", "equipment", "backpack"]),
  itemIdentity: z.string().min(1).max(160),
  quantity: z.number().int().positive(),
  expectedOfferGold: z.string().regex(/^[1-9]\d*$/)
}).strict();

export const buyFromGoblinMarketMessageSchema = z.object({
  type: z.literal("BUY_FROM_GOBLIN_MARKET"),
  requestId: requestIdSchema,
  marketStructureId: z.string().uuid(),
  itemId: z.literal("wheat_seed"),
  quantity: z.number().int().positive().max(250),
  expectedUnitPriceGold: z.string().regex(/^[1-9]\d*$/)
}).strict();

export const requestKingdomStateMessageSchema = z.object({
  type: z.literal("REQUEST_KINGDOM_STATE"),
  requestId: requestIdSchema
}).strict();

export const previewCityFoundingMessageSchema = z.object({
  type: z.literal("PREVIEW_CITY_FOUNDING"),
  requestId: requestIdSchema,
  flagId: z.string().uuid()
}).strict();

export const foundCityMessageSchema = z.object({
  type: z.literal("FOUND_CITY"),
  requestId: requestIdSchema,
  flagId: z.string().uuid()
}).strict();

export const advanceCityConstructionMessageSchema = z.object({
  type: z.literal("ADVANCE_CITY_CONSTRUCTION"),
  requestId: requestIdSchema,
  cityId: z.string().uuid(),
  action: z.enum(["build_foundation", "build_frames", "finish"])
}).strict();

export const requestCityInfoMessageSchema = z.object({
  type: z.literal("REQUEST_CITY_INFO"),
  requestId: requestIdSchema,
  cityId: z.string().uuid()
}).strict();

export const joinCityMessageSchema = z.object({
  type: z.literal("JOIN_CITY"),
  requestId: requestIdSchema,
  cityId: z.string().uuid()
}).strict();

export const requestCityAppMessageSchema = z.object({
  type: z.literal("REQUEST_CITY_APP"),
  requestId: requestIdSchema
}).strict();

export const buildCityHouseMessageSchema = z.object({
  type: z.literal("BUILD_CITY_HOUSE"),
  requestId: requestIdSchema
}).strict();

export const buildOilWellMessageSchema = z.object({
  type: z.literal("BUILD_OIL_WELL"),
  requestId: requestIdSchema,
  cityId: z.string().uuid(),
  /** Personal producer to build; absent means an Oil Well. */
  structureType: z.enum(["oil_well", "quartz_hut", "library"]).optional()
}).strict();

export const openOilWellMessageSchema = z.object({
  type: z.literal("OPEN_OIL_WELL"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  remote: z.boolean().optional()
}).strict();

export const harvestOilWellMessageSchema = z.object({
  type: z.literal("HARVEST_OIL_WELL"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  remote: z.boolean().optional()
}).strict();

export const openLibraryMessageSchema = z.object({
  type: z.literal("OPEN_LIBRARY"),
  requestId: requestIdSchema,
  structureId: z.string().uuid()
}).strict();

export const studyLibraryMessageSchema = z.object({
  type: z.literal("STUDY_LIBRARY"),
  requestId: requestIdSchema,
  structureId: z.string().uuid()
}).strict();

export const destroyOilWellMessageSchema = z.object({
  type: z.literal("DESTROY_OIL_WELL"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  expectedPlacementRevision: z.string().regex(/^[1-9]\d*$/)
}).strict();

export const destroyCityHouseMessageSchema = z.object({
  type: z.literal("DESTROY_CITY_HOUSE"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  expectedPlacementRevision: z.string().min(1)
}).strict();

export const buildCityFacilityMessageSchema = z.object({
  type: z.literal("BUILD_CITY_FACILITY"),
  requestId: requestIdSchema,
  cityId: z.string().uuid(),
  facilityType: z.enum(["warehouse", "cistern_warrens", "salon", "city_kennel"])
}).strict();

export const buildMilitaryFacilityMessageSchema = z.object({
  type: z.literal("BUILD_MILITARY_FACILITY"),
  requestId: requestIdSchema,
  cityId: z.string().uuid(),
  facilityType: z.enum(["barracks", "demolition_factory"])
}).strict();

export const buildLodgeMessageSchema = z.object({
  type: z.literal("BUILD_LODGE"),
  requestId: requestIdSchema
}).strict();

export const upgradeLodgeMessageSchema = z.object({
  type: z.literal("UPGRADE_LODGE"),
  requestId: requestIdSchema,
  expectedLevel: z.number().int().min(1).max(5)
}).strict();

export const destroyLodgeMessageSchema = z.object({
  type: z.literal("DESTROY_LODGE"),
  requestId: requestIdSchema
}).strict();

export const requestMilitaryIndustryMessageSchema = z.object({
  type: z.literal("REQUEST_MILITARY_INDUSTRY"),
  requestId: requestIdSchema
}).strict();

export const trainSiegeCrewMessageSchema = z.object({
  type: z.literal("TRAIN_SIEGE_CREW"),
  requestId: requestIdSchema,
  facilityStructureId: z.string().uuid()
}).strict();

export const trainMilitaryUnitMessageSchema = z.object({
  type: z.literal("TRAIN_MILITARY_UNIT"),
  requestId: requestIdSchema,
  facilityStructureId: z.string().uuid(),
  unitType: z.enum(["infantry", "archer", "bomber"])
}).strict();

export const manufactureFieldBallistaMessageSchema = z.object({
  type: z.literal("MANUFACTURE_FIELD_BALLISTA"),
  requestId: requestIdSchema,
  facilityStructureId: z.string().uuid()
}).strict();

export const startMilitaryProductionMessageSchema = z.object({
  type: z.literal("START_MILITARY_PRODUCTION"),
  requestId: requestIdSchema,
  facilityStructureId: z.string().uuid(),
  production: z.enum(["repair_kit_batch", "torch_batch"]),
  quantity: z.number().int().min(1).max(20)
}).strict();

export const combineMilitaryGroupsMessageSchema = z.object({
  type: z.literal("COMBINE_MILITARY_GROUPS"),
  requestId: requestIdSchema,
  groupIds: z.array(z.string().uuid()).min(2).max(6)
}).strict();

export const splitMilitaryGroupMessageSchema = z.object({
  type: z.literal("SPLIT_MILITARY_GROUP"),
  requestId: requestIdSchema,
  groupId: z.string().uuid(),
  splitSizes: z.array(z.number().int().min(1).max(6)).min(2).max(6)
}).strict();

export const buildWarCampMessageSchema = z.object({
  type: z.literal("BUILD_WAR_CAMP"),
  requestId: requestIdSchema
}).strict();

export const relocateWarCampMessageSchema = z.object({
  type: z.literal("RELOCATE_WAR_CAMP"),
  requestId: requestIdSchema
}).strict();

export const removeWarCampMessageSchema = z.object({
  type: z.literal("REMOVE_WAR_CAMP"),
  requestId: requestIdSchema
}).strict();

export const callTroopsMessageSchema = z.object({
  type: z.literal("CALL_TROOPS"),
  requestId: requestIdSchema
}).strict();

const militaryGroupCommandSchema = z.object({
  requestId: requestIdSchema,
  groupId: z.string().uuid()
}).strict();

export const followMilitaryGroupMessageSchema = militaryGroupCommandSchema.extend({
  type: z.literal("FOLLOW_MILITARY_GROUP")
}).strict();

export const deployMilitaryGroupMessageSchema = militaryGroupCommandSchema.extend({
  type: z.literal("DEPLOY_MILITARY_GROUP"),
  position: z.object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180)
  }).strict().optional()
}).strict();

export const defendMilitaryGroupMessageSchema = militaryGroupCommandSchema.extend({
  type: z.literal("DEFEND_MILITARY_GROUP")
}).strict();

export const returnMilitaryGroupMessageSchema = militaryGroupCommandSchema.extend({
  type: z.literal("RETURN_MILITARY_GROUP")
}).strict();

export const stopMilitaryGroupMessageSchema = militaryGroupCommandSchema.extend({
  type: z.literal("STOP_MILITARY_GROUP")
}).strict();

/** Cancels a Siege follow order while keeping its current field coordinate. */
export const stayMilitaryGroupMessageSchema = militaryGroupCommandSchema.extend({
  type: z.literal("STAY_MILITARY_GROUP")
}).strict();

/** Begins the authoritative 30-second Pack Up transition for a deployed Siege. */
export const packUpMilitaryGroupMessageSchema = militaryGroupCommandSchema.extend({
  type: z.literal("PACK_UP_MILITARY_GROUP")
}).strict();

export const moveMilitaryGroupMessageSchema = militaryGroupCommandSchema.extend({
  type: z.literal("MOVE_MILITARY_GROUP"),
  position: z.object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180)
  }).strict()
}).strict();

export const attackMilitaryGroupMessageSchema = z.object({
  type: z.literal("ATTACK_MILITARY_GROUP"),
  requestId: requestIdSchema,
  groupId: z.string().uuid(),
  targetEntityId: z.string().min(1).max(160)
}).strict();

export const attackMilitarySiegeMessageSchema = z.object({
  type: z.literal("ATTACK_MILITARY_SIEGE"),
  requestId: requestIdSchema,
  groupId: z.string().uuid()
}).strict();

/** Bomber and Siege target kind; absent means a flag (older clients). */
const militaryTargetKindSchema = z.enum(["flag", "city_structure"]).optional();

export const demolishFlagMessageSchema = z.object({
  type: z.literal("DEMOLISH_FLAG"),
  requestId: requestIdSchema,
  groupId: z.string().uuid(),
  targetFlagId: z.string().uuid(),
  targetKind: militaryTargetKindSchema
}).strict();

/** Hand attack, Bomber strike or Siege volley on another player's War Camp. */
export const attackWarCampMessageSchema = z.object({
  type: z.literal("ATTACK_WAR_CAMP"),
  requestId: requestIdSchema,
  campId: z.string().uuid(),
  mode: z.enum(["hand", "bomber", "siege"]),
  groupId: z.string().uuid().optional()
}).strict();

export const fireBallistaVolleyMessageSchema = z.object({
  type: z.literal("FIRE_BALLISTA_VOLLEY"),
  requestId: requestIdSchema,
  groupId: z.string().uuid(),
  targetFlagId: z.string().uuid(),
  targetKind: militaryTargetKindSchema
}).strict();

/** City building warfare (war part C3): hand attack, start and stop repair. */
export const attackCityStructureMessageSchema = z.object({
  type: z.literal("ATTACK_CITY_STRUCTURE"),
  requestId: requestIdSchema,
  structureId: z.string().uuid()
}).strict();

export const startCityStructureRepairMessageSchema = z.object({
  type: z.literal("START_CITY_STRUCTURE_REPAIR"),
  requestId: requestIdSchema,
  structureId: z.string().uuid()
}).strict();

export const stopCityStructureRepairMessageSchema = z.object({
  type: z.literal("STOP_CITY_STRUCTURE_REPAIR"),
  requestId: requestIdSchema
}).strict();

export const repairBallistaMessageSchema = z.object({
  type: z.literal("REPAIR_BALLISTA"),
  requestId: requestIdSchema,
  unitId: z.string().uuid()
}).strict();

export const collectMilitaryJobMessageSchema = z.object({
  type: z.literal("COLLECT_MILITARY_JOB"),
  requestId: requestIdSchema,
  jobId: z.string().uuid()
}).strict();

export const upgradeCityFacilityMessageSchema = z.object({
  type: z.literal("UPGRADE_CITY_FACILITY"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  /** Warehouse tiers 1-3; City Market levels 1-10 (the upgrade starts from at most 9). */
  expectedTier: z.number().int().min(1).max(9)
}).strict();

export const destroyCityFacilityMessageSchema = z.object({
  type: z.literal("DESTROY_CITY_FACILITY"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  expectedPlacementRevision: z.string().min(1)
}).strict();

export const openCityWarehouseMessageSchema = z.object({
  type: z.literal("OPEN_CITY_WAREHOUSE"),
  requestId: requestIdSchema,
  structureId: z.string().uuid()
}).strict();

export const donateCityWarehouseMessageSchema = z.object({
  type: z.literal("DONATE_CITY_WAREHOUSE"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  stackId: z.string().uuid(),
  quantity: z.number().int().positive()
}).strict();

export const donateAllCityWarehouseMessageSchema = z.object({
  type: z.literal("DONATE_ALL_CITY_WAREHOUSE"),
  requestId: requestIdSchema,
  structureId: z.string().uuid()
}).strict();

export const moveCityWarehouseStackMessageSchema = z.object({
  type: z.literal("MOVE_CITY_WAREHOUSE_STACK"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  stackId: z.string().uuid(),
  targetSlot: z.number().int().nonnegative()
}).strict();

export const reorganizeCityWarehouseMessageSchema = z.object({
  type: z.literal("REORGANIZE_CITY_WAREHOUSE"),
  requestId: requestIdSchema,
  structureId: z.string().uuid()
}).strict();

export const donateCityGoldMessageSchema = z.object({
  type: z.literal("DONATE_CITY_GOLD"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  amount: z.string().regex(/^[1-9]\d{0,18}$/)
}).strict();

export const buyCityMarketDailyMessageSchema = z.object({
  type: z.literal("BUY_CITY_MARKET_DAILY"),
  requestId: requestIdSchema,
  cityId: z.string().uuid()
}).strict();

export const buildCityMarketMessageSchema = z.object({
  type: z.literal("BUILD_CITY_MARKET"),
  requestId: requestIdSchema,
  cityId: z.string().uuid(),
  expectedCityRevision: z.string().regex(/^(0|[1-9]\d*)$/)
}).strict();

export const buildCityMonumentMessageSchema = z.object({
  type: z.literal("BUILD_CITY_MONUMENT"),
  requestId: requestIdSchema,
  cityId: z.string().uuid(),
  districtType: cityDistrictSchema,
  expectedCityRevision: z.string().regex(/^(0|[1-9]\d*)$/),
  expectedDistrictRevision: z.string().regex(/^(0|[1-9]\d*)$/)
}).strict();

export const upgradeCityMonumentMessageSchema = z.object({
  type: z.literal("UPGRADE_CITY_MONUMENT"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  expectedTier: z.union([z.literal(1), z.literal(2)]),
  expectedPlacementRevision: z.string().regex(/^[1-9]\d*$/),
  expectedDistrictRevision: z.string().regex(/^(0|[1-9]\d*)$/)
}).strict();

export const destroyCityMonumentMessageSchema = z.object({
  type: z.literal("DESTROY_CITY_MONUMENT"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  expectedPlacementRevision: z.string().regex(/^[1-9]\d*$/),
  expectedDistrictRevision: z.string().regex(/^(0|[1-9]\d*)$/)
}).strict();

export const leaveCityMessageSchema = z.object({
  type: z.literal("LEAVE_CITY"),
  requestId: requestIdSchema,
  cityId: z.string().uuid()
}).strict();

export const claimCityMayorMessageSchema = z.object({
  type: z.literal("CLAIM_CITY_MAYOR"),
  requestId: requestIdSchema,
  cityId: z.string().uuid()
}).strict();

export const relinquishCityMayorMessageSchema = z.object({
  type: z.literal("RELINQUISH_CITY_MAYOR"),
  requestId: requestIdSchema,
  cityId: z.string().uuid()
}).strict();

export const convertCityFlagMessageSchema = z.object({
  type: z.literal("CONVERT_CITY_FLAG"),
  requestId: requestIdSchema,
  flagId: z.string().uuid()
}).strict();

export const visitCityMessageSchema = z.object({
  type: z.literal("VISIT_CITY"),
  requestId: requestIdSchema,
  cityId: z.string().uuid()
}).strict();

export const visitCityHouseMessageSchema = z.object({
  type: z.literal("VISIT_CITY_HOUSE"),
  requestId: requestIdSchema,
  structureId: z.string().uuid()
}).strict();

export const visitCityMarketMessageSchema = z.object({
  type: z.literal("VISIT_CITY_MARKET"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  expectedPlacementRevision: z.string().regex(/^[1-9]\d*$/)
}).strict();

export const visitCityWarehouseMessageSchema = z.object({
  type: z.literal("VISIT_CITY_WAREHOUSE"),
  requestId: requestIdSchema,
  structureId: z.string().uuid(),
  expectedPlacementRevision: z.string().regex(/^[1-9]\d*$/)
}).strict();

export const visitWorldMapCityMessageSchema = z.object({
  type: z.literal("VISIT_WORLD_MAP_CITY"),
  requestId: requestIdSchema,
  cityId: z.string().uuid()
}).strict();

export const openHollinHutMessageSchema = z.object({
  type: z.literal("OPEN_HOLLIN_HUT"),
  requestId: requestIdSchema,
  hutId: z.string().min(1).max(80)
}).strict();

export const buyFromHollinHutMessageSchema = z.object({
  type: z.literal("BUY_FROM_HOLLIN_HUT"),
  requestId: requestIdSchema,
  hutId: z.string().min(1).max(80),
  itemId: z.string().min(1).max(80),
  quantity: z.number().int().positive().max(100),
  expectedUnitPriceGold: z.string().regex(/^[1-9]\d*$/)
}).strict();

export const listWanderingMerchantsMessageSchema = z.object({
  type: z.literal("LIST_WANDERING_MERCHANTS"),
  requestId: requestIdSchema
}).strict();

export const openWanderingMerchantMessageSchema = z.object({
  type: z.literal("OPEN_WANDERING_MERCHANT"),
  requestId: requestIdSchema,
  merchantId: z.string().min(1).max(80)
}).strict();

export const buyFromWanderingMerchantMessageSchema = z.object({
  type: z.literal("BUY_FROM_WANDERING_MERCHANT"),
  requestId: requestIdSchema,
  merchantId: z.string().min(1).max(80),
  itemId: z.string().min(1).max(80),
  quantity: z.number().int().positive().max(10),
  expectedUnitPriceGold: z.string().regex(/^[1-9]\d*$/)
}).strict();

export const craftCinderLanternMessageSchema = z.object({
  type: z.literal("CRAFT_CINDER_LANTERN"),
  requestId: requestIdSchema,
  lantern: z.enum(["cinder", "challenger"]).optional()
}).strict();

export const offerBerryToHollinsMessageSchema = z.object({
  type: z.literal("OFFER_BERRY_TO_HOLLINS"),
  requestId: requestIdSchema,
  hutId: z.string().min(1).max(80)
}).strict();

export const useHollinHutServiceMessageSchema = z.object({
  type: z.literal("USE_HOLLIN_HUT_SERVICE"),
  requestId: requestIdSchema,
  hutId: z.string().min(1).max(80),
  service: z.enum(["heal", "turn_in_eggs"])
}).strict();

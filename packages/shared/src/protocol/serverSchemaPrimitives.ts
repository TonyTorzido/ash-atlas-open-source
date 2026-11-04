import { z } from "zod";
import { playerAppearanceSnapshotSchema } from "../appearance.js";

import {
  INVENTORY_ITEM_TYPES,
  REPEATABLE_RESOURCE_NODE_TYPES,
  RESOURCE_TYPES
} from "../collectibles.js";
import { FISHING_ROD_MAX_USES } from "../fishing.js";
import { SHOP_TAG_PATTERN } from "../shopProvenance.js";

export const requestIdSchema = z.string().min(1).max(128);

export const wireStringSchema = z.string();
export const wireNumberSchema = z.number().finite();
export const wireIntegerSchema = z.number().int().safe();
export const wireNonnegativeIntegerSchema = wireIntegerSchema.nonnegative();
export const wireDecimalIntegerSchema = z.string().regex(/^\d+$/u);
export const wireBooleanSchema = z.boolean();
export const wireObjectSchema = z.object({}).passthrough();
export const wireObjectArraySchema = z.array(wireObjectSchema);
export const wireStringArraySchema = z.array(wireStringSchema);
export const optionalRequestIdSchema = requestIdSchema.optional();
export const latLonServerSchema = z.object({
  lat: wireNumberSchema,
  lon: wireNumberSchema
}).passthrough();

export function serverFrame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), ...shape }).passthrough();
}

export const playerGatheringActivityServerSchema = z.object({
  kind: z.enum(["chop", "mine", "fish"]),
  toolDefinitionId: wireStringSchema.nullable(),
  targetLat: wireNumberSchema,
  targetLon: wireNumberSchema,
  startedAt: wireStringSchema,
  completesAt: wireStringSchema.nullable()
}).passthrough();
export const playerDashServerSchema = z.object({
  active: wireBooleanSchema,
  startedAt: wireNumberSchema,
  until: wireNumberSchema,
  cooldownUntil: wireNumberSchema,
  fromLat: wireNumberSchema,
  fromLon: wireNumberSchema,
  toLat: wireNumberSchema,
  toLon: wireNumberSchema
}).passthrough();
export const playerSnapshotServerSchema = z.object({
  playerId: wireStringSchema,
  username: wireStringSchema,
  displayColor: wireStringSchema.nullable(),
  regionCode: wireStringSchema,
  zoneId: wireStringSchema,
  lat: wireNumberSchema,
  lon: wireNumberSchema,
  anchorLat: wireNumberSchema,
  anchorLon: wireNumberSchema,
  moveLeashRadiusM: wireNumberSchema,
  movementRevision: wireNonnegativeIntegerSchema,
  relocationRevision: wireNonnegativeIntegerSchema.optional(),
  targetLat: wireNumberSchema.nullable(),
  targetLon: wireNumberSchema.nullable(),
  moving: wireBooleanSchema,
  currentFlagId: wireStringSchema.nullable().optional(),
  currentKingdomSeatId: wireStringSchema.nullable().optional(),
  online: wireBooleanSchema,
  updatedAt: wireStringSchema,
  appearance: playerAppearanceSnapshotSchema.optional(),
  hunger: z.object({
    current: wireNonnegativeIntegerSchema,
    baseCapacity: wireNonnegativeIntegerSchema
  }).strict().optional(),
  afloat: wireBooleanSchema.optional(),
  gathering: playerGatheringActivityServerSchema.nullable().optional(),
  dash: playerDashServerSchema.nullable().optional(),
  /** Active class id (PlayerSnapshot.classId). A plain string so a class added later never breaks an older client. */
  classId: wireStringSchema.min(1).max(80).nullable().optional()
}).passthrough();
export const playerDeltaUpsertServerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("full"),
    player: playerSnapshotServerSchema
  }).passthrough(),
  z.object({
    kind: z.literal("movement"),
    playerId: wireStringSchema,
    lat: wireNumberSchema,
    lon: wireNumberSchema,
    movementRevision: wireNonnegativeIntegerSchema,
    relocationRevision: wireNonnegativeIntegerSchema.optional(),
    targetLat: wireNumberSchema.nullable(),
    targetLon: wireNumberSchema.nullable(),
    moving: wireBooleanSchema,
    online: wireBooleanSchema,
    updatedAt: wireStringSchema,
    dash: playerDashServerSchema.nullable().optional(),
    speedMps: wireNumberSchema.positive().optional()
  }).passthrough()
]);
export const flagSnapshotServerSchema = z.object({
  id: wireStringSchema,
  anchorKind: z.enum(["flag", "buoy"]).optional(),
  controlType: z.enum(["personal", "city", "city_seat", "kingdom", "kingdom_seat"]),
  ownerId: wireStringSchema,
  ownerUsername: wireStringSchema.optional(),
  ownerColor: wireStringSchema.optional(),
  presentationColor: wireStringSchema.nullable().optional(),
  systemControlled: z.boolean().optional(),
  name: wireStringSchema,
  lat: wireNumberSchema,
  lon: wireNumberSchema,
  packageId: wireStringSchema.nullable(),
  elevationM: wireNumberSchema.nullable(),
  terrainClass: wireStringSchema.nullable(),
  biome: wireStringSchema.nullable(),
  ecoregion: wireStringSchema.nullable(),
  claimRadiusM: wireNumberSchema,
  resourceVisionRadiusM: wireNumberSchema.optional(),
  accessMode: wireStringSchema.optional(),
  jumpTollGold: wireStringSchema.optional(),
  accessRevision: wireStringSchema.optional(),
  cityId: wireStringSchema.nullable(),
  reinforcementLevel: wireNonnegativeIntegerSchema.optional(),
  upgradeTier: z.enum(["base", "stone", "atlas_shrine", "tower"]).optional(),
  towerLevel: wireNonnegativeIntegerSchema.nullable().optional(),
  obeliskLevel: wireNonnegativeIntegerSchema.nullable().optional(),
  warStructureKind: z.enum(["war_tower", "war_outpost"]).nullable().optional(),
  warId: wireStringSchema.nullable().optional(),
  developerTestTarget: z.boolean().optional(),
  health: wireNonnegativeIntegerSchema.optional(),
  maximumHealth: wireNonnegativeIntegerSchema.optional(),
  burning: wireBooleanSchema.optional(),
  burningStartedAt: wireStringSchema.nullable().optional(),
  burningUntil: wireStringSchema.nullable().optional(),
  legendaryBirdSpecies: z.enum(["fire", "lightning", "ice"]).nullable().optional(),
  atlasShrineSlotNumber: wireNonnegativeIntegerSchema.nullable().optional(),
  kingdomId: wireStringSchema.nullable().optional(),
  kingdomName: wireStringSchema.nullable().optional(),
  kingdomEmblemKey: wireStringSchema.nullable().optional(),
  kingdomColor: wireStringSchema.nullable().optional(),
  kingdomSeatId: wireStringSchema.nullable().optional(),
  kingdomSeatConstructionState: z.enum(["under_construction", "complete"]).nullable().optional(),
  kingdomSeatLat: wireNumberSchema.nullable().optional(),
  kingdomSeatLon: wireNumberSchema.nullable().optional(),
  kingdomAffiliatedAt: wireStringSchema.nullable().optional(),
  originalOwnerPlayerId: wireStringSchema.nullable().optional(),
  contributedByPlayerId: wireStringSchema.nullable().optional(),
  contributedByUsername: wireStringSchema.nullable().optional(),
  originalPersonalColor: wireStringSchema.nullable().optional(),
  createdAt: wireStringSchema
}).passthrough();
export const citySnapshotServerSchema = z.object({
  id: wireStringSchema,
  worldId: wireStringSchema,
  worldSettlementId: wireStringSchema,
  worldSettlementSource: wireStringSchema,
  worldSourceSettlementId: wireStringSchema,
  settlementClass: wireStringSchema.nullable(),
  settlementReleaseId: wireStringSchema.nullable(),
  settlementReleaseFingerprint: wireStringSchema.nullable(),
  name: wireStringSchema,
  controllerKind: z.enum(["player", "npc"]).optional().default("player"),
  culture: z.enum(["human", "goblin"]).optional().default("human"),
  bannerColor: wireStringSchema.optional(),
  countryCode: wireStringSchema,
  regionCode: wireStringSchema.nullable(),
  founderPlayerId: wireStringSchema,
  founderUsername: wireStringSchema.optional(),
  founderColor: wireStringSchema.optional(),
  mayorPlayerId: wireStringSchema.nullable(),
  mayorConfirmed: wireBooleanSchema,
  founderMayorClaimDeadline: wireStringSchema.nullable(),
  mayorUsername: wireStringSchema.optional(),
  mayorColor: wireStringSchema.optional(),
  seatFlagId: wireStringSchema,
  lat: wireNumberSchema,
  lon: wireNumberSchema,
  active: wireBooleanSchema,
  jumpable: wireBooleanSchema,
  constructionPhase: z.enum(["blueprint", "foundation", "framing", "complete"]),
  constructionCompletedAt: wireStringSchema.nullable(),
  constructionContributions: z.array(z.object({
    playerId: wireStringSchema,
    stage: z.enum(["blueprint", "foundation", "framing", "finishing"]),
    contributedAt: wireStringSchema
  }).strict()).max(4),
  spatialRevision: wireStringSchema,
  foundingAnnexRadiusM: wireNumberSchema,
  createdAt: wireStringSchema
}).passthrough();
export const cityMembershipServerSchema = z.object({
  cityId: wireStringSchema,
  cityName: wireStringSchema,
  role: z.enum(["mayor", "member"]),
  joinedAt: wireStringSchema
}).passthrough();
const cityFacilityMaterialCostServerSchema = z.object({
  materials: z.array(z.object({
    itemId: z.enum(RESOURCE_TYPES),
    quantity: wireIntegerSchema.positive()
  }).passthrough()),
  cityCoins: wireNonnegativeIntegerSchema,
  cityGold: wireNonnegativeIntegerSchema.optional()
}).strict();
const warehouseCostScheduleServerSchema = z.object({
  1: cityFacilityMaterialCostServerSchema,
  2: cityFacilityMaterialCostServerSchema,
  3: cityFacilityMaterialCostServerSchema
}).strip();
export const cityAppFacilityCostsServerSchema = z.object({
  warehouse: warehouseCostScheduleServerSchema,
  cistern_warrens: warehouseCostScheduleServerSchema,
  salon: warehouseCostScheduleServerSchema,
  city_kennel: warehouseCostScheduleServerSchema
}).strip();
const cityMonumentTierServerSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3)
]);
const cityMonumentTiersServerSchema = z.object({
  mining: cityMonumentTierServerSchema.nullable(),
  forestry: cityMonumentTierServerSchema.nullable(),
  hunting: cityMonumentTierServerSchema.nullable()
}).strict();
function cityDistrictMonumentServerSchema(
  districtType: "mining" | "forestry" | "hunting"
) {
  return z.object({
    districtType: z.literal(districtType),
    structureId: wireStringSchema.nullable(),
    status: z.enum(["inactive", "constructing", "active"]),
    tier: cityMonumentTierServerSchema.nullable()
  }).strict();
}
const cityDistrictBenefitServerSchema = z.object({
  cityId: wireStringSchema.nullable(),
  monumentTiers: cityMonumentTiersServerSchema,
  districtRevision: wireStringSchema,
  miningExtraYieldChance: wireNumberSchema.min(0).max(1),
  forestryExtraYieldChance: wireNumberSchema.min(0).max(1),
  directMobDamageBonus: wireNonnegativeIntegerSchema,
  mobDefenseBonus: wireNonnegativeIntegerSchema,
  resinPreservationChance: wireNumberSchema.min(0).max(1)
}).strict();
const cityGoldDonationServerSchema = z.object({
  playerId: wireStringSchema,
  username: wireStringSchema,
  amount: wireStringSchema,
  donatedAt: wireStringSchema
}).strict();
export const cityGoldSnapshotServerSchema = z.object({
  balance: wireStringSchema,
  capacity: wireStringSchema,
  remainingCapacity: wireStringSchema,
  lifetimeDonated: wireStringSchema,
  lifetimeSpent: wireStringSchema,
  revision: wireStringSchema,
  canDonate: wireBooleanSchema,
  recentDonations: z.array(cityGoldDonationServerSchema).max(25)
}).strict();
const cityCivicCostServerSchema = z.object({
  materials: z.array(z.object({
    itemId: z.enum(["wood", "stone"]),
    quantity: wireIntegerSchema.positive()
  }).strict()).length(2),
  cityCoins: wireNonnegativeIntegerSchema,
  cityGold: wireNonnegativeIntegerSchema
}).strict();
const cityCivicCostsServerSchema = z.object({
  market: cityCivicCostServerSchema,
  monument: z.object({
    1: cityCivicCostServerSchema,
    2: cityCivicCostServerSchema,
    3: cityCivicCostServerSchema
  }).strict()
}).strict();
const cityMilitaryFacilityCostServerSchema = z.object({
  materials: z.array(z.object({
    itemId: wireStringSchema,
    quantity: wireIntegerSchema.positive()
  }).strict()).min(1).max(8),
  cityCoins: wireNonnegativeIntegerSchema
}).strict();
export const cityMarketDailyServerSchema = z.object({
  marketStructureId: wireStringSchema,
  marketLevel: wireIntegerSchema.min(1).max(10),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  cityCoins: wireNonnegativeIntegerSchema,
  glimmer: wireNonnegativeIntegerSchema,
  day: wireStringSchema,
  purchasedToday: wireBooleanSchema
}).strict();
export const cityAppSnapshotServerSchema = z.object({
  city: citySnapshotServerSchema.nullable(),
  membership: cityMembershipServerSchema.nullable(),
  municipality: wireStringSchema.nullable(),
  region: wireStringSchema.nullable(),
  country: wireStringSchema.nullable(),
  memberCount: wireNonnegativeIntegerSchema,
  house: wireObjectSchema.nullable(),
  oilWell: wireObjectSchema.nullable().optional(),
  quartzHut: wireObjectSchema.nullable().optional(),
  library: wireObjectSchema.nullable().optional(),
  marketDaily: cityMarketDailyServerSchema.nullable().optional(),
  structures: wireObjectArraySchema,
  treasuryBalance: wireStringSchema,
  lifetimeCoinsEarned: wireStringSchema,
  lifetimeCoinsSpent: wireStringSchema,
  playerContribution: wireStringSchema,
  playerContributionRank: wireNonnegativeIntegerSchema.nullable(),
  leaderboard: wireObjectArraySchema,
  ownLeaderboardEntry: wireObjectSchema.nullable(),
  warehouseUsedSlots: wireNonnegativeIntegerSchema,
  warehouseTotalSlots: wireNonnegativeIntegerSchema,
  warehouseCurrentWeightGrams: wireDecimalIntegerSchema.optional(),
  warehouseMaximumWeightGrams: wireDecimalIntegerSchema.optional(),
  facilityCosts: cityAppFacilityCostsServerSchema,
  militaryFacilityCosts: z.object({
    barracks: cityMilitaryFacilityCostServerSchema,
    demolition_factory: cityMilitaryFacilityCostServerSchema,
  }).strict().optional(),
  civicCosts: cityCivicCostsServerSchema,
  district: z.object({
    districtRevision: wireStringSchema,
    monuments: z.object({
      mining: cityDistrictMonumentServerSchema("mining"),
      forestry: cityDistrictMonumentServerSchema("forestry"),
      hunting: cityDistrictMonumentServerSchema("hunting")
    }).strict(),
    memberBenefit: cityDistrictBenefitServerSchema,
    standardBuyerTaxBps: z.number().int().min(0).max(10_000),
    specialtyBuyerTaxBps: z.number().int().min(0).max(10_000),
    specialtyDescriptions: z.object({
      mining: wireStringSchema.optional(),
      forestry: wireStringSchema.optional(),
      hunting: wireStringSchema.optional()
    }).strict()
  }).strict(),
  gold: cityGoldSnapshotServerSchema,
  founderClaimDeadline: wireStringSchema.nullable(),
  playerIsFounder: wireBooleanSchema,
  mayorVacant: wireBooleanSchema,
  mayorClaimAllowed: wireBooleanSchema,
  mayorClaimReason: wireStringSchema.nullable(),
  activeConstruction: z.object({
    operationKey: wireStringSchema,
    requestId: requestIdSchema,
    action: z.enum([
      "build_house",
      "build_oil_well",
      "build_quartz_hut",
      "build_library",
      "build_facility",
      "build_market",
      "build_monument",
      "upgrade_facility",
      "upgrade_monument"
    ]),
    structureId: wireStringSchema,
    anchor: latLonServerSchema,
    constructionStartedAt: wireStringSchema,
    constructionCompletesAt: wireStringSchema
  }).strict().nullable()
}).strict();
export const cityInfoServerSchema = z.object({
  city: citySnapshotServerSchema,
  memberCount: wireNonnegativeIntegerSchema,
  membership: cityMembershipServerSchema.nullable(),
  joinAllowed: wireBooleanSchema,
  joinReason: wireStringSchema.nullable(),
  mayorClaimAllowed: wireBooleanSchema,
  mayorClaimReason: wireStringSchema.nullable()
}).passthrough();
export const inventoryServerSchema = z.object({
  playerId: wireStringSchema,
  revision: wireNonnegativeIntegerSchema,
  items: z.array(z.object({
    playerId: wireStringSchema,
    resourceType: z.enum(INVENTORY_ITEM_TYPES),
    variant: wireStringSchema.nullable(),
    quantity: wireNonnegativeIntegerSchema,
    entryId: z.string().uuid().optional(),
    unitWeightGrams: wireNonnegativeIntegerSchema.optional(),
    totalWeightGrams: z.string().regex(/^\d+$/u).optional(),
    stackId: z.string().uuid().optional(),
    slotIndex: wireNonnegativeIntegerSchema.optional(),
    manualSplit: wireBooleanSchema.optional(),
    rodId: wireStringSchema.optional(),
    usesRemaining: wireNonnegativeIntegerSchema.max(FISHING_ROD_MAX_USES).optional(),
    look: z.string().min(1).max(80).optional(),
    equipped: wireBooleanSchema.optional(),
    provenance: z.object({ tag: z.string().regex(SHOP_TAG_PATTERN), originalBuyerName: z.string().min(1).max(80) }).strict().optional()
  }).passthrough()),
  currentWeightGrams: z.string().regex(/^\d+$/u).optional(),
  maximumWeightGrams: z.string().regex(/^\d+$/u).optional(),
  unlockedSlots: wireNonnegativeIntegerSchema.optional(),
  totals: z.object({
    wood: wireNonnegativeIntegerSchema,
    stone: wireNonnegativeIntegerSchema,
    coal: wireNonnegativeIntegerSchema,
    iron: wireNonnegativeIntegerSchema,
    sulfur: wireNonnegativeIntegerSchema,
    slag: wireNonnegativeIntegerSchema.optional(),
    food: wireNonnegativeIntegerSchema,
    ore: wireNonnegativeIntegerSchema,
    water: wireNonnegativeIntegerSchema,
    leather: wireNonnegativeIntegerSchema,
    giving_berry: wireNonnegativeIntegerSchema,
    balsam_resin: wireNonnegativeIntegerSchema,
    atlas_shrine_shard: wireNonnegativeIntegerSchema,
    enchantment_stone: wireNonnegativeIntegerSchema,
    fishing_rod: wireNonnegativeIntegerSchema.optional()
  }).passthrough()
}).passthrough();
export const collectibleNodeServerSchema = z.object({
  id: wireStringSchema,
  type: z.enum(RESOURCE_TYPES),
  lat: wireNumberSchema,
  lon: wireNumberSchema,
  quantity: wireNonnegativeIntegerSchema,
  state: z.enum(["available", "harvested"]),
  createdAt: wireStringSchema,
  harvestedAt: wireStringSchema.nullable(),
  sourceCellId: wireStringSchema,
  waterKind: z.enum(["fresh", "salt", "unknown"]).nullable(),
  presentationOwner: z.enum([
    "population",
    "repeatable-resource",
    "resource-vision"
  ]).optional(),
  repeatableNodeType: z.enum(REPEATABLE_RESOURCE_NODE_TYPES).optional(),
  repeatableState: z.enum(["ready", "depleted"]).optional(),
  repeatableReadyAt: wireStringSchema.nullable().optional(),
  repeatableTimerVisibility: z.enum(["visible", "redacted"]).optional(),
  repeatableRevision: wireNonnegativeIntegerSchema.optional(),
  treeLifeRevision: wireNonnegativeIntegerSchema.optional(),
  berryAvailable: wireBooleanSchema.optional(),
  resinAvailable: wireBooleanSchema.optional(),
  sapReadyAt: wireStringSchema.nullable().optional()
}).passthrough();
export const repeatableNodeServerSchema = z.object({
  id: wireStringSchema,
  nodeType: z.enum(REPEATABLE_RESOURCE_NODE_TYPES),
  lat: wireNumberSchema,
  lon: wireNumberSchema,
  yieldItemId: z.enum(RESOURCE_TYPES),
  yieldQuantity: wireNonnegativeIntegerSchema,
  state: z.enum(["ready", "depleted"]),
  authorityRevision: wireNonnegativeIntegerSchema,
  readyAt: wireStringSchema.nullable(),
  timerVisibility: z.enum(["visible", "redacted"])
}).passthrough();
export const resourceVisionServerSchema = z.object({
  flagId: wireStringSchema,
  flagName: wireStringSchema,
  destinationKind: z.enum(["flag", "kingdom_seat", "area"]).optional(),
  center: latLonServerSchema,
  movementLeashRadiusM: wireNumberSchema,
  paddingM: wireNumberSchema,
  radiusM: wireNumberSchema
}).passthrough();
export const resourceVisionStatusServerSchema = z.object({
  flagId: wireStringSchema,
  layoutVersion: wireStringSchema,
  status: z.enum(["pending", "generating", "ready", "failed"]),
  radiusM: wireNumberSchema,
  nodeCount: wireNonnegativeIntegerSchema,
  waterHighlightCount: wireNonnegativeIntegerSchema,
  requestedAt: wireStringSchema,
  generatedAt: wireStringSchema.nullable(),
  lastError: wireStringSchema.nullable(),
  updatedAt: wireStringSchema
}).passthrough();
export const harvestSessionServerSchema = z.object({
  sessionId: wireStringSchema,
  playerId: wireStringSchema,
  nodeId: wireStringSchema,
  resourceType: z.enum(RESOURCE_TYPES),
  operationKey: wireStringSchema,
  status: z.enum(["active", "completed", "cancelled", "expired"]),
  startedAt: wireStringSchema,
  completesAt: wireStringSchema,
  expiresAt: wireStringSchema,
  completedAt: wireStringSchema.nullable(),
  cancelledAt: wireStringSchema.nullable()
}).passthrough();
export const manorWorldServerSchema = z.object({
  manorId: wireStringSchema,
  ownerPlayerId: wireStringSchema,
  ownerUsername: wireStringSchema,
  regionCode: wireStringSchema,
  lat: wireNumberSchema,
  lon: wireNumberSchema,
  builtAt: wireStringSchema,
  placementRevision: wireNonnegativeIntegerSchema,
  manorTypeId: wireStringSchema.optional()
}).passthrough();
export const manorPositionServerSchema = z.object({
  x: wireNumberSchema,
  y: wireNumberSchema,
  targetX: wireNumberSchema.nullable(),
  targetY: wireNumberSchema.nullable(),
  moving: wireBooleanSchema,
  revision: wireNonnegativeIntegerSchema
}).passthrough();
export const populationEntityServerSchema = z.object({
  entityId: wireStringSchema,
  zoneId: wireStringSchema,
  // Production support is owned by the server Population V2 mob registry.
  // The wire contract validates a stable key shape so adding one registered
  // mob does not require another independently maintained protocol whitelist.
  kind: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/u),
  archetype: wireStringSchema,
  position: latLonServerSchema,
  homePosition: latLonServerSchema,
  stateRevision: wireNonnegativeIntegerSchema,
  berryAvailable: wireBooleanSchema.optional(),
  resinAvailable: wireBooleanSchema.optional(),
  sapReadyAt: wireStringSchema.nullable().optional()
}).passthrough();

export const worldViewAuthorityServerSchema = z.object({
  playerId: wireStringSchema,
  connectionId: wireStringSchema,
  connectionGeneration: wireNonnegativeIntegerSchema,
  relocationRevision: wireNonnegativeIntegerSchema,
  resourceVisionRevision: wireNonnegativeIntegerSchema,
  gameplayViewGeneration: wireNonnegativeIntegerSchema,
  populationPreparationGeneration: wireNonnegativeIntegerSchema
}).strict();

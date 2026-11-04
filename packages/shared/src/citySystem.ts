import type { HarvestAccessMode } from "./harvestAccess.js";
import type { ResourceType } from "./collectibles.js";
import type { CityMembershipSnapshot, CitySnapshot } from "./types.js";
import { DEFAULT_INTERACTION_RADIUS_M } from "./gameplayArea.js";
import type { CityMarketDailySnapshot } from "./cityMarketDaily.js";
import type { CityBuildingWarfareSnapshot } from "./cityStructureWarfare.js";

export const CITY_STRUCTURE_TYPES = [
  "city_house",
  "mayor_house",
  "oil_well",
  "quartz_hut",
  "library",
  "warehouse",
  "cistern_warrens",
  "salon",
  "city_kennel",
  "market",
  "monument",
  "barracks",
  "armory",
  "demolition_factory",
  "siege_workshop",
  "powder_works",
  "weaponsmith"
] as const;

export type CityStructureType = typeof CITY_STRUCTURE_TYPES[number];
export type LegacyCityStructureType = Extract<
  CityStructureType,
  "weaponsmith" | "armory" | "siege_workshop" | "powder_works"
>;
export type ActiveCityStructureType = Exclude<
  CityStructureType,
  LegacyCityStructureType
>;
export type CityStructureState = "constructing" | "active" | "destroyed";
export type CityFacilityType = "warehouse" | "cistern_warrens" | "salon" | "city_kennel";
export const MILITARY_FACILITY_TYPES = [
  "barracks",
  "demolition_factory"
] as const;
export type MilitaryFacilityType = typeof MILITARY_FACILITY_TYPES[number];
/**
 * The player-facing personal war-building catalog.  Keep this keyed by the
 * active roster so retired military structure aliases cannot leak into the
 * Construction > City catalog.
 */
export const MILITARY_FACILITY_CATALOG: Readonly<Record<
  MilitaryFacilityType,
  Readonly<{ title: string; description: string }>
>> = Object.freeze({
  barracks: Object.freeze({
    title: "Barracks",
    description: "Train Infantry and Archer units."
  }),
  demolition_factory: Object.freeze({
    title: "Demolition Factory",
    description: "Train Bombers and Siege; produce Torches and Repair Kits."
  })
});
/** Historical military facilities retained only for forward migration/data compatibility. */
export type LegacyMilitaryFacilityType = "armory" | "siege_workshop" | "powder_works";
export type CityFacilityBuildType = CityFacilityType | MilitaryFacilityType;
export const CITY_DISTRICT_TYPES = [
  "mining",
  "forestry",
  "hunting"
] as const;
export type CityDistrictType = typeof CITY_DISTRICT_TYPES[number];
export type CityMonumentTier = 1 | 2 | 3;

export const CITY_STRUCTURE_FOOTPRINT_RADIUS_M: Readonly<
  Record<ActiveCityStructureType, number>
> = {
  city_house: 10,
  mayor_house: 10,
  oil_well: 12,
  quartz_hut: 12,
  library: 16,
  warehouse: 18,
  cistern_warrens: 18,
  salon: 16,
  city_kennel: 16,
  market: 20,
  monument: 12,
  barracks: 18,
  demolition_factory: 22
};

export const CITY_HALL_FOOTPRINT_RADIUS_M = 20;
export const CITY_STRUCTURE_EXCLUSION_MARGIN_M = 150;
export const CITY_HOUSE_BUILD_DURATION_MS = 30_000;
export const OIL_WELL_BUILD_DURATION_MS = 30_000;
export const CITY_STRUCTURE_BUILD_DURATION_MS = 30_000;
export const CISTERN_WARRENS_BUILD_DURATION_MS = CITY_STRUCTURE_BUILD_DURATION_MS;
export const CITY_STRUCTURE_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
export const OIL_WELL_INTERACTION_RADIUS_M = 50;
export const OIL_WELL_OWNER_VISIBILITY_RADIUS_M = 1_500;
export const OIL_WELL_CAPACITY = 120;
export const OIL_WELL_PRODUCTION_PER_HOUR = 10;
export const OIL_WELL_UNIT_INTERVAL_MS = 6 * 60 * 1_000;
/*
 * Quartz Hut: a member's personal Crystal producer, mirroring the Oil Well
 * (one per player, inside their own city, same build time, interaction
 * radius, unit interval and lazy production). It has no tolls, remote access
 * or profession perks. HP and burn feed the city building warfare profile
 * (cityStructureWarfare.ts).
 */
export const QUARTZ_HUT_ITEM_ID = "crystal" as const;
export const QUARTZ_HUT_BUILD_DURATION_MS = OIL_WELL_BUILD_DURATION_MS;
export const QUARTZ_HUT_INTERACTION_RADIUS_M = OIL_WELL_INTERACTION_RADIUS_M;
export const QUARTZ_HUT_CAPACITY = 120;
export const QUARTZ_HUT_PRODUCTION_PER_HOUR = 10;
export const QUARTZ_HUT_UNIT_INTERVAL_MS = OIL_WELL_UNIT_INTERVAL_MS;
export const QUARTZ_HUT_MAXIMUM_HEALTH = 11_000;
export const QUARTZ_HUT_BURN_DURATION_MS = 68 * 60 * 60 * 1_000;
/** Personal resource producers: one per player, owner-collected. */
export const PERSONAL_PRODUCER_STRUCTURE_TYPES = ["oil_well", "quartz_hut"] as const;
export type PersonalProducerStructureType = typeof PERSONAL_PRODUCER_STRUCTURE_TYPES[number];
export function isPersonalProducerStructureType(
  type: string
): type is PersonalProducerStructureType {
  return type === "oil_well" || type === "quartz_hut";
}
/**
 * Library: a member's personal study hall (one per player, inside their own
 * city). It has no production state; studying is a separate gold flow
 * (library.ts). HP and burn feed the city building warfare profile.
 */
export const LIBRARY_BUILD_DURATION_MS = CITY_STRUCTURE_BUILD_DURATION_MS;
export const LIBRARY_INTERACTION_RADIUS_M = CITY_STRUCTURE_INTERACTION_RADIUS_M;
export const LIBRARY_MAXIMUM_HEALTH = 22_500;
export const LIBRARY_BURN_DURATION_MS = 28 * 60 * 60 * 1_000;
/** Personal buildings: owner-built structures; producers plus the Library. */
export const PERSONAL_BUILDING_STRUCTURE_TYPES = ["oil_well", "quartz_hut", "library"] as const;
export type PersonalBuildingStructureType = typeof PERSONAL_BUILDING_STRUCTURE_TYPES[number];
export function isPersonalBuildingStructureType(
  type: string
): type is PersonalBuildingStructureType {
  return type === "oil_well" || type === "quartz_hut" || type === "library";
}
export const CITY_WAREHOUSE_INTERACTION_RADIUS_M = CITY_STRUCTURE_INTERACTION_RADIUS_M;
export const CITY_MARKET_INTERACTION_RADIUS_M = CITY_STRUCTURE_INTERACTION_RADIUS_M;
export const CITY_STRUCTURE_SNAPSHOT_RADIUS_M = 25_000;
export const CITY_FOUNDER_MAYOR_CLAIM_WINDOW_MS = 15 * 60 * 1_000;
export const CITY_MARKET_STANDARD_BUYER_TAX_BPS = 900;
export const CITY_MARKET_SPECIALTY_BUYER_TAX_BPS = 450;

export const CITY_PHYSICAL_CONSTRUCTION_ACTIONS = [
  "build_house",
  "build_oil_well",
  "build_quartz_hut",
  "build_library",
  "build_facility",
  "build_market",
  "build_monument",
  "upgrade_facility",
  "upgrade_monument"
] as const;

export type CityPhysicalConstructionAction =
  typeof CITY_PHYSICAL_CONSTRUCTION_ACTIONS[number];

export function cityConstructionDurationMs(
  action: CityPhysicalConstructionAction
): number {
  return action === "build_house"
    ? CITY_HOUSE_BUILD_DURATION_MS
    : action === "build_oil_well"
      ? OIL_WELL_BUILD_DURATION_MS
      : action === "build_quartz_hut"
        ? QUARTZ_HUT_BUILD_DURATION_MS
        : action === "build_library"
          ? LIBRARY_BUILD_DURATION_MS
      : CITY_STRUCTURE_BUILD_DURATION_MS;
}

export type CityMaterialCost = Readonly<{
  materials: readonly Readonly<{ itemId: ResourceType; quantity: number }>[];
  cityCoins: number;
  cityGold?: number;
}>;

export const CITY_HOUSE_COST: CityMaterialCost = {
  materials: [
    { itemId: "wood", quantity: 28 },
    { itemId: "stone", quantity: 14 }
  ],
  cityCoins: 0
};

export const OIL_WELL_COST: CityMaterialCost = {
  materials: [
    { itemId: "wood", quantity: 225 },
    { itemId: "stone", quantity: 30 },
    { itemId: "balsam_resin", quantity: 110 }
  ],
  cityCoins: 0
};

export const QUARTZ_HUT_COST: CityMaterialCost = {
  materials: [
    { itemId: "wood", quantity: 230 },
    { itemId: "stone", quantity: 30 },
    { itemId: "sulfur", quantity: 90 }
  ],
  cityCoins: 0
};

/** Library: stone and wood from existing resources (2:1 ratio, scaled to our house cost). */
export const LIBRARY_COST: CityMaterialCost = {
  materials: [
    { itemId: "stone", quantity: 110 },
    { itemId: "wood", quantity: 55 }
  ],
  cityCoins: 0
};

export const CITY_FACILITY_COSTS: Readonly<
  Record<CityFacilityType, Readonly<Record<1 | 2 | 3, CityMaterialCost>>>
> = {
  warehouse: {
    1: {
      materials: [
        { itemId: "wood", quantity: 110 },
        { itemId: "stone", quantity: 70 }
      ],
      cityCoins: 110
    },
    2: {
      materials: [
        { itemId: "wood", quantity: 185 },
        { itemId: "stone", quantity: 12 }
      ],
      cityCoins: 450
    },
    3: {
      materials: [
        { itemId: "wood", quantity: 430 },
        { itemId: "stone", quantity: 12 }
      ],
      cityCoins: 1_400
    }
  },
  cistern_warrens: {
    1: {
      materials: [
        { itemId: "wood", quantity: 140 },
        { itemId: "stone", quantity: 160 }
      ],
      cityCoins: 275
    },
    2: {
      materials: [],
      cityCoins: 0
    },
    3: {
      materials: [],
      cityCoins: 0
    }
  },
  salon: {
    1: {
      materials: [
        { itemId: "wood", quantity: 90 },
        { itemId: "stone", quantity: 55 }
      ],
      cityCoins: 120
    },
    2: { materials: [], cityCoins: 0 },
    3: { materials: [], cityCoins: 0 }
  },
  city_kennel: {
    1: {
      materials: [
        { itemId: "wood", quantity: 95 },
        { itemId: "stone", quantity: 45 }
      ],
      cityCoins: 90
    },
    2: { materials: [], cityCoins: 0 },
    3: { materials: [], cityCoins: 0 }
  }
};

export const CITY_WAREHOUSE_SLOTS_BY_TIER: Readonly<Record<1 | 2 | 3, number>> = {
  1: 64,
  2: 105,
  3: 150
};

export type CityCivicCost = Readonly<{
  materials: readonly Readonly<{ itemId: "wood" | "stone"; quantity: number }>[];
  cityCoins: number;
  cityGold: number;
}>;

export const CITY_MONUMENT_COSTS: Readonly<
  Record<CityMonumentTier, CityCivicCost>
> = {
  1: {
    materials: [
      { itemId: "wood", quantity: 230 },
      { itemId: "stone", quantity: 55 }
    ],
    cityCoins: 950,
    cityGold: 900
  },
  2: {
    materials: [
      { itemId: "wood", quantity: 260 },
      { itemId: "stone", quantity: 55 }
    ],
    cityCoins: 1_100,
    cityGold: 1_000
  },
  3: {
    materials: [
      { itemId: "wood", quantity: 280 },
      { itemId: "stone", quantity: 60 }
    ],
    cityCoins: 1_200,
    cityGold: 1_100
  }
};

export const CITY_MARKET_COST: CityCivicCost = {
  materials: [
    { itemId: "wood", quantity: 275 },
    { itemId: "stone", quantity: 45 }
  ],
  cityCoins: 1_100,
  cityGold: 4_400
};

/*
 * City Market levels (war part B3). The market's city_structures tier IS its
 * level: built at level 1, upgraded through the facility upgrade up to 10.
 * Upgrading to level n costs the build's materials and City Coins times n
 * (our choice). City Gold is left out: the build's 4,400 is already the
 * whole City Gold capacity, so a scaled Gold cost could never be held.
 * Each level opens one City Tower slot in the city; existing towers over the
 * cap stay, only new City Tower upgrades are refused.
 */
export const CITY_MARKET_MAX_LEVEL = 10;

/** The Market level for its structure tier (the two are the same number). */
export function cityMarketLevel(tier: number): number {
  return Number.isSafeInteger(tier) && tier >= 1 ? Math.min(tier, CITY_MARKET_MAX_LEVEL) : 0;
}

/** The cost to upgrade the Market to `level` (2..10); null outside that range. */
export function cityMarketUpgradeCost(level: number): CityMaterialCost | null {
  if (!Number.isSafeInteger(level) || level < 2 || level > CITY_MARKET_MAX_LEVEL) return null;
  return {
    materials: CITY_MARKET_COST.materials.map(({ itemId, quantity }) => ({ itemId, quantity: quantity * level })),
    cityCoins: CITY_MARKET_COST.cityCoins * level
  };
}

/** City Tower slots from a Market level: one per level, up to 10. */
export function cityTowerSlotCapacity(marketLevel: number): number {
  return Math.max(0, Math.min(CITY_MARKET_MAX_LEVEL, Math.floor(marketLevel)));
}

export type CityTowerSlotsSnapshot = Readonly<{
  marketLevel: number;
  /** Standing City Towers in the city. */
  used: number;
  capacity: number;
}>;

export const CITY_GOLD_CAPACITY = Math.max(
  CITY_MARKET_COST.cityGold,
  ...Object.values(CITY_MONUMENT_COSTS).map(({ cityGold }) => cityGold)
);

export const CITY_DISTRICT_GATHERING_CHANCE_BY_TIER: Readonly<
  Record<CityMonumentTier, number>
> = {
  1: 0.01,
  2: 0.02,
  3: 0.03
};

export type CityDistrictBenefitSnapshot = Readonly<{
  cityId: string | null;
  monumentTiers: Readonly<Record<CityDistrictType, CityMonumentTier | null>>;
  districtRevision: string;
  miningExtraYieldChance: number;
  forestryExtraYieldChance: number;
  directMobDamageBonus: number;
  mobDefenseBonus: number;
  resinPreservationChance: number;
}>;

export const EMPTY_CITY_DISTRICT_BENEFIT: CityDistrictBenefitSnapshot = {
  cityId: null,
  monumentTiers: {
    mining: null,
    forestry: null,
    hunting: null
  },
  districtRevision: "0",
  miningExtraYieldChance: 0,
  forestryExtraYieldChance: 0,
  directMobDamageBonus: 0,
  mobDefenseBonus: 0,
  resinPreservationChance: 0
};

export type CityStructureSnapshot = Readonly<{
  structureId: string;
  cityId: string;
  cityControllerKind?: "player" | "npc";
  cityCulture?: "human" | "goblin";
  type: CityStructureType;
  /** Warehouse 1-3, Monument 1-3, City Market 1-10 (its level); others 1. */
  tier: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  districtType: CityDistrictType | null;
  ownerPlayerId: string | null;
  ownerUsername?: string | null;
  worldId: string;
  regionCode: string | null;
  lat: number;
  lon: number;
  footprintRadiusM: number;
  placementRevision: string;
  state: CityStructureState;
  constructionStartedAt: string | null;
  constructionCompletesAt: string | null;
  builtAt: string | null;
  upgradedAt: string | null;
  destroyedAt: string | null;
  harvestAccessMode?: HarvestAccessMode | null;
  harvestAccessRevision?: string;
  /** War health, burning and repair; absent for buildings without health. */
  warfare?: CityBuildingWarfareSnapshot | null;
}>;

export function cityStructureExclusionRadiusM(footprintRadiusM: number): number {
  return footprintRadiusM + CITY_STRUCTURE_EXCLUSION_MARGIN_M;
}

export function cityStructureRequiredCenterDistanceM(
  proposedFootprintRadiusM: number,
  blockingFootprintRadiusM: number
): number {
  return cityStructureExclusionRadiusM(proposedFootprintRadiusM) +
    cityStructureExclusionRadiusM(blockingFootprintRadiusM);
}

export type CityWarehouseStackSnapshot = Readonly<{
  stackId: string;
  slotIndex: number;
  itemId: ResourceType;
  variant: string | null;
  quantity: number;
  /** Authoritative runtime limit supplied by the server item catalog. */
  maxStack?: number;
  version: string;
}>;

export type CityWarehouseSnapshot = Readonly<{
  cityId: string;
  structureId: string;
  cityName: string;
  tier: 1 | 2 | 3;
  /** Decimal integer grams; storage capacity is weight authority. */
  currentWeightGrams?: string;
  maximumWeightGrams?: string;
  /** Historical compatibility projections; never gate storage. */
  usedSlots: number;
  totalSlots: number;
  revision: string;
  canReorganize: boolean;
  stacks: CityWarehouseStackSnapshot[];
  gold: CityGoldSnapshot;
}>;

export type CityGoldDonationSnapshot = Readonly<{
  playerId: string;
  username: string;
  amount: string;
  donatedAt: string;
}>;

export type CityGoldSnapshot = Readonly<{
  balance: string;
  capacity: string;
  remainingCapacity: string;
  lifetimeDonated: string;
  lifetimeSpent: string;
  revision: string;
  canDonate: boolean;
  recentDonations: CityGoldDonationSnapshot[];
}>;

export type CityDistrictMonumentSnapshot = Readonly<{
  districtType: CityDistrictType;
  structureId: string | null;
  status: "inactive" | "constructing" | "active";
  tier: CityMonumentTier | null;
}>;

export type CityDistrictSnapshot = Readonly<{
  districtRevision: string;
  monuments: Readonly<Record<CityDistrictType, CityDistrictMonumentSnapshot>>;
  memberBenefit: CityDistrictBenefitSnapshot;
  standardBuyerTaxBps: number;
  specialtyBuyerTaxBps: number;
  specialtyDescriptions: Readonly<Partial<Record<CityDistrictType, string>>>;
}>;

export type CityCivicCostsSnapshot = Readonly<{
  market: CityCivicCost;
  monument: typeof CITY_MONUMENT_COSTS;
}>;

export type CityContributionEntry = Readonly<{
  rank: number;
  playerId: string;
  username: string;
  contributed: string;
  currentMember: boolean;
}>;

export type CityAppSnapshot = Readonly<{
  city: CitySnapshot | null;
  membership: CityMembershipSnapshot | null;
  municipality: string | null;
  region: string | null;
  country: string | null;
  memberCount: number;
  house: CityStructureSnapshot | null;
  oilWell?: CityStructureSnapshot | null;
  quartzHut?: CityStructureSnapshot | null;
  library?: CityStructureSnapshot | null;
  structures: CityStructureSnapshot[];
  treasuryBalance: string;
  lifetimeCoinsEarned: string;
  lifetimeCoinsSpent: string;
  playerContribution: string;
  playerContributionRank: number | null;
  leaderboard: CityContributionEntry[];
  ownLeaderboardEntry: CityContributionEntry | null;
  warehouseUsedSlots: number;
  warehouseTotalSlots: number;
  /** Decimal integer grams; warehouse capacity is weight authority. */
  warehouseCurrentWeightGrams?: string;
  warehouseMaximumWeightGrams?: string;
  facilityCosts: typeof CITY_FACILITY_COSTS;
  militaryFacilityCosts?: Readonly<Record<MilitaryFacilityType, CityMaterialCost>>;
  civicCosts: CityCivicCostsSnapshot;
  district: CityDistrictSnapshot;
  gold: CityGoldSnapshot;
  /** The City Market's daily Glimmer-for-City-Coins package for the viewer; null without an active Market. */
  marketDaily?: CityMarketDailySnapshot | null;
  founderClaimDeadline: string | null;
  playerIsFounder: boolean;
  mayorVacant: boolean;
  mayorClaimAllowed: boolean;
  mayorClaimReason: string | null;
  activeConstruction: CityActiveConstructionSnapshot | null;
  /** City Tower slots from the Market level; absent from older servers. */
  cityTowerSlots?: CityTowerSlotsSnapshot;
}>;

export type GoblinMarketLine = Readonly<{
  kind: "resource" | "equipment" | "backpack";
  identity: string;
  displayName: string;
  quantity: number;
  offerGold: string;
}>;

export type GoblinMarketBuyLine = Readonly<{
  kind: "resource";
  itemId: "wheat_seed";
  identity: "wheat_seed";
  displayName: string;
  quantity: number;
  unitPriceGold: string;
}>;

export type GoblinMarketSnapshot = Readonly<{
  cityId: string;
  cityName: string;
  marketStructureId: string;
  relation: "neutral" | "enemy";
  lines: GoblinMarketLine[];
  buyLines: GoblinMarketBuyLine[];
}>;

/**
 * A personal producer (Oil Well or Quartz Hut). storedCrudeOil holds the
 * stored units of resourceItemId; absent structureType means an Oil Well.
 */
export type OilWellSnapshot = Readonly<{
  structureId: string;
  structureType?: PersonalBuildingStructureType;
  resourceItemId?: "crude_oil" | typeof QUARTZ_HUT_ITEM_ID;
  ownerPlayerId: string;
  ownerUsername: string;
  storedCrudeOil: number;
  capacity: number;
  productionPerHour: number;
  serverTime: number;
  nextUnitAt: string | null;
  fullAt?: string | null;
  canHarvest: boolean;
  canDestroy: boolean;
  accessMode?: HarvestAccessMode;
  accessRevision?: string;
  tollGold?: string;
  isOwner?: boolean;
}>;

export type CityActiveConstructionSnapshot = Readonly<{
  operationKey: string;
  requestId: string;
  action: CityPhysicalConstructionAction;
  structureId: string;
  anchor: Readonly<{ lat: number; lon: number }>;
  constructionStartedAt: string;
  constructionCompletesAt: string;
}>;

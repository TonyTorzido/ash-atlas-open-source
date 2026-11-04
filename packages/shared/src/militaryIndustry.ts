import type { ResourceType } from "./collectibles.js";
import type { MilitaryFacilityType } from "./citySystem.js";
import { MELEE_ATTACK_RANGE_M, RANGED_ATTACK_RANGE_M } from "./combatConstants.js";
import { DEFAULT_INTERACTION_RADIUS_M } from "./gameplayArea.js";
import { KINGDOM_PERK_WATCHFIRES_RECOVERY_MULTIPLIER } from "./kingdomPerks.js";
import { TOWER_ATTACK_RANGE_M } from "./structureWarfare.js";
import type { LatLon } from "./types.js";

/** Shared, server-authoritative military production and field contracts. */
export const LODGE_LEVELS = [1, 2, 3, 4, 5] as const;
export type LodgeLevel = typeof LODGE_LEVELS[number];

export const LODGE_CAPACITY_BY_LEVEL: Readonly<Record<LodgeLevel, number>> = Object.freeze({
  1: 2,
  2: 4,
  3: 6,
  4: 8,
  5: 10
});

export type MilitaryMaterialCost = Readonly<{
  materials: readonly Readonly<{ itemId: ResourceType; quantity: number }>[];
  cityCoins: number;
}>;

/** Common foundational material costs; no rare or boss materials are used. */
export const LODGE_COSTS: Readonly<Record<LodgeLevel, MilitaryMaterialCost>> = Object.freeze({
  1: Object.freeze({
    materials: Object.freeze([
      { itemId: "wood", quantity: 50 },
      { itemId: "stone", quantity: 25 },
      { itemId: "leather", quantity: 5 },
      { itemId: "cloth", quantity: 5 }
    ] as const),
    cityCoins: 0
  }),
  2: Object.freeze({
    materials: Object.freeze([
      { itemId: "wood", quantity: 75 },
      { itemId: "stone", quantity: 40 },
      { itemId: "leather", quantity: 8 },
      { itemId: "cloth", quantity: 8 }
    ] as const),
    cityCoins: 0
  }),
  3: Object.freeze({
    materials: Object.freeze([
      { itemId: "wood", quantity: 100 },
      { itemId: "stone", quantity: 60 },
      { itemId: "iron_bar", quantity: 5 },
      { itemId: "leather", quantity: 12 },
      { itemId: "cloth", quantity: 12 }
    ] as const),
    cityCoins: 0
  }),
  4: Object.freeze({
    materials: Object.freeze([
      { itemId: "wood", quantity: 150 },
      { itemId: "stone", quantity: 90 },
      { itemId: "iron_bar", quantity: 10 },
      { itemId: "leather", quantity: 16 },
      { itemId: "cloth", quantity: 16 }
    ] as const),
    cityCoins: 0
  }),
  5: Object.freeze({
    materials: Object.freeze([
      { itemId: "wood", quantity: 200 },
      { itemId: "stone", quantity: 120 },
      { itemId: "iron_bar", quantity: 15 },
      { itemId: "leather", quantity: 20 },
      { itemId: "cloth", quantity: 20 }
    ] as const),
    cityCoins: 0
  })
});

export const LODGE_FOOTPRINT_RADIUS_M = 10;
export const LODGE_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
export const LODGE_SNAPSHOT_RADIUS_M = 50_000;
export const LODGE_OUTDOOR_CLEARANCE_M = 30;

export const MILITARY_CITY_FACILITY_COSTS: Readonly<
  Record<MilitaryFacilityType, MilitaryMaterialCost>
> = Object.freeze({
  barracks: Object.freeze({
    materials: Object.freeze([
      { itemId: "wood", quantity: 250 },
      { itemId: "stone", quantity: 200 },
      { itemId: "iron_bar", quantity: 10 },
      { itemId: "leather", quantity: 10 },
      { itemId: "cloth", quantity: 10 }
    ] as const),
    cityCoins: 500
  }),
  demolition_factory: Object.freeze({
    materials: Object.freeze([
      { itemId: "iron_bar", quantity: 100 },
      { itemId: "sulfur", quantity: 100 },
      { itemId: "cloth", quantity: 200 },
      { itemId: "wood", quantity: 500 }
    ] as const),
    cityCoins: 0
  })
});

export const MILITARY_FACILITY_QUEUE_CAPACITY = 5;
export const MILITARY_MAX_FUSION_SIZE = 6;
/** Maximum distance between compatible player-owned groups during fusion. */
export const MILITARY_FUSION_RANGE_M = 1_000;
export const MILITARY_UNIT_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
/** Canonical maximum world distance for a deployed Siege volley. */
export const SIEGE_ATTACK_RANGE_METERS = 575;
/**
 * Numerical tolerance for the inclusive Siege boundary. WGS84 destination
 * round-trips can differ by a few floating-point ulps; this keeps the shared
 * 575m contract exact without widening the gameplay range in any material
 * way.
 */
export const SIEGE_ATTACK_RANGE_TOLERANCE_METERS = 1e-6;

export function isWithinSiegeAttackRange(distanceM: number): boolean {
  return Number.isFinite(distanceM) &&
    distanceM <= SIEGE_ATTACK_RANGE_METERS + SIEGE_ATTACK_RANGE_TOLERANCE_METERS;
}
/**
 * Minimum Siege placement distance from a city or kingdom target by fusion
 * level 1..6. Personal Towers keep the area volley with no
 * minimum distance.
 */
export const SIEGE_ORGANIZATION_MINIMUM_PLACEMENT_M_BY_FUSION = Object.freeze([
  140, 205, 281, 334, 419, 477
] as const);

export function siegeOrganizationMinimumPlacementMeters(fusionLevel: number): number {
  const level = Math.min(
    SIEGE_ORGANIZATION_MINIMUM_PLACEMENT_M_BY_FUSION.length,
    Math.max(1, Math.floor(Number.isFinite(fusionLevel) ? fusionLevel : 1))
  );
  return SIEGE_ORGANIZATION_MINIMUM_PLACEMENT_M_BY_FUSION[level - 1]!;
}
/** Tower firing range; the tower volley rules live in structureWarfare.ts. */
export const TOWER_ATTACK_RANGE_METERS = TOWER_ATTACK_RANGE_M;
/** Canonical following formation distance measured from the owner's position. */
export const MILITARY_FOLLOW_DISTANCE_M = 125;
/** Stable lateral spacing between separate groups in a follow formation. */
export const MILITARY_FOLLOW_FORMATION_SPACING_M = 50;
/** Follow movement runs at this fraction of the canonical player movement speed. */
export const MILITARY_FOLLOW_SPEED_RATIO = 0.7;
/** @deprecated Use MILITARY_FOLLOW_DISTANCE_M. */
export const MILITARY_FOLLOW_OFFSET_M = MILITARY_FOLLOW_DISTANCE_M;
/** Authoritative server duration for packing a deployed Siege back into field state. */
export const SIEGE_PACK_UP_DURATION_MS = 30_000;
export const MILITARY_RALLY_DURATION_MS = 45_000;
export const MILITARY_BOMBER_CHANNEL_DURATION_MS = 5_000;
/** One authoritative Siege volley every 75 seconds once the cadence is due. */
export const MILITARY_BALLISTA_VOLLEY_CADENCE_MS = 75_000;
export const MILITARY_HUMAN_RECOVERY_DURATION_MS = 20 * 60_000;
/** Recovery time of a defeated human unit; The Watchfires' buff stretches it for the enemy. */
export function militaryHumanRecoveryDurationMs(watchfiresDelay: boolean): number {
  return watchfiresDelay
    ? Math.round(MILITARY_HUMAN_RECOVERY_DURATION_MS * KINGDOM_PERK_WATCHFIRES_RECOVERY_MULTIPLIER)
    : MILITARY_HUMAN_RECOVERY_DURATION_MS;
}
export const MILITARY_BALLISTA_REPAIR_AMOUNT = 50;
export const MILITARY_BALLISTA_REPAIR_COST = Object.freeze({
  repairKit: 1,
  wood: 10,
  ironBar: 1
});
export const MILITARY_WAR_CAMP_RELOCATION_COOLDOWN_MS = 24 * 60 * 60_000;
export const MILITARY_WAR_CAMP_FOOTPRINT_RADIUS_M = 8;
export const MILITARY_WAR_CAMP_OUTDOOR_CLEARANCE_M = 30;
export const MILITARY_WAR_CAMP_COST = Object.freeze({
  materials: Object.freeze([
    { itemId: "crude_oil" as const, quantity: 230 },
    { itemId: "crystal" as const, quantity: 85 },
    { itemId: "iron" as const, quantity: 4 }
  ]),
  cityCoins: 0
});

export const MILITARY_UNIT_TYPES = [
  "infantry",
  "archer",
  "bomber",
  "field_ballista"
] as const;
export type MilitaryUnitType = typeof MILITARY_UNIT_TYPES[number];

/** Canonical player-facing names for military groups and their fusion level. */
export function militaryUnitDisplayName(unitType: MilitaryUnitType): string {
  switch (unitType) {
    case "field_ballista":
      return "Kippen Siege";
    case "bomber":
      return "Kippen Bomber";
    case "infantry":
      return "Kippen Melee";
    case "archer":
      return "Kippen Archer";
  }
}

export function militaryGroupDisplayName(
  unitType: MilitaryUnitType,
  survivingMembers: number
): string {
  const safeLevel = Number.isSafeInteger(survivingMembers)
    ? Math.min(MILITARY_MAX_FUSION_SIZE, Math.max(1, survivingMembers))
    : 1;
  return `${militaryUnitDisplayName(unitType)} +${safeLevel}`;
}

/**
 * Stable presentation hooks for the roster/map renderer. Production art can
 * replace these keys without changing unit identity or protocol contracts.
 */
export const MILITARY_ART_HOOKS: Readonly<Record<
  MilitaryUnitType | "war_camp" | "fusion_badge",
  Readonly<{ assetKey: string; fallbackKey: string }>
>> = Object.freeze({
  infantry: Object.freeze({ assetKey: "military/units/infantry.png", fallbackKey: "unit-silhouette" }),
  archer: Object.freeze({ assetKey: "military/units/archer.png", fallbackKey: "unit-silhouette" }),
  bomber: Object.freeze({ assetKey: "military/units/bomber.png", fallbackKey: "unit-silhouette" }),
  field_ballista: Object.freeze({ assetKey: "military/units/field-ballista-crew.png", fallbackKey: "ballista-with-crew-silhouette" }),
  war_camp: Object.freeze({ assetKey: "military/war-camp.png", fallbackKey: "camp-marker" }),
  fusion_badge: Object.freeze({ assetKey: "military/fusion-count-badge.png", fallbackKey: "count-badge" })
});

export const MILITARY_UNIT_MAX_HP: Readonly<Record<MilitaryUnitType, number>> = Object.freeze({
  infantry: 100,
  archer: 80,
  bomber: 60,
  field_ballista: 150
});

/** Ordinary anti-personnel damage. Siege structural damage is separate. */
export const MILITARY_UNIT_ATTACK_DAMAGE: Readonly<Record<MilitaryUnitType, number>> = Object.freeze({
  infantry: 11,
  archer: 9,
  bomber: 2,
  field_ballista: 0
});

/** Ordinary combat range; Ballistas use their structure-only volley path. */
export const MILITARY_UNIT_ATTACK_RANGE_M: Readonly<Record<MilitaryUnitType, number>> = Object.freeze({
  infantry: MELEE_ATTACK_RANGE_M,
  archer: RANGED_ATTACK_RANGE_M,
  bomber: MELEE_ATTACK_RANGE_M,
  field_ballista: 0
});

export type MilitaryOrdinaryAttackProfile = Readonly<{
  unitType: Exclude<MilitaryUnitType, "field_ballista">;
  damagePerMember: number;
  rangeM: number;
  sourceTechniqueId: string;
}>;

/** Returns the one-shot ordinary attack profile for a combat-capable unit. */
export function militaryOrdinaryAttackProfile(
  unitType: MilitaryUnitType
): MilitaryOrdinaryAttackProfile | null {
  if (unitType === "field_ballista") return null;
  return Object.freeze({
    unitType,
    damagePerMember: MILITARY_UNIT_ATTACK_DAMAGE[unitType],
    rangeM: MILITARY_UNIT_ATTACK_RANGE_M[unitType],
    sourceTechniqueId: `military_${unitType}_basic_attack`
  });
}

/** Aggregate surviving underlying members without creating a second combat model. */
export function planMilitaryGroupAttack(
  unitType: MilitaryUnitType,
  survivingMembers: number,
  /** Flat attack added per member (Picked Legion). */
  attackBonusPerMember = 0
): Readonly<{
  memberCount: number;
  damage: number;
  rangeM: number;
  sourceTechniqueId: string;
}> | null {
  if (!Number.isSafeInteger(survivingMembers) || survivingMembers < 1) return null;
  const profile = militaryOrdinaryAttackProfile(unitType);
  if (!profile) return null;
  return Object.freeze({
    memberCount: survivingMembers,
    damage: (profile.damagePerMember + Math.max(0, attackBonusPerMember)) * survivingMembers,
    rangeM: profile.rangeM,
    sourceTechniqueId: profile.sourceTechniqueId
  });
}

export type MilitaryUnitRecipe = Readonly<{
  unitType: MilitaryUnitType;
  facility: "barracks" | "demolition_factory";
  durationMs: number;
  materials: readonly Readonly<{ itemId: ResourceType; quantity: number }>[];
  gold: number;
}>;

export const MILITARY_UNIT_RECIPES: Readonly<Record<MilitaryUnitType, MilitaryUnitRecipe>> = Object.freeze({
  infantry: Object.freeze({
    unitType: "infantry", facility: "barracks", durationMs: 60_000, gold: 50,
    materials: Object.freeze([
      { itemId: "simple_food", quantity: 50 }, { itemId: "wood", quantity: 50 }, { itemId: "leather", quantity: 25 }
    ] as const)
  }),
  archer: Object.freeze({
    unitType: "archer", facility: "barracks", durationMs: 75_000, gold: 75,
    materials: Object.freeze([
      { itemId: "simple_food", quantity: 50 }, { itemId: "wood", quantity: 75 }, { itemId: "cloth", quantity: 25 }
    ] as const)
  }),
  bomber: Object.freeze({
    unitType: "bomber", facility: "demolition_factory", durationMs: 90_000, gold: 0,
    // The crude_oil line is the base price; see bomberCrudeOilCost for the owned-bomber surcharge.
    materials: Object.freeze([
      { itemId: "simple_food", quantity: 100 }, { itemId: "sulfur", quantity: 6 },
      { itemId: "crude_oil", quantity: 55 }
    ] as const)
  }),
  field_ballista: Object.freeze({
    unitType: "field_ballista", facility: "demolition_factory", durationMs: 120_000, gold: 250,
    materials: Object.freeze([
      { itemId: "simple_food", quantity: 100 }, { itemId: "iron_bar", quantity: 25 },
      { itemId: "wood", quantity: 150 }, { itemId: "cloth", quantity: 75 }
    ] as const)
  })
});

/** Crude oil for the next bomber: 55 + 45 per bomber already owned (alive or in training). */
export const BOMBER_CRUDE_OIL_BASE = 55;
export const BOMBER_CRUDE_OIL_PER_OWNED = 45;
export function bomberCrudeOilCost(ownedBombers: number, quantity = 1): number {
  const owned = Math.max(0, Math.floor(ownedBombers));
  const count = Math.max(0, Math.floor(quantity));
  return count * (BOMBER_CRUDE_OIL_BASE + BOMBER_CRUDE_OIL_PER_OWNED * owned) +
    BOMBER_CRUDE_OIL_PER_OWNED * (count * (count - 1)) / 2;
}

/** Full structural damage contributed by each surviving fusion level. */
export const BALLISTA_STRUCTURAL_DAMAGE_PER_FUSION_LEVEL = 7;
/** @deprecated Use BALLISTA_STRUCTURAL_DAMAGE_PER_FUSION_LEVEL. */
export const BALLISTA_STRUCTURAL_DAMAGE_PER_MEMBER = BALLISTA_STRUCTURAL_DAMAGE_PER_FUSION_LEVEL;

/**
 * Computes one bounded Ballista volley without ever damaging below breach.
 * The second argument is the authoritative fusion level (the number of
 * surviving Ballista members in the group), and the optional threshold lets
 * Towers use their higher breach boundary without changing Siege cadence.
 */
export function planBallistaStructuralDamage(
  currentHealth: number,
  underlyingBallistas: number,
  breachThreshold = 100
): number {
  const threshold = Number.isFinite(breachThreshold) ? Math.max(0, Math.floor(breachThreshold)) : 100;
  return Math.min(
    Math.max(0, Math.floor(currentHealth) - threshold),
    BALLISTA_STRUCTURAL_DAMAGE_PER_FUSION_LEVEL * Math.max(0, Math.floor(underlyingBallistas))
  );
}

export type MilitaryUnitStatus = "available" | "recovering" | "destroyed";
/** Durable server-owned movement intent for a player-commanded field group. */
export type MilitaryGroupMovementOrder = "NONE" | "FOLLOW_PLAYER" | "MOVE_TO_COORDINATE";
export type MilitaryUnitLocationState =
  | "STATIONED_CITY"
  | "STATIONED_WAR_CAMP"
  | "PACKED_FIELD"
  | "FOLLOWING_PLAYER"
  | "DEPLOYED_FIELD"
  | "PACKING_UP"
  | "RECOVERING";

export type MilitaryUnitSnapshot = Readonly<{
  unitId: string;
  ownerPlayerId: string;
  unitType: MilitaryUnitType;
  homeCityId: string | null;
  currentHp: number;
  maxHp: number;
  status: MilitaryUnitStatus;
  locationState: MilitaryUnitLocationState;
  stationCityId: string | null;
  warCampId: string | null;
  lat: number | null;
  lon: number | null;
  groupId: string | null;
  nextRecoveryAt: string | null;
  nextFireAt: string | null;
  targetFlagId: string | null;
  /** Server snapshots always include these; optional keeps older persisted
   * client fixtures/source snapshots wire-compatible during rollout. */
  movementOrder?: MilitaryGroupMovementOrder;
  movementTarget?: LatLon | null;
  packingCompletesAt: string | null;
  revision: string;
  createdAt: string;
}>;

export type MilitaryUnitGroupSnapshot = Readonly<{
  groupId: string;
  ownerPlayerId: string;
  unitType: MilitaryUnitType;
  memberUnitIds: readonly string[];
  memberCount: number;
  currentHp: number;
  maxHp: number;
  locationState: MilitaryUnitLocationState;
  stationCityId: string | null;
  warCampId: string | null;
  lat: number | null;
  lon: number | null;
  targetFlagId: string | null;
  /** A Siege's city-building target (war part C3); absent from older servers. */
  targetCityStructureId?: string | null;
  nextFireAt: string | null;
  packingCompletesAt: string | null;
  /** Server snapshots always include these; optional for legacy clients. */
  movementOrder?: MilitaryGroupMovementOrder;
  movementTarget?: LatLon | null;
  revision: string;
}>;

export type WarCampSnapshot = Readonly<{
  campId: string;
  ownerPlayerId: string;
  worldId: string;
  regionCode: string;
  lat: number;
  lon: number;
  placementRevision: string;
  builtAt: string;
  removedAt: string | null;
  relocationAvailableAt: string | null;
  /** War Camp health (2,200 max); absent from older servers. */
  health?: number;
  maximumHealth?: number;
  /** End of the 1 h burn once the camp reached its burn threshold; null when not burning. */
  burningUntil?: string | null;
  /** Owner's display name, for other players' camps. */
  ownerName?: string | null;
}>;

export type MilitaryBomberChannelSnapshot = Readonly<{
  requestId: string;
  groupId: string;
  targetFlagId: string;
  /** "city_structure" when targetFlagId names a city building. */
  targetKind?: "flag" | "city_structure";
  startedAt: string;
  completesAt: string;
}>;

/** Authoritative occurrence of a Siege volley for presentation-only cues. */
export type MilitarySiegeVolleyCue = Readonly<{
  groupId: string;
  occurredAt: number;
}>;
/** Sent once after committed demolition; never inferred from a channel deadline. */
export type MilitaryBomberDetonationCue = Readonly<{
  requestId: string;
  groupId: string;
  occurredAt: number;
  position: Readonly<{ lat: number; lon: number }>;
  targetPosition: Readonly<{ lat: number; lon: number }>;
}>;
export const SIEGE_CREW_CAPACITY_COST = 2;
export const SIEGE_CREW_TRAINING_DURATION_MS = 60_000;
export const SIEGE_CREW_TRAINING_COST = Object.freeze({
  food: 3,
  gold: 100,
  cloth: 2,
  leather: 2
});

export const ARMORY_REPAIR_KIT_DURATION_MS = 5_000;
export const ARMORY_REPAIR_KIT_MAX_BATCH = 20;
export const ARMORY_REPAIR_KIT_INPUTS = Object.freeze([
  Object.freeze({ itemId: "chitin" as const, quantity: 2 }),
  Object.freeze({ itemId: "balsam_resin" as const, quantity: 1 })
]);

export const POWDER_WORKS_TORCH_DURATION_MS = 5_000;
export const POWDER_WORKS_TORCH_MAX_BATCH = 10;
/** The canonical personal torch recipe: 10 Coal + 100 Crude Oil = 25 Torches. */
export const POWDER_WORKS_TORCH_INPUTS = Object.freeze([
  Object.freeze({ itemId: "coal" as const, quantity: 10 }),
  Object.freeze({ itemId: "crude_oil" as const, quantity: 100 })
]);
export const POWDER_WORKS_TORCH_OUTPUT_QUANTITY = 25;

export const MILITARY_PERSONNEL_TYPES = ["siege_crew"] as const;
export type MilitaryPersonnelType = typeof MILITARY_PERSONNEL_TYPES[number];
export type MilitaryPersonnelStatus = "training" | "available" | "assigned" | "recovering";

export const MILITARY_JOB_TYPES = [
  "train_siege_crew",
  "train_infantry",
  "train_archer",
  "train_bomber",
  "manufacture_field_ballista",
  "repair_kit_batch",
  "torch_batch",
  "field_ballista_kit"
] as const;
export type MilitaryJobType = typeof MILITARY_JOB_TYPES[number];

export type LodgeSnapshot = Readonly<{
  lodgeId: string;
  ownerPlayerId: string;
  worldId: string;
  regionCode: string;
  lat: number;
  lon: number;
  level: LodgeLevel;
  capacity: number;
  occupiedCapacity: number;
  reservedCapacity: number;
  placementRevision: string;
  builtAt: string;
  upgradedAt: string | null;
}>;

export type PersonnelSnapshot = Readonly<{
  personnelId: string;
  ownerPlayerId: string;
  personnelType: MilitaryPersonnelType;
  capacityCost: number;
  status: MilitaryPersonnelStatus;
  createdAt: string;
  assignmentReference: string | null;
  revision: string;
}>;

export type MilitaryJobSnapshot = Readonly<{
  jobId: string;
  facilityStructureId: string;
  ownerPlayerId: string;
  jobType: MilitaryJobType;
  quantity: number;
  outputQuantity: number;
  collectedQuantity: number;
  startedAt: string;
  completesAt: string;
  productionFinished: boolean;
  readyQuantity: number;
}>;

export type MilitaryIndustrySnapshot = Readonly<{
  lodge: LodgeSnapshot | null;
  personnel: readonly PersonnelSnapshot[];
  units: readonly MilitaryUnitSnapshot[];
  groups: readonly MilitaryUnitGroupSnapshot[];
  /** Other players' deployed Siege groups currently inside the viewer's vision. */
  visibleGroups?: readonly MilitaryUnitGroupSnapshot[];
  warCamp: WarCampSnapshot | null;
  /** Other players' standing War Camps inside the viewer's vision (attack targets). */
  visibleWarCamps?: readonly WarCampSnapshot[];
  bomberChannel?: MilitaryBomberChannelSnapshot | null;
  jobs: readonly MilitaryJobSnapshot[];
  queueCapacity: number;
  /** Crude oil the next bomber costs right now (see bomberCrudeOilCost). */
  bomberCrudeOilPrice?: number;
  serverTime: number;
  fieldBallistaKitEnabled: false;
  fieldBallistaEnabled: true;
}>;

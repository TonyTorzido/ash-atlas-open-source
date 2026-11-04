import { randomUUID } from "node:crypto";

import { cityTowerSlotsSnapshot } from "./cityTowerSlots.js";
import type {
  CityAppSnapshot,
  CityConstructionAction,
  CityConstructionContribution,
  CityConstructionPhase,
  CityFoundingPreview,
  CityInfoSnapshot,
  CityMembershipSnapshot,
  CitySnapshot,
  CityStructureSnapshot,
  CityDistrictSnapshot,
  CityGoldSnapshot,
  LatLon,
  NearestMunicipalitySnapshot,
  PlayerInventorySnapshot,
  SettlementClass
} from "@ash-atlas/shared";
import {
  CITY_FACILITY_COSTS,
  CITY_DISTRICT_TYPES,
  CITY_GOLD_CAPACITY,
  CITY_MARKET_COST,
  CITY_MARKET_SPECIALTY_BUYER_TAX_BPS,
  MILITARY_CITY_FACILITY_COSTS,
  CITY_MARKET_STANDARD_BUYER_TAX_BPS,
  CITY_MONUMENT_COSTS,
  EMPTY_CITY_DISTRICT_BENEFIT,
  CITY_WAREHOUSE_CAPACITY_GRAMS,
  CITY_WAREHOUSE_SLOTS_BY_TIER,
  STRATEGIC_VISION_RADIUS_M,
  TERRITORY_EDGE_TOLERANCE_M,
  classifyFlagPlacementTerrain,
  WORLD_EDGE_MESSAGE,
  isWithinWorldEdge,
  distanceMeters,
  WORLD_MAP_CAPITAL_ANCHOR,
  WORLD_MAP_CAPITAL_NAME,
  type DeveloperCapitalFoundingPlan,
  type DeveloperCapitalExcludedReason,
  type DeveloperCapitalSkipReason,
  type DeveloperCapitalStructureType
} from "@ash-atlas/shared";
import type pg from "pg";

import { MAX_FLAG_CLAIM_RADIUS_M, type AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { WORLD_RUNTIME_CONTRACT } from "../runtime/authorityIdentity.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type {
  SettlementAuthorityIdentity,
  SettlementLookupResult,
  WorldGameplayEnvironmentResult,
  WorldSettlement
} from "../world/worldTypes.js";
import {
  CITY_FOUNDING_EXPANSION_COUNT,
  buildCityFoundingLayoutCandidates,
  resolveCityFoundingLayout,
  type CityFoundingLayoutCandidate,
  type CityFoundingResolvedLayout
} from "./cityFoundingLayout.js";
import { prepareFlagEnvironmentPersistence } from "./flagEnvironmentPersistence.js";
import {
  beginTerritoryCollapseInTransaction,
  breakTerritoryFlagsInTransaction,
  type TerritoryCollapseBegun
} from "./territoryCollapse.js";
import {
  FLAG_CONTROL_TOUCH_TOLERANCE_M,
  findForeignOrganizationConnection,
  isPersonalFlagControlledByPlayer,
  lockFlagControlGeometry
} from "./flagControlGeometry.js";
import type { PlayerRecord } from "./state.js";
import type { InventoryService } from "./inventory.js";
import type { CityFlagService } from "./flagServiceContracts.js";
import { WalletOperationError, type WalletService } from "./wallet.js";
import {
  CityStructureService,
  lockPlayerAndCity,
  type CityHouseMutationResult
} from "./cityStructures.js";
import {
  developerCapitalConnectedNodes,
  developerCapitalFlagSlots,
  developerCapitalSeatCandidates
} from "./developerCapitalLayout.js";
import { CityTreasuryService } from "./cityTreasury.js";
import { CityWarehouseService } from "./cityWarehouse.js";
import { CityDistrictBenefitService } from "./cityDistrictBenefits.js";
import { MilitaryIndustryService } from "./militaryIndustry.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type SettlementPreviewCacheEntry = {
  lookup: SettlementLookupResult;
  expiresAt: number;
};

export type CityServiceOptions = {
  settlementAuthority?: () => SettlementAuthorityIdentity;
  now?: () => number;
  positivePreviewTtlMs?: number;
  negativePreviewTtlMs?: number;
  previewCacheMaxEntries?: number;
  inventory?: Pick<
    InventoryService,
    | "debitItemsForOperationInTransaction"
    | "grantItemsForOperationInTransaction"
    | "snapshotInTransaction"
  >;
  wallet?: Pick<
    WalletService,
    "debitForOperationInTransaction" | "snapshotInTransaction"
  >;
  flagService?: CityFlagService;
};

const DEFAULT_SETTLEMENT_AUTHORITY = WORLD_RUNTIME_CONTRACT.settlementAuthority;
const DEFAULT_POSITIVE_PREVIEW_TTL_MS = 45_000;
const DEFAULT_NEGATIVE_PREVIEW_TTL_MS = 10_000;
const DEFAULT_PREVIEW_CACHE_MAX_ENTRIES = 256;

type CityRow = {
  id: string;
  world_id: string;
  canonical_municipality_id: string;
  world_settlement_id: string;
  world_settlement_source: string;
  world_source_settlement_id: string;
  settlement_class: string | null;
  settlement_release_id: string | null;
  settlement_release_fingerprint: string | null;
  settlement_founding_policy_id: string | null;
  settlement_founding_policy_fingerprint: string | null;
  settlement_resolution_policy_id: string | null;
  settlement_resolution_policy_fingerprint: string | null;
  name: string;
  controller_kind: "player" | "npc";
  culture: "human" | "goblin";
  banner_color: string;
  country_code: string;
  region_code: string | null;
  founder_player_id: string;
  founder_username?: string | null;
  founder_color?: string | null;
  mayor_player_id: string | null;
  mayor_house_deadline: Date | string | null;
  mayor_confirmed_at: Date | string | null;
  mayor_username?: string | null;
  mayor_color?: string | null;
  seat_flag_id: string;
  hall_lat: number;
  hall_lon: number;
  founding_annex_radius_m: number;
  active: boolean;
  jumpable: boolean;
  construction_phase: CityConstructionPhase;
  construction_completed_at: Date | string | null;
  construction_contributions: Array<{
    playerId: string;
    stage: CityConstructionContribution["stage"];
    contributedAt: string;
  }>;
  spatial_revision: string | number;
  created_at: Date | string;
};

type CityFlagRow = {
  id: string;
  anchor_kind: "flag" | "buoy";
  owner_id: string;
  owner_username: string | null;
  owner_color: string;
  control_type: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
  name: string;
  lat: number;
  lon: number;
  claim_radius_m: number;
  city_id: string | null;
  kingdom_id: string | null;
  reinforcement_level: number;
  distance_m: number;
  lifecycle_revision: string;
};

type MembershipRow = {
  city_id: string;
  city_name: string;
  role: "mayor" | "member";
  joined_at: Date | string;
  house_structure_id: string;
  member_count: string;
  expansion_flag_count: string;
};

type CityLifecycleReason = "destroyed" | "abandoned";

export const CITY_BASE_EXPANSION_FLAG_LIMIT = 6;
export const CITY_EXPANSION_FLAGS_PER_ADDITIONAL_MEMBER = 5;

export function cityExpansionFlagLimit(memberCount: number): number {
  return CITY_BASE_EXPANSION_FLAG_LIMIT +
    CITY_EXPANSION_FLAGS_PER_ADDITIONAL_MEMBER * Math.max(0, memberCount - 1);
}

type CityCapacity = {
  memberCount: number;
  expansionFlagCount: number;
  expansionFlagLimit: number;
};

export type FoundCityResult = {
  city: CitySnapshot;
  seatFlagId: string;
  territoryFlagIds: string[];
  annexedFlags: Array<{ flagId: string; previousOwnerPlayerId: string }>;
  replayed: boolean;
};

export type DeveloperCapitalFoundingResult = {
  dryRun: boolean;
  replayed: boolean;
  plan: DeveloperCapitalFoundingPlan;
  city: CitySnapshot | null;
  territoryFlagIds: string[];
  structures: CityStructureSnapshot[];
  membership: CityMembershipSnapshot | null;
  leftHouse: CityHouseMutationResult | null;
};

export type AdvanceCityConstructionResult = {
  action: CityConstructionAction;
  city: CitySnapshot;
  replayed: boolean;
  inventory?: PlayerInventorySnapshot;
  walletGold?: string;
  walletVersion?: string;
};

export type CityJoinResult = {
  info: CityInfoSnapshot;
  membership: CityMembershipSnapshot;
  replayed: boolean;
};

export type CityLeaveResult = {
  info: CityInfoSnapshot;
  cityId: string;
  replayed: boolean;
};

export type CityFlagConversionResult = {
  cityId: string;
  flagId: string;
  memberCount: number;
  expansionFlagCount: number;
  expansionFlagLimit: number;
  replayed: boolean;
};

export type CityFlagConversionOptions = {
  /**
   * Server-derived developer:world-mutate authority. Skips the per-city expansion
   * flag cap only; CITY_FLAG_NETWORK_LIMIT and every placement rule still apply.
   */
  exemptFromExpansionLimit?: boolean;
};

export type CityFlagConversionPreview = {
  cityId: string;
  cityName: string;
  flagId: string;
  flagName: string;
  position: LatLon;
};

export type CityMayorResult = {
  city: CitySnapshot;
  structure?: CityStructureSnapshot;
  membership?: CityMembershipSnapshot | null;
  replayed: boolean;
};

export type CityFoundingErrorCode =
  | "CITY_BOUNDARY_AUTHORITY_UNAVAILABLE"
  | "CITY_NO_MUNICIPALITY_HERE"
  | "CITY_MUNICIPALITY_TYPE_INELIGIBLE"
  | "CITY_MUNICIPALITY_POPULATION_INELIGIBLE"
  | "CITY_MUNICIPALITY_ALREADY_FOUNDED"
  | "CITY_FOUNDING_FLAG_REQUIRED"
  | "CITY_FOUNDING_FLAG_NOT_CONTROLLED"
  | "CITY_FOUNDING_OUTSIDE_TERRITORY"
  | "CITY_INCOMPATIBLE_AFFILIATION"
  | "CITY_REQUIREMENTS_MISSING"
  | "CITY_NOT_FOUND"
  | "CITY_ALREADY_MEMBER"
  | "CITY_NOT_MEMBER"
  | "CITY_MAYOR_MUST_RELINQUISH"
  | "CITY_MAYOR_ALREADY_CLAIMED"
  | "CITY_MAYOR_REQUIRED_MEMBERSHIP"
  | "CITY_MAYOR_PERMISSION_DENIED"
  | "CITY_FLAG_NOT_CONNECTED"
  | "CITY_FLAG_FOREIGN_CONNECTION"
  | "CITY_FLAG_ALREADY_CONTROLLED"
  | "CITY_FLAG_LIFECYCLE_CHANGED"
  | "CITY_EXPANSION_LIMIT_REACHED"
  | "CITY_FLAG_NETWORK_LIMIT"
  | "CITY_FLAG_RELEASE_OVERLAP"
  | "CITY_FLAG_CONTROL_CHANGED"
  | "CITY_FLAG_ATLAS_SHRINE_INELIGIBLE"
  | "CITY_FLAG_KIND_UNSUPPORTED"
  | "CITY_WORLD_EDGE"
  | "CITY_FULL_FOOTPRINT_UNAVAILABLE"
  | "CITY_PERMISSION_DENIED"
  | "CITY_PLAYER_REQUIRED"
  | "CITY_REQUEST_CONFLICT"
  | "CITY_HOUSE_REQUIRED"
  | "CITY_CONSTRUCTION_UNAVAILABLE"
  | "CITY_CONSTRUCTION_PHASE_MISMATCH"
  | "CITY_CONSTRUCTION_ACTOR_ALREADY_CONTRIBUTED"
  | "CITY_CONSTRUCTION_INSUFFICIENT_STONE"
  | "CITY_CONSTRUCTION_INSUFFICIENT_WOOD"
  | "CITY_CONSTRUCTION_INSUFFICIENT_GOLD";

export class CityFoundingError extends Error {
  constructor(
    readonly code: CityFoundingErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CityFoundingError";
  }
}

export class CityService {
  private readonly settlementPreviewCache = new Map<string, SettlementPreviewCacheEntry>();
  private readonly settlementPreviewFlights = new Map<string, Promise<SettlementLookupResult>>();
  private readonly settlementAuthority: () => SettlementAuthorityIdentity;
  private readonly now: () => number;
  private readonly positivePreviewTtlMs: number;
  private readonly negativePreviewTtlMs: number;
  private readonly previewCacheMaxEntries: number;
  readonly structures: CityStructureService | null;
  readonly militaryIndustry: MilitaryIndustryService | null;
  readonly districtBenefits: CityDistrictBenefitService;
  private readonly inventory: CityServiceOptions["inventory"];
  private readonly wallet: CityServiceOptions["wallet"];

  constructor(
    private readonly pool: pg.Pool,
    private readonly worldLookup: WorldLookupClient,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    options: CityServiceOptions = {}
  ) {
    this.districtBenefits = new CityDistrictBenefitService(pool);
    this.inventory = options.inventory;
    this.wallet = options.wallet;
    this.settlementAuthority = options.settlementAuthority ?? (() => DEFAULT_SETTLEMENT_AUTHORITY);
    this.now = options.now ?? Date.now;
    this.positivePreviewTtlMs = Math.max(
      1,
      options.positivePreviewTtlMs ?? DEFAULT_POSITIVE_PREVIEW_TTL_MS
    );
    this.negativePreviewTtlMs = Math.max(
      1,
      options.negativePreviewTtlMs ?? DEFAULT_NEGATIVE_PREVIEW_TTL_MS
    );
    this.previewCacheMaxEntries = Math.max(
      1,
      options.previewCacheMaxEntries ?? DEFAULT_PREVIEW_CACHE_MAX_ENTRIES
    );
    if (options.inventory) {
      const treasury = new CityTreasuryService(pool);
      const warehouse = new CityWarehouseService(pool, options.inventory);
      this.structures = new CityStructureService(
        pool,
        config.WORLD_ID,
        options.inventory,
        treasury,
        warehouse,
        worldLookup
      );
      this.militaryIndustry = new MilitaryIndustryService(
        pool,
        config.WORLD_ID,
        options.inventory,
        undefined,
        options.flagService
          ? options.flagService.deleteFlagForBomberInTransaction.bind(options.flagService)
          : undefined,
        config.PLAYER_SPEED_MPS,
        options.flagService
          ? options.flagService.deleteFlagForBurnInTransaction.bind(options.flagService)
          : undefined
      );
    } else {
      this.structures = null;
      this.militaryIndustry = null;
    }
  }

  async listCitiesNear(
    position: { lat: number; lon: number },
    radiusM = this.config.CITY_SNAPSHOT_RADIUS_M,
    limit = this.config.CITY_SNAPSHOT_LIMIT
  ): Promise<CitySnapshot[]> {
    await this.structures?.reconcileExpiredFounderClaimDeadlines();
    const visibleRadiusM = Math.min(radiusM, STRATEGIC_VISION_RADIUS_M);
    const result = await this.pool.query<CityRow>(
      `${CITY_SELECT}
       WHERE c.world_id = $5 AND c.active AND ST_DWithin(
         c.hall_geom::geography,
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         $3
       )
       ORDER BY ST_Distance(
         c.hall_geom::geography,
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
       ), c.id
       LIMIT $4`,
      [
        position.lon,
        position.lat,
        visibleRadiusM,
        Math.min(Math.max(limit, 1), 1_000),
        this.config.WORLD_ID
      ]
    );
    return result.rows.map(rowToCity);
  }

  async getCity(cityId: string): Promise<CitySnapshot | null> {
    await this.structures?.reconcileExpiredFounderClaimDeadlines();
    const result = await this.pool.query<CityRow>(
      `${CITY_SELECT} WHERE c.id = $1 AND c.world_id = $2 AND c.active`,
      [cityId, this.config.WORLD_ID]
    );
    return result.rows[0] ? rowToCity(result.rows[0]) : null;
  }

  async getMembership(playerId: string): Promise<CityMembershipSnapshot | null> {
    return loadMembership(this.pool, playerId, this.config.WORLD_ID);
  }

  async getCityInfo(playerId: string, cityId: string): Promise<CityInfoSnapshot> {
    const city = await this.getCity(cityId);
    if (!city) throw new CityFoundingError("CITY_NOT_FOUND", "City does not exist in this world");
    const [membership, capacity] = await Promise.all([
      loadMembership(this.pool, playerId, this.config.WORLD_ID),
      loadCityCapacity(this.pool, cityId)
    ]);
    const sameCity = membership?.cityId === cityId;
    const founderReservationActive = city.founderMayorClaimDeadline !== null;
    const joinReason = sameCity
      ? "You are already a member of this city"
      : city.constructionPhase !== "complete"
        ? "Complete city construction before building a City House."
      : membership
        ? `You are already a member of ${membership.cityName}. Leave that city before joining ${city.name}.`
        : "Build a City House on this city’s land to become a member.";
    const mayorClaimReason = city.mayorPlayerId
      ? `${city.mayorUsername ?? "Another player"} is the current Mayor`
      : city.constructionPhase !== "complete"
        ? "Complete city construction before building a City House"
      : founderReservationActive && city.founderPlayerId !== playerId
        ? "The founder still has the exclusive Mayor claim reservation"
      : sameCity
        ? null
        : "Build a City House in this city, then use the City app to become Mayor";
    return {
      city,
      memberCount: capacity.memberCount,
      expansionFlagCount: capacity.expansionFlagCount,
      expansionFlagLimit: capacity.expansionFlagLimit,
      membership: sameCity ? membership : null,
      joinAllowed: false,
      joinReason,
      mayorClaimAllowed:
        city.mayorPlayerId === null &&
        sameCity &&
        (!founderReservationActive || city.founderPlayerId === playerId),
      mayorClaimReason
    };
  }

  async getCityApp(playerId: string): Promise<CityAppSnapshot> {
    const [activeConstruction, oilWell, quartzHut, library] = await Promise.all([
      this.structures?.activeConstructionForPlayer(playerId) ?? null,
      this.structures?.getOilWellForOwner(playerId) ?? null,
      this.structures?.getOilWellForOwner(playerId, "quartz_hut") ?? null,
      this.structures?.getOilWellForOwner(playerId, "library") ?? null
    ]);
    const membership = await this.getMembership(playerId);
    if (!membership) {
      const pendingHouse =
        await this.structures?.getConstructingHouseForOwner(playerId) ?? null;
      const founderReservation = pendingHouse
        ? null
        : await this.pool.query<{ id: string }>(
          `SELECT id::text
           FROM cities
           WHERE founder_player_id=$1 AND world_id=$2 AND active
             AND mayor_player_id IS NULL
             AND (
               construction_phase <> 'complete'
               OR mayor_house_deadline > clock_timestamp()
             )
           ORDER BY created_at DESC,id
           LIMIT 1`,
          [playerId, this.config.WORLD_ID]
        );
      const visibleCityId = pendingHouse?.cityId ?? founderReservation?.rows[0]?.id ?? null;
      if (visibleCityId) {
        const city = await this.getCity(visibleCityId);
        if (city) {
          const structures = await this.structures?.listForCity(city.id) ?? [];
          const [district, gold] = await Promise.all([
            loadCityDistrictSnapshot(
              this.pool,
              this.districtBenefits,
              city.id,
              null
            ),
            this.structures?.gold.snapshot(city.id, null) ??
              Promise.resolve(emptyCityGold())
          ]);
          const founderReservationActive = city.founderMayorClaimDeadline !== null;
          const founderOwnsReservation =
            founderReservationActive && city.founderPlayerId === playerId;
          return {
            city,
            membership: null,
            municipality: city.name,
            region: city.regionCode,
            country: city.countryCode,
            memberCount: 0,
            house: pendingHouse,
            oilWell,
            quartzHut,
            library,
            structures,
            treasuryBalance: "0",
            lifetimeCoinsEarned: "0",
            lifetimeCoinsSpent: "0",
            playerContribution: "0",
            playerContributionRank: null,
            leaderboard: [],
            ownLeaderboardEntry: null,
            warehouseUsedSlots: 0,
            warehouseTotalSlots: 0,
            warehouseCurrentWeightGrams: "0",
            warehouseMaximumWeightGrams: CITY_WAREHOUSE_CAPACITY_GRAMS.toString(),
            facilityCosts: CITY_FACILITY_COSTS,
            militaryFacilityCosts: MILITARY_CITY_FACILITY_COSTS,
            civicCosts: {
              market: CITY_MARKET_COST,
              monument: CITY_MONUMENT_COSTS
            },
            district,
            gold,
            founderClaimDeadline: city.founderMayorClaimDeadline,
            playerIsFounder: city.founderPlayerId === playerId,
            mayorVacant: city.mayorPlayerId === null,
            mayorClaimAllowed: false,
            mayorClaimReason: city.constructionPhase !== "complete"
              ? "Complete city construction before building a City House"
              : founderOwnsReservation
              ? pendingHouse
                ? "Your City House must finish construction before you can claim Mayor"
                : "Build an active City House before the founder reservation expires"
              : founderReservationActive
                ? "The founder still has the exclusive Mayor claim reservation"
                : "An active City House membership is required",
            activeConstruction
          };
        }
      }
      return {
        city: null,
        membership: null,
        municipality: null,
        region: null,
        country: null,
        memberCount: 0,
        house: null,
        oilWell,
        quartzHut,
        library,
        structures: [],
        treasuryBalance: "0",
        lifetimeCoinsEarned: "0",
        lifetimeCoinsSpent: "0",
        playerContribution: "0",
        playerContributionRank: null,
        leaderboard: [],
        ownLeaderboardEntry: null,
        warehouseUsedSlots: 0,
        warehouseTotalSlots: 0,
        warehouseCurrentWeightGrams: "0",
        warehouseMaximumWeightGrams: CITY_WAREHOUSE_CAPACITY_GRAMS.toString(),
        facilityCosts: CITY_FACILITY_COSTS,
        militaryFacilityCosts: MILITARY_CITY_FACILITY_COSTS,
        civicCosts: {
          market: CITY_MARKET_COST,
          monument: CITY_MONUMENT_COSTS
        },
        district: emptyCityDistrict(),
        gold: emptyCityGold(),
        founderClaimDeadline: null,
        playerIsFounder: false,
        mayorVacant: true,
        mayorClaimAllowed: false,
        mayorClaimReason: "An active City House membership is required",
        activeConstruction
      };
    }
    const structuresService = this.requireStructures();
    await structuresService.reconcileExpiredFounderClaimDeadlines();
    const city = await this.getCity(membership.cityId);
    if (!city) throw new CityFoundingError("CITY_NOT_FOUND", "City no longer exists");
    const [structures, treasury, leaderboard, capacity, warehouseUsage, district, gold, marketDaily, cityTowerSlots] = await Promise.all([
      structuresService.listForCity(city.id),
      structuresService.treasury.snapshot(city.id),
      structuresService.treasury.leaderboard(city.id, playerId),
      loadCityCapacity(this.pool, city.id),
      this.pool.query<{ used_slots: string; weight: string }>(
        `SELECT count(*)::text AS used_slots,
                COALESCE(sum(stack.quantity::numeric * definition.unit_weight_grams),0)::text AS weight
         FROM city_warehouse_stacks stack
         JOIN item_definitions definition ON definition.item_id=stack.item_id
         WHERE stack.city_id=$1`,
        [city.id]
      ),
      loadCityDistrictSnapshot(
        this.pool,
        this.districtBenefits,
        city.id,
        playerId
      ),
      structuresService.gold.snapshot(city.id, null),
      structuresService.marketDaily.snapshot(city.id, playerId),
      cityTowerSlotsSnapshot(this.pool, city.id)
    ]);
    const house = structures.find((structure) => structure.structureId === membership.houseStructureId) ?? null;
    const warehouse = structures.find((structure) => structure.type === "warehouse") ?? null;
    const founderReservationActive = city.founderMayorClaimDeadline !== null;
    const mayorClaimAllowed =
      city.mayorPlayerId === null &&
      house?.state === "active" &&
      (!founderReservationActive || city.founderPlayerId === playerId);
    const mayorClaimReason = city.mayorPlayerId
      ? `${city.mayorUsername ?? "Another player"} is the current Mayor`
      : founderReservationActive && city.founderPlayerId !== playerId
        ? "The founder still has the exclusive Mayor claim reservation"
        : house?.state !== "active"
          ? "An active City House is required"
          : null;
    return {
      city,
      membership,
      municipality: city.name,
      region: city.regionCode,
      country: city.countryCode,
      memberCount: capacity.memberCount,
      house,
      oilWell,
      quartzHut,
      library,
      structures,
      treasuryBalance: treasury.balance,
      lifetimeCoinsEarned: treasury.lifetimeEarned,
      lifetimeCoinsSpent: treasury.lifetimeSpent,
      playerContribution: leaderboard.own?.contributed ?? "0",
      playerContributionRank: leaderboard.own?.rank ?? null,
      leaderboard: leaderboard.entries,
      ownLeaderboardEntry:
        leaderboard.own && !leaderboard.entries.some((entry) => entry.playerId === playerId)
          ? leaderboard.own
          : null,
      warehouseUsedSlots: Number(warehouseUsage.rows[0]?.used_slots ?? 0),
      warehouseTotalSlots: warehouse
        ? CITY_WAREHOUSE_SLOTS_BY_TIER[warehouse.tier as 1 | 2 | 3]
        : 0,
      warehouseCurrentWeightGrams: warehouseUsage.rows[0]?.weight ?? "0",
      warehouseMaximumWeightGrams: CITY_WAREHOUSE_CAPACITY_GRAMS.toString(),
      facilityCosts: CITY_FACILITY_COSTS,
      militaryFacilityCosts: MILITARY_CITY_FACILITY_COSTS,
      civicCosts: {
        market: CITY_MARKET_COST,
        monument: CITY_MONUMENT_COSTS
      },
      district,
      gold,
      marketDaily,
      founderClaimDeadline: city.founderMayorClaimDeadline,
      playerIsFounder: city.founderPlayerId === playerId,
      mayorVacant: city.mayorPlayerId === null,
      mayorClaimAllowed,
      mayorClaimReason,
      activeConstruction,
      cityTowerSlots
    };
  }

  private requireStructures(): CityStructureService {
    if (!this.structures) {
      throw new CityFoundingError(
        "CITY_HOUSE_REQUIRED",
        "The City House system is unavailable"
      );
    }
    return this.structures;
  }

  async previewFounding(player: PlayerRecord, flagId: string): Promise<CityFoundingPreview> {
    const flag = await resolveFoundingFlag(this.pool, player, flagId, false);
    const hallPosition = { lat: Number(flag.lat), lon: Number(flag.lon) };
    const lookup = await this.lookupMunicipality(player.playerId, flag, hallPosition);
    const affiliation = await activeAffiliation(
      this.pool,
      player.playerId,
      this.config.WORLD_ID
    );
    if (!lookup.found) {
      return {
        flag: foundingFlagSnapshot(flag),
        hallPosition,
        municipality: null,
        nearestMunicipality: nearestSnapshot(lookup),
        eligible: false,
        reasonCode: "CITY_NO_MUNICIPALITY_HERE",
        reason: outsideMunicipalityMessage(lookup),
        materialCost: 0
      };
    }
    if (!lookup.settlement.foundingEligible) {
      const ineligibility = municipalityFoundingIneligibility(lookup.settlement);
      return {
        flag: foundingFlagSnapshot(flag),
        hallPosition,
        municipality: municipalitySnapshot(lookup.settlement),
        nearestMunicipality: null,
        eligible: false,
        reasonCode: ineligibility.code,
        reason: ineligibility.message,
        materialCost: 0
      };
    }
    const claimed = await this.pool.query(
      `SELECT 1 FROM cities
       WHERE world_id = $1 AND canonical_municipality_id = $2
       LIMIT 1`,
      [this.config.WORLD_ID, lookup.settlement.settlementId]
    );
    const reason = claimed.rowCount
      ? `${municipalityLabel(lookup.settlement)} has already been founded in this world`
      : affiliation
        ? affiliation
        : null;
    return {
      flag: foundingFlagSnapshot(flag),
      hallPosition,
      municipality: municipalitySnapshot(lookup.settlement),
      nearestMunicipality: null,
      eligible: reason === null,
      reasonCode: claimed.rowCount
        ? "CITY_MUNICIPALITY_ALREADY_FOUNDED"
        : affiliation
          ? "CITY_INCOMPATIBLE_AFFILIATION"
          : null,
      reason,
      materialCost: 0
    };
  }

  async foundCity(
    player: PlayerRecord,
    input: { requestId: string; flagId: string }
  ): Promise<FoundCityResult> {
    const replay = await this.findFoundingReplay(this.pool, player.playerId, input.requestId);
    if (replay) return replay;

    const capturedPlayer = { ...player, position: { ...player.position } };
    const preflightFlag = await resolveFoundingFlag(
      this.pool, capturedPlayer, input.flagId, false
    );
    const hallPosition = {
      lat: Number(preflightFlag.lat),
      lon: Number(preflightFlag.lon)
    };
    if (!isWithinWorldEdge(hallPosition)) {
      throw new CityFoundingError("CITY_WORLD_EDGE", WORLD_EDGE_MESSAGE);
    }
    const lookup = await this.lookupMunicipality(
      player.playerId, preflightFlag, hallPosition
    );
    if (!lookup.found) {
      throw new CityFoundingError(
        "CITY_NO_MUNICIPALITY_HERE",
        outsideMunicipalityMessage(lookup),
        { nearestMunicipality: nearestSnapshot(lookup) }
      );
    }
    if (!lookup.settlement.foundingEligible) {
      const ineligibility = municipalityFoundingIneligibility(lookup.settlement);
      throw new CityFoundingError(
        ineligibility.code,
        ineligibility.message,
        ineligibility.details
      );
    }
    const footprintWorld = await this.prepareFoundingFootprint(preflightFlag);

    const client = await this.pool.connect();
    const foundingSettlement: WorldSettlement = lookup.settlement;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [player.playerId]);
      await lockFlagControlGeometry(client);

      const lockedReplay = await this.findFoundingReplay(client, player.playerId, input.requestId);
      if (lockedReplay) {
        await client.query("COMMIT");
        return lockedReplay;
      }
      const affiliation = await activeAffiliation(
        client,
        player.playerId,
        this.config.WORLD_ID
      );
      if (affiliation) {
        throw new CityFoundingError("CITY_INCOMPATIBLE_AFFILIATION", affiliation);
      }
      const flag = await resolveFoundingFlag(client, capturedPlayer, input.flagId, true);
      assertFoundingFlagUnchanged(preflightFlag, flag);
      const municipalityType = lookup.settlement.settlementClass;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `city-municipality:${this.config.WORLD_ID}:${lookup.settlement.settlementId}`
      ]);
      if (await findForeignOrganizationConnection(client, flag.id, null, null)) {
        throw new CityFoundingError(
          "CITY_FLAG_FOREIGN_CONNECTION",
          "A City Center cannot connect to an existing city or Kingdom"
        );
      }
      const claimed = await client.query(
        `SELECT 1 FROM cities
         WHERE world_id = $1 AND canonical_municipality_id = $2
         LIMIT 1`,
        [this.config.WORLD_ID, lookup.settlement.settlementId]
      );
      if (claimed.rowCount) {
        throw new CityFoundingError(
          "CITY_MUNICIPALITY_ALREADY_FOUNDED",
          `${municipalityLabel(lookup.settlement)} has already been founded in this world`
        );
      }
      const footprint = await lockAndResolveCityFoundingFootprint(
        client,
        flag,
        Number(this.config.FLAG_CLAIM_RADIUS_M),
        footprintWorld.layouts,
        footprintWorld.worlds,
        this.config.ALLOW_UNRESOLVED_FLAGS_IN_DEV
      );
      if (!footprint) {
        throw new CityFoundingError(
          "CITY_FULL_FOOTPRINT_UNAVAILABLE",
          "The City Hall cannot establish its minimum territory here after annexing eligible flags and searching alternate legal ground."
        );
      }

      const cityId = randomUUID();
      const inserted = await client.query<CityRow>(
        `INSERT INTO cities (
           id, world_id, canonical_municipality_id,
           world_settlement_id, world_settlement_source, world_source_settlement_id,
           settlement_class, settlement_release_id, settlement_release_fingerprint,
           settlement_founding_policy_id, settlement_founding_policy_fingerprint,
           settlement_resolution_policy_id, settlement_resolution_policy_fingerprint,
           name, country_code, region_code,
           founder_player_id, mayor_player_id, mayor_house_deadline, founding_request_id,
           construction_phase, construction_completed_at, jumpable,
           seat_flag_id, hall_lat, hall_lon, hall_geom, founding_annex_radius_m
         ) VALUES (
           $1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           $16,NULL,NULL,$17,'blueprint',NULL,false,$18,$19,$20,
           ST_SetSRID(ST_MakePoint($20,$19),4326),$21
         )
         RETURNING *,
           $22::text AS founder_username,
           $23::text AS founder_color,
           NULL::text AS mayor_username,
           NULL::text AS mayor_color`,
        [
          cityId,
          this.config.WORLD_ID,
          lookup.settlement.settlementId,
          lookup.settlement.source,
          lookup.settlement.sourceSettlementId,
          lookup.settlement.settlementClass,
          lookup.settlement.settlementReleaseId,
          lookup.settlement.settlementReleaseFingerprint,
          lookup.settlement.foundingPolicyId,
          lookup.settlement.foundingPolicyFingerprint,
          lookup.settlement.resolutionPolicyId,
          lookup.settlement.resolutionPolicyFingerprint,
          lookup.settlement.name,
          lookup.settlement.countryCode,
          lookup.settlement.regionCode,
          player.playerId,
          input.requestId,
          flag.id,
          hallPosition.lat,
          hallPosition.lon,
          Number(flag.claim_radius_m),
          player.username,
          player.displayColor
        ]
      );
      const converted = await client.query(
        `UPDATE flags
         SET control_type = 'city_seat', city_id = $2, name = $4,
             health = NULL, maximum_health = NULL,
             burning_started_at = NULL, burning_until = NULL, burning_reason = NULL,
             access_mode = 'public', jump_toll_gold = 0,
             city_affiliated_at = now(), city_affiliated_by_player_id = NULL,
             original_owner_player_id = NULL,
             contributed_by_player_id = NULL,
             original_personal_color = NULL
         WHERE id = $1 AND owner_id = $3 AND control_type = 'personal'
           AND city_id IS NULL AND kingdom_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM legendary_bird_events event
             WHERE event.flag_id = flags.id AND event.status IN ('pending','active')
           )`,
        [flag.id, cityId, player.playerId, `${lookup.settlement.name}'s Flag`]
      );
      if (converted.rowCount !== 1) {
        throw new CityFoundingError(
          "CITY_FLAG_LIFECYCLE_CHANGED",
          "The founding flag changed during confirmation"
        );
      }
      await detachConvertedCityFlagAccess(client, flag.id);
      const annexedFlags: Array<{ flagId: string; previousOwnerPlayerId: string }> = [];
      const territoryFlagIds: string[] = [];
      for (const annexedFlagId of footprint.layout.annexedFlagIds) {
        const annexed = footprint.flagsById.get(annexedFlagId);
        if (!annexed) throw new Error("annexable city flag lock is missing");
        const changed = await client.query(
          `UPDATE flags
           SET control_type = 'city', city_id = $2, name = $4,
               health = NULL, maximum_health = NULL,
               burning_started_at = NULL, burning_until = NULL, burning_reason = NULL,
               access_mode = 'public', jump_toll_gold = 0,
               city_affiliated_at = now(), city_affiliated_by_player_id = NULL,
               original_owner_player_id = NULL,
               contributed_by_player_id = NULL,
               original_personal_color = NULL
           WHERE id = $1 AND owner_id = $3 AND control_type = 'personal'
             AND city_id IS NULL AND kingdom_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM legendary_bird_events event
               WHERE event.flag_id = flags.id AND event.status IN ('pending','active')
             )`,
          [annexed.id, cityId, player.playerId, `${lookup.settlement.name}'s Flag`]
        );
        if (changed.rowCount !== 1) {
          throw new CityFoundingError(
            "CITY_FLAG_LIFECYCLE_CHANGED",
            "An eligible founding flag changed while the city's territory was being established"
          );
        }
        await detachConvertedCityFlagAccess(client, annexed.id);
        await insertCityFlagHistory(client, {
          cityId,
          flag: annexed,
          actorId: player.playerId,
          action: "affiliated",
          reason: "founding_annexation",
          requestId: input.requestId,
          resultingCityId: cityId,
          metadata: { foundingAnnexRadiusM: Number(flag.claim_radius_m) }
        });
        annexedFlags.push({
          flagId: annexed.id,
          previousOwnerPlayerId: annexed.owner_id
        });
        territoryFlagIds.push(annexed.id);
      }
      for (const slot of footprint.layout.slots) {
        const generatedFlagId = randomUUID();
        const world = footprintWorld.worlds[slot.worldPointIndex];
        if (!world) throw new Error("city footprint terrain result is missing");
        const environment = prepareFlagEnvironmentPersistence(world);
        const generated = await client.query<CityFlagRow>(
          `INSERT INTO flags (
             id, owner_id, name, lat, lon, package_id, elevation_m, terrain_class,
             biome, ecoregion, claim_radius_m, resource_vision_radius_m,
             environment_snapshot, geom, control_type, city_id,
             access_mode, jump_toll_gold, city_affiliated_at,
             city_affiliated_by_player_id, original_owner_player_id,
             contributed_by_player_id, original_personal_color
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,
             ST_SetSRID(ST_MakePoint($5,$4),4326),'city',$14,
             'public',0,now(),NULL,NULL,NULL,NULL
           )
           RETURNING id, owner_id, NULL::text AS owner_username,
             $15::text AS owner_color, anchor_kind, control_type, name, lat, lon,
             claim_radius_m, city_id, kingdom_id,
             0::double precision AS distance_m,
             concat(created_at::text, '/', updated_at::text) AS lifecycle_revision`,
          [
            generatedFlagId,
            player.playerId,
            `${lookup.settlement.name}'s Flag`,
            slot.position.lat,
            slot.position.lon,
            environment.packageId,
            environment.elevationM,
            environment.terrainClass,
            environment.biome,
            environment.ecoregion,
            Number(this.config.FLAG_CLAIM_RADIUS_M),
            Number(this.config.FLAG_RESOURCE_VISION_RADIUS_M),
            environment.snapshotJson,
            cityId,
            player.displayColor
          ]
        );
        const generatedFlag = generated.rows[0];
        if (!generatedFlag) throw new Error("generated city flag insert did not return a row");
        await insertCityFlagHistory(client, {
          cityId,
          flag: generatedFlag,
          actorId: player.playerId,
          action: "affiliated",
          reason: "founding_generated",
          requestId: input.requestId,
          resultingCityId: cityId,
          metadata: {
            ringSlot: slot.index,
            bearingDegrees: slot.bearingDegrees,
            rotationDegrees: footprint.layout.rotationDegrees
          }
        });
        territoryFlagIds.push(generatedFlag.id);
      }
      if (territoryFlagIds.length < CITY_FOUNDING_EXPANSION_COUNT) {
        throw new Error("city footprint did not produce the minimum expansion flag allocation");
      }
      await client.query(
        `INSERT INTO player_discovered_cities (player_id, city_id, first_visited_at, last_visited_at)
         VALUES ($1,$2,now(),now())
         ON CONFLICT (player_id, city_id) DO UPDATE
         SET last_visited_at = EXCLUDED.last_visited_at`,
        [player.playerId, cityId]
      );
      await insertCityFlagHistory(client, {
        cityId,
        flag,
        actorId: player.playerId,
        action: "seat_founded",
        reason: "founding_flag_conversion",
        requestId: input.requestId,
        resultingCityId: cityId,
        metadata: {
          municipalityType,
          sourceTerritoryLat: Number(flag.lat),
          sourceTerritoryLon: Number(flag.lon),
          hallLat: hallPosition.lat,
          hallLon: hallPosition.lon
        }
      });
      await client.query(
        `INSERT INTO city_construction_contributions (
           city_id,actor_player_id,request_id,stage,action
         ) VALUES ($1,$2,$3,'blueprint','found_city')`,
        [cityId, player.playerId, input.requestId]
      );
      const foundedRow = await loadCityById(client, cityId, this.config.WORLD_ID);
      await client.query("COMMIT");
      if (!inserted.rows[0]) throw new Error("city insert did not return a row");
      this.logger.info(
        {
          cityId,
          founderPlayerId: player.playerId,
          municipalityId: lookup.settlement.settlementId,
          sourceFlagId: flag.id,
          sourceTerritoryPosition: { lat: Number(flag.lat), lon: Number(flag.lon) },
          hallPosition
        },
        "city founded from personal flag"
      );
      return {
        city: rowToCity(foundedRow),
        seatFlagId: flag.id,
        territoryFlagIds: [flag.id, ...territoryFlagIds],
        annexedFlags,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isMunicipalityUniqueViolation(error)) {
        throw new CityFoundingError(
          "CITY_MUNICIPALITY_ALREADY_FOUNDED",
          foundingSettlement
            ? `${municipalityLabel(foundingSettlement)} has already been founded in this world`
            : "This settlement has already been founded in this world"
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async advanceConstruction(
    playerId: string,
    input: { requestId: string; cityId: string; action: CityConstructionAction }
  ): Promise<AdvanceCityConstructionResult> {
    const inventoryService = this.inventory;
    const walletService = this.wallet;
    if (!inventoryService || !walletService) {
      throw new CityFoundingError(
        "CITY_CONSTRUCTION_UNAVAILABLE",
        "City construction service is unavailable"
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `city-construction-request:${playerId}:${input.requestId}`
      ]);
      const replay = await loadConstructionContribution(client, playerId, input.requestId);
      if (replay) assertConstructionReplayIntent(replay, input);

      const lockedCity = await loadCityById(
        client,
        input.cityId,
        this.config.WORLD_ID,
        true
      );
      if (replay) {
        const result = await constructionResult(
          client,
          inventoryService,
          walletService,
          playerId,
          input.action,
          rowToCity(lockedCity),
          true
        );
        await client.query("COMMIT");
        return result;
      }

      const transition = constructionTransition(input.action);
      if (lockedCity.construction_phase !== transition.expectedPhase) {
        throw new CityFoundingError(
          "CITY_CONSTRUCTION_PHASE_MISMATCH",
          constructionPhaseMessage(lockedCity.construction_phase),
          {
            currentPhase: lockedCity.construction_phase,
            expectedPhase: transition.expectedPhase
          }
        );
      }
      const priorContribution = await client.query(
        `SELECT 1 FROM city_construction_contributions
         WHERE city_id=$1 AND actor_player_id=$2 LIMIT 1`,
        [input.cityId, playerId]
      );
      if (priorContribution.rowCount) {
        throw new CityFoundingError(
          "CITY_CONSTRUCTION_ACTOR_ALREADY_CONTRIBUTED",
          "Each city construction stage must be completed by a different player"
        );
      }

      const operationKey = `city-construction:${playerId}:${input.requestId}`;
      let inventory: PlayerInventorySnapshot | undefined;
      let walletGold: string | undefined;
      let walletVersion: string | undefined;
      if (transition.material) {
        try {
          const debit = await inventoryService.debitItemsForOperationInTransaction(client, {
            operationKey: `${operationKey}:inventory`,
            playerId,
            source: "city_construction",
            sourceEntityType: "city",
            sourceEntityId: input.cityId,
            metadata: { cityId: input.cityId, action: input.action },
            debits: [{
              itemId: transition.material.itemId,
              variant: "default",
              quantity: BigInt(transition.material.quantity)
            }]
          });
          inventory = debit.inventory;
        } catch (error) {
          if (error instanceof Error && error.message === "Inventory does not contain enough items") {
            throw new CityFoundingError(
              transition.material.itemId === "stone"
                ? "CITY_CONSTRUCTION_INSUFFICIENT_STONE"
                : "CITY_CONSTRUCTION_INSUFFICIENT_WOOD",
              `City construction requires ${transition.material.quantity} default ${transition.material.itemId}`
            );
          }
          throw error;
        }
      } else {
        const accountId = await loadPlayerAccountId(client, playerId);
        try {
          const debit = await walletService.debitForOperationInTransaction(client, {
            playerId,
            accountId,
            amount: 4_500n,
            operationKey: `${operationKey}:wallet`,
            reason: "city_construction_finish",
            metadata: { cityId: input.cityId, action: input.action }
          });
          walletGold = debit.goldBalance.toString();
          walletVersion = debit.version.toString();
        } catch (error) {
          if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
            throw new CityFoundingError(
              "CITY_CONSTRUCTION_INSUFFICIENT_GOLD",
              "Finishing city construction requires 4500 gold"
            );
          }
          throw error;
        }
      }

      await client.query(
        `INSERT INTO city_construction_contributions (
           city_id,actor_player_id,request_id,stage,action,
           material_item_id,material_quantity,gold_amount
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.cityId,
          playerId,
          input.requestId,
          transition.stage,
          input.action,
          transition.material?.itemId ?? null,
          transition.material?.quantity ?? null,
          input.action === "finish" ? "4500" : null
        ]
      );
      const advanced = await client.query(
        `UPDATE cities
         SET construction_phase=$3,
             construction_completed_at=CASE
               WHEN $3='complete' THEN now() ELSE NULL
             END,
             jumpable=CASE WHEN $3='complete' THEN true ELSE false END,
             mayor_house_deadline=CASE
               WHEN $3='complete' THEN now() + interval '15 minutes'
               ELSE NULL
             END,
             spatial_revision=spatial_revision+1
         WHERE id=$1 AND world_id=$2 AND active AND construction_phase=$4`,
        [input.cityId, this.config.WORLD_ID, transition.nextPhase, transition.expectedPhase]
      );
      if (advanced.rowCount !== 1) {
        throw new CityFoundingError(
          "CITY_CONSTRUCTION_PHASE_MISMATCH",
          "City construction advanced before this request could be committed"
        );
      }
      const current = rowToCity(await loadCityById(client, input.cityId, this.config.WORLD_ID));
      await client.query("COMMIT");
      return {
        action: input.action,
        city: current,
        replayed: false,
        ...(inventory ? { inventory } : {}),
        ...(walletGold !== undefined ? { walletGold, walletVersion: walletVersion! } : {})
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async joinCity(
    playerId: string,
    input: { requestId: string; cityId: string }
  ): Promise<CityJoinResult> {
    void playerId;
    const city = await this.getCity(input.cityId);
    if (!city) throw new CityFoundingError("CITY_NOT_FOUND", "City no longer exists");
    if (city.controllerKind === "npc") {
      throw new CityFoundingError(
        "CITY_PERMISSION_DENIED",
        "NPC cities do not accept player membership"
      );
    }
    throw new CityFoundingError(
      "CITY_HOUSE_REQUIRED",
      "Build a City House on this city’s land to become a member."
    );
  }

  async leaveCity(
    playerId: string,
    input: { requestId: string; cityId: string }
  ): Promise<CityLeaveResult> {
    void playerId;
    void input;
    throw new CityFoundingError(
      "CITY_HOUSE_REQUIRED",
      "Destroy your City House to leave the city."
    );
  }

  async claimMayor(
    playerId: string,
    input: { requestId: string; cityId: string }
  ): Promise<CityMayorResult> {
    if (this.structures) {
      const changed = await this.structures.claimMayor(
        playerId,
        input.cityId,
        input.requestId
      );
      const city = await this.getCity(input.cityId);
      if (!city) throw new CityFoundingError("CITY_NOT_FOUND", "City no longer exists");
      return {
        city,
        structure: changed.structure,
        membership: changed.membership,
        replayed: changed.replayed
      };
    }
    throw new CityFoundingError(
      "CITY_HOUSE_REQUIRED",
      "Mayor control requires the City House authority service"
    );
  }

  async relinquishMayor(
    playerId: string,
    input: { requestId: string; cityId: string }
  ): Promise<CityMayorResult> {
    if (this.structures) {
      const changed = await this.structures.relinquishMayor(
        playerId,
        input.cityId,
        input.requestId
      );
      const city = await this.getCity(input.cityId);
      if (!city) throw new CityFoundingError("CITY_NOT_FOUND", "City no longer exists");
      return {
        city,
        structure: changed.structure,
        membership: changed.membership,
        replayed: changed.replayed
      };
    }
    throw new CityFoundingError(
      "CITY_HOUSE_REQUIRED",
      "Mayor control requires the City House authority service"
    );
  }

  async convertCityFlag(
    playerId: string,
    input: { requestId: string; flagId: string },
    options: CityFlagConversionOptions = {}
  ): Promise<CityFlagConversionResult> {
    const replay = await this.replayCityFlagConversion(playerId, input);
    if (replay) {
      return replay;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [playerId]);
      const membership = await loadMembership(client, playerId, this.config.WORLD_ID);
      if (!membership) {
        throw new CityFoundingError(
          "CITY_INCOMPATIBLE_AFFILIATION",
          "Active city membership is required to contribute a flag"
        );
      }
      await lockCityFlagNetworkMutation(client, membership.cityId);
      const lockedReplay = await loadMutation(client, playerId, input.requestId);
      if (lockedReplay) {
        assertMutationReplay(lockedReplay, "convert_city_flag", membership.cityId, input.flagId);
        const capacity = await loadCityCapacity(client, membership.cityId);
        await client.query("COMMIT");
        return {
          cityId: membership.cityId,
          flagId: input.flagId,
          ...capacity,
          replayed: true
        };
      }
      await lockFlagControlGeometry(client);
      const { capacity, flag, anchor } = await validateCityFlagConversion(
        client,
        playerId,
        membership,
        input.flagId,
        true,
        options
      );
      const changed = await client.query(
        // The flag now belongs to the city: owner_id records the Mayor (the
        // converting member while the city has none) and grants nothing by
        // itself; the contributor stays in the affiliation history.
        `UPDATE flags
         SET control_type = 'city', city_id = $2, name = $4,
             owner_id = COALESCE((SELECT mayor_player_id FROM cities WHERE id = $2), $3),
             health = NULL, maximum_health = NULL,
             burning_started_at = NULL, burning_until = NULL, burning_reason = NULL,
             access_mode = 'public', jump_toll_gold = 0,
             city_affiliated_at = now(), city_affiliated_by_player_id = NULL,
             original_owner_player_id = NULL,
             contributed_by_player_id = NULL,
             original_personal_color = NULL
         WHERE id = $1 AND owner_id = $3 AND control_type = 'personal'
           AND city_id IS NULL AND kingdom_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM legendary_bird_events event
             WHERE event.flag_id = flags.id AND event.status IN ('pending','active')
           )`,
        [flag.id, membership.cityId, playerId, `${membership.cityName}'s Flag`]
      );
      if (changed.rowCount !== 1) {
        throw new CityFoundingError(
          "CITY_FLAG_LIFECYCLE_CHANGED",
          "Flag control changed during confirmation"
        );
      }
      await detachConvertedCityFlagAccess(client, flag.id);
      await insertCityFlagHistory(client, {
        cityId: membership.cityId,
        flag,
        actorId: playerId,
        action: "affiliated",
        reason: "member_conversion",
        requestId: input.requestId,
        resultingCityId: membership.cityId,
        metadata: { connectionAnchorFlagId: anchor, originalOwnerPlayerId: flag.owner_id }
      });
      await insertMutation(
        client,
        playerId,
        input.requestId,
        "convert_city_flag",
        membership.cityId,
        flag.id
      );
      await client.query(
        "UPDATE cities SET spatial_revision = spatial_revision + 1 WHERE id = $1",
        [membership.cityId]
      );
      await client.query("COMMIT");
      return {
        cityId: membership.cityId,
        flagId: flag.id,
        memberCount: capacity.memberCount,
        expansionFlagCount: capacity.expansionFlagCount + 1,
        expansionFlagLimit: capacity.expansionFlagLimit,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async replayCityFlagConversion(
    playerId: string,
    input: { requestId: string; flagId: string }
  ): Promise<CityFlagConversionResult | null> {
    const replay = await loadMutation(this.pool, playerId, input.requestId);
    if (!replay) return null;
    assertMutationReplay(replay, "convert_city_flag", replay.city_id, input.flagId);
    return {
      cityId: replay.city_id,
      flagId: input.flagId,
      ...await loadCityCapacity(this.pool, replay.city_id),
      replayed: true
    };
  }

  async previewCityFlagConversion(
    playerId: string,
    flagId: string,
    options: CityFlagConversionOptions = {}
  ): Promise<CityFlagConversionPreview> {
    const membership = await loadMembership(this.pool, playerId, this.config.WORLD_ID);
    if (!membership) {
      throw new CityFoundingError(
        "CITY_INCOMPATIBLE_AFFILIATION",
        "Active city membership is required to contribute a flag"
      );
    }
    const { flag } = await validateCityFlagConversion(
      this.pool,
      playerId,
      membership,
      flagId,
      false,
      options
    );
    return {
      cityId: membership.cityId,
      cityName: membership.cityName,
      flagId: flag.id,
      flagName: flag.name,
      position: { lat: Number(flag.lat), lon: Number(flag.lon) }
    };
  }

  /**
   * Ends a city and starts its territory collapse in one transaction: the city
   * becomes inactive, memberships end, and every city flag is marked collapsing
   * and queued to break in a wave outward from the City Center. Returns null when
   * the city was already inactive. This is the single entry point later siege
   * code calls for a city (see TerritoryCollapseService).
   */
  async deactivateCity(
    cityId: string,
    reason: CityLifecycleReason,
    options: Readonly<{ actorPlayerId?: string | null; collapseReason?: string }> = {}
  ): Promise<TerritoryCollapseBegun | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `city-flag-network:${cityId}`
      ]);
      await lockFlagControlGeometry(client);
      const cityFlags = await client.query<{ id: string }>(
        `SELECT id FROM flags WHERE city_id=$1 ORDER BY id FOR UPDATE`,
        [cityId]
      );
      const cityFlagIds = cityFlags.rows.map((flag) => flag.id);
      if (cityFlagIds.length > 0) {
        const liveLegendaryEvent = await client.query(
          `SELECT 1 FROM legendary_bird_events
           WHERE flag_id=ANY($1::uuid[]) AND status IN ('pending','active')
           LIMIT 1`,
          [cityFlagIds]
        );
        if (liveLegendaryEvent.rowCount) {
          throw new CityFoundingError(
            "CITY_FLAG_LIFECYCLE_CHANGED",
            "The city cannot be deactivated during an active legendary bird encounter"
          );
        }
      }
      const changed = await client.query<{ id: string; name: string }>(
        `UPDATE cities
         SET active = false, jumpable = false, inactive_reason = $2,
             ended_at = now(), rebuild_available_at = now() + interval '7 days'
         WHERE id = $1 AND active
         RETURNING id, name`,
        [cityId, reason]
      );
      if (!changed.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const activeMembers = await client.query<{ player_id: string }>(
        `SELECT player_id FROM city_memberships
         WHERE city_id=$1 AND left_at IS NULL
         ORDER BY player_id FOR UPDATE`,
        [cityId]
      );
      if (this.structures) {
        for (const member of activeMembers.rows) {
          await this.structures.destroyPersonalStructuresForMembershipLossInTransaction(
            client,
            member.player_id,
            cityId,
            "city_deactivated"
          );
        }
      }
      await client.query(
        `UPDATE city_memberships
         SET left_at=now(),ended_reason='city_deactivated'
         WHERE city_id=$1 AND left_at IS NULL`,
        [cityId]
      );
      // The seat is still referenced so the wave can start from it; the
      // collapse worker's deletion clears cities.seat_flag_id (ON DELETE SET NULL).
      const collapse = await beginTerritoryCollapseInTransaction(client, {
        kind: "city",
        id: cityId,
        displayName: changed.rows[0]!.name,
        reason: options.collapseReason ?? `city_${reason}`,
        actorPlayerId: options.actorPlayerId ?? null,
        notifyPlayerIds: activeMembers.rows.map((member) => member.player_id)
      });
      await client.query("COMMIT");
      return collapse;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Developer-only: founds the Albuquerque hub city for the caller in one transaction
   * (City Center + ~50 territory flags + active Mayor House, Warehouse and City Market).
   * dryRun executes the identical transaction and rolls it back, returning the plan.
   * Idempotent per (founder, requestId) via cities_founder_request_unique.
   */
  async foundDeveloperCapital(
    player: PlayerRecord,
    input: { requestId: string; dryRun: boolean; leaveCurrentCity: boolean }
  ): Promise<DeveloperCapitalFoundingResult> {
    const structures = this.structures;
    if (!structures) {
      throw new CityFoundingError(
        "CITY_CONSTRUCTION_UNAVAILABLE",
        "City structure service is unavailable"
      );
    }
    if (!input.dryRun) {
      const replay = await this.findDeveloperCapitalReplay(player.playerId, input.requestId);
      if (replay) return replay;
    }
    const claimRadiusM = Number(this.config.FLAG_CLAIM_RADIUS_M);
    const allowUnresolved = this.config.ALLOW_UNRESOLVED_FLAGS_IN_DEV;
    const legalLand = (
      world: WorldGameplayEnvironmentResult | undefined,
      point: LatLon
    ): boolean =>
      Boolean(
        world && (world.ok || allowUnresolved) &&
        classifyFlagPlacementTerrain(world) !== "water" && isWithinWorldEdge(point)
      );
    const lookupEnvironments = async (
      points: LatLon[]
    ): Promise<WorldGameplayEnvironmentResult[]> => {
      try {
        return await this.worldLookup.lookupGameplayEnvironments(points, { caller: "city" });
      } catch (error) {
        this.logger.warn({ err: error }, "developer capital terrain lookup failed");
        throw new CityFoundingError(
          "CITY_BOUNDARY_AUTHORITY_UNAVAILABLE",
          "Capital founding is unavailable because terrain could not be verified"
        );
      }
    };

    const anchor: LatLon = { ...WORLD_MAP_CAPITAL_ANCHOR };
    let hall: LatLon = anchor;
    const anchorWorld = (await lookupEnvironments([anchor]))[0];
    if (!legalLand(anchorWorld, anchor)) {
      const candidates = developerCapitalSeatCandidates(anchor).slice(1);
      const worlds = await lookupEnvironments(candidates);
      const index = candidates.findIndex((point, i) => legalLand(worlds[i], point));
      if (index < 0) {
        throw new CityFoundingError(
          "CITY_FULL_FOOTPRINT_UNAVAILABLE",
          "No legal land was found within 500 m of the capital anchor"
        );
      }
      hall = candidates[index]!;
    }

    let lookup: SettlementLookupResult;
    try {
      lookup = await this.worldLookup.lookupSettlement(hall.lat, hall.lon);
      assertSettlementAuthority(lookup, this.settlementAuthority());
    } catch (error) {
      this.logger.warn({ err: error, hall }, "developer capital settlement lookup failed");
      throw new CityFoundingError(
        "CITY_BOUNDARY_AUTHORITY_UNAVAILABLE",
        "Capital founding is unavailable because settlement authority could not be queried"
      );
    }
    if (!lookup.found) {
      throw new CityFoundingError("CITY_NO_MUNICIPALITY_HERE", outsideMunicipalityMessage(lookup));
    }
    const settlement = lookup.settlement;
    if (!settlement.name.toLowerCase().includes(WORLD_MAP_CAPITAL_NAME.toLowerCase())) {
      throw new CityFoundingError(
        "CITY_NO_MUNICIPALITY_HERE",
        `The capital anchor resolves to ${municipalityLabel(settlement)}, not ${WORLD_MAP_CAPITAL_NAME}`
      );
    }
    if (!settlement.foundingEligible) {
      const ineligibility = municipalityFoundingIneligibility(settlement);
      throw new CityFoundingError(ineligibility.code, ineligibility.message, ineligibility.details);
    }

    const slots = developerCapitalFlagSlots(hall, claimRadiusM + 1);
    const slotWorlds = await lookupEnvironments(slots);
    if (!legalLand(slotWorlds[0], slots[0]!)) {
      throw new CityFoundingError(
        "CITY_FULL_FOOTPRINT_UNAVAILABLE",
        "The capital City Center position is not legal land"
      );
    }
    const preMembership = await loadMembership(this.pool, player.playerId, this.config.WORLD_ID);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (preMembership) {
        // Same lock order as City House destruction: city, house player, player row.
        await lockPlayerAndCity(client, player.playerId, preMembership.cityId);
      } else {
        await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [player.playerId]);
      }
      await lockFlagControlGeometry(client);
      if (!input.dryRun) {
        const lockedReplay = await this.findDeveloperCapitalReplay(
          player.playerId,
          input.requestId,
          client
        );
        if (lockedReplay) {
          await client.query("COMMIT");
          return lockedReplay;
        }
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `city-municipality:${this.config.WORLD_ID}:${settlement.settlementId}`
      ]);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('ash-atlas-flag-placement-v1', 0))"
      );
      const claimed = await client.query<{ name: string; active: boolean }>(
        `SELECT name, active FROM cities
         WHERE world_id = $1 AND canonical_municipality_id = $2 LIMIT 1`,
        [this.config.WORLD_ID, settlement.settlementId]
      );
      if (claimed.rows[0]) {
        throw new CityFoundingError(
          "CITY_MUNICIPALITY_ALREADY_FOUNDED",
          `${municipalityLabel(settlement)} has already been founded in this world ` +
            `(${claimed.rows[0].name}, ${claimed.rows[0].active ? "active" : "inactive"})`
        );
      }
      const membership = await loadMembership(client, player.playerId, this.config.WORLD_ID);
      if ((membership?.cityId ?? null) !== (preMembership?.cityId ?? null)) {
        throw new CityFoundingError(
          "CITY_REQUEST_CONFLICT",
          "Your city membership changed while the capital was being planned; retry"
        );
      }
      const reservedHouse = await client.query<{ city_name: string }>(
        `SELECT city.name AS city_name
         FROM city_structures structure
         JOIN cities city ON city.id = structure.city_id
         WHERE structure.owner_player_id = $1 AND structure.state = 'constructing'
           AND structure.structure_type IN ('city_house','mayor_house')
         LIMIT 1`,
        [player.playerId]
      );
      if (reservedHouse.rows[0]) {
        throw new CityFoundingError(
          "CITY_INCOMPATIBLE_AFFILIATION",
          `Your City House in ${reservedHouse.rows[0].city_name} is still under construction; ` +
            "finish or cancel it before founding the capital"
        );
      }
      if (membership && !input.leaveCurrentCity && !input.dryRun) {
        throw new CityFoundingError(
          "CITY_INCOMPATIBLE_AFFILIATION",
          `You are ${membership.role === "mayor" ? "the Mayor" : "a member"} of ` +
            `${membership.cityName}. Enable "Leave current city" to destroy your City House ` +
            "there and found the capital"
        );
      }
      let leave: DeveloperCapitalFoundingPlan["leave"] = null;
      let leftHouse: CityHouseMutationResult | null = null;
      if (membership) {
        // Dry runs perform the leave too (then roll back) so the plan shows what it destroys.
        const destroyed = await structures.destroyHouseForDeveloperCapitalInTransaction(
          client,
          player.playerId,
          input.requestId
        );
        leftHouse = destroyed.result;
        leave = {
          cityId: membership.cityId,
          cityName: membership.cityName,
          houseStructureId: destroyed.result.structure.structureId,
          houseType: destroyed.houseType,
          mayorRelinquished: membership.role === "mayor",
          destroyedStructures: (destroyed.result.destroyedStructures ?? []).map((structure) => ({
            structureId: structure.structureId,
            type: structure.type,
            state: structure.state
          })),
          refundedLines: destroyed.refundedLines,
          droppedLines: destroyed.droppedLines
        };
      }

      // Every flag whose center lies inside the capital footprint (any slot circle) is
      // locked and either annexed (personal flags) or listed as excluded.
      const footprintFlags = await client.query<{
        id: string;
        owner_id: string;
        owner_username: string | null;
        anchor_kind: string;
        control_type: string;
        city_id: string | null;
        kingdom_id: string | null;
        reinforcement_level: number;
        system_controlled: boolean;
        legendary_event: boolean;
        lat: number;
        lon: number;
        claim_radius_m: number;
      }>(
        `SELECT flag.id, flag.owner_id, owner.username AS owner_username, flag.anchor_kind,
                flag.control_type, flag.city_id, flag.kingdom_id, flag.reinforcement_level,
                flag.system_controlled, flag.lat, flag.lon, flag.claim_radius_m,
                EXISTS (
                  SELECT 1 FROM legendary_bird_events event
                  WHERE event.flag_id = flag.id AND event.status IN ('pending','active')
                ) AS legendary_event
         FROM flags flag
         LEFT JOIN players owner ON owner.id = flag.owner_id
         WHERE EXISTS (
           SELECT 1 FROM unnest($1::double precision[], $2::double precision[]) AS point(lat, lon)
           WHERE ST_DWithin(
             flag.geom::geography,
             ST_SetSRID(ST_MakePoint(point.lon, point.lat), 4326)::geography,
             $3
           )
         )
         ORDER BY flag.id
         FOR UPDATE OF flag`,
        [slots.map(({ lat }) => lat), slots.map(({ lon }) => lon), claimRadiusM]
      );
      const exclusionReason = (
        flag: (typeof footprintFlags.rows)[number]
      ): DeveloperCapitalExcludedReason | null =>
        flag.kingdom_id !== null || flag.control_type === "kingdom" ||
          flag.control_type === "kingdom_seat"
          ? "kingdom"
          : flag.city_id !== null || flag.control_type !== "personal"
            ? "other_city"
            : flag.anchor_kind !== "flag"
              ? "buoy"
              : Number(flag.reinforcement_level) === 2
                ? "atlas_shrine"
                : Number(flag.reinforcement_level) === 3
                  ? "tower"
                  : flag.system_controlled
                    ? "system_controlled"
                    : flag.legendary_event
                      ? "legendary_event"
                      : null;
      const annexable = footprintFlags.rows.filter((flag) => exclusionReason(flag) === null);
      const excludedFlags: DeveloperCapitalFoundingPlan["excludedFlags"] = footprintFlags.rows
        .filter((flag) => exclusionReason(flag) !== null)
        .map((flag) => ({
          flagId: flag.id,
          ownerPlayerId: flag.owner_id,
          ownerUsername: flag.owner_username,
          lat: Number(flag.lat),
          lon: Number(flag.lon),
          reason: exclusionReason(flag)!
        }));

      // Territory that is not part of the footprint (and kingdom seats) still blocks slots.
      const blocked = await client.query<{ slot: string }>(
        `SELECT point.slot::text AS slot
         FROM unnest($1::double precision[], $2::double precision[])
           WITH ORDINALITY AS point(lat, lon, slot)
         WHERE EXISTS (
           SELECT 1 FROM flags existing
           WHERE NOT (existing.id = ANY($4::uuid[]))
             AND ST_DWithin(
               existing.geom::geography,
               ST_SetSRID(ST_MakePoint(point.lon, point.lat), 4326)::geography,
               existing.claim_radius_m + $3
             )
         ) OR EXISTS (
           SELECT 1 FROM kingdom_seats seat
           JOIN kingdoms kingdom ON kingdom.id = seat.kingdom_id
           WHERE seat.status = 'active' AND kingdom.status = 'active'
             AND ST_DWithin(
               seat.geom::geography,
               ST_SetSRID(ST_MakePoint(point.lon, point.lat), 4326)::geography,
               seat.territory_radius_m + $3
             )
         )`,
        [
          slots.map(({ lat }) => lat),
          slots.map(({ lon }) => lon),
          claimRadiusM,
          annexable.map(({ id }) => id)
        ]
      );
      const blockedSlots = new Set(blocked.rows.map(({ slot }) => Number(slot) - 1));
      const overlapsFlag = (
        position: LatLon,
        flag: { lat: number; lon: number; claim_radius_m: number }
      ): boolean =>
        distanceMeters(position, { lat: Number(flag.lat), lon: Number(flag.lon) }) <=
          Number(flag.claim_radius_m) + claimRadiusM;
      const terrainReason = (index: number): DeveloperCapitalSkipReason | null =>
        !isWithinWorldEdge(slots[index]!)
          ? "world_edge"
          : !legalLand(slotWorlds[index], slots[index]!)
            ? "terrain_unavailable"
            : null;
      // Each annexed flag fills its nearest non-seat slot when its center is inside it.
      const filledSlotFor = (flag: { lat: number; lon: number }): number | null => {
        let best: { slot: number; distanceM: number } | null = null;
        for (const [slot, position] of slots.entries()) {
          if (slot === 0) continue;
          const distanceM = distanceMeters(position, { lat: Number(flag.lat), lon: Number(flag.lon) });
          if (distanceM <= claimRadiusM && (!best || distanceM < best.distanceM)) {
            best = { slot, distanceM };
          }
        }
        return best?.slot ?? null;
      };
      // Pass 1 finds which annexable flags join the seat network; pass 2 settles the
      // slots once the flags that stay foreign (disconnected) block their neighbours.
      const resolveNetwork = (annexIds: ReadonlySet<string>) => {
        const extraBlocking = annexable.filter((flag) => !annexIds.has(flag.id));
        const filled = new Set(
          annexable
            .filter((flag) => annexIds.has(flag.id))
            .map(filledSlotFor)
            .filter((slot): slot is number => slot !== null)
        );
        const slotReason = (index: number): DeveloperCapitalSkipReason | null =>
          terrainReason(index) ??
          (blockedSlots.has(index) || extraBlocking.some((flag) => overlapsFlag(slots[index]!, flag))
            ? "existing_territory"
            : null);
        const nodes = [
          ...slots.map((position, index) => ({
            position,
            radiusM: claimRadiusM,
            usable: slotReason(index) === null
          })),
          ...annexable.map((flag) => ({
            position: { lat: Number(flag.lat), lon: Number(flag.lon) },
            radiusM: Number(flag.claim_radius_m),
            usable: annexIds.has(flag.id)
          }))
        ];
        const connected = developerCapitalConnectedNodes(nodes, FLAG_CONTROL_TOUCH_TOLERANCE_M);
        return { filled, slotReason, connected };
      };
      const pass1 = resolveNetwork(new Set(annexable.map(({ id }) => id)));
      if (pass1.slotReason(0) !== null && pass1.slotReason(0) !== "existing_territory") {
        throw new CityFoundingError(
          "CITY_FULL_FOOTPRINT_UNAVAILABLE",
          "The capital City Center position is not legal land"
        );
      }
      if (pass1.slotReason(0) === "existing_territory") {
        throw new CityFoundingError(
          "CITY_FULL_FOOTPRINT_UNAVAILABLE",
          "The capital City Center would overlap territory that cannot be annexed"
        );
      }
      const annexIds = new Set(
        annexable
          .filter((_, index) => pass1.connected[slots.length + index])
          .map(({ id }) => id)
      );
      const network = resolveNetwork(annexIds);
      const annexedRows = annexable.filter(
        (flag, index) => annexIds.has(flag.id) && network.connected[slots.length + index]
      );
      for (const flag of annexable) {
        if (annexedRows.includes(flag)) continue;
        excludedFlags.push({
          flagId: flag.id,
          ownerPlayerId: flag.owner_id,
          ownerUsername: flag.owner_username,
          lat: Number(flag.lat),
          lon: Number(flag.lon),
          reason: "disconnected"
        });
      }
      const annexedFlags: DeveloperCapitalFoundingPlan["annexedFlags"] = annexedRows.map((flag) => ({
        flagId: flag.id,
        previousOwnerPlayerId: flag.owner_id,
        previousOwnerUsername: flag.owner_username,
        lat: Number(flag.lat),
        lon: Number(flag.lon),
        filledSlot: filledSlotFor(flag)
      }));
      const finalFilled = new Set(
        annexedFlags.map(({ filledSlot }) => filledSlot).filter((slot): slot is number => slot !== null)
      );
      const placedFlags: DeveloperCapitalFoundingPlan["placedFlags"] = [];
      const skippedFlags: DeveloperCapitalFoundingPlan["skippedFlags"] = [];
      for (const [slot, position] of slots.entries()) {
        if (finalFilled.has(slot)) continue;
        const reason = network.slotReason(slot) ??
          (network.connected[slot] ? null : "disconnected");
        if (reason) skippedFlags.push({ slot, lat: position.lat, lon: position.lon, reason });
        else placedFlags.push({ slot, lat: position.lat, lon: position.lon });
      }

      const cityId = randomUUID();
      await client.query(
        `INSERT INTO cities (
           id, world_id, canonical_municipality_id,
           world_settlement_id, world_settlement_source, world_source_settlement_id,
           settlement_class, settlement_release_id, settlement_release_fingerprint,
           settlement_founding_policy_id, settlement_founding_policy_fingerprint,
           settlement_resolution_policy_id, settlement_resolution_policy_fingerprint,
           name, country_code, region_code,
           founder_player_id, mayor_player_id, mayor_confirmed_at, mayor_house_deadline,
           founding_request_id, construction_phase, construction_completed_at, jumpable,
           controller_kind, culture,
           seat_flag_id, hall_lat, hall_lon, hall_geom, founding_annex_radius_m
         ) VALUES (
           $1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           $16,$16,clock_timestamp(),NULL,$17,'complete',clock_timestamp(),true,
           'player','human',NULL,$18,$19,ST_SetSRID(ST_MakePoint($19,$18),4326),$20
         )`,
        [
          cityId,
          this.config.WORLD_ID,
          settlement.settlementId,
          settlement.source,
          settlement.sourceSettlementId,
          settlement.settlementClass,
          settlement.settlementReleaseId,
          settlement.settlementReleaseFingerprint,
          settlement.foundingPolicyId,
          settlement.foundingPolicyFingerprint,
          settlement.resolutionPolicyId,
          settlement.resolutionPolicyFingerprint,
          settlement.name,
          settlement.countryCode,
          settlement.regionCode,
          player.playerId,
          input.requestId,
          hall.lat,
          hall.lon,
          claimRadiusM
        ]
      );
      const flagName = `${settlement.name}'s Flag`;
      const territoryFlagIds: string[] = [];
      for (const placed of placedFlags) {
        const flagId = randomUUID();
        const environment = prepareFlagEnvironmentPersistence(slotWorlds[placed.slot]!);
        await client.query(
          `INSERT INTO flags (
             id, owner_id, name, lat, lon, package_id, elevation_m, terrain_class,
             biome, ecoregion, claim_radius_m, resource_vision_radius_m,
             environment_snapshot, geom, control_type, city_id,
             access_mode, jump_toll_gold, city_affiliated_at,
             city_affiliated_by_player_id, original_owner_player_id,
             contributed_by_player_id, original_personal_color
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,
             ST_SetSRID(ST_MakePoint($5,$4),4326),$14,$15,
             'public',0,now(),NULL,NULL,NULL,NULL
           )`,
          [
            flagId,
            player.playerId,
            flagName,
            placed.lat,
            placed.lon,
            environment.packageId,
            environment.elevationM,
            environment.terrainClass,
            environment.biome,
            environment.ecoregion,
            claimRadiusM,
            Number(this.config.FLAG_RESOURCE_VISION_RADIUS_M),
            environment.snapshotJson,
            placed.slot === 0 ? "city_seat" : "city",
            cityId
          ]
        );
        if (placed.slot !== 0) {
          await client.query(
            `INSERT INTO city_flag_affiliation_history (
               id, city_id, flag_id, flag_owner_player_id, performed_by_player_id,
               action, reason, request_id, prior_city_id, resulting_city_id, metadata
             ) VALUES (
               $1,$2,$3,$4,$4,'affiliated','developer_capital_generated',$5,NULL,$2,$6::jsonb
             )`,
            [
              randomUUID(),
              cityId,
              flagId,
              player.playerId,
              input.requestId,
              JSON.stringify({ slot: placed.slot })
            ]
          );
        }
        territoryFlagIds.push(flagId);
      }
      const seatFlagId = territoryFlagIds[0]!;
      for (const annexed of annexedFlags) {
        // User rule for the capital: annexed flags belong to the city, held by its Mayor.
        const changed = await client.query(
          `UPDATE flags
           SET owner_id = $3, control_type = 'city', city_id = $2, name = $4,
               health = NULL, maximum_health = NULL,
               burning_started_at = NULL, burning_until = NULL, burning_reason = NULL,
               access_mode = 'public', jump_toll_gold = 0,
               city_affiliated_at = now(), city_affiliated_by_player_id = NULL,
               original_owner_player_id = NULL,
               contributed_by_player_id = NULL,
               original_personal_color = NULL
           WHERE id = $1 AND control_type = 'personal'
             AND city_id IS NULL AND kingdom_id IS NULL`,
          [annexed.flagId, cityId, player.playerId, flagName]
        );
        if (changed.rowCount !== 1) {
          throw new CityFoundingError(
            "CITY_FLAG_LIFECYCLE_CHANGED",
            "A flag inside the capital footprint changed while it was being annexed"
          );
        }
        await detachConvertedCityFlagAccess(client, annexed.flagId);
        await client.query(
          `INSERT INTO city_flag_affiliation_history (
             id, city_id, flag_id, flag_owner_player_id, performed_by_player_id,
             action, reason, request_id, prior_city_id, resulting_city_id, metadata
           ) VALUES (
             $1,$2,$3,$4,$5,'affiliated','developer_capital_annexation',$6,NULL,$2,$7::jsonb
           )`,
          [
            randomUUID(),
            cityId,
            annexed.flagId,
            annexed.previousOwnerPlayerId,
            player.playerId,
            input.requestId,
            JSON.stringify({ previousOwnerPlayerId: annexed.previousOwnerPlayerId })
          ]
        );
        territoryFlagIds.push(annexed.flagId);
      }
      await client.query("UPDATE cities SET seat_flag_id = $2 WHERE id = $1", [cityId, seatFlagId]);
      await client.query(
        `INSERT INTO player_discovered_cities (player_id, city_id, first_visited_at, last_visited_at)
         VALUES ($1,$2,now(),now())
         ON CONFLICT (player_id, city_id) DO UPDATE
         SET last_visited_at = EXCLUDED.last_visited_at`,
        [player.playerId, cityId]
      );
      const seeded = await structures.seedDeveloperCapitalStructuresInTransaction(client, {
        cityId,
        playerId: player.playerId,
        requestId: input.requestId
      });
      const plan: DeveloperCapitalFoundingPlan = {
        cityName: settlement.name,
        municipalityId: settlement.settlementId,
        municipalityLabel: municipalityLabel(settlement),
        hall: {
          lat: hall.lat,
          lon: hall.lon,
          snappedFromAnchorM: Math.round(distanceMeters(anchor, hall))
        },
        candidateFlagCount: slots.length,
        placedFlags,
        skippedFlags,
        annexedFlags,
        excludedFlags,
        structures: seeded.structures.map((structure) => ({
          type: structure.type as DeveloperCapitalStructureType,
          lat: structure.lat,
          lon: structure.lon
        })),
        marketVenueKey: `city:${cityId}`,
        currentCity: membership
          ? { cityId: membership.cityId, cityName: membership.cityName, role: membership.role }
          : null,
        leaveRequired: membership !== null,
        leave
      };
      await client.query(
        `INSERT INTO city_flag_affiliation_history (
           id, city_id, flag_id, flag_owner_player_id, performed_by_player_id,
           action, reason, request_id, prior_city_id, resulting_city_id, metadata
         ) VALUES ($1,$2,$3,$4,$4,'seat_founded','developer_capital',$5,NULL,$2,$6::jsonb)`,
        [
          randomUUID(),
          cityId,
          seatFlagId,
          player.playerId,
          input.requestId,
          JSON.stringify({ developerCapital: plan })
        ]
      );
      const city = rowToCity(await loadCityById(client, cityId, this.config.WORLD_ID));
      if (input.dryRun) {
        await client.query("ROLLBACK");
        return {
          dryRun: true,
          replayed: false,
          plan,
          city: null,
          territoryFlagIds: [],
          structures: [],
          membership: null,
          leftHouse: null
        };
      }
      await client.query("COMMIT");
      this.logger.info(
        {
          cityId,
          founderPlayerId: player.playerId,
          municipalityId: settlement.settlementId,
          placedFlags: placedFlags.length,
          skippedFlags: skippedFlags.length,
          leftCityId: leave?.cityId ?? null
        },
        "developer capital founded"
      );
      return {
        dryRun: false,
        replayed: false,
        plan,
        city,
        territoryFlagIds,
        structures: seeded.structures,
        membership: seeded.membership,
        leftHouse
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isMunicipalityUniqueViolation(error)) {
        throw new CityFoundingError(
          "CITY_MUNICIPALITY_ALREADY_FOUNDED",
          `${municipalityLabel(settlement)} has already been founded in this world`
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async findDeveloperCapitalReplay(
    playerId: string,
    requestId: string,
    queryable: Queryable = this.pool
  ): Promise<DeveloperCapitalFoundingResult | null> {
    const result = await queryable.query<
      CityRow & { capital_plan: DeveloperCapitalFoundingPlan | null }
    >(
      `${CITY_SELECT.replace(
        "FROM cities c",
        `, (SELECT history.metadata->'developerCapital'
            FROM city_flag_affiliation_history history
            WHERE history.city_id = c.id AND history.action = 'seat_founded'
              AND history.reason = 'developer_capital'
            ORDER BY history.created_at LIMIT 1) AS capital_plan
         FROM cities c`
      )}
       WHERE c.founder_player_id = $1 AND c.founding_request_id = $2`,
      [playerId, requestId]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!row.capital_plan) {
      throw new CityFoundingError(
        "CITY_REQUEST_CONFLICT",
        "This request ID was already used to found a different city"
      );
    }
    const flags = await queryable.query<{ id: string }>(
      `SELECT id FROM flags WHERE city_id = $1
       ORDER BY CASE WHEN control_type = 'city_seat' THEN 0 ELSE 1 END, id`,
      [row.id]
    );
    return {
      dryRun: false,
      replayed: true,
      plan: row.capital_plan,
      city: rowToCity(row),
      territoryFlagIds: flags.rows.map(({ id }) => id),
      structures: (await this.structures?.listForCity(row.id)) ?? [],
      membership: await loadMembership(queryable, playerId, this.config.WORLD_ID),
      leftHouse: null
    };
  }

  private async lookupMunicipality(
    playerId: string,
    flag: CityFlagRow,
    hallPosition: LatLon
  ): Promise<SettlementLookupResult> {
    const requiredAuthority = this.settlementAuthority();
    const key = JSON.stringify([
      this.config.WORLD_ID,
      playerId,
      flag.id,
      flag.lifecycle_revision,
      hallPosition.lat,
      hallPosition.lon,
      requiredAuthority.releaseId,
      requiredAuthority.releaseFingerprint,
      requiredAuthority.foundingPolicyId,
      requiredAuthority.foundingPolicyFingerprint,
      requiredAuthority.resolutionPolicyId,
      requiredAuthority.resolutionPolicyFingerprint
    ]);
    const now = this.now();
    this.pruneSettlementPreviewCache(now);
    const cached = this.settlementPreviewCache.get(key);
    if (cached && cached.expiresAt > now) return cached.lookup;

    let request = this.settlementPreviewFlights.get(key);
    const ownsRequest = !request;
    if (!request) {
      request = (async () => {
        const lookup = await this.worldLookup.lookupSettlement(
          hallPosition.lat, hallPosition.lon
        );
        assertSettlementAuthority(lookup, requiredAuthority);
        const ttl = lookup.found && lookup.settlement.foundingEligible
          ? this.positivePreviewTtlMs
          : this.negativePreviewTtlMs;
        this.storeSettlementPreview(key, lookup, this.now() + ttl);
        return lookup;
      })();
      this.settlementPreviewFlights.set(key, request);
    }
    try {
      return await request;
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          flagId: flag.id,
          hallLat: hallPosition.lat,
          hallLon: hallPosition.lon
        },
        "municipal boundary lookup failed"
      );
      throw new CityFoundingError(
        "CITY_BOUNDARY_AUTHORITY_UNAVAILABLE",
        "City founding is unavailable because settlement authority could not be queried"
      );
    } finally {
      if (ownsRequest && this.settlementPreviewFlights.get(key) === request) {
        this.settlementPreviewFlights.delete(key);
      }
    }
  }

  private pruneSettlementPreviewCache(now: number): void {
    for (const [key, entry] of this.settlementPreviewCache) {
      if (entry.expiresAt <= now) this.settlementPreviewCache.delete(key);
    }
  }

  private storeSettlementPreview(
    key: string,
    lookup: SettlementLookupResult,
    expiresAt: number
  ): void {
    this.settlementPreviewCache.delete(key);
    while (this.settlementPreviewCache.size >= this.previewCacheMaxEntries) {
      const oldest = this.settlementPreviewCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.settlementPreviewCache.delete(oldest);
    }
    this.settlementPreviewCache.set(key, { lookup, expiresAt });
  }

  private async prepareFoundingFootprint(flag: CityFlagRow): Promise<{
    layouts: CityFoundingLayoutCandidate[];
    worlds: WorldGameplayEnvironmentResult[];
  }> {
    const layouts = buildCityFoundingLayoutCandidates(
      { lat: Number(flag.lat), lon: Number(flag.lon) },
      Number(flag.claim_radius_m),
      Number(this.config.FLAG_CLAIM_RADIUS_M)
    );
    try {
      const worlds = await this.worldLookup.lookupGameplayEnvironments(
        layouts.flatMap((layout) => layout.slots.map(({ position }) => position)),
        { caller: "city" }
      );
      return { layouts, worlds };
    } catch (error) {
      this.logger.warn(
        { err: error, flagId: flag.id },
        "city founding footprint terrain lookup failed"
      );
      throw new CityFoundingError(
        "CITY_BOUNDARY_AUTHORITY_UNAVAILABLE",
        "City founding is unavailable because the full territory footprint could not be verified"
      );
    }
  }

  private async findFoundingReplay(
    queryable: Queryable,
    playerId: string,
    requestId: string
  ): Promise<FoundCityResult | null> {
    const result = await queryable.query<CityRow>(
      `${CITY_SELECT}
       WHERE c.founder_player_id = $1 AND c.founding_request_id = $2`,
      [playerId, requestId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const flags = await queryable.query<{ id: string }>(
      `SELECT id FROM flags
       WHERE city_id = $1 AND control_type IN ('city_seat', 'city')
       ORDER BY CASE WHEN control_type = 'city_seat' THEN 0 ELSE 1 END, id`,
      [row.id]
    );
    return {
      city: rowToCity(row),
      seatFlagId: row.seat_flag_id,
      territoryFlagIds: flags.rows.map(({ id }) => id),
      annexedFlags: [],
      replayed: true
    };
  }

  private async joinResult(
    playerId: string,
    cityId: string,
    replayed: boolean
  ): Promise<CityJoinResult> {
    const [membership, info] = await Promise.all([
      loadMembership(this.pool, playerId, this.config.WORLD_ID),
      this.getCityInfo(playerId, cityId)
    ]);
    if (!membership || membership.cityId !== cityId) {
      throw new Error("city membership commit did not persist");
    }
    return { info, membership, replayed };
  }

  private async mayorResult(cityId: string, replayed: boolean): Promise<CityMayorResult> {
    const city = await this.getCity(cityId);
    if (!city) throw new CityFoundingError("CITY_NOT_FOUND", "City does not exist in this world");
    return { city, replayed };
  }

  private async leaveResult(
    playerId: string,
    cityId: string,
    replayed: boolean
  ): Promise<CityLeaveResult> {
    return {
      info: await this.getCityInfo(playerId, cityId),
      cityId,
      replayed
    };
  }
}

type LockedCityFoundingFootprint = {
  layout: CityFoundingResolvedLayout;
  flagsById: Map<string, CityFlagRow>;
};

async function lockAndResolveCityFoundingFootprint(
  queryable: Queryable,
  foundingFlag: CityFlagRow,
  expansionRadiusM: number,
  layouts: CityFoundingLayoutCandidate[],
  worlds: WorldGameplayEnvironmentResult[],
  allowUnresolvedWorld: boolean
): Promise<LockedCityFoundingFootprint | null> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('ash-atlas-flag-placement-v1', 0))"
  );
  const maximumRingRadiusM = Math.max(...layouts.map(({ radiusM }) => radiusM));
  const searchRadiusM =
    maximumRingRadiusM + MAX_FLAG_CLAIM_RADIUS_M + expansionRadiusM;
  const flags = await queryable.query<CityFlagRow>(
    `SELECT flag.id, flag.owner_id, owner.username AS owner_username,
            COALESCE(owner.display_color, '#d83a3a') AS owner_color,
            flag.anchor_kind, flag.control_type, flag.name, flag.lat, flag.lon, flag.claim_radius_m,
            flag.city_id, flag.kingdom_id,
            concat(flag.created_at::text, '/', flag.updated_at::text) AS lifecycle_revision,
            ST_Distance(
              flag.geom::geography,
              ST_SetSRID(ST_MakePoint($1,$2),4326)::geography
            ) AS distance_m
     FROM flags flag
     LEFT JOIN players owner ON owner.id = flag.owner_id
     WHERE ST_DWithin(
       flag.geom::geography,
       ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
       $3
     )
     ORDER BY flag.id
     FOR UPDATE OF flag`,
    [Number(foundingFlag.lon), Number(foundingFlag.lat), searchRadiusM]
  );
  const kingdomSeats = await queryable.query<{
    id: string;
    lat: number;
    lon: number;
    territory_radius_m: number;
  }>(
    `SELECT seat.id, seat.lat, seat.lon, seat.territory_radius_m
     FROM kingdom_seats seat
     JOIN kingdoms kingdom ON kingdom.id = seat.kingdom_id
     WHERE seat.status = 'active' AND kingdom.status = 'active'
       AND ST_DWithin(
         seat.geom::geography,
         ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
         $3 + seat.territory_radius_m
       )
     ORDER BY seat.id
     FOR UPDATE OF seat`,
    [Number(foundingFlag.lon), Number(foundingFlag.lat), searchRadiusM]
  );
  const flagsById = new Map(flags.rows.map((flag) => [flag.id, flag]));
  const annexableFlags: CityFlagRow[] = [];
  for (const flag of flags.rows) {
    if (
      flag.id === foundingFlag.id ||
      flag.owner_id !== foundingFlag.owner_id ||
      flag.anchor_kind !== "flag" ||
      flag.control_type !== "personal" ||
      flag.city_id !== null ||
      flag.kingdom_id !== null ||
      Number(flag.distance_m) >
        Number(foundingFlag.claim_radius_m) +
          Number(flag.claim_radius_m) +
          TERRITORY_EDGE_TOLERANCE_M ||
      await findForeignOrganizationConnection(queryable, flag.id, null, null)
    ) continue;
    annexableFlags.push(flag);
  }
  const personalCircles = annexableFlags.map((flag) => ({
      id: flag.id,
      ownerId: flag.owner_id,
      position: { lat: Number(flag.lat), lon: Number(flag.lon) },
      radiusM: Number(flag.claim_radius_m)
    }));
  const blockingCircles = flags.rows.map((flag) => ({
    id: flag.id,
    position: { lat: Number(flag.lat), lon: Number(flag.lon) },
    radiusM: Number(flag.claim_radius_m)
  }));
  const protectedCircles = [
    ...flags.rows
      .filter((flag) => flag.id !== foundingFlag.id && flag.control_type !== "personal")
      .map((flag) => ({
        id: flag.id,
        position: { lat: Number(flag.lat), lon: Number(flag.lon) },
        radiusM: Number(flag.claim_radius_m)
      })),
    ...kingdomSeats.rows.map((seat) => ({
      id: seat.id,
      position: { lat: Number(seat.lat), lon: Number(seat.lon) },
      radiusM: Number(seat.territory_radius_m)
    }))
  ];
  const layout = resolveCityFoundingLayout({
    center: { lat: Number(foundingFlag.lat), lon: Number(foundingFlag.lon) },
    centerRadiusM: Number(foundingFlag.claim_radius_m),
    expansionRadiusM,
    layouts,
    personalCircles,
    blockingCircles,
    protectedCircles,
    isNewCircleTerrainLegal: (worldPointIndex) => {
      const world = worlds[worldPointIndex];
      return Boolean(
        world &&
        (world.ok || allowUnresolvedWorld) &&
        classifyFlagPlacementTerrain(world) !== "water"
      );
    }
  });
  return layout ? { layout, flagsById } : null;
}

const CITY_SELECT = `
  SELECT c.id, c.world_id, c.canonical_municipality_id,
         c.world_settlement_id, c.world_settlement_source,
         c.world_source_settlement_id, c.settlement_class,
         c.settlement_release_id, c.settlement_release_fingerprint,
         c.settlement_founding_policy_id,
         c.settlement_founding_policy_fingerprint,
         c.settlement_resolution_policy_id,
         c.settlement_resolution_policy_fingerprint,
         c.name, c.controller_kind, c.culture, c.banner_color,
         c.country_code, c.region_code,
         c.founder_player_id, p.username AS founder_username,
         p.display_color AS founder_color, c.mayor_player_id,
         c.mayor_house_deadline,c.mayor_confirmed_at,
         mayor.username AS mayor_username, mayor.display_color AS mayor_color,
         c.seat_flag_id, c.hall_lat, c.hall_lon,
         c.founding_annex_radius_m, c.active, c.jumpable,
         c.construction_phase,c.construction_completed_at,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'playerId', contribution.actor_player_id,
             'stage', contribution.stage,
             'contributedAt', contribution.created_at
           ) ORDER BY contribution.contribution_id)
           FROM city_construction_contributions contribution
           WHERE contribution.city_id = c.id
         ), '[]'::jsonb) AS construction_contributions,
         c.spatial_revision, c.created_at
  FROM cities c
  LEFT JOIN players p ON p.id = c.founder_player_id
  LEFT JOIN players mayor ON mayor.id = c.mayor_player_id`;

function rowToCity(row: CityRow): CitySnapshot {
  const city: CitySnapshot = {
    id: row.id,
    worldId: row.world_id,
    worldSettlementId: row.canonical_municipality_id,
    worldSettlementSource: row.world_settlement_source,
    worldSourceSettlementId: row.world_source_settlement_id,
    settlementClass: row.settlement_class,
    settlementReleaseId: row.settlement_release_id,
    settlementReleaseFingerprint: row.settlement_release_fingerprint,
    name: row.name,
    controllerKind: row.controller_kind,
    culture: row.culture,
    bannerColor: row.banner_color,
    countryCode: row.country_code,
    regionCode: row.region_code,
    founderPlayerId: row.founder_player_id,
    mayorPlayerId: row.mayor_player_id,
    mayorConfirmed: row.mayor_confirmed_at !== null,
    founderMayorClaimDeadline: row.mayor_house_deadline
      ? new Date(row.mayor_house_deadline).toISOString()
      : null,
    seatFlagId: row.seat_flag_id,
    lat: Number(row.hall_lat),
    lon: Number(row.hall_lon),
    active: row.active,
    jumpable: row.jumpable,
    constructionPhase: row.construction_phase,
    constructionCompletedAt: row.construction_completed_at
      ? new Date(row.construction_completed_at).toISOString()
      : null,
    constructionContributions: row.construction_contributions.map((contribution) => ({
      ...contribution,
      contributedAt: new Date(contribution.contributedAt).toISOString()
    })),
    spatialRevision: String(row.spatial_revision),
    foundingAnnexRadiusM: Number(row.founding_annex_radius_m),
    createdAt: new Date(row.created_at).toISOString()
  };
  if (row.founder_username) city.founderUsername = row.founder_username;
  if (row.founder_color) city.founderColor = row.founder_color;
  if (row.mayor_username) city.mayorUsername = row.mayor_username;
  if (row.mayor_color) city.mayorColor = row.mayor_color;
  return city;
}

type ConstructionContributionRow = {
  city_id: string;
  action: "found_city" | CityConstructionAction;
};

type ConstructionTransition = {
  expectedPhase: CityConstructionPhase;
  nextPhase: CityConstructionPhase;
  stage: "foundation" | "framing" | "finishing";
  material: { itemId: "stone" | "wood"; quantity: number } | null;
};

function constructionTransition(action: CityConstructionAction): ConstructionTransition {
  switch (action) {
    case "build_foundation":
      return {
        expectedPhase: "blueprint",
        nextPhase: "foundation",
        stage: "foundation",
        material: { itemId: "stone", quantity: 120 }
      };
    case "build_frames":
      return {
        expectedPhase: "foundation",
        nextPhase: "framing",
        stage: "framing",
        material: { itemId: "wood", quantity: 450 }
      };
    case "finish":
      return {
        expectedPhase: "framing",
        nextPhase: "complete",
        stage: "finishing",
        material: null
      };
  }
}

function constructionPhaseMessage(phase: CityConstructionPhase): string {
  switch (phase) {
    case "blueprint": return "This city needs its foundation built next";
    case "foundation": return "This city needs its frames built next";
    case "framing": return "This city is ready for finishing";
    case "complete": return "This city is already complete";
  }
}

async function loadConstructionContribution(
  queryable: Queryable,
  playerId: string,
  requestId: string
): Promise<ConstructionContributionRow | null> {
  const result = await queryable.query<ConstructionContributionRow>(
    `SELECT city_id::text,action
     FROM city_construction_contributions
     WHERE actor_player_id=$1 AND request_id=$2`,
    [playerId, requestId]
  );
  return result.rows[0] ?? null;
}

function assertConstructionReplayIntent(
  replay: ConstructionContributionRow,
  input: { cityId: string; action: CityConstructionAction }
): void {
  if (replay.city_id !== input.cityId || replay.action !== input.action) {
    throw new CityFoundingError(
      "CITY_REQUEST_CONFLICT",
      "This request ID was already used for a different city construction action"
    );
  }
}

async function loadCityById(
  queryable: Queryable,
  cityId: string,
  worldId: string,
  lock = false
): Promise<CityRow> {
  const result = await queryable.query<CityRow>(
    `${CITY_SELECT}
     WHERE c.id=$1 AND c.world_id=$2 AND c.active
     ${lock ? "FOR UPDATE OF c" : ""}`,
    [cityId, worldId]
  );
  const city = result.rows[0];
  if (!city) {
    throw new CityFoundingError("CITY_NOT_FOUND", "City does not exist in this world");
  }
  return city;
}

async function loadPlayerAccountId(queryable: Queryable, playerId: string): Promise<string> {
  const result = await queryable.query<{ account_id: string }>(
    "SELECT account_id FROM players WHERE id=$1 FOR SHARE",
    [playerId]
  );
  const accountId = result.rows[0]?.account_id;
  if (!accountId) {
    throw new CityFoundingError("CITY_PLAYER_REQUIRED", "Player account is unavailable");
  }
  return accountId;
}

async function constructionResult(
  queryable: pg.PoolClient,
  inventory: NonNullable<CityServiceOptions["inventory"]>,
  wallet: NonNullable<CityServiceOptions["wallet"]>,
  playerId: string,
  action: CityConstructionAction,
  city: CitySnapshot,
  replayed: boolean
): Promise<AdvanceCityConstructionResult> {
  if (action === "finish") {
    const accountId = await loadPlayerAccountId(queryable, playerId);
    const snapshot = await wallet.snapshotInTransaction(queryable, playerId, accountId);
    return {
      action,
      city,
      replayed,
      walletGold: snapshot.gold,
      walletVersion: snapshot.revision
    };
  }
  return {
    action,
    city,
    replayed,
    inventory: await inventory.snapshotInTransaction(queryable, playerId)
  };
}

async function resolveFoundingFlag(
  queryable: Queryable,
  player: PlayerRecord,
  flagId: string,
  lock: boolean
): Promise<CityFlagRow> {
  const result = await queryable.query<CityFlagRow>(
    `SELECT flag.id, flag.owner_id, owner.username AS owner_username,
            COALESCE(owner.display_color, '#d83a3a') AS owner_color,
            flag.anchor_kind, flag.control_type, flag.name, flag.lat, flag.lon, flag.claim_radius_m,
            flag.city_id, flag.kingdom_id,
            concat(flag.created_at::text, '/', flag.updated_at::text) AS lifecycle_revision,
            ST_Distance(
              flag.geom::geography,
              ST_SetSRID(ST_MakePoint($2,$3),4326)::geography
            ) AS distance_m
     FROM flags flag
     LEFT JOIN players owner ON owner.id = flag.owner_id
     WHERE flag.id = $1${lock ? " FOR UPDATE OF flag" : ""}`,
    [flagId, player.position.lon, player.position.lat]
  );
  const flag = result.rows[0];
  if (!flag) {
    throw new CityFoundingError(
      "CITY_FOUNDING_FLAG_REQUIRED",
      "Select a completed personal flag to found a city"
    );
  }
  if (flag.owner_id !== player.playerId || !isPersonalFlagControlledByPlayer(flag, player.playerId)) {
    throw new CityFoundingError(
      "CITY_FOUNDING_FLAG_NOT_CONTROLLED",
      "The founding flag must be a personal flag you own and control",
      { flagId, ownerId: flag.owner_id, controlType: flag.control_type }
    );
  }
  if (flag.anchor_kind === "buoy") {
    throw new CityFoundingError(
      "CITY_FLAG_KIND_UNSUPPORTED",
      "Buoys cannot found or join a city"
    );
  }
  if (flag.city_id || flag.kingdom_id) {
    throw new CityFoundingError(
      "CITY_FOUNDING_FLAG_NOT_CONTROLLED",
      "A city- or Kingdom-controlled flag cannot found a city"
    );
  }
  if (Number(flag.distance_m) > Number(flag.claim_radius_m) + TERRITORY_EDGE_TOLERANCE_M) {
    throw new CityFoundingError(
      "CITY_FOUNDING_OUTSIDE_TERRITORY",
      "Stand inside the selected completed personal flag territory to found a city",
      {
        flagId,
        distanceM: Number(flag.distance_m),
        claimRadiusM: Number(flag.claim_radius_m),
        territoryEdgeToleranceM: TERRITORY_EDGE_TOLERANCE_M
      }
    );
  }
  return flag;
}

async function loadCityFlag(
  queryable: Queryable,
  flagId: string,
  lock: boolean
): Promise<CityFlagRow | null> {
  const result = await queryable.query<CityFlagRow>(
    `SELECT flag.id, flag.owner_id, owner.username AS owner_username,
            COALESCE(owner.display_color, '#d83a3a') AS owner_color,
            flag.anchor_kind, flag.control_type, flag.name, flag.lat, flag.lon, flag.claim_radius_m,
            flag.city_id, flag.kingdom_id, flag.reinforcement_level,
            concat(flag.created_at::text, '/', flag.updated_at::text) AS lifecycle_revision,
            0::double precision AS distance_m
     FROM flags flag
     LEFT JOIN players owner ON owner.id = flag.owner_id
     WHERE flag.id = $1${lock ? " FOR UPDATE OF flag" : ""}`,
    [flagId]
  );
  return result.rows[0] ?? null;
}

async function validateCityFlagConversion(
  queryable: Queryable,
  playerId: string,
  membership: CityMembershipSnapshot,
  flagId: string,
  lockFlag: boolean,
  options: CityFlagConversionOptions = {}
): Promise<{
  capacity: CityCapacity;
  flag: CityFlagRow;
  anchor: string;
}> {
  const capacity = await loadCityCapacity(queryable, membership.cityId);
  if (
    !options.exemptFromExpansionLimit &&
    capacity.expansionFlagCount >= capacity.expansionFlagLimit
  ) {
    throw new CityFoundingError(
      "CITY_EXPANSION_LIMIT_REACHED",
      cityExpansionLimitMessage(capacity),
      {
        expansionFlagCount: capacity.expansionFlagCount,
        expansionFlagLimit: capacity.expansionFlagLimit
      }
    );
  }
  const flag = await loadCityFlag(queryable, flagId, lockFlag);
  if (!flag) {
    throw new CityFoundingError("CITY_FLAG_LIFECYCLE_CHANGED", "The flag no longer exists");
  }
  if (!isPersonalFlagControlledByPlayer(flag, playerId)) {
    throw new CityFoundingError(
      "CITY_FOUNDING_FLAG_NOT_CONTROLLED",
      "Only a personal flag you own and control can be contributed"
    );
  }
  if (flag.anchor_kind === "buoy") {
    throw new CityFoundingError(
      "CITY_FLAG_KIND_UNSUPPORTED",
      "Buoys cannot be contributed to a city"
    );
  }
  if (flag.reinforcement_level === 2 || flag.reinforcement_level === 3) {
    throw new CityFoundingError(
      "CITY_FLAG_ATLAS_SHRINE_INELIGIBLE",
      flag.reinforcement_level === 3
        ? "Towers cannot be contributed to a city"
        : "Atlas Shrines cannot be contributed to a city"
    );
  }
  if (flag.city_id || flag.kingdom_id) {
    throw new CityFoundingError(
      "CITY_FLAG_ALREADY_CONTROLLED",
      "The flag is already controlled by a city or Kingdom"
    );
  }
  if (await findForeignOrganizationConnection(
    queryable,
    flag.id,
    membership.cityId,
    null
  )) {
    throw new CityFoundingError(
      "CITY_FLAG_FOREIGN_CONNECTION",
      "A city flag cannot connect to a Kingdom or another city"
    );
  }
  const anchor = await loadCityConnectionAnchor(queryable, membership.cityId, flag.id);
  if (!anchor) {
    throw new CityFoundingError(
      "CITY_FLAG_NOT_CONNECTED",
      "The flag territory must touch the City Center or connected city flag network"
    );
  }
  return { capacity, flag, anchor };
}

async function activeAffiliation(
  queryable: Queryable,
  playerId: string,
  worldId: string
): Promise<string | null> {
  const result = await queryable.query<{ city_name: string | null }>(
    `SELECT (SELECT c.name FROM city_memberships cm
        JOIN cities c ON c.id = cm.city_id
        JOIN city_structures house ON house.structure_id=cm.house_structure_id
          AND house.state='active'
        WHERE cm.player_id = $1 AND cm.left_at IS NULL
          AND c.world_id = $2 AND c.active LIMIT 1) AS city_name`,
    [playerId, worldId]
  );
  const row = result.rows[0];
  if (row?.city_name) return `Leave ${row.city_name} before founding another city`;
  return null;
}

async function loadMembership(
  queryable: Queryable,
  playerId: string,
  worldId: string
): Promise<CityMembershipSnapshot | null> {
  const result = await queryable.query<MembershipRow>(
    `SELECT membership.city_id, city.name AS city_name,
            CASE WHEN city.mayor_player_id = membership.player_id
                       AND city.mayor_confirmed_at IS NOT NULL
              THEN 'mayor' ELSE 'member' END AS role,
            membership.joined_at,
            membership.house_structure_id::text,
            (SELECT count(*)::text
             FROM city_memberships current_membership
             WHERE current_membership.city_id = membership.city_id
               AND current_membership.left_at IS NULL) AS member_count,
            (SELECT count(*)::text
             FROM flags city_flag
             WHERE city_flag.city_id = membership.city_id
               AND city_flag.control_type = 'city') AS expansion_flag_count
     FROM city_memberships membership
     JOIN cities city ON city.id = membership.city_id
     JOIN city_structures house
       ON house.structure_id=membership.house_structure_id
      AND house.state='active'
      AND house.structure_type IN ('city_house','mayor_house')
     WHERE membership.player_id = $1 AND membership.left_at IS NULL
       AND membership.world_id = $2 AND city.world_id = $2 AND city.active
     ORDER BY membership.joined_at DESC, membership.city_id
     LIMIT 1`,
    [playerId, worldId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const memberCount = Number(row.member_count);
  const expansionFlagCount = Number(row.expansion_flag_count);
  return {
    cityId: row.city_id,
    cityName: row.city_name,
    role: row.role,
    joinedAt: new Date(row.joined_at).toISOString(),
    houseStructureId: row.house_structure_id,
    expansionFlagCount,
    expansionFlagLimit: cityExpansionFlagLimit(memberCount)
  };
}

async function loadCityCapacity(
  queryable: Queryable,
  cityId: string
): Promise<CityCapacity> {
  const result = await queryable.query<{
    member_count: string;
    expansion_flag_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM city_memberships membership
        WHERE membership.city_id = $1 AND membership.left_at IS NULL) AS member_count,
       (SELECT count(*)::text
        FROM flags city_flag
        WHERE city_flag.city_id = $1 AND city_flag.control_type = 'city') AS expansion_flag_count`,
    [cityId]
  );
  const memberCount = Number(result.rows[0]?.member_count ?? 0);
  const expansionFlagCount = Number(result.rows[0]?.expansion_flag_count ?? 0);
  return {
    memberCount,
    expansionFlagCount,
    expansionFlagLimit: cityExpansionFlagLimit(memberCount)
  };
}

async function lockCityFlagNetworkMutation(
  queryable: Queryable,
  cityId: string
): Promise<void> {
  await queryable.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `city-flag-network:${cityId}`
  ]);
}

async function detachConvertedCityFlagAccess(
  queryable: Queryable,
  flagId: string
): Promise<void> {
  await queryable.query(
    "UPDATE normal_flag_passage_requests SET source_flag_id = NULL WHERE source_flag_id = $1",
    [flagId]
  );
}

function cityExpansionLimitMessage(capacity: CityCapacity): string {
  const overCapacity = capacity.expansionFlagCount > capacity.expansionFlagLimit
    ? " (over capacity)"
    : "";
  return `City expansion limit reached: ${capacity.expansionFlagCount} of ` +
    `${capacity.expansionFlagLimit} flags${overCapacity}.`;
}

async function loadCityConnectionAnchor(
  queryable: Queryable,
  cityId: string,
  targetFlagId: string
): Promise<string | null> {
  const result = await queryable.query<{ id: string }>(
    `WITH RECURSIVE connected(id) AS (
       SELECT seat.id
       FROM cities city
       JOIN flags seat ON seat.id = city.seat_flag_id
       WHERE city.id = $1 AND city.active
         AND seat.city_id = city.id AND seat.control_type = 'city_seat'
       UNION
       SELECT candidate.id
       FROM connected
       JOIN flags current_flag ON current_flag.id = connected.id
       JOIN flags candidate
         ON candidate.city_id = $1
        AND candidate.control_type = 'city'
        AND candidate.id <> current_flag.id
        AND ST_DWithin(
          candidate.geom::geography,
          current_flag.geom::geography,
          candidate.claim_radius_m + current_flag.claim_radius_m + $3
        )
     )
     SELECT neighbor.id
     FROM flags target
     JOIN connected ON true
     JOIN flags neighbor ON neighbor.id = connected.id
      AND ST_DWithin(
        target.geom::geography,
        neighbor.geom::geography,
        target.claim_radius_m + neighbor.claim_radius_m + $3
      )
     WHERE target.id = $2
     ORDER BY ST_Distance(target.geom::geography, neighbor.geom::geography), neighbor.id
     LIMIT 1`,
    [cityId, targetFlagId, FLAG_CONTROL_TOUCH_TOLERANCE_M]
  );
  return result.rows[0]?.id ?? null;
}

type CityFlagPruneResult = {
  affectedFlagIds: string[];
  ownerPlayerIds: string[];
};

const CITY_FLAG_NETWORK_LIMIT = 1_000;

export function isCityControlledFlag(flag: {
  control_type: string;
  city_id?: string | null;
}): boolean {
  return (flag.control_type === "city" || flag.control_type === "city_seat")
    && Boolean(flag.city_id);
}

/**
 * City flags belong to the city: only its confirmed Mayor manages them. The
 * contributing player keeps no rights over a converted flag.
 */
export async function assertCityFlagAction(
  queryable: Queryable,
  actorId: string,
  cityId: string
): Promise<void> {
  const result = await queryable.query<{ is_mayor: boolean }>(
    `SELECT city.mayor_player_id = membership.player_id
              AND city.mayor_confirmed_at IS NOT NULL AS is_mayor
     FROM city_memberships membership
     JOIN cities city ON city.id = membership.city_id
     WHERE membership.player_id = $1
       AND membership.city_id = $2
       AND membership.left_at IS NULL
       AND city.active
     LIMIT 1`,
    [actorId, cityId]
  );
  const membership = result.rows[0];
  if (!membership?.is_mayor) {
    throw new CityFoundingError(
      "CITY_PERMISSION_DENIED",
      "Only the city Mayor may manage city flags"
    );
  }
}

export async function lockCityFlagNetwork(
  queryable: Queryable,
  cityId: string
): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`city-flag-network:${cityId}`]
  );
  const locked = await queryable.query<{ id: string }>(
    `SELECT id
     FROM flags
     WHERE city_id = $1 AND control_type IN ('city', 'city_seat')
     ORDER BY id
     LIMIT $2
     FOR UPDATE`,
    [cityId, CITY_FLAG_NETWORK_LIMIT + 1]
  );
  if (locked.rows.length > CITY_FLAG_NETWORK_LIMIT) {
    throw new CityFoundingError(
      "CITY_FLAG_NETWORK_LIMIT",
      "City flag network safety limit exceeded"
    );
  }
}

async function loadConnectedCityFlagIds(
  queryable: Queryable,
  cityId: string,
  excludedFlagIds: string[]
): Promise<string[]> {
  const result = await queryable.query<{ id: string }>(
    `WITH RECURSIVE connected(id) AS (
       SELECT seat.id
       FROM cities city
       JOIN flags seat ON seat.id = city.seat_flag_id
       WHERE city.id = $1
         AND city.active
         AND seat.city_id = city.id
         AND seat.control_type = 'city_seat'
         AND NOT (seat.id = ANY($2::uuid[]))
       UNION
       SELECT candidate.id
       FROM connected
       JOIN flags current_flag ON current_flag.id = connected.id
       JOIN flags candidate
         ON candidate.city_id = $1
        AND candidate.control_type = 'city'
        AND candidate.id <> current_flag.id
        AND NOT (candidate.id = ANY($2::uuid[]))
        AND ST_DWithin(
          candidate.geom::geography,
          current_flag.geom::geography,
          candidate.claim_radius_m + current_flag.claim_radius_m + $3
        )
     )
     SELECT id FROM connected ORDER BY id`,
    [cityId, excludedFlagIds, FLAG_CONTROL_TOUCH_TOLERANCE_M]
  );
  return result.rows.map(({ id }) => id);
}

async function cityFlagRemovalSet(
  queryable: Queryable,
  cityId: string,
  initialFlagIds: string[]
): Promise<string[]> {
  const all = await queryable.query<{ id: string }>(
    "SELECT id FROM flags WHERE city_id = $1 AND control_type = 'city' ORDER BY id",
    [cityId]
  );
  if (all.rows.length > CITY_FLAG_NETWORK_LIMIT) {
    throw new CityFoundingError(
      "CITY_FLAG_NETWORK_LIMIT",
      "City flag network safety limit exceeded"
    );
  }
  const allIds = all.rows.map(({ id }) => id);
  const allSet = new Set(allIds);
  const initial = [...new Set(initialFlagIds.filter((id) => allSet.has(id)))];
  if (initial.length === 0) return [];
  const connected = new Set(await loadConnectedCityFlagIds(queryable, cityId, initial));
  return [
    ...initial,
    ...allIds.filter((id) => !initial.includes(id) && !connected.has(id))
  ];
}

/**
 * Removes flags from a city. Flags removed from the city, and every flag the
 * removal cuts off from the City Center network, BREAK (are deleted) instead of
 * reverting to personal control: a city flag belongs to the city. With
 * initialAction "flag_deleted" the caller deletes the initial flags itself.
 */
export async function clearAndPruneCityFlags(
  queryable: Queryable,
  cityId: string,
  initialFlagIds: string[],
  actorId: string | null,
  reason: string,
  initialAction: "removed" | "flag_deleted" = "removed"
): Promise<CityFlagPruneResult> {
  await lockCityFlagNetwork(queryable, cityId);
  const rows = await queryable.query<CityFlagRow>(
    `SELECT flag.id, flag.owner_id, owner.username AS owner_username,
            COALESCE(owner.display_color, '#d83a3a') AS owner_color,
            flag.anchor_kind, flag.control_type, flag.name, flag.lat, flag.lon, flag.claim_radius_m,
            flag.city_id, flag.kingdom_id, 0::double precision AS distance_m
     FROM flags flag
     LEFT JOIN players owner ON owner.id = flag.owner_id
     WHERE flag.city_id = $1
     ORDER BY flag.id
     FOR UPDATE OF flag`,
    [cityId]
  );
  const affectedIds = await cityFlagRemovalSet(queryable, cityId, initialFlagIds);
  if (affectedIds.length === 0) {
    return { affectedFlagIds: [], ownerPlayerIds: [] };
  }
  const initialSet = new Set(initialFlagIds);
  const breakingIds = initialAction === "flag_deleted"
    ? affectedIds.filter((id) => !initialSet.has(id))
    : affectedIds;
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  for (const id of affectedIds) {
    const flag = byId.get(id);
    if (!flag) continue;
    await insertCityFlagHistory(queryable, {
      cityId,
      flag,
      actorId,
      action: initialSet.has(id) ? initialAction : "pruned",
      reason: initialSet.has(id) ? reason : `disconnected_after:${reason}`,
      resultingCityId: null,
      metadata: { downstream: !initialSet.has(id), broken: true }
    });
  }
  const broken = await breakTerritoryFlagsInTransaction(queryable, breakingIds);
  await queryable.query(
    "UPDATE cities SET spatial_revision = spatial_revision + 1 WHERE id = $1",
    [cityId]
  );
  return {
    affectedFlagIds: broken.map(({ id }) => id),
    ownerPlayerIds: [...new Set(broken.map(({ ownerId }) => ownerId))]
  };
}

async function insertCityFlagHistory(
  queryable: Queryable,
  input: {
    cityId: string;
    flag: CityFlagRow;
    actorId: string | null;
    action: "seat_founded" | "affiliated" | "removed" | "pruned" | "flag_deleted" | "city_deactivated";
    reason: string;
    requestId?: string | null;
    resultingCityId?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await queryable.query(
    `INSERT INTO city_flag_affiliation_history (
       id, city_id, flag_id, flag_owner_player_id, performed_by_player_id,
       action, reason, request_id, prior_city_id, resulting_city_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      randomUUID(),
      input.cityId,
      input.flag.id,
      input.flag.owner_id,
      input.actorId,
      input.action,
      input.reason,
      input.requestId ?? null,
      input.flag.city_id,
      input.resultingCityId ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

type MutationRow = {
  operation: string;
  city_id: string;
  flag_id: string | null;
};

async function loadMutation(
  queryable: Queryable,
  actorId: string,
  requestId: string
): Promise<MutationRow | null> {
  const result = await queryable.query<MutationRow>(
    `SELECT operation, city_id, flag_id
     FROM city_mutations WHERE actor_player_id = $1 AND request_id = $2`,
    [actorId, requestId]
  );
  return result.rows[0] ?? null;
}

async function insertMutation(
  queryable: Queryable,
  actorId: string,
  requestId: string,
  operation:
    | "join_city"
    | "leave_city"
    | "convert_city_flag"
    | "claim_city_mayor"
    | "relinquish_city_mayor",
  cityId: string,
  flagId: string | null
): Promise<void> {
  await queryable.query(
    `INSERT INTO city_mutations (
       actor_player_id, request_id, operation, city_id, flag_id
     ) VALUES ($1,$2,$3,$4,$5)`,
    [actorId, requestId, operation, cityId, flagId]
  );
}

function assertMutationReplay(
  row: MutationRow,
  operation: MutationRow["operation"],
  cityId: string,
  flagId: string | null
): void {
  if (row.operation !== operation || row.city_id !== cityId || row.flag_id !== flagId) {
    throw new CityFoundingError(
      "CITY_REQUEST_CONFLICT",
      "This request ID was already used for a different city action"
    );
  }
}

function municipalitySnapshot(settlement: WorldSettlement): {
  municipalityId: string;
  name: string;
  countryCode: string;
  regionCode: string | null;
  jurisdictionName: string | null;
  municipalityType: SettlementClass;
} {
  return {
    municipalityId: settlement.settlementId,
    name: settlement.name,
    countryCode: settlement.countryCode,
    regionCode: settlement.regionCode,
    jurisdictionName: settlement.jurisdictionName,
    municipalityType: settlement.settlementClass
  };
}

function assertSettlementAuthority(
  lookup: SettlementLookupResult,
  required: SettlementAuthorityIdentity
): void {
  if (
    lookup.authority.releaseId !== required.releaseId ||
    lookup.authority.releaseFingerprint !== required.releaseFingerprint ||
    lookup.authority.foundingPolicyId !== required.foundingPolicyId ||
    lookup.authority.foundingPolicyFingerprint !== required.foundingPolicyFingerprint ||
    lookup.authority.resolutionPolicyId !== required.resolutionPolicyId ||
    lookup.authority.resolutionPolicyFingerprint !== required.resolutionPolicyFingerprint
  ) {
    throw new Error("World settlement authority does not match the pinned release and policy");
  }
}

function assertFoundingFlagUnchanged(preflight: CityFlagRow, locked: CityFlagRow): void {
  if (
    locked.id !== preflight.id ||
    locked.owner_id !== preflight.owner_id ||
    locked.control_type !== preflight.control_type ||
    locked.city_id !== preflight.city_id ||
    locked.kingdom_id !== preflight.kingdom_id ||
    Number(locked.lat) !== Number(preflight.lat) ||
    Number(locked.lon) !== Number(preflight.lon) ||
    Number(locked.claim_radius_m) !== Number(preflight.claim_radius_m) ||
    locked.lifecycle_revision !== preflight.lifecycle_revision
  ) {
    throw new CityFoundingError(
      "CITY_FLAG_LIFECYCLE_CHANGED",
      "The founding flag changed during confirmation"
    );
  }
}

function nearestSnapshot(
  lookup: Extract<SettlementLookupResult, { found: false }>
): NearestMunicipalitySnapshot | null {
  const nearest = lookup.nearest;
  if (!nearest) return null;
  return {
    municipalityId: nearest.municipalityId,
    name: nearest.name,
    countryCode: nearest.countryCode,
    regionCode: nearest.regionCode,
    jurisdictionName: nearest.jurisdictionName,
    distanceM: nearest.distanceM,
    direction: compassDirection(nearest.bearingDegrees)
  };
}

export function compassDirection(bearingDegrees: number): string {
  const directions = [
    "north", "northeast", "east", "southeast",
    "south", "southwest", "west", "northwest"
  ] as const;
  const normalized = ((bearingDegrees % 360) + 360) % 360;
  return directions[Math.round(normalized / 45) % directions.length]!;
}

function outsideMunicipalityMessage(
  lookup: Extract<SettlementLookupResult, { found: false }>
): string {
  const nearest = nearestSnapshot(lookup);
  if (!nearest) return "No recognized city at this location";
  return `No recognized city at this location. ${nearest.name}, ${
    nearest.jurisdictionName ?? nearest.regionCode ?? nearest.countryCode
  } is ${formatDistance(nearest.distanceM)} ${nearest.direction}.`;
}

function formatDistance(distanceM: number): string {
  return distanceM < 1_000
    ? `${Math.round(distanceM)} m`
    : `${(distanceM / 1_000).toFixed(distanceM < 10_000 ? 1 : 0)} km`;
}

function municipalityLabel(settlement: WorldSettlement): string {
  return `${settlement.name}, ${
    settlement.jurisdictionName ?? settlement.regionCode ?? settlement.countryCode
  }`;
}

function municipalityFoundingIneligibility(settlement: WorldSettlement): {
  code:
    | "CITY_MUNICIPALITY_TYPE_INELIGIBLE"
    | "CITY_MUNICIPALITY_POPULATION_INELIGIBLE";
  message: string;
  details: Record<string, unknown>;
} {
  const details = {
    settlementId: settlement.settlementId,
    settlementClass: settlement.settlementClass,
    population: settlement.population,
    minimumFoundingPopulation: settlement.minimumFoundingPopulation,
    foundingIneligibilityReason: settlement.foundingIneligibilityReason
  };
  if (
    settlement.foundingIneligibilityReason === null ||
    settlement.foundingIneligibilityReason === "class_ineligible"
  ) {
    return {
      code: "CITY_MUNICIPALITY_TYPE_INELIGIBLE",
      message: "This City Hall placement is not inside an eligible settlement area",
      details
    };
  }
  if (settlement.minimumFoundingPopulation === null) {
    throw new Error("World settlement authority omitted the minimum founding population");
  }
  const minimum = settlement.minimumFoundingPopulation.toLocaleString("en-US");
  const label = municipalityLabel(settlement);
  if (settlement.foundingIneligibilityReason === "population_missing") {
    return {
      code: "CITY_MUNICIPALITY_POPULATION_INELIGIBLE",
      message: `Population data is unavailable for ${label}. City founding requires a verified population of at least ${minimum}.`,
      details
    };
  }
  if (settlement.population === null) {
    throw new Error("World settlement authority omitted the settlement population");
  }
  return {
    code: "CITY_MUNICIPALITY_POPULATION_INELIGIBLE",
    message: `${label} has a population of ${settlement.population.toLocaleString("en-US")}. City founding requires at least ${minimum}.`,
    details
  };
}

function foundingFlagSnapshot(flag: CityFlagRow) {
  return {
    id: flag.id,
    name: flag.name,
    ownerColor: flag.owner_color,
    lat: Number(flag.lat),
    lon: Number(flag.lon),
    claimRadiusM: Number(flag.claim_radius_m)
  };
}

function isMunicipalityUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" &&
    "code" in error && (error as { code?: unknown }).code === "23505" &&
    "constraint" in error &&
    (error as { constraint?: unknown }).constraint ===
      "cities_world_canonical_municipality_unique"
  );
}

function emptyCityGold(): CityGoldSnapshot {
  return {
    balance: "0",
    capacity: String(CITY_GOLD_CAPACITY),
    remainingCapacity: String(CITY_GOLD_CAPACITY),
    lifetimeDonated: "0",
    lifetimeSpent: "0",
    revision: "0",
    canDonate: false,
    recentDonations: []
  };
}

function emptyCityDistrict(): CityDistrictSnapshot {
  return {
    districtRevision: "0",
    monuments: {
      mining: { districtType: "mining", structureId: null, status: "inactive", tier: null },
      forestry: { districtType: "forestry", structureId: null, status: "inactive", tier: null },
      hunting: { districtType: "hunting", structureId: null, status: "inactive", tier: null }
    },
    memberBenefit: EMPTY_CITY_DISTRICT_BENEFIT,
    standardBuyerTaxBps: CITY_MARKET_STANDARD_BUYER_TAX_BPS,
    specialtyBuyerTaxBps: CITY_MARKET_SPECIALTY_BUYER_TAX_BPS,
    specialtyDescriptions: {}
  };
}

async function loadCityDistrictSnapshot(
  queryable: Queryable,
  benefits: CityDistrictBenefitService,
  cityId: string,
  memberPlayerId: string | null
): Promise<CityDistrictSnapshot> {
  const result = await queryable.query<{
    district_revision: string;
  }>(
    `SELECT district_revision::text FROM cities WHERE id = $1`,
    [cityId]
  );
  const row = result.rows[0];
  if (!row) return emptyCityDistrict();
  const monumentRows = await queryable.query<{
    structure_id: string;
    district_type: "mining" | "forestry" | "hunting";
    state: "constructing" | "active";
    tier: 1 | 2 | 3;
  }>(
    `SELECT structure_id::text,district_type,state,tier
     FROM city_structures
     WHERE city_id = $1
       AND structure_type = 'monument'
       AND state IN ('constructing','active')
     ORDER BY district_type`,
    [cityId]
  );
  const monuments = emptyCityDistrict().monuments as Record<
    "mining" | "forestry" | "hunting",
    CityDistrictSnapshot["monuments"]["mining"]
  >;
  for (const monument of monumentRows.rows) {
    monuments[monument.district_type] = {
      districtType: monument.district_type,
      structureId: monument.structure_id,
      status: monument.state,
      tier: monument.tier
    };
  }
  const memberBenefit = memberPlayerId
    ? await benefits.resolveForPlayer(queryable, memberPlayerId)
    : EMPTY_CITY_DISTRICT_BENEFIT;
  return {
    districtRevision: row.district_revision,
    monuments,
    memberBenefit,
    standardBuyerTaxBps: CITY_MARKET_STANDARD_BUYER_TAX_BPS,
    specialtyBuyerTaxBps: CITY_MARKET_SPECIALTY_BUYER_TAX_BPS,
    specialtyDescriptions: Object.fromEntries(
      CITY_DISTRICT_TYPES.flatMap((districtType) =>
        monuments[districtType].status !== "active"
          ? []
          : [[districtType, districtType === "mining"
            ? "4.5% buyer tax on Stone, Ore, and future Mining materials"
            : districtType === "forestry"
              ? "4.5% buyer tax on Wood and Frond Sap"
              : "4.5% buyer tax on Leather and Atlas Shrine Shards"]]
      )
    )
  };
}

import { LibraryStudyService } from "./libraryStudy.js";
import { CityMarketDailyService } from "./cityMarketDaily.js";
import { randomUUID } from "node:crypto";

import {
  cityBuildingWarfareProfile,
  type CityBuildingWarfareSnapshot,
  CITY_FACILITY_COSTS,
  CITY_HALL_FOOTPRINT_RADIUS_M,
  CITY_HOUSE_COST,
  CITY_MARKET_COST,
  CITY_MARKET_MAX_LEVEL,
  cityMarketUpgradeCost,
  CITY_MONUMENT_COSTS,
  OIL_WELL_COST,
  QUARTZ_HUT_CAPACITY,
  QUARTZ_HUT_COST,
  QUARTZ_HUT_ITEM_ID,
  QUARTZ_HUT_PRODUCTION_PER_HOUR,
  QUARTZ_HUT_UNIT_INTERVAL_MS,
  LIBRARY_COST,
  isPersonalBuildingStructureType,
  type PersonalBuildingStructureType,
  isPersonalProducerStructureType,
  type CityMaterialCost,
  type PersonalProducerStructureType,
  OIL_WELL_INTERACTION_RADIUS_M,
  OIL_WELL_OWNER_VISIBILITY_RADIUS_M,
  OIL_WELL_PRODUCTION_PER_HOUR,
  OIL_WELL_UNIT_INTERVAL_MS,
  CITY_STRUCTURE_EXCLUSION_MARGIN_M,
  CITY_STRUCTURE_FOOTPRINT_RADIUS_M,
  CITY_STRUCTURE_INTERACTION_RADIUS_M,
  MILITARY_CITY_FACILITY_COSTS,
  MILITARY_FACILITY_TYPES,
  cityConstructionDurationMs,
  cityStructureExclusionRadiusM,
  cityStructureRequiredCenterDistanceM,
  destinationPoint,
  oilWellCapacityForOilWorkerRank,
  type ActiveCityStructureType,
  type CityActiveConstructionSnapshot,
  type CityPhysicalConstructionAction,
  type CityDistrictType,
  type CityFacilityType,
  type CityFacilityBuildType,
  type MilitaryFacilityType,
  type CityMembershipSnapshot,
  type CityStructureSnapshot,
  type CityStructureType,
  type DroppedItemSnapshot,
  type PlayerInventorySnapshot,
  type MasteryGrantResult,
  type OilWellSnapshot,
  type ResourceType
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  attackCityBuilding,
  reconcileCityBuildingWarfare,
  startCityBuildingRepair,
  stopCityBuildingRepairForPlayer,
  type CityBuildingAttackResult,
  type CityBuildingRepairerPresence,
  type CityBuildingWarfareSweep,
  type CityStructureWarfarePlayer
} from "./cityStructureWarfare.js";

import type { InventoryService } from "./inventory.js";
import type { CityTreasuryService } from "./cityTreasury.js";
import type { CityWarehouseService } from "./cityWarehouse.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { classifyLandFootprint } from "./landFootprintAuthority.js";
import { CityGoldService } from "./cityGold.js";
import { MasteryService } from "./masteries.js";
import { WalletOperationError, WalletService } from "./wallet.js";
import {
  createSystemGroundDropsInTransaction,
  type SystemGroundDropLine
} from "./droppedItems.js";

type Position = { lat: number; lon: number };
type CityLockRow = {
  id: string;
  world_id: string;
  region_code: string | null;
  name: string;
  controller_kind: "player" | "npc";
  founder_player_id: string;
  mayor_player_id: string | null;
  mayor_house_deadline: Date | string | null;
  mayor_confirmed_at: Date | string | null;
  hall_lat: number;
  hall_lon: number;
  spatial_revision: string;
  district_revision: string;
  construction_phase: "blueprint" | "foundation" | "framing" | "complete";
};

type StructureRow = {
  structure_id: string;
  city_id: string;
  city_controller_kind?: "player" | "npc";
  city_culture?: "human" | "goblin";
  structure_type: CityStructureType;
  tier: CityStructureSnapshot["tier"];
  district_type: CityDistrictType | null;
  owner_player_id: string | null;
  owner_username?: string | null;
  world_id: string;
  region_code: string | null;
  lat: number;
  lon: number;
  footprint_radius_m: number;
  placement_revision: string;
  state: "constructing" | "active" | "destroyed";
  built_at: Date | string | null;
  upgraded_at: Date | string | null;
  destroyed_at: Date | string | null;
  construction_started_at: Date | string | null;
  construction_completes_at: Date | string | null;
  build_operation_key: string;
  harvest_access_mode: "private" | "public" | null;
  harvest_access_revision: number | string;
  health?: number | null;
  health_at?: Date | string | null;
  burning_since?: Date | string | null;
  repair_player_id?: string | null;
};

export class CityStructureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CityStructureError";
  }
}

export type CityHouseMutationResult = {
  structure: CityStructureSnapshot;
  membership: CityMembershipSnapshot | null;
  replayed: boolean;
  inventory?: PlayerInventorySnapshot;
  droppedItems?: DroppedItemSnapshot[];
  destroyedStructures?: CityStructureSnapshot[];
};

export type CityConstructionCompletion = {
  actorPlayerId: string;
  requestId: string;
  structure: CityStructureSnapshot;
  membership: CityMembershipSnapshot | null;
  inventory?: PlayerInventorySnapshot;
  droppedItems?: DroppedItemSnapshot[];
};

export type CityFacilityMutationResult = {
  structure: CityStructureSnapshot;
  replayed?: boolean;
  inventory?: PlayerInventorySnapshot;
  droppedItems?: DroppedItemSnapshot[];
};

export type CityWarDestruction = {
  structure: CityStructureSnapshot;
  ownerPlayerId: string | null;
  /** A destroyed City House ends its owner's city membership. */
  membershipEnded: boolean;
};

export type CityConstructionCancellation = CityFacilityMutationResult & {
  action: CityPhysicalConstructionAction;
};

export type OilWellHarvestResult = {
  well: OilWellSnapshot;
  inventory: PlayerInventorySnapshot;
  harvestedQuantity: number;
  replayed: boolean;
  message: string;
  masteryGrant?: MasteryGrantResult;
  tollGold?: string;
  walletGold?: string;
  walletVersion?: string;
};

export class CityStructureService {
  readonly gold: CityGoldService;
  readonly marketDaily: CityMarketDailyService;
  private readonly masteries: MasteryService;
  private readonly wallet: WalletService;
  readonly library: LibraryStudyService;

  constructor(
    private readonly pool: pg.Pool,
    private readonly worldId: string,
    private readonly inventory: Pick<
      InventoryService,
      "debitItemsForOperationInTransaction" |
      "grantItemsForOperationInTransaction" |
      "snapshotInTransaction"
    >,
    readonly treasury: CityTreasuryService,
    readonly warehouse: CityWarehouseService,
    private readonly worldLookup?: Pick<WorldLookupClient, "lookupGameplayEnvironments">
  ) {
    this.gold = new CityGoldService(pool);
    this.marketDaily = new CityMarketDailyService(pool, treasury);
    this.masteries = new MasteryService(pool);
    this.wallet = new WalletService(pool);
    this.library = new LibraryStudyService(pool, this.wallet);
  }

  async listForCity(cityId: string): Promise<CityStructureSnapshot[]> {
    const result = await this.pool.query<StructureRow>(
      `${STRUCTURE_SELECT}
       WHERE city_id=$1 AND state<>'destroyed'
         AND structure_type IN (
           'city_house','mayor_house','oil_well','quartz_hut','library','warehouse','cistern_warrens','salon','city_kennel','market','monument',
           'barracks','demolition_factory'
         )
       ORDER BY structure_type,created_at,structure_id`,
      [cityId]
    );
    return result.rows.map(rowToStructure);
  }

  async listNear(position: Position, radiusM: number): Promise<CityStructureSnapshot[]> {
    const result = await this.pool.query<StructureRow>(
      `${STRUCTURE_SELECT}
       WHERE world_id=$1 AND state IN ('constructing','active')
         AND structure_type IN (
           'city_house','mayor_house','oil_well','quartz_hut','library','warehouse','cistern_warrens','salon','city_kennel','market','monument',
           'barracks','demolition_factory'
         )
         AND ST_DWithin(
           geom::geography,
           ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
           $4
         )
       ORDER BY ST_Distance(
         geom::geography,
         ST_SetSRID(ST_MakePoint($2,$3),4326)::geography
       ),structure_id`,
      [this.worldId, position.lon, position.lat, radiusM]
    );
    return result.rows.map(rowToStructure);
  }

  async getActiveHouse(structureId: string): Promise<CityStructureSnapshot | null> {
    const result = await this.pool.query<StructureRow>(
      `${STRUCTURE_SELECT}
       WHERE structure_id=$1::uuid
         AND world_id=$2
         AND state='active'
         AND structure_type IN ('city_house','mayor_house')`,
      [structureId, this.worldId]
    );
    return result.rows[0] ? rowToStructure(result.rows[0]) : null;
  }

  async getOilWellForOwner(
    playerId: string,
    structureType: PersonalBuildingStructureType = "oil_well"
  ): Promise<CityStructureSnapshot | null> {
    const result = await this.pool.query<StructureRow>(
      `${STRUCTURE_SELECT}
       WHERE owner_player_id=$1
         AND state IN ('constructing','active')
         AND structure_type=$2
       ORDER BY construction_started_at,structure_id
       LIMIT 1`,
      [playerId, structureType]
    );
    return result.rows[0] ? rowToStructure(result.rows[0]) : null;
  }

  async ownerOilWellProjection(
    playerId: string,
    position: Position
  ): Promise<CityStructureSnapshot | null> {
    const result = await this.pool.query<StructureRow>(
      `${STRUCTURE_SELECT}
       WHERE owner_player_id=$1 AND structure_type='oil_well' AND state='active'
         AND ST_DWithin(
           geom::geography,
           ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
           $4
         )
       LIMIT 1`,
      [
        playerId,
        position.lon,
        position.lat,
        OIL_WELL_OWNER_VISIBILITY_RADIUS_M
      ]
    );
    return result.rows[0] ? rowToStructure(result.rows[0]) : null;
  }

  async getActiveMarket(
    structureId: string,
    expectedPlacementRevision: string
  ): Promise<CityStructureSnapshot | null> {
    return this.getActiveJumpableStructure(
      structureId,
      expectedPlacementRevision,
      "market"
    );
  }

  async getActiveWarehouse(
    structureId: string,
    expectedPlacementRevision: string
  ): Promise<CityStructureSnapshot | null> {
    return this.getActiveJumpableStructure(
      structureId,
      expectedPlacementRevision,
      "warehouse"
    );
  }

  async getActiveJumpableStructure(
    structureId: string,
    expectedPlacementRevision: string,
    expectedType: "market" | "warehouse"
  ): Promise<CityStructureSnapshot | null> {
    const result = await this.pool.query<StructureRow>(
      `${QUALIFIED_STRUCTURE_SELECT}
       JOIN cities city
         ON city.id=structure.city_id
        AND city.active
       WHERE structure.structure_id=$1::uuid
         AND structure.world_id=$2
         AND structure.state='active'
         AND structure.structure_type=$3
         AND structure.placement_revision=$4::bigint`,
      [structureId, this.worldId, expectedType, expectedPlacementRevision]
    );
    return result.rows[0] ? rowToStructure(result.rows[0]) : null;
  }

  async activeConstructionForPlayer(
    playerId: string
  ): Promise<CityActiveConstructionSnapshot | null> {
    const result = await this.pool.query<{
      operation_key: string;
      request_id: string;
      action: CityActiveConstructionSnapshot["action"];
      structure_id: string;
      lat: number;
      lon: number;
      construction_started_at: Date | string;
      construction_completes_at: Date | string;
    }>(
      `SELECT operation.operation_key,operation.request_id,operation.action,
              structure.structure_id::text,structure.lat,structure.lon,
              structure.construction_started_at,
              structure.construction_completes_at
       FROM city_structure_operations operation
       JOIN city_structures structure
         ON structure.build_operation_key=operation.operation_key
       WHERE operation.actor_player_id=$1
         AND operation.action IN (
           'build_house','build_oil_well','build_quartz_hut','build_library','build_facility','build_market','build_monument',
           'upgrade_facility','upgrade_monument'
         )
         AND structure.state='constructing'
       ORDER BY structure.construction_started_at,structure.structure_id
       LIMIT 1`,
      [playerId]
    );
    const row = result.rows[0];
    return row
      ? {
          operationKey: row.operation_key,
          requestId: row.request_id,
          action: row.action,
          structureId: row.structure_id,
          anchor: { lat: Number(row.lat), lon: Number(row.lon) },
          constructionStartedAt: new Date(
            row.construction_started_at
          ).toISOString(),
          constructionCompletesAt: new Date(
            row.construction_completes_at
          ).toISOString()
        }
      : null;
  }

  async buildHouse(
    playerId: string,
    position: Position,
    requestId: string
  ): Promise<CityHouseMutationResult> {
    assertPosition(position);
    const operationKey = `city-structure:${playerId}:${requestId}`;
    const replay = await this.replayHouse(operationKey, playerId, "build_house");
    if (replay) return replay;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        operationKey
      ]);
      await lockCityConstructionChannel(client, playerId);
      const lockedReplay = await this.replayHouse(
        operationKey,
        playerId,
        "build_house",
        client
      );
      if (lockedReplay) {
        await client.query("COMMIT");
        return lockedReplay;
      }
      await assertNoActiveCityConstruction(client, playerId, operationKey);
      const cityId = await resolveCityAtPosition(client, this.worldId, position);
      await lockPlayerAndCity(client, playerId, cityId);
      const city = await lockCity(client, cityId, this.worldId);
      const lockedCityId = await resolveCityAtPosition(client, this.worldId, position);
      if (lockedCityId !== cityId) {
        throw new CityStructureError(
          "CITY_HOUSE_CITY_TERRITORY_CHANGED",
          "City territory changed before the City House could be placed"
        );
      }
      await reconcileLockedFounderClaimDeadline(client, city);
      const affiliation = await client.query<{ city_id: string; city_name: string }>(
        `SELECT membership.city_id,city.name AS city_name
         FROM city_memberships membership
         JOIN cities city ON city.id=membership.city_id
         WHERE membership.player_id=$1 AND membership.left_at IS NULL
         LIMIT 1`,
        [playerId]
      );
      if (affiliation.rows[0]) {
        throw new CityStructureError(
          "CITY_ALREADY_MEMBER",
          `You already have an active City House in ${affiliation.rows[0].city_name}`
        );
      }
      const reservedHouse = await client.query<{ city_name: string }>(
        `SELECT city.name AS city_name
         FROM city_structures structure
         JOIN cities city ON city.id=structure.city_id
         WHERE structure.owner_player_id=$1
           AND structure.state IN ('constructing','active')
           AND structure.structure_type IN ('city_house','mayor_house')
         LIMIT 1
         FOR SHARE OF structure`,
        [playerId]
      );
      if (reservedHouse.rows[0]) {
        throw new CityStructureError(
          "CITY_HOUSE_ALREADY_RESERVED",
          `You already have a City House reserved in ${reservedHouse.rows[0].city_name}`
        );
      }
      const type: CityStructureType = "city_house";
      await validatePlacement(client, city, position, type, null, this.worldLookup);
      const structureId = randomUUID();
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: "build_house",
        cityId,
        structureId,
        intent: { cityId, position, type }
      });
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:inventory`,
        playerId,
        source: "city_house_construction",
        sourceEntityType: "city_structure",
        sourceEntityId: structureId,
        metadata: { cityId, structureType: type },
        debits: CITY_HOUSE_COST.materials.map((material) => ({
          itemId: material.itemId,
          variant: "default",
          quantity: BigInt(material.quantity)
        }))
      });
      const inserted = await insertStructure(client, {
        structureId,
        city,
        type,
        tier: 1,
        ownerPlayerId: playerId,
        position,
        operationKey
      });
      await recordStructureMaterialSpend(client, {
        structureId,
        tier: 1,
        paidByPlayerId: playerId,
        sourceOperationKey: operationKey,
        materials: CITY_HOUSE_COST.materials
      });
      await writeStructureEvent(
        client,
        operationKey,
        cityId,
        structureId,
        playerId,
        "built",
        {
          type,
          constructionDurationMs: cityConstructionDurationMs("build_house")
        }
      );
      const result = {
        structure: rowToStructure(inserted),
        membership: null,
        replayed: false
      };
      await completeStructureOperation(client, operationKey, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateStructureConstraint(error);
    } finally {
      client.release();
    }
  }

  /** Builds a personal producer: an Oil Well (default) or a Quartz Hut. */
  async buildOilWell(
    playerId: string,
    cityId: string,
    position: Position,
    requestId: string,
    structureType: PersonalBuildingStructureType = "oil_well"
  ): Promise<CityFacilityMutationResult> {
    assertPosition(position);
    const spec = PERSONAL_PRODUCERS[structureType];
    const operationKey = `city-structure:${playerId}:${requestId}`;
    const replay = await replayStructureOperation(
      this.pool,
      operationKey,
      playerId,
      spec.buildAction
    );
    if (replay) return replay as CityFacilityMutationResult;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        operationKey
      ]);
      await lockCityConstructionChannel(client, playerId);
      await lockPlayerAndCity(client, playerId, cityId);
      const lockedReplay = await replayStructureOperation(
        client,
        operationKey,
        playerId,
        spec.buildAction
      );
      if (lockedReplay) {
        await client.query("COMMIT");
        return lockedReplay as CityFacilityMutationResult;
      }
      await assertNoActiveCityConstruction(client, playerId, operationKey);
      const city = await lockCity(client, cityId, this.worldId);
      await requireActiveCityMember(client, playerId, cityId);
      const positionedCityId = await resolveCityAtPosition(
        client,
        this.worldId,
        position
      );
      if (positionedCityId !== cityId) {
        throw new CityStructureError(
          `${spec.errorPrefix}_CITY_TERRITORY_REQUIRED`,
          `Stand inside your city territory to build ${spec.article} ${spec.name}.`
        );
      }
      const existing = await client.query(
        `SELECT 1 FROM city_structures
         WHERE owner_player_id=$1 AND structure_type=$2
           AND state IN ('constructing','active')
         LIMIT 1 FOR SHARE`,
        [playerId, spec.type]
      );
      if (existing.rowCount) {
        throw new CityStructureError(
          `${spec.errorPrefix}_ALREADY_EXISTS`,
          `You already own an active or constructing ${spec.name}.`
        );
      }
      await validatePlacement(client, city, position, spec.type, null, this.worldLookup);
      const structureId = randomUUID();
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: spec.buildAction,
        cityId,
        structureId,
        intent: { cityId, position, type: spec.type }
      });
      const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:inventory`,
        playerId,
        source: `${spec.type}_construction`,
        sourceEntityType: "city_structure",
        sourceEntityId: structureId,
        metadata: { cityId, structureType: spec.type },
        debits: spec.cost.materials.map((material) => ({
          itemId: material.itemId,
          variant: "default",
          quantity: BigInt(material.quantity)
        }))
      });
      const inserted = await insertStructure(client, {
        structureId,
        city,
        type: spec.type,
        tier: 1,
        ownerPlayerId: playerId,
        position,
        operationKey
      });
      await recordStructureMaterialSpend(client, {
        structureId,
        tier: 1,
        paidByPlayerId: playerId,
        sourceOperationKey: operationKey,
        materials: spec.cost.materials
      });
      await writeStructureEvent(
        client,
        operationKey,
        cityId,
        structureId,
        playerId,
        "built",
        {
          type: spec.type,
          constructionDurationMs: cityConstructionDurationMs(spec.buildAction)
        }
      );
      const result: CityFacilityMutationResult = {
        structure: rowToStructure(inserted),
        inventory: debit.inventory
      };
      await completeStructureOperation(client, operationKey, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateStructureConstraint(error);
    } finally {
      client.release();
    }
  }

  async openOilWell(
    playerId: string,
    structureId: string,
    position: Position,
    remote = false
  ): Promise<OilWellSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const structure = await lockActiveOilWell(client, structureId);
      const spec = producerSpecForRow(structure);
      const isOwner = structure.owner_player_id === playerId;
      if (!isOwner && structure.harvest_access_mode !== "public") {
        throw new CityStructureError(`${spec.errorPrefix}_PRIVATE`, `This ${spec.name} is private.`);
      }
      if (isOwner) await requireActiveCityMember(client, playerId, structure.city_id);
      const oilWorkerRank = spec.type === "oil_well"
        ? await this.masteries.professionRankInTransaction(client, structure.owner_player_id!, "oil_worker")
        : 0;
      if (remote) {
        requireOilWellOwner(structure, playerId);
        if (spec.type !== "oil_well") throw new CityStructureError("QUARTZ_HUT_REMOTE_UNAVAILABLE", "Stand at your Quartz Hut to check it.");
        if (oilWorkerRank < 4) throw new CityStructureError("OIL_WELL_REMOTE_MONITORING_LOCKED", "Oil Worker Rank 4 is required for remote monitoring.");
      } else {
        requireNearOilWell(structure, position);
      }
      const tollGold = spec.type === "oil_well" ? await oilWellToll(client, structure.owner_player_id!) : 0n;
      const capacity = producerCapacity(spec, oilWorkerRank);
      const production = await settleOilWellProduction(client, spec, structureId, capacity);
      const snapshot = oilWellSnapshot(
        spec,
        structure,
        production,
        new Date(production.server_now).getTime(),
        capacity,
        playerId,
        tollGold
      );
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async harvestOilWell(
    playerId: string,
    structureId: string,
    position: Position,
    requestId: string,
    remote = false
  ): Promise<OilWellHarvestResult> {
    const operationKey = `oil-well:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reserved = await client.query(
        `INSERT INTO city_oil_well_operations (
           operation_key,actor_player_id,request_id,structure_id,action
         ) VALUES ($1,$2,$3,$4::uuid,'harvest')
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [operationKey, playerId, requestId, structureId]
      );
      if (!reserved.rowCount) {
        const prior = await client.query<{
          actor_player_id: string;
          structure_id: string;
          action: string;
          result: OilWellHarvestResult | null;
          completed_at: Date | null;
        }>(
          `SELECT actor_player_id,structure_id::text,action,result,completed_at
           FROM city_oil_well_operations WHERE operation_key=$1 FOR UPDATE`,
          [operationKey]
        );
        const row = prior.rows[0];
        if (
          !row || row.actor_player_id !== playerId ||
          row.structure_id !== structureId || row.action !== "harvest"
        ) {
          throw new CityStructureError(
            "OIL_WELL_IDEMPOTENCY_CONFLICT",
            "Oil Well request ID was reused with different intent."
          );
        }
        if (!row.completed_at || !row.result) {
          throw new CityStructureError(
            "OIL_WELL_OPERATION_INCOMPLETE",
            "The prior Oil Well harvest is still completing."
          );
        }
        await client.query("COMMIT");
        return { ...row.result, replayed: true };
      }
      const structure = await lockActiveOilWell(client, structureId);
      const spec = producerSpecForRow(structure);
      const isOwner = structure.owner_player_id === playerId;
      const oilWorkerRank = spec.type === "oil_well"
        ? await this.masteries.professionRankInTransaction(client, structure.owner_player_id!, "oil_worker")
        : 0;
      if (remote) {
        requireOilWellOwner(structure, playerId);
        if (spec.type !== "oil_well") throw new CityStructureError("QUARTZ_HUT_REMOTE_UNAVAILABLE", "Stand at your Quartz Hut to collect.");
        if (oilWorkerRank < 8) throw new CityStructureError("OIL_WELL_REMOTE_HARVEST_LOCKED", "Master Oil Worker is required for remote harvest.");
      } else {
        requireNearOilWell(structure, position);
      }
      if (!isOwner && structure.harvest_access_mode !== "public") {
        throw new CityStructureError(`${spec.errorPrefix}_PRIVATE`, `This ${spec.name} is private.`);
      }
      if (isOwner) await requireActiveCityMember(client, playerId, structure.city_id);
      const tollGold = spec.type === "oil_well" ? await oilWellToll(client, structure.owner_player_id!) : 0n;
      const capacity = producerCapacity(spec, oilWorkerRank);
      const production = await settleOilWellProduction(client, spec, structureId, capacity);
      let inventory: PlayerInventorySnapshot;
      let harvestedQuantity = 0;
      if (production.stored > 0) {
        const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:inventory`,
          playerId,
          source: `${spec.type}_harvest`,
          sourceEntityType: "city_structure",
          sourceEntityId: structureId,
          metadata: { cityId: structure.city_id },
          allowPartial: true,
          grants: [{
            itemId: spec.itemId!, // producers only: the Library never reaches harvest
            variant: "default",
            quantity: BigInt(production.stored)
          }]
        });
        inventory = grant.inventory;
        harvestedQuantity = grant.grants[0]?.grantedQuantity ?? 0;
      } else {
        inventory = await this.inventory.snapshotInTransaction(client, playerId);
      }
      const remaining = production.stored - harvestedQuantity;
      const wallet = harvestedQuantity > 0 && !isOwner && tollGold > 0n
        ? await this.settleOilWellToll(client, operationKey, structure, playerId, tollGold)
        : null;
      const updatedProduction = await client.query<OilWellProductionRow>(
        `UPDATE ${spec.productionTable}
         SET ${spec.storedColumn}=$2,updated_at=clock_timestamp()
         WHERE structure_id=$1::uuid
         RETURNING structure_id::text,owner_player_id,${spec.storedColumn} AS stored,
                   production_cursor,settled_capacity,clock_timestamp() AS server_now`,
        [structureId, remaining]
      );
      const settled = updatedProduction.rows[0]!;
      const message = harvestedQuantity === 0
        ? production.stored === 0
          ? `No ${spec.itemName} is ready yet.`
          : `Inventory is full. No ${spec.itemName} was harvested.`
        : remaining === 0
          ? `Harvested ${harvestedQuantity} ${spec.itemName}.`
          : `Harvested ${harvestedQuantity} ${spec.itemName}; ${remaining} remains stored.`;
      const masteryGrant = harvestedQuantity > 0 && spec.type === "oil_well"
        ? await this.masteries.grantProfessionXpInTransaction(client, {
            operationKey: `${operationKey}:mastery`,
            playerId,
            sourceId: structureId,
            activity: { kind: "oil-harvest", harvestedCrude: harvestedQuantity }
          })
        : undefined;
      const result: OilWellHarvestResult = {
        well: oilWellSnapshot(
          spec,
          structure,
          settled,
          new Date(settled.server_now).getTime(),
          capacity,
          playerId,
          tollGold
        ),
        inventory,
        harvestedQuantity,
        replayed: false,
        message,
        tollGold: isOwner ? "0" : tollGold.toString(),
        ...(wallet ? { walletGold: wallet.gold, walletVersion: wallet.version } : {}),
        ...(masteryGrant ? { masteryGrant } : {})
      };
      await client.query(
        `UPDATE city_oil_well_operations
         SET result=$2::jsonb,completed_at=clock_timestamp()
         WHERE operation_key=$1`,
        [operationKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelOilWellConstruction(
    playerId: string,
    reason: string
  ): Promise<CityFacilityMutationResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCityConstructionChannel(client, playerId);
      const row = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE owner_player_id=$1 AND structure_type IN ('oil_well','quartz_hut','library')
           AND state='constructing'
         ORDER BY structure_id
         FOR UPDATE`,
        [playerId]
      );
      if (!row.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const result = await this.cancelOilWellConstructionInTransaction(
        client,
        row.rows[0],
        reason
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async settleOilWellToll(
    client: pg.PoolClient,
    operationKey: string,
    structure: StructureRow,
    payerPlayerId: string,
    amount: bigint
  ): Promise<{ gold: string; version: string }> {
    const ownerPlayerId = structure.owner_player_id!;
    const accounts = await client.query<{ id: string; account_id: string }>(
      "SELECT id,account_id FROM players WHERE id=ANY($1::text[]) ORDER BY id",
      [[payerPlayerId, ownerPlayerId]]
    );
    const byPlayer = new Map(accounts.rows.map((row) => [row.id, row.account_id]));
    const payerAccount = byPlayer.get(payerPlayerId);
    const ownerAccount = byPlayer.get(ownerPlayerId);
    if (!payerAccount || !ownerAccount) throw new Error("Oil Well toll wallet owner is unavailable");
    for (const id of [payerPlayerId, ownerPlayerId].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`harvest-toll:${id}`]);
    }
    let debit;
    try {
      debit = await this.wallet.debitForOperationInTransaction(client, {
        playerId: payerPlayerId, accountId: payerAccount, amount,
        operationKey: `harvest-toll-debit:${operationKey}`, reason: "public_oil_well_toll",
        metadata: { structureId: structure.structure_id, ownerPlayerId }
      });
    } catch (error) {
      if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
        throw new CityStructureError("INSUFFICIENT_GOLD", `This public Oil Well costs ${amount} Gold to harvest.`);
      }
      throw error;
    }
    await this.wallet.creditForOperationInTransaction(client, {
      playerId: ownerPlayerId, accountId: ownerAccount, amount,
      operationKey: `harvest-toll-credit:${operationKey}`, reason: "public_oil_well_toll",
      metadata: { structureId: structure.structure_id, payerPlayerId }
    });
    await client.query(
      `INSERT INTO harvest_toll_operations
         (operation_key,harvest_type,asset_id,payer_player_id,recipient_player_id,toll_gold)
       VALUES ($1,'oil_well',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [operationKey, structure.structure_id, payerPlayerId, ownerPlayerId, amount.toString()]
    );
    return { gold: debit.goldBalance.toString(), version: debit.version.toString() };
  }

  async cancelConstructionForMovement(
    playerId: string
  ): Promise<CityConstructionCancellation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCityConstructionChannel(client, playerId);
      const active = await client.query<StructureRow & {
        actor_player_id: string;
        request_id: string;
        action: CityPhysicalConstructionAction;
        intent: Record<string, unknown>;
      }>(
        `SELECT structure.structure_id::text,structure.city_id::text,
                structure.structure_type,structure.tier,structure.district_type,
                structure.owner_player_id,
                (SELECT username FROM players WHERE id=structure.owner_player_id) AS owner_username,
                structure.world_id,structure.region_code,structure.lat,structure.lon,
                structure.footprint_radius_m,structure.placement_revision::text,
                structure.state,structure.construction_started_at,
                structure.construction_completes_at,structure.built_at,
                structure.upgraded_at,structure.destroyed_at,structure.build_operation_key,
                operation.actor_player_id,operation.request_id,operation.action,operation.intent
         FROM city_structure_operations operation
         JOIN city_structures structure
           ON structure.build_operation_key=operation.operation_key
         WHERE operation.actor_player_id=$1
           AND operation.action IN (
             'build_house','build_oil_well','build_quartz_hut','build_library','build_facility','build_market','build_monument',
             'upgrade_facility','upgrade_monument'
           )
           AND structure.state='constructing'
         ORDER BY structure.construction_started_at,structure.structure_id
         LIMIT 1
         FOR UPDATE OF structure`,
        [playerId]
      );
      const row = active.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      if (row.action === "build_oil_well" || row.action === "build_quartz_hut" || row.action === "build_library") {
        const result = await this.cancelOilWellConstructionInTransaction(client, row, "movement");
        await client.query("COMMIT");
        return { ...result, action: row.action };
      }

      const upgrading = row.action === "upgrade_facility" || row.action === "upgrade_monument";
      const updated = await client.query<StructureRow>(
        upgrading
          ? `UPDATE city_structures
             SET tier=tier-1,state='active',construction_started_at=NULL,
                 construction_completes_at=NULL,placement_revision=placement_revision+1,
                 updated_at=clock_timestamp()
             WHERE structure_id=$1::uuid AND state='constructing'
             RETURNING ${STRUCTURE_RETURNING_FIELDS}`
          : `UPDATE city_structures
             SET state='destroyed',destroyed_at=clock_timestamp(),
                 placement_revision=placement_revision+1,updated_at=clock_timestamp()
             WHERE structure_id=$1::uuid AND state='constructing'
             RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [row.structure_id]
      );
      const cancelled = updated.rows[0];
      if (!cancelled) {
        throw new CityStructureError(
          "CITY_CONSTRUCTION_STALE",
          "City construction changed before movement cancellation completed."
        );
      }
      cancelled.owner_username = row.owner_username ?? null;

      const cost = cityConstructionCost(row.action, row);
      let inventory: PlayerInventorySnapshot | undefined;
      let droppedItems: DroppedItemSnapshot[] = [];
      const playerFunded = row.action === "build_house" ||
        (row.action === "build_facility" && row.structure_type === "warehouse");
      if (playerFunded) {
        const refund = await this.refundStructureMaterialsInTransaction(
          client,
          { ...row, owner_player_id: playerId },
          row.build_operation_key,
          "city_construction_cancelled",
          true,
          row.build_operation_key
        );
        inventory = refund.inventory;
        droppedItems = refund.droppedItems;
      } else {
        const lines = await structureMaterialSpendLines(
          client,
          row.structure_id,
          row.build_operation_key
        );
        const warehouseRefunds = await this.warehouse.grantDestructionRefundInTransaction(
          client,
          {
            cityId: row.city_id,
            materials: lines.map((line) => ({
              itemId: line.itemId,
              variant: line.variant,
              quantity: line.refundQuantity
            }))
          }
        );
        const dropQuantities = new Map<string, number>();
        for (const line of lines) {
          const refund = warehouseRefunds.find(
            (candidate) => candidate.itemId === line.itemId && candidate.variant === line.variant
          );
          const granted = refund?.grantedQuantity ?? 0;
          const dropped = refund?.remainderQuantity ?? line.refundQuantity;
          await writeStructureRefund(client, {
            operationKey: row.build_operation_key,
            structureId: row.structure_id,
            line,
            quantity: granted,
            destination: "city_warehouse"
          });
          if (dropped > 0) {
            dropQuantities.set(`${line.itemId}\u0000${line.variant}`, dropped);
            await writeStructureRefund(client, {
              operationKey: row.build_operation_key,
              structureId: row.structure_id,
              line,
              quantity: dropped,
              destination: "ground_drop",
              recipientPlayerId: playerId
            });
          }
        }
        droppedItems = await createSystemGroundDropsInTransaction(client, {
          operationKey: `${row.build_operation_key}:ground-refund`,
          droppedByPlayerId: playerId,
          regionCode: row.region_code ?? "unknown",
          position: { lat: Number(row.lat), lon: Number(row.lon) },
          reason: "city_construction_cancelled",
          lines: refundDropLines(lines, dropQuantities)
        });
      }
      if (cost.cityCoins > 0) {
        await this.treasury.refundConstructionInTransaction(client, {
          operationKey: `${row.build_operation_key}:coins:refund`,
          cityId: row.city_id,
          actorPlayerId: playerId,
          amount: cost.cityCoins,
          sourceId: row.structure_id,
          metadata: { action: row.action, tier: row.tier, reason: "movement" }
        });
      }
      if (cost.cityGold > 0) {
        await this.gold.refundConstructionInTransaction(client, {
          operationKey: `${row.build_operation_key}:gold:refund`,
          cityId: row.city_id,
          actorPlayerId: playerId,
          requestId: `${row.request_id}:movement-refund`,
          amount: BigInt(cost.cityGold),
          structureId: row.structure_id,
          sourceType: row.structure_type === "market" ? "market" : "monument",
          targetTier: row.tier as 1 | 2 | 3
        });
      }

      if (row.structure_type === "monument") {
        await client.query(
          `UPDATE cities
           SET district_revision = district_revision + 1,
               spatial_revision = spatial_revision + 1
           WHERE id = $1`,
          [row.city_id]
        );
        await client.query(
          `UPDATE market_venues
           SET tax_revision = tax_revision + 1
           WHERE city_id = $1 AND state = 'active'`,
          [row.city_id]
        );
      }

      await writeStructureEvent(
        client,
        row.build_operation_key,
        row.city_id,
        row.structure_id,
        playerId,
        "cancelled",
        { type: row.structure_type, action: row.action, reason: "movement" }
      );
      const result: CityConstructionCancellation = {
        action: row.action,
        structure: rowToStructure(cancelled),
        ...(inventory ? { inventory } : {}),
        ...(droppedItems.length > 0 ? { droppedItems } : {})
      };
      await completeStructureOperation(client, row.build_operation_key, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async destroyOilWell(
    playerId: string,
    structureId: string,
    expectedPlacementRevision: string,
    position: Position,
    requestId: string
  ): Promise<CityFacilityMutationResult> {
    const operationKey = `city-structure:${playerId}:${requestId}`;
    const replay = await replayStructureOperation(
      this.pool,
      operationKey,
      playerId,
      PERSONAL_PRODUCER_DESTROY_ACTIONS
    );
    if (replay) {
      return { ...(replay as CityFacilityMutationResult), replayed: true };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        operationKey
      ]);
      const lockedReplay = await replayStructureOperation(
        client,
        operationKey,
        playerId,
        PERSONAL_PRODUCER_DESTROY_ACTIONS
      );
      if (lockedReplay) {
        await client.query("COMMIT");
        return {
          ...(lockedReplay as CityFacilityMutationResult),
          replayed: true
        };
      }
      const structure = await lockActiveOilWell(client, structureId, true);
      const spec = producerSpecForRow(structure);
      requireOilWellOwnerAndProximity(structure, playerId, position);
      if (structure.placement_revision !== expectedPlacementRevision) {
        throw new CityStructureError(
          `${spec.errorPrefix}_STALE`,
          `The ${spec.name} changed before destruction was confirmed.`
        );
      }
      await lockPlayerAndCity(client, playerId, structure.city_id);
      await requireActiveCityMember(client, playerId, structure.city_id);
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: spec.destroyAction,
        cityId: structure.city_id,
        structureId,
        intent: { structureId, expectedPlacementRevision }
      });
      const refund = await this.refundStructureMaterialsInTransaction(
        client,
        structure,
        operationKey,
        `${spec.type}_destroyed_refund`,
        false
      );
      if (spec.productionTable) {
        await client.query(
          `DELETE FROM ${spec.productionTable} WHERE structure_id=$1::uuid`,
          [structureId]
        );
      }
      const destroyed = await client.query<StructureRow>(
        `UPDATE city_structures
         SET state='destroyed',destroyed_at=clock_timestamp(),
             placement_revision=placement_revision+1,updated_at=clock_timestamp()
         WHERE structure_id=$1::uuid AND state='active'
         RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [structureId]
      );
      if (!destroyed.rows[0]) {
        throw new CityStructureError(
          `${spec.errorPrefix}_STALE`,
          `The ${spec.name} changed before destruction completed.`
        );
      }
      destroyed.rows[0].owner_username = structure.owner_username ?? null;
      await writeStructureEvent(
        client,
        operationKey,
        structure.city_id,
        structureId,
        playerId,
        "destroyed",
        spec.type === "oil_well"
          ? { type: "oil_well", storedOilDestroyed: true }
          : { type: spec.type, storedDestroyed: true }
      );
      const result: CityFacilityMutationResult = {
        structure: rowToStructure(destroyed.rows[0]),
        inventory: refund.inventory,
        droppedItems: refund.droppedItems
      };
      await completeStructureOperation(client, operationKey, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async destroyHouse(
    playerId: string,
    structureId: string,
    expectedPlacementRevision: string,
    requestId: string
  ): Promise<CityHouseMutationResult> {
    const client = await this.pool.connect();
    const operationKey = `city-structure:${playerId}:${requestId}`;
    try {
      await client.query("BEGIN");
      const discoveredHouse = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE owner_player_id=$1 AND state='active'
           AND structure_type IN ('city_house','mayor_house')`,
        [playerId]
      );
      const discovered = discoveredHouse.rows[0];
      if (!discovered) {
        const replay = await replayStructureOperation(client, operationKey, playerId, "destroy_house");
        if (replay) {
          await client.query("COMMIT");
          return { ...(replay as CityHouseMutationResult), replayed: true };
        }
        throw new CityStructureError(
          "CITY_HOUSE_NOT_FOUND",
          "You do not have an active City House to destroy"
        );
      }
      await lockPlayerAndCity(client, playerId, discovered.city_id);
      const house = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE owner_player_id=$1 AND state='active'
           AND structure_type IN ('city_house','mayor_house')
         FOR UPDATE`,
        [playerId]
      );
      const row = house.rows[0];
      if (!row) {
        throw new CityStructureError(
          "CITY_HOUSE_NOT_FOUND",
          "Your City House changed before destruction completed"
        );
      }
      const replay = await replayStructureOperation(client, operationKey, playerId, "destroy_house");
      if (replay) {
        await client.query("COMMIT");
        return { ...(replay as CityHouseMutationResult), replayed: true };
      }
      if (
        row.structure_id !== structureId ||
        row.placement_revision !== expectedPlacementRevision
      ) {
        throw new CityStructureError(
          "CITY_HOUSE_STALE",
          "Your City House changed before destruction was confirmed"
        );
      }
      const { result } = await this.destroyLockedHouseInTransaction(
        client,
        playerId,
        row,
        operationKey,
        requestId
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Destroys an already-locked active City/Mayor House under the normal rules:
   * one-third material refund, personal Oil Well cleanup, membership end and
   * Mayor relinquishment. Callers own the transaction and the player/city locks.
   */
  private async destroyLockedHouseInTransaction(
    client: pg.PoolClient,
    playerId: string,
    row: StructureRow,
    operationKey: string,
    requestId: string,
    options: Readonly<{ refund?: boolean; intent?: Record<string, unknown> }> = {}
  ): Promise<{
    result: CityHouseMutationResult;
    refundedLines: Array<{ itemId: string; quantity: number }>;
    droppedLines: Array<{ itemId: string; quantity: number }>;
  }> {
    await reserveStructureOperation(client, {
      operationKey,
      playerId,
      requestId,
      action: "destroy_house",
      cityId: row.city_id,
      structureId: row.structure_id,
      intent: { structureId: row.structure_id, ...(options.intent ?? {}) }
    });
    // A house lost in war returns no materials.
    const refundLines = options.refund === false
      ? []
      : await structureMaterialRefundLines(client, row.structure_id);
    const refundGrant = refundLines.length > 0
      ? await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:refund`,
          playerId,
          source: "city_house_destroyed_refund",
          sourceEntityType: "city_structure",
          sourceEntityId: row.structure_id,
          metadata: { cityId: row.city_id },
          allowPartial: true,
          grants: refundLines.map((line) => ({
            itemId: line.itemId,
            variant: line.variant,
            quantity: line.refundQuantity
          }))
        })
      : null;
    const dropQuantities = new Map<string, number>();
    for (const line of refundLines) {
      const grant = refundGrant?.grants.find(
        (candidate) =>
          candidate.itemId === line.itemId &&
          (candidate.variant ?? "default") === line.variant
      );
      const inventoryQuantity = grant?.grantedQuantity ?? 0;
      const droppedQuantity = line.refundQuantity - inventoryQuantity;
      await writeStructureRefund(client, {
        operationKey,
        structureId: row.structure_id,
        line,
        quantity: inventoryQuantity,
        destination: "player_inventory",
        recipientPlayerId: playerId
      });
      if (droppedQuantity > 0) {
        dropQuantities.set(
          `${line.itemId}\u0000${line.variant}`,
          droppedQuantity
        );
        await writeStructureRefund(client, {
          operationKey,
          structureId: row.structure_id,
          line,
          quantity: droppedQuantity,
          destination: "ground_drop",
          recipientPlayerId: playerId
        });
      }
    }
    const refundDrops = await createSystemGroundDropsInTransaction(client, {
      operationKey: `${operationKey}:ground-refund`,
      droppedByPlayerId: playerId,
      regionCode: row.region_code ?? "unknown",
      position: { lat: Number(row.lat), lon: Number(row.lon) },
      reason: "city_house_destroyed",
      lines: refundDropLines(refundLines, dropQuantities)
    });
    const destroyed = await client.query<StructureRow>(
      `UPDATE city_structures
       SET state='destroyed',destroyed_at=now(),
           placement_revision=placement_revision+1,updated_at=now()
       WHERE structure_id=$1 AND state='active'
       RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
      [row.structure_id]
    );
    if (destroyed.rows[0]) {
      destroyed.rows[0].owner_username = row.owner_username ?? null;
    }
    const personalCleanup =
      await this.destroyPersonalStructuresForMembershipLossInTransaction(
        client,
        playerId,
        row.city_id,
        "city_membership_ended",
        row.structure_id
      );
    const membership = await client.query<{ membership_id: string }>(
      `UPDATE city_memberships
       SET left_at=now(),ended_reason='house_destroyed'
       WHERE player_id=$1 AND city_id=$2 AND left_at IS NULL
       RETURNING membership_id::text`,
      [playerId, row.city_id]
    );
    if (!membership.rows[0]) {
      throw new CityStructureError(
        "CITY_MEMBERSHIP_INVARIANT_BROKEN",
        "The active City House did not have an active membership"
      );
    }
    if (row.structure_type === "mayor_house") {
      await client.query(
        `UPDATE cities
         SET mayor_player_id=NULL,mayor_confirmed_at=NULL,mayor_house_deadline=NULL,
             spatial_revision=spatial_revision+1
         WHERE id=$1 AND mayor_player_id=$2`,
        [row.city_id, playerId]
      );
    }
    await writeStructureEvent(
      client,
      operationKey,
      row.city_id,
      row.structure_id,
      playerId,
      "destroyed",
      { membershipId: membership.rows[0].membership_id }
    );
    const result = {
      structure: rowToStructure(destroyed.rows[0]!),
      membership: null,
      replayed: false,
      ...(personalCleanup.inventory
        ? { inventory: personalCleanup.inventory }
        : refundGrant
          ? { inventory: refundGrant.inventory }
          : {}),
      droppedItems: [...refundDrops, ...personalCleanup.droppedItems],
      destroyedStructures: personalCleanup.structures
    };
    await completeStructureOperation(client, operationKey, result);
    return {
      result,
      refundedLines: refundLines
        .map((line) => ({
          itemId: line.itemId,
          quantity: line.refundQuantity -
            (dropQuantities.get(`${line.itemId}\u0000${line.variant}`) ?? 0)
        }))
        .filter((line) => line.quantity > 0),
      droppedLines: refundLines
        .map((line) => ({
          itemId: line.itemId,
          quantity: dropQuantities.get(`${line.itemId}\u0000${line.variant}`) ?? 0
        }))
        .filter((line) => line.quantity > 0)
    };
  }

  /**
   * Developer capital founding: destroys the caller's active City/Mayor House through the
   * normal destruction path. The caller holds lockPlayerAndCity for the house's city.
   */
  async destroyHouseForDeveloperCapitalInTransaction(
    client: pg.PoolClient,
    playerId: string,
    requestId: string
  ): Promise<{
    result: CityHouseMutationResult;
    cityId: string;
    houseType: "city_house" | "mayor_house";
    refundedLines: Array<{ itemId: string; quantity: number }>;
    droppedLines: Array<{ itemId: string; quantity: number }>;
  }> {
    const house = await client.query<StructureRow>(
      `${STRUCTURE_SELECT}
       WHERE owner_player_id=$1 AND state='active'
         AND structure_type IN ('city_house','mayor_house')
       FOR UPDATE`,
      [playerId]
    );
    const row = house.rows[0];
    if (!row) {
      throw new CityStructureError(
        "CITY_HOUSE_NOT_FOUND",
        "Your City House changed before the capital could be founded"
      );
    }
    const destroyed = await this.destroyLockedHouseInTransaction(
      client,
      playerId,
      row,
      `developer-capital:${playerId}:${requestId}:leave`,
      `${requestId}:capital-leave`
    );
    return {
      ...destroyed,
      cityId: row.city_id,
      houseType: row.structure_type === "mayor_house" ? "mayor_house" : "city_house"
    };
  }

  /**
   * Developer capital founding: creates the founder's active Mayor House (membership as
   * confirmed Mayor), the City Warehouse and the City Market with its venue, each at a
   * position that passes the normal placement rules. The city row must already exist
   * in this transaction with its territory flags.
   */
  async seedDeveloperCapitalStructuresInTransaction(
    client: pg.PoolClient,
    input: Readonly<{ cityId: string; playerId: string; requestId: string }>
  ): Promise<{ structures: CityStructureSnapshot[]; membership: CityMembershipSnapshot }> {
    const city = await lockCity(client, input.cityId, this.worldId);
    const hall = { lat: Number(city.hall_lat), lon: Number(city.hall_lon) };
    const plan = [
      { type: "mayor_house", bearing: 0, action: "build_house", suffix: "house" },
      { type: "warehouse", bearing: 120, action: "build_facility", suffix: "warehouse" },
      { type: "market", bearing: 240, action: "build_market", suffix: "market" }
    ] as const;
    const structures: CityStructureSnapshot[] = [];
    let membership: CityMembershipSnapshot | null = null;
    for (const entry of plan) {
      const position = await this.findDeveloperCapitalPlacement(
        client,
        city,
        entry.type,
        hall,
        entry.bearing
      );
      const structureId = randomUUID();
      const operationKey =
        `developer-capital:${input.playerId}:${input.requestId}:${entry.suffix}`;
      await reserveStructureOperation(client, {
        operationKey,
        playerId: input.playerId,
        requestId: `${input.requestId}:capital-${entry.suffix}`,
        action: entry.action,
        cityId: input.cityId,
        structureId,
        intent: { developerCapital: true, type: entry.type, position }
      });
      const radius = CITY_STRUCTURE_FOOTPRINT_RADIUS_M[entry.type];
      const inserted = await client.query<StructureRow>(
        `INSERT INTO city_structures (
           structure_id,city_id,structure_type,tier,district_type,owner_player_id,world_id,
           region_code,lat,lon,geom,footprint_geom,footprint_radius_m,state,build_operation_key,
           construction_started_at,construction_completes_at,built_at
         ) VALUES (
           $1,$2,$3,1,NULL,$4,$5,$6,$7,$8,
           ST_SetSRID(ST_MakePoint($8,$7),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,$9)::geometry,
           $9,'active',$10,NULL,NULL,clock_timestamp()
         )
         RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [
          structureId,
          input.cityId,
          entry.type,
          entry.type === "mayor_house" ? input.playerId : null,
          city.world_id,
          city.region_code,
          position.lat,
          position.lon,
          radius,
          operationKey
        ]
      );
      const row = inserted.rows[0]!;
      if (entry.type === "mayor_house") {
        const owner = await client.query<{ username: string }>(
          "SELECT username FROM players WHERE id=$1",
          [input.playerId]
        );
        row.owner_username = owner.rows[0]?.username ?? null;
        const joined = await client.query<{ joined_at: Date | string }>(
          `INSERT INTO city_memberships (
             membership_id,city_id,player_id,world_id,role,house_structure_id,joined_at
           ) VALUES ($1,$2,$3,$4,'mayor',$5,clock_timestamp())
           RETURNING joined_at`,
          [randomUUID(), input.cityId, input.playerId, city.world_id, structureId]
        );
        membership = {
          cityId: input.cityId,
          cityName: city.name,
          role: "mayor",
          joinedAt: new Date(joined.rows[0]!.joined_at).toISOString(),
          houseStructureId: structureId,
          expansionFlagCount: 0,
          expansionFlagLimit: 0
        };
      }
      if (entry.type === "market") {
        // Same venue activation as reconcileDueConstruction's market completion.
        await client.query(
          `INSERT INTO market_venues (
             venue_id, venue_key, display_name, scope_type, access_policy_id,
             fee_policy_id, active, city_id, market_structure_id,
             tax_revision, state
           ) VALUES (
             $1,$2,$3,'regional','physical-city-market-v1',
             2,true,$4,$5,1,'active'
           )
           ON CONFLICT (city_id) DO UPDATE
           SET market_structure_id = EXCLUDED.market_structure_id,
               display_name = EXCLUDED.display_name,
               active = true,
               state = 'active',
               tax_revision = market_venues.tax_revision + 1`,
          [
            randomUUID(),
            `city:${input.cityId}`,
            `${city.name} City Market`,
            input.cityId,
            structureId
          ]
        );
        await client.query(
          `INSERT INTO market_venue_controls (venue_id)
           SELECT venue_id FROM market_venues WHERE city_id = $1
           ON CONFLICT (venue_id) DO UPDATE
           SET frozen = false,
               new_orders_enabled = true,
               matching_enabled = true,
               cancellations_enabled = true,
               claims_enabled = true,
               updated_at = clock_timestamp()`,
          [input.cityId]
        );
      }
      await writeStructureEvent(
        client,
        operationKey,
        input.cityId,
        structureId,
        input.playerId,
        entry.type === "market" ? "market_activated" : "activated",
        { developerCapital: true, type: entry.type }
      );
      if (entry.type === "mayor_house") {
        await writeStructureEvent(
          client,
          operationKey,
          input.cityId,
          structureId,
          input.playerId,
          "promoted_to_mayor_house",
          { developerCapital: true }
        );
      }
      const structure = rowToStructure(row);
      await completeStructureOperation(
        client,
        operationKey,
        entry.type === "mayor_house"
          ? { structure, membership, replayed: false }
          : { structure }
      );
      structures.push(structure);
    }
    if (!membership) throw new Error("developer capital Mayor House membership is missing");
    return { structures, membership };
  }

  private async findDeveloperCapitalPlacement(
    client: pg.PoolClient,
    city: CityLockRow,
    type: "mayor_house" | "warehouse" | "market",
    hall: Position,
    preferredBearing: number
  ): Promise<Position> {
    const bearingOffsets = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180];
    for (const distanceM of [400, 520, 640, 760, 880]) {
      for (const offset of bearingOffsets) {
        const position = destinationPoint(
          hall,
          distanceM,
          (preferredBearing + offset + 360) % 360
        );
        try {
          await validatePlacement(client, city, position, type, null, this.worldLookup);
          return position;
        } catch (error) {
          if (!(error instanceof CityStructureError)) throw error;
        }
      }
    }
    throw new CityStructureError(
      "CITY_STRUCTURE_PLACEMENT_UNAVAILABLE",
      `No valid ${type.replace("_", " ")} placement was found inside the capital territory`
    );
  }

  /**
   * Developer App only (the handler guards the capability): an active Salon in the city whose territory
   * the developer stands in (NPC cities included, for test worlds without settlement authority), placed at
   * or near them with no Mayor, materials or construction time.
   * Returns the city's existing Salon when it already has one, so the command doubles as "find the Salon".
   */
  async buildDeveloperSalon(
    player: Readonly<{ playerId: string; position: Position }>,
    requestId: string
  ): Promise<{ structure: CityStructureSnapshot; created: boolean }> {
    assertPosition(player.position);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cityId = await resolveCityAtPosition(client, this.worldId, player.position, "structure");
      const city = await lockCity(client, cityId, this.worldId, true);
      const existing = await client.query<StructureRow>(
        `SELECT ${STRUCTURE_RETURNING_FIELDS} FROM city_structures
         WHERE city_id=$1 AND structure_type='salon' AND state IN ('constructing','active')
         LIMIT 1`,
        [cityId]
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { structure: rowToStructure(existing.rows[0]), created: false };
      }
      let position: Position | null = null;
      for (const distanceM of [0, 40, 80, 120, 160, 220]) {
        for (const bearing of distanceM === 0 ? [0] : [0, 45, 90, 135, 180, 225, 270, 315]) {
          const candidate = distanceM === 0 ? player.position : destinationPoint(player.position, distanceM, bearing);
          try {
            await validatePlacement(client, city, candidate, "salon", null, this.worldLookup);
            position = candidate;
            break;
          } catch (error) {
            if (!(error instanceof CityStructureError)) throw error;
          }
        }
        if (position) break;
      }
      if (!position) {
        throw new CityStructureError(
          "CITY_STRUCTURE_PLACEMENT_UNAVAILABLE",
          "No valid Salon placement was found near you inside this city."
        );
      }
      const structureId = randomUUID();
      const operationKey = `developer-salon:${player.playerId}:${requestId}`;
      await reserveStructureOperation(client, {
        operationKey,
        playerId: player.playerId,
        requestId,
        action: "build_facility",
        cityId,
        structureId,
        intent: { developerSalon: true, type: "salon", position }
      });
      const inserted = await client.query<StructureRow>(
        `INSERT INTO city_structures (
           structure_id,city_id,structure_type,tier,district_type,owner_player_id,world_id,
           region_code,lat,lon,geom,footprint_geom,footprint_radius_m,state,build_operation_key,
           construction_started_at,construction_completes_at,built_at
         ) VALUES (
           $1,$2,'salon',1,NULL,NULL,$3,$4,$5,$6,
           ST_SetSRID(ST_MakePoint($6,$5),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,$7)::geometry,
           $7,'active',$8,NULL,NULL,clock_timestamp()
         )
         RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [
          structureId, cityId, city.world_id, city.region_code, position.lat, position.lon,
          CITY_STRUCTURE_FOOTPRINT_RADIUS_M.salon, operationKey
        ]
      );
      await writeStructureEvent(client, operationKey, cityId, structureId, player.playerId, "activated",
        { developerSalon: true, type: "salon" });
      const structure = rowToStructure(inserted.rows[0]!);
      await completeStructureOperation(client, operationKey, { structure });
      await client.query("COMMIT");
      return { structure, created: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimMayor(
    playerId: string,
    cityId: string,
    requestId: string
  ): Promise<CityHouseMutationResult> {
    return this.changeMayor(playerId, cityId, requestId, "claim_mayor");
  }

  async relinquishMayor(
    playerId: string,
    cityId: string,
    requestId: string
  ): Promise<CityHouseMutationResult> {
    return this.changeMayor(playerId, cityId, requestId, "relinquish_mayor");
  }

  async buildFacility(
    playerId: string,
    cityId: string,
    type: CityFacilityBuildType,
    position: Position,
    requestId: string
  ): Promise<CityStructureSnapshot> {
    assertPosition(position);
    if (
      type !== "warehouse" && type !== "cistern_warrens" && type !== "salon" && type !== "city_kennel" &&
      type !== "barracks" && type !== "demolition_factory"
    ) {
      throw new CityStructureError(
        "CITY_FACILITY_NOT_FOUND",
        "That city facility is unavailable."
      );
    }
    const operationKey = `city-structure:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCityConstructionChannel(client, playerId);
      const replay = await replayStructureOperation(client, operationKey, playerId, "build_facility");
      if (replay) {
        await client.query("COMMIT");
        return (replay as { structure: CityStructureSnapshot }).structure;
      }
      await assertNoActiveCityConstruction(client, playerId, operationKey);
      const positionedCityId = await resolveCityAtPosition(
        client,
        this.worldId,
        position,
        "structure"
      );
      await lockPlayerAndCity(client, playerId, positionedCityId);
      const city = await lockCity(client, positionedCityId, this.worldId);
      const lockedCityId = await resolveCityAtPosition(
        client,
        this.worldId,
        position,
        "structure"
      );
      if (lockedCityId !== positionedCityId) {
        throw new CityStructureError(
          "CITY_STRUCTURE_CITY_TERRITORY_CHANGED",
          "City territory changed before the city facility could be placed"
        );
      }
      const militaryFacility = isMilitaryFacilityType(type);
      if (militaryFacility) {
        await requireActiveCityMemberForMilitary(client, playerId, positionedCityId);
      } else {
        await requireConfirmedMayor(client, city, playerId);
      }
      const existingFacility = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM city_structures
             WHERE structure_type=$1
               AND state IN ('constructing','active')
               AND ${militaryFacility ? "owner_player_id=$2" : "city_id=$2"}
          ) AS exists`,
        militaryFacility
          ? [type, playerId]
          : [type, positionedCityId]
      );
      if (existingFacility.rows[0]?.exists) {
        throw new CityStructureError(
          "CITY_FACILITY_ALREADY_EXISTS",
          militaryFacility
            ? "You already own that personal military facility active or under construction"
            : "This city already has that facility active or under construction"
        );
      }
      await validatePlacement(client, city, position, type, null, this.worldLookup);
      const structureId = randomUUID();
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: "build_facility",
        cityId: positionedCityId,
        structureId,
        intent: { cityId: positionedCityId, type, position, tier: 1 }
      });
      const cost = isMilitaryFacilityType(type)
        ? MILITARY_CITY_FACILITY_COSTS[type]
        : CITY_FACILITY_COSTS[type][1];
      const warehouseHistory =
        type === "warehouse"
          ? await client.query<{ exists: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM city_structures
                 WHERE city_id=$1 AND structure_type='warehouse'
                   AND state IN ('constructing','active')
               )`,
              [positionedCityId]
            )
          : null;
      if (type === "warehouse" && !warehouseHistory?.rows[0]?.exists) {
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:inventory`,
          playerId,
          source: "city_warehouse_bootstrap",
          sourceEntityType: "city_structure",
          sourceEntityId: structureId,
          metadata: { cityId: positionedCityId, structureType: type, tier: 1 },
          debits: cost.materials.map((material) => ({
            itemId: material.itemId,
            variant: "default",
            quantity: BigInt(material.quantity)
          }))
        });
      } else {
        await this.warehouse.consumeInTransaction(client, {
          operationKey: `${operationKey}:warehouse`,
          playerId,
          cityId: positionedCityId,
          materials: cost.materials
        });
      }
      if (cost.cityCoins > 0) {
        await this.treasury.spendInTransaction(client, {
          operationKey: `${operationKey}:coins`,
          cityId: positionedCityId,
          actorPlayerId: playerId,
          amount: cost.cityCoins,
          sourceId: structureId,
          metadata: { structureType: type, tier: 1 }
        });
      }
      const inserted = await insertStructure(client, {
        structureId,
        city,
        type,
        tier: 1,
        ownerPlayerId: militaryFacility ? playerId : null,
        position,
        operationKey
      });
      await recordStructureMaterialSpend(client, {
        structureId,
        tier: 1,
        paidByPlayerId: playerId,
        sourceOperationKey: operationKey,
        materials: cost.materials
      });
      await writeStructureEvent(
        client,
        operationKey,
        positionedCityId,
        structureId,
        playerId,
        "built",
        {
          type,
          tier: 1,
          constructionDurationMs: cityConstructionDurationMs("build_facility")
        }
      );
      const structure = rowToStructure(inserted);
      await completeStructureOperation(client, operationKey, { structure });
      await client.query("COMMIT");
      return structure;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateStructureConstraint(error);
    } finally {
      client.release();
    }
  }

  async buildMarket(
    playerId: string,
    cityId: string,
    position: Position,
    requestId: string,
    expectedCityRevision: string
  ): Promise<CityStructureSnapshot> {
    return this.buildCivicStructure({
      playerId,
      cityId,
      position,
      requestId,
      expectedCityRevision,
      type: "market",
      districtType: null,
      expectedDistrictRevision: null
    });
  }

  async buildMonument(
    playerId: string,
    cityId: string,
    districtType: CityDistrictType,
    position: Position,
    requestId: string,
    expectedCityRevision: string,
    expectedDistrictRevision: string
  ): Promise<CityStructureSnapshot> {
    return this.buildCivicStructure({
      playerId,
      cityId,
      position,
      requestId,
      expectedCityRevision,
      type: "monument",
      districtType,
      expectedDistrictRevision
    });
  }

  private async buildCivicStructure(input: Readonly<{
    playerId: string;
    cityId: string;
    position: Position;
    requestId: string;
    expectedCityRevision: string;
    type: "market" | "monument";
    districtType: CityDistrictType | null;
    expectedDistrictRevision: string | null;
  }>): Promise<CityStructureSnapshot> {
    assertPosition(input.position);
    const operationKey = `city-structure:${input.playerId}:${input.requestId}`;
    const action = input.type === "market" ? "build_market" : "build_monument";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCityConstructionChannel(client, input.playerId);
      const replay = await replayStructureOperation(
        client,
        operationKey,
        input.playerId,
        action
      );
      if (replay) {
        await client.query("COMMIT");
        return (replay as { structure: CityStructureSnapshot }).structure;
      }
      await assertNoActiveCityConstruction(
        client,
        input.playerId,
        operationKey
      );
      const positionedCityId = await resolveCityAtPosition(
        client,
        this.worldId,
        input.position,
        "structure"
      );
      await lockPlayerAndCity(client, input.playerId, positionedCityId);
      const city = await lockCity(client, positionedCityId, this.worldId);
      const lockedCityId = await resolveCityAtPosition(
        client,
        this.worldId,
        input.position,
        "structure"
      );
      if (lockedCityId !== positionedCityId) {
        throw new CityStructureError(
          "CITY_STRUCTURE_CITY_TERRITORY_CHANGED",
          `City territory changed before the ${input.type} could be placed`
        );
      }
      await requireConfirmedMayor(client, city, input.playerId);
      if (city.spatial_revision !== input.expectedCityRevision) {
        throw new CityStructureError(
          "CITY_STRUCTURE_STALE",
          "City state changed; refresh before building"
        );
      }
      if (
        input.expectedDistrictRevision !== null &&
        city.district_revision !== input.expectedDistrictRevision
      ) {
        throw new CityStructureError(
          "CITY_DISTRICT_STALE",
          "City District state changed; refresh before building"
        );
      }
      const warehouse = await client.query(
        `SELECT 1
         FROM city_structures
         WHERE city_id = $1
           AND structure_type = 'warehouse'
           AND state = 'active'
         FOR SHARE`
        ,
        [positionedCityId]
      );
      if (warehouse.rowCount !== 1) {
        throw new CityStructureError(
          "CITY_WAREHOUSE_REQUIRED",
          "An active City Warehouse is required"
        );
      }
      const existing = await client.query(
        `SELECT 1
         FROM city_structures
         WHERE city_id = $1
           AND structure_type = $2
           AND ($2 <> 'monument' OR district_type = $3)
           AND state IN ('constructing', 'active')
         FOR SHARE`,
        [positionedCityId, input.type, input.districtType]
      );
      if (existing.rowCount) {
        throw new CityStructureError(
          input.type === "market"
            ? "CITY_MARKET_ALREADY_EXISTS"
            : "CITY_MONUMENT_ALREADY_EXISTS",
          `This city already has a ${input.type} active or under construction`
        );
      }
      await validatePlacement(client, city, input.position, input.type, null, this.worldLookup);
      const structureId = randomUUID();
      const priorDistrictRevision = city.district_revision;
      const priorCityRevision = city.spatial_revision;
      let districtRevision = BigInt(city.district_revision);
      let cityRevision = BigInt(city.spatial_revision);
      if (input.type === "monument") {
        if (!input.districtType) {
          throw new CityStructureError(
            "CITY_DISTRICT_REQUIRED",
            "Select a City District for the Monument"
          );
        }
        const changed = await client.query<{
          district_revision: string;
          spatial_revision: string;
        }>(
          `UPDATE cities
           SET district_revision = district_revision + 1,
               spatial_revision = spatial_revision + 1
           WHERE id = $1
           RETURNING district_revision::text, spatial_revision::text`,
          [positionedCityId]
        );
        districtRevision = BigInt(changed.rows[0]!.district_revision);
        cityRevision = BigInt(changed.rows[0]!.spatial_revision);
        await client.query(
          `UPDATE market_venues
           SET tax_revision = tax_revision + 1
           WHERE city_id = $1 AND state = 'active'`,
          [positionedCityId]
        );
      }
      await reserveStructureOperation(client, {
        operationKey,
        playerId: input.playerId,
        requestId: input.requestId,
        action,
        cityId: positionedCityId,
        structureId,
        intent: {
          cityId: positionedCityId,
          type: input.type,
          districtType: input.districtType,
          position: input.position,
          expectedCityRevision: input.expectedCityRevision,
          expectedDistrictRevision: input.expectedDistrictRevision
        }
      });
      const cost = input.type === "market"
        ? CITY_MARKET_COST
        : CITY_MONUMENT_COSTS[1];
      await this.warehouse.consumeInTransaction(client, {
        operationKey: `${operationKey}:warehouse`,
        playerId: input.playerId,
        cityId: positionedCityId,
        materials: cost.materials
      });
      await this.treasury.spendInTransaction(client, {
        operationKey: `${operationKey}:coins`,
        cityId: positionedCityId,
        actorPlayerId: input.playerId,
        amount: cost.cityCoins,
        sourceId: structureId,
        metadata: { structureType: input.type, tier: 1 }
      });
      await this.gold.spendForConstructionInTransaction(client, {
        operationKey: `${operationKey}:gold`,
        cityId: positionedCityId,
        actorPlayerId: input.playerId,
        requestId: input.requestId,
        amount: BigInt(cost.cityGold),
        structureId,
        sourceType: input.type,
        targetTier: 1
      });
      const inserted = await insertStructure(client, {
        structureId,
        city,
        type: input.type,
        tier: 1,
        districtType: input.districtType,
        ownerPlayerId: null,
        position: input.position,
        operationKey
      });
      await recordStructureMaterialSpend(client, {
        structureId,
        tier: 1,
        paidByPlayerId: input.playerId,
        sourceOperationKey: operationKey,
        materials: cost.materials
      });
      await writeStructureEvent(
        client,
        operationKey,
        positionedCityId,
        structureId,
        input.playerId,
        input.type === "market" ? "market_built" : "monument_built",
        {
          type: input.type,
          tier: 1,
          districtType: input.districtType,
          constructionDurationMs: cityConstructionDurationMs(action)
        }
      );
      if (input.type === "monument") {
        await writeDistrictEvent(client, {
          cityId: positionedCityId,
          actorPlayerId: input.playerId,
          structureId,
          operationKey,
          eventType: "monument_construction_started",
          priorDistrict: null,
          newDistrict: input.districtType,
          priorTier: null,
          newTier: 1,
          priorDistrictRevision,
          districtRevision: districtRevision.toString(),
          priorCityRevision,
          cityRevision: cityRevision.toString()
        });
      }
      const structure = rowToStructure(inserted);
      await completeStructureOperation(client, operationKey, { structure });
      await client.query("COMMIT");
      return structure;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateStructureConstraint(error);
    } finally {
      client.release();
    }
  }

  async upgradeFacility(
    playerId: string,
    structureId: string,
    expectedTier: number,
    position: Position,
    requestId: string
  ): Promise<CityStructureSnapshot> {
    const operationKey = `city-structure:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCityConstructionChannel(client, playerId);
      const replay = await replayStructureOperation(
        client,
        operationKey,
        playerId,
        "upgrade_facility"
      );
      if (replay) {
        await client.query("COMMIT");
        return (replay as { structure: CityStructureSnapshot }).structure;
      }
      const discovered = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE structure_id=$1::uuid AND state='active'
           AND structure_type IN ('warehouse','market')`,
        [structureId]
      );
      const discoveredRow = discovered.rows[0];
      if (!discoveredRow) throw new CityStructureError("CITY_FACILITY_NOT_FOUND", "That city facility is unavailable");
      await lockPlayerAndCity(client, playerId, discoveredRow.city_id);
      const locked = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE structure_id=$1::uuid AND state='active'
           AND structure_type IN ('warehouse','market')
         FOR UPDATE`,
        [structureId]
      );
      const row = locked.rows[0];
      if (!row) throw new CityStructureError("CITY_FACILITY_NOT_FOUND", "That city facility is unavailable");
      const city = await lockCity(client, row.city_id, this.worldId);
      await requireConfirmedMayor(client, city, playerId);
      requireNearStructure(row, position);
      await assertNoActiveCityConstruction(client, playerId, operationKey);
      if (row.tier !== expectedTier) {
        throw new CityStructureError(
          "CITY_FACILITY_STALE_TIER",
          `Expected Tier ${expectedTier}; this facility is Tier ${row.tier}`
        );
      }
      // The City Market's tier is its level (1-10); the Warehouse tops out at Tier 3.
      const market = row.structure_type === "market";
      const maximumTier = market ? CITY_MARKET_MAX_LEVEL : 3;
      if (row.tier >= maximumTier) {
        throw new CityStructureError(
          "CITY_FACILITY_MAXIMUM_TIER",
          market ? `The City Market is already level ${maximumTier}` : "This facility is already Tier 3"
        );
      }
      const targetTier = (row.tier + 1) as CityStructureSnapshot["tier"];
      const type = row.structure_type as "warehouse" | "market";
      const cost = market
        ? cityMarketUpgradeCost(targetTier)!
        : CITY_FACILITY_COSTS.warehouse[targetTier as 2 | 3];
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: "upgrade_facility",
        cityId: row.city_id,
        structureId,
        intent: { structureId, expectedTier, targetTier }
      });
      await this.warehouse.consumeInTransaction(client, {
        operationKey: `${operationKey}:warehouse`,
        playerId,
        cityId: row.city_id,
        materials: cost.materials
      });
      await recordStructureMaterialSpend(client, {
        structureId,
        tier: targetTier,
        paidByPlayerId: playerId,
        sourceOperationKey: operationKey,
        materials: cost.materials
      });
      await this.treasury.spendInTransaction(client, {
        operationKey: `${operationKey}:coins`,
        cityId: row.city_id,
        actorPlayerId: playerId,
        amount: cost.cityCoins,
        sourceId: structureId,
        metadata: { structureType: type, tier: targetTier }
      });
      const updated = await client.query<StructureRow>(
        `UPDATE city_structures
         SET tier=$2,state='constructing',build_operation_key=$4,
             construction_started_at=construction_clock.started_at,
             construction_completes_at=construction_clock.started_at
               + ($5::bigint * interval '1 millisecond'),
             placement_revision=placement_revision+1,
             updated_at=construction_clock.started_at
         FROM (SELECT clock_timestamp() AS started_at) construction_clock
         WHERE structure_id=$1::uuid AND tier=$3
         RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [
          structureId,
          targetTier,
          expectedTier,
          operationKey,
          cityConstructionDurationMs("upgrade_facility")
        ]
      );
      if (!updated.rows[0]) {
        throw new CityStructureError("CITY_FACILITY_STALE_TIER", "Facility tier changed during upgrade");
      }
      await writeStructureEvent(client, operationKey, row.city_id, structureId, playerId, "upgraded", {
        fromTier: expectedTier,
        toTier: targetTier,
        constructionDurationMs: cityConstructionDurationMs("upgrade_facility")
      });
      const structure = rowToStructure(updated.rows[0]);
      await completeStructureOperation(client, operationKey, { structure });
      await client.query("COMMIT");
      return structure;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upgradeMonument(
    playerId: string,
    structureId: string,
    expectedTier: 1 | 2,
    expectedPlacementRevision: string,
    expectedDistrictRevision: string,
    position: Position,
    requestId: string
  ): Promise<CityStructureSnapshot> {
    assertPosition(position);
    const operationKey = `city-structure:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCityConstructionChannel(client, playerId);
      const replay = await replayStructureOperation(
        client,
        operationKey,
        playerId,
        "upgrade_monument"
      );
      if (replay) {
        await client.query("COMMIT");
        return (replay as { structure: CityStructureSnapshot }).structure;
      }
      const discovered = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE structure_id = $1
           AND structure_type = 'monument'
           AND state = 'active'`,
        [structureId]
      );
      const discoveredRow = discovered.rows[0];
      if (!discoveredRow) {
        throw new CityStructureError(
          "CITY_MONUMENT_NOT_FOUND",
          "That active Monument is unavailable"
        );
      }
      await lockPlayerAndCity(client, playerId, discoveredRow.city_id);
      const city = await lockCity(client, discoveredRow.city_id, this.worldId);
      await requireConfirmedMayor(client, city, playerId);
      await assertNoActiveCityConstruction(client, playerId, operationKey);
      const locked = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE structure_id = $1
           AND structure_type = 'monument'
           AND state = 'active'
         FOR UPDATE`,
        [structureId]
      );
      const row = locked.rows[0];
      if (!row) {
        throw new CityStructureError(
          "CITY_MONUMENT_NOT_FOUND",
          "That active Monument is unavailable"
        );
      }
      requireNearStructure(row, position);
      if (
        row.tier !== expectedTier ||
        row.placement_revision !== expectedPlacementRevision
      ) {
        throw new CityStructureError(
          "CITY_MONUMENT_STALE",
          "Monument state changed; refresh before upgrading"
        );
      }
      if (city.district_revision !== expectedDistrictRevision) {
        throw new CityStructureError(
          "CITY_DISTRICT_STALE",
          "City District state changed; refresh before upgrading"
        );
      }
      const warehouse = await client.query(
        `SELECT 1
         FROM city_structures
         WHERE city_id = $1
           AND structure_type = 'warehouse'
           AND state = 'active'
         FOR SHARE`,
        [row.city_id]
      );
      if (warehouse.rowCount !== 1) {
        throw new CityStructureError(
          "CITY_WAREHOUSE_REQUIRED",
          "An active City Warehouse is required"
        );
      }
      const targetTier = (expectedTier + 1) as 2 | 3;
      const cost = CITY_MONUMENT_COSTS[targetTier];
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: "upgrade_monument",
        cityId: row.city_id,
        structureId,
        intent: {
          structureId,
          expectedTier,
          targetTier,
          expectedPlacementRevision,
          expectedDistrictRevision
        }
      });
      await this.warehouse.consumeInTransaction(client, {
        operationKey: `${operationKey}:warehouse`,
        playerId,
        cityId: row.city_id,
        materials: cost.materials
      });
      await this.treasury.spendInTransaction(client, {
        operationKey: `${operationKey}:coins`,
        cityId: row.city_id,
        actorPlayerId: playerId,
        amount: cost.cityCoins,
        sourceId: structureId,
        metadata: { structureType: "monument", tier: targetTier }
      });
      await this.gold.spendForConstructionInTransaction(client, {
        operationKey: `${operationKey}:gold`,
        cityId: row.city_id,
        actorPlayerId: playerId,
        requestId,
        amount: BigInt(cost.cityGold),
        structureId,
        sourceType: "monument",
        targetTier
      });
      await recordStructureMaterialSpend(client, {
        structureId,
        tier: targetTier,
        paidByPlayerId: playerId,
        sourceOperationKey: operationKey,
        materials: cost.materials
      });
      const updated = await client.query<StructureRow>(
        `UPDATE city_structures
         SET tier = $2,
             state = 'constructing',
             build_operation_key = $5,
             construction_started_at = construction_clock.started_at,
             construction_completes_at = construction_clock.started_at
               + ($6::bigint * interval '1 millisecond'),
             placement_revision = placement_revision + 1,
             updated_at = construction_clock.started_at
         FROM (SELECT clock_timestamp() AS started_at) construction_clock
         WHERE structure_id = $1
           AND tier = $3
           AND placement_revision = $4::bigint
         RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [
          structureId,
          targetTier,
          expectedTier,
          expectedPlacementRevision,
          operationKey,
          cityConstructionDurationMs("upgrade_monument")
        ]
      );
      if (!updated.rows[0]) {
        throw new CityStructureError(
          "CITY_MONUMENT_STALE",
          "Monument state changed during upgrade"
        );
      }
      const revised = await client.query<{
        district_revision: string;
        spatial_revision: string;
      }>(
        `UPDATE cities
         SET district_revision = district_revision + 1,
             spatial_revision = spatial_revision + 1
         WHERE id = $1
         RETURNING district_revision::text, spatial_revision::text`,
        [row.city_id]
      );
      await client.query(
        `UPDATE market_venues
         SET tax_revision = tax_revision + 1
         WHERE city_id = $1 AND state = 'active'`,
        [row.city_id]
      );
      await writeStructureEvent(
        client,
        operationKey,
        row.city_id,
        structureId,
        playerId,
        "monument_upgraded",
        {
          fromTier: expectedTier,
          toTier: targetTier,
          constructionDurationMs: cityConstructionDurationMs("upgrade_monument")
        }
      );
      await writeDistrictEvent(client, {
        cityId: row.city_id,
        actorPlayerId: playerId,
        structureId,
        operationKey,
        eventType: "monument_upgraded",
        priorDistrict: row.district_type,
        newDistrict: row.district_type,
        priorTier: expectedTier,
        newTier: targetTier,
        priorDistrictRevision: city.district_revision,
        districtRevision: revised.rows[0]!.district_revision,
        priorCityRevision: city.spatial_revision,
        cityRevision: revised.rows[0]!.spatial_revision
      });
      const structure = rowToStructure(updated.rows[0]);
      await completeStructureOperation(client, operationKey, { structure });
      await client.query("COMMIT");
      return structure;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateStructureConstraint(error);
    } finally {
      client.release();
    }
  }

  async destroyMonument(
    playerId: string,
    structureId: string,
    expectedPlacementRevision: string,
    expectedDistrictRevision: string,
    position: Position,
    requestId: string
  ): Promise<CityStructureSnapshot> {
    assertPosition(position);
    const operationKey = `city-structure:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const discovered = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE structure_id = $1
           AND structure_type = 'monument'
           AND state IN ('constructing', 'active')`,
        [structureId]
      );
      const discoveredRow = discovered.rows[0];
      if (!discoveredRow) {
        throw new CityStructureError(
          "CITY_MONUMENT_NOT_FOUND",
          "That Monument is unavailable"
        );
      }
      await lockPlayerAndCity(client, playerId, discoveredRow.city_id);
      const city = await lockCity(client, discoveredRow.city_id, this.worldId);
      await requireConfirmedMayor(client, city, playerId);
      const replay = await replayStructureOperation(
        client,
        operationKey,
        playerId,
        "destroy_monument"
      );
      if (replay) {
        await client.query("COMMIT");
        return (replay as { structure: CityStructureSnapshot }).structure;
      }
      const locked = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE structure_id = $1
           AND structure_type = 'monument'
           AND state IN ('constructing', 'active')
         FOR UPDATE`,
        [structureId]
      );
      const row = locked.rows[0];
      if (!row) {
        throw new CityStructureError(
          "CITY_MONUMENT_NOT_FOUND",
          "That Monument is unavailable"
        );
      }
      requireNearStructure(row, position);
      if (
        row.placement_revision !== expectedPlacementRevision ||
        city.district_revision !== expectedDistrictRevision
      ) {
        throw new CityStructureError(
          "CITY_MONUMENT_STALE",
          "Monument or District state changed; refresh before destroying"
        );
      }
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: "destroy_monument",
        cityId: row.city_id,
        structureId,
        intent: {
          structureId,
          expectedPlacementRevision,
          expectedDistrictRevision
        }
      });
      const updated = await client.query<StructureRow>(
        `UPDATE city_structures
         SET state = 'destroyed',
             built_at = COALESCE(
               built_at,
               construction_completes_at,
               construction_started_at,
               clock_timestamp()
             ),
             destroyed_at = clock_timestamp(),
             placement_revision = placement_revision + 1,
             updated_at = clock_timestamp()
         WHERE structure_id = $1
           AND placement_revision = $2::bigint
           AND state IN ('constructing', 'active')
         RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [structureId, expectedPlacementRevision]
      );
      if (!updated.rows[0]) {
        throw new CityStructureError(
          "CITY_MONUMENT_STALE",
          "Monument state changed during destruction"
        );
      }
      const revised = await client.query<{
        district_revision: string;
        spatial_revision: string;
      }>(
        `UPDATE cities
         SET latest_monument_destroyed_at = destruction.now,
             district_revision = district_revision + 1,
             spatial_revision = spatial_revision + 1
         FROM (SELECT clock_timestamp() AS now) destruction
         WHERE cities.id = $1
         RETURNING district_revision::text, spatial_revision::text`,
        [row.city_id]
      );
      await client.query(
        `UPDATE market_venues
         SET tax_revision = tax_revision + 1
         WHERE city_id = $1 AND state = 'active'`,
        [row.city_id]
      );
      await writeStructureEvent(
        client,
        operationKey,
        row.city_id,
        structureId,
        playerId,
        "monument_destroyed",
        {
          districtType: row.district_type,
          tier: row.tier,
          refund: {
            materials: 0,
            cityCoins: 0,
            cityGold: 0
          }
        }
      );
      await writeDistrictEvent(client, {
        cityId: row.city_id,
        actorPlayerId: playerId,
        structureId,
        operationKey,
        eventType: "monument_destroyed",
        priorDistrict: row.district_type,
        newDistrict: row.district_type,
        priorTier: row.tier as 1 | 2 | 3,
        newTier: null,
        priorDistrictRevision: city.district_revision,
        districtRevision: revised.rows[0]!.district_revision,
        priorCityRevision: city.spatial_revision,
        cityRevision: revised.rows[0]!.spatial_revision,
        metadata: {
          noRefund: true
        }
      });
      const structure = rowToStructure(updated.rows[0]);
      await completeStructureOperation(client, operationKey, { structure });
      await client.query("COMMIT");
      return structure;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateStructureConstraint(error);
    } finally {
      client.release();
    }
  }

  async destroyFacility(
    playerId: string,
    structureId: string,
    expectedPlacementRevision: string,
    position: Position,
    requestId: string
  ): Promise<CityFacilityMutationResult> {
    assertPosition(position);
    const operationKey = `city-structure:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const discovered = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE structure_id=$1::uuid
           AND structure_type IN ('warehouse','cistern_warrens','salon','city_kennel','barracks','demolition_factory')`,
        [structureId]
      );
      const discoveredRow = discovered.rows[0];
      if (!discoveredRow) {
        throw new CityStructureError("CITY_FACILITY_NOT_FOUND", "That city facility is unavailable");
      }
      await lockPlayerAndCity(client, playerId, discoveredRow.city_id);
      const locked = await client.query<StructureRow>(
        `${STRUCTURE_SELECT}
         WHERE structure_id=$1::uuid
           AND structure_type IN ('warehouse','cistern_warrens','salon','city_kennel','barracks','demolition_factory')
         FOR UPDATE`,
        [structureId]
      );
      const row = locked.rows[0];
      if (!row) {
        throw new CityStructureError("CITY_FACILITY_NOT_FOUND", "That city facility is unavailable");
      }
      const city = await lockCity(client, row.city_id, this.worldId);
      if (isActiveMilitaryStructureType(row.structure_type)) {
        if (row.owner_player_id && row.owner_player_id !== playerId) {
          throw new CityStructureError(
            "CITY_MILITARY_OWNER_REQUIRED",
            "Only the owner may manage this personal military facility"
          );
        }
        await requireActiveCityMemberForMilitary(client, playerId, row.city_id);
      } else {
        await requireConfirmedMayor(client, city, playerId);
      }
      const replay = await replayStructureOperation(
        client,
        operationKey,
        playerId,
        "destroy_facility"
      );
      if (replay) {
        await client.query("COMMIT");
        return replay as CityFacilityMutationResult;
      }
      if (row.state === "destroyed") {
        throw new CityStructureError(
          "CITY_FACILITY_ALREADY_DESTROYED",
          "That city facility has already been destroyed"
        );
      }
      if (row.structure_type === "cistern_warrens") {
        const occupancy = await client.query<{ occupied: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM cistern_warrens_presence
             WHERE sewer_structure_id=$1::uuid
           ) AS occupied`,
          [structureId]
        );
        if (occupancy.rows[0]?.occupied) {
          throw new CityStructureError(
            "CISTERN_WARRENS_OCCUPIED",
            "The Cistern Warrens cannot be destroyed while players are inside"
          );
        }
      }
      if (row.structure_type === "salon") {
        const occupied = await client.query(
          `SELECT 1 FROM salon_presence
           WHERE salon_structure_id=$1::uuid
           LIMIT 1`,
          [row.structure_id]
        );
        if (occupied.rowCount) {
          throw new CityStructureError(
            "CITY_FACILITY_OCCUPIED",
            "The Salon cannot be destroyed while players are inside."
          );
        }
      }
      requireNearStructure(row, position);
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: "destroy_facility",
        cityId: row.city_id,
        structureId,
        intent: { structureId }
      });
      const refundLines = await structureMaterialRefundLines(
        client,
        row.structure_id
      );
      const dropLines: SystemGroundDropLine[] = [];
      if (row.structure_type === "warehouse") {
        const contents = await client.query<{
          item_id: string;
          variant: string;
          quantity: string;
        }>(
          `SELECT item_id,variant,quantity::text
           FROM city_warehouse_stacks
           WHERE city_id=$1
           ORDER BY item_id,variant,slot_index
           FOR UPDATE`,
          [row.city_id]
        );
        await client.query(
          "DELETE FROM city_warehouse_stacks WHERE city_id=$1",
          [row.city_id]
        );
        const contentTotals = new Map<string, SystemGroundDropLine>();
        for (const content of contents.rows) {
          const key = `${content.item_id}\u0000${content.variant}`;
          const current = contentTotals.get(key);
          contentTotals.set(key, {
            itemId: content.item_id,
            variant: content.variant,
            quantity:
              (current?.quantity ?? 0) + Number(content.quantity)
          });
        }
        dropLines.push(...contentTotals.values());
        for (const line of refundLines) {
          dropLines.push({
            itemId: line.itemId,
            variant: line.variant,
            quantity: line.refundQuantity
          });
          await writeStructureRefund(client, {
            operationKey,
            structureId,
            line,
            quantity: line.refundQuantity,
            destination: "ground_drop"
          });
        }
      } else {
        const warehouseRefunds =
          await this.warehouse.grantDestructionRefundInTransaction(client, {
            cityId: row.city_id,
            materials: refundLines.map((line) => ({
              itemId: line.itemId,
              variant: line.variant,
              quantity: line.refundQuantity
            }))
          });
        for (const line of refundLines) {
          const result = warehouseRefunds.find(
            (candidate) =>
              candidate.itemId === line.itemId &&
              candidate.variant === line.variant
          );
          const warehouseQuantity = result?.grantedQuantity ?? 0;
          const droppedQuantity =
            result?.remainderQuantity ?? line.refundQuantity;
          await writeStructureRefund(client, {
            operationKey,
            structureId,
            line,
            quantity: warehouseQuantity,
            destination: "city_warehouse"
          });
          if (droppedQuantity > 0) {
            dropLines.push({
              itemId: line.itemId,
              variant: line.variant,
              quantity: droppedQuantity
            });
            await writeStructureRefund(client, {
              operationKey,
              structureId,
              line,
              quantity: droppedQuantity,
              destination: "ground_drop"
            });
          }
        }
      }
      if (row.placement_revision !== expectedPlacementRevision) {
        throw new CityStructureError(
          "CITY_FACILITY_STALE",
          "That city facility changed before destruction was confirmed"
        );
      }
      const drops = await createSystemGroundDropsInTransaction(client, {
        operationKey: `${operationKey}:warehouse-and-refund`,
        droppedByPlayerId: playerId,
        regionCode: row.region_code ?? "unknown",
        position: { lat: Number(row.lat), lon: Number(row.lon) },
        reason: row.structure_type === "warehouse"
          ? "city_warehouse_destroyed"
          : "city_facility_destroyed_refund",
        lines: combineSystemDropLines(dropLines)
      });
      const updated = await client.query<StructureRow>(
        `UPDATE city_structures
         SET state='destroyed',destroyed_at=now(),
             placement_revision=placement_revision+1,updated_at=now()
         WHERE structure_id=$1::uuid AND state='active'
         RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [structureId]
      );
      if (!updated.rows[0]) {
        throw new CityStructureError(
          "CITY_FACILITY_ALREADY_DESTROYED",
          "That city facility has already been destroyed"
        );
      }
      await writeStructureEvent(
        client,
        operationKey,
        row.city_id,
        structureId,
        playerId,
        "destroyed",
        { type: row.structure_type, tier: row.tier }
      );
      const result = {
        structure: rowToStructure(updated.rows[0]),
        droppedItems: drops
      };
      await completeStructureOperation(client, operationKey, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getStructure(structureId: string): Promise<CityStructureSnapshot | null> {
    if (!/^[0-9a-f-]{36}$/i.test(structureId)) return null;
    const result = await this.pool.query<StructureRow>(
      `${STRUCTURE_SELECT} WHERE structure_id=$1::uuid`,
      [structureId]
    );
    return result.rows[0] ? rowToStructure(result.rows[0]) : null;
  }

  attackBuilding(
    playerId: string,
    structureId: string,
    requestId: string,
    player: CityStructureWarfarePlayer
  ): Promise<CityBuildingAttackResult> {
    return attackCityBuilding(this.pool, { playerId, structureId, requestId, player });
  }

  startBuildingRepair(
    playerId: string,
    structureId: string,
    player: CityStructureWarfarePlayer
  ): Promise<Readonly<{ structureId: string; cityId: string; replayed: boolean }>> {
    return startCityBuildingRepair(this.pool, { playerId, structureId, player });
  }

  stopBuildingRepair(playerId: string): Promise<Readonly<{ structureId: string; cityId: string }> | null> {
    return stopCityBuildingRepairForPlayer(this.pool, playerId);
  }

  /** Warfare tick: repairs, burn-outs, then war destruction of fallen buildings. */
  async reconcileBuildingWarfare(isRepairerPresent: CityBuildingRepairerPresence): Promise<Readonly<{
    changedStructureIds: string[];
    stoppedRepairs: CityBuildingWarfareSweep["stoppedRepairs"];
    destroyed: CityWarDestruction[];
  }>> {
    const sweep = await reconcileCityBuildingWarfare(this.pool, isRepairerPresent);
    const destroyed = await this.destroyFallenBuildingsForWar();
    return { changedStructureIds: sweep.changedStructureIds, stoppedRepairs: sweep.stoppedRepairs, destroyed };
  }

  /**
   * Destroys every active building that fell in war (zero health from a burn,
   * a Siege or a Bomber). Lock order: city-structure advisory -> owner player
   * row -> building row. No materials are refunded. Warehouse contents stay in
   * the city warehouse and return when a Warehouse is rebuilt; Market orders
   * stay on their venue. A Salon or Sewer with players inside waits until it
   * is empty. A City House takes its owner out of the city, as a demolished
   * house does.
   */
  async destroyFallenBuildingsForWar(limit = 25): Promise<CityWarDestruction[]> {
    const fallen = await this.pool.query<{ structure_id: string }>(
      `SELECT structure_id::text FROM city_structures
       WHERE state='active' AND health=0
       ORDER BY structure_id LIMIT $1`,
      [limit]
    );
    const destroyed: CityWarDestruction[] = [];
    for (const { structure_id: structureId } of fallen.rows) {
      const result = await this.destroyFallenBuildingForWar(structureId);
      if (result) destroyed.push(result);
    }
    return destroyed;
  }

  async destroyFallenBuildingForWar(structureId: string): Promise<CityWarDestruction | null> {
    const discovered = await this.pool.query<StructureRow>(
      `${STRUCTURE_SELECT} WHERE structure_id=$1::uuid AND state='active' AND health=0`,
      [structureId]
    );
    const candidate = discovered.rows[0];
    if (!candidate) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (candidate.owner_player_id) {
        await lockPlayerAndCity(client, candidate.owner_player_id, candidate.city_id);
      } else {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `city-structure:${candidate.city_id}`
        ]);
      }
      const locked = await client.query<StructureRow>(
        `${STRUCTURE_SELECT} WHERE structure_id=$1::uuid FOR UPDATE`,
        [structureId]
      );
      const row = locked.rows[0];
      if (
        !row || row.state !== "active" || Number(row.health) !== 0 ||
        row.owner_player_id !== candidate.owner_player_id
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (row.structure_type === "salon" || row.structure_type === "cistern_warrens") {
        const occupied = await client.query(
          row.structure_type === "salon"
            ? "SELECT 1 FROM salon_presence WHERE salon_structure_id=$1::uuid LIMIT 1"
            : "SELECT 1 FROM cistern_warrens_presence WHERE sewer_structure_id=$1::uuid LIMIT 1",
          [structureId]
        );
        if (occupied.rowCount) {
          await client.query("ROLLBACK");
          return null;
        }
      }
      const operationKey = `city-structure-war:${structureId}:${row.placement_revision}`;
      const requestId = `war:${structureId}:${row.placement_revision}`;
      const details = { type: row.structure_type, reason: "war" };
      let structure: CityStructureSnapshot;
      let membershipEnded = false;
      if (row.structure_type === "city_house" && row.owner_player_id) {
        const { result } = await this.destroyLockedHouseInTransaction(
          client,
          row.owner_player_id,
          row,
          operationKey,
          requestId,
          { refund: false, intent: { reason: "war" } }
        );
        structure = result.structure;
        membershipEnded = true;
      } else {
        const actor = await client.query<{ actor_id: string }>(
          `SELECT COALESCE($2::text,mayor_player_id,founder_player_id) AS actor_id FROM cities WHERE id=$1::uuid`,
          [row.city_id, row.owner_player_id]
        );
        const actorId = actor.rows[0]!.actor_id;
        await reserveStructureOperation(client, {
          operationKey,
          playerId: actorId,
          requestId,
          action: "war_destroyed",
          cityId: row.city_id,
          structureId,
          intent: details
        });
        if (isPersonalBuildingStructureType(row.structure_type)) {
          const productionTable = producerSpecForRow(row).productionTable;
          if (productionTable) {
            await client.query(
              `DELETE FROM ${productionTable} WHERE structure_id=$1::uuid`,
              [structureId]
            );
          }
        }
        const updated = await client.query<StructureRow>(
          `UPDATE city_structures
           SET state='destroyed',destroyed_at=clock_timestamp(),
               burning_since=NULL,repair_player_id=NULL,repair_started_at=NULL,
               placement_revision=placement_revision+1,updated_at=clock_timestamp()
           WHERE structure_id=$1::uuid AND state='active'
           RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
          [structureId]
        );
        if (row.structure_type === "monument") {
          await client.query(
            `UPDATE cities
             SET latest_monument_destroyed_at=clock_timestamp(),
                 district_revision=district_revision+1,spatial_revision=spatial_revision+1
             WHERE id=$1`,
            [row.city_id]
          );
          await client.query(
            `UPDATE market_venues SET tax_revision=tax_revision+1 WHERE city_id=$1 AND state='active'`,
            [row.city_id]
          );
        }
        await writeStructureEvent(client, operationKey, row.city_id, structureId, actorId, "destroyed", details);
        structure = rowToStructure({ ...updated.rows[0]!, owner_username: row.owner_username ?? null });
        await completeStructureOperation(client, operationKey, { structure });
      }
      await client.query(
        `UPDATE military_unit_groups
         SET target_city_structure_id=NULL,next_fire_at=NULL,revision=revision+1,updated_at=clock_timestamp()
         WHERE target_city_structure_id=$1::uuid`,
        [structureId]
      );
      await client.query("COMMIT");
      return { structure, ownerPlayerId: row.owner_player_id, membershipEnded };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getConstructingHouseForOwner(
    playerId: string
  ): Promise<CityStructureSnapshot | null> {
    const result = await this.pool.query<StructureRow>(
      `${STRUCTURE_SELECT}
       WHERE owner_player_id=$1
         AND state='constructing'
         AND structure_type IN ('city_house','mayor_house')
       ORDER BY construction_started_at,structure_id
       LIMIT 1`,
      [playerId]
    );
    return result.rows[0] ? rowToStructure(result.rows[0]) : null;
  }

  async reconcileDueConstruction(
    limit = 25
  ): Promise<CityConstructionCompletion[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<StructureRow & {
        actor_player_id: string;
        request_id: string;
        action: string;
        city_name: string;
      }>(
        `SELECT structure.structure_id::text,structure.city_id::text,
                structure.structure_type,structure.tier,structure.district_type,
                structure.owner_player_id,
                (SELECT username FROM players WHERE id=structure.owner_player_id) AS owner_username,
                structure.world_id,structure.region_code,structure.lat,structure.lon,
                structure.footprint_radius_m,structure.placement_revision::text,
                structure.state,structure.construction_started_at,
                structure.construction_completes_at,structure.built_at,
                structure.upgraded_at,structure.destroyed_at,
                structure.build_operation_key,
                operation.actor_player_id,operation.request_id,operation.action,
                city.name AS city_name
         FROM city_structures structure
         JOIN city_structure_operations operation
           ON operation.operation_key=structure.build_operation_key
         JOIN cities city ON city.id=structure.city_id AND city.active
         WHERE structure.state='constructing'
            AND structure.structure_type IN (
              'city_house','mayor_house','oil_well','quartz_hut','library','warehouse','cistern_warrens','salon','city_kennel','market','monument',
              'barracks','demolition_factory'
           )
           AND structure.construction_completes_at<=clock_timestamp()
         ORDER BY structure.construction_completes_at,structure.structure_id
         LIMIT $1
         FOR UPDATE OF structure SKIP LOCKED`,
        [Math.min(Math.max(limit, 1), 250)]
      );
      const completed: CityConstructionCompletion[] = [];
      for (const row of due.rows) {
        if (isPersonalBuildingStructureType(row.structure_type)) {
          try {
            await requireActiveCityMember(
              client,
              row.owner_player_id!,
              row.city_id
            );
            const city = await lockCity(client, row.city_id, this.worldId);
            await validatePlacement(
              client,
              city,
              { lat: Number(row.lat), lon: Number(row.lon) },
              row.structure_type,
              row.structure_id
            );
          } catch (error) {
            if (!(error instanceof CityStructureError)) throw error;
            const cancelled = await this.cancelOilWellConstructionInTransaction(
              client,
              row,
              error.code
            );
            completed.push({
              actorPlayerId: row.actor_player_id,
              requestId: row.request_id,
              structure: cancelled.structure,
              membership: null,
              ...(cancelled.inventory
                ? { inventory: cancelled.inventory }
                : {}),
              ...(cancelled.droppedItems
                ? { droppedItems: cancelled.droppedItems }
                : {})
            });
            continue;
          }
        }
        const updated = await client.query<StructureRow>(
          `UPDATE city_structures
           SET state='active',
               structure_type=CASE
                 WHEN structure_type='mayor_house' THEN 'city_house'
                 ELSE structure_type
               END,
               built_at=CASE
                 WHEN $2 IN (
                   'build_house','build_oil_well','build_quartz_hut','build_library','build_facility','build_market','build_monument'
                 ) THEN construction_completes_at
                 ELSE built_at
               END,
               upgraded_at=CASE
                 WHEN $2 IN ('upgrade_facility','upgrade_monument')
                   THEN construction_completes_at
                 ELSE upgraded_at
               END,
               placement_revision=placement_revision+1,updated_at=clock_timestamp()
           WHERE structure_id=$1::uuid AND state='constructing'
           RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
          [row.structure_id, row.action]
        );
        const active = updated.rows[0];
        if (!active) continue;
        active.owner_username = row.owner_username ?? null;
        if (isPersonalBuildingStructureType(active.structure_type) && PERSONAL_PRODUCERS[active.structure_type].productionTable) {
          const spec = PERSONAL_PRODUCERS[active.structure_type];
          await client.query(
            `INSERT INTO ${spec.productionTable} (
               structure_id,owner_player_id,${spec.storedColumn},production_cursor
             ) VALUES ($1::uuid,$2,0,$3)
             ON CONFLICT (structure_id) DO NOTHING`,
            [
              active.structure_id,
              active.owner_player_id,
              active.construction_completes_at
            ]
          );
        }
        let membership: CityMembershipSnapshot | null = null;
        if (
          active.structure_type === "city_house" ||
          active.structure_type === "mayor_house"
        ) {
          const cityAuthority = await client.query<{ controller_kind: "player" | "npc" }>(
            "SELECT controller_kind FROM cities WHERE id=$1 FOR UPDATE",
            [active.city_id]
          );
          if (cityAuthority.rows[0]?.controller_kind !== "player") {
            throw new CityStructureError(
              "CITY_PERMISSION_DENIED",
              "NPC cities do not accept player membership"
            );
          }
          const membershipId = randomUUID();
          const insertedMembership = await client.query<{ joined_at: Date | string }>(
            `INSERT INTO city_memberships (
               membership_id,city_id,player_id,world_id,role,house_structure_id,joined_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING joined_at`,
            [
              membershipId,
              active.city_id,
              active.owner_player_id,
              active.world_id,
              "member",
              active.structure_id,
              active.construction_completes_at
            ]
          );
          membership = {
            cityId: active.city_id,
            cityName: row.city_name,
            role: "member",
            joinedAt: new Date(
              insertedMembership.rows[0]!.joined_at
            ).toISOString(),
            houseStructureId: active.structure_id,
            expansionFlagCount: 0,
            expansionFlagLimit: 0
          };
        }
        if (active.structure_type === "market") {
          const venueId = randomUUID();
          await client.query(
            `INSERT INTO market_venues (
               venue_id, venue_key, display_name, scope_type, access_policy_id,
               fee_policy_id, active, city_id, market_structure_id,
               tax_revision, state
             ) VALUES (
               $1,$2,$3,'regional','physical-city-market-v1',
               2,true,$4,$5,1,'active'
             )
             ON CONFLICT (city_id) DO UPDATE
             SET market_structure_id = EXCLUDED.market_structure_id,
                 display_name = EXCLUDED.display_name,
                 active = true,
                 state = 'active',
                 tax_revision = market_venues.tax_revision + 1`,
            [
              venueId,
              `city:${active.city_id}`,
              `${row.city_name} City Market`,
              active.city_id,
              active.structure_id
            ]
          );
          await client.query(
            `INSERT INTO market_venue_controls (venue_id)
             SELECT venue_id FROM market_venues WHERE city_id = $1
             ON CONFLICT (venue_id) DO UPDATE
             SET frozen = false,
                 new_orders_enabled = true,
                 matching_enabled = true,
                 cancellations_enabled = true,
                 claims_enabled = true,
                 updated_at = clock_timestamp()`,
            [active.city_id]
          );
        }
        if (active.structure_type === "monument") {
          const cityBefore = await client.query<{
            district_revision: string;
            spatial_revision: string;
          }>(
            `SELECT district_revision::text, spatial_revision::text
             FROM cities WHERE id = $1 FOR UPDATE`,
            [active.city_id]
          );
          const revised = await client.query<{
            district_revision: string;
            spatial_revision: string;
          }>(
            `UPDATE cities
             SET monument_ever_activated = true,
                 district_revision = district_revision + 1,
                 spatial_revision = spatial_revision + 1
             WHERE id = $1
             RETURNING district_revision::text, spatial_revision::text`,
            [active.city_id]
          );
          await client.query(
            `UPDATE market_venues
             SET tax_revision = tax_revision + 1
             WHERE city_id = $1 AND state = 'active'`,
            [active.city_id]
          );
          await writeDistrictEvent(client, {
            cityId: active.city_id,
            actorPlayerId: row.actor_player_id,
            structureId: active.structure_id,
            operationKey: active.build_operation_key,
            eventType: "monument_activated",
            priorDistrict: active.district_type,
            newDistrict: active.district_type,
            priorTier: null,
            newTier: active.tier as 1 | 2 | 3,
            priorDistrictRevision:
              cityBefore.rows[0]!.district_revision,
            districtRevision: revised.rows[0]!.district_revision,
            priorCityRevision: cityBefore.rows[0]!.spatial_revision,
            cityRevision: revised.rows[0]!.spatial_revision
          });
        }
        await writeStructureEvent(
          client,
          active.build_operation_key,
          active.city_id,
          active.structure_id,
          row.actor_player_id,
          active.structure_type === "market"
            ? "market_activated"
            : active.structure_type === "monument"
              ? "monument_activated"
              : "activated",
          { completedAt: active.construction_completes_at }
        );
        const structure = rowToStructure(active);
        await completeStructureOperation(
          client,
          active.build_operation_key,
          active.structure_type === "city_house" ||
            active.structure_type === "mayor_house"
            ? { structure, membership, replayed: false }
            : { structure }
        );
        completed.push({
          actorPlayerId: row.actor_player_id,
          requestId: row.request_id,
          structure,
          membership
        });
      }
      await client.query("COMMIT");
      return completed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateStructureConstraint(error);
    } finally {
      client.release();
    }
  }

  async reconcileExpiredFounderClaimDeadlines(limit = 25): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<{ id: string }>(
        `SELECT id
         FROM cities
         WHERE active AND mayor_house_deadline IS NOT NULL
           AND mayor_house_deadline <= clock_timestamp()
         ORDER BY mayor_house_deadline,id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit]
      );
      for (const city of expired.rows) {
        await client.query(
          `UPDATE cities
           SET mayor_house_deadline=NULL,
               spatial_revision=spatial_revision+1
           WHERE id=$1 AND mayor_house_deadline <= clock_timestamp()`,
          [city.id]
        );
      }
      await client.query("COMMIT");
      return expired.rows.map((row) => row.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async changeMayor(
    playerId: string,
    cityId: string,
    requestId: string,
    action: "claim_mayor" | "relinquish_mayor"
  ): Promise<CityHouseMutationResult> {
    const client = await this.pool.connect();
    const operationKey = `city-structure:${playerId}:${requestId}`;
    try {
      await client.query("BEGIN");
      await lockPlayerAndCity(client, playerId, cityId);
      const city = await lockCity(client, cityId, this.worldId);
      await reconcileLockedFounderClaimDeadline(client, city);
      const replay = await replayStructureOperation(client, operationKey, playerId, action);
      if (replay) {
        await client.query("COMMIT");
        return { ...(replay as CityHouseMutationResult), replayed: true };
      }
      const membership = await client.query<{
        membership_id: string;
        joined_at: Date | string;
        house_structure_id: string;
      }>(
        `SELECT membership.membership_id::text,membership.joined_at,
                membership.house_structure_id::text
         FROM city_memberships membership
         JOIN city_structures house
           ON house.structure_id=membership.house_structure_id
          AND house.state='active'
          AND house.structure_type IN ('city_house','mayor_house')
         WHERE membership.player_id=$1 AND membership.city_id=$2
           AND membership.left_at IS NULL
         FOR UPDATE OF membership,house`,
        [playerId, cityId]
      );
      const member = membership.rows[0];
      if (!member) {
        throw new CityStructureError(
          "CITY_MAYOR_REQUIRED_MEMBERSHIP",
          "An active City House in this city is required"
        );
      }
      if (action === "claim_mayor") {
        if (city.mayor_player_id) {
          throw new CityStructureError(
            "CITY_MAYOR_ALREADY_CLAIMED",
            "This city already has a Mayor."
          );
        }
      } else if (city.mayor_player_id !== playerId || city.mayor_confirmed_at === null) {
        throw new CityStructureError(
          "CITY_MAYOR_PERMISSION_DENIED",
          "Only the confirmed Mayor may relinquish city control"
        );
      }
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId,
        action,
        cityId,
        structureId: member.house_structure_id,
        intent: { cityId, houseStructureId: member.house_structure_id }
      });
      if (action === "claim_mayor") {
        const claimed = await client.query<{ mayor_confirmed_at: Date | string }>(
          `UPDATE cities
           SET mayor_player_id=$2,
               mayor_confirmed_at=clock_timestamp(),
               mayor_house_deadline=NULL,
               spatial_revision=spatial_revision+1
           WHERE id=$1 AND active AND mayor_player_id IS NULL
             AND (
               mayor_house_deadline IS NULL
               OR mayor_house_deadline <= clock_timestamp()
               OR founder_player_id=$2
             )
           RETURNING mayor_confirmed_at`,
          [cityId, playerId]
        );
        if (!claimed.rows[0]) {
          const status = await client.query<{
            mayor_player_id: string | null;
            founder_reserved: boolean;
          }>(
            `SELECT mayor_player_id,
                    mayor_house_deadline > clock_timestamp() AS founder_reserved
             FROM cities WHERE id=$1`,
            [cityId]
          );
          if (status.rows[0]?.mayor_player_id) {
            throw new CityStructureError(
              "CITY_MAYOR_ALREADY_CLAIMED",
              "This city already has a Mayor."
            );
          }
          if (status.rows[0]?.founder_reserved) {
            throw new CityStructureError(
              "CITY_MAYOR_FOUNDER_RESERVED",
              "Only the city founder may claim Mayor before the founder reservation expires."
            );
          }
          throw new CityStructureError(
            "CITY_MAYOR_ALREADY_CLAIMED",
            "This city already has a Mayor."
          );
        }
      } else {
        const relinquished = await client.query(
          `UPDATE cities
           SET mayor_player_id=NULL,mayor_confirmed_at=NULL,
               mayor_house_deadline=NULL,spatial_revision=spatial_revision+1
           WHERE id=$1 AND active
             AND mayor_player_id=$2 AND mayor_confirmed_at IS NOT NULL`,
          [cityId, playerId]
        );
        if (relinquished.rowCount !== 1) {
          throw new CityStructureError(
            "CITY_MAYOR_PERMISSION_DENIED",
            "Only the confirmed Mayor may relinquish city control"
          );
        }
      }
      const targetType = action === "claim_mayor" ? "mayor_house" : "city_house";
      const changed = await client.query<StructureRow>(
        `UPDATE city_structures
         SET structure_type=$2,placement_revision=placement_revision+1,updated_at=now()
         WHERE structure_id=$1::uuid AND state='active'
           AND structure_type=$3
         RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [
          member.house_structure_id,
          targetType,
          action === "claim_mayor" ? "city_house" : "mayor_house"
        ]
      );
      if (!changed.rows[0]) {
        throw new CityStructureError(
          "CITY_MAYOR_HOUSE_INVARIANT_BROKEN",
          action === "claim_mayor"
            ? "Mayor claim requires an active City House"
            : "Confirmed Mayor control requires an active Mayor House"
        );
      }
      const changedMembership = await client.query(
        `UPDATE city_memberships SET role=$3
         WHERE membership_id=$1::uuid AND house_structure_id=$2::uuid
           AND role=$4`,
        [
          member.membership_id,
          member.house_structure_id,
          action === "claim_mayor" ? "mayor" : "member",
          action === "claim_mayor" ? "member" : "mayor"
        ]
      );
      if (changedMembership.rowCount !== 1) {
        throw new CityStructureError(
          "CITY_MAYOR_MEMBERSHIP_INVARIANT_BROKEN",
          "Mayor control requires the matching active city membership"
        );
      }
      await writeStructureEvent(
        client,
        operationKey,
        cityId,
        member.house_structure_id,
        playerId,
        action === "claim_mayor" ? "promoted_to_mayor_house" : "demoted_to_city_house",
        {}
      );
      const result: CityHouseMutationResult = {
        structure: rowToStructure(changed.rows[0]),
        membership: {
          cityId,
          cityName: city.name,
          role: action === "claim_mayor" ? "mayor" : "member",
          joinedAt: new Date(member.joined_at).toISOString(),
          houseStructureId: member.house_structure_id,
          expansionFlagCount: 0,
          expansionFlagLimit: 0
        },
        replayed: false
      };
      await completeStructureOperation(client, operationKey, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateStructureConstraint(error);
    } finally {
      client.release();
    }
  }

  async destroyPersonalStructuresForMembershipLossInTransaction(
    client: pg.PoolClient,
    playerId: string,
    cityId: string,
    reason: string,
    excludeStructureId?: string
  ): Promise<{
    structures: CityStructureSnapshot[];
    inventory?: PlayerInventorySnapshot;
    droppedItems: DroppedItemSnapshot[];
  }> {
    const rows = await client.query<StructureRow>(
      `${STRUCTURE_SELECT}
       WHERE owner_player_id=$1 AND city_id=$2::uuid
         AND structure_type IN ('oil_well','quartz_hut','library')
         AND state IN ('constructing','active')
         AND ($3::uuid IS NULL OR structure_id<>$3::uuid)
       ORDER BY structure_id
       FOR UPDATE`,
      [playerId, cityId, excludeStructureId ?? null]
    );
    const structures: CityStructureSnapshot[] = [];
    const droppedItems: DroppedItemSnapshot[] = [];
    let inventory: PlayerInventorySnapshot | undefined;
    for (const row of rows.rows) {
      if (row.state === "constructing") {
        const cancelled = await this.cancelOilWellConstructionInTransaction(
          client,
          row,
          reason
        );
        structures.push(cancelled.structure);
        if (cancelled.inventory) inventory = cancelled.inventory;
        droppedItems.push(...(cancelled.droppedItems ?? []));
        continue;
      }
      const spec = producerSpecForRow(row);
      const operationKey = `city-membership-loss:${row.structure_id}`;
      await reserveStructureOperation(client, {
        operationKey,
        playerId,
        requestId: `membership-loss:${row.structure_id}`,
        action: spec.destroyAction,
        cityId,
        structureId: row.structure_id,
        intent: { reason, automatic: true }
      });
      if (spec.productionTable) {
        await client.query(
          `DELETE FROM ${spec.productionTable} WHERE structure_id=$1::uuid`,
          [row.structure_id]
        );
      }
      const destroyed = await client.query<StructureRow>(
        `UPDATE city_structures
         SET state='destroyed',destroyed_at=clock_timestamp(),
             placement_revision=placement_revision+1,updated_at=clock_timestamp()
         WHERE structure_id=$1::uuid AND state='active'
         RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
        [row.structure_id]
      );
      if (destroyed.rows[0]) {
        destroyed.rows[0].owner_username = row.owner_username ?? null;
      }
      if (!destroyed.rows[0]) continue;
      await writeStructureEvent(
        client,
        operationKey,
        cityId,
        row.structure_id,
        playerId,
        "destroyed",
        { type: spec.type, reason, automatic: true, refund: false }
      );
      const structure = rowToStructure(destroyed.rows[0]);
      await completeStructureOperation(client, operationKey, { structure });
      structures.push(structure);
    }
    return {
      structures,
      ...(inventory ? { inventory } : {}),
      droppedItems
    };
  }

  private async cancelOilWellConstructionInTransaction(
    client: pg.PoolClient,
    row: StructureRow,
    reason: string
  ): Promise<CityFacilityMutationResult> {
    const spec = producerSpecForRow(row);
    const refund = await this.refundStructureMaterialsInTransaction(
      client,
      row,
      row.build_operation_key,
      `${spec.type}_construction_cancelled`,
      true
    );
    const destroyed = await client.query<StructureRow>(
      `UPDATE city_structures
       SET state='destroyed',destroyed_at=clock_timestamp(),
           placement_revision=placement_revision+1,updated_at=clock_timestamp()
       WHERE structure_id=$1::uuid AND state='constructing'
       RETURNING ${STRUCTURE_RETURNING_FIELDS}`,
      [row.structure_id]
    );
    const cancelled = destroyed.rows[0];
    if (!cancelled) {
      throw new CityStructureError(
        `${spec.errorPrefix}_CONSTRUCTION_STALE`,
        `${spec.name} construction changed before cancellation completed.`
      );
    }
    cancelled.owner_username = row.owner_username ?? null;
    await writeStructureEvent(
      client,
      row.build_operation_key,
      row.city_id,
      row.structure_id,
      row.owner_player_id!,
      "cancelled",
      { type: spec.type, reason }
    );
    const result: CityFacilityMutationResult = {
      structure: rowToStructure(cancelled),
      inventory: refund.inventory,
      droppedItems: refund.droppedItems
    };
    await completeStructureOperation(client, row.build_operation_key, result);
    return result;
  }

  private async refundStructureMaterialsInTransaction(
    client: pg.PoolClient,
    row: StructureRow,
    operationKey: string,
    source: string,
    fullRefund: boolean,
    sourceOperationKey?: string
  ): Promise<{
    inventory: PlayerInventorySnapshot;
    droppedItems: DroppedItemSnapshot[];
  }> {
    const lines = fullRefund
      ? await structureMaterialSpendLines(client, row.structure_id, sourceOperationKey)
      : await structureMaterialRefundLines(client, row.structure_id);
    if (lines.length === 0) {
      return {
        inventory: await this.inventory.snapshotInTransaction(
          client,
          row.owner_player_id!
        ),
        droppedItems: []
      };
    }
    const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
      operationKey: `${operationKey}:refund`,
      playerId: row.owner_player_id!,
      source,
      sourceEntityType: "city_structure",
      sourceEntityId: row.structure_id,
      metadata: { cityId: row.city_id, fullRefund },
      allowPartial: true,
      grants: lines.map((line) => ({
        itemId: line.itemId,
        variant: line.variant,
        quantity: BigInt(line.refundQuantity)
      }))
    });
    const dropQuantities = new Map<string, number>();
    for (const line of lines) {
      const granted = grant.grants.find(
        (candidate) => candidate.itemId === line.itemId &&
          (candidate.variant ?? "default") === line.variant
      )?.grantedQuantity ?? 0;
      const dropped = line.refundQuantity - granted;
      await writeStructureRefund(client, {
        operationKey,
        structureId: row.structure_id,
        line,
        quantity: granted,
        destination: "player_inventory",
        recipientPlayerId: row.owner_player_id!
      });
      if (dropped > 0) {
        dropQuantities.set(`${line.itemId}\u0000${line.variant}`, dropped);
        await writeStructureRefund(client, {
          operationKey,
          structureId: row.structure_id,
          line,
          quantity: dropped,
          destination: "ground_drop",
          recipientPlayerId: row.owner_player_id!
        });
      }
    }
    return {
      inventory: grant.inventory,
      droppedItems: await createSystemGroundDropsInTransaction(client, {
        operationKey: `${operationKey}:ground-refund`,
        droppedByPlayerId: row.owner_player_id!,
        regionCode: row.region_code ?? "unknown",
        position: { lat: Number(row.lat), lon: Number(row.lon) },
        reason: source,
        lines: refundDropLines(lines, dropQuantities)
      })
    };
  }

  private async replayHouse(
    operationKey: string,
    playerId: string,
    action: string,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool
  ): Promise<CityHouseMutationResult | null> {
    const replay = await replayStructureOperation(queryable, operationKey, playerId, action);
    if (!replay) return null;
    return { ...(replay as CityHouseMutationResult), replayed: true };
  }
}

type OilWellProductionRow = {
  structure_id: string;
  owner_player_id: string;
  /** Stored units of the producer's resource (stored_crude_oil / stored_crystal). */
  stored: number;
  production_cursor: Date | string;
  settled_capacity: number;
  server_now: Date | string;
};

async function requireActiveCityMember(
  client: pg.PoolClient,
  playerId: string,
  cityId: string
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM city_memberships
     WHERE player_id=$1 AND city_id=$2::uuid AND left_at IS NULL
     LIMIT 1 FOR SHARE`,
    [playerId, cityId]
  );
  if (!result.rowCount) {
    throw new CityStructureError(
      "OIL_WELL_MEMBERSHIP_REQUIRED",
      "Active membership in this city is required."
    );
  }
}

export async function requireActiveCityMemberForMilitary(
  client: pg.PoolClient,
  playerId: string,
  cityId: string,
  facilityName = "personal military facility"
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM city_memberships
     WHERE player_id=$1 AND city_id=$2::uuid AND left_at IS NULL
     LIMIT 1 FOR SHARE`,
    [playerId, cityId]
  );
  if (!result.rowCount) {
    throw new CityStructureError(
      facilityName === "Lodge"
        ? "LODGE_CITY_MEMBERSHIP_REQUIRED"
        : "CITY_MILITARY_MEMBERSHIP_REQUIRED",
      `Active membership in this city is required for a ${facilityName}.`
    );
  }
}

type PersonalProducerSpec = Readonly<{
  type: PersonalBuildingStructureType;
  name: string;
  article: "a" | "an";
  errorPrefix: "OIL_WELL" | "QUARTZ_HUT" | "LIBRARY";
  buildAction: "build_oil_well" | "build_quartz_hut" | "build_library";
  destroyAction: "destroy_oil_well" | "destroy_quartz_hut" | "destroy_library";
  cost: CityMaterialCost;
  /** Null for the Library, which has no production state. */
  productionTable: "city_oil_well_production" | "city_quartz_hut_production" | null;
  storedColumn: "stored_crude_oil" | "stored_crystal" | null;
  itemId: "crude_oil" | typeof QUARTZ_HUT_ITEM_ID | null;
  itemName: string;
  productionPerHour: number;
  unitIntervalMs: number;
}>;

/** Oil Well and Quartz Hut share one producer flow; only these constants differ. */
const PERSONAL_PRODUCERS: Readonly<Record<PersonalBuildingStructureType, PersonalProducerSpec>> = {
  oil_well: {
    type: "oil_well",
    name: "Oil Well",
    article: "an",
    errorPrefix: "OIL_WELL",
    buildAction: "build_oil_well",
    destroyAction: "destroy_oil_well",
    cost: OIL_WELL_COST,
    productionTable: "city_oil_well_production",
    storedColumn: "stored_crude_oil",
    itemId: "crude_oil",
    itemName: "Crude Oil",
    productionPerHour: OIL_WELL_PRODUCTION_PER_HOUR,
    unitIntervalMs: OIL_WELL_UNIT_INTERVAL_MS
  },
  quartz_hut: {
    type: "quartz_hut",
    name: "Quartz Hut",
    article: "a",
    errorPrefix: "QUARTZ_HUT",
    buildAction: "build_quartz_hut",
    destroyAction: "destroy_quartz_hut",
    cost: QUARTZ_HUT_COST,
    productionTable: "city_quartz_hut_production",
    storedColumn: "stored_crystal",
    itemId: QUARTZ_HUT_ITEM_ID,
    itemName: "Crystal",
    productionPerHour: QUARTZ_HUT_PRODUCTION_PER_HOUR,
    unitIntervalMs: QUARTZ_HUT_UNIT_INTERVAL_MS
  },
  library: {
    type: "library",
    name: "Library",
    article: "a",
    errorPrefix: "LIBRARY",
    buildAction: "build_library",
    destroyAction: "destroy_library",
    cost: LIBRARY_COST,
    productionTable: null,
    storedColumn: null,
    itemId: null,
    itemName: "Folios",
    productionPerHour: 0,
    unitIntervalMs: 0
  }
};
const PERSONAL_PRODUCER_DESTROY_ACTIONS = ["destroy_oil_well", "destroy_quartz_hut", "destroy_library"] as const;

function producerSpecForRow(row: Pick<StructureRow, "structure_type">): PersonalProducerSpec {
  if (!isPersonalBuildingStructureType(row.structure_type)) {
    throw new Error(`Not a personal building: ${row.structure_type}`);
  }
  return PERSONAL_PRODUCERS[row.structure_type];
}

function producerCapacity(spec: PersonalProducerSpec, oilWorkerRank: number): number {
  return spec.type === "oil_well"
    ? oilWellCapacityForOilWorkerRank(oilWorkerRank)
    : QUARTZ_HUT_CAPACITY;
}

/** Locks an active personal producer (Oil Well or Quartz Hut). */
async function lockActiveOilWell(
  client: pg.PoolClient,
  structureId: string,
  includeLibrary = false
): Promise<StructureRow> {
  const result = await client.query<StructureRow>(
    `${STRUCTURE_SELECT}
     WHERE structure_id=$1::uuid
       AND (structure_type IN ('oil_well','quartz_hut') OR ($2::boolean AND structure_type='library'))
       AND state='active'
     FOR UPDATE`,
    [structureId, includeLibrary]
  );
  if (!result.rows[0]) {
    throw new CityStructureError(
      "OIL_WELL_NOT_FOUND",
      "That structure is no longer active."
    );
  }
  return result.rows[0];
}

function requireOilWellOwnerAndProximity(
  structure: StructureRow,
  playerId: string,
  position: Position
): void {
  requireOilWellOwner(structure, playerId);
  requireNearOilWell(structure, position);
}

function requireNearOilWell(
  structure: StructureRow,
  position: Position
): void {
  if (
    distanceMeters(position, {
      lat: Number(structure.lat),
      lon: Number(structure.lon)
    }) > OIL_WELL_INTERACTION_RADIUS_M
  ) {
    throw new CityStructureError(
      `${producerSpecForRow(structure).errorPrefix}_PROXIMITY_REQUIRED`,
      `Stand within ${OIL_WELL_INTERACTION_RADIUS_M} meters of the ${producerSpecForRow(structure).name}.`
    );
  }
}

function requireOilWellOwner(
  structure: StructureRow,
  playerId: string
): void {
  if (structure.owner_player_id !== playerId) {
    throw new CityStructureError(
      `${producerSpecForRow(structure).errorPrefix}_OWNER_REQUIRED`,
      `Only the ${producerSpecForRow(structure).name} owner may use it.`
    );
  }
}

async function settleOilWellProduction(
  client: pg.PoolClient,
  spec: PersonalProducerSpec,
  structureId: string,
  capacity: number
): Promise<OilWellProductionRow> {
  const locked = await client.query<OilWellProductionRow>(
    `SELECT structure_id::text,owner_player_id,${spec.storedColumn} AS stored,
            production_cursor,settled_capacity,clock_timestamp() AS server_now
     FROM ${spec.productionTable}
     WHERE structure_id=$1::uuid
     FOR UPDATE`,
    [structureId]
  );
  const row = locked.rows[0];
  if (!row) {
    throw new CityStructureError(
      `${spec.errorPrefix}_PRODUCTION_UNAVAILABLE`,
      `${spec.name} production state is unavailable.`
    );
  }
  const nowMs = new Date(row.server_now).getTime();
  const priorCapacity = Number(row.settled_capacity);
  const cursorMs = capacity > priorCapacity && Number(row.stored) >= priorCapacity
    ? nowMs
    : new Date(row.production_cursor).getTime();
  const completedUnits = Math.max(
    0,
    Math.floor((nowMs - cursorMs) / spec.unitIntervalMs)
  );
  const nextStored = Math.min(
    capacity,
    Number(row.stored) + completedUnits
  );
  const nextCursorMs = nextStored >= capacity
    ? nowMs
    : cursorMs + completedUnits * spec.unitIntervalMs;
  if (
    nextStored !== Number(row.stored) ||
    nextCursorMs !== new Date(row.production_cursor).getTime() ||
    priorCapacity !== capacity
  ) {
    const updated = await client.query<OilWellProductionRow>(
      `UPDATE ${spec.productionTable}
       SET ${spec.storedColumn}=$2,
           production_cursor=to_timestamp($3::double precision / 1000.0),
           settled_capacity=$4,
           updated_at=clock_timestamp()
       WHERE structure_id=$1::uuid
       RETURNING structure_id::text,owner_player_id,${spec.storedColumn} AS stored,
                 production_cursor,settled_capacity,clock_timestamp() AS server_now`,
      [structureId, nextStored, nextCursorMs, capacity]
    );
    return updated.rows[0]!;
  }
  return row;
}

function oilWellSnapshot(
  spec: PersonalProducerSpec,
  structure: StructureRow,
  production: OilWellProductionRow,
  serverTime: number,
  capacity: number,
  actorPlayerId: string,
  tollGold: bigint
): OilWellSnapshot {
  const stored = Number(production.stored);
  const cursorMs = new Date(production.production_cursor).getTime();
  return {
    structureId: structure.structure_id,
    structureType: spec.type,
    resourceItemId: spec.itemId!, // producers only
    ownerPlayerId: structure.owner_player_id!,
    ownerUsername: structure.owner_username ?? "Unknown player",
    storedCrudeOil: stored,
    capacity,
    productionPerHour: spec.productionPerHour,
    serverTime,
    nextUnitAt: stored < capacity
      ? new Date(cursorMs + spec.unitIntervalMs).toISOString()
      : null,
    fullAt: stored < capacity
      ? new Date(cursorMs + (capacity - stored) * spec.unitIntervalMs).toISOString()
      : null,
    canHarvest: stored > 0,
    canDestroy: structure.owner_player_id === actorPlayerId,
    accessMode: structure.harvest_access_mode ?? "private",
    accessRevision: String(structure.harvest_access_revision ?? 0),
    tollGold: structure.owner_player_id === actorPlayerId ? "0" : tollGold.toString(),
    isOwner: structure.owner_player_id === actorPlayerId
  };
}

async function oilWellToll(
  client: pg.PoolClient,
  ownerPlayerId: string
): Promise<bigint> {
  const result = await client.query<{ toll_gold: string }>(
    `SELECT toll_gold::text FROM player_harvest_toll_settings
     WHERE owner_player_id=$1 AND harvest_type='oil_well' FOR SHARE`,
    [ownerPlayerId]
  );
  return BigInt(result.rows[0]?.toll_gold ?? "0");
}

export async function validateCityTerritoryFootprint(
  client: pg.PoolClient,
  cityId: string,
  position: Position,
  footprintRadiusM: number,
  purpose: "structure" | "lodge" = "structure"
): Promise<void> {
  const footprintSql =
    "ST_Buffer(ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,$3)::geometry";
  const covered = await client.query<{ covered: boolean; foreign_overlap: boolean }>(
    `WITH proposed AS (
       SELECT ${footprintSql} AS geom
     ), own_territory AS (
       SELECT ST_UnaryUnion(ST_Collect(
         ST_Buffer(flag.geom::geography,flag.claim_radius_m)::geometry
       )) AS geom
       FROM flags flag
       WHERE flag.city_id=$4 AND flag.control_type IN ('city','city_seat')
     )
     SELECT COALESCE(ST_Covers(own_territory.geom,proposed.geom),false) AS covered,
            EXISTS (
              SELECT 1 FROM flags foreign_flag
              WHERE foreign_flag.city_id IS NOT NULL
                AND foreign_flag.city_id<>$4
                AND foreign_flag.control_type IN ('city','city_seat')
                AND ST_Intersects(
                  ST_Buffer(foreign_flag.geom::geography,foreign_flag.claim_radius_m)::geometry,
                  proposed.geom
                )
            ) AS foreign_overlap
     FROM proposed,own_territory`,
    [position.lat, position.lon, footprintRadiusM, cityId]
  );
  if (!covered.rows[0]?.covered) {
    throw new CityStructureError(
      purpose === "lodge"
        ? "LODGE_CITY_TERRITORY_REQUIRED"
        : "CITY_STRUCTURE_FOOTPRINT_OUTSIDE_TERRITORY",
      purpose === "lodge"
        ? "The entire Lodge footprint must be inside active city-controlled territory"
        : "The entire structure footprint must be inside active city-controlled territory"
    );
  }
  if (covered.rows[0].foreign_overlap) {
    throw new CityStructureError(
      purpose === "lodge"
        ? "LODGE_CITY_FOREIGN_TERRITORY"
        : "CITY_STRUCTURE_FOREIGN_TERRITORY",
      purpose === "lodge"
        ? "A Lodge cannot overlap another city's territory"
        : "A city structure cannot overlap another city's territory"
    );
  }
}

async function validatePlacement(
  client: pg.PoolClient,
  city: CityLockRow,
  position: Position,
  type: ActiveCityStructureType,
  excludedStructureId: string | null = null,
  worldLookup?: Pick<WorldLookupClient, "lookupGameplayEnvironments">
): Promise<void> {
  const radius = CITY_STRUCTURE_FOOTPRINT_RADIUS_M[type];
  if (worldLookup) {
    const water = await classifyLandFootprint(worldLookup, position, radius);
    if (water === "river") {
      throw new CityStructureError(
        "CITY_STRUCTURE_RIVER_WATER",
        "Cannot build on river water."
      );
    }
    if (water === "other-water") {
      throw new CityStructureError(
        "CITY_STRUCTURE_WATER",
        "Cannot build on water."
      );
    }
  }
  await validateCityTerritoryFootprint(client, city.id, position, radius);
  const hallDistance = distanceMeters(position, {
    lat: Number(city.hall_lat),
    lon: Number(city.hall_lon)
  });
  const hallRequired = cityStructureRequiredCenterDistanceM(
    radius,
    CITY_HALL_FOOTPRINT_RADIUS_M
  );
  if (hallDistance < hallRequired) {
    throw new CityStructureError(
      "CITY_STRUCTURE_CLEARANCE_REQUIRED",
      `This structure needs ${Math.ceil(hallRequired)} meters of center clearance from City Hall`,
      {
        blockingStructureId: city.id,
        blockingStructureType: "city_hall",
        requiredCenterDistanceM: hallRequired,
        actualCenterDistanceM: hallDistance,
        proposedExclusionRadiusM: cityStructureExclusionRadiusM(radius),
        blockingExclusionRadiusM:
          cityStructureExclusionRadiusM(CITY_HALL_FOOTPRINT_RADIUS_M)
      }
    );
  }
  const collision = await client.query<{
    structure_id: string;
    structure_type: CityStructureType;
    footprint_radius_m: number;
    distance_m: number;
    required_m: number;
  }>(
    `SELECT structure_id::text,structure_type,footprint_radius_m,
            ST_Distance(
              geom::geography,
              ST_SetSRID(ST_MakePoint($1,$2),4326)::geography
            ) AS distance_m,
            footprint_radius_m+$3+($4*2) AS required_m
     FROM city_structures
     WHERE state IN ('constructing','active')
       AND ($5::uuid IS NULL OR structure_id<>$5::uuid)
       AND ST_DWithin(
         geom::geography,
         ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
         footprint_radius_m+$3+($4*2)
       )
       AND ST_Distance(
         geom::geography,
         ST_SetSRID(ST_MakePoint($1,$2),4326)::geography
       ) < footprint_radius_m+$3+($4*2)
     ORDER BY distance_m,structure_id
     LIMIT 1
     FOR SHARE`,
    [
      position.lon,
      position.lat,
      radius,
      CITY_STRUCTURE_EXCLUSION_MARGIN_M,
      excludedStructureId
    ]
  );
  if (collision.rows[0]) {
    throw new CityStructureError(
      "CITY_STRUCTURE_CLEARANCE_REQUIRED",
      "This placement is too close to another city structure",
      {
        blockingStructureId: collision.rows[0].structure_id,
        blockingStructureType: collision.rows[0].structure_type,
        requiredCenterDistanceM: Number(collision.rows[0].required_m),
        actualCenterDistanceM: Number(collision.rows[0].distance_m),
        proposedExclusionRadiusM: cityStructureExclusionRadiusM(radius),
        blockingExclusionRadiusM: cityStructureExclusionRadiusM(
          Number(collision.rows[0].footprint_radius_m)
        )
      }
    );
  }
}

async function insertStructure(
  client: pg.PoolClient,
  input: {
    structureId: string;
    city: CityLockRow;
    type: ActiveCityStructureType;
    tier: 1 | 2 | 3;
    districtType?: CityDistrictType | null;
    ownerPlayerId: string | null;
    position: Position;
    operationKey: string;
  }
): Promise<StructureRow> {
  const radius = CITY_STRUCTURE_FOOTPRINT_RADIUS_M[input.type];
  const action = input.type === "city_house"
    ? "build_house"
    : input.type === "oil_well"
      ? "build_oil_well"
    : input.type === "quartz_hut"
      ? "build_quartz_hut"
    : input.type === "library"
      ? "build_library"
    : input.type === "warehouse"
      ? "build_facility"
      : input.type === "market"
        ? "build_market"
        : "build_monument";
  const result = await client.query<StructureRow>(
    `INSERT INTO city_structures (
       structure_id,city_id,structure_type,tier,district_type,owner_player_id,world_id,region_code,
       lat,lon,geom,footprint_geom,footprint_radius_m,state,build_operation_key,
       construction_started_at,construction_completes_at,built_at,harvest_access_mode
     ) SELECT
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       ST_SetSRID(ST_MakePoint($10,$9),4326),
       ST_Buffer(ST_SetSRID(ST_MakePoint($10,$9),4326)::geography,$11)::geometry,
       $11,'constructing',$12,started_at,
       started_at+($13::bigint * interval '1 millisecond'),NULL,
       CASE WHEN $3='oil_well' THEN 'private' ELSE NULL END
     FROM (SELECT clock_timestamp() AS started_at) construction_clock
     RETURNING structure_id::text,city_id::text,structure_type,tier,district_type,owner_player_id,
               world_id,region_code,lat,lon,footprint_radius_m,
               placement_revision::text,state,construction_started_at,
               construction_completes_at,built_at,upgraded_at,destroyed_at,
               build_operation_key,harvest_access_mode,harvest_access_revision::text`,
    [
      input.structureId,
      input.city.id,
      input.type,
      input.tier,
      input.districtType ?? null,
      input.ownerPlayerId,
      input.city.world_id,
      input.city.region_code,
      input.position.lat,
      input.position.lon,
      radius,
      input.operationKey,
      cityConstructionDurationMs(action)
    ]
  );
  if (input.ownerPlayerId && result.rows[0]) {
    const owner = await client.query<{ username: string }>(
      "SELECT username FROM players WHERE id=$1",
      [input.ownerPlayerId]
    );
    result.rows[0].owner_username = owner.rows[0]?.username ?? null;
  }
  return result.rows[0]!;
}

async function assertNoActiveCityConstruction(
  client: pg.PoolClient,
  playerId: string,
  operationKey: string
): Promise<void> {
  const active = await client.query<{ structure_id: string }>(
    `SELECT structure.structure_id::text
     FROM city_structure_operations operation
     JOIN city_structures structure
       ON structure.build_operation_key=operation.operation_key
     WHERE operation.actor_player_id=$1
       AND operation.operation_key<>$2
       AND operation.action IN (
         'build_house','build_oil_well','build_quartz_hut','build_library','build_facility','build_market','build_monument',
         'upgrade_facility','upgrade_monument'
       )
       AND structure.state='constructing'
     LIMIT 1
     FOR SHARE OF structure`,
    [playerId, operationKey]
  );
  if (active.rows[0]) {
    throw new CityStructureError(
      "CITY_CONSTRUCTION_ALREADY_ACTIVE",
      "Finish the current city construction before starting another."
    );
  }
}

async function lockCityConstructionChannel(
  client: pg.PoolClient,
  playerId: string
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `city-construction-player:${playerId}`
  ]);
}

export async function lockPlayerAndCity(
  client: pg.PoolClient,
  playerId: string,
  cityId: string
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `city-structure:${cityId}`
  ]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `city-house-player:${playerId}`
  ]);
  await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
}

export async function resolveCityAtPosition(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  worldId: string,
  position: Position,
  purpose: "house" | "structure" | "lodge" = "house"
): Promise<string> {
  const result = await queryable.query<{
    city_id: string;
    construction_phase: "blueprint" | "foundation" | "framing" | "complete";
  }>(
    `SELECT city.id::text AS city_id,city.construction_phase
     FROM cities city
     WHERE city.world_id=$1
       AND city.active
       AND EXISTS (
         SELECT 1
         FROM flags flag
         WHERE flag.city_id=city.id
           AND flag.control_type IN ('city','city_seat')
           AND ST_Covers(
             ST_Buffer(flag.geom::geography,flag.claim_radius_m)::geometry,
             ST_SetSRID(ST_MakePoint($2,$3),4326)
           )
       )
     ORDER BY city.id
     LIMIT 2`,
    [worldId, position.lon, position.lat]
  );
  if (result.rows.length === 0) {
    throw new CityStructureError(
      purpose === "house"
        ? "CITY_HOUSE_CITY_TERRITORY_REQUIRED"
        : purpose === "lodge"
          ? "LODGE_CITY_TERRITORY_REQUIRED"
          : "CITY_STRUCTURE_CITY_TERRITORY_REQUIRED",
      purpose === "house"
        ? "Stand inside active city territory to build a City House."
        : purpose === "lodge"
          ? "Stand inside active city territory to build a Lodge."
          : "Stand inside active city territory to build a city structure."
    );
  }
  if (result.rows.length > 1) {
    throw new CityStructureError(
      purpose === "house"
        ? "CITY_HOUSE_CITY_TERRITORY_AMBIGUOUS"
        : purpose === "lodge"
          ? "LODGE_CITY_TERRITORY_AMBIGUOUS"
          : "CITY_STRUCTURE_CITY_TERRITORY_AMBIGUOUS",
      "This location is controlled by more than one active city"
    );
  }
  if (result.rows[0]!.construction_phase !== "complete") {
    throw new CityStructureError(
      "CITY_CONSTRUCTION_INCOMPLETE",
      purpose === "house"
        ? "City Houses cannot be built until city construction is complete"
        : purpose === "lodge"
          ? "Lodges cannot be built until city construction is complete"
          : "City structures cannot be built until city construction is complete"
    );
  }
  return result.rows[0]!.city_id;
}

export async function lockCity(
  client: pg.PoolClient,
  cityId: string,
  worldId: string,
  /** Developer App test placements only (DEV_BUILD_SALON): NPC cities are the only territory some test worlds have. */
  allowNpcCity = false
): Promise<CityLockRow> {
  const result = await client.query<CityLockRow>(
    `SELECT id,world_id,region_code,name,controller_kind,founder_player_id,mayor_player_id,
            mayor_house_deadline,mayor_confirmed_at,hall_lat,hall_lon,
            spatial_revision::text,district_revision::text,
            construction_phase
     FROM cities WHERE id=$1 AND world_id=$2 AND active FOR UPDATE`,
    [cityId, worldId]
  );
  if (!result.rows[0]) {
    throw new CityStructureError("CITY_NOT_FOUND", "City does not exist in this world");
  }
  if (result.rows[0].controller_kind === "npc" && !allowNpcCity) {
    throw new CityStructureError(
      "CITY_PERMISSION_DENIED",
      "NPC cities do not accept player membership or construction"
    );
  }
  if (result.rows[0].construction_phase !== "complete") {
    throw new CityStructureError(
      "CITY_CONSTRUCTION_INCOMPLETE",
      "City structures cannot be built until city construction is complete"
    );
  }
  return result.rows[0];
}

async function reconcileLockedFounderClaimDeadline(
  client: pg.PoolClient,
  city: CityLockRow
): Promise<void> {
  if (city.mayor_house_deadline) {
    const expired = await client.query(
      `UPDATE cities
       SET mayor_house_deadline=NULL,
           spatial_revision=spatial_revision+1
       WHERE id=$1
         AND mayor_house_deadline IS NOT NULL
         AND mayor_house_deadline <= clock_timestamp()`,
      [city.id]
    );
    if (expired.rowCount === 1) {
      city.mayor_house_deadline = null;
    }
  }
}

async function requireConfirmedMayor(
  client: pg.PoolClient,
  city: CityLockRow,
  playerId: string
): Promise<void> {
  if (city.mayor_player_id !== playerId || city.mayor_confirmed_at === null) {
    throw new CityStructureError(
      "CITY_MAYOR_PERMISSION_DENIED",
      "Only the confirmed Mayor may manage city facilities"
    );
  }
  const membership = await client.query(
    `SELECT 1
     FROM city_memberships membership
     JOIN city_structures house
       ON house.structure_id=membership.house_structure_id
      AND house.state='active' AND house.structure_type='mayor_house'
     WHERE membership.player_id=$1 AND membership.city_id=$2
       AND membership.left_at IS NULL`,
    [playerId, city.id]
  );
  if (!membership.rowCount) {
    throw new CityStructureError(
      "CITY_MAYOR_PERMISSION_DENIED",
      "Mayor authorization requires an active Mayor House"
    );
  }
}

async function reserveStructureOperation(
  client: pg.PoolClient,
  input: {
    operationKey: string;
    playerId: string;
    requestId: string;
    action: string;
    cityId: string;
    structureId: string;
    intent: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO city_structure_operations (
       operation_key,actor_player_id,request_id,action,city_id,structure_id,intent
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      input.operationKey,
      input.playerId,
      input.requestId,
      input.action,
      input.cityId,
      input.structureId,
      JSON.stringify(input.intent)
    ]
  );
}

async function replayStructureOperation(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  operationKey: string,
  playerId: string,
  action: string | readonly string[]
): Promise<unknown | null> {
  const result = await queryable.query<{
    actor_player_id: string;
    action: string;
    result: unknown | null;
    completed_at: Date | null;
  }>(
    `SELECT actor_player_id,action,result,completed_at
     FROM city_structure_operations WHERE operation_key=$1`,
    [operationKey]
  );
  const row = result.rows[0];
  if (!row) return null;
  const expected: readonly string[] = typeof action === "string" ? [action] : action;
  if (row.actor_player_id !== playerId || !expected.includes(row.action)) {
    throw new CityStructureError(
      "CITY_STRUCTURE_IDEMPOTENCY_CONFLICT",
      "City structure request ID was reused with different intent"
    );
  }
  if (!row.completed_at || !row.result) {
    throw new CityStructureError(
      "CITY_STRUCTURE_OPERATION_INCOMPLETE",
      "The prior city structure operation did not complete"
    );
  }
  return row.result;
}

async function completeStructureOperation(
  client: pg.PoolClient,
  operationKey: string,
  result: unknown
): Promise<void> {
  await client.query(
    `UPDATE city_structure_operations
     SET result=$2::jsonb,completed_at=now()
     WHERE operation_key=$1`,
    [operationKey, JSON.stringify(result)]
  );
}

async function writeStructureEvent(
  client: pg.PoolClient,
  operationKey: string,
  cityId: string,
  structureId: string,
  playerId: string,
  eventType: string,
  details: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO city_structure_events (
       operation_key,city_id,structure_id,actor_player_id,event_type,details
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [operationKey, cityId, structureId, playerId, eventType, JSON.stringify(details)]
  );
}

async function writeDistrictEvent(
  client: pg.PoolClient,
  input: Readonly<{
    cityId: string;
    actorPlayerId: string;
    structureId: string;
    operationKey: string;
    eventType:
      | "district_selected"
      | "monument_construction_started"
      | "monument_activated"
      | "monument_upgraded"
      | "monument_destroyed"
      | "district_changed";
    priorDistrict: CityDistrictType | null;
    newDistrict: CityDistrictType | null;
    priorTier: 1 | 2 | 3 | null;
    newTier: 1 | 2 | 3 | null;
    priorDistrictRevision: string;
    districtRevision: string;
    priorCityRevision: string;
    cityRevision: string;
    metadata?: Readonly<Record<string, unknown>>;
  }>
): Promise<void> {
  await client.query(
    `INSERT INTO city_district_events (
       city_id, actor_player_id, structure_id, operation_key, event_type,
       prior_district, new_district, prior_tier, new_tier,
       prior_district_revision, district_revision,
       prior_city_revision, city_revision, metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,
       $10::bigint,$11::bigint,$12::bigint,$13::bigint,$14::jsonb
     )`,
    [
      input.cityId,
      input.actorPlayerId,
      input.structureId,
      input.operationKey,
      input.eventType,
      input.priorDistrict,
      input.newDistrict,
      input.priorTier,
      input.newTier,
      input.priorDistrictRevision,
      input.districtRevision,
      input.priorCityRevision,
      input.cityRevision,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

async function recordStructureMaterialSpend(
  client: pg.PoolClient,
  input: {
    structureId: string;
    tier: CityStructureSnapshot["tier"];
    paidByPlayerId: string;
    sourceOperationKey: string;
    materials: readonly { itemId: ResourceType; quantity: number }[];
  }
): Promise<void> {
  for (const material of input.materials) {
    await client.query(
      `INSERT INTO city_structure_material_spend (
         structure_id,tier,item_id,variant,quantity,
         paid_by_player_id,source_operation_key
       ) VALUES ($1,$2,$3,'default',$4::bigint,$5,$6)`,
      [
        input.structureId,
        input.tier,
        material.itemId,
        material.quantity,
        input.paidByPlayerId,
        input.sourceOperationKey
      ]
    );
  }
}

type MaterialRefundLine = {
  itemId: ResourceType;
  variant: string;
  investedQuantity: number;
  refundQuantity: number;
};

async function structureMaterialSpendLines(
  client: pg.PoolClient,
  structureId: string,
  sourceOperationKey?: string
): Promise<MaterialRefundLine[]> {
  const result = await client.query<{
    item_id: ResourceType;
    variant: string;
    invested_quantity: string;
  }>(
    `SELECT item_id,variant,sum(quantity)::bigint::text AS invested_quantity
     FROM city_structure_material_spend
     WHERE structure_id=$1::uuid
       AND ($2::text IS NULL OR source_operation_key=$2)
     GROUP BY item_id,variant
     ORDER BY item_id,variant`,
    [structureId, sourceOperationKey ?? null]
  );
  return result.rows.map((row) => ({
    itemId: row.item_id,
    variant: row.variant,
    investedQuantity: Number(row.invested_quantity),
    refundQuantity: Number(row.invested_quantity)
  }));
}

function cityConstructionCost(
  action: CityPhysicalConstructionAction,
  structure: Pick<StructureRow, "structure_type" | "tier">
): { cityCoins: number; cityGold: number } {
  if (action === "build_house" || action === "build_oil_well" || action === "build_quartz_hut" || action === "build_library") {
    return { cityCoins: 0, cityGold: 0 };
  }
  if (action === "upgrade_facility" && structure.structure_type === "market") {
    return { cityCoins: cityMarketUpgradeCost(structure.tier)?.cityCoins ?? 0, cityGold: 0 };
  }
  if (action === "build_facility" || action === "upgrade_facility") {
    if (isActiveMilitaryStructureType(structure.structure_type)) {
      const cost = MILITARY_CITY_FACILITY_COSTS[structure.structure_type];
      return { cityCoins: cost.cityCoins, cityGold: 0 };
    }
    const type = structure.structure_type as CityFacilityType;
    const cost = CITY_FACILITY_COSTS[type]?.[structure.tier as 1 | 2 | 3];
    if (!cost) return { cityCoins: 0, cityGold: 0 };
    return { cityCoins: cost.cityCoins, cityGold: 0 };
  }
  const cost = structure.structure_type === "market"
    ? CITY_MARKET_COST
    : CITY_MONUMENT_COSTS[structure.tier as 1 | 2 | 3];
  return { cityCoins: cost.cityCoins, cityGold: cost.cityGold };
}

async function structureMaterialRefundLines(
  client: pg.PoolClient,
  structureId: string
): Promise<MaterialRefundLine[]> {
  const result = await client.query<{
    item_id: ResourceType;
    variant: string;
    invested_quantity: string;
    refund_quantity: string;
  }>(
    `SELECT item_id,variant,sum(quantity)::bigint::text AS invested_quantity,
            floor(sum(quantity)::numeric/3)::bigint::text AS refund_quantity
     FROM city_structure_material_spend
     WHERE structure_id=$1::uuid
     GROUP BY item_id,variant
     HAVING floor(sum(quantity)::numeric/3)>0
     ORDER BY item_id,variant`,
    [structureId]
  );
  return result.rows.map((row) => ({
    itemId: row.item_id,
    variant: row.variant,
    investedQuantity: Number(row.invested_quantity),
    refundQuantity: Number(row.refund_quantity)
  }));
}

async function writeStructureRefund(
  client: pg.PoolClient,
  input: {
    operationKey: string;
    structureId: string;
    line: MaterialRefundLine;
    quantity: number;
    destination: "player_inventory" | "city_warehouse" | "ground_drop";
    recipientPlayerId?: string;
  }
): Promise<void> {
  if (input.quantity <= 0) return;
  await client.query(
    `INSERT INTO city_structure_refunds (
       operation_key,structure_id,item_id,variant,invested_quantity,
       refund_quantity,destination,recipient_player_id
     ) VALUES ($1,$2,$3,$4,$5::bigint,$6::bigint,$7,$8)
     ON CONFLICT DO NOTHING`,
    [
      input.operationKey,
      input.structureId,
      input.line.itemId,
      input.line.variant,
      input.line.investedQuantity,
      input.quantity,
      input.destination,
      input.recipientPlayerId ?? null
    ]
  );
}

function refundDropLines(
  lines: readonly MaterialRefundLine[],
  quantities: ReadonlyMap<string, number>
): SystemGroundDropLine[] {
  return lines.flatMap((line) => {
    const quantity = quantities.get(`${line.itemId}\u0000${line.variant}`) ?? 0;
    return quantity > 0
      ? [{ itemId: line.itemId, variant: line.variant, quantity }]
      : [];
  });
}

function combineSystemDropLines(
  lines: readonly SystemGroundDropLine[]
): SystemGroundDropLine[] {
  const combined = new Map<string, SystemGroundDropLine>();
  for (const line of lines) {
    const variant = line.variant ?? "default";
    const key = `${line.itemId}\u0000${variant}`;
    combined.set(key, {
      itemId: line.itemId,
      variant,
      quantity: (combined.get(key)?.quantity ?? 0) + line.quantity
    });
  }
  return [...combined.values()];
}

const STRUCTURE_SELECT = `
  SELECT structure_id::text,city_id::text,structure_type,tier,district_type,owner_player_id,
         (SELECT controller_kind FROM cities WHERE id=city_structures.city_id) AS city_controller_kind,
         (SELECT culture FROM cities WHERE id=city_structures.city_id) AS city_culture,
         (SELECT username FROM players WHERE id=city_structures.owner_player_id) AS owner_username,
         world_id,region_code,lat,lon,footprint_radius_m,
         placement_revision::text,state,construction_started_at,
         construction_completes_at,built_at,upgraded_at,destroyed_at,
         build_operation_key
         ,harvest_access_mode,harvest_access_revision::text
         ,health,health_at,burning_since,repair_player_id
  FROM city_structures`;

const QUALIFIED_STRUCTURE_SELECT = `
  SELECT structure.structure_id::text,structure.city_id::text,
         structure.structure_type,structure.tier,structure.district_type,
         structure.owner_player_id,
         (SELECT controller_kind FROM cities WHERE id=structure.city_id) AS city_controller_kind,
         (SELECT culture FROM cities WHERE id=structure.city_id) AS city_culture,
         (SELECT username FROM players WHERE id=structure.owner_player_id) AS owner_username,
         structure.world_id,structure.region_code,
         structure.lat,structure.lon,structure.footprint_radius_m,
         structure.placement_revision::text,structure.state,
         structure.construction_started_at,structure.construction_completes_at,
         structure.built_at,structure.upgraded_at,structure.destroyed_at,
         structure.build_operation_key
         ,structure.harvest_access_mode,structure.harvest_access_revision::text
         ,structure.health,structure.health_at,structure.burning_since,structure.repair_player_id
  FROM city_structures structure`;

const STRUCTURE_RETURNING_FIELDS = `
  structure_id::text,city_id::text,structure_type,tier,district_type,owner_player_id,
  world_id,region_code,lat,lon,footprint_radius_m,
  placement_revision::text,state,construction_started_at,
  construction_completes_at,built_at,upgraded_at,destroyed_at,
  build_operation_key,harvest_access_mode,harvest_access_revision::text,
  health,health_at,burning_since,repair_player_id`;

function rowToStructure(row: StructureRow): CityStructureSnapshot {
  return {
    structureId: row.structure_id,
    cityId: row.city_id,
    cityControllerKind: row.city_controller_kind ?? "player",
    cityCulture: row.city_culture ?? "human",
    type: row.structure_type,
    tier: row.tier,
    districtType: row.district_type,
    ownerPlayerId: row.owner_player_id,
    ownerUsername: row.owner_username ?? null,
    worldId: row.world_id,
    regionCode: row.region_code,
    lat: Number(row.lat),
    lon: Number(row.lon),
    footprintRadiusM: Number(row.footprint_radius_m),
    placementRevision: String(row.placement_revision),
    state: row.state,
    constructionStartedAt: row.construction_started_at
      ? new Date(row.construction_started_at).toISOString()
      : null,
    constructionCompletesAt: row.construction_completes_at
      ? new Date(row.construction_completes_at).toISOString()
      : null,
    builtAt: row.built_at ? new Date(row.built_at).toISOString() : null,
    upgradedAt: row.upgraded_at ? new Date(row.upgraded_at).toISOString() : null,
    destroyedAt: row.destroyed_at ? new Date(row.destroyed_at).toISOString() : null,
    harvestAccessMode: row.harvest_access_mode ?? (row.structure_type === "oil_well" ? "private" : null),
    harvestAccessRevision: String(row.harvest_access_revision ?? 0),
    warfare: cityBuildingWarfareSnapshot(row)
  };
}

function cityBuildingWarfareSnapshot(row: StructureRow): CityBuildingWarfareSnapshot | null {
  const profile = cityBuildingWarfareProfile(row.structure_type);
  if (!profile || row.city_controller_kind === "npc" || row.state !== "active") return null;
  return {
    maximumHealth: profile.maximumHealth,
    burnThreshold: profile.burnThreshold,
    burnDurationMs: profile.burnDurationMs,
    bombable: profile.bombable,
    health: row.health === null || row.health === undefined ? profile.maximumHealth : Number(row.health),
    healthAt: row.health_at ? new Date(row.health_at).toISOString() : null,
    burning: Boolean(row.burning_since),
    repairing: Boolean(row.repair_player_id),
    repairPlayerId: row.repair_player_id ?? null
  };
}

function assertPosition(position: Position): void {
  if (
    !Number.isFinite(position.lat) ||
    !Number.isFinite(position.lon) ||
    position.lat < -90 ||
    position.lat > 90 ||
    position.lon < -180 ||
    position.lon > 180
  ) {
    throw new CityStructureError("INVALID_POSITION", "Authoritative world position is invalid");
  }
}

function requireNearStructure(row: StructureRow, position: Position): void {
  if (distanceMeters(position, { lat: Number(row.lat), lon: Number(row.lon) }) >
      CITY_STRUCTURE_INTERACTION_RADIUS_M) {
    throw new CityStructureError(
      "CITY_FACILITY_PROXIMITY_REQUIRED",
      `Stand within ${CITY_STRUCTURE_INTERACTION_RADIUS_M} meters of the facility`
    );
  }
}

function isMilitaryFacilityType(type: CityFacilityBuildType): type is MilitaryFacilityType {
  return MILITARY_FACILITY_TYPES.includes(type as MilitaryFacilityType);
}

function isActiveMilitaryStructureType(
  type: CityStructureType
): type is MilitaryFacilityType {
  return MILITARY_FACILITY_TYPES.includes(type as MilitaryFacilityType);
}

function distanceMeters(left: Position, right: Position): number {
  const radians = Math.PI / 180;
  const lat1 = left.lat * radians;
  const lat2 = right.lat * radians;
  const dLat = (right.lat - left.lat) * radians;
  const dLon = (right.lon - left.lon) * radians;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function translateStructureConstraint(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("code" in error)) return error;
  const constraint = "constraint" in error ? String((error as { constraint?: unknown }).constraint) : "";
  if ((error as { code?: unknown }).code === "23505") {
    if (
      constraint.includes("one_active_house_per_player") ||
      constraint.includes("one_reserved_house_per_player")
    ) {
      return new CityStructureError(
        "CITY_HOUSE_ALREADY_EXISTS",
        "You already have an active or constructing City House"
      );
    }
    if (constraint.includes("one_reserved_quartz_hut_per_player")) {
      return new CityStructureError(
        "QUARTZ_HUT_ALREADY_EXISTS",
        "You already own an active or constructing Quartz Hut."
      );
    }
    if (constraint.includes("one_reserved_oil_well_per_player")) {
      return new CityStructureError(
        "OIL_WELL_ALREADY_EXISTS",
        "You already own an active or constructing Oil Well."
      );
    }
    if (
      constraint.includes("one_active_facility_type") ||
      constraint.includes("one_reserved_facility_type") ||
      constraint.includes("one_reserved_personal_military_type") ||
      constraint.includes("one_reserved_salon_per_city") ||
      constraint.includes("one_reserved_city_kennel_per_city")
    ) {
      return new CityStructureError(
        "CITY_FACILITY_ALREADY_EXISTS",
        "This city already has that facility active or under construction"
      );
    }
    if (constraint.includes("one_reserved_monument")) {
      return new CityStructureError(
        "CITY_MONUMENT_ALREADY_EXISTS",
        "This city already has that Monument active or under construction"
      );
    }
    if (
      constraint.includes("one_active_mayor_house") ||
      constraint.includes("one_reserved_mayor_house")
    ) {
      return new CityStructureError(
        "CITY_MAYOR_ALREADY_CLAIMED",
        "This city already has a Mayor House active or under construction"
      );
    }
    if (constraint.includes("one_active_mayoralty_per_player")) {
      return new CityStructureError(
        "CITY_MAYOR_ALREADY_SERVING",
        "Relinquish your current Mayor office before claiming another city."
      );
    }
  }
  return error;
}

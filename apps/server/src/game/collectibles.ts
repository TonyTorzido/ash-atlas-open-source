import {
  COLLECTIBLE_PICKUP_RADIUS_M,
  COLLECTIBLE_VISIBILITY_RADIUS_M as SHARED_COLLECTIBLE_VISIBILITY_RADIUS_M,
  FLAG_VISIT_VISIBLE_PREPARATION_RADIUS_M as SHARED_FLAG_VISIT_VISIBLE_PREPARATION_RADIUS_M,
  MAX_VISIBLE_COLLECTIBLE_NODES,
  MOVE_LEASH_TO_VISION_GAP_M as SHARED_MOVE_LEASH_TO_VISION_GAP_M,
  RESOURCE_PREPARATION_RADIUS_M as SHARED_RESOURCE_PREPARATION_RADIUS_M,
  RESOURCE_LAYOUT_VERSION,
  SPAWN_CELL_SIZE_M as SHARED_SPAWN_CELL_SIZE_M,
  BALSAM_RESIN_ITEM_ID,
  GIVING_BERRY_ITEM_ID,
  GIVING_TREE_WOOD_YIELD,
  ELDER_FROND_SAP_REFILL_MS,
  PLAYER_SAPLING_TREE_ID_PREFIX,
  treeVarietyForStableId,
  distanceMeters,
  isActiveResourceType,
  isGivingTreeResinCapable,
  isElderFern,
  resourceVisionRadiusForLeash,
  treeWoodYieldForStableId,
  type CollectibleNode,
  type DroppedItemSnapshot,
  type LatLon,
  type PlayerInventorySnapshot,
  type ResourceVision,
  type ResourceVisionGenerationStatus,
  type ResourceVisionStatus,
  type ResourceType,
  type WaterSourceHighlight,
  type WaterKind
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";
import { settlePhysicalItemRewardInTransaction } from "./droppedItems.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";
import { InventoryService } from "./inventory.js";
import { kingdomBrickYieldAt } from "./kingdomBrickYield.js";
import { collectibleReward } from "./items.js";
import type { DeveloperSpawnedPlant } from "./developerSpawnedPlants.js";
import {
  DEVELOPER_PLANT_ENTITY_PREFIX,
  type DeveloperSpawnedPlantService
} from "./developerSpawnedPlants.js";
import type { PlayerRecord } from "./state.js";
import type { PopulationZoneV2Id } from "./populationZonesV2Geometry.js";

export const SPAWN_CELL_SIZE_M = SHARED_SPAWN_CELL_SIZE_M;
export const RESOURCE_PREPARATION_RADIUS_M = SHARED_RESOURCE_PREPARATION_RADIUS_M;
export const FLAG_VISIT_VISIBLE_PREPARATION_RADIUS_M =
  SHARED_FLAG_VISIT_VISIBLE_PREPARATION_RADIUS_M;
export const MOVE_LEASH_TO_VISION_GAP_M = SHARED_MOVE_LEASH_TO_VISION_GAP_M;
export const COLLECTIBLE_VISIBILITY_RADIUS_M = SHARED_COLLECTIBLE_VISIBILITY_RADIUS_M;
export const PICKUP_RADIUS_M = COLLECTIBLE_PICKUP_RADIUS_M;
export const WATER_INTERACTION_RADIUS_M = 50;
export { MAX_VISIBLE_COLLECTIBLE_NODES };

const GRID_REFERENCE_LAT = 34.5;
const METERS_PER_DEGREE_LAT = 111_320;
const METERS_PER_DEGREE_LON =
  METERS_PER_DEGREE_LAT * Math.cos((GRID_REFERENCE_LAT * Math.PI) / 180);

export type CollectiblePlayer = {
  playerId: string;
  regionCode: string;
  position: LatLon;
};

type CollectibleWaterEnvironment = {
  ok: boolean;
  packageId: string | null;
  elevationM: number | null;
  terrainClass: string | null;
  landCoverClass?: string | null;
  biome: string | null;
  ecoregion: string | null;
  isLand: boolean | null;
  isSaltwater: boolean | null;
  insideMajorLake: boolean;
  nearMajorRiver: boolean;
  majorRiverDistanceM: number | null;
  majorLakeDistanceM: number | null;
  warning: string | null;
  raw: unknown;
};

type CollectibleNodeRow = {
  id: string;
  cell_id: string;
  resource_type: string;
  quantity: number;
  lat: number;
  lon: number;
  state: string;
  created_at: Date | string;
  harvested_at: Date | string | null;
  harvested_by_player_id?: string | null;
  population_v2_entity_id: string | null;
  population_v2_state_revision: number | string;
  developer_spawned_plant_id?: string | null;
  population_v2_suppressed?: boolean;
  population_v2_current_authority?: boolean;
  resin_harvested_life_revision?: number | string | null;
  sap_harvested_at?: Date | string | null;
};

const CURRENT_POPULATION_TREE_AUTHORITY_SQL = `
  EXISTS (
    SELECT 1
    FROM population_spawn_slots_v2 AS authority_slot
    JOIN population_zone_generations_v2 AS authority_generation
      ON authority_generation.generation_id=authority_slot.generation_id
     AND authority_generation.plan_id=authority_slot.plan_id
    JOIN population_zones_v2 AS authority_plan
      ON authority_plan.plan_id=authority_slot.plan_id
    JOIN population_zone_cutovers_v2 AS authority_cutover
      ON authority_cutover.zone_id=authority_plan.zone_id
     AND authority_cutover.geometry_version=authority_plan.geometry_version
    JOIN population_entity_state_v2 AS authority_state
      ON authority_state.entity_id=authority_slot.entity_id
    WHERE authority_slot.entity_id=tree.population_v2_entity_id
      AND authority_slot.plan_id=tree.population_v2_plan_id
      AND authority_slot.entity_kind IN ('tree','flax')
      AND authority_generation.zone_id=authority_plan.zone_id
      AND authority_generation.is_current
      AND authority_generation.status='active'
      AND authority_generation.expires_at > statement_timestamp()
      AND authority_plan.zone_id=tree.physical_population_zone_v2_id
      AND authority_plan.status='ready'
      AND authority_cutover.selected_plan_id=authority_plan.plan_id
      AND authority_cutover.serving_version='v2'
      AND authority_cutover.status='stable'
      AND authority_cutover.cutover_revision=tree.population_cutover_revision
      AND authority_state.state_revision=tree.population_v2_state_revision
      AND (
        (
          authority_state.state='ready'
          AND tree.state='available'
          AND tree.harvested_at IS NULL
          AND tree.harvested_by_player_id IS NULL
        )
        OR
        (
          authority_state.state='harvested'
          AND tree.state='harvested'
          AND tree.harvested_at=authority_state.killed_or_harvested_at
          AND tree.harvested_by_player_id
            IS NOT DISTINCT FROM authority_state.state_actor_player_id
        )
      )
  )
`;

export type CollectibleHarvestErrorCode =
  | "HARVEST_NODE_NOT_FOUND"
  | "HARVEST_NODE_ALREADY_HARVESTED"
  | "HARVEST_NODE_SUPPRESSED"
  | "HARVEST_OUTSIDE_RESOURCE_VISION"
  | "HARVEST_TOO_FAR"
  | "HARVEST_POPULATION_LIFE_CHANGED"
  | "HARVEST_RESIN_UNAVAILABLE"
  | "HARVEST_RESIN_ALREADY_HARVESTED";

export class CollectibleHarvestError extends Error {
  constructor(
    readonly code: CollectibleHarvestErrorCode,
    message: string,
    readonly details: Readonly<{
      nodeId?: string;
      authoritativeDistanceM?: number;
      maximumDistanceM?: number;
      stateRevision?: number;
      nodePosition?: LatLon;
      reconciliation?: "remove-node" | "refresh-node";
      populationTreeTransition?: HarvestedPopulationTreeTransition;
    }> = {}
  ) {
    super(message);
    this.name = "CollectibleHarvestError";
  }
}

export type CollectibleTransaction = Pick<pg.PoolClient, "query">;

export type HarvestedPopulationTreeTransition = Readonly<{
  entityId: string;
  entityKind: "tree";
  stateRevision: number;
  position: LatLon;
  zoneId: PopulationZoneV2Id;
  generationId: string;
  cutoverRevision: number;
}>;

export type HarvestableCollectibleNode = CollectibleNode & Readonly<{
  harvestOperationKey: string;
  stateRevision: number;
}>;

type SpawnCountsRow = {
  spawn_cell_count: string;
  available_node_count: string;
  harvested_node_count: string;
};

type ResourceVisionStatusRow = {
  flag_id: string;
  layout_version: string;
  status: ResourceVisionGenerationStatus;
  radius_m: number;
  node_count: number;
  water_highlight_count: number;
  requested_at: Date | string;
  generated_at: Date | string | null;
  last_error: string | null;
  updated_at: Date | string;
};

type ResourceVisionStatusCountRow = {
  status: ResourceVisionGenerationStatus;
  count: string;
};

export type PreparedCollectibleVision = {
  resourceVision: ResourceVision;
  layoutVersion: typeof RESOURCE_LAYOUT_VERSION;
  waterHighlights: WaterSourceHighlight[];
  preparedAt: number;
  timings: PreparationStageTimings;
  commitTimings: CommitStageTimings | null;
};

export type SpawnCellKey = {
  id: string;
  regionCode: string;
  cellX: number;
  cellY: number;
  center: LatLon;
};

export type PreparationStageTimings = {
  waterHighlightMs: number;
  totalMs: number;
};

export type CommitStageTimings = {
  statusUpdateMs: number;
  totalMs: number;
  databaseStatementCount: number;
};

type WaterCollectionResult = {
  waterKind: WaterKind;
  inventory: PlayerInventorySnapshot;
  message: string;
  replayed: boolean;
};

type WaterCollectionOperationRow = {
  operation_key: string;
  player_id: string;
  request_id: string;
  source_entity_id: string;
  water_kind: WaterKind;
  result_message: string;
};

export class WaterCollectionCadenceError extends Error {
  readonly code = "WATER_COLLECTION_CADENCE";

  constructor(readonly retryAfterMs: number) {
    super(`Water collection is available again in ${retryAfterMs}ms`);
    this.name = "WaterCollectionCadenceError";
  }
}

export class CollectibleService {
  private readonly inventory: InventoryService;

  constructor(
    private readonly pool: pg.Pool,
    private readonly worldLookup: WorldLookupClient,
    private readonly config: AppConfig,
    private readonly logger: Pick<AppLogger, "warn" | "info">,
    private readonly developerPlants?: DeveloperSpawnedPlantService
  ) {
    this.inventory = new InventoryService(pool);
  }

  /** Prepares the non-population Resource Vision data without publishing status. */
  async prepareResourceVision(input: {
    resourceVision: ResourceVision;
    signal?: AbortSignal | undefined;
  }): Promise<PreparedCollectibleVision> {
    const totalStarted = performance.now();
    throwIfPreparationAborted(input.signal);
    const waterStarted = performance.now();
    const waterHighlights = await this.waterHighlightsForVision(
      input.resourceVision,
      input.signal
    );
    throwIfPreparationAborted(input.signal);
    return {
      resourceVision: input.resourceVision,
      layoutVersion: RESOURCE_LAYOUT_VERSION,
      waterHighlights,
      preparedAt: Date.now(),
      commitTimings: null,
      timings: {
        waterHighlightMs: performance.now() - waterStarted,
        totalMs: performance.now() - totalStarted
      }
    };
  }

  /** Publishes a previously prepared non-population Resource Vision status. */
  async commitResourceVision(
    plan: PreparedCollectibleVision,
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<ResourceVisionStatus> {
    const totalStarted = performance.now();
    throwIfPreparationAborted(options.signal);
    const client = await this.pool.connect();
    try {
      throwIfPreparationAborted(options.signal);
      await client.query("BEGIN");
      const statusStarted = performance.now();
      const status = await this.upsertResourceVisionStatus({
        resourceVision: plan.resourceVision,
        status: "ready",
        nodeCount: 0,
        waterHighlightCount: plan.waterHighlights.length,
        generated: true,
        lastError: null
      }, client);
      throwIfPreparationAborted(options.signal);
      await client.query("COMMIT");
      plan.commitTimings = {
        statusUpdateMs: performance.now() - statusStarted,
        totalMs: performance.now() - totalStarted,
        databaseStatementCount: 1
      };
      this.logger.info({
        flagId: plan.resourceVision.flagId,
        latitude: plan.resourceVision.center.lat,
        absoluteLatitudeBucket: Math.floor(Math.abs(plan.resourceVision.center.lat) / 15) * 15,
        resourceLayoutVersion: plan.layoutVersion,
        preparationStages: plan.timings,
        commitStages: plan.commitTimings
      }, "resource vision status committed");
      return status;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAvailableNear(player: CollectiblePlayer): Promise<CollectibleNode[]> {
    const result = await this.pool.query<CollectibleNodeRow>(
      `
      SELECT id, cell_id, resource_type, quantity, lat, lon, state, created_at, harvested_at,
             population_v2_entity_id, population_v2_state_revision,
             resin_harvested_life_revision, sap_harvested_at,
             ST_Distance(
               geom::geography,
               ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
             ) AS distance_m
      FROM collectible_nodes AS tree
      WHERE region_code = $3
        AND state = 'available'
        AND population_v2_entity_id IS NOT NULL
        AND NOT population_v2_suppressed
        AND resource_type <> 'stone'
        AND resource_type NOT IN ('food', 'water')
        AND ${CURRENT_POPULATION_TREE_AUTHORITY_SQL}
        AND ST_DWithin(
          geom::geography,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          $4
        )
      ORDER BY distance_m ASC, id ASC
      LIMIT $5
      `,
      [
        player.position.lat,
        player.position.lon,
        player.regionCode,
        COLLECTIBLE_VISIBILITY_RADIUS_M,
        MAX_VISIBLE_COLLECTIBLE_NODES
      ]
    );
    const nodes = result.rows.map(rowToCollectibleNode);
    if (!this.developerPlants) return nodes;
    const developerPlants = await this.developerPlants.listAvailableInVision({
      center: player.position,
      radiusM: COLLECTIBLE_VISIBILITY_RADIUS_M,
      regionCode: player.regionCode
    });
    return [...nodes, ...developerPlants.map(developerPlantToCollectibleNode)]
      .sort((left, right) =>
        distanceMeters(player.position, left) - distanceMeters(player.position, right) ||
        left.id.localeCompare(right.id)
      )
      .slice(0, MAX_VISIBLE_COLLECTIBLE_NODES);
  }

  async listAvailableInVision(
    _regionCode: string,
    resourceVision: ResourceVision | null
  ): Promise<CollectibleNode[]> {
    if (!resourceVision) {
      return [];
    }
    const result = await this.pool.query<CollectibleNodeRow>(
      `
      SELECT id, cell_id, resource_type, quantity, lat, lon, state, created_at, harvested_at,
             population_v2_entity_id, population_v2_state_revision,
             resin_harvested_life_revision, sap_harvested_at,
             ST_Distance(
               geom::geography,
               ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
             ) AS distance_m
      FROM collectible_nodes AS tree
       WHERE state = 'available'
        AND population_v2_entity_id IS NOT NULL
        AND NOT population_v2_suppressed
        AND resource_type <> 'stone'
        AND resource_type NOT IN ('food', 'water')
        AND ${CURRENT_POPULATION_TREE_AUTHORITY_SQL}
        AND ST_DWithin(
          geom::geography,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           $3
         )
       ORDER BY distance_m ASC, id ASC
       LIMIT $4
      `,
      [
        resourceVision.center.lat,
        resourceVision.center.lon,
        resourceVision.radiusM,
        MAX_VISIBLE_COLLECTIBLE_NODES
      ]
    );
    const nodes = result.rows.map(rowToCollectibleNode);
    if (!this.developerPlants) return nodes;
    const developerPlants = await this.developerPlants.listAvailableInVision({
      center: resourceVision.center,
      radiusM: resourceVision.radiusM,
      regionCode: _regionCode
    });
    return [...nodes, ...developerPlants.map(developerPlantToCollectibleNode)]
      .sort((left, right) =>
        distanceMeters(resourceVision.center, left) -
          distanceMeters(resourceVision.center, right) ||
        left.id.localeCompare(right.id)
      )
      .slice(0, MAX_VISIBLE_COLLECTIBLE_NODES);
  }

  async waterHighlightsForVision(
    resourceVision: ResourceVision | null,
    signal?: AbortSignal
  ): Promise<WaterSourceHighlight[]> {
    if (!resourceVision) {
      return [];
    }
    return this.worldLookup.collectibleWaterSourcesNear(
      resourceVision.center,
      resourceVision.radiusM,
      { signal }
    );
  }

  async countSpawns(): Promise<{
    spawnCellCount: number;
    availableNodeCount: number;
    harvestedNodeCount: number;
    resourceVisionStatusCounts: Record<ResourceVisionGenerationStatus, number>;
  }> {
    const result = await this.pool.query<SpawnCountsRow>(
      `
      SELECT
        (SELECT count(*) FROM spawn_cells) AS spawn_cell_count,
        (
          SELECT count(*) FROM collectible_nodes
          WHERE state = 'available' AND population_v2_entity_id IS NOT NULL
        ) AS available_node_count,
        (
          SELECT count(*) FROM collectible_nodes
          WHERE state = 'harvested' AND population_v2_entity_id IS NOT NULL
        ) AS harvested_node_count
      `
    );
    const statusResult = await this.pool.query<ResourceVisionStatusCountRow>(
      `
      SELECT status, count(*) AS count
      FROM flag_resource_visions
      GROUP BY status
      `
    );
    const row = result.rows[0];
    const resourceVisionStatusCounts = emptyResourceVisionStatusCounts();
    for (const statusRow of statusResult.rows) {
      resourceVisionStatusCounts[statusRow.status] = Number(statusRow.count);
    }
    return {
      spawnCellCount: Number(row?.spawn_cell_count ?? 0),
      availableNodeCount: Number(row?.available_node_count ?? 0),
      harvestedNodeCount: Number(row?.harvested_node_count ?? 0),
      resourceVisionStatusCounts
    };
  }

  async resourceVisionStatus(flagId: string): Promise<ResourceVisionStatus | null> {
    const result = await this.pool.query<ResourceVisionStatusRow>(
      `
      SELECT flag_id, layout_version, status, radius_m, node_count, water_highlight_count,
             requested_at, generated_at, last_error, updated_at
      FROM flag_resource_visions
      WHERE flag_id = $1
      `,
      [flagId]
    );
    const row = result.rows[0];
    return row ? rowToResourceVisionStatus(row) : null;
  }

  async markResourceVisionPending(
    resourceVision: ResourceVision
  ): Promise<ResourceVisionStatus> {
    return this.upsertResourceVisionStatus({
      resourceVision,
      status: "pending",
      nodeCount: 0,
      waterHighlightCount: 0,
      generated: false,
      lastError: null
    });
  }

  async markResourceVisionGenerating(
    resourceVision: ResourceVision
  ): Promise<ResourceVisionStatus> {
    return this.upsertResourceVisionStatus({
      resourceVision,
      status: "generating",
      nodeCount: 0,
      waterHighlightCount: 0,
      generated: false,
      lastError: null
    });
  }

  async markResourceVisionReady(
    resourceVision: ResourceVision,
    nodeCount: number,
    waterHighlightCount: number
  ): Promise<ResourceVisionStatus> {
    return this.upsertResourceVisionStatus({
      resourceVision,
      status: "ready",
      nodeCount,
      waterHighlightCount,
      generated: true,
      lastError: null
    });
  }

  async markResourceVisionFailed(
    resourceVision: ResourceVision,
    error: unknown
  ): Promise<ResourceVisionStatus> {
    return this.upsertResourceVisionStatus({
      resourceVision,
      status: "failed",
      nodeCount: 0,
      waterHighlightCount: 0,
      generated: false,
      lastError: error instanceof Error ? error.message : String(error)
    });
  }

  async pickupNode(
    player: CollectiblePlayer,
    nodeId: string,
    resourceVision: ResourceVision | null
  ): Promise<{
    node: CollectibleNode;
    inventory: PlayerInventorySnapshot;
    replayed: boolean;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<CollectibleNodeRow>(
        `
        SELECT id, cell_id, resource_type, quantity, lat, lon, state, created_at, harvested_at,
               harvested_by_player_id, population_v2_entity_id, population_v2_state_revision
        FROM collectible_nodes AS tree
        WHERE id = $1
          AND population_v2_entity_id IS NOT NULL
          AND NOT population_v2_suppressed
          AND ${CURRENT_POPULATION_TREE_AUTHORITY_SQL}
        FOR UPDATE OF tree
        `,
        [nodeId]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Collectible does not exist");
      }
      if (row.resource_type === "stone") {
        throw new Error("Loose stone is no longer harvestable; use a permanent stone mine");
      }
      const operationKey = collectibleOperationKeyForRow(row, player.playerId);
      const reward = collectibleReward(
        row.resource_type as ResourceType,
        row.resource_type === "wood"
          ? treeWoodYieldForStableId(row.id)
          : Number(row.quantity)
      );
      const inventoryOperation = {
        operationKey,
        playerId: player.playerId,
        source: "collectible-harvest",
        sourceEntityType: "collectible_node",
        sourceEntityId: row.id,
        metadata: {
          resourceType: row.resource_type,
          nodeQuantity: row.quantity
        },
        grants: [reward]
      };
      if (row.state !== "available") {
        if (row.harvested_by_player_id === player.playerId) {
          const replay = await this.inventory.replayCompletedOperationInTransaction(
            client,
            inventoryOperation
          );
          if (replay) {
            await client.query("COMMIT");
            return {
              node: rowToCollectibleNode(row),
              inventory: replay.inventory,
              replayed: true
            };
          }
        }
        throw new Error("Collectible has already been harvested");
      }
      if (!isActiveResourceType(row.resource_type as ResourceType)) {
        throw new Error("That resource is not currently available in gameplay");
      }
      if (!resourceVision) {
        throw new Error("Visit a flag to survey resources");
      }
      const distanceM = distanceMeters(player.position, {
        lat: Number(row.lat),
        lon: Number(row.lon)
      });
      const visionDistanceM = distanceMeters(resourceVision.center, {
        lat: Number(row.lat),
        lon: Number(row.lon)
      });
      if (visionDistanceM > resourceVision.radiusM) {
        throw new Error("Collectible is outside the active resource vision");
      }
      if (distanceM > PICKUP_RADIUS_M) {
        throw new Error(`Collectible is too far away (${Math.round(distanceM)}m)`);
      }

      const updatedRow = await this.harvestNodeStateInTransaction(
        client,
        row,
        player.playerId,
        new Date()
      );

      const grant = await this.inventory.grantItemsForOperationInTransaction(
        client,
        inventoryOperation
      );
      if (!grant.applied) {
        throw new Error("Collectible inventory operation was already completed");
      }
      await client.query("COMMIT");
      return {
        node: rowToCollectibleNode(updatedRow),
        inventory: grant.inventory,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async collectWaterAt(
    player: CollectiblePlayer,
    target: LatLon,
    requestId: string = crypto.randomUUID()
  ): Promise<WaterCollectionResult> {
    const operationKey = waterCollectionOperationKey(requestId, player.playerId);
    const sourceEntityId = waterCollectionSourceEntityId(target);
    const completed = await this.replayWaterCollection(
      this.pool,
      operationKey,
      player.playerId,
      requestId,
      sourceEntityId
    );
    if (completed) return completed;
    throw new Error("Water collection is not currently available");
  }

  private async replayWaterCollection(
    queryable: CollectibleTransaction,
    operationKey: string,
    playerId: string,
    requestId: string,
    sourceEntityId: string
  ): Promise<WaterCollectionResult | null> {
    const completed = await queryable.query<WaterCollectionOperationRow>(
      `
      SELECT operation_key, player_id, request_id, source_entity_id, water_kind, result_message
      FROM water_collection_operations
      WHERE operation_key = $1
      `,
      [operationKey]
    );
    const row = completed.rows[0];
    if (!row) return null;
    if (
      row.player_id !== playerId ||
      row.request_id !== requestId ||
      row.source_entity_id !== sourceEntityId
    ) {
      throw new Error("Water request id was already used with different input");
    }
    return {
      waterKind: row.water_kind,
      inventory: await this.inventory.snapshotInTransaction(queryable, playerId),
      message: row.result_message,
      replayed: true
    };
  }

  async validateHarvestStartInTransaction(
    queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string,
    resourceVision: ResourceVision | null,
    expectedStateRevision?: number
  ): Promise<HarvestableCollectibleNode> {
    const row = await this.lockHarvestableNode(
      queryable,
      player,
      nodeId,
      resourceVision,
      expectedStateRevision
    );
    if (!isActiveResourceType(row.resource_type as ResourceType)) {
      throw new Error("That resource is not currently available in gameplay");
    }
    collectibleReward(
      row.resource_type as ResourceType,
      row.resource_type === "wood"
        ? treeWoodYieldForStableId(row.id)
        : Number(row.quantity)
    );
    return {
      ...rowToCollectibleNode(row),
      stateRevision: Number(row.population_v2_state_revision),
      harvestOperationKey: collectibleOperationKeyForRow(row, player.playerId)
    };
  }

  async validateResinHarvestStartInTransaction(
    queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string,
    resourceVision: ResourceVision | null,
    expectedStateRevision?: number
  ): Promise<HarvestableCollectibleNode> {
    const row = await this.lockHarvestableNode(
      queryable,
      player,
      nodeId,
      resourceVision,
      expectedStateRevision
    );
    if (isElderFern(row.id)) {
      const lastTapMs = await lastSapTapMs(queryable, row);
      assertSapAvailable(row, Date.now(), lastTapMs);
      return {
        ...rowToCollectibleNode(row),
        stateRevision: Number(row.population_v2_state_revision),
        type: BALSAM_RESIN_ITEM_ID,
        quantity: 1,
        harvestOperationKey: sapHarvestOperationKey(row, lastTapMs)
      };
    }
    assertResinAvailable(row);
    return {
      ...rowToCollectibleNode(row),
      stateRevision: Number(row.population_v2_state_revision),
      type: GIVING_BERRY_ITEM_ID,
      quantity: 1,
      harvestOperationKey: resinHarvestOperationKey(row)
    };
  }

  async completeHarvestInTransaction(
    queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string,
    resourceVision: ResourceVision | null,
    bonusQuantity = 0,
    operationKey?: string
  ): Promise<{
    node: CollectibleNode;
    inventory: PlayerInventorySnapshot;
    rewardQuantity?: number;
    droppedItems: DroppedItemSnapshot[];
    populationTreeTransition: HarvestedPopulationTreeTransition | null;
  }> {
    const row = await this.lockHarvestableNode(queryable, player, nodeId, resourceVision);
    const authoritativeOperationKey = collectibleOperationKeyForRow(
      row,
      player.playerId
    );
    if (operationKey !== undefined && operationKey !== authoritativeOperationKey) {
      throw new CollectibleHarvestError(
        "HARVEST_POPULATION_LIFE_CHANGED",
        "This resource changed before gathering completed.",
        {
          nodeId,
          stateRevision: Number(row.population_v2_state_revision),
          nodePosition: { lat: Number(row.lat), lon: Number(row.lon) },
          reconciliation: "remove-node"
        }
      );
    }
    const reward = collectibleReward(
      row.resource_type as ResourceType,
      (
        row.resource_type === "wood"
          ? treeWoodYieldForStableId(row.id)
          : Number(row.quantity)
      ) + Math.max(0, Math.trunc(bonusQuantity))
    );
    const updatedRow = await this.harvestNodeStateInTransaction(
      queryable,
      row,
      player.playerId,
      new Date()
    );
    const populationTreeTransition = row.resource_type === "wood" && !isPlayerTreeNodeId(row.id)
      ? await this.harvestedPopulationTreeTransitionInTransaction(
          queryable,
          row.id
        )
      : null;

    const position = { lat: Number(row.lat), lon: Number(row.lon) };
    const rewardOperationKey = operationKey ?? authoritativeOperationKey;
    const settlement = await settlePhysicalItemRewardInTransaction(
      queryable,
      this.inventory,
      {
        delivery: "inventory_then_ground",
        lines: [reward],
        inventoryOperation: {
          operationKey: rewardOperationKey,
          playerId: player.playerId,
          source: "collectible-harvest",
          sourceEntityType: "collectible_node",
          sourceEntityId: row.id,
          metadata: {
            resourceType: row.resource_type,
            nodeQuantity: row.quantity
          }
        },
        groundDrop: {
          operationKey: `harvest-overflow:${rewardOperationKey}`,
          droppedByPlayerId: player.playerId,
          regionCode: packageIdForPosition(position),
          zoneId: zoneIdForPosition(position),
          pileId: `harvest:${rewardOperationKey}`,
          sourceEntityType: "collectible_node",
          sourceEntityId: row.id,
          position,
          reason: "harvest_inventory_overflow"
        }
      }
    );
    const grant = settlement.inventoryGrant;
    if (!grant) throw new Error("Collectible reward did not create an inventory operation");
    if (!grant.applied) {
      throw new Error("Collectible inventory operation was already completed");
    }
    return {
      node: rowToCollectibleNode(updatedRow),
      inventory: grant.inventory,
      rewardQuantity: reward.quantity,
      droppedItems: settlement.droppedItems,
      populationTreeTransition
    };
  }

  /**
   * Bricks from gathering on kingdom land (obelisk-multiplied), idempotent
   * per harvest operation. Overflow is dropped. Returns the updated
   * inventory when Bricks were granted.
   */
  async grantKingdomBricksInTransaction(
    queryable: CollectibleTransaction,
    playerId: string,
    position: Readonly<{ lat: number; lon: number }>,
    harvestOperationKey: string
  ): Promise<PlayerInventorySnapshot | null> {
    const brickYield = await kingdomBrickYieldAt(queryable, {
      playerId,
      position,
      rollKey: `harvest:${harvestOperationKey}`
    });
    if (!brickYield) return null;
    const grant = await this.inventory.grantItemsForOperationInTransaction(queryable, {
      operationKey: `kingdom-bricks:${harvestOperationKey}`,
      playerId,
      source: "kingdom_brick_yield",
      sourceEntityType: "harvest",
      sourceEntityId: harvestOperationKey,
      metadata: { kingdomId: brickYield.kingdomId, obeliskLevel: brickYield.obeliskLevel, member: brickYield.member },
      allowPartial: true,
      grants: [{ itemId: "bricks", variant: null, quantity: brickYield.quantity }]
    });
    return grant.inventory;
  }

  /** Deepstone Lore rare find: one extra material, idempotent per harvest operation. Overflow is dropped. */
  async grantRareFindInTransaction(
    queryable: CollectibleTransaction,
    playerId: string,
    itemId: string,
    harvestOperationKey: string
  ): Promise<void> {
    await this.inventory.grantItemsForOperationInTransaction(queryable, {
      operationKey: `rare-find:${harvestOperationKey}`,
      playerId,
      source: "deepstone_rare_find",
      sourceEntityType: "harvest",
      sourceEntityId: harvestOperationKey,
      allowPartial: true,
      grants: [{ itemId: itemId as ResourceType, variant: null, quantity: 1 }]
    });
  }

  async completeResinHarvestInTransaction(
    queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string,
    resourceVision: ResourceVision | null,
    operationKey?: string,
    bonusQuantity = 0
  ): Promise<{
    node: CollectibleNode;
    inventory: PlayerInventorySnapshot;
    rewardQuantity: number;
    droppedItems: DroppedItemSnapshot[];
  }> {
    const row = await this.lockHarvestableNode(
      queryable,
      player,
      nodeId,
      resourceVision
    );
    if (isElderFern(row.id)) {
      return this.completeSapHarvestInTransaction(
        queryable,
        player,
        row,
        operationKey,
        bonusQuantity
      );
    }
    assertResinAvailable(row);
    const authoritativeOperationKey = resinHarvestOperationKey(row);
    if (operationKey !== undefined && operationKey !== authoritativeOperationKey) {
      throw new CollectibleHarvestError(
        "HARVEST_POPULATION_LIFE_CHANGED",
        "This Giving Tree changed before gathering completed.",
        {
          nodeId,
          stateRevision: Number(row.population_v2_state_revision),
          nodePosition: { lat: Number(row.lat), lon: Number(row.lon) },
          reconciliation: "remove-node"
        }
      );
    }
    const lifeRevision = collectibleTreeLifeRevision(row);
    const updated = await queryable.query<CollectibleNodeRow>(
      `UPDATE collectible_nodes AS tree
       SET resin_harvested_life_revision = $2
       WHERE id = $1
         AND state = 'available'
         AND resource_type = 'wood'
         AND population_v2_entity_id IS NOT NULL
         AND NOT population_v2_suppressed
         AND ${CURRENT_POPULATION_TREE_AUTHORITY_SQL}
         AND resin_harvested_life_revision IS DISTINCT FROM $2
       RETURNING id, cell_id, resource_type, quantity, lat, lon, state,
                 created_at, harvested_at, harvested_by_player_id,
                 population_v2_entity_id, population_v2_state_revision,
                 resin_harvested_life_revision, sap_harvested_at`,
      [row.id, lifeRevision]
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      throw new CollectibleHarvestError(
        "HARVEST_RESIN_ALREADY_HARVESTED",
        "Giving Berries have already been harvested from this tree life.",
        { nodeId, reconciliation: "refresh-node" }
      );
    }
    const rewardQuantity = 1 + Math.max(0, Math.trunc(bonusQuantity));
    const position = { lat: Number(row.lat), lon: Number(row.lon) };
    const settlement = await settlePhysicalItemRewardInTransaction(
      queryable,
      this.inventory,
      {
        delivery: "inventory_then_ground",
        lines: [{
          itemId: GIVING_BERRY_ITEM_ID,
          variant: null,
          quantity: rewardQuantity
        }],
        inventoryOperation: {
          operationKey: authoritativeOperationKey,
          playerId: player.playerId,
          source: "giving-tree-resin-harvest",
          sourceEntityType: "collectible_node",
          sourceEntityId: row.id,
          metadata: { treeLifeRevision: lifeRevision }
        },
        groundDrop: {
          operationKey: `harvest-overflow:${authoritativeOperationKey}`,
          droppedByPlayerId: player.playerId,
          regionCode: packageIdForPosition(position),
          zoneId: zoneIdForPosition(position),
          pileId: `harvest:${authoritativeOperationKey}`,
          sourceEntityType: "collectible_node",
          sourceEntityId: row.id,
          position,
          reason: "harvest_inventory_overflow"
        }
      }
    );
    const grant = settlement.inventoryGrant;
    if (!grant) throw new Error("Giving Berry reward did not create an inventory operation");
    if (!grant.applied) {
      throw new Error("Giving Berry inventory operation was already completed");
    }
    return {
      node: rowToCollectibleNode(updatedRow),
      inventory: grant.inventory,
      rewardQuantity,
      droppedItems: settlement.droppedItems
    };
  }

  /** Taps a locked Elder Fern for Frond Sap (balsam_resin); it refills 5 hours later. */
  private async completeSapHarvestInTransaction(
    queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    row: CollectibleNodeRow,
    operationKey: string | undefined,
    bonusQuantity: number
  ): Promise<{
    node: CollectibleNode;
    inventory: PlayerInventorySnapshot;
    rewardQuantity: number;
    droppedItems: DroppedItemSnapshot[];
  }> {
    const now = new Date();
    const lastTapMs = await lastSapTapMs(queryable, row);
    assertSapAvailable(row, now.getTime(), lastTapMs);
    const authoritativeOperationKey = sapHarvestOperationKey(row, lastTapMs);
    if (operationKey !== undefined && operationKey !== authoritativeOperationKey) {
      throw new CollectibleHarvestError(
        "HARVEST_POPULATION_LIFE_CHANGED",
        "This Elder Fern changed before tapping completed.",
        {
          nodeId: row.id,
          stateRevision: Number(row.population_v2_state_revision),
          nodePosition: { lat: Number(row.lat), lon: Number(row.lon) },
          reconciliation: "refresh-node"
        }
      );
    }
    const updated = await queryable.query<CollectibleNodeRow>(
      `UPDATE collectible_nodes AS tree
       SET sap_harvested_at = $2
       WHERE id = $1
         AND state = 'available'
         AND resource_type = 'wood'
         AND population_v2_entity_id IS NOT NULL
         AND NOT population_v2_suppressed
         AND ${CURRENT_POPULATION_TREE_AUTHORITY_SQL}
         AND (sap_harvested_at IS NULL OR sap_harvested_at <= $3)
       RETURNING id, cell_id, resource_type, quantity, lat, lon, state,
                 created_at, harvested_at, harvested_by_player_id,
                 population_v2_entity_id, population_v2_state_revision,
                 resin_harvested_life_revision, sap_harvested_at`,
      [row.id, now, new Date(now.getTime() - ELDER_FROND_SAP_REFILL_MS)]
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      throw new CollectibleHarvestError(
        "HARVEST_RESIN_ALREADY_HARVESTED",
        "This Elder Fern has already been tapped.",
        { nodeId: row.id, reconciliation: "refresh-node" }
      );
    }
    const rewardQuantity = 1 + Math.max(0, Math.trunc(bonusQuantity));
    const position = { lat: Number(row.lat), lon: Number(row.lon) };
    const settlement = await settlePhysicalItemRewardInTransaction(
      queryable,
      this.inventory,
      {
        delivery: "inventory_then_ground",
        lines: [{
          itemId: BALSAM_RESIN_ITEM_ID,
          variant: null,
          quantity: rewardQuantity
        }],
        inventoryOperation: {
          operationKey: authoritativeOperationKey,
          playerId: player.playerId,
          source: "elder-frond-sap-harvest",
          sourceEntityType: "collectible_node",
          sourceEntityId: row.id,
          metadata: { sapHarvestedAt: now.toISOString() }
        },
        groundDrop: {
          operationKey: `harvest-overflow:${authoritativeOperationKey}`,
          droppedByPlayerId: player.playerId,
          regionCode: packageIdForPosition(position),
          zoneId: zoneIdForPosition(position),
          pileId: `harvest:${authoritativeOperationKey}`,
          sourceEntityType: "collectible_node",
          sourceEntityId: row.id,
          position,
          reason: "harvest_inventory_overflow"
        }
      }
    );
    const grant = settlement.inventoryGrant;
    if (!grant) throw new Error("Frond Sap reward did not create an inventory operation");
    if (!grant.applied) {
      throw new Error("Frond Sap inventory operation was already completed");
    }
    return {
      node: rowToCollectibleNode(updatedRow),
      inventory: grant.inventory,
      rewardQuantity,
      droppedItems: settlement.droppedItems
    };
  }

  async inventoryForPlayerInTransaction(
    queryable: CollectibleTransaction,
    playerId: string
  ): Promise<PlayerInventorySnapshot> {
    return this.inventory.snapshotInTransaction(queryable, playerId);
  }

  async harvestedPopulationTreeTransitionInTransaction(
    queryable: CollectibleTransaction,
    nodeId: string
  ): Promise<HarvestedPopulationTreeTransition> {
    const transition =
      await this.findHarvestedPopulationTreeTransitionInTransaction(
        queryable,
        nodeId
      );
    if (!transition) {
      throw new Error(
        "harvested collectible is not an authoritative Population V2 tree"
      );
    }
    return transition;
  }

  async findHarvestedPopulationTreeTransitionInTransaction(
    queryable: CollectibleTransaction,
    nodeId: string
  ): Promise<HarvestedPopulationTreeTransition | null> {
    return loadHarvestedPopulationTreeTransition(queryable, nodeId);
  }

  async inventoryForPlayer(playerId: string): Promise<PlayerInventorySnapshot> {
    return this.inventory.getInventorySnapshot(playerId);
  }

  private async lockHarvestableNode(
    queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string,
    resourceVision: ResourceVision | null,
    expectedStateRevision?: number
  ): Promise<CollectibleNodeRow> {
    if (!resourceVision) {
      throw new CollectibleHarvestError(
        "HARVEST_OUTSIDE_RESOURCE_VISION",
        "This resource is outside the active Resource Vision.",
        { nodeId, reconciliation: "refresh-node" }
      );
    }
    if (isDeveloperPlantNodeId(nodeId) || isPlayerTreeNodeId(nodeId)) {
      return this.lockDeveloperPlantNode(
        queryable,
        player,
        nodeId,
        resourceVision,
        expectedStateRevision
      );
    }
    const result = await queryable.query<CollectibleNodeRow>(
      `
      SELECT id, cell_id, resource_type, quantity, lat, lon, state, created_at, harvested_at,
             harvested_by_player_id, population_v2_entity_id,
             population_v2_state_revision, population_v2_suppressed,
             resin_harvested_life_revision, sap_harvested_at,
             (${CURRENT_POPULATION_TREE_AUTHORITY_SQL})
               AS population_v2_current_authority
      FROM collectible_nodes AS tree
      WHERE id = $1
        AND population_v2_entity_id IS NOT NULL
      FOR UPDATE OF tree
      `,
      [nodeId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new CollectibleHarvestError(
        "HARVEST_NODE_NOT_FOUND",
        "This resource no longer exists.",
        { nodeId, reconciliation: "remove-node" }
      );
    }
    const nodePosition = {
      lat: Number(row.lat),
      lon: Number(row.lon)
    };
    if (row.population_v2_suppressed) {
      throw new CollectibleHarvestError(
        "HARVEST_NODE_SUPPRESSED",
        "This resource is no longer available here.",
        {
          nodeId,
          stateRevision: Number(row.population_v2_state_revision),
          nodePosition,
          reconciliation: "remove-node"
        }
      );
    }
    if (!row.population_v2_current_authority) {
      throw new CollectibleHarvestError(
        "HARVEST_NODE_NOT_FOUND",
        "This resource is no longer part of the current population.",
        {
          nodeId,
          stateRevision: Number(row.population_v2_state_revision),
          nodePosition,
          reconciliation: "remove-node"
        }
      );
    }
    if (row.state !== "available") {
      const populationTreeTransition = row.resource_type === "wood"
        ? await loadHarvestedPopulationTreeTransition(queryable, nodeId)
        : null;
      throw new CollectibleHarvestError(
        "HARVEST_NODE_ALREADY_HARVESTED",
        "This resource has already been harvested.",
        {
          nodeId,
          stateRevision:
            populationTreeTransition?.stateRevision ??
            Number(row.population_v2_state_revision),
          nodePosition,
          reconciliation: "remove-node",
          ...(populationTreeTransition ? { populationTreeTransition } : {})
        }
      );
    }
    const stateRevision = Number(row.population_v2_state_revision);
    if (
      expectedStateRevision !== undefined &&
      stateRevision !== expectedStateRevision
    ) {
      throw new CollectibleHarvestError(
        "HARVEST_POPULATION_LIFE_CHANGED",
        "This resource changed before gathering began.",
        {
          nodeId,
          stateRevision,
          nodePosition,
          reconciliation: "refresh-node"
        }
      );
    }
    if (row.resource_type === "stone") {
      throw new Error("Loose stone is no longer harvestable; use a permanent stone mine");
    }
    if (distanceMeters(resourceVision.center, nodePosition) > resourceVision.radiusM) {
      throw new CollectibleHarvestError(
        "HARVEST_OUTSIDE_RESOURCE_VISION",
        "This resource is outside the active Resource Vision.",
        {
          nodeId,
          stateRevision: Number(row.population_v2_state_revision),
          nodePosition,
          reconciliation: "remove-node"
        }
      );
    }
    const distanceM = distanceMeters(player.position, nodePosition);
    if (distanceM > PICKUP_RADIUS_M) {
      throw new CollectibleHarvestError(
        "HARVEST_TOO_FAR",
        `Move closer to this resource (${Math.round(distanceM)}m away).`,
        {
          nodeId,
          authoritativeDistanceM: Math.round(distanceM),
          maximumDistanceM: PICKUP_RADIUS_M,
          stateRevision: Number(row.population_v2_state_revision),
          nodePosition,
          reconciliation: "refresh-node"
        }
      );
    }
    return row;
  }

  private async lockDeveloperPlantNode(
    queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string,
    resourceVision: ResourceVision,
    expectedStateRevision?: number
  ): Promise<CollectibleNodeRow> {
    const playerTree = isPlayerTreeNodeId(nodeId);
    const treeUuid = nodeId.slice(PLAYER_SAPLING_TREE_ID_PREFIX.length);
    const result = playerTree && !PLAYER_TREE_UUID.test(treeUuid)
      ? { rows: [] as CollectibleNodeRow[] }
      : playerTree
        ? await queryable.query<CollectibleNodeRow>(
            `SELECT ${PLAYER_TREE_COLUMNS} FROM player_saplings WHERE id = $1::uuid FOR UPDATE`,
            [treeUuid]
          )
        : await queryable.query<CollectibleNodeRow>(
      `SELECT entity_id AS id,
              entity_id AS developer_spawned_plant_id,
              'developer:' || entity_id AS cell_id,
              resource_type, quantity, spawn_lat AS lat, spawn_lon AS lon,
              state, created_at, harvested_at, harvested_by_player_id,
              NULL::uuid AS population_v2_entity_id,
              state_revision AS population_v2_state_revision
         FROM developer_spawned_plants
        WHERE entity_id = $1
        FOR UPDATE`,
      [nodeId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new CollectibleHarvestError(
        "HARVEST_NODE_NOT_FOUND",
        "This resource no longer exists.",
        { nodeId, reconciliation: "remove-node" }
      );
    }
    const nodePosition = { lat: Number(row.lat), lon: Number(row.lon) };
    if (row.state !== "available") {
      throw new CollectibleHarvestError(
        "HARVEST_NODE_ALREADY_HARVESTED",
        "This resource has already been harvested.",
        {
          nodeId,
          stateRevision: Number(row.population_v2_state_revision),
          nodePosition,
          reconciliation: "remove-node"
        }
      );
    }
    const stateRevision = Number(row.population_v2_state_revision);
    if (
      expectedStateRevision !== undefined &&
      stateRevision !== expectedStateRevision
    ) {
      throw new CollectibleHarvestError(
        "HARVEST_POPULATION_LIFE_CHANGED",
        "This resource changed before gathering began.",
        { nodeId, stateRevision, nodePosition, reconciliation: "refresh-node" }
      );
    }
    if (distanceMeters(resourceVision.center, nodePosition) > resourceVision.radiusM) {
      throw new CollectibleHarvestError(
        "HARVEST_OUTSIDE_RESOURCE_VISION",
        "This resource is outside the active Resource Vision.",
        { nodeId, stateRevision, nodePosition, reconciliation: "remove-node" }
      );
    }
    const distanceM = distanceMeters(player.position, nodePosition);
    if (distanceM > PICKUP_RADIUS_M) {
      throw new CollectibleHarvestError(
        "HARVEST_TOO_FAR",
        `Move closer to this resource (${Math.round(distanceM)}m away).`,
        {
          nodeId,
          authoritativeDistanceM: Math.round(distanceM),
          maximumDistanceM: PICKUP_RADIUS_M,
          stateRevision,
          nodePosition,
          reconciliation: "refresh-node"
        }
      );
    }
    return row;
  }

  private async harvestNodeStateInTransaction(
    queryable: CollectibleTransaction,
    row: CollectibleNodeRow,
    playerId: string,
    harvestedAt: Date
  ): Promise<CollectibleNodeRow> {
    const expectedRevision = Number(row.population_v2_state_revision);
    if (isPlayerTreeNodeId(row.id)) {
      // Chopping fells a grown player tree for good: it never respawns.
      const transitioned = await queryable.query<CollectibleNodeRow>(
        `UPDATE player_saplings
            SET status = 'chopped', state_revision = state_revision + 1,
                chopped_at = $3, chopped_by_player_id = $4, due_at = NULL
          WHERE id = $1::uuid AND status = 'grown' AND state_revision = $2
          RETURNING ${PLAYER_TREE_COLUMNS}`,
        [row.id.slice(PLAYER_SAPLING_TREE_ID_PREFIX.length), expectedRevision, harvestedAt, playerId]
      );
      if (transitioned.rowCount !== 1 || !transitioned.rows[0]) {
        throw new CollectibleHarvestError(
          "HARVEST_NODE_ALREADY_HARVESTED",
          "This resource has already been harvested.",
          {
            nodeId: row.id,
            stateRevision: expectedRevision + 1,
            nodePosition: { lat: Number(row.lat), lon: Number(row.lon) },
            reconciliation: "remove-node"
          }
        );
      }
      return transitioned.rows[0];
    }
    if (row.developer_spawned_plant_id) {
      const transitioned = await queryable.query<CollectibleNodeRow>(
        `UPDATE developer_spawned_plants
            SET state = 'harvested',
                state_revision = state_revision + 1,
                harvested_at = $3,
                harvested_by_player_id = $4
          WHERE entity_id = $1
            AND state = 'available'
            AND state_revision = $2
          RETURNING entity_id AS id,
                    entity_id AS developer_spawned_plant_id,
                    'developer:' || entity_id AS cell_id,
                    resource_type, quantity, spawn_lat AS lat, spawn_lon AS lon,
                    state, created_at, harvested_at, harvested_by_player_id,
                    NULL::uuid AS population_v2_entity_id,
                    state_revision AS population_v2_state_revision`,
        [row.developer_spawned_plant_id, expectedRevision, harvestedAt, playerId]
      );
      if (transitioned.rowCount !== 1 || !transitioned.rows[0]) {
        throw new CollectibleHarvestError(
          "HARVEST_NODE_ALREADY_HARVESTED",
          "This resource has already been harvested.",
          {
            nodeId: row.id,
            stateRevision: expectedRevision + 1,
            nodePosition: { lat: Number(row.lat), lon: Number(row.lon) },
            reconciliation: "remove-node"
          }
        );
      }
      return transitioned.rows[0];
    }
    if (
      !row.population_v2_entity_id
      || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0
    ) {
      throw new Error("Population v2 collectible has an invalid state revision");
    }
    const transitioned = await queryable.query(
      `UPDATE population_entity_state_v2
       SET state = 'harvested',
           state_revision = state_revision + 1,
           state_actor_player_id = $3,
           killed_or_harvested_at = $4,
           respawn_at = NULL,
           durable_runtime_state = '{}'::jsonb,
           updated_at = clock_timestamp()
       WHERE entity_id = $1::uuid
          AND state = 'ready'
          AND state_revision = $2::bigint
          AND EXISTS (
            SELECT 1
            FROM collectible_nodes AS tree
            WHERE tree.id=$5
              AND tree.population_v2_entity_id=
                population_entity_state_v2.entity_id
              AND NOT tree.population_v2_suppressed
              AND ${CURRENT_POPULATION_TREE_AUTHORITY_SQL}
          )
       RETURNING entity_id`,
      [
        row.population_v2_entity_id,
        expectedRevision,
        playerId,
        harvestedAt,
        row.id
      ]
    );
    if (transitioned.rowCount !== 1) {
      const populationTreeTransition = row.resource_type === "wood"
        ? await loadHarvestedPopulationTreeTransition(queryable, row.id)
        : null;
      throw new CollectibleHarvestError(
        "HARVEST_NODE_ALREADY_HARVESTED",
        "This resource has already been harvested.",
        {
          nodeId: row.id,
          stateRevision:
            populationTreeTransition?.stateRevision ?? expectedRevision + 1,
          nodePosition: { lat: Number(row.lat), lon: Number(row.lon) },
          reconciliation: "remove-node",
          ...(populationTreeTransition ? { populationTreeTransition } : {})
        }
      );
    }
    const synchronized = await queryable.query<CollectibleNodeRow>(
      `SELECT id, cell_id, resource_type, quantity, lat, lon, state,
              created_at, harvested_at, harvested_by_player_id,
              population_v2_entity_id, population_v2_state_revision,
              resin_harvested_life_revision, sap_harvested_at
       FROM collectible_nodes AS tree
       WHERE id = $1
          AND population_v2_entity_id = $2::uuid
          AND NOT population_v2_suppressed
          AND ${CURRENT_POPULATION_TREE_AUTHORITY_SQL}`,
      [row.id, row.population_v2_entity_id]
    );
    if (!synchronized.rows[0]) {
      throw new CollectibleHarvestError(
        "HARVEST_POPULATION_LIFE_CHANGED",
        "This resource changed before gathering completed.",
        {
          nodeId: row.id,
          stateRevision: expectedRevision + 1,
          nodePosition: { lat: Number(row.lat), lon: Number(row.lon) },
          reconciliation: "remove-node"
        }
      );
    }
    return synchronized.rows[0];
  }

  private async upsertResourceVisionStatus(input: {
    resourceVision: ResourceVision;
    status: ResourceVisionGenerationStatus;
    nodeCount: number;
    waterHighlightCount: number;
    generated: boolean;
    lastError: string | null;
  }, queryable: CollectibleTransaction = this.pool): Promise<ResourceVisionStatus> {
    const result = await queryable.query<ResourceVisionStatusRow>(
      `
      INSERT INTO flag_resource_visions (
        flag_id, layout_version, status, radius_m, node_count, water_highlight_count,
        generated_at, last_error
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        CASE WHEN $7 THEN now() ELSE NULL END,
        $8
      )
      ON CONFLICT (flag_id)
      DO UPDATE SET
        layout_version = EXCLUDED.layout_version,
        status = EXCLUDED.status,
        radius_m = EXCLUDED.radius_m,
        node_count = EXCLUDED.node_count,
        water_highlight_count = EXCLUDED.water_highlight_count,
        requested_at = CASE
          WHEN EXCLUDED.status = 'pending' THEN now()
          ELSE flag_resource_visions.requested_at
        END,
        generated_at = EXCLUDED.generated_at,
        last_error = EXCLUDED.last_error
      RETURNING flag_id, layout_version, status, radius_m, node_count, water_highlight_count,
                requested_at, generated_at, last_error, updated_at
      `,
      [
        input.resourceVision.flagId,
        RESOURCE_LAYOUT_VERSION,
        input.status,
        input.resourceVision.radiusM,
        input.nodeCount,
        input.waterHighlightCount,
        input.generated,
        input.lastError
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("resource vision status update did not return a row");
    }
    return rowToResourceVisionStatus(row);
  }
}

export function collectiblePlayerFromRecord(player: PlayerRecord): CollectiblePlayer {
  return {
    playerId: player.playerId,
    regionCode: player.regionCode,
    position: player.position
  };
}

export function resourceVisionForFlag(input: {
  flagId: string;
  flagName: string;
  flagCenter: LatLon;
  movementLeashRadiusM: number;
  visionRadiusM?: number | undefined;
}): ResourceVision {
  const radiusM = Math.max(
    input.visionRadiusM ?? 0,
    resourceVisionRadiusForLeash(input.movementLeashRadiusM)
  );
  return {
    flagId: input.flagId,
    flagName: input.flagName,
    center: input.flagCenter,
    movementLeashRadiusM: input.movementLeashRadiusM,
    paddingM: radiusM - input.movementLeashRadiusM,
    radiusM
  };
}

export function collectiblePlayerFromSnapshot(input: {
  playerId: string;
  regionCode: string;
  lat: number;
  lon: number;
}): CollectiblePlayer {
  return {
    playerId: input.playerId,
    regionCode: input.regionCode,
    position: {
      lat: input.lat,
      lon: input.lon
    }
  };
}

export function spawnCellForPoint(
  point: LatLon,
  regionCode = packageIdForPosition(point)
): SpawnCellKey {
  const cellX = Math.floor((point.lon * METERS_PER_DEGREE_LON) / SPAWN_CELL_SIZE_M);
  const cellY = Math.floor((point.lat * METERS_PER_DEGREE_LAT) / SPAWN_CELL_SIZE_M);
  return {
    id: `${regionCode}:${cellX}:${cellY}`,
    regionCode,
    cellX,
    cellY,
    center: {
      lon: normalizeLongitude(
        ((cellX + 0.5) * SPAWN_CELL_SIZE_M) / METERS_PER_DEGREE_LON
      ),
      lat: Math.max(
        -90,
        Math.min(90, ((cellY + 0.5) * SPAWN_CELL_SIZE_M) / METERS_PER_DEGREE_LAT)
      )
    }
  };
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function normalizeCollectibleWaterEnvironment(
  world: WorldLookupResult
): CollectibleWaterEnvironment {
  const raw = recordOrNull(world.raw);
  const profile = recordOrNull(raw?.profile) ?? raw;
  const environment = recordOrNull(profile?.environment) ?? profile;
  const water = recordOrNull(profile?.water) ?? profile;
  const riverDistanceM =
    world.riverDistanceM ??
    nullableNumber(water?.river_distance_m) ??
    nullableNumber(water?.major_river_distance_m);
  return {
    ok: world.ok,
    packageId: world.packageId,
    elevationM: world.elevationM,
    terrainClass: world.terrainClass,
    landCoverClass: world.landCoverClass ?? nullableString(environment?.land_cover_class),
    biome: world.biome,
    ecoregion: world.ecoregion,
    isLand: world.isLand ?? booleanOrNull(environment?.is_land),
    isSaltwater: world.isSaltwater ?? booleanOrNull(environment?.is_saltwater),
    insideMajorLake:
      world.insideMajorLake === true || booleanOrNull(water?.inside_major_lake) === true,
    nearMajorRiver:
      (world.derivedTags ?? []).includes("near_major_river") ||
      (riverDistanceM !== null && riverDistanceM <= 10_000),
    majorRiverDistanceM: riverDistanceM,
    majorLakeDistanceM:
      world.majorLakeDistanceM ?? nullableNumber(water?.major_lake_distance_m),
    warning: world.warning ?? null,
    raw: world.raw
  };
}

export function classifyCollectibleWater(world: WorldLookupResult): WaterKind | null {
  if (!world.ok) {
    return null;
  }
  const environment = normalizeCollectibleWaterEnvironment(world);
  if (environment.isSaltwater === true) {
    return "salt";
  }
  if (environment.insideMajorLake) {
    return "fresh";
  }
  if (environment.nearMajorRiver && (environment.majorRiverDistanceM ?? Infinity) <= 75) {
    return "fresh";
  }
  if ((environment.majorLakeDistanceM ?? Infinity) <= 50) {
    return "fresh";
  }
  return null;
}

async function loadHarvestedPopulationTreeTransition(
  queryable: CollectibleTransaction,
  nodeId: string
): Promise<HarvestedPopulationTreeTransition | null> {
  const result = await queryable.query<{
    entity_id: string;
    entity_kind: string;
    zone_id: PopulationZoneV2Id;
    generation_id: string | null;
    state_revision: number | string;
    cutover_revision: number | string;
    lat: number | string;
    lon: number | string;
  }>(
    `SELECT tree.population_v2_entity_id AS entity_id,
            slot.entity_kind, tree.physical_population_zone_v2_id AS zone_id,
            slot.generation_id, state.state_revision,
            tree.population_cutover_revision AS cutover_revision,
            tree.lat, tree.lon
     FROM collectible_nodes AS tree
     JOIN population_entity_state_v2 AS state
       ON state.entity_id=tree.population_v2_entity_id
     JOIN population_plan_spawn_slots_v2 AS slot
       ON slot.entity_id=tree.population_v2_entity_id
     WHERE tree.id=$1
       AND tree.resource_type='wood'
       AND state.state='harvested'
       AND NOT tree.population_v2_suppressed
       AND ${CURRENT_POPULATION_TREE_AUTHORITY_SQL}`,
    [nodeId]
  );
  const row = result.rows[0];
  if (
    !row
    || row.entity_kind !== "tree"
    || row.generation_id === null
    || !row.zone_id
  ) {
    return null;
  }
  return {
    entityId: row.entity_id,
    entityKind: "tree",
    stateRevision: Number(row.state_revision),
    position: { lat: Number(row.lat), lon: Number(row.lon) },
    zoneId: row.zone_id,
    generationId: row.generation_id,
    cutoverRevision: Number(row.cutover_revision)
  };
}

function rowToCollectibleNode(row: CollectibleNodeRow): CollectibleNode {
  const treeLifeRevision = row.developer_spawned_plant_id
    ? Number(row.population_v2_state_revision)
    : row.resource_type === "wood"
      ? collectibleTreeLifeRevision(row)
      : undefined;
  return {
    id: row.id,
    type: row.resource_type as ResourceType,
    lat: Number(row.lat),
    lon: Number(row.lon),
    quantity: row.resource_type === "wood"
      ? treeWoodYieldForStableId(row.id)
      : Number(row.quantity),
    state: row.state === "harvested" ? "harvested" : "available",
    createdAt: dateToIso(row.created_at),
    harvestedAt: row.harvested_at === null ? null : dateToIso(row.harvested_at),
    sourceCellId: row.cell_id,
    waterKind: null,
    presentationOwner: "population",
    ...(treeLifeRevision === undefined
      ? {}
      : {
          treeLifeRevision,
          berryAvailable:
            row.state === "available" &&
            treeVarietyForStableId(row.id) === "giving_tree" &&
            isGivingTreeResinCapable(row.id) &&
            resinHarvestedLifeRevision(row) !== treeLifeRevision,
          resinAvailable: false,
          ...(isTappableElderFernRow(row) ? { sapReadyAt: sapReadyAtForRow(row) } : {})
        })
  };
}

function developerPlantToCollectibleNode(
  plant: DeveloperSpawnedPlant
): CollectibleNode {
  return {
    id: plant.entityId,
    type: plant.resourceType,
    lat: plant.position.lat,
    lon: plant.position.lon,
    quantity: plant.quantity,
    state: plant.state,
    createdAt: plant.createdAt,
    harvestedAt: plant.harvestedAt,
    sourceCellId: `developer:${plant.entityId}`,
    waterKind: null,
    presentationOwner: "population",
    treeLifeRevision: plant.stateRevision
  };
}

function collectibleTreeLifeRevision(row: CollectibleNodeRow): number {
  const value = Number(row.population_v2_state_revision);
  if (
    !row.population_v2_entity_id
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error("Giving Tree has an invalid life revision");
  }
  return value;
}

function resinHarvestOperationKey(row: CollectibleNodeRow): string {
  return `giving-tree-resin:${row.id}:life:${collectibleTreeLifeRevision(row)}`;
}

function resinHarvestedLifeRevision(row: CollectibleNodeRow): number | null {
  if (
    row.resin_harvested_life_revision === null ||
    row.resin_harvested_life_revision === undefined
  ) return null;
  const value = Number(row.resin_harvested_life_revision);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Population Elder Ferns can be tapped; developer-spawned plants have no sap timer row. */
function isTappableElderFernRow(row: CollectibleNodeRow): boolean {
  return row.resource_type === "wood"
    && !row.developer_spawned_plant_id
    && !isPlayerTreeNodeId(row.id)
    && Boolean(row.population_v2_entity_id)
    && isElderFern(row.id);
}

function sapHarvestedAtMs(row: CollectibleNodeRow): number | null {
  if (row.sap_harvested_at === null || row.sap_harvested_at === undefined) return null;
  const value = row.sap_harvested_at instanceof Date
    ? row.sap_harvested_at.getTime()
    : Date.parse(row.sap_harvested_at);
  return Number.isFinite(value) ? value : null;
}

/** When the fern's sap refills after its last tap; null when it was never tapped. */
function sapReadyAtForRow(row: CollectibleNodeRow): string | null {
  const harvestedAtMs = sapHarvestedAtMs(row);
  return harvestedAtMs === null
    ? null
    : new Date(harvestedAtMs + ELDER_FROND_SAP_REFILL_MS).toISOString();
}

/**
 * The fern's last tap: the row's timer, or the newest Frond Sap grant in the inventory ledger
 * when that is later. The ledger survives a collectible row that is re-created (or reset)
 * for the same fern, so a lost timer can neither refill a fern early nor repeat a used key.
 */
async function lastSapTapMs(
  queryable: CollectibleTransaction,
  row: CollectibleNodeRow
): Promise<number | null> {
  const ledger = await queryable.query<{ last_tap: Date | string | null }>(
    `SELECT max(created_at) AS last_tap
     FROM inventory_operations
     WHERE source_entity_type = 'collectible_node'
       AND source_entity_id = $1
       AND source = 'elder-frond-sap-harvest'`,
    [row.id]
  );
  const lastTap = ledger.rows[0]?.last_tap ?? null;
  const ledgerMs = lastTap === null ? null : new Date(lastTap).getTime();
  const rowMs = sapHarvestedAtMs(row);
  if (ledgerMs === null || !Number.isFinite(ledgerMs)) return rowMs;
  return rowMs === null ? ledgerMs : Math.max(rowMs, ledgerMs);
}

/** One tap per refill: the key changes with every recorded tap. */
function sapHarvestOperationKey(row: CollectibleNodeRow, lastTapMs: number | null): string {
  return `elder-frond-sap:${row.id}:after:${lastTapMs === null ? "never" : String(lastTapMs)}`;
}

function assertSapAvailable(row: CollectibleNodeRow, nowMs: number, lastTapMs: number | null): void {
  if (!isTappableElderFernRow(row)) {
    throw new CollectibleHarvestError(
      "HARVEST_RESIN_UNAVAILABLE",
      "This tree has no sap to tap.",
      { nodeId: row.id, reconciliation: "refresh-node" }
    );
  }
  const harvestedAtMs = lastTapMs;
  if (harvestedAtMs !== null && harvestedAtMs + ELDER_FROND_SAP_REFILL_MS > nowMs) {
    const remainingMinutes = Math.ceil((harvestedAtMs + ELDER_FROND_SAP_REFILL_MS - nowMs) / 60_000);
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    throw new CollectibleHarvestError(
      "HARVEST_RESIN_ALREADY_HARVESTED",
      `This Elder Fern has been tapped. Its sap refills in ${hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`}.`,
      { nodeId: row.id, reconciliation: "refresh-node" }
    );
  }
}

function assertResinAvailable(row: CollectibleNodeRow): void {
  if (row.resource_type !== "wood" || !isGivingTreeResinCapable(row.id)) {
    throw new CollectibleHarvestError(
      "HARVEST_RESIN_UNAVAILABLE",
      "This Giving Tree has no harvestable berries.",
      { nodeId: row.id, reconciliation: "refresh-node" }
    );
  }
  if (resinHarvestedLifeRevision(row) === collectibleTreeLifeRevision(row)) {
    throw new CollectibleHarvestError(
      "HARVEST_RESIN_ALREADY_HARVESTED",
      "Giving Berries have already been harvested from this tree life.",
      { nodeId: row.id, reconciliation: "refresh-node" }
    );
  }
}

function rowToResourceVisionStatus(row: ResourceVisionStatusRow): ResourceVisionStatus {
  return {
    flagId: row.flag_id,
    layoutVersion: row.layout_version,
    status: row.status,
    radiusM: Number(row.radius_m),
    nodeCount: Number(row.node_count),
    waterHighlightCount: Number(row.water_highlight_count),
    requestedAt: dateToIso(row.requested_at),
    generatedAt: row.generated_at === null ? null : dateToIso(row.generated_at),
    lastError: row.last_error,
    updatedAt: dateToIso(row.updated_at)
  };
}

function emptyResourceVisionStatusCounts(): Record<ResourceVisionGenerationStatus, number> {
  return {
    pending: 0,
    generating: 0,
    ready: 0,
    failed: 0
  };
}

export function collectiblePickupOperationKey(
  nodeId: string,
  playerId: string,
  populationV2LifeRevision: number
): string {
  const legacyKey = `collect:${nodeId}:${playerId}`;
  if (
    !Number.isSafeInteger(populationV2LifeRevision)
    || populationV2LifeRevision < 0
  ) {
    throw new Error("Population v2 collectible life revision is invalid");
  }
  return `${legacyKey}:life:${populationV2LifeRevision}`;
}

function collectibleOperationKeyForRow(
  row: CollectibleNodeRow,
  playerId: string
): string {
  if (row.developer_spawned_plant_id) {
    const stateRevision = Number(row.population_v2_state_revision);
    const lifeRevision = row.state === "available"
      ? stateRevision
      : stateRevision - 1;
    return collectiblePickupOperationKey(row.id, playerId, lifeRevision);
  }
  if (!row.population_v2_entity_id) {
    throw new Error("Collectible does not have Population v2 ownership");
  }
  const stateRevision = Number(row.population_v2_state_revision);
  const lifeRevision = row.state === "available"
    ? stateRevision
    : stateRevision - 1;
  return collectiblePickupOperationKey(row.id, playerId, lifeRevision);
}

function isDeveloperPlantNodeId(nodeId: string): boolean {
  return nodeId.startsWith(DEVELOPER_PLANT_ENTITY_PREFIX);
}

/** Grown trees players planted (givingSaplings.ts) are choppable nodes backed by player_saplings. */
export function isPlayerTreeNodeId(nodeId: string): boolean {
  return nodeId.startsWith(PLAYER_SAPLING_TREE_ID_PREFIX);
}

const PLAYER_TREE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const PLAYER_TREE_COLUMNS = `'sapling:' || id::text AS id,
              'sapling:' || id::text AS developer_spawned_plant_id,
              'player-tree:' || id::text AS cell_id,
              'wood' AS resource_type, ${GIVING_TREE_WOOD_YIELD}::int AS quantity, lat, lon,
              CASE WHEN status = 'grown' THEN 'available' ELSE 'harvested' END AS state,
              created_at, chopped_at AS harvested_at, chopped_by_player_id AS harvested_by_player_id,
              NULL::uuid AS population_v2_entity_id,
              state_revision AS population_v2_state_revision`;

export function waterCollectionOperationKey(requestId: string, playerId: string): string {
  return `collect-water:${requestId}:${playerId}`;
}

function waterCollectionSourceEntityId(target: LatLon): string {
  return `${target.lat.toFixed(6)},${target.lon.toFixed(6)}`;
}

function dateToIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function throwIfPreparationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("flag resource preparation aborted");
  error.name = "AbortError";
  throw error;
}

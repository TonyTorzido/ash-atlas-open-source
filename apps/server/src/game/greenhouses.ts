import { createHash, randomUUID } from "node:crypto";

import {
  distanceMeters,
  greenhouseInitialAnchors,
  GREENHOUSE_BUILD_COST,
  GREENHOUSE_FARM_PLOT_PLACEMENT_COST,
  GREENHOUSE_FERTILIZER_CATEGORY_INPUTS,
  type ResourceType,
  GREENHOUSE_FERTILIZER_RECIPE,
  GREENHOUSE_BUILD_DURATION_MS,
  GREENHOUSE_DESTROY_INTERACTION_RADIUS_M,
  GREENHOUSE_MAIN_ROOM,
  GREENHOUSE_GARDENING_BUCKET_CAPACITY_TENTHS,
  GREENHOUSE_INITIAL_ANCHOR_COUNT,
  GREENHOUSE_RIVERBANK_POLICY_DISTANCE_M,
  GREENHOUSE_RIVERBANK_POLICY_ID,
  GREENHOUSE_STARTING_TANK_WATER_TENTHS,
  GREENHOUSE_TANK_CAPACITY_TENTHS,
  GREENHOUSE_WATER_BUCKET_CAPACITY_TENTHS,
  GREENHOUSE_WATER_BUCKET_FILL_DURATION_MS,
  GREENHOUSE_WATER_BUCKET_MAX_RANGE_M,
  GREENHOUSE_STUDIO_CATALOG,
  greenhouseWaterGallons,
  greenhousePlacementIssue,
  type GreenhousePlacementKind,
  type GreenhouseAnchorSnapshot,
  type GreenhouseBuildPreview,
  type GreenhouseBuildResult,
  type GreenhouseBuildCancellation,
  type GreenhouseBuildSnapshot,
  type GreenhouseEligibilitySnapshot,
  type GreenhouseMutationResult,
  type GreenhousePlantStage,
  type GreenhousePlantSnapshot,
  type GreenhouseSnapshot,
  type GreenhouseStateSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import type pg from "pg";
import { resolveMaterialSpend, spendableItemCounts } from "./materialSpend.js";

import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { InventoryService } from "./inventory.js";
import type { PlayerRecord } from "./state.js";
import { createSystemGroundDropsInTransaction } from "./droppedItems.js";
import {
  DEFAULT_GREENHOUSE_CROP_ID,
  enabledGreenhouseCropDefinition,
  greenhouseCropDefinition,
  type GreenhouseCropDefinition
} from "./greenhouseCrops.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type GreenhouseRow = {
  greenhouse_id: string;
  owner_player_id: string;
  owner_username?: string;
  world_id: string;
  region_code: string;
  lat: number | string;
  lon: number | string;
  placement_revision: number | string;
  room_count: number;
  planter_capacity: number;
  tank_water_tenths: number;
  tank_placed: boolean;
  tank_x: number | string | null;
  tank_y: number | string | null;
  is_riverbank: boolean;
  riverbank_policy: string;
  riverbank_distance_m: number;
  eligibility_checked_at: Date | string;
  built_at: Date | string;
};

type AnchorRow = {
  anchor_id: string;
  greenhouse_id: string;
  room_id: string;
  row_index: number;
  column_index: number;
  x: number;
  y: number;
  active: boolean;
  placed: boolean;
  custom_positioned: boolean;
  crop_id: string | null;
  stage: number | null;
  planted_at: Date | string | null;
  watered_at: Date | string | null;
  next_stage_at: Date | string | null;
  dry: boolean | null;
  berries_remaining?: number | null;
  resin_harvested?: boolean | null;
};

type BuildRow = {
  build_id: string;
  owner_player_id: string;
  request_id: string;
  request_hash: string;
  world_id: string;
  region_code: string;
  lat: number | string;
  lon: number | string;
  is_riverbank: boolean;
  riverbank_policy: string;
  riverbank_distance_m: number;
  eligibility_checked_at: Date | string;
  status: "constructing" | "completed" | "cancelled";
  started_at: Date | string;
  completes_at: Date | string;
  greenhouse_id: string | null;
};

type BucketRow = {
  water_bucket_tenths: number;
  gardening_bucket_tenths: number;
};

type OperationRow = {
  action: string;
  request_hash: string;
  result?: unknown;
};

type DueBuildCompletion = Readonly<{
  playerId: string;
  requestId: string;
  greenhouse: GreenhouseSnapshot;
  inventory: PlayerInventorySnapshot;
}>;

type GreenhouseDestroyResult = Readonly<{
  greenhouseId: string;
  placementRevision: number;
  replayed: boolean;
}>;

type DuePlantTransition = Readonly<{
  greenhouseId: string;
  anchorId: string;
  fromStage: GreenhousePlantStage;
  toStage: GreenhousePlantStage;
}>;

export class GreenhouseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GreenhouseError";
  }
}

/** 1-3 Mist Drops per crop harvest, derived from the request id so a replay grants the same amount. */
function mistDropsForHarvest(requestId: string): number {
  return 1 + (createHash("sha256").update(`mist-drop:${requestId}`).digest()[0]! % 3);
}

export class GreenhouseService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly worldId: string,
    private readonly inventory: Pick<
      InventoryService,
      | "debitItemsForOperationInTransaction"
      | "grantItemsForOperationInTransaction"
      | "snapshotInTransaction"
      | "getInventorySnapshot"
    >,
    private readonly worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironment" | "lookupCanonicalWaterbodyNear">,
    private readonly now: () => number = Date.now
  ) {}

  /** Players known to have no active water fill; empty on boot so restarts re-check the DB. */
  private readonly knownIdleWaterFill = new Set<string>();
  private waterFillStartEpoch = 0;

  /** Cheap sync check: false only when this process has seen the player idle since their last fill start. */
  mayHaveActiveWaterFill(playerId: string): boolean {
    return !this.knownIdleWaterFill.has(playerId);
  }

  private markWaterFillIdle(playerId: string, epochBefore: number): void {
    // A fill started while the idle observation was in flight invalidates it.
    if (epochBefore === this.waterFillStartEpoch) this.knownIdleWaterFill.add(playerId);
  }

  async listNear(player: PlayerRecord, radiusM = 5_000): Promise<GreenhouseSnapshot[]> {
    const result = await this.pool.query<GreenhouseRow>(
      `${GREENHOUSE_SELECT}
       WHERE greenhouse.removed_at IS NULL AND (
         greenhouse.owner_player_id=$1 OR (
           greenhouse.world_id=$2 AND greenhouse.region_code=$3 AND
           ST_DWithin(greenhouse.geom::geography,
             ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,$6)
         )
       )
       ORDER BY ST_Distance(greenhouse.geom::geography,
           ST_SetSRID(ST_MakePoint($4,$5),4326)::geography),greenhouse.greenhouse_id`,
      [player.playerId, this.worldId, player.regionCode, player.position.lon, player.position.lat, Math.max(1, radiusM)]
    );
    return Promise.all(result.rows.map((row) => this.snapshotForRow(row)));
  }

  async authorizeEntry(playerId: string, greenhouseId: string): Promise<void> {
    const result = await this.pool.query<{ owner_player_id: string }>(
      `SELECT owner_player_id FROM player_greenhouses WHERE greenhouse_id=$1 AND removed_at IS NULL`,
      [greenhouseId]
    );
    const row = result.rows[0];
    if (!row) throw new GreenhouseError("GREENHOUSE_NOT_FOUND", "That Greenhouse no longer exists.");
    if (row.owner_player_id !== playerId) throw new GreenhouseError("GREENHOUSE_OWNER_REQUIRED", "Only the greenhouse owner may enter this Greenhouse.");
  }

  async previewBuild(player: PlayerRecord): Promise<GreenhouseBuildPreview> {
    requirePosition(player);
    const environment = await this.worldLookup.lookupGameplayEnvironment(
      player.position.lat,
      player.position.lon
    );
    if (!environment.ok || environment.isRiverbank === null) {
      throw new GreenhouseError(
        "GREENHOUSE_WORLD_UNAVAILABLE",
        "Authoritative World placement data is unavailable. Try again shortly."
      );
    }
    const eligibility = eligibilitySnapshot(environment.isRiverbank === true, this.now());
    const previewCrop = requireGreenhouseCropDefinition(DEFAULT_GREENHOUSE_CROP_ID);
    return {
      position: { lat: player.position.lat, lon: player.position.lon },
      eligibility,
      stageDurationMs: greenhouseCropStageDurationMs(previewCrop, eligibility.isRiverbank),
      serverTime: this.now()
    };
  }

  async build(player: PlayerRecord, requestId: string): Promise<GreenhouseBuildResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const environment = await this.worldLookup.lookupGameplayEnvironment(
      player.position.lat,
      player.position.lon
    );
    if (!environment.ok || environment.isRiverbank === null) {
      throw new GreenhouseError(
        "GREENHOUSE_WORLD_UNAVAILABLE",
        "Authoritative World placement data is unavailable. Try again shortly."
      );
    }
    const eligibility = eligibilitySnapshot(environment.isRiverbank === true, this.now());
    const hash = requestHash("build", player.playerId, player.position.lat, player.position.lon);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await buildForRequest(client, player.playerId, requestId);
      if (replay) {
        if (replay.request_hash !== hash) {
          throw new GreenhouseError("GREENHOUSE_REPLAY_CONFLICT", "The Greenhouse request ID was already used.");
        }
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        if (replay.status === "completed" && replay.greenhouse_id) {
          const greenhouse = await requireGreenhouse(client, replay.greenhouse_id);
          await client.query("COMMIT");
          return { status: "completed", greenhouse: await this.snapshotForRow(greenhouse), inventory, replayed: true };
        }
        if (replay.status === "cancelled") {
          throw new GreenhouseError("GREENHOUSE_BUILD_CANCELLED", "That Greenhouse construction was cancelled. Start a new build.");
        }
        await client.query("COMMIT");
        return {
          status: "constructing",
          build: mapBuild(replay),
          inventory,
          replayed: true
        };
      }
      if (await activeBuild(client, player.playerId)) {
        throw new GreenhouseError("GREENHOUSE_BUILD_ACTIVE", "Finish the current Greenhouse construction first.");
      }
      if (await hasActiveGreenhouse(client, player.playerId)) {
        throw new GreenhouseError("GREENHOUSE_OWNER_LIMIT", "You may only own one Greenhouse.");
      }
      let inventory;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `greenhouse:build:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "greenhouse_construction",
          sourceEntityType: "greenhouse",
          sourceEntityId: player.playerId,
          metadata: {
            requestId,
            worldId: this.worldId,
            eligibility
          },
          debits: GREENHOUSE_BUILD_COST.map((cost) => ({
            itemId: cost.itemId,
            variant: null,
            quantity: cost.quantity
          }))
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new GreenhouseError(
            "GREENHOUSE_MATERIALS_REQUIRED",
            "A Greenhouse requires 100 Wood, 10 Iron Bars, and 30 Stone."
          );
        }
        throw error;
      }
      const buildId = randomUUID();
      const startedAt = this.now();
      const completesAt = startedAt + GREENHOUSE_BUILD_DURATION_MS;
      await client.query(
        `INSERT INTO greenhouse_build_jobs (
           build_id,owner_player_id,request_id,request_hash,world_id,region_code,lat,lon,geom,
           is_riverbank,riverbank_policy,riverbank_distance_m,eligibility_checked_at,
           status,started_at,completes_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,ST_SetSRID(ST_MakePoint($8,$7),4326),$9,$10,$11,to_timestamp($12/1000.0),'constructing',to_timestamp($13/1000.0),to_timestamp($14/1000.0))`,
        [
          buildId,
          player.playerId,
          requestId,
          hash,
          this.worldId,
          player.regionCode,
          player.position.lat,
          player.position.lon,
          eligibility.isRiverbank,
          eligibility.policyId,
          eligibility.policyDistanceM,
          Date.parse(eligibility.checkedAt),
          startedAt,
          completesAt
        ]
      );
      await client.query("COMMIT");
      return {
        status: "constructing",
        build: {
          buildId,
          position: { lat: player.position.lat, lon: player.position.lon },
          eligibility,
          startedAt,
          completesAt,
          durationMs: GREENHOUSE_BUILD_DURATION_MS
        },
        inventory,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileDueBuilds(limit = 32): Promise<Readonly<{
    completed: DueBuildCompletion[];
    cancelled: GreenhouseBuildCancellation[];
  }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<BuildRow>(
        `SELECT build_id,owner_player_id,request_id,request_hash,world_id,region_code,lat,lon,
           is_riverbank,riverbank_policy,riverbank_distance_m,eligibility_checked_at,
           status,started_at,completes_at,greenhouse_id
         FROM greenhouse_build_jobs
         WHERE status='constructing' AND completes_at <= clock_timestamp()
         ORDER BY completes_at,build_id
         LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [Math.max(1, Math.min(128, limit))]
      );
      const completed: DueBuildCompletion[] = [];
      const cancelled: GreenhouseBuildCancellation[] = [];
      for (const build of due.rows) {
        const greenhouseId = randomUUID();
        const greenhouse = await client.query<GreenhouseRow>(
          `INSERT INTO player_greenhouses (
           greenhouse_id,owner_player_id,world_id,region_code,lat,lon,geom,
             tank_water_tenths,tank_placed,is_riverbank,riverbank_policy,riverbank_distance_m,eligibility_checked_at
           ) VALUES ($1,$2,$3,$4,$5,$6,ST_SetSRID(ST_MakePoint($6,$5),4326),$7,false,$8,$9,$10,$11)
           RETURNING ${GREENHOUSE_RETURNING_FIELDS}`,
          [
            greenhouseId, build.owner_player_id, build.world_id, build.region_code,
            Number(build.lat), Number(build.lon), GREENHOUSE_STARTING_TANK_WATER_TENTHS,
            build.is_riverbank, build.riverbank_policy, build.riverbank_distance_m, build.eligibility_checked_at
          ]
        );
        await insertInitialAnchors(client, greenhouseId);
        await client.query(
          `UPDATE greenhouse_build_jobs SET status='completed',greenhouse_id=$2,updated_at=now()
           WHERE build_id=$1`,
          [build.build_id, greenhouseId]
        );
        await ensureBucketState(client, build.owner_player_id);
        const starterCrop = requireGreenhouseCropDefinition(DEFAULT_GREENHOUSE_CROP_ID);
        const existingGardeningBucket = await client.query(
          `SELECT 1 FROM player_inventory
           WHERE player_id=$1 AND resource_type='gardening_bucket' AND variant='default' AND quantity>0
           LIMIT 1`,
          [build.owner_player_id]
        );
        const starter = await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `greenhouse:starter:${build.owner_player_id}:${greenhouseId}`,
          playerId: build.owner_player_id,
          source: "greenhouse_starter_allotment",
          sourceEntityType: "greenhouse",
          sourceEntityId: greenhouseId,
          metadata: {
            greenhouseId,
            cropId: starterCrop.cropId,
            starterSeedQuantity: starterCrop.starterSeedQuantity
          },
          grants: [
            { ...starterCrop.seed, quantity: starterCrop.starterSeedQuantity },
            ...(existingGardeningBucket.rows[0] ? [] : [{ itemId: "gardening_bucket" as const, variant: null, quantity: 1 }])
          ]
        });
        const row = greenhouse.rows[0];
        if (!row) throw new GreenhouseError("GREENHOUSE_BUILD_CONFLICT", "Greenhouse completion failed.");
        completed.push({
          playerId: build.owner_player_id,
          requestId: build.request_id,
          greenhouse: await this.snapshotForRow(row, client),
          inventory: starter.inventory
        });
      }
      await client.query("COMMIT");
      return { completed, cancelled };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelBuildForMovement(playerId: string): Promise<GreenhouseBuildCancellation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const build = await activeBuildRow(client, playerId, true);
      if (!build) {
        await client.query("COMMIT");
        return null;
      }
      const cancelled = await this.cancelBuildInTransaction(client, build, "movement");
      await client.query("COMMIT");
      return cancelled;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelBuild(playerId: string, requestId: string): Promise<GreenhouseBuildCancellation | null> {
    requireRequestId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, playerId, requestId);
      const hash = requestHash("cancel-build", playerId);
      const replay = await existingOperation(client, playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        await client.query("COMMIT");
        const result = replay.result && typeof replay.result === "object"
          ? replay.result as Partial<GreenhouseBuildCancellation>
          : null;
        if (!result?.buildId || !result.inventory || !Array.isArray(result.droppedItems)) return null;
        return {
          playerId,
          requestId: typeof result.requestId === "string" ? result.requestId : requestId,
          buildId: result.buildId,
          inventory: result.inventory,
          droppedItems: result.droppedItems,
          message: typeof result.message === "string"
            ? result.message
            : "Greenhouse construction was cancelled; materials were refunded."
        };
      }
      const build = await activeBuildRow(client, playerId, true);
      if (!build) {
        await client.query("COMMIT");
        return null;
      }
      const cancelled = await this.cancelBuildInTransaction(client, build, "manual");
      await insertOperation(client, playerId, requestId, "cancel-build", hash, null, cancelled);
      await client.query("COMMIT");
      return cancelled;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async destroy(player: PlayerRecord, requestId: string, greenhouseId: string): Promise<GreenhouseDestroyResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const hash = requestHash("destroy", player.playerId, greenhouseId);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const result = replay.result && typeof replay.result === "object"
          ? replay.result as { greenhouseId?: string; placementRevision?: number }
          : {};
        await client.query("COMMIT");
        return {
          greenhouseId: result.greenhouseId ?? greenhouseId,
          placementRevision: Number(result.placementRevision ?? 0),
          replayed: true
        };
      }
      const target = await client.query<{ greenhouse_id: string; placement_revision: number }>(
        `SELECT greenhouse_id,placement_revision
         FROM player_greenhouses
         WHERE greenhouse_id=$1::uuid AND owner_player_id=$2 AND removed_at IS NULL
           AND world_id=$3 AND region_code=$4
           AND ST_DWithin(
             geom::geography,
             ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,
             $7
           )
         FOR UPDATE`,
        [greenhouseId, player.playerId, this.worldId, player.regionCode, player.position.lon, player.position.lat, GREENHOUSE_DESTROY_INTERACTION_RADIUS_M]
      );
      if (!target.rows[0]) {
        throw new GreenhouseError(
          "GREENHOUSE_OWNER_OR_RANGE_REQUIRED",
          `Only the owner may destroy this Greenhouse, and only within ${GREENHOUSE_DESTROY_INTERACTION_RADIUS_M}m.`
        );
      }
      const updated = await client.query<{ placement_revision: number }>(
        `UPDATE player_greenhouses
         SET removed_at=clock_timestamp(),placement_revision=placement_revision+1,updated_at=clock_timestamp()
         WHERE greenhouse_id=$1::uuid AND removed_at IS NULL
         RETURNING placement_revision`,
        [greenhouseId]
      );
      const placementRevision = Number(updated.rows[0]?.placement_revision ?? target.rows[0].placement_revision);
      await insertOperation(
        client,
        player.playerId,
        requestId,
        "destroy",
        hash,
        greenhouseId,
        { greenhouseId, placementRevision }
      );
      await client.query("COMMIT");
      return { greenhouseId, placementRevision, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async cancelBuildInTransaction(
    client: pg.PoolClient,
    build: BuildRow,
    reason: "movement" | "manual"
  ): Promise<GreenhouseBuildCancellation> {
    const refund = await this.inventory.grantItemsForOperationInTransaction(client, {
      operationKey: `greenhouse:build:${build.owner_player_id}:${build.request_id}:refund`,
      playerId: build.owner_player_id,
      source: "greenhouse_refund",
      sourceEntityType: "greenhouse_build",
      sourceEntityId: build.build_id,
      metadata: { requestId: build.request_id, reason },
      allowPartial: true,
      grants: GREENHOUSE_BUILD_COST.map((cost) => ({
        itemId: cost.itemId,
        variant: null,
        quantity: cost.quantity
      }))
    });
    const droppedItems = await createSystemGroundDropsInTransaction(client, {
      operationKey: `greenhouse:build:${build.owner_player_id}:${build.request_id}:refund-drop`,
      droppedByPlayerId: build.owner_player_id,
      regionCode: build.region_code,
      position: { lat: Number(build.lat), lon: Number(build.lon) },
      reason: "greenhouse_construction_cancelled",
      lines: GREENHOUSE_BUILD_COST.flatMap((cost) => {
        const granted = refund.grants.find((entry) => entry.itemId === cost.itemId)?.grantedQuantity ?? 0;
        const quantity = cost.quantity - granted;
        return quantity > 0 ? [{ itemId: cost.itemId, variant: null, quantity }] : [];
      })
    });
    await client.query(
      `UPDATE greenhouse_build_jobs
       SET status='cancelled',cancel_reason=$2,updated_at=clock_timestamp()
       WHERE build_id=$1::uuid AND status='constructing'`,
      [build.build_id, reason]
    );
    return {
      playerId: build.owner_player_id,
      requestId: build.request_id,
      buildId: build.build_id,
      inventory: refund.inventory,
      droppedItems,
      message: reason === "movement"
        ? "Greenhouse construction was cancelled by movement; materials were refunded."
        : "Greenhouse construction was cancelled; materials were refunded."
    };
  }

  async activeBuildForPlayer(playerId: string): Promise<Readonly<{
    requestId: string;
    build: GreenhouseBuildSnapshot;
    inventory: PlayerInventorySnapshot;
  }> | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await activeBuildRow(client, playerId);
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return { requestId: row.request_id, build: mapBuild(row), inventory };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileDuePlants(limit = 256): Promise<DuePlantTransition[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{
        greenhouse_id: string;
        anchor_id: string;
        crop_id: string;
        stage: number;
      }>(
        `SELECT greenhouse_id,anchor_id,crop_id,stage FROM greenhouse_plants
         WHERE dry=false AND next_stage_at <= clock_timestamp()
         ORDER BY next_stage_at,anchor_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [Math.max(1, Math.min(1024, limit))]
      );
      const transitions: DuePlantTransition[] = [];
      for (const plant of due.rows) {
        const crop = requireGreenhouseCropDefinition(plant.crop_id);
        const fromStage = plant.stage as GreenhousePlantStage;
        const toStage = Math.min(crop.maxStage, fromStage + 1) as GreenhousePlantStage;
        await client.query(
          `UPDATE greenhouse_plants SET stage=$3,dry=true,next_stage_at=NULL,updated_at=clock_timestamp()
           WHERE greenhouse_id=$1 AND anchor_id=$2 AND dry=false`,
          [plant.greenhouse_id, plant.anchor_id, toStage]
        );
        transitions.push({ greenhouseId: plant.greenhouse_id, anchorId: plant.anchor_id, fromStage, toStage });
      }
      await client.query("COMMIT");
      return transitions;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Persist a Studio-template placement.  The client may preview a drag, but
   * this transaction remains the sole authority for room containment, blocker
   * and overlap checks. */
  async place(
    player: PlayerRecord,
    requestId: string,
    greenhouseId: string,
    placementKind: GreenhousePlacementKind,
    x: number,
    y: number,
    anchorId?: string
  ): Promise<GreenhouseMutationResult> {
    requireRequestId(requestId);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new GreenhouseError("GREENHOUSE_INVALID_PLACEMENT", "Choose a valid room position.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const greenhouse = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      const hash = requestHash("place", player.playerId, greenhouseId, placementKind, x, y, anchorId ?? "");
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await this.stateInTransaction(client, greenhouse, player.playerId);
        await client.query("COMMIT");
        const result = replay.result && typeof replay.result === "object" ? replay.result as Record<string, unknown> : {};
        return {
          state,
          inventory: state.inventory,
          replayed: true,
          message: typeof result.message === "string" ? result.message : "That placement was already applied.",
          placementKind,
          ...(typeof result.placedAnchorId === "string" ? { placedAnchorId: result.placedAnchorId } : {})
        };
      }

      let placedAnchorId: string | undefined;
      if (placementKind === "pot") {
        const target = anchorId
          ? await client.query<AnchorRow>(
            `SELECT anchor_id,greenhouse_id,room_id,row_index,column_index,x,y,active,placed,custom_positioned,
               NULL::integer AS stage,NULL::timestamptz AS planted_at,NULL::timestamptz AS watered_at,
               NULL::timestamptz AS next_stage_at,NULL::boolean AS dry
             FROM greenhouse_plant_anchors
             WHERE greenhouse_id=$1 AND anchor_id=$2 AND active=true FOR UPDATE`,
            [greenhouseId, anchorId]
          )
          : await client.query<AnchorRow>(
            `SELECT anchor_id,greenhouse_id,room_id,row_index,column_index,x,y,active,placed,custom_positioned,
               NULL::integer AS stage,NULL::timestamptz AS planted_at,NULL::timestamptz AS watered_at,
               NULL::timestamptz AS next_stage_at,NULL::boolean AS dry
             FROM greenhouse_plant_anchors
             WHERE greenhouse_id=$1 AND active=true AND placed=false
             ORDER BY row_index,column_index,anchor_id LIMIT 1 FOR UPDATE`,
            [greenhouseId]
          );
        const row = target.rows[0];
        if (!row) throw new GreenhouseError("GREENHOUSE_PLANTER_CAPACITY", "All greenhouse Farm Plot capacity is already placed.");
        if (row.placed) throw new GreenhouseError("GREENHOUSE_PLACEMENT_OCCUPIED", "That Farm Plot is already placed.");
        placedAnchorId = row.anchor_id;
      } else if (anchorId) {
        throw new GreenhouseError("GREENHOUSE_INVALID_PLACEMENT", "A water tank has one stable placement; choose a room position instead.");
      }

      const occupants = await placedOccupants(
        client,
        greenhouse,
        placementKind === "pot" ? placedAnchorId : undefined,
        placementKind === "water_tank"
      );
      const issue = greenhousePlacementIssue(GREENHOUSE_STUDIO_CATALOG, placementKind, x, y, occupants);
      if (issue) throw new GreenhouseError("GREENHOUSE_INVALID_PLACEMENT", issue);
      if (placementKind === "pot") {
        const materialRows = await client.query<{ resource_type: string; quantity: string }>(
          `SELECT resource_type,quantity::text FROM player_inventory
           WHERE player_id=$1 AND variant='default' AND resource_type = ANY($2::text[])`,
          [player.playerId, GREENHOUSE_FARM_PLOT_PLACEMENT_COST.map((cost) => cost.itemId)]
        );
        const materialQuantities = new Map(materialRows.rows.map((row) => [row.resource_type, Number(row.quantity)]));
        if (GREENHOUSE_FARM_PLOT_PLACEMENT_COST.some((cost) =>
          (materialQuantities.get(cost.itemId) ?? 0) < cost.quantity
        )) {
          throw new GreenhouseError(
            "GREENHOUSE_FARM_PLOT_MATERIALS_REQUIRED",
            "Farm Plot placement requires 100 Wood and 50 Fertilizer."
          );
        }
        const bucket = await lockBucketState(client, player.playerId);
        await requireCarriedItem(
          client,
          player.playerId,
          "gardening_bucket",
          "GREENHOUSE_GARDENING_BUCKET_REQUIRED",
          "Carry your Gardening Bucket with 1 gallon of water to place a Farm Plot."
        );
        if (bucket.gardening_bucket_tenths < 10) {
          throw new GreenhouseError(
            "GREENHOUSE_GARDENING_BUCKET_WATER_REQUIRED",
            "Your Gardening Bucket needs 1 gallon of water to place a Farm Plot."
          );
        }
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `greenhouse:place-farm-plot:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "greenhouse-farm-plot-placement",
          sourceEntityType: "greenhouse",
          sourceEntityId: greenhouseId,
          metadata: { greenhouseId, placementKind, x, y },
          debits: GREENHOUSE_FARM_PLOT_PLACEMENT_COST.map((cost) => ({
            itemId: cost.itemId,
            variant: "default",
            quantity: cost.quantity
          }))
        });
        await client.query(
          `UPDATE greenhouse_water_buckets
           SET gardening_bucket_tenths=gardening_bucket_tenths-10,updated_at=clock_timestamp()
           WHERE player_id=$1`,
          [player.playerId]
        );
        await client.query(
          `UPDATE greenhouse_plant_anchors
           SET x=$3,y=$4,placed=true,custom_positioned=true,updated_at=clock_timestamp()
           WHERE greenhouse_id=$1 AND anchor_id=$2 AND active=true`,
          [greenhouseId, placedAnchorId, x, y]
        );
      } else {
        await client.query(
          `UPDATE player_greenhouses
           SET tank_x=$2,tank_y=$3,tank_placed=true,placement_revision=placement_revision+1,updated_at=clock_timestamp()
           WHERE greenhouse_id=$1 AND removed_at IS NULL`,
          [greenhouseId, x, y]
        );
      }
      if (placementKind === "pot") {
        await client.query(
          `UPDATE player_greenhouses SET placement_revision=placement_revision+1,updated_at=clock_timestamp()
           WHERE greenhouse_id=$1 AND removed_at IS NULL`,
          [greenhouseId]
        );
      }
      const message = placementKind === "pot" ? "Farm Plot placed." : "Water tank placed.";
      const result = { message, placementKind, ...(placedAnchorId ? { placedAnchorId } : {}), x, y };
      await insertOperation(client, player.playerId, requestId, "place", hash, greenhouseId, result);
      const updatedGreenhouse = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      const state = await this.stateInTransaction(client, updatedGreenhouse, player.playerId);
      await client.query("COMMIT");
      return {
        state,
        inventory: state.inventory,
        replayed: false,
        message,
        placementKind,
        ...(placedAnchorId ? { placedAnchorId } : {})
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshot(player: PlayerRecord, greenhouseId: string): Promise<GreenhouseStateSnapshot> {
    await this.reconcileDuePlants();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      const state = await this.stateInTransaction(client, row, player.playerId);
      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async developerAdvanceAllCrops(playerId: string, greenhouseId: string, requestId: string): Promise<{
    state: GreenhouseStateSnapshot;
    advancedCount: number;
    replayed: boolean;
  }> {
    const result = await this.developerMutateAllCrops(playerId, greenhouseId, requestId, "developer-advance-all", "advance");
    return { state: result.state, advancedCount: result.advancedCount ?? 0, replayed: result.replayed };
  }

  async developerWaterAllCrops(playerId: string, greenhouseId: string, requestId: string): Promise<{
    state: GreenhouseStateSnapshot;
    wateredCount: number;
    replayed: boolean;
  }> {
    const result = await this.developerMutateAllCrops(playerId, greenhouseId, requestId, "developer-water-all", "water");
    return { state: result.state, wateredCount: result.wateredCount ?? 0, replayed: result.replayed };
  }

  private async developerMutateAllCrops(
    playerId: string,
    greenhouseId: string,
    requestId: string,
    action: string,
    mutation: "advance" | "water"
  ): Promise<{ state: GreenhouseStateSnapshot; advancedCount?: number; wateredCount?: number; replayed: boolean }> {
    requireRequestId(requestId);
    await this.reconcileDuePlants();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, playerId, requestId);
      const greenhouse = await requireOwnedGreenhouse(client, greenhouseId, playerId);
      const hash = requestHash(action, playerId, greenhouseId);
      const replay = await existingOperation(client, playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await this.stateInTransaction(client, greenhouse, playerId);
        await client.query("COMMIT");
        const result = replay.result && typeof replay.result === "object" ? replay.result as Record<string, unknown> : {};
        return {
          state,
          ...(mutation === "advance" ? { advancedCount: Number(result.advancedCount ?? 0) } : { wateredCount: Number(result.wateredCount ?? 0) }),
          replayed: true
        };
      }

      const plants = await client.query<{ anchor_id: string; crop_id: string; stage: number; dry: boolean }>(
        `SELECT plant.anchor_id,plant.crop_id,plant.stage,plant.dry
         FROM greenhouse_plants plant
         JOIN greenhouse_plant_anchors anchor ON anchor.greenhouse_id=plant.greenhouse_id AND anchor.anchor_id=plant.anchor_id
         WHERE plant.greenhouse_id=$1 AND anchor.active=true AND anchor.placed=true
         ORDER BY anchor.room_id,anchor.row_index,anchor.column_index,anchor.anchor_id
         FOR UPDATE`,
        [greenhouseId]
      );
      const now = this.now();
      let changed = 0;
      for (const plant of plants.rows) {
        const crop = requireGreenhouseCropDefinition(plant.crop_id);
        if (mutation === "advance") {
          if (plant.stage >= crop.maxStage) continue;
          await client.query(
            `UPDATE greenhouse_plants
             SET stage=LEAST(stage+1,$3),dry=true,watered_at=NULL,next_stage_at=NULL,updated_at=clock_timestamp()
             WHERE greenhouse_id=$1 AND anchor_id=$2`,
            [greenhouseId, plant.anchor_id, crop.maxStage]
          );
        } else {
          if (plant.stage >= crop.maxStage || !plant.dry) continue;
          const nextStageAt = now + greenhouseCropStageDurationMs(crop, greenhouse.is_riverbank);
          await client.query(
            `UPDATE greenhouse_plants
             SET dry=false,watered_at=to_timestamp($3/1000.0),next_stage_at=to_timestamp($4/1000.0),updated_at=clock_timestamp()
             WHERE greenhouse_id=$1 AND anchor_id=$2`,
            [greenhouseId, plant.anchor_id, now, nextStageAt]
          );
        }
        changed += 1;
      }
      const result = mutation === "advance" ? { advancedCount: changed } : { wateredCount: changed };
      await insertOperation(client, playerId, requestId, action, hash, greenhouseId, result);
      const state = await this.stateInTransaction(client, greenhouse, playerId);
      await client.query("COMMIT");
      return { state, ...result, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async planterPosition(greenhouseId: string, anchorId: string): Promise<{ roomId: string; x: number; y: number } | null> {
    const result = await this.pool.query<{ room_id: string; x: number; y: number; placed: boolean; custom_positioned: boolean }>(
      `SELECT room_id,x,y,placed,custom_positioned
       FROM greenhouse_plant_anchors
       WHERE greenhouse_id=$1 AND anchor_id=$2 AND active=true`,
      [greenhouseId, anchorId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const authored = GREENHOUSE_STUDIO_CATALOG.anchors.find((anchor) => anchor.anchorId === anchorId);
    return {
      roomId: row.room_id,
      x: row.placed || row.custom_positioned ? Number(row.x) : Number(authored?.x ?? row.x),
      y: row.placed || row.custom_positioned ? Number(row.y) : Number(authored?.y ?? row.y)
    };
  }

  async waterStoragePosition(greenhouseId: string): Promise<{ roomId: string; x: number; y: number } | null> {
    const result = await this.pool.query<{ tank_placed: boolean; tank_x: number | string | null; tank_y: number | string | null }>(
      `SELECT tank_placed,tank_x,tank_y FROM player_greenhouses
       WHERE greenhouse_id=$1 AND removed_at IS NULL`,
      [greenhouseId]
    );
    const row = result.rows[0];
    if (!row || row.tank_placed === false) return null;
    return {
      roomId: GREENHOUSE_MAIN_ROOM,
      x: row.tank_x === null || row.tank_x === undefined ? GREENHOUSE_STUDIO_CATALOG.waterStorage.x : Number(row.tank_x),
      y: row.tank_y === null || row.tank_y === undefined ? GREENHOUSE_STUDIO_CATALOG.waterStorage.y : Number(row.tank_y)
    };
  }

  async plant(
    player: PlayerRecord,
    requestId: string,
    greenhouseId: string,
    anchorId: string,
    packId: string,
    cropId: string = DEFAULT_GREENHOUSE_CROP_ID
  ): Promise<GreenhouseMutationResult> {
    return this.mutatePlant(player, requestId, greenhouseId, anchorId, packId, cropId);
  }

  async water(player: PlayerRecord, requestId: string, greenhouseId: string, anchorId: string): Promise<GreenhouseMutationResult> {
    requireRequestId(requestId);
    await this.reconcileDuePlants();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const greenhouse = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      const hash = requestHash("water", player.playerId, greenhouseId, anchorId);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await this.stateInTransaction(client, greenhouse, player.playerId);
        const inventory = state.inventory;
        await client.query("COMMIT");
        return { state, inventory, replayed: true, message: "The plant watering was already applied." };
      }
      const bucket = await lockBucketState(client, player.playerId);
      await requireCarriedItem(client, player.playerId, "gardening_bucket", "GREENHOUSE_GARDENING_BUCKET_REQUIRED", "Carry your Gardening Bucket to water greenhouse plants.");
      if (bucket.gardening_bucket_tenths < 1) {
        throw new GreenhouseError("GREENHOUSE_WATER_REQUIRED", "Your gardening bucket needs at least 0.1 gallons.");
      }
      const plant = await requirePlant(client, greenhouseId, anchorId, true);
      const crop = requireGreenhouseCropDefinition(plant.cropId);
      if (plant.stage >= crop.maxStage) throw new GreenhouseError("GREENHOUSE_HARVEST_READY", `This ${crop.displayName.toLowerCase()} is ready to harvest.`);
      if (!plant.dry) throw new GreenhouseError("GREENHOUSE_TIMER_ACTIVE", "This plant is already growing.");
      const now = this.now();
      const stageDurationMs = greenhouseCropStageDurationMs(crop, greenhouse.is_riverbank);
      const nextStageAt = now + stageDurationMs;
      const leavingFruitingTreeStage = crop.kind === "giving_tree" && plant.stage === 3;
      await client.query(
        `UPDATE greenhouse_water_buckets SET gardening_bucket_tenths=gardening_bucket_tenths-1,updated_at=clock_timestamp() WHERE player_id=$1`,
        [player.playerId]
      );
      await client.query(
        `UPDATE greenhouse_plants SET watered_at=to_timestamp($3/1000.0),next_stage_at=to_timestamp($4/1000.0),dry=false,
           berries_remaining=CASE WHEN $5::boolean THEN 0 ELSE berries_remaining END,updated_at=clock_timestamp()
         WHERE greenhouse_id=$1 AND anchor_id=$2`,
        [greenhouseId, anchorId, now, nextStageAt, leavingFruitingTreeStage]
      );
      await insertOperation(client, player.playerId, requestId, "water", hash, greenhouseId);
      const state = await this.stateInTransaction(client, greenhouse, player.playerId);
      await client.query("COMMIT");
      return { state, inventory: state.inventory, replayed: false, message: `Watered for ${(stageDurationMs / 3_600_000).toFixed(1)}h.` };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async clip(player: PlayerRecord, requestId: string, greenhouseId: string, anchorId: string): Promise<GreenhouseMutationResult & { yieldQuantity: number }> {
    requireRequestId(requestId);
    await this.reconcileDuePlants();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const greenhouse = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      const hash = requestHash("clip", player.playerId, greenhouseId, anchorId);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await this.stateInTransaction(client, greenhouse, player.playerId);
        await client.query("COMMIT");
        return { state, inventory: state.inventory, replayed: true, yieldQuantity: 0, message: "The clipping was already applied." };
      }
      const plant = await requirePlant(client, greenhouseId, anchorId, true);
      const crop = requireGreenhouseCropDefinition(plant.cropId);
      if (crop.kind === "giving_tree" && plant.stage === 3) {
        if (!plant.dry) throw new GreenhouseError("GREENHOUSE_CLIPPING_UNAVAILABLE", "Wait for the Giving Tree to finish growing before gathering berries.");
        const tree = await client.query<{ berries_remaining: number | null }>(
          `SELECT berries_remaining FROM greenhouse_plants WHERE greenhouse_id=$1 AND anchor_id=$2 FOR UPDATE`,
          [greenhouseId, anchorId]
        );
        const berriesRemaining = Number(tree.rows[0]?.berries_remaining ?? 0);
        if (berriesRemaining <= 0) throw new GreenhouseError("GREENHOUSE_BERRIES_UNAVAILABLE", "This Giving Tree has already been gathered.");
        const quantity = crop.berryYield ?? berriesRemaining;
        const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `greenhouse:berries:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "greenhouse_giving_tree",
          sourceEntityType: "greenhouse_anchor",
          sourceEntityId: anchorId,
          metadata: { requestId, greenhouseId, anchorId },
          grants: [{ itemId: "giving_berry", variant: null, quantity }]
        });
        await client.query(`DELETE FROM greenhouse_plants WHERE greenhouse_id=$1 AND anchor_id=$2`, [greenhouseId, anchorId]);
        await insertOperation(client, player.playerId, requestId, "clip", hash, greenhouseId);
        const state = await this.stateInTransaction(client, greenhouse, player.playerId);
        await client.query("COMMIT");
        return { state, inventory: grant.inventory, replayed: false, yieldQuantity: quantity, message: `Gathered ${quantity} Giving Berries.` };
      }
      if (!plant.dry) throw new GreenhouseError("GREENHOUSE_CLIPPING_UNAVAILABLE", "Wait for this crop stage to finish before taking a clipping.");
      const quantity = crop.clippingYieldByStage[plant.stage as GreenhousePlantStage] ?? 0;
      if (quantity <= 0) throw new GreenhouseError("GREENHOUSE_CLIPPING_UNAVAILABLE", "This crop cannot be clipped at this stage.");
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `greenhouse:clip:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "greenhouse_clipping",
        sourceEntityType: "greenhouse_anchor",
        sourceEntityId: anchorId,
        metadata: { requestId, greenhouseId, anchorId },
        grants: [{ ...crop.seed, quantity }]
      });
      await client.query("DELETE FROM greenhouse_plants WHERE greenhouse_id=$1 AND anchor_id=$2", [greenhouseId, anchorId]);
      await insertOperation(client, player.playerId, requestId, "clip", hash, greenhouseId);
      const state = await this.stateInTransaction(client, greenhouse, player.playerId);
      await client.query("COMMIT");
      return {
        state,
        inventory: grant.inventory,
        replayed: false,
        yieldQuantity: quantity,
        message: `Collected ${quantity} ${crop.seedDisplayName}${quantity === 1 ? "" : "s"}.`
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async harvest(player: PlayerRecord, requestId: string, greenhouseId: string, anchorId: string): Promise<GreenhouseMutationResult & { yieldQuantity: number }> {
    requireRequestId(requestId);
    await this.reconcileDuePlants();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const greenhouse = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      const hash = requestHash("harvest", player.playerId, greenhouseId, anchorId);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await this.stateInTransaction(client, greenhouse, player.playerId);
        await client.query("COMMIT");
        return { state, inventory: state.inventory, replayed: true, yieldQuantity: 0, message: "The harvest was already applied." };
      }
      const plant = await requirePlant(client, greenhouseId, anchorId, true);
      const crop = requireGreenhouseCropDefinition(plant.cropId);
      if (crop.kind === "giving_tree" && plant.resinHarvested) {
        throw new GreenhouseError("GREENHOUSE_HARVEST_UNAVAILABLE", "This Giving Tree was already tapped for resin.");
      }
      if (plant.stage !== crop.maxStage || !plant.dry) {
        throw new GreenhouseError("GREENHOUSE_HARVEST_UNAVAILABLE", `This ${crop.displayName.toLowerCase()} is not ready to harvest.`);
      }
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `greenhouse:harvest:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "greenhouse_harvest",
        sourceEntityType: "greenhouse_anchor",
        sourceEntityId: anchorId,
        metadata: { requestId, greenhouseId, anchorId },
        grants: [crop.harvest, { itemId: "mist_drop", variant: null, quantity: mistDropsForHarvest(requestId) }]
      });
      await client.query("DELETE FROM greenhouse_plants WHERE greenhouse_id=$1 AND anchor_id=$2", [greenhouseId, anchorId]);
      await insertOperation(client, player.playerId, requestId, "harvest", hash, greenhouseId);
      const state = await this.stateInTransaction(client, greenhouse, player.playerId);
      await client.query("COMMIT");
      return {
        state,
        inventory: grant.inventory,
        replayed: false,
        yieldQuantity: crop.harvest.quantity,
        message: `Harvested ${crop.harvest.quantity} ${crop.displayName}.`
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async tapTree(player: PlayerRecord, requestId: string, greenhouseId: string, anchorId: string): Promise<GreenhouseMutationResult & { yieldQuantity: number }> {
    requireRequestId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const greenhouse = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      const hash = requestHash("tap", player.playerId, greenhouseId, anchorId);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await this.stateInTransaction(client, greenhouse, player.playerId);
        await client.query("COMMIT");
        return { state, inventory: state.inventory, replayed: true, yieldQuantity: 0, message: "The tree tapping was already applied." };
      }
      const plant = await requirePlant(client, greenhouseId, anchorId, true);
      const crop = requireGreenhouseCropDefinition(plant.cropId);
      if (crop.kind !== "giving_tree" || plant.stage !== crop.maxStage) throw new GreenhouseError("GREENHOUSE_TREE_REQUIRED", "That Farm Plot does not hold a mature Giving Tree.");
      if (!plant.dry) throw new GreenhouseError("GREENHOUSE_TIMER_ACTIVE", "Wait for this tree stage to finish before tapping resin.");
      const result = await client.query<{ berries_remaining: number | null; resin_harvested: boolean }>(`SELECT berries_remaining,resin_harvested FROM greenhouse_plants WHERE greenhouse_id=$1 AND anchor_id=$2 FOR UPDATE`, [greenhouseId, anchorId]);
      const row = result.rows[0];
      if (!row) throw new GreenhouseError("GREENHOUSE_TREE_REQUIRED", "That Farm Plot no longer holds a mature Giving Tree.");
      if (row.resin_harvested) throw new GreenhouseError("GREENHOUSE_RESIN_UNAVAILABLE", "This tree has already been tapped.");
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `greenhouse:resin:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "greenhouse_giving_tree_resin",
        sourceEntityType: "greenhouse_anchor",
        sourceEntityId: anchorId,
        metadata: { requestId, greenhouseId, anchorId },
        grants: [{ itemId: "balsam_resin", variant: null, quantity: crop.resinYield ?? 1 }]
      });
      await client.query(`DELETE FROM greenhouse_plants WHERE greenhouse_id=$1 AND anchor_id=$2`, [greenhouseId, anchorId]);
      await insertOperation(client, player.playerId, requestId, "tap", hash, greenhouseId);
      const state = await this.stateInTransaction(client, greenhouse, player.playerId);
      await client.query("COMMIT");
      return { state, inventory: grant.inventory, replayed: false, yieldQuantity: crop.resinYield ?? 1, message: "Tapped 1 Frond Sap." };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async craftWaterBucket(player: PlayerRecord, requestId: string): Promise<{ inventory: Awaited<ReturnType<InventoryService["getInventorySnapshot"]>>; replayed: boolean; waterBucketGallons: number; gardeningBucketGallons: number }> {
    requireRequestId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const hash = requestHash("craft-water-bucket", player.playerId);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await bucketState(client, player.playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { inventory, replayed: true, waterBucketGallons: greenhouseWaterGallons(state.water_bucket_tenths), gardeningBucketGallons: greenhouseWaterGallons(state.gardening_bucket_tenths) };
      }
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`greenhouse-bucket-limit:${player.playerId}`]);
      const existingBucket = await client.query(
        `SELECT 1 FROM player_inventory
         WHERE player_id=$1 AND resource_type='water_bucket' AND variant='default' AND quantity>0
         LIMIT 1`,
        [player.playerId]
      );
      if (existingBucket.rows[0]) {
        throw new GreenhouseError("GREENHOUSE_WATER_BUCKET_LIMIT", "You can carry only one Water Bucket.");
      }
      const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `greenhouse:craft-water-bucket:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "greenhouse_bucket_crafting",
        sourceEntityType: "player",
        sourceEntityId: player.playerId,
        metadata: { requestId },
        debits: [{ itemId: "iron", variant: null, quantity: 10 }]
      });
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `greenhouse:craft-water-bucket-grant:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "greenhouse_bucket_crafting",
        sourceEntityType: "player",
        sourceEntityId: player.playerId,
        metadata: { requestId },
        grants: [{ itemId: "water_bucket", variant: null, quantity: 1 }]
      });
      if (grant.grants[0]?.grantedQuantity !== 1) {
        throw new GreenhouseError("GREENHOUSE_INVENTORY_CAPACITY", "Make room for the Water Bucket first.");
      }
      await ensureBucketState(client, player.playerId);
      await insertOperation(client, player.playerId, requestId, "craft-water-bucket", hash, null);
      const state = await bucketState(client, player.playerId);
      await client.query("COMMIT");
      return { inventory: grant.inventory, replayed: debit.applied === false, waterBucketGallons: greenhouseWaterGallons(state.water_bucket_tenths), gardeningBucketGallons: greenhouseWaterGallons(state.gardening_bucket_tenths) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async craftFertilizer(player: PlayerRecord, requestId: string): Promise<{
    inventory: Awaited<ReturnType<InventoryService["getInventorySnapshot"]>>;
    replayed: boolean;
  }> {
    requireRequestId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const hash = requestHash("craft-fertilizer", player.playerId);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { inventory, replayed: true };
      }
      const spendable = await spendableItemCounts(this.inventory, client, player.playerId);
      const resolved = resolveMaterialSpend("Fertilizer", GREENHOUSE_FERTILIZER_RECIPE, GREENHOUSE_FERTILIZER_CATEGORY_INPUTS, spendable, {});
      if (!resolved.ok) throw new GreenhouseError(`GREENHOUSE_${resolved.failure.code}`, resolved.failure.message);
      const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `greenhouse:craft-fertilizer:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "greenhouse_fertilizer_crafting",
        sourceEntityType: "player",
        sourceEntityId: player.playerId,
        metadata: { requestId },
        debits: resolved.debits.map((ingredient) => ({
          itemId: ingredient.itemId as ResourceType,
          variant: null,
          quantity: ingredient.quantity
        }))
      });
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `greenhouse:craft-fertilizer-grant:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "greenhouse_fertilizer_crafting",
        sourceEntityType: "player",
        sourceEntityId: player.playerId,
        metadata: { requestId },
        grants: [{ itemId: "fertilizer", variant: null, quantity: 1 }]
      });
      if (grant.grants[0]?.grantedQuantity !== 1) {
        throw new GreenhouseError("GREENHOUSE_INVENTORY_CAPACITY", "Make room for Fertilizer first.");
      }
      await insertOperation(client, player.playerId, requestId, "craft-fertilizer", hash, null);
      await client.query("COMMIT");
      return { inventory: grant.inventory, replayed: debit.applied === false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async startWaterBucketFill(player: PlayerRecord, requestId: string, target: { lat: number; lon: number }, gallons: number): Promise<{ completesAt: number; rangeM: number; gallons: number }> {
    requireRequestId(requestId);
    // Before any DB work, so a concurrent move cannot skip the cancel for a fill about to commit.
    this.waterFillStartEpoch += 1;
    this.knownIdleWaterFill.delete(player.playerId);
    if (!Number.isInteger(gallons) || gallons < 1 || gallons > 5) throw new GreenhouseError("GREENHOUSE_INVALID_GALLONS", "Choose between 1 and 5 gallons.");
    const rangeM = distanceMeters(player.position, target);
    if (rangeM > GREENHOUSE_WATER_BUCKET_MAX_RANGE_M) throw new GreenhouseError("GREENHOUSE_WATER_RANGE", `Move within ${GREENHOUSE_WATER_BUCKET_MAX_RANGE_M}m of the river (${Math.round(rangeM)}m away).`);
    const environment = await this.worldLookup.lookupGameplayEnvironment(target.lat, target.lon);
    const waterbody = await this.worldLookup.lookupCanonicalWaterbodyNear(target, environment, 0);
    if (
      !environment.ok ||
      environment.isSaltwater === true ||
      waterbody.kind !== "river" ||
      waterbody.searchComplete !== true ||
      waterbody.resolutionStatus !== "resolved" ||
      !waterbody.sourceId ||
      !Number.isFinite(waterbody.distanceM ?? Number.NaN) ||
      (waterbody.distanceM ?? Number.POSITIVE_INFINITY) > 0
    ) {
      throw new GreenhouseError("GREENHOUSE_FRESH_RIVER_REQUIRED", "Choose a fresh river water target.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const hash = requestHash("fill", player.playerId, target.lat, target.lon, gallons);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const current = await client.query<{ completes_at: Date | string; requested_tenths: number }>(
          `SELECT completes_at,requested_tenths FROM greenhouse_water_fills WHERE player_id=$1 ORDER BY created_at DESC LIMIT 1`, [player.playerId]
        );
        const row = current.rows[0];
        if (!row) throw new GreenhouseError("GREENHOUSE_FILL_MISSING", "The previous fill is no longer available.");
        await client.query("COMMIT");
        return { completesAt: new Date(row.completes_at).getTime(), rangeM, gallons: Number(row.requested_tenths) / 10 };
      }
      const bucket = await lockBucketState(client, player.playerId);
      const hasBucket = await client.query(`SELECT 1 FROM player_inventory WHERE player_id=$1 AND resource_type='water_bucket' AND variant='default' AND quantity>0`, [player.playerId]);
      if (!hasBucket.rows[0]) throw new GreenhouseError("GREENHOUSE_WATER_BUCKET_REQUIRED", "Craft a Water Bucket first.");
      if (bucket.water_bucket_tenths + gallons * 10 > GREENHOUSE_WATER_BUCKET_CAPACITY_TENTHS) throw new GreenhouseError("GREENHOUSE_WATER_BUCKET_FULL", "The Water Bucket cannot hold that much water.");
      const active = await client.query(`SELECT 1 FROM greenhouse_water_fills WHERE player_id=$1 AND status='active' LIMIT 1`, [player.playerId]);
      if (active.rows[0]) throw new GreenhouseError("GREENHOUSE_FILL_ACTIVE", "Your Water Bucket is already being filled.");
      const now = this.now();
      const completesAt = now + gallons * GREENHOUSE_WATER_BUCKET_FILL_DURATION_MS;
      await client.query(
        `INSERT INTO greenhouse_water_fills (player_id,target_lat,target_lon,requested_tenths,started_at,completes_at)
         VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),to_timestamp($6/1000.0))`,
        [player.playerId, target.lat, target.lon, gallons * 10, now, completesAt]
      );
      await insertOperation(client, player.playerId, requestId, "fill", hash, null);
      await client.query("COMMIT");
      return { completesAt, rangeM, gallons };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeWaterBucketFill(player: PlayerRecord, requestId: string): Promise<{ gallons: number; waterBucketGallons: number; inventory: Awaited<ReturnType<InventoryService["getInventorySnapshot"]>>; replayed: boolean }> {
    requireRequestId(requestId);
    const epochBefore = this.waterFillStartEpoch;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const fill = await client.query<{ fill_id: string; requested_tenths: number; completes_at: Date | string; status: string }>(
        `SELECT fill_id,requested_tenths,completes_at,status FROM greenhouse_water_fills
         WHERE player_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [player.playerId]
      );
      const row = fill.rows[0];
      if (!row) throw new GreenhouseError("GREENHOUSE_FILL_MISSING", "There is no Water Bucket fill to complete.");
      const hash = requestHash("complete-fill", player.playerId, row.fill_id);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await bucketState(client, player.playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { gallons: 0, waterBucketGallons: greenhouseWaterGallons(state.water_bucket_tenths), inventory, replayed: true };
      }
      if (row.status !== "active") throw new GreenhouseError("GREENHOUSE_FILL_NOT_ACTIVE", "That Water Bucket fill is no longer active.");
      const now = this.now();
      if (new Date(row.completes_at).getTime() > now) throw new GreenhouseError("GREENHOUSE_FILL_NOT_READY", "The Water Bucket is still filling.");
      const state = await lockBucketState(client, player.playerId);
      const credited = Math.min(Number(row.requested_tenths), GREENHOUSE_WATER_BUCKET_CAPACITY_TENTHS - state.water_bucket_tenths);
      await client.query(`UPDATE greenhouse_water_buckets SET water_bucket_tenths=water_bucket_tenths+$2,updated_at=clock_timestamp() WHERE player_id=$1`, [player.playerId, credited]);
      await client.query(`UPDATE greenhouse_water_fills SET credited_tenths=$2,status='completed',updated_at=clock_timestamp() WHERE fill_id=$1`, [row.fill_id, credited]);
      await insertOperation(client, player.playerId, requestId, "complete-fill", hash, null);
      const updated = await bucketState(client, player.playerId);
      const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      this.markWaterFillIdle(player.playerId, epochBefore);
      return { gallons: credited / 10, waterBucketGallons: greenhouseWaterGallons(updated.water_bucket_tenths), inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelWaterBucketFill(player: PlayerRecord, requestId: string): Promise<{ active: boolean; creditedGallons: number; waterBucketGallons: number; inventory: Awaited<ReturnType<InventoryService["getInventorySnapshot"]>> }> {
    requireRequestId(requestId);
    const epochBefore = this.waterFillStartEpoch;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const fill = await client.query<{ fill_id: string; requested_tenths: number; started_at: Date | string; status: string }>(
        `SELECT fill_id,requested_tenths,started_at,status FROM greenhouse_water_fills
         WHERE player_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [player.playerId]
      );
      const row = fill.rows[0];
      if (!row) {
        const state = await bucketState(client, player.playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        this.markWaterFillIdle(player.playerId, epochBefore);
        return { active: false, creditedGallons: 0, waterBucketGallons: greenhouseWaterGallons(state.water_bucket_tenths), inventory };
      }
      const now = this.now();
      const elapsed = Math.max(0, now - new Date(row.started_at).getTime());
      const credited = Math.min(Number(row.requested_tenths), Math.floor(elapsed / GREENHOUSE_WATER_BUCKET_FILL_DURATION_MS) * 10);
      const state = await lockBucketState(client, player.playerId);
      const grant = Math.min(credited, GREENHOUSE_WATER_BUCKET_CAPACITY_TENTHS - state.water_bucket_tenths);
      if (grant > 0) {
        await client.query(`UPDATE greenhouse_water_buckets SET water_bucket_tenths=water_bucket_tenths+$2,updated_at=clock_timestamp() WHERE player_id=$1`, [player.playerId, grant]);
      }
      await client.query(`UPDATE greenhouse_water_fills SET credited_tenths=$2,status='cancelled',updated_at=clock_timestamp() WHERE fill_id=$1`, [row.fill_id, grant]);
      const hash = requestHash("cancel-fill", player.playerId, row.fill_id);
      await insertOperation(client, player.playerId, requestId, "cancel-fill", hash, null);
      const updated = await bucketState(client, player.playerId);
      const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      this.markWaterFillIdle(player.playerId, epochBefore);
      return { active: true, creditedGallons: grant / 10, waterBucketGallons: greenhouseWaterGallons(updated.water_bucket_tenths), inventory };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async depositWater(player: PlayerRecord, requestId: string, greenhouseId: string): Promise<GreenhouseMutationResult> {
    return this.mutateTank(player, requestId, greenhouseId, "deposit");
  }

  async refillGardeningBucket(player: PlayerRecord, requestId: string, greenhouseId: string): Promise<GreenhouseMutationResult> {
    return this.mutateTank(player, requestId, greenhouseId, "refill");
  }

  async bucketStateForPlayer(playerId: string): Promise<{ waterBucketGallons: number; gardeningBucketGallons: number }> {
    const result = await this.pool.query<BucketRow>(`SELECT water_bucket_tenths,gardening_bucket_tenths FROM greenhouse_water_buckets WHERE player_id=$1`, [playerId]);
    const row = result.rows[0] ?? { water_bucket_tenths: 0, gardening_bucket_tenths: 0 };
    return { waterBucketGallons: greenhouseWaterGallons(Number(row.water_bucket_tenths)), gardeningBucketGallons: greenhouseWaterGallons(Number(row.gardening_bucket_tenths)) };
  }

  private async mutatePlant(
    player: PlayerRecord,
    requestId: string,
    greenhouseId: string,
    anchorId: string,
    packId: string,
    cropId: string
  ): Promise<GreenhouseMutationResult> {
    requireRequestId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const greenhouse = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      const hash = requestHash("plant", player.playerId, greenhouseId, anchorId, cropId, packId);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await this.stateInTransaction(client, greenhouse, player.playerId);
        await client.query("COMMIT");
        return { state, inventory: state.inventory, replayed: true, message: "The plant action was already applied." };
      }
      const crop = enabledGreenhouseCropDefinition(cropId);
      if (!crop) throw new GreenhouseError("GREENHOUSE_CROP_UNAVAILABLE", "That crop is not available for planting.");
      const anchor = await requireAnchor(client, greenhouseId, anchorId, true);
      if (anchor.placed === false) {
        throw new GreenhouseError("GREENHOUSE_PLACEMENT_REQUIRED", "Place this Farm Plot before planting.");
      }
      const existing = await client.query(`SELECT 1 FROM greenhouse_plants WHERE greenhouse_id=$1 AND anchor_id=$2`, [greenhouseId, anchorId]);
      if (existing.rows[0]) throw new GreenhouseError("GREENHOUSE_ANCHOR_OCCUPIED", "That Farm Plot already contains a plant.");
      const grant = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `greenhouse:plant:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "greenhouse_planting",
        sourceEntityType: "greenhouse_anchor",
        sourceEntityId: anchorId,
        metadata: { requestId, greenhouseId, anchorId, cropId: crop.cropId },
        debits: [{ ...crop.seed, quantity: crop.seed.quantity }]
      });
      await client.query(
        `INSERT INTO greenhouse_plants (anchor_id,greenhouse_id,owner_player_id,crop_id,stage,planted_at,dry,berries_remaining)
         VALUES ($1,$2,$3,$4,1,clock_timestamp(),true,$5)`,
        [anchorId, greenhouseId, player.playerId, crop.cropId, crop.kind === "giving_tree" ? crop.berryYield ?? 3 : null]
      );
      await insertOperation(client, player.playerId, requestId, "plant", hash, greenhouseId);
      const state = await this.stateInTransaction(client, greenhouse, player.playerId);
      await client.query("COMMIT");
      return { state, inventory: grant.inventory, replayed: false, message: `Planted a ${crop.seedDisplayName}. Water it to start the timer.` };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async mutateTank(player: PlayerRecord, requestId: string, greenhouseId: string, action: "deposit" | "refill"): Promise<GreenhouseMutationResult> {
    requireRequestId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const greenhouse = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      if (greenhouse.tank_placed === false) {
        throw new GreenhouseError("GREENHOUSE_TANK_NOT_PLACED", "Place the water tank before using it.");
      }
      const hash = requestHash(action, player.playerId, greenhouseId);
      const replay = await existingOperation(client, player.playerId, requestId);
      if (replay) {
        requireOperationHash(replay, hash, "GREENHOUSE_REPLAY_CONFLICT");
        const state = await this.stateInTransaction(client, greenhouse, player.playerId);
        await client.query("COMMIT");
        return { state, inventory: state.inventory, replayed: true, message: "The water action was already applied." };
      }
      const bucket = await lockBucketState(client, player.playerId);
      await requireCarriedItem(
        client,
        player.playerId,
        action === "deposit" ? "water_bucket" : "gardening_bucket",
        action === "deposit" ? "GREENHOUSE_WATER_BUCKET_REQUIRED" : "GREENHOUSE_GARDENING_BUCKET_REQUIRED",
        action === "deposit" ? "Carry your Water Bucket to deposit water." : "Carry your Gardening Bucket to refill it."
      );
      let moved = 0;
      if (action === "deposit") {
        moved = Math.min(bucket.water_bucket_tenths, GREENHOUSE_TANK_CAPACITY_TENTHS - greenhouse.tank_water_tenths);
        if (moved <= 0) throw new GreenhouseError("GREENHOUSE_TANK_FULL", "The greenhouse tank is full.");
        await client.query(`UPDATE greenhouse_water_buckets SET water_bucket_tenths=water_bucket_tenths-$2,updated_at=clock_timestamp() WHERE player_id=$1`, [player.playerId, moved]);
        await client.query(`UPDATE player_greenhouses SET tank_water_tenths=tank_water_tenths+$2,updated_at=clock_timestamp() WHERE greenhouse_id=$1`, [greenhouseId, moved]);
      } else {
        moved = Math.min(greenhouse.tank_water_tenths, GREENHOUSE_GARDENING_BUCKET_CAPACITY_TENTHS - bucket.gardening_bucket_tenths);
        if (moved <= 0) throw new GreenhouseError("GREENHOUSE_NO_WATER", "The tank has no water or your gardening bucket is full.");
        await client.query(`UPDATE greenhouse_water_buckets SET gardening_bucket_tenths=gardening_bucket_tenths+$2,updated_at=clock_timestamp() WHERE player_id=$1`, [player.playerId, moved]);
        await client.query(`UPDATE player_greenhouses SET tank_water_tenths=tank_water_tenths-$2,updated_at=clock_timestamp() WHERE greenhouse_id=$1`, [greenhouseId, moved]);
      }
      await insertOperation(client, player.playerId, requestId, action, hash, greenhouseId);
      const updatedGreenhouse = await requireOwnedGreenhouse(client, greenhouseId, player.playerId);
      const state = await this.stateInTransaction(client, updatedGreenhouse, player.playerId);
      await client.query("COMMIT");
      return { state, inventory: state.inventory, replayed: false, message: `${greenhouseWaterGallons(moved)} gallons moved.` };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async stateInTransaction(client: pg.PoolClient, greenhouse: GreenhouseRow, playerId: string): Promise<GreenhouseStateSnapshot> {
    await client.query(
      `DELETE FROM greenhouse_plants
       WHERE greenhouse_id=$1 AND crop_id='giving_berry_tree' AND resin_harvested=true`,
      [greenhouse.greenhouse_id]
    );
    const anchors = await client.query<AnchorRow>(
      `SELECT anchor.anchor_id,anchor.greenhouse_id,anchor.room_id,anchor.row_index,anchor.column_index,anchor.x,anchor.y,anchor.active,anchor.placed,anchor.custom_positioned,
         plant.crop_id,plant.stage,plant.planted_at,plant.watered_at,plant.next_stage_at,plant.dry,plant.berries_remaining,plant.resin_harvested
       FROM greenhouse_plant_anchors anchor
       LEFT JOIN greenhouse_plants plant
         ON plant.greenhouse_id=anchor.greenhouse_id AND plant.anchor_id=anchor.anchor_id
       WHERE anchor.greenhouse_id=$1 ORDER BY anchor.room_id,anchor.row_index,anchor.column_index`,
      [greenhouse.greenhouse_id]
    );
    const bucket = await bucketState(client, playerId);
    const inventory = await this.inventory.snapshotInTransaction(client, playerId);
    return {
      greenhouse: mapGreenhouse(greenhouse, anchors.rows),
      serverTime: this.now(),
      waterBucketGallons: greenhouseWaterGallons(bucket.water_bucket_tenths),
      gardeningBucketGallons: greenhouseWaterGallons(bucket.gardening_bucket_tenths),
      inventory
    };
  }

  private async snapshotForRow(row: GreenhouseRow, queryable: Queryable = this.pool): Promise<GreenhouseSnapshot> {
    const anchors = await queryable.query<AnchorRow>(
      `SELECT anchor.anchor_id,anchor.greenhouse_id,anchor.room_id,anchor.row_index,anchor.column_index,anchor.x,anchor.y,anchor.active,anchor.placed,anchor.custom_positioned,
         plant.crop_id,plant.stage,plant.planted_at,plant.watered_at,plant.next_stage_at,plant.dry,plant.berries_remaining,plant.resin_harvested
       FROM greenhouse_plant_anchors anchor
       LEFT JOIN greenhouse_plants plant
         ON plant.greenhouse_id=anchor.greenhouse_id AND plant.anchor_id=anchor.anchor_id
       WHERE anchor.greenhouse_id=$1 ORDER BY anchor.room_id,anchor.row_index,anchor.column_index`,
      [row.greenhouse_id]
    );
    return mapGreenhouse(row, anchors.rows);
  }
}

const GREENHOUSE_RETURNING_FIELDS = `greenhouse_id,owner_player_id,
  (SELECT username FROM players WHERE players.id=owner_player_id) AS owner_username,
  world_id,region_code,lat,lon,placement_revision,room_count,planter_capacity,tank_water_tenths,tank_placed,tank_x,tank_y,
  is_riverbank,riverbank_policy,riverbank_distance_m,eligibility_checked_at,built_at`;
const GREENHOUSE_SELECT_FIELDS = `greenhouse.greenhouse_id,greenhouse.owner_player_id,
  (SELECT username FROM players WHERE players.id=greenhouse.owner_player_id) AS owner_username,
  greenhouse.world_id,greenhouse.region_code,greenhouse.lat,greenhouse.lon,greenhouse.placement_revision,
  greenhouse.room_count,greenhouse.planter_capacity,greenhouse.tank_water_tenths,
  greenhouse.tank_placed,greenhouse.tank_x,greenhouse.tank_y,
  greenhouse.is_riverbank,greenhouse.riverbank_policy,greenhouse.riverbank_distance_m,
  greenhouse.eligibility_checked_at,greenhouse.built_at`;
const GREENHOUSE_SELECT = `SELECT ${GREENHOUSE_SELECT_FIELDS} FROM player_greenhouses greenhouse`;

function mapGreenhouse(row: GreenhouseRow, anchors: readonly AnchorRow[]): GreenhouseSnapshot {
  return {
    greenhouseId: row.greenhouse_id,
    ownerPlayerId: row.owner_player_id,
    ...(row.owner_username === undefined ? {} : { ownerUsername: row.owner_username }),
    regionCode: row.region_code,
    lat: Number(row.lat),
    lon: Number(row.lon),
    builtAt: new Date(row.built_at).toISOString(),
    placementRevision: Number(row.placement_revision),
    roomCount: Number(row.room_count),
    planterCapacity: Number(row.planter_capacity),
    tankWaterTenths: Number(row.tank_water_tenths),
    tankCapacityTenths: GREENHOUSE_TANK_CAPACITY_TENTHS,
    eligibility: {
      isRiverbank: row.is_riverbank,
      policyId: row.riverbank_policy,
      policyDistanceM: Number(row.riverbank_distance_m),
      checkedAt: new Date(row.eligibility_checked_at).toISOString()
    },
    anchors: anchors.map(mapAnchor),
    waterStorage: {
      ...GREENHOUSE_STUDIO_CATALOG.waterStorage,
      x: row.tank_x === null || row.tank_x === undefined ? GREENHOUSE_STUDIO_CATALOG.waterStorage.x : Number(row.tank_x),
      y: row.tank_y === null || row.tank_y === undefined ? GREENHOUSE_STUDIO_CATALOG.waterStorage.y : Number(row.tank_y),
      placed: row.tank_placed !== false
    }
  };
}

function mapAnchor(row: AnchorRow): GreenhouseAnchorSnapshot {
  const authored = GREENHOUSE_STUDIO_CATALOG.anchors.find((anchor) => anchor.anchorId === row.anchor_id);
  return {
    anchorId: row.anchor_id,
    roomId: authored?.roomId ?? row.room_id,
    row: authored?.row ?? Number(row.row_index),
    column: authored?.column ?? Number(row.column_index),
    x: row.placed || row.custom_positioned ? Number(row.x) : (authored?.x ?? Number(row.x)),
    y: row.placed || row.custom_positioned ? Number(row.y) : (authored?.y ?? Number(row.y)),
    active: row.active,
    placed: row.placed !== false,
    plant: row.stage === null ? null : mapPlant(row)
  };
}

function mapPlant(row: AnchorRow): GreenhousePlantSnapshot {
  if (!row.crop_id) throw new GreenhouseError("GREENHOUSE_CROP_UNAVAILABLE", "The planted crop is unavailable.");
  const crop = requireGreenhouseCropDefinition(row.crop_id);
  const stage = row.stage as GreenhousePlantStage;
  return {
    anchorId: row.anchor_id,
    cropId: crop.cropId,
    stage,
    artId: crop.stageArtIds[stage],
    plantedAt: new Date(row.planted_at!).toISOString(),
    wateredAt: row.watered_at ? new Date(row.watered_at).toISOString() : null,
    nextStageAt: row.next_stage_at ? new Date(row.next_stage_at).toISOString() : null,
    dry: row.dry === true,
    berriesRemaining: row.berries_remaining ?? null,
    resinHarvested: row.resin_harvested === true
  };
}

function requireGreenhouseCropDefinition(cropId: string): GreenhouseCropDefinition {
  const crop = greenhouseCropDefinition(cropId);
  if (!crop) throw new GreenhouseError("GREENHOUSE_CROP_UNAVAILABLE", "The planted crop is unavailable.");
  return crop;
}

function greenhouseCropStageDurationMs(crop: GreenhouseCropDefinition, isRiverbank: boolean): number {
  return crop.stageDurationMs[isRiverbank ? "riverbank" : "inland"];
}

function mapBuild(row: BuildRow): GreenhouseBuildSnapshot {
  const startedAt = new Date(row.started_at).getTime();
  const completesAt = new Date(row.completes_at).getTime();
  return {
    buildId: row.build_id,
    position: { lat: Number(row.lat), lon: Number(row.lon) },
    eligibility: {
      isRiverbank: row.is_riverbank,
      policyId: row.riverbank_policy,
      policyDistanceM: Number(row.riverbank_distance_m),
      checkedAt: new Date(row.eligibility_checked_at).toISOString()
    },
    startedAt,
    completesAt,
    durationMs: completesAt - startedAt
  };
}

function eligibilitySnapshot(isRiverbank: boolean, nowMs: number): GreenhouseEligibilitySnapshot {
  return {
    isRiverbank,
    policyId: GREENHOUSE_RIVERBANK_POLICY_ID,
    policyDistanceM: GREENHOUSE_RIVERBANK_POLICY_DISTANCE_M,
    checkedAt: new Date(nowMs).toISOString()
  };
}

async function insertInitialAnchors(queryable: Queryable, greenhouseId: string): Promise<void> {
  const anchors = greenhouseInitialAnchors();
  for (const anchor of anchors) {
    await queryable.query(
      `INSERT INTO greenhouse_plant_anchors (anchor_id,greenhouse_id,room_id,row_index,column_index,x,y,placed,custom_positioned)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [anchor.anchorId, greenhouseId, anchor.roomId, anchor.row, anchor.column, anchor.x, anchor.y, anchor.placed !== false, false]
    );
  }
  if (anchors.length !== GREENHOUSE_INITIAL_ANCHOR_COUNT) throw new GreenhouseError("GREENHOUSE_ANCHOR_CONFLICT", "Greenhouse Farm Plot layout is invalid.");
}

async function placedOccupants(
  queryable: Queryable,
  greenhouse: GreenhouseRow,
  excludeAnchorId?: string,
  excludeTank = false
): Promise<Array<{ kind: GreenhousePlacementKind; x: number; y: number }>> {
  const result = await queryable.query<Pick<AnchorRow, "anchor_id" | "x" | "y" | "placed" | "custom_positioned">>(
    `SELECT anchor_id,x,y,placed,custom_positioned
     FROM greenhouse_plant_anchors
     WHERE greenhouse_id=$1 AND active=true AND placed=true
       AND ($2::text IS NULL OR anchor_id<>$2)`,
    [greenhouse.greenhouse_id, excludeAnchorId ?? null]
  );
  const occupants: Array<{ kind: GreenhousePlacementKind; x: number; y: number }> = result.rows.map((row) => {
    return {
      kind: "pot",
      x: Number(row.x),
      y: Number(row.y)
    };
  });
  if (greenhouse.tank_placed !== false && !excludeTank) {
    occupants.push({
      kind: "water_tank",
      x: greenhouse.tank_x === null || greenhouse.tank_x === undefined ? GREENHOUSE_STUDIO_CATALOG.waterStorage.x : Number(greenhouse.tank_x),
      y: greenhouse.tank_y === null || greenhouse.tank_y === undefined ? GREENHOUSE_STUDIO_CATALOG.waterStorage.y : Number(greenhouse.tank_y)
    });
  }
  return occupants;
}

async function requireGreenhouse(queryable: Queryable, greenhouseId: string): Promise<GreenhouseRow> {
  const result = await queryable.query<GreenhouseRow>(`${GREENHOUSE_SELECT} WHERE greenhouse.greenhouse_id=$1 AND greenhouse.removed_at IS NULL`, [greenhouseId]);
  const row = result.rows[0];
  if (!row) throw new GreenhouseError("GREENHOUSE_NOT_FOUND", "Greenhouse no longer exists.");
  return row;
}

async function requireOwnedGreenhouse(queryable: Queryable, greenhouseId: string, playerId: string): Promise<GreenhouseRow> {
  const result = await queryable.query<GreenhouseRow>(`${GREENHOUSE_SELECT} WHERE greenhouse.greenhouse_id=$1 AND greenhouse.owner_player_id=$2 AND greenhouse.removed_at IS NULL FOR UPDATE`, [greenhouseId, playerId]);
  const row = result.rows[0];
  if (!row) throw new GreenhouseError("GREENHOUSE_OWNER_REQUIRED", "Only the greenhouse owner can use this greenhouse.");
  return row;
}

async function requireAnchor(queryable: Queryable, greenhouseId: string, anchorId: string, lock: boolean): Promise<AnchorRow> {
  const result = await queryable.query<AnchorRow>(`SELECT anchor_id,greenhouse_id,room_id,row_index,column_index,x,y,active,placed,custom_positioned,NULL::text AS crop_id,NULL::integer AS stage,NULL::timestamptz AS planted_at,NULL::timestamptz AS watered_at,NULL::timestamptz AS next_stage_at,NULL::boolean AS dry,NULL::integer AS berries_remaining,NULL::boolean AS resin_harvested FROM greenhouse_plant_anchors WHERE greenhouse_id=$1 AND anchor_id=$2${lock ? " FOR UPDATE" : ""}`, [greenhouseId, anchorId]);
  const row = result.rows[0];
  if (!row || !row.active) throw new GreenhouseError("GREENHOUSE_ANCHOR_NOT_FOUND", "That Farm Plot is not available.");
  return row;
}

async function requirePlant(queryable: Queryable, greenhouseId: string, anchorId: string, lock: boolean): Promise<{ cropId: string; stage: number; dry: boolean; resinHarvested: boolean }> {
  const result = await queryable.query<{ crop_id: string; stage: number; dry: boolean; resin_harvested: boolean }>(`SELECT crop_id,stage,dry,resin_harvested FROM greenhouse_plants WHERE greenhouse_id=$1 AND anchor_id=$2${lock ? " FOR UPDATE" : ""}`, [greenhouseId, anchorId]);
  const row = result.rows[0];
  if (!row) throw new GreenhouseError("GREENHOUSE_PLANT_REQUIRED", "That Farm Plot is empty.");
  return { cropId: row.crop_id, stage: row.stage, dry: row.dry, resinHarvested: row.resin_harvested };
}

async function activeBuild(queryable: Queryable, playerId: string): Promise<boolean> {
  return Boolean(await activeBuildRow(queryable, playerId));
}

async function activeBuildRow(queryable: Queryable, playerId: string, lock = false): Promise<BuildRow | null> {
  const result = await queryable.query<BuildRow>(
    `SELECT build_id,owner_player_id,request_id,request_hash,world_id,region_code,lat,lon,
       is_riverbank,riverbank_policy,riverbank_distance_m,eligibility_checked_at,
       status,started_at,completes_at,greenhouse_id
     FROM greenhouse_build_jobs
     WHERE owner_player_id=$1 AND status='constructing'
     ORDER BY started_at DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [playerId]
  );
  return result.rows[0] ?? null;
}

async function hasActiveGreenhouse(queryable: Queryable, playerId: string): Promise<boolean> {
  const result = await queryable.query(`SELECT 1 FROM player_greenhouses WHERE owner_player_id=$1 AND removed_at IS NULL LIMIT 1`, [playerId]);
  return Boolean(result.rows[0]);
}

async function buildForRequest(queryable: Queryable, playerId: string, requestId: string): Promise<BuildRow | null> {
  const result = await queryable.query<BuildRow>(`SELECT build_id,owner_player_id,request_id,request_hash,world_id,region_code,lat,lon,is_riverbank,riverbank_policy,riverbank_distance_m,eligibility_checked_at,status,started_at,completes_at,greenhouse_id FROM greenhouse_build_jobs WHERE owner_player_id=$1 AND request_id=$2`, [playerId, requestId]);
  return result.rows[0] ?? null;
}

async function existingOperation(queryable: Queryable, playerId: string, requestId: string): Promise<OperationRow | null> {
  const result = await queryable.query<OperationRow>(`SELECT action,request_hash,result FROM greenhouse_operations WHERE player_id=$1 AND request_id=$2`, [playerId, requestId]);
  return result.rows[0] ?? null;
}

async function insertOperation(
  queryable: Queryable,
  playerId: string,
  requestId: string,
  action: string,
  requestHashValue: string,
  greenhouseId: string | null,
  result: unknown = {}
): Promise<void> {
  await queryable.query(
    `INSERT INTO greenhouse_operations (operation_key,player_id,request_id,action,request_hash,greenhouse_id,result)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [`greenhouse:${playerId}:${requestId}`, playerId, requestId, action, requestHashValue, greenhouseId, JSON.stringify(result)]
  );
}

async function ensureBucketState(queryable: Queryable, playerId: string): Promise<void> {
  await queryable.query(`INSERT INTO greenhouse_water_buckets (player_id) VALUES ($1) ON CONFLICT (player_id) DO NOTHING`, [playerId]);
}

async function requireCarriedItem(
  queryable: Queryable,
  playerId: string,
  itemId: "gardening_bucket" | "water_bucket",
  code: string,
  message: string
): Promise<void> {
  const result = await queryable.query(
    `SELECT 1 FROM player_inventory
     WHERE player_id=$1 AND resource_type=$2 AND variant='default' AND quantity>0
     LIMIT 1`,
    [playerId, itemId]
  );
  if (!result.rows[0]) throw new GreenhouseError(code, message);
}

async function lockBucketState(queryable: Queryable, playerId: string): Promise<BucketRow> {
  await ensureBucketState(queryable, playerId);
  const result = await queryable.query<BucketRow>(`SELECT water_bucket_tenths,gardening_bucket_tenths FROM greenhouse_water_buckets WHERE player_id=$1 FOR UPDATE`, [playerId]);
  const row = result.rows[0];
  if (!row) throw new GreenhouseError("GREENHOUSE_BUCKET_STATE_MISSING", "Bucket state is unavailable.");
  return { water_bucket_tenths: Number(row.water_bucket_tenths), gardening_bucket_tenths: Number(row.gardening_bucket_tenths) };
}

async function bucketState(queryable: Queryable, playerId: string): Promise<BucketRow> {
  const result = await queryable.query<BucketRow>(`SELECT water_bucket_tenths,gardening_bucket_tenths FROM greenhouse_water_buckets WHERE player_id=$1`, [playerId]);
  const row = result.rows[0];
  return row ? { water_bucket_tenths: Number(row.water_bucket_tenths), gardening_bucket_tenths: Number(row.gardening_bucket_tenths) } : { water_bucket_tenths: 0, gardening_bucket_tenths: 0 };
}

async function lockOperation(queryable: pg.PoolClient, playerId: string, requestId: string): Promise<void> {
  await queryable.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`greenhouse-operation:${playerId}:${requestId}`]);
}

function requireOperationHash(operation: OperationRow, hash: string, code: string): void {
  if (operation.request_hash !== hash) throw new GreenhouseError(code, "That request ID was already used for a different Greenhouse action.");
}

function requestHash(action: string, ...parts: Array<string | number>): string {
  return createHash("sha256").update(JSON.stringify([action, ...parts])).digest("hex");
}

function requireRequestId(requestId: string): void {
  if (!requestId || requestId.length > 128) throw new GreenhouseError("GREENHOUSE_INVALID_REQUEST", "A valid request ID is required.");
}

function requirePosition(player: PlayerRecord): void {
  if (!Number.isFinite(player.position.lat) || !Number.isFinite(player.position.lon)) throw new GreenhouseError("GREENHOUSE_INVALID_POSITION", "Your world position is unavailable.");
}

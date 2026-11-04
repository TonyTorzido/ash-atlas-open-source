import { createHash, randomUUID } from "node:crypto";

import {
  LOOM_BUILD_COST,
  LOOM_BUILD_DURATION_MS,
  LOOM_INTERACTION_RADIUS_M,
  LOOM_MAX_MANOR_DISTANCE_M,
  LOOM_QUEUE_CAPACITY,
  LOOM_SNAPSHOT_RADIUS_M,
  loomOutputQuantity,
  requireLoomRecipe,
  type DroppedItemSnapshot,
  type LoomBuildSnapshot,
  type LoomJobSnapshot,
  type LoomRecipeId,
  type LoomStateSnapshot,
  type LoomWorldSnapshot,
  type PlayerInventorySnapshot,
  artificerBulkBonusItems,
  artificerCraftDurationMs,
} from "@ash-atlas/shared";
import type pg from "pg";

import { activeSpecializationRank } from "./skills/activeSpecialization.js";
import type { InventoryService } from "./inventory.js";
import { breakdownGuardFailure, spendableItemCounts } from "./materialSpend.js";
import { createSystemGroundDropsInTransaction } from "./droppedItems.js";
import type { PlayerRecord } from "./state.js";
import { requireOutdoorStationClearance } from "./stationPlacementClearance.js";

type LoomRow = {
  loom_id: string;
  manor_id: string;
  owner_player_id: string;
  owner_username: string;
  region_code: string;
  lat: number;
  lon: number;
  built_at: Date | string;
  placement_revision: string;
};

type JobRow = {
  job_id: string;
  loom_id: string;
  owner_player_id: string;
  recipe_id: LoomRecipeId;
  requested_input_quantity: number;
  output_quantity: number;
  collected_quantity: number;
  started_at: Date | string;
  completes_at: Date | string;
  cleared_at: Date | string | null;
};

type OperationRow = {
  action: "build" | "start" | "collect";
  request_hash: string;
  loom_id: string;
  job_id: string | null;
  result_quantity: number;
};

type BuildRow = {
  build_id: string;
  owner_player_id: string;
  request_id: string;
  request_hash: string;
  manor_id: string;
  world_id: string;
  region_code: string;
  lat: number;
  lon: number;
  status: "constructing" | "completed" | "cancelled";
  started_at: Date | string;
  completes_at: Date | string;
  loom_id: string | null;
  cancel_reason: string | null;
};

export class LoomError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LoomError";
  }
}

export type LoomMutationResult = Readonly<{
  state: LoomStateSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

export type LoomCollectionResult = LoomMutationResult & Readonly<{
  collectedQuantity: number;
}>;

export type LoomBuildRequestResult =
  | Readonly<{
      status: "constructing";
      build: LoomBuildSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
    }>
  | Readonly<{
      status: "completed";
      loom: LoomWorldSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: true;
    }>
  | Readonly<{
      status: "cancelled";
      buildId: string;
      inventory: PlayerInventorySnapshot;
      replayed: true;
    }>;

export type LoomBuildCompletion = Readonly<{
  playerId: string;
  requestId: string;
  loom: LoomWorldSnapshot;
  inventory: PlayerInventorySnapshot;
}>;

export type LoomBuildCancellation = Readonly<{
  playerId: string;
  requestId: string;
  buildId: string;
  inventory: PlayerInventorySnapshot;
  droppedItems: DroppedItemSnapshot[];
  reason: string;
}>;

export class LoomService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly worldId: string,
    private readonly inventory: Pick<
      InventoryService,
      | "debitItemsForOperationInTransaction"
      | "grantItemsForOperationInTransaction"
      | "snapshotInTransaction"
    >,
    private readonly now: () => number = Date.now
  ) {}

  async listNear(
    player: PlayerRecord,
    radiusM = LOOM_SNAPSHOT_RADIUS_M
  ): Promise<LoomWorldSnapshot[]> {
    const result = await this.pool.query<LoomRow>(
      `${LOOM_SELECT}
       WHERE loom.removed_at IS NULL
         AND loom.world_id=$1 AND loom.region_code=$2
         AND ST_DWithin(
           loom.geom::geography,
           ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
           $5
         )
       ORDER BY ST_Distance(
         loom.geom::geography,
         ST_SetSRID(ST_MakePoint($3,$4),4326)::geography
       ),loom.loom_id`,
      [
        this.worldId,
        player.regionCode,
        player.position.lon,
        player.position.lat,
        Math.min(Math.max(radiusM, 1), LOOM_SNAPSHOT_RADIUS_M)
      ]
    );
    return result.rows.map(mapLoom);
  }

  async build(player: PlayerRecord, requestId: string): Promise<LoomBuildRequestResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const hash = requestHash("build", player.playerId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      await lockBuildChannel(client, player.playerId);
      const replay = await buildForRequest(client, player.playerId, requestId);
      if (replay) {
        if (replay.request_hash !== hash) {
          throw new LoomError("LOOM_REPLAY_CONFLICT", "The Loom request ID was already used.");
        }
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        if (replay.status === "completed" && replay.loom_id) {
          const loom = await requireLoom(client, replay.loom_id);
          await client.query("COMMIT");
          return { status: "completed", loom: mapLoom(loom), inventory, replayed: true };
        }
        if (replay.status === "cancelled") {
          await client.query("COMMIT");
          return { status: "cancelled", buildId: replay.build_id, inventory, replayed: true };
        }
        await client.query("COMMIT");
        return { status: "constructing", build: mapBuild(replay), inventory, replayed: true };
      }
      const active = await activeBuild(client, player.playerId, true);
      if (active) {
        throw new LoomError(
          "LOOM_BUILD_ACTIVE",
          "Finish or cancel the current Loom construction first."
        );
      }
      if ((await client.query(
        "SELECT 1 FROM furnace_build_jobs WHERE owner_player_id=$1 AND status='constructing' LIMIT 1",
        [player.playerId]
      )).rows[0]) {
        throw new LoomError(
          "LOOM_BUILD_ACTIVE",
          "Finish or cancel the current Furnace construction first."
        );
      }
      if ((await client.query(
        "SELECT 1 FROM tannery_build_jobs WHERE owner_player_id=$1 AND status='constructing' LIMIT 1",
        [player.playerId]
      )).rows[0]) {
        throw new LoomError(
          "LOOM_BUILD_ACTIVE",
          "Finish or cancel the current Tannery construction first."
        );
      }
      if ((await client.query(
        "SELECT 1 FROM kitchen_build_jobs WHERE owner_player_id=$1 AND status='constructing' LIMIT 1",
        [player.playerId]
      )).rows[0]) {
        throw new LoomError(
          "LOOM_BUILD_ACTIVE",
          "Finish or cancel the current Kitchen construction first."
        );
      }
      if (await hasActiveLoom(client, player.playerId)) {
        throw new LoomError(
          "LOOM_OWNER_LIMIT",
          "You may only own one Loom."
        );
      }
      const manor = await client.query<{ id: string; world_lat: number; world_lon: number }>(
        `SELECT id,world_lat,world_lon
         FROM player_manors
         WHERE owner_player_id=$1 AND built_at IS NOT NULL
           AND world_region_code=$2
           AND ST_DWithin(
             geom::geography,
             ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
             $5
           )
         FOR SHARE`,
        [
          player.playerId,
          player.regionCode,
          player.position.lon,
          player.position.lat,
          LOOM_MAX_MANOR_DISTANCE_M
        ]
      );
      if (!manor.rows[0]) {
        throw new LoomError(
          "LOOM_MANOR_RANGE_REQUIRED",
          "Looms must be built within 650m of your Manor."
        );
      }
      await requireOutdoorStationClearance(client, this.worldId, player.regionCode, player.position, {
        manorCenter: { lat: Number(manor.rows[0].world_lat), lon: Number(manor.rows[0].world_lon) },
        maxManorDistanceM: LOOM_MAX_MANOR_DISTANCE_M,
        movementAnchor: player.anchor,
        moveLeashRadiusM: player.moveLeashRadiusM
      });
      const buildId = randomUUID();
      const startedAt = this.now();
      const completesAt = startedAt + LOOM_BUILD_DURATION_MS;
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `loom:build:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "loom_construction",
          sourceEntityType: "loom_build",
          sourceEntityId: buildId,
          metadata: { requestId },
          debits: [
            { itemId: "stone", variant: null, quantity: LOOM_BUILD_COST.stone },
            { itemId: "wood", variant: null, quantity: LOOM_BUILD_COST.wood }
          ]
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new LoomError(
            "LOOM_BUILD_MATERIALS_REQUIRED",
            `Building a Loom requires ${LOOM_BUILD_COST.wood} Wood and ${LOOM_BUILD_COST.stone} Stone.`
          );
        }
        throw error;
      }
      const inserted = await client.query<BuildRow>(
        `INSERT INTO loom_build_jobs (
           build_id,owner_player_id,request_id,request_hash,manor_id,
           world_id,region_code,lat,lon,geom,started_at,completes_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,
           ST_SetSRID(ST_MakePoint($9,$8),4326),
           to_timestamp($10 / 1000.0),to_timestamp($11 / 1000.0)
         )
         RETURNING ${BUILD_RETURNING_FIELDS}`,
        [
          buildId,
          player.playerId,
          requestId,
          hash,
          manor.rows[0].id,
          this.worldId,
          player.regionCode,
          player.position.lat,
          player.position.lon,
          startedAt,
          completesAt
        ]
      );
      const build = requireRow(inserted.rows[0], "Loom construction could not be started");
      await client.query("COMMIT");
      return { status: "constructing", build: mapBuild(build), inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async activeBuildForPlayer(playerId: string): Promise<Readonly<{
    requestId: string;
    build: LoomBuildSnapshot;
    inventory: PlayerInventorySnapshot;
  }> | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await activeBuild(client, playerId, false);
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

  async cancelBuildForMovement(playerId: string): Promise<LoomBuildCancellation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockBuildChannel(client, playerId);
      const build = await activeBuild(client, playerId, true);
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

  async reconcileDueBuilds(limit = 100): Promise<Readonly<{
    completed: LoomBuildCompletion[];
    cancelled: LoomBuildCancellation[];
  }>> {
    const due = await this.pool.query<{ build_id: string }>(
      `SELECT build_id
       FROM loom_build_jobs
       WHERE status='constructing' AND completes_at <= clock_timestamp()
       ORDER BY completes_at,build_id
       LIMIT $1`,
      [limit]
    );
    const completed: LoomBuildCompletion[] = [];
    const cancelled: LoomBuildCancellation[] = [];
    for (const { build_id: buildId } of due.rows) {
      const result = await this.completeBuild(buildId);
      if (!result) continue;
      if ("loom" in result) completed.push(result);
      else cancelled.push(result);
    }
    return { completed, cancelled };
  }

  private async completeBuild(
    buildId: string
  ): Promise<LoomBuildCompletion | LoomBuildCancellation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ owner_player_id: string }>(
        `SELECT owner_player_id
         FROM loom_build_jobs
         WHERE build_id=$1::uuid`,
        [buildId]
      );
      if (!owner.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      await lockBuildChannel(client, owner.rows[0].owner_player_id);
      const selected = await client.query<BuildRow>(
        `SELECT ${BUILD_RETURNING_FIELDS}
         FROM loom_build_jobs
         WHERE build_id=$1::uuid
         FOR UPDATE`,
        [buildId]
      );
      const build = selected.rows[0];
      if (!build || build.status !== "constructing" || Date.parse(String(build.completes_at)) > this.now()) {
        await client.query("COMMIT");
        return null;
      }
      const manor = await client.query<{ id: string }>(
        `SELECT manor.id
         FROM player_manors manor
         WHERE manor.id=$1::uuid
           AND manor.owner_player_id=$2
           AND manor.built_at IS NOT NULL
           AND manor.world_region_code=$3
           AND ST_DWithin(
             manor.geom::geography,
             ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,
             $6
           )
         FOR SHARE OF manor`,
        [
          build.manor_id,
          build.owner_player_id,
          build.region_code,
          build.lon,
          build.lat,
          LOOM_MAX_MANOR_DISTANCE_M
        ]
      );
      if (!manor.rows[0]) {
        const cancelled = await this.cancelBuildInTransaction(client, build, "revalidation-failed");
        await client.query("COMMIT");
        return cancelled;
      }
      if (await hasActiveLoom(client, build.owner_player_id)) {
        const cancelled = await this.cancelBuildInTransaction(client, build, "owner-limit");
        await client.query("COMMIT");
        return cancelled;
      }
      const inserted = await client.query<{ loom_id: string }>(
        `INSERT INTO player_looms (
           manor_id,owner_player_id,world_id,region_code,lat,lon,geom,built_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,
           ST_SetSRID(ST_MakePoint($6,$5),4326),$7
         )
         RETURNING loom_id`,
        [
          build.manor_id,
          build.owner_player_id,
          build.world_id,
          build.region_code,
          build.lat,
          build.lon,
          build.completes_at
        ]
      );
      const loomId = requireRow(inserted.rows[0], "Loom placement failed").loom_id;
      await client.query(
        `UPDATE loom_build_jobs
         SET status='completed',loom_id=$2::uuid,updated_at=clock_timestamp()
         WHERE build_id=$1::uuid`,
        [build.build_id, loomId]
      );
      await client.query(
        `INSERT INTO loom_operations (
           operation_key,player_id,request_id,action,request_hash,loom_id
         ) VALUES ($1,$2,$3,'build',$4,$5)`,
        [
          operationKey(build.owner_player_id, build.request_id),
          build.owner_player_id,
          build.request_id,
          build.request_hash,
          loomId
        ]
      );
      const loom = await requireLoom(client, loomId);
      const inventory = await this.inventory.snapshotInTransaction(client, build.owner_player_id);
      await client.query("COMMIT");
      return {
        playerId: build.owner_player_id,
        requestId: build.request_id,
        loom: mapLoom(loom),
        inventory
      };
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
    reason: string
  ): Promise<LoomBuildCancellation> {
    const refund = await this.inventory.grantItemsForOperationInTransaction(client, {
      operationKey: `loom:build:${build.owner_player_id}:${build.request_id}:refund`,
      playerId: build.owner_player_id,
      source: "loom_construction_cancelled",
      sourceEntityType: "loom_build",
      sourceEntityId: build.build_id,
      metadata: { requestId: build.request_id, reason },
      allowPartial: true,
      grants: [
        { itemId: "stone", variant: null, quantity: LOOM_BUILD_COST.stone },
        { itemId: "wood", variant: null, quantity: LOOM_BUILD_COST.wood }
      ]
    });
    const costLines = [
      { itemId: "stone", quantity: LOOM_BUILD_COST.stone },
      { itemId: "wood", quantity: LOOM_BUILD_COST.wood }
    ] as const;
    const droppedItems = await createSystemGroundDropsInTransaction(client, {
      operationKey: `loom:build:${build.owner_player_id}:${build.request_id}:refund-drop`,
      droppedByPlayerId: build.owner_player_id,
      regionCode: build.region_code,
      position: { lat: build.lat, lon: build.lon },
      reason: "loom_construction_cancelled",
      lines: costLines.flatMap((line) => {
        const granted = refund.grants.find((candidate) => candidate.itemId === line.itemId)
          ?.grantedQuantity ?? 0;
        const quantity = line.quantity - granted;
        return quantity > 0 ? [{ itemId: line.itemId, variant: null, quantity }] : [];
      })
    });
    await client.query(
      `UPDATE loom_build_jobs
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
      reason
    };
  }

  async state(player: PlayerRecord, loomId: string): Promise<LoomStateSnapshot> {
    const loom = await this.requireInRange(this.pool, player, loomId, false);
    const jobs = await currentJobs(this.pool, loomId);
    return stateSnapshot(
      mapLoom(loom),
      jobs.filter((job) => job.owner_player_id === player.playerId),
      this.now(),
      jobs.length
    );
  }

  async start(
    player: PlayerRecord,
    requestId: string,
    loomId: string,
    recipeId: LoomRecipeId,
    quantity: number,
    confirmHighGrade?: boolean
  ): Promise<LoomMutationResult> {
    requireRequestId(requestId);
    const recipe = requireLoomRecipe(recipeId);
    requireRecipeQuantity(recipeId, quantity);
    requirePosition(player);
    const hash = requestHash("start", player.playerId, loomId, recipeId, quantity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "start", hash);
        const loom = await this.requireInRange(client, player, replay.loom_id, false);
        const jobs = await currentJobs(client, loom.loom_id);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return {
          state: stateSnapshot(
            mapLoom(loom),
            jobs.filter((job) => job.owner_player_id === player.playerId),
            this.now(),
            jobs.length
          ),
          inventory,
          replayed: true
        };
      }
      const loom = await this.requireInRange(client, player, loomId, true);
      const jobs = await currentJobs(client, loomId);
      if (jobs.length >= LOOM_QUEUE_CAPACITY) {
        throw new LoomError(
          "LOOM_QUEUE_FULL",
          "The Loom queue is full. Collect a finished batch before adding another."
        );
      }
      if (recipe.breakdownGrade !== undefined) {
        const guard = breakdownGuardFailure(recipe.inputItemId, quantity, confirmHighGrade);
        if (guard) throw new LoomError(guard.code, guard.message);
        const spendable = await spendableItemCounts(this.inventory, client, player.playerId);
        if ((spendable.get(recipe.inputItemId) ?? 0) < quantity) {
          throw new LoomError(
            "LOOM_MATERIALS_REQUIRED",
            `${recipe.displayName} needs ${quantity} ${recipe.inputDisplayName} you can spend (kept items are not used).`
          );
        }
      }
      const inputs = [{
        itemId: recipe.inputItemId,
        displayName: recipe.inputDisplayName,
        quantity
      }] as const;
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `loom:start:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "loom_processing",
          sourceEntityType: "loom",
          sourceEntityId: loomId,
          metadata: { requestId, recipeId, quantity },
          debits: inputs.map((input) => ({
            itemId: input.itemId,
            variant: null,
            quantity: input.quantity
          }))
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new LoomError(
            "LOOM_MATERIALS_REQUIRED",
            `${recipe.displayName} requires ${inputs.map((input) => `${input.quantity} ${input.displayName}`).join(" and ")}.`
          );
        }
        throw error;
      }
      const nowMs = this.now();
      const scheduledStartMs = jobs.reduce(
        (tailMs, queuedJob) => Math.max(tailMs, jobFinishesAt(queuedJob)),
        nowMs
      );
      const artificerRank = await activeSpecializationRank(client, player.playerId, "artificer");
      const baseOutputQuantity = loomOutputQuantity(recipeId, quantity);
      const bonusQuantity = artificerBulkBonusItems(baseOutputQuantity, artificerRank);
      const outputQuantity = baseOutputQuantity + bonusQuantity;
      const completesAtMs = scheduledStartMs + artificerCraftDurationMs(recipe.durationMs, artificerRank);
      const inserted = await client.query<JobRow>(
        `INSERT INTO loom_jobs (
           loom_id,owner_player_id,recipe_id,requested_input_quantity,output_quantity,
           started_at,completes_at,bonus_quantity
         ) VALUES ($1,$2,$3,$4,$5,to_timestamp($6 / 1000.0),to_timestamp($7 / 1000.0),$8)
         RETURNING job_id,loom_id,owner_player_id,recipe_id,requested_input_quantity,
           output_quantity,collected_quantity,started_at,completes_at,cleared_at`,
        [loomId, player.playerId, recipeId, quantity, outputQuantity, scheduledStartMs, completesAtMs, bonusQuantity]
      );
      const job = requireRow(inserted.rows[0], "Loom job could not be started");
      await client.query(
        `INSERT INTO loom_operations (
           operation_key,player_id,request_id,action,request_hash,loom_id,job_id
         ) VALUES ($1,$2,$3,'start',$4,$5,$6)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, loomId, job.job_id]
      );
      await client.query("COMMIT");
      return {
        state: stateSnapshot(
          mapLoom(loom),
          [...jobs, job].filter((candidate) => candidate.owner_player_id === player.playerId),
          nowMs,
          jobs.length + 1
        ),
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

  async collect(
    player: PlayerRecord,
    requestId: string,
    loomId: string
  ): Promise<LoomCollectionResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const hash = requestHash("collect", player.playerId, loomId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "collect", hash);
        const loom = await this.requireInRange(client, player, replay.loom_id, false);
        const jobs = await currentJobs(client, loom.loom_id);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return {
          state: stateSnapshot(
            mapLoom(loom),
            jobs.filter((job) => job.owner_player_id === player.playerId),
            this.now(),
            jobs.length
          ),
          inventory,
          collectedQuantity: replay.result_quantity,
          replayed: true
        };
      }
      const loom = await this.requireInRange(client, player, loomId, true);
      const jobs = await currentJobs(client, loomId);
      const playerJobs = jobs.filter((job) => job.owner_player_id === player.playerId);
      if (playerJobs.length === 0) throw new LoomError("LOOM_JOB_REQUIRED", "This Loom has no output to collect.");
      const nowMs = this.now();
      const readyJobs = playerJobs.map((job) => ({
        job,
        ready: nowMs >= new Date(job.completes_at).getTime()
          ? Math.max(0, job.output_quantity - job.collected_quantity)
          : 0
      })).filter((candidate) => candidate.ready > 0);
      if (readyJobs.length === 0) {
        throw new LoomError(
          "LOOM_OUTPUT_NOT_READY",
          "No Loom output is ready to collect yet."
        );
      }
      const grantsByItem = new Map<string, number>();
      for (const { job, ready } of readyJobs) {
        const itemId = requireLoomRecipe(job.recipe_id).outputItemId;
        grantsByItem.set(itemId, (grantsByItem.get(itemId) ?? 0) + ready);
      }
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `loom:collect:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "loom_processing",
        sourceEntityType: "loom",
        sourceEntityId: loomId,
        metadata: { requestId, jobIds: readyJobs.map(({ job }) => job.job_id) },
        grants: [...grantsByItem].map(([itemId, quantity]) => ({
          itemId: itemId as ReturnType<typeof requireLoomRecipe>["outputItemId"],
          variant: null,
          quantity
        })),
        allowPartial: true
      });
      const grantedByItem = new Map(
        grant.grants.map((result) => [result.itemId, result.grantedQuantity])
      );
      let collectedQuantity = 0;
      for (const { job, ready } of readyJobs) {
        const itemId = requireLoomRecipe(job.recipe_id).outputItemId;
        const granted = Math.min(ready, grantedByItem.get(itemId) ?? 0);
        if (granted <= 0) continue;
        grantedByItem.set(itemId, (grantedByItem.get(itemId) ?? 0) - granted);
        collectedQuantity += granted;
        const collectedTotal = job.collected_quantity + granted;
        await client.query(
          `UPDATE loom_jobs
           SET collected_quantity=$2,
               cleared_at=CASE WHEN $2=output_quantity THEN to_timestamp($3 / 1000.0) ELSE NULL END,
               updated_at=now()
           WHERE job_id=$1`,
          [job.job_id, collectedTotal, nowMs]
        );
      }
      await client.query(
        `INSERT INTO loom_operations (
           operation_key,player_id,request_id,action,request_hash,loom_id,job_id,result_quantity
         ) VALUES ($1,$2,$3,'collect',$4,$5,$6,$7)`,
        [
          operationKey(player.playerId, requestId),
          player.playerId,
          requestId,
          hash,
          loomId,
          readyJobs[0]!.job.job_id,
          collectedQuantity
        ]
      );
      const remainingJobs = await currentJobs(client, loomId);
      await client.query("COMMIT");
      return {
        state: stateSnapshot(
          mapLoom(loom),
          remainingJobs.filter((job) => job.owner_player_id === player.playerId),
          nowMs,
          remainingJobs.length
        ),
        inventory: grant.inventory,
        collectedQuantity,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireInRange(
    queryable: Pick<pg.Pool | pg.PoolClient, "query">,
    player: PlayerRecord,
    loomId: string,
    lock: boolean
  ): Promise<LoomRow> {
    const result = await queryable.query<LoomRow>(
      `${LOOM_SELECT}
       WHERE loom.loom_id=$1::uuid
         AND loom.removed_at IS NULL
         AND loom.world_id=$2
         AND loom.region_code=$3
         AND ST_DWithin(
           loom.geom::geography,
           ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,
           $6
         )
       ${lock ? "FOR UPDATE OF loom" : ""}`,
      [
        loomId,
        this.worldId,
        player.regionCode,
        player.position.lon,
        player.position.lat,
        LOOM_INTERACTION_RADIUS_M
      ]
    );
    if (!result.rows[0]) {
      throw new LoomError(
        "LOOM_RANGE_REQUIRED",
        `Move within ${LOOM_INTERACTION_RADIUS_M}m of the Loom to use it.`
      );
    }
    return result.rows[0];
  }
}

const LOOM_SELECT = `SELECT
  loom.loom_id,loom.manor_id,loom.owner_player_id,
  owner.username AS owner_username,loom.region_code,loom.lat,loom.lon,
  loom.built_at,loom.placement_revision::text
 FROM player_looms loom
 JOIN players owner ON owner.id=loom.owner_player_id`;

const BUILD_RETURNING_FIELDS = `build_id,owner_player_id,request_id,request_hash,
  manor_id,world_id,region_code,lat,lon,status,started_at,completes_at,
  loom_id,cancel_reason`;

async function requireLoom(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  loomId: string
): Promise<LoomRow> {
  const result = await queryable.query<LoomRow>(
    `${LOOM_SELECT}
     WHERE loom.loom_id=$1::uuid AND loom.removed_at IS NULL`,
    [loomId]
  );
  return requireRow(result.rows[0], "Loom no longer exists");
}

async function buildForRequest(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  requestId: string
): Promise<BuildRow | null> {
  const result = await queryable.query<BuildRow>(
    `SELECT ${BUILD_RETURNING_FIELDS}
     FROM loom_build_jobs
     WHERE owner_player_id=$1 AND request_id=$2`,
    [playerId, requestId]
  );
  return result.rows[0] ?? null;
}

async function activeBuild(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  lock: boolean
): Promise<BuildRow | null> {
  const result = await queryable.query<BuildRow>(
    `SELECT ${BUILD_RETURNING_FIELDS}
     FROM loom_build_jobs
     WHERE owner_player_id=$1 AND status='constructing'
     ORDER BY started_at,build_id
     LIMIT 1
     ${lock ? "FOR UPDATE" : ""}`,
    [playerId]
  );
  return result.rows[0] ?? null;
}

async function hasActiveLoom(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string
): Promise<boolean> {
  const result = await queryable.query(
    `SELECT 1
     FROM player_looms
     WHERE owner_player_id=$1 AND removed_at IS NULL
     LIMIT 1`,
    [playerId]
  );
  return result.rows[0] !== undefined;
}

async function currentJobs(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  loomId: string
): Promise<JobRow[]> {
  const result = await queryable.query<JobRow>(
    `SELECT job_id,loom_id,owner_player_id,recipe_id,requested_input_quantity,
       output_quantity,collected_quantity,started_at,completes_at,cleared_at
     FROM loom_jobs
     WHERE loom_id=$1::uuid AND cleared_at IS NULL
     ORDER BY started_at,created_at,job_id`,
    [loomId]
  );
  return result.rows;
}

function stateSnapshot(
  loom: LoomWorldSnapshot,
  jobs: readonly JobRow[],
  nowMs: number,
  occupiedSlots = jobs.length
): LoomStateSnapshot {
  return {
    loom,
    jobs: jobs.map((job) => mapJob(job, nowMs)),
    queueCapacity: LOOM_QUEUE_CAPACITY,
    occupiedSlots,
    serverTime: nowMs
  };
}

function jobFinishesAt(job: JobRow): number {
  return new Date(job.completes_at).getTime();
}

function mapLoom(row: LoomRow): LoomWorldSnapshot {
  return {
    loomId: row.loom_id,
    manorId: row.manor_id,
    ownerPlayerId: row.owner_player_id,
    ownerUsername: row.owner_username,
    regionCode: row.region_code,
    lat: Number(row.lat),
    lon: Number(row.lon),
    builtAt: new Date(row.built_at).toISOString(),
    placementRevision: Number(row.placement_revision)
  };
}

function mapBuild(row: BuildRow): LoomBuildSnapshot {
  const startedAt = new Date(row.started_at).getTime();
  const completesAt = new Date(row.completes_at).getTime();
  return {
    buildId: row.build_id,
    position: { lat: Number(row.lat), lon: Number(row.lon) },
    startedAt,
    completesAt,
    durationMs: completesAt - startedAt
  };
}

function mapJob(row: JobRow, nowMs: number): LoomJobSnapshot {
  const recipe = requireLoomRecipe(row.recipe_id);
  const startedAtMs = new Date(row.started_at).getTime();
  const completesAtMs = new Date(row.completes_at).getTime();
  const productionFinished = nowMs >= completesAtMs;
  const readyQuantity = productionFinished
    ? Math.max(0, row.output_quantity - row.collected_quantity)
    : 0;
  return {
    jobId: row.job_id,
    recipeId: row.recipe_id,
    inputItemId: recipe.inputItemId,
    outputItemId: recipe.outputItemId,
    outputDisplayName: recipe.outputDisplayName,
    requestedInputQuantity: row.requested_input_quantity,
    outputQuantity: row.output_quantity,
    collectedQuantity: row.collected_quantity,
    readyQuantity,
    startedAt: new Date(startedAtMs).toISOString(),
    completesAt: new Date(completesAtMs).toISOString(),
    productionFinished
  };
}

async function lockOperation(
  client: pg.PoolClient,
  playerId: string,
  requestId: string
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [`loom-operation:${playerId}:${requestId}`]
  );
}

async function lockBuildChannel(client: pg.PoolClient, playerId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [`outdoor-station-build-player:${playerId}`]
  );
}

async function previousOperation(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  requestId: string
): Promise<OperationRow | null> {
  const result = await queryable.query<OperationRow>(
    `SELECT action,request_hash,loom_id,job_id,result_quantity
     FROM loom_operations
     WHERE player_id=$1 AND request_id=$2`,
    [playerId, requestId]
  );
  return result.rows[0] ?? null;
}

function requireMatchingOperation(
  operation: OperationRow,
  action: OperationRow["action"],
  hash: string
): void {
  if (operation.action !== action || operation.request_hash !== hash) {
    throw new LoomError(
      "LOOM_REPLAY_CONFLICT",
      "That request ID was already used for a different Loom action."
    );
  }
}

function requestHash(action: string, ...parts: Array<string | number>): string {
  return createHash("sha256")
    .update(JSON.stringify([action, ...parts]))
    .digest("hex");
}

function operationKey(playerId: string, requestId: string): string {
  return `loom:${playerId}:${requestId}`;
}

function requireRequestId(requestId: string): void {
  if (!requestId || requestId.length > 128) {
    throw new LoomError("LOOM_INVALID_REQUEST", "A valid request ID is required.");
  }
}

function requireRecipeQuantity(recipeId: LoomRecipeId, quantity: number): void {
  const recipe = requireLoomRecipe(recipeId);
  if (
    !Number.isSafeInteger(quantity)
    || quantity < recipe.minimumQuantity
    || quantity > recipe.maximumQuantity
    || quantity % recipe.inputMultiple !== 0
  ) {
    throw new LoomError(
      "LOOM_INVALID_QUANTITY",
      recipe.inputMultiple === 2
        ? `Choose an even number between ${recipe.minimumQuantity} and ${recipe.maximumQuantity} ${recipe.inputDisplayName}.`
        : `Choose between ${recipe.minimumQuantity} and ${recipe.maximumQuantity} ${recipe.inputDisplayName}.`
    );
  }
}

function requirePosition(player: PlayerRecord): void {
  if (!Number.isFinite(player.position.lat) || !Number.isFinite(player.position.lon)) {
    throw new LoomError("LOOM_INVALID_POSITION", "Your world position is unavailable.");
  }
}

function requireRow<T>(value: T | undefined, message: string): T {
  if (!value) throw new LoomError("LOOM_CONFLICT", message);
  return value;
}

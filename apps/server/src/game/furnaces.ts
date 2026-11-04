import { createHash, randomUUID } from "node:crypto";

import { UTILITY_GEAR, UTILITY_GEAR_ACTION_DURATION_MS } from "@ash-atlas/shared";
import { spendUtilityGearUseInTransaction, type UtilityGearHooks } from "./utilityGear.js";
import {
  FURNACE_BUILD_COST,
  FURNACE_BUILD_DURATION_MS,
  FURNACE_GLIMMER_OIL_CRUDE_OIL_PER_UNIT,
  FURNACE_GLIMMER_OIL_GLIMMER_PER_UNIT,
  FURNACE_GLIMMER_OIL_ITEM_ID,
  FURNACE_GLIMMER_OIL_MAX_QUANTITY,
  FURNACE_INTERACTION_RADIUS_M,
  FURNACE_MAX_MANOR_DISTANCE_M,
  FURNACE_QUEUE_CAPACITY,
  FURNACE_SNAPSHOT_RADIUS_M,
  completedFurnaceOutput,
  furnaceCategoryInputs,
  furnaceRecipeInputs,
  materialBreakdown,
  FURNACE_BREAKDOWN_INPUT_IDS,
  FURNACE_BREAKDOWN_MAX_QUANTITY,
  type CategoryPick,
  FURNACE_METAL_BAR_RECIPE_IDS,
  slagRecoveryCostForMetallurgyRank,
  metallurgyDoubleBarChance,
  metallurgyIronSuccessChance,
  requireFurnaceRecipe,
  type DroppedItemSnapshot,
  type FurnaceBuildSnapshot,
  type FurnaceJobSnapshot,
  type FurnaceRecipeId,
  type FurnaceRecipeInput,
  type FurnaceStateSnapshot,
  type FurnaceWorldSnapshot,
  type PlayerInventorySnapshot,
  type PremiumWalletSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import { isInventoryCapacityError, type InventoryService } from "./inventory.js";
import { PremiumWalletOperationError, PremiumWalletService } from "./premiumWallet.js";
import { MasteryService } from "./masteries.js";
import { breakdownGuardFailure, resolveMaterialSpend, spendableItemCounts } from "./materialSpend.js";
import { createSystemGroundDropsInTransaction } from "./droppedItems.js";
import type { PlayerRecord } from "./state.js";
import { requireOutdoorStationClearance } from "./stationPlacementClearance.js";

type FurnaceRow = {
  furnace_id: string;
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
  furnace_id: string;
  owner_player_id: string;
  recipe_id: FurnaceRecipeId;
  requested_quantity: number;
  collected_quantity: number;
  started_at: Date | string;
  cleared_at: Date | string | null;
  duration_ms?: number | null;
  unit_outcomes: string[];
};

type OperationRow = {
  action: "build" | "start" | "collect" | "refine" | "breakdown";
  request_hash: string;
  furnace_id: string;
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
  furnace_id: string | null;
  cancel_reason: string | null;
};

export class FurnaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FurnaceError";
  }
}

export type FurnaceMutationResult = Readonly<{
  state: FurnaceStateSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

export type FurnaceCollectionResult = FurnaceMutationResult & Readonly<{
  collectedQuantity: number;
}>;

export type FurnaceGlimmerOilRefineResult = FurnaceMutationResult & Readonly<{
  premiumWallet: PremiumWalletSnapshot;
  refinedQuantity: number;
}>;

export type FurnaceBuildRequestResult =
  | Readonly<{
      status: "constructing";
      build: FurnaceBuildSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
    }>
  | Readonly<{
      status: "completed";
      furnace: FurnaceWorldSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: true;
    }>
  | Readonly<{
      status: "cancelled";
      buildId: string;
      inventory: PlayerInventorySnapshot;
      replayed: true;
    }>;

export type FurnaceBuildCompletion = Readonly<{
  playerId: string;
  requestId: string;
  furnace: FurnaceWorldSnapshot;
  inventory: PlayerInventorySnapshot;
}>;

export type FurnaceBuildCancellation = Readonly<{
  playerId: string;
  requestId: string;
  buildId: string;
  inventory: PlayerInventorySnapshot;
  droppedItems: DroppedItemSnapshot[];
  reason: string;
}>;

export class FurnaceService {
  private utilityGear: UtilityGearHooks | null = null;

  /** Refreshes the equipment runtime and the client after a utility glove spent a use. */
  setUtilityGear(hooks: UtilityGearHooks): void {
    this.utilityGear = hooks;
  }

  constructor(
    private readonly pool: pg.Pool,
    private readonly worldId: string,
    private readonly inventory: Pick<
      InventoryService,
      | "debitItemsForOperationInTransaction"
      | "grantItemsForOperationInTransaction"
      | "snapshotInTransaction"
    >,
    private readonly now: () => number = Date.now,
    private readonly masteries: Pick<MasteryService, "professionRankInTransaction" | "grantProfessionXpCompactInTransaction"> = new MasteryService(pool),
    private readonly random: () => number = Math.random,
    private readonly premiumWallet: Pick<
      PremiumWalletService,
      "debitForOperationInTransaction" | "snapshotInTransaction"
    > = new PremiumWalletService()
  ) {}

  async listNear(
    player: PlayerRecord,
    radiusM = FURNACE_SNAPSHOT_RADIUS_M
  ): Promise<FurnaceWorldSnapshot[]> {
    const result = await this.pool.query<FurnaceRow>(
      `${FURNACE_SELECT}
       WHERE furnace.removed_at IS NULL
         AND furnace.world_id=$1 AND furnace.region_code=$2
         AND ST_DWithin(
           furnace.geom::geography,
           ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
           $5
         )
       ORDER BY ST_Distance(
         furnace.geom::geography,
         ST_SetSRID(ST_MakePoint($3,$4),4326)::geography
       ),furnace.furnace_id`,
      [
        this.worldId,
        player.regionCode,
        player.position.lon,
        player.position.lat,
        Math.min(Math.max(radiusM, 1), FURNACE_SNAPSHOT_RADIUS_M)
      ]
    );
    return result.rows.map(mapFurnace);
  }

  async build(player: PlayerRecord, requestId: string): Promise<FurnaceBuildRequestResult> {
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
          throw new FurnaceError("FURNACE_REPLAY_CONFLICT", "The Furnace request ID was already used.");
        }
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        if (replay.status === "completed" && replay.furnace_id) {
          const furnace = await requireFurnace(client, replay.furnace_id);
          await client.query("COMMIT");
          return { status: "completed", furnace: mapFurnace(furnace), inventory, replayed: true };
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
        throw new FurnaceError(
          "FURNACE_BUILD_ACTIVE",
          "Finish or cancel the current Furnace construction first."
        );
      }
      if ((await client.query(
        "SELECT 1 FROM tannery_build_jobs WHERE owner_player_id=$1 AND status='constructing' LIMIT 1",
        [player.playerId]
      )).rows[0]) {
        throw new FurnaceError(
          "FURNACE_BUILD_ACTIVE",
          "Finish or cancel the current Tannery construction first."
        );
      }
      if ((await client.query(
        "SELECT 1 FROM loom_build_jobs WHERE owner_player_id=$1 AND status='constructing' LIMIT 1",
        [player.playerId]
      )).rows[0]) {
        throw new FurnaceError(
          "FURNACE_BUILD_ACTIVE",
          "Finish or cancel the current Loom construction first."
        );
      }
      if ((await client.query(
        "SELECT 1 FROM kitchen_build_jobs WHERE owner_player_id=$1 AND status='constructing' LIMIT 1",
        [player.playerId]
      )).rows[0]) {
        throw new FurnaceError(
          "FURNACE_BUILD_ACTIVE",
          "Finish or cancel the current Kitchen construction first."
        );
      }
      if (await hasActiveFurnace(client, player.playerId)) {
        throw new FurnaceError(
          "FURNACE_OWNER_LIMIT",
          "You may only own one Furnace."
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
          FURNACE_MAX_MANOR_DISTANCE_M
        ]
      );
      if (!manor.rows[0]) {
        throw new FurnaceError(
          "FURNACE_MANOR_RANGE_REQUIRED",
          "Furnaces must be built within 600m of your Manor."
        );
      }
      await requireOutdoorStationClearance(client, this.worldId, player.regionCode, player.position, {
        manorCenter: { lat: Number(manor.rows[0].world_lat), lon: Number(manor.rows[0].world_lon) },
        maxManorDistanceM: FURNACE_MAX_MANOR_DISTANCE_M,
        movementAnchor: player.anchor,
        moveLeashRadiusM: player.moveLeashRadiusM
      });
      const buildId = randomUUID();
      const startedAt = this.now();
      const completesAt = startedAt + FURNACE_BUILD_DURATION_MS;
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `furnace:build:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "furnace_construction",
          sourceEntityType: "furnace_build",
          sourceEntityId: buildId,
          metadata: { requestId },
          debits: [
            { itemId: "stone", variant: null, quantity: FURNACE_BUILD_COST.stone },
            { itemId: "wood", variant: null, quantity: FURNACE_BUILD_COST.wood },
            { itemId: "coal", variant: null, quantity: FURNACE_BUILD_COST.coal }
          ]
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new FurnaceError(
            "FURNACE_BUILD_MATERIALS_REQUIRED",
            `Building a Furnace requires ${FURNACE_BUILD_COST.stone} Stone, ${FURNACE_BUILD_COST.wood} Wood, and ${FURNACE_BUILD_COST.coal} Coal.`
          );
        }
        throw error;
      }
      const inserted = await client.query<BuildRow>(
        `INSERT INTO furnace_build_jobs (
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
      const build = requireRow(inserted.rows[0], "Furnace construction could not be started");
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
    build: FurnaceBuildSnapshot;
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

  async cancelBuildForMovement(playerId: string): Promise<FurnaceBuildCancellation | null> {
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
    completed: FurnaceBuildCompletion[];
    cancelled: FurnaceBuildCancellation[];
  }>> {
    const due = await this.pool.query<{ build_id: string }>(
      `SELECT build_id
       FROM furnace_build_jobs
       WHERE status='constructing' AND completes_at <= clock_timestamp()
       ORDER BY completes_at,build_id
       LIMIT $1`,
      [limit]
    );
    const completed: FurnaceBuildCompletion[] = [];
    const cancelled: FurnaceBuildCancellation[] = [];
    for (const { build_id: buildId } of due.rows) {
      const result = await this.completeBuild(buildId);
      if (!result) continue;
      if ("furnace" in result) completed.push(result);
      else cancelled.push(result);
    }
    return { completed, cancelled };
  }

  private async completeBuild(
    buildId: string
  ): Promise<FurnaceBuildCompletion | FurnaceBuildCancellation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ owner_player_id: string }>(
        `SELECT owner_player_id
         FROM furnace_build_jobs
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
         FROM furnace_build_jobs
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
          FURNACE_MAX_MANOR_DISTANCE_M
        ]
      );
      if (!manor.rows[0]) {
        const cancelled = await this.cancelBuildInTransaction(client, build, "revalidation-failed");
        await client.query("COMMIT");
        return cancelled;
      }
      if (await hasActiveFurnace(client, build.owner_player_id)) {
        const cancelled = await this.cancelBuildInTransaction(client, build, "owner-limit");
        await client.query("COMMIT");
        return cancelled;
      }
      const inserted = await client.query<{ furnace_id: string }>(
        `INSERT INTO player_furnaces (
           manor_id,owner_player_id,world_id,region_code,lat,lon,geom,built_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,
           ST_SetSRID(ST_MakePoint($6,$5),4326),$7
         )
         RETURNING furnace_id`,
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
      const furnaceId = requireRow(inserted.rows[0], "Furnace placement failed").furnace_id;
      await client.query(
        `UPDATE furnace_build_jobs
         SET status='completed',furnace_id=$2::uuid,updated_at=clock_timestamp()
         WHERE build_id=$1::uuid`,
        [build.build_id, furnaceId]
      );
      await client.query(
        `INSERT INTO furnace_operations (
           operation_key,player_id,request_id,action,request_hash,furnace_id
         ) VALUES ($1,$2,$3,'build',$4,$5)`,
        [
          operationKey(build.owner_player_id, build.request_id),
          build.owner_player_id,
          build.request_id,
          build.request_hash,
          furnaceId
        ]
      );
      const furnace = await requireFurnace(client, furnaceId);
      const inventory = await this.inventory.snapshotInTransaction(client, build.owner_player_id);
      await client.query("COMMIT");
      return {
        playerId: build.owner_player_id,
        requestId: build.request_id,
        furnace: mapFurnace(furnace),
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
  ): Promise<FurnaceBuildCancellation> {
    const refund = await this.inventory.grantItemsForOperationInTransaction(client, {
      operationKey: `furnace:build:${build.owner_player_id}:${build.request_id}:refund`,
      playerId: build.owner_player_id,
      source: "furnace_construction_cancelled",
      sourceEntityType: "furnace_build",
      sourceEntityId: build.build_id,
      metadata: { requestId: build.request_id, reason },
      allowPartial: true,
      grants: [
        { itemId: "stone", variant: null, quantity: FURNACE_BUILD_COST.stone },
        { itemId: "wood", variant: null, quantity: FURNACE_BUILD_COST.wood },
        { itemId: "coal", variant: null, quantity: FURNACE_BUILD_COST.coal }
      ]
    });
    const costLines = [
      { itemId: "stone", quantity: FURNACE_BUILD_COST.stone },
      { itemId: "wood", quantity: FURNACE_BUILD_COST.wood },
      { itemId: "coal", quantity: FURNACE_BUILD_COST.coal }
    ] as const;
    const droppedItems = await createSystemGroundDropsInTransaction(client, {
      operationKey: `furnace:build:${build.owner_player_id}:${build.request_id}:refund-drop`,
      droppedByPlayerId: build.owner_player_id,
      regionCode: build.region_code,
      position: { lat: build.lat, lon: build.lon },
      reason: "furnace_construction_cancelled",
      lines: costLines.flatMap((line) => {
        const granted = refund.grants.find((candidate) => candidate.itemId === line.itemId)
          ?.grantedQuantity ?? 0;
        const quantity = line.quantity - granted;
        return quantity > 0 ? [{ itemId: line.itemId, variant: null, quantity }] : [];
      })
    });
    await client.query(
      `UPDATE furnace_build_jobs
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

  async state(player: PlayerRecord, furnaceId: string): Promise<FurnaceStateSnapshot> {
    const furnace = await this.requireOwnedInRange(this.pool, player, furnaceId, false);
    const jobs = await currentJobs(this.pool, furnaceId);
    const metallurgyRank = await this.masteries.professionRankInTransaction(this.pool, player.playerId, "metallurgy");
    return stateSnapshot(mapFurnace(furnace), jobs, this.now(), metallurgyRank);
  }

  async start(
    player: PlayerRecord,
    requestId: string,
    furnaceId: string,
    recipeIdOrQuantity: FurnaceRecipeId | string | number,
    quantityInput?: number,
    options: Readonly<{ categoryPicks?: readonly (readonly CategoryPick[])[]; confirmHighGrade?: boolean }> = {}
  ): Promise<FurnaceMutationResult> {
    if (typeof recipeIdOrQuantity === "string" && FURNACE_BREAKDOWN_INPUT_IDS.includes(recipeIdOrQuantity)) {
      return this.breakdown(player, requestId, furnaceId, recipeIdOrQuantity, quantityInput ?? Number.NaN, options.confirmHighGrade);
    }
    const recipeId = (typeof recipeIdOrQuantity === "number"
      ? "iron_bar"
      : recipeIdOrQuantity) as FurnaceRecipeId;
    const quantity = typeof recipeIdOrQuantity === "number"
      ? recipeIdOrQuantity
      : quantityInput ?? Number.NaN;
    requireRequestId(requestId);
    const recipe = requireFurnaceRecipe(recipeId);
    requireRecipeQuantity(recipeId, quantity);
    requirePosition(player);
    const hash = recipe.categoryInputs === undefined
      ? requestHash("start", player.playerId, furnaceId, recipeId, quantity)
      : requestHash("start", player.playerId, furnaceId, recipeId, quantity, JSON.stringify(options.categoryPicks ?? null));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "start", hash);
        const furnace = await requireFurnace(client, replay.furnace_id);
        const jobs = await currentJobs(client, furnace.furnace_id);
        const metallurgyRank = await this.masteries.professionRankInTransaction(client, player.playerId, "metallurgy");
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return {
          state: stateSnapshot(mapFurnace(furnace), jobs, this.now(), metallurgyRank),
          inventory,
          replayed: true
        };
      }
      const furnace = await this.requireOwnedInRange(client, player, furnaceId, true);
      const jobs = await currentJobs(client, furnaceId);
      const metallurgyRank = await this.masteries.professionRankInTransaction(client, player.playerId, "metallurgy");
      if (recipe.retired) {
        throw new FurnaceError(
          "FURNACE_RECIPE_RETIRED",
          "Cores are no longer forged. Infuse equipment with bars at the Jewel Station."
        );
      }
      if (metallurgyRank < recipe.minimumMetallurgyRank) {
        throw new FurnaceError(
          "FURNACE_PROFESSION_RANK_REQUIRED",
          `Metallurgy Rank ${recipe.minimumMetallurgyRank} is required to forge ${recipe.outputDisplayName}s.`
        );
      }
      if (recipeId === "slag_recovery" && slagRecoveryCostForMetallurgyRank(metallurgyRank) === null) {
        throw new FurnaceError(
          "FURNACE_PROFESSION_RANK_REQUIRED",
          "Metallurgy Rank 2 is required to recover Iron Bars from Slag."
        );
      }
      const occupiedSlots = jobs.reduce(
        (total, job) => total + job.requested_quantity - job.collected_quantity,
        0
      );
      if (quantity > FURNACE_QUEUE_CAPACITY - occupiedSlots) {
        throw new FurnaceError(
          "FURNACE_QUEUE_FULL",
          `The Furnace has ${Math.max(0, FURNACE_QUEUE_CAPACITY - occupiedSlots)} queue slots available.`
        );
      }
      const inputs = furnaceRecipeInputs(recipeId, quantity, { metallurgyRank });
      let debits: readonly { itemId: string; quantity: number }[] = inputs;
      if (recipe.categoryInputs !== undefined) {
        const spendable = await spendableItemCounts(this.inventory, client, player.playerId);
        const resolved = resolveMaterialSpend(recipe.displayName, inputs, furnaceCategoryInputs(recipeId, quantity), spendable, {
          ...(options.categoryPicks === undefined ? {} : { picks: options.categoryPicks }),
          ...(options.confirmHighGrade === undefined ? {} : { confirmHighGrade: options.confirmHighGrade })
        });
        if (!resolved.ok) throw new FurnaceError(`FURNACE_${resolved.failure.code}`, resolved.failure.message);
        debits = resolved.debits;
      }
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `furnace:start:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "furnace_smelting",
          sourceEntityType: "furnace",
          sourceEntityId: furnaceId,
          metadata: { requestId, recipeId, quantity },
          debits: debits.map((input) => ({
            itemId: input.itemId as FurnaceRecipeInput["itemId"],
            variant: null,
            quantity: input.quantity
          }))
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new FurnaceError(
            "FURNACE_MATERIALS_REQUIRED",
            `${recipe.displayName} requires ${inputs.map((input) => `${input.quantity} ${input.displayName}`).join(" and ")}.`
          );
        }
        throw error;
      }
      // A worn Artisan Glove makes each unit take 1 second and spends one use per unit. A job the
      // worn glove cannot fully cover is refused rather than split, so no unit runs at the wrong speed.
      // Furnaces stand at the owner's Manor (requireOwnedInRange above), so this is always at home.
      const wornGlove = await client.query<{ uses_remaining: number }>(
        `SELECT uses_remaining FROM equipment_instances
          WHERE owner_player_id = $1 AND location = 'equipped' AND equipped_slot = $2
            AND definition_id = 'artisan_glove' AND uses_remaining > 0
          FOR UPDATE`,
        [player.playerId, UTILITY_GEAR.artisan_glove.slot]
      );
      const gloveUses = Number(wornGlove.rows[0]?.uses_remaining ?? 0);
      if (gloveUses > 0 && gloveUses < quantity) {
        throw new FurnaceError(
          "FURNACE_GLOVE_USES_SHORT",
          `Your ${UTILITY_GEAR.artisan_glove.displayName} has ${gloveUses} use${gloveUses === 1 ? "" : "s"} left. Smelt ${gloveUses} or fewer, or take it off.`
        );
      }
      const gloveSpent = gloveUses > 0
        ? await spendUtilityGearUseInTransaction(client, player.playerId, "artisan_glove", quantity)
        : null;
      const nowMs = this.now();
      const scheduledStartMs = jobs.reduce(
        (tailMs, queuedJob) => Math.max(tailMs, jobFinishesAt(queuedJob)),
        nowMs
      );
      const inserted = await client.query<JobRow>(
        `INSERT INTO furnace_smelt_jobs (
           furnace_id,owner_player_id,recipe_id,requested_quantity,started_at,duration_ms
         ) VALUES ($1,$2,$3,$4,to_timestamp($5 / 1000.0),$6)
         RETURNING job_id,furnace_id,owner_player_id,recipe_id,requested_quantity,
           collected_quantity,started_at,cleared_at,duration_ms`,
        [furnaceId, player.playerId, recipeId, quantity, scheduledStartMs, gloveSpent ? UTILITY_GEAR_ACTION_DURATION_MS : null]
      );
      const job = {
        ...requireRow(inserted.rows[0], "Furnace job could not be started"),
        unit_outcomes: []
      };
      if (recipeId === "iron_bar") {
        const firstAttempt = (await client.query(
          `SELECT 1 FROM furnace_smelt_jobs
           WHERE owner_player_id=$1 AND recipe_id='iron_bar' AND job_id<>$2::uuid
           LIMIT 1`,
          [player.playerId, job.job_id]
        )).rowCount === 0;
        const successChance = metallurgyIronSuccessChance(metallurgyRank);
        for (let unitIndex = 1; unitIndex <= quantity; unitIndex += 1) {
          const outcome = firstAttempt && unitIndex === 1
            ? "success"
            : this.random() < successChance ? "success" : "failure";
          await client.query(
            `INSERT INTO furnace_smelt_units (job_id,unit_index,outcome)
             VALUES ($1::uuid,$2,$3)`,
            [job.job_id, unitIndex, outcome]
          );
        }
      }
      await client.query(
        `INSERT INTO furnace_operations (
           operation_key,player_id,request_id,action,request_hash,furnace_id,job_id
         ) VALUES ($1,$2,$3,'start',$4,$5,$6)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, furnaceId, job.job_id]
      );
      await client.query("COMMIT");
      if (gloveSpent) await this.utilityGear?.afterUse(player.playerId).catch(() => undefined);
      return {
        state: stateSnapshot(mapFurnace(furnace), [...jobs, job], nowMs, metallurgyRank),
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
    furnaceId: string
  ): Promise<FurnaceCollectionResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const hash = requestHash("collect", player.playerId, furnaceId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "collect", hash);
        const furnace = await requireFurnace(client, replay.furnace_id);
        const jobs = await currentJobs(client, furnace.furnace_id);
        const metallurgyRank = await this.masteries.professionRankInTransaction(client, player.playerId, "metallurgy");
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return {
          state: stateSnapshot(mapFurnace(furnace), jobs, this.now(), metallurgyRank),
          inventory,
          collectedQuantity: replay.result_quantity,
          replayed: true
        };
      }
      const furnace = await this.requireOwnedInRange(client, player, furnaceId, true);
      const jobs = await currentJobs(client, furnaceId);
      if (jobs.length === 0) throw new FurnaceError("FURNACE_JOB_REQUIRED", "This Furnace has no output to collect.");
      const nowMs = this.now();
      const readyJobs = jobs.map((job) => ({
        job,
        ready: Math.max(0, completedFurnaceOutput(
          job.recipe_id,
          new Date(job.started_at).getTime(),
          job.requested_quantity,
          nowMs,
          job.duration_ms
        ) - job.collected_quantity)
      })).filter((candidate) => candidate.ready > 0);
      if (readyJobs.length === 0) {
        throw new FurnaceError(
          "FURNACE_OUTPUT_NOT_READY",
          "No Furnace output is ready to collect yet."
        );
      }
      let latestInventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      let collectedQuantity = 0;
      const collectMetallurgyRank = await this.masteries.professionRankInTransaction(client, player.playerId, "metallurgy");
      for (const { job, ready } of readyJobs) {
        const recipe = requireFurnaceRecipe(job.recipe_id);
        for (let offset = 0; offset < ready; offset += 1) {
          const unitIndex = job.collected_quantity + offset + 1;
          const outcome = recipe.recipeId === "iron_bar" && job.unit_outcomes[unitIndex - 1] === "failure"
            ? "failure"
            : "success";
          const itemId = recipe.recipeId === "iron_bar" && outcome === "failure"
            ? "slag"
            : recipe.outputItemId;
          const isBar = recipe.recipeId === "iron_bar" ||
            (FURNACE_METAL_BAR_RECIPE_IDS as readonly string[]).includes(recipe.recipeId);
          const barQuantity = isBar && outcome === "success"
            ? furnaceBarYield(collectMetallurgyRank, job.job_id, unitIndex)
            : 1;
          const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
            operationKey: `furnace:collect:${player.playerId}:${requestId}:${job.job_id}:${unitIndex}`,
            playerId: player.playerId,
            source: "furnace_smelting",
            sourceEntityType: "furnace",
            sourceEntityId: furnaceId,
            metadata: { requestId, jobId: job.job_id, unitIndex, outcome, ...(barQuantity > 1 ? { doubled: true } : {}) },
            grants: [{ itemId, variant: null, quantity: barQuantity }],
            allowPartial: true
          });
          latestInventory = grant.inventory;
          const granted = grant.grants.find((result) => result.itemId === itemId)?.grantedQuantity ?? 0;
          if (granted <= 0) break;
          const collectedTotal = job.collected_quantity + offset + 1;
          await client.query(
            `UPDATE furnace_smelt_jobs
             SET collected_quantity=$2,
                 cleared_at=CASE WHEN $2=requested_quantity THEN to_timestamp($3 / 1000.0) ELSE NULL END,
                 updated_at=now()
             WHERE job_id=$1`,
            [job.job_id, collectedTotal, nowMs]
          );
          if (recipe.recipeId === "iron_bar") {
            await client.query(
              `UPDATE furnace_smelt_units
               SET settled_at=to_timestamp($3 / 1000.0)
               WHERE job_id=$1::uuid AND unit_index=$2 AND settled_at IS NULL`,
              [job.job_id, unitIndex, nowMs]
            );
            await this.masteries.grantProfessionXpCompactInTransaction(client, {
              operationKey: `furnace:xp:${job.job_id}:${unitIndex}`,
              playerId: player.playerId,
              sourceId: `${job.job_id}:${unitIndex}`,
              activity: { kind: "iron-smelt", outcome }
            });
          } else if ((FURNACE_METAL_BAR_RECIPE_IDS as readonly string[]).includes(recipe.recipeId)) {
            await this.masteries.grantProfessionXpCompactInTransaction(client, {
              operationKey: `furnace:xp:${job.job_id}:${unitIndex}`,
              playerId: player.playerId,
              sourceId: `${job.job_id}:${unitIndex}`,
              activity: { kind: "metal-bar-smelt" }
            });
          }
          collectedQuantity += 1;
        }
      }
      await client.query(
        `INSERT INTO furnace_operations (
           operation_key,player_id,request_id,action,request_hash,furnace_id,job_id,result_quantity
         ) VALUES ($1,$2,$3,'collect',$4,$5,$6,$7)`,
        [
          operationKey(player.playerId, requestId),
          player.playerId,
          requestId,
          hash,
          furnaceId,
          readyJobs[0]!.job.job_id,
          collectedQuantity
        ]
      );
      const remainingJobs = await currentJobs(client, furnaceId);
      const metallurgyRank = await this.masteries.professionRankInTransaction(client, player.playerId, "metallurgy");
      await client.query("COMMIT");
      return {
        state: stateSnapshot(
          mapFurnace(furnace),
          remainingJobs,
          nowMs,
          metallurgyRank
        ),
        inventory: latestInventory,
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

  /**
   * Instantly refines Crude Oil into Glimmer Oil (item `refined_oil`) at the
   * player's Furnace. The account's Glimmer debit, the Crude Oil debit, the
   * Glimmer Oil grant, and the request record commit in one transaction, and
   * a retried request ID replays the recorded result without charging again.
   */
  /** Instant one-way breakdown (metal trinkets to Slag, essences, gems); never uses the queue. */
  private async breakdown(
    player: PlayerRecord,
    requestId: string,
    furnaceId: string,
    itemId: string,
    quantity: number,
    confirmHighGrade: boolean | undefined
  ): Promise<FurnaceMutationResult> {
    requireRequestId(requestId);
    const entry = materialBreakdown(itemId);
    if (!entry || entry.station !== "furnace") {
      throw new FurnaceError("FURNACE_RECIPE_UNKNOWN", "That item does not break down at a Furnace.");
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > FURNACE_BREAKDOWN_MAX_QUANTITY) {
      throw new FurnaceError("FURNACE_INVALID_QUANTITY", `Choose between 1 and ${FURNACE_BREAKDOWN_MAX_QUANTITY}.`);
    }
    requirePosition(player);
    const hash = requestHash("breakdown", player.playerId, furnaceId, itemId, quantity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "breakdown", hash);
        const furnace = await requireFurnace(client, replay.furnace_id);
        const jobs = await currentJobs(client, furnace.furnace_id);
        const metallurgyRank = await this.masteries.professionRankInTransaction(client, player.playerId, "metallurgy");
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { state: stateSnapshot(mapFurnace(furnace), jobs, this.now(), metallurgyRank), inventory, replayed: true };
      }
      const furnace = await this.requireOwnedInRange(client, player, furnaceId, true);
      const guard = breakdownGuardFailure(itemId, quantity, confirmHighGrade);
      if (guard) throw new FurnaceError(`FURNACE_${guard.code}`, guard.message);
      const spendable = await spendableItemCounts(this.inventory, client, player.playerId);
      if ((spendable.get(itemId) ?? 0) < quantity) {
        throw new FurnaceError("FURNACE_MATERIALS_REQUIRED", `You need ${quantity} you can spend (kept items are not used).`);
      }
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `furnace:breakdown:debit:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "furnace_breakdown",
        sourceEntityType: "furnace",
        sourceEntityId: furnaceId,
        metadata: { requestId, itemId, quantity },
        debits: [{ itemId: entry.inputItemId, variant: null, quantity }]
      });
      const outputQuantity = quantity * entry.outputPerInput;
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `furnace:breakdown:grant:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "furnace_breakdown",
          sourceEntityType: "furnace",
          sourceEntityId: furnaceId,
          metadata: { requestId, itemId, quantity },
          grants: [{ itemId: entry.outputItemId, variant: null, quantity: outputQuantity }]
        })).inventory;
      } catch (error) {
        if (isInventoryCapacityError(error)) throw new FurnaceError("FURNACE_INVENTORY_FULL", "You cannot carry that much.");
        throw error;
      }
      await client.query(
        `INSERT INTO furnace_operations (
           operation_key,player_id,request_id,action,request_hash,furnace_id,job_id,result_quantity
         ) VALUES ($1,$2,$3,'breakdown',$4,$5,NULL,$6)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, furnaceId, outputQuantity]
      );
      const jobs = await currentJobs(client, furnaceId);
      const metallurgyRank = await this.masteries.professionRankInTransaction(client, player.playerId, "metallurgy");
      await client.query("COMMIT");
      return { state: stateSnapshot(mapFurnace(furnace), jobs, this.now(), metallurgyRank), inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async refineGlimmerOil(
    player: PlayerRecord,
    requestId: string,
    furnaceId: string,
    quantity: number
  ): Promise<FurnaceGlimmerOilRefineResult> {
    requireRequestId(requestId);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > FURNACE_GLIMMER_OIL_MAX_QUANTITY) {
      throw new FurnaceError(
        "FURNACE_INVALID_QUANTITY",
        `Choose between 1 and ${FURNACE_GLIMMER_OIL_MAX_QUANTITY} Glimmer Oil.`
      );
    }
    requirePosition(player);
    const hash = requestHash("refine", player.playerId, furnaceId, quantity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "refine", hash);
        const furnace = await requireFurnace(client, replay.furnace_id);
        const jobs = await currentJobs(client, furnace.furnace_id);
        const metallurgyRank = await this.masteries.professionRankInTransaction(client, player.playerId, "metallurgy");
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        const premiumWallet = await this.premiumWallet.snapshotInTransaction(
          client,
          await requireAccountId(client, player.playerId)
        );
        await client.query("COMMIT");
        return {
          state: stateSnapshot(mapFurnace(furnace), jobs, this.now(), metallurgyRank),
          inventory,
          premiumWallet,
          refinedQuantity: replay.result_quantity,
          replayed: true
        };
      }
      const furnace = await this.requireOwnedInRange(client, player, furnaceId, true);
      const accountId = await requireAccountId(client, player.playerId);
      const glimmer = quantity * FURNACE_GLIMMER_OIL_GLIMMER_PER_UNIT;
      const crudeOil = quantity * FURNACE_GLIMMER_OIL_CRUDE_OIL_PER_UNIT;
      try {
        await this.premiumWallet.debitForOperationInTransaction(client, {
          accountId,
          currency: "glimmer",
          amount: BigInt(glimmer),
          operationKey: `furnace:refine:${player.playerId}:${requestId}`,
          reason: "spend",
          actorPlayerId: player.playerId,
          refType: "furnace_glimmer_oil",
          refId: requestId,
          metadata: { furnaceId, itemId: FURNACE_GLIMMER_OIL_ITEM_ID, quantity }
        });
      } catch (error) {
        if (error instanceof PremiumWalletOperationError && error.code === "PREMIUM_WALLET_INSUFFICIENT_FUNDS") {
          throw new FurnaceError(
            "FURNACE_GLIMMER_REQUIRED",
            `Refining ${quantity} Glimmer Oil requires ${glimmer} Glimmer.`
          );
        }
        throw error;
      }
      try {
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `furnace:refine:debit:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "furnace_refining",
          sourceEntityType: "furnace",
          sourceEntityId: furnaceId,
          metadata: { requestId, quantity },
          debits: [{ itemId: "crude_oil", variant: null, quantity: crudeOil }]
        });
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new FurnaceError(
            "FURNACE_MATERIALS_REQUIRED",
            `Refining ${quantity} Glimmer Oil requires ${crudeOil} Crude Oil.`
          );
        }
        throw error;
      }
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `furnace:refine:grant:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "furnace_refining",
          sourceEntityType: "furnace",
          sourceEntityId: furnaceId,
          metadata: { requestId, quantity },
          grants: [{ itemId: FURNACE_GLIMMER_OIL_ITEM_ID, variant: null, quantity }]
        })).inventory;
      } catch (error) {
        if (isInventoryCapacityError(error)) {
          throw new FurnaceError("FURNACE_INVENTORY_FULL", "You cannot carry that much Glimmer Oil.");
        }
        throw error;
      }
      await client.query(
        `INSERT INTO furnace_operations (
           operation_key,player_id,request_id,action,request_hash,furnace_id,job_id,result_quantity
         ) VALUES ($1,$2,$3,'refine',$4,$5,NULL,$6)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, furnaceId, quantity]
      );
      const jobs = await currentJobs(client, furnaceId);
      const metallurgyRank = await this.masteries.professionRankInTransaction(client, player.playerId, "metallurgy");
      const premiumWallet = await this.premiumWallet.snapshotInTransaction(client, accountId);
      await client.query("COMMIT");
      return {
        state: stateSnapshot(mapFurnace(furnace), jobs, this.now(), metallurgyRank),
        inventory,
        premiumWallet,
        refinedQuantity: quantity,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireOwnedInRange(
    queryable: Pick<pg.Pool | pg.PoolClient, "query">,
    player: PlayerRecord,
    furnaceId: string,
    lock: boolean
  ): Promise<FurnaceRow> {
    const result = await queryable.query<FurnaceRow>(
      `${FURNACE_SELECT}
       WHERE furnace.furnace_id=$1::uuid
         AND furnace.removed_at IS NULL
         AND furnace.owner_player_id=$2
         AND furnace.world_id=$3
         AND furnace.region_code=$4
         AND ST_DWithin(
           furnace.geom::geography,
           ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,
           $7
         )
       ${lock ? "FOR UPDATE OF furnace" : ""}`,
      [
        furnaceId,
        player.playerId,
        this.worldId,
        player.regionCode,
        player.position.lon,
        player.position.lat,
        FURNACE_INTERACTION_RADIUS_M
      ]
    );
    if (!result.rows[0]) {
      throw new FurnaceError(
        "FURNACE_OWNER_OR_RANGE_REQUIRED",
        `Move within ${FURNACE_INTERACTION_RADIUS_M}m of your Furnace to use it.`
      );
    }
    return result.rows[0];
  }
}

const FURNACE_SELECT = `SELECT
  furnace.furnace_id,furnace.manor_id,furnace.owner_player_id,
  owner.username AS owner_username,furnace.region_code,furnace.lat,furnace.lon,
  furnace.built_at,furnace.placement_revision::text
 FROM player_furnaces furnace
 JOIN players owner ON owner.id=furnace.owner_player_id`;

const BUILD_RETURNING_FIELDS = `build_id,owner_player_id,request_id,request_hash,
  manor_id,world_id,region_code,lat,lon,status,started_at,completes_at,
  furnace_id,cancel_reason`;

async function requireFurnace(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  furnaceId: string
): Promise<FurnaceRow> {
  const result = await queryable.query<FurnaceRow>(
    `${FURNACE_SELECT}
     WHERE furnace.furnace_id=$1::uuid AND furnace.removed_at IS NULL`,
    [furnaceId]
  );
  return requireRow(result.rows[0], "Furnace no longer exists");
}

async function buildForRequest(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  requestId: string
): Promise<BuildRow | null> {
  const result = await queryable.query<BuildRow>(
    `SELECT ${BUILD_RETURNING_FIELDS}
     FROM furnace_build_jobs
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
     FROM furnace_build_jobs
     WHERE owner_player_id=$1 AND status='constructing'
     ORDER BY started_at,build_id
     LIMIT 1
     ${lock ? "FOR UPDATE" : ""}`,
    [playerId]
  );
  return result.rows[0] ?? null;
}

async function hasActiveFurnace(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string
): Promise<boolean> {
  const result = await queryable.query(
    `SELECT 1
     FROM player_furnaces
     WHERE owner_player_id=$1 AND removed_at IS NULL
     LIMIT 1`,
    [playerId]
  );
  return result.rows[0] !== undefined;
}

async function currentJobs(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  furnaceId: string
): Promise<JobRow[]> {
  const result = await queryable.query<JobRow>(
    `SELECT job.job_id,job.furnace_id,job.owner_player_id,job.recipe_id,job.requested_quantity,
       job.collected_quantity,job.started_at,job.cleared_at,job.duration_ms,
       COALESCE((
         SELECT array_agg(unit.outcome ORDER BY unit.unit_index)
         FROM furnace_smelt_units AS unit
         WHERE unit.job_id=job.job_id
       ), ARRAY[]::text[]) AS unit_outcomes
     FROM furnace_smelt_jobs
     AS job
     WHERE job.furnace_id=$1::uuid AND job.cleared_at IS NULL
     ORDER BY job.started_at,job.created_at,job.job_id
     FOR UPDATE`,
    [furnaceId]
  );
  return result.rows;
}

function stateSnapshot(
  furnace: FurnaceWorldSnapshot,
  jobs: readonly JobRow[],
  nowMs: number,
  metallurgyRank = 0
): FurnaceStateSnapshot {
  return {
    furnace,
    jobs: jobs.map((job) => mapJob(job, nowMs)),
    queueCapacity: FURNACE_QUEUE_CAPACITY,
    occupiedSlots: jobs.reduce(
      (total, job) => total + job.requested_quantity - job.collected_quantity,
      0
    ),
    serverTime: nowMs,
    metallurgyRank
  };
}

function jobFinishesAt(job: JobRow): number {
  const recipe = requireFurnaceRecipe(job.recipe_id);
  return new Date(job.started_at).getTime() + (job.duration_ms ?? recipe.durationMs) * (
    recipe.completionMode === "sequential" ? job.requested_quantity : 1
  );
}

function mapFurnace(row: FurnaceRow): FurnaceWorldSnapshot {
  return {
    furnaceId: row.furnace_id,
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

function mapBuild(row: BuildRow): FurnaceBuildSnapshot {
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

function mapJob(row: JobRow, nowMs: number): FurnaceJobSnapshot {
  const recipe = requireFurnaceRecipe(row.recipe_id);
  const startedAtMs = new Date(row.started_at).getTime();
  const completedQuantity = completedFurnaceOutput(
    row.recipe_id,
    startedAtMs,
    row.requested_quantity,
    nowMs,
    row.duration_ms
  );
  const productionFinished = completedQuantity >= row.requested_quantity;
  const readyOutcomes = row.recipe_id === "iron_bar"
    ? row.unit_outcomes.slice(row.collected_quantity, completedQuantity)
    : [];
  return {
    jobId: row.job_id,
    recipeId: row.recipe_id,
    outputItemId: recipe.outputItemId,
    outputDisplayName: recipe.outputDisplayName,
    requestedQuantity: row.requested_quantity,
    completedQuantity,
    collectedQuantity: row.collected_quantity,
    readyQuantity: Math.max(0, completedQuantity - row.collected_quantity),
    startedAt: new Date(row.started_at).toISOString(),
    nextCompletesAt: productionFinished
      ? null
      : new Date(recipe.completionMode === "batch"
          ? startedAtMs + (row.duration_ms ?? recipe.durationMs)
          : startedAtMs + (completedQuantity + 1) * (row.duration_ms ?? recipe.durationMs)
        ).toISOString(),
    productionFinished,
    ...(row.recipe_id === "iron_bar" ? {
      readySuccessQuantity: readyOutcomes.filter((outcome) => outcome !== "failure").length,
      readyFailureQuantity: readyOutcomes.filter((outcome) => outcome === "failure").length
    } : {})
  };
}

async function lockOperation(
  client: pg.PoolClient,
  playerId: string,
  requestId: string
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [`furnace-operation:${playerId}:${requestId}`]
  );
}

async function requireAccountId(
  queryable: Pick<pg.PoolClient, "query">,
  playerId: string
): Promise<string> {
  const result = await queryable.query<{ account_id: string | null }>(
    "SELECT account_id::text FROM players WHERE id=$1",
    [playerId]
  );
  const accountId = result.rows[0]?.account_id;
  if (!accountId) {
    throw new FurnaceError("FURNACE_ACCOUNT_REQUIRED", "Sign in to an account to spend Glimmer.");
  }
  return accountId;
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
    `SELECT action,request_hash,furnace_id,job_id,result_quantity
     FROM furnace_operations
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
    throw new FurnaceError(
      "FURNACE_REPLAY_CONFLICT",
      "That request ID was already used for a different Furnace action."
    );
  }
}

/**
 * Bars per smelted unit: 2 with the Metallurgy double-bar chance, else 1. The roll is a pure hash of
 * the job and unit, so a replayed or retried collection of the same unit always decides the same way.
 */
export function furnaceBarYield(metallurgyRank: number, jobId: string, unitIndex: number): 1 | 2 {
  const chance = metallurgyDoubleBarChance(metallurgyRank);
  if (chance <= 0) return 1;
  const digest = createHash("sha256").update(`furnace-double-bar-v1:${jobId}:${unitIndex}`).digest("hex");
  const unit = Number.parseInt(digest.slice(0, 13), 16) / 0x10_0000_0000_0000;
  return unit < chance ? 2 : 1;
}

function requestHash(action: string, ...parts: Array<string | number>): string {
  return createHash("sha256")
    .update(JSON.stringify([action, ...parts]))
    .digest("hex");
}

function operationKey(playerId: string, requestId: string): string {
  return `furnace:${playerId}:${requestId}`;
}

function requireRequestId(requestId: string): void {
  if (!requestId || requestId.length > 128) {
    throw new FurnaceError("FURNACE_INVALID_REQUEST", "A valid request ID is required.");
  }
}

function requireRecipeQuantity(recipeId: FurnaceRecipeId, quantity: number): void {
  const recipe = requireFurnaceRecipe(recipeId);
  if (!Number.isSafeInteger(quantity) || quantity < recipe.minimumQuantity || quantity > recipe.maximumQuantity) {
    throw new FurnaceError(
      "FURNACE_INVALID_QUANTITY",
      `Choose between ${recipe.minimumQuantity} and ${recipe.maximumQuantity} ${recipe.outputDisplayName}${recipe.maximumQuantity === 1 ? "" : "s"}.`
    );
  }
}

function requirePosition(player: PlayerRecord): void {
  if (!Number.isFinite(player.position.lat) || !Number.isFinite(player.position.lon)) {
    throw new FurnaceError("FURNACE_INVALID_POSITION", "Your world position is unavailable.");
  }
}

function requireRow<T>(value: T | undefined, message: string): T {
  if (!value) throw new FurnaceError("FURNACE_CONFLICT", message);
  return value;
}

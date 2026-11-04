import { createHash, randomUUID } from "node:crypto";

import {
  KITCHEN_BUILD_COST,
  KITCHEN_COOK_ANY_CATEGORY,
  KITCHEN_COOK_ANY_MAX_QUANTITY,
  KITCHEN_MAX_BATCH_SIZE,
  KITCHEN_BUILD_DURATION_MS,
  KITCHEN_INTERACTION_RADIUS_M,
  KITCHEN_MAX_MANOR_DISTANCE_M,
  KITCHEN_QUEUE_CAPACITY,
  KITCHEN_RECIPES,
  KITCHEN_SNAPSHOT_RADIUS_M,
  kitchenOutputQuantity,
  requireKitchenRecipe,
  type CategoryPick,
  type DroppedItemSnapshot,
  type KitchenBuildSnapshot,
  type KitchenJobSnapshot,
  type KitchenRecipeId,
  type KitchenJobRecipeId,
  type KitchenStateSnapshot,
  type KitchenWorldSnapshot,
  type PlayerInventorySnapshot,
  artificerBulkBonusItems,
  artificerCraftDurationMs,
} from "@ash-atlas/shared";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";
import { activeSpecializationRank } from "./skills/activeSpecialization.js";
import { MasteryService } from "./masteries.js";
import { breakdownGuardFailure, resolveMaterialSpend, spendableItemCounts } from "./materialSpend.js";
import { createSystemGroundDropsInTransaction } from "./droppedItems.js";
import type { PlayerRecord } from "./state.js";
import { requireOutdoorStationClearance } from "./stationPlacementClearance.js";

type KitchenRow = {
  kitchen_id: string;
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
  kitchen_id: string;
  owner_player_id: string;
  recipe_id: KitchenJobRecipeId;
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
  kitchen_id: string;
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
  kitchen_id: string | null;
  cancel_reason: string | null;
};

export class KitchenError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KitchenError";
  }
}

export type KitchenMutationResult = Readonly<{
  state: KitchenStateSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

export type KitchenCollectionResult = KitchenMutationResult & Readonly<{
  collectedQuantity: number;
}>;

export type KitchenBuildRequestResult =
  | Readonly<{
      status: "constructing";
      build: KitchenBuildSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
    }>
  | Readonly<{
      status: "completed";
      kitchen: KitchenWorldSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: true;
    }>
  | Readonly<{
      status: "cancelled";
      buildId: string;
      inventory: PlayerInventorySnapshot;
      replayed: true;
    }>;

export type KitchenBuildCompletion = Readonly<{
  playerId: string;
  requestId: string;
  kitchen: KitchenWorldSnapshot;
  inventory: PlayerInventorySnapshot;
}>;

export type KitchenBuildCancellation = Readonly<{
  playerId: string;
  requestId: string;
  buildId: string;
  inventory: PlayerInventorySnapshot;
  droppedItems: DroppedItemSnapshot[];
  reason: string;
}>;

export class KitchenService {
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
    private readonly masteries: Pick<MasteryService, "grantProfessionXpCompactInTransaction"> = new MasteryService(pool)
  ) {}

  async listNear(player: PlayerRecord, radiusM = KITCHEN_SNAPSHOT_RADIUS_M): Promise<KitchenWorldSnapshot[]> {
    const result = await this.pool.query<KitchenRow>(
      `${KITCHEN_SELECT}
       WHERE kitchen.removed_at IS NULL AND kitchen.world_id=$1 AND kitchen.region_code=$2
         AND ST_DWithin(kitchen.geom::geography,
           ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5)
       ORDER BY ST_Distance(kitchen.geom::geography,
           ST_SetSRID(ST_MakePoint($3,$4),4326)::geography),kitchen.kitchen_id`,
      [this.worldId, player.regionCode, player.position.lon, player.position.lat,
        Math.min(Math.max(radiusM, 1), KITCHEN_SNAPSHOT_RADIUS_M)]
    );
    return result.rows.map(mapKitchen);
  }

  async build(player: PlayerRecord, requestId: string): Promise<KitchenBuildRequestResult> {
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
        if (replay.request_hash !== hash) throw new KitchenError("KITCHEN_REPLAY_CONFLICT", "The Kitchen request ID was already used.");
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        if (replay.status === "completed" && replay.kitchen_id) {
          const kitchen = await requireKitchen(client, replay.kitchen_id);
          await client.query("COMMIT");
          return { status: "completed", kitchen: mapKitchen(kitchen), inventory, replayed: true };
        }
        if (replay.status === "cancelled") {
          await client.query("COMMIT");
          return { status: "cancelled", buildId: replay.build_id, inventory, replayed: true };
        }
        await client.query("COMMIT");
        return { status: "constructing", build: mapBuild(replay), inventory, replayed: true };
      }
      if (await activeBuild(client, player.playerId, true)) {
        throw new KitchenError("KITCHEN_BUILD_ACTIVE", "Finish or cancel the current Kitchen construction first.");
      }
      const conflictingBuilds = [
        ["furnace_build_jobs", "Furnace"],
        ["tannery_build_jobs", "Tannery"],
        ["loom_build_jobs", "Loom"]
      ] as const;
      for (const [table, label] of conflictingBuilds) {
        if ((await client.query(`SELECT 1 FROM ${table} WHERE owner_player_id=$1 AND status='constructing' LIMIT 1`, [player.playerId])).rows[0]) {
          throw new KitchenError("KITCHEN_BUILD_ACTIVE", `Finish the current ${label} construction first.`);
        }
      }
      if (await hasActiveKitchen(client, player.playerId)) {
        throw new KitchenError("KITCHEN_OWNER_LIMIT", "You may only own one Kitchen.");
      }
      const manor = await client.query<{ id: string; world_lat: number; world_lon: number }>(
        `SELECT id,world_lat,world_lon FROM player_manors
         WHERE owner_player_id=$1 AND built_at IS NOT NULL AND world_region_code=$2
           AND ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5)
         FOR SHARE`,
        [player.playerId, player.regionCode, player.position.lon, player.position.lat, KITCHEN_MAX_MANOR_DISTANCE_M]
      );
      if (!manor.rows[0]) throw new KitchenError("KITCHEN_MANOR_RANGE_REQUIRED", "Kitchens must be built within 650m of your Manor.");
      await requireOutdoorStationClearance(client, this.worldId, player.regionCode, player.position, {
        manorCenter: { lat: Number(manor.rows[0].world_lat), lon: Number(manor.rows[0].world_lon) },
        maxManorDistanceM: KITCHEN_MAX_MANOR_DISTANCE_M,
        movementAnchor: player.anchor,
        moveLeashRadiusM: player.moveLeashRadiusM
      });
      const buildId = randomUUID();
      const startedAt = this.now();
      const completesAt = startedAt + KITCHEN_BUILD_DURATION_MS;
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `kitchen:build:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "kitchen_construction",
          sourceEntityType: "kitchen_build",
          sourceEntityId: buildId,
          metadata: { requestId },
          debits: [
            { itemId: "stone", variant: null, quantity: KITCHEN_BUILD_COST.stone },
            { itemId: "wood", variant: null, quantity: KITCHEN_BUILD_COST.wood }
          ]
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new KitchenError("KITCHEN_BUILD_MATERIALS_REQUIRED", `Building a Kitchen requires ${KITCHEN_BUILD_COST.wood} Wood and ${KITCHEN_BUILD_COST.stone} Stone.`);
        }
        throw error;
      }
      const inserted = await client.query<BuildRow>(
        `INSERT INTO kitchen_build_jobs (
          build_id,owner_player_id,request_id,request_hash,manor_id,world_id,region_code,
          lat,lon,geom,started_at,completes_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
          ST_SetSRID(ST_MakePoint($9,$8),4326),to_timestamp($10 / 1000.0),to_timestamp($11 / 1000.0))
         RETURNING ${BUILD_RETURNING_FIELDS}`,
        [buildId, player.playerId, requestId, hash, manor.rows[0].id, this.worldId,
          player.regionCode, player.position.lat, player.position.lon, startedAt, completesAt]
      );
      const build = requireRow(inserted.rows[0], "Kitchen construction could not be started");
      await client.query("COMMIT");
      return { status: "constructing", build: mapBuild(build), inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async activeBuildForPlayer(playerId: string): Promise<Readonly<{ requestId: string; build: KitchenBuildSnapshot; inventory: PlayerInventorySnapshot }> | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await activeBuild(client, playerId, false);
      if (!row) { await client.query("COMMIT"); return null; }
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return { requestId: row.request_id, build: mapBuild(row), inventory };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async cancelBuildForMovement(playerId: string): Promise<KitchenBuildCancellation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockBuildChannel(client, playerId);
      const build = await activeBuild(client, playerId, true);
      if (!build) { await client.query("COMMIT"); return null; }
      const cancelled = await this.cancelBuildInTransaction(client, build, "movement");
      await client.query("COMMIT");
      return cancelled;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async reconcileDueBuilds(limit = 100): Promise<Readonly<{ completed: KitchenBuildCompletion[]; cancelled: KitchenBuildCancellation[] }>> {
    const due = await this.pool.query<{ build_id: string }>(
      `SELECT build_id FROM kitchen_build_jobs WHERE status='constructing' AND completes_at <= clock_timestamp() ORDER BY completes_at,build_id LIMIT $1`,
      [limit]
    );
    const completed: KitchenBuildCompletion[] = [];
    const cancelled: KitchenBuildCancellation[] = [];
    for (const { build_id: buildId } of due.rows) {
      const result = await this.completeBuild(buildId);
      if (!result) continue;
      if ("kitchen" in result) completed.push(result);
      else cancelled.push(result);
    }
    return { completed, cancelled };
  }

  async state(player: PlayerRecord, kitchenId: string): Promise<KitchenStateSnapshot> {
    const kitchen = await this.requireInRange(this.pool, player, kitchenId, false);
    const jobs = await currentJobs(this.pool, kitchenId);
    return stateSnapshot(mapKitchen(kitchen), jobs.filter((job) => job.owner_player_id === player.playerId), this.now(), jobs.length);
  }

  async start(player: PlayerRecord, requestId: string, kitchenId: string, recipeId: KitchenRecipeId, quantity: number, confirmHighGrade?: boolean): Promise<KitchenMutationResult> {
    requireRequestId(requestId);
    const recipe = requireKitchenRecipe(recipeId);
    requireRecipeQuantity(recipeId, quantity);
    requirePosition(player);
    const hash = requestHash("start", player.playerId, kitchenId, recipeId, quantity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "start", hash);
        const kitchen = await this.requireInRange(client, player, replay.kitchen_id, false);
        const jobs = await currentJobs(client, kitchen.kitchen_id);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { state: stateSnapshot(mapKitchen(kitchen), jobs.filter((job) => job.owner_player_id === player.playerId), this.now(), jobs.length), inventory, replayed: true };
      }
      const kitchen = await this.requireInRange(client, player, kitchenId, true);
      const jobs = await currentJobs(client, kitchenId);
      if (jobs.length >= KITCHEN_QUEUE_CAPACITY) throw new KitchenError("KITCHEN_QUEUE_FULL", "The Kitchen queue is full. Collect finished food before adding another batch.");
      if (recipe.breakdownGrade !== undefined) {
        const guard = breakdownGuardFailure(recipe.inputItemId, quantity, confirmHighGrade);
        if (guard) throw new KitchenError(guard.code, guard.message);
        const spendable = await spendableItemCounts(this.inventory, client, player.playerId);
        if ((spendable.get(recipe.inputItemId) ?? 0) < quantity) {
          throw new KitchenError("KITCHEN_MATERIALS_REQUIRED", `${recipe.displayName} needs ${quantity} ${recipe.inputDisplayName} you can spend (kept items are not used).`);
        }
      }
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `kitchen:start:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "kitchen_processing",
          sourceEntityType: "kitchen",
          sourceEntityId: kitchenId,
          metadata: { requestId, recipeId, quantity },
          debits: [{ itemId: recipe.inputItemId, variant: null, quantity }]
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new KitchenError("KITCHEN_MATERIALS_REQUIRED", `${recipe.displayName} requires ${quantity} ${recipe.inputDisplayName}.`);
        }
        throw error;
      }
      const nowMs = this.now();
      const scheduledStartMs = jobs.reduce((tail, queued) => Math.max(tail, jobFinishesAt(queued)), nowMs);
      const artificerRank = await activeSpecializationRank(client, player.playerId, "artificer");
      const baseOutputQuantity = kitchenOutputQuantity(recipeId, quantity);
      const bonusQuantity = artificerBulkBonusItems(baseOutputQuantity, artificerRank);
      const outputQuantity = baseOutputQuantity + bonusQuantity;
      const completesAtMs = scheduledStartMs + artificerCraftDurationMs(recipe.durationMs, artificerRank);
      const inserted = await client.query<JobRow>(
        `INSERT INTO kitchen_jobs (kitchen_id,owner_player_id,recipe_id,requested_input_quantity,output_quantity,started_at,completes_at,bonus_quantity)
         VALUES ($1,$2,$3,$4,$5,to_timestamp($6 / 1000.0),to_timestamp($7 / 1000.0),$8)
         RETURNING job_id,kitchen_id,owner_player_id,recipe_id,requested_input_quantity,output_quantity,collected_quantity,started_at,completes_at,cleared_at`,
        [kitchenId, player.playerId, recipeId, quantity, outputQuantity, scheduledStartMs, completesAtMs, bonusQuantity]
      );
      const job = requireRow(inserted.rows[0], "Kitchen job could not be started");
      await client.query(
        `INSERT INTO kitchen_operations (operation_key,player_id,request_id,action,request_hash,kitchen_id,job_id)
         VALUES ($1,$2,$3,'start',$4,$5,$6)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, kitchenId, job.job_id]
      );
      await client.query("COMMIT");
      return { state: stateSnapshot(mapKitchen(kitchen), [...jobs, job].filter((candidate) => candidate.owner_player_id === player.playerId), nowMs, jobs.length + 1), inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  /**
   * "Cook any Meat / Fish": picks lowest grade first (or the player's previewed picks), then fills
   * the free queue slots with one job per concrete item (each through its per-item recipe, at most
   * 50 per job). Whatever does not fit stays in the inventory and is reported as leftover.
   */
  async startCookAny(
    player: PlayerRecord,
    requestId: string,
    kitchenId: string,
    quantity: number,
    picks?: readonly (readonly CategoryPick[])[],
    confirmHighGrade?: boolean
  ): Promise<KitchenMutationResult & Readonly<{ leftoverQuantity: number }>> {
    requireRequestId(requestId);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > KITCHEN_COOK_ANY_MAX_QUANTITY) {
      throw new KitchenError("KITCHEN_INVALID_QUANTITY", `Choose between 1 and ${KITCHEN_COOK_ANY_MAX_QUANTITY} Meat or Fish.`);
    }
    requirePosition(player);
    const hash = requestHash("cook_any", player.playerId, kitchenId, quantity, JSON.stringify(picks ?? null));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "start", hash);
        const kitchen = await this.requireInRange(client, player, replay.kitchen_id, false);
        const jobs = await currentJobs(client, kitchen.kitchen_id);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { state: stateSnapshot(mapKitchen(kitchen), jobs.filter((job) => job.owner_player_id === player.playerId), this.now(), jobs.length), inventory, replayed: true, leftoverQuantity: replay.result_quantity };
      }
      const kitchen = await this.requireInRange(client, player, kitchenId, true);
      const jobs = await currentJobs(client, kitchenId);
      const freeSlots = KITCHEN_QUEUE_CAPACITY - jobs.length;
      if (freeSlots <= 0) throw new KitchenError("KITCHEN_QUEUE_FULL", "The Kitchen queue is full. Collect finished food before adding another batch.");
      const spendable = await spendableItemCounts(this.inventory, client, player.playerId);
      const resolved = resolveMaterialSpend(
        "Cook any Meat / Fish", [], [{ category: KITCHEN_COOK_ANY_CATEGORY, quantity }], spendable,
        { ...(picks === undefined ? {} : { picks }), ...(confirmHighGrade === undefined ? {} : { confirmHighGrade }) }
      );
      if (!resolved.ok) throw new KitchenError(`KITCHEN_${resolved.failure.code}`, resolved.failure.message);
      const chunks: { recipeId: KitchenRecipeId; quantity: number }[] = [];
      for (const debit of resolved.debits) {
        for (let left = debit.quantity; left > 0; left -= KITCHEN_MAX_BATCH_SIZE) {
          chunks.push({ recipeId: debit.itemId as KitchenRecipeId, quantity: Math.min(left, KITCHEN_MAX_BATCH_SIZE) });
        }
      }
      const queued = chunks.slice(0, freeSlots);
      const leftoverQuantity = chunks.slice(freeSlots).reduce((total, chunk) => total + chunk.quantity, 0);
      const debits = new Map<string, number>();
      for (const chunk of queued) debits.set(chunk.recipeId, (debits.get(chunk.recipeId) ?? 0) + chunk.quantity);
      const inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `kitchen:start:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "kitchen_processing",
        sourceEntityType: "kitchen",
        sourceEntityId: kitchenId,
        metadata: { requestId, recipeId: "cook_any", quantity, leftoverQuantity },
        debits: [...debits].map(([itemId, debitQuantity]) => ({ itemId: itemId as KitchenRecipeId, variant: null, quantity: debitQuantity }))
      })).inventory;
      const nowMs = this.now();
      let tailMs = jobs.reduce((tail, queuedJob) => Math.max(tail, jobFinishesAt(queuedJob)), nowMs);
      const artificerRank = await activeSpecializationRank(client, player.playerId, "artificer");
      const inserted: JobRow[] = [];
      for (const chunk of queued) {
        const recipe = requireKitchenRecipe(chunk.recipeId);
        const completesAtMs = tailMs + artificerCraftDurationMs(recipe.durationMs, artificerRank);
        const baseOutputQuantity = kitchenOutputQuantity(chunk.recipeId, chunk.quantity);
        const bonusQuantity = artificerBulkBonusItems(baseOutputQuantity, artificerRank);
        const row = await client.query<JobRow>(
          `INSERT INTO kitchen_jobs (kitchen_id,owner_player_id,recipe_id,requested_input_quantity,output_quantity,started_at,completes_at,bonus_quantity)
           VALUES ($1,$2,$3,$4,$5,to_timestamp($6 / 1000.0),to_timestamp($7 / 1000.0),$8)
           RETURNING job_id,kitchen_id,owner_player_id,recipe_id,requested_input_quantity,output_quantity,collected_quantity,started_at,completes_at,cleared_at`,
          [kitchenId, player.playerId, chunk.recipeId, chunk.quantity, baseOutputQuantity + bonusQuantity, tailMs, completesAtMs, bonusQuantity]
        );
        inserted.push(requireRow(row.rows[0], "Kitchen job could not be started"));
        tailMs = completesAtMs;
      }
      await client.query(
        `INSERT INTO kitchen_operations (operation_key,player_id,request_id,action,request_hash,kitchen_id,job_id,result_quantity)
         VALUES ($1,$2,$3,'start',$4,$5,$6,$7)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, kitchenId, inserted[0]!.job_id, leftoverQuantity]
      );
      await client.query("COMMIT");
      const allJobs = [...jobs, ...inserted];
      return { state: stateSnapshot(mapKitchen(kitchen), allJobs.filter((job) => job.owner_player_id === player.playerId), nowMs, allJobs.length), inventory, replayed: false, leftoverQuantity };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async collect(player: PlayerRecord, requestId: string, kitchenId: string): Promise<KitchenCollectionResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const hash = requestHash("collect", player.playerId, kitchenId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "collect", hash);
        const kitchen = await this.requireInRange(client, player, replay.kitchen_id, false);
        const jobs = await currentJobs(client, kitchen.kitchen_id);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { state: stateSnapshot(mapKitchen(kitchen), jobs.filter((job) => job.owner_player_id === player.playerId), this.now(), jobs.length), inventory, collectedQuantity: replay.result_quantity, replayed: true };
      }
      const kitchen = await this.requireInRange(client, player, kitchenId, true);
      const jobs = await currentJobs(client, kitchenId);
      const playerJobs = jobs.filter((job) => job.owner_player_id === player.playerId);
      if (playerJobs.length === 0) throw new KitchenError("KITCHEN_JOB_REQUIRED", "This Kitchen has no food to collect.");
      const nowMs = this.now();
      const readyJobs = playerJobs.map((job) => ({ job, ready: nowMs >= new Date(job.completes_at).getTime() ? Math.max(0, job.output_quantity - job.collected_quantity) : 0 })).filter(({ ready }) => ready > 0);
      if (readyJobs.length === 0) throw new KitchenError("KITCHEN_OUTPUT_NOT_READY", "No Kitchen food is ready to collect yet.");
      const readyByItem = new Map<string, number>();
      for (const { job, ready } of readyJobs) {
        const itemId = kitchenJobOutput(job.recipe_id);
        readyByItem.set(itemId, (readyByItem.get(itemId) ?? 0) + ready);
      }
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `kitchen:collect:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "kitchen_processing",
        sourceEntityType: "kitchen",
        sourceEntityId: kitchenId,
        metadata: { requestId, jobIds: readyJobs.map(({ job }) => job.job_id) },
        grants: [...readyByItem].map(([itemId, quantity]) => ({ itemId: itemId as "simple_food" | "crude_oil", variant: null, quantity })),
        allowPartial: true
      });
      const remainingByItem = new Map(grant.grants.map((result) => [result.itemId as string, result.grantedQuantity]));
      let granted = 0;
      for (const { job, ready } of readyJobs) {
        const itemId = kitchenJobOutput(job.recipe_id);
        const quantity = Math.min(ready, remainingByItem.get(itemId) ?? 0);
        if (quantity <= 0) continue;
        remainingByItem.set(itemId, (remainingByItem.get(itemId) ?? 0) - quantity);
        granted += quantity;
        const collectedTotal = job.collected_quantity + quantity;
        await client.query(
          `UPDATE kitchen_jobs SET collected_quantity=$2,cleared_at=CASE WHEN $2=output_quantity THEN to_timestamp($3 / 1000.0) ELSE NULL END,updated_at=now() WHERE job_id=$1`,
          [job.job_id, collectedTotal, nowMs]
        );
        if (itemId === "crude_oil") {
          // Rendering fat or blubber is Oil Worker work (DROPS-PROGRESSION-DESIGN 4.2).
          await this.masteries.grantProfessionXpCompactInTransaction(client, {
            operationKey: `kitchen:xp:${job.job_id}:${collectedTotal}`,
            playerId: player.playerId,
            sourceId: `${job.job_id}:${collectedTotal}`,
            activity: { kind: "oil-harvest", harvestedCrude: quantity }
          });
        }
      }
      await client.query(
        `INSERT INTO kitchen_operations (operation_key,player_id,request_id,action,request_hash,kitchen_id,job_id,result_quantity)
         VALUES ($1,$2,$3,'collect',$4,$5,$6,$7)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, kitchenId, readyJobs[0]!.job.job_id, granted]
      );
      const remainingJobs = await currentJobs(client, kitchenId);
      await client.query("COMMIT");
      return { state: stateSnapshot(mapKitchen(kitchen), remainingJobs.filter((job) => job.owner_player_id === player.playerId), nowMs, remainingJobs.length), inventory: grant.inventory, collectedQuantity: granted, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async completeBuild(buildId: string): Promise<KitchenBuildCompletion | KitchenBuildCancellation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ owner_player_id: string }>("SELECT owner_player_id FROM kitchen_build_jobs WHERE build_id=$1::uuid", [buildId]);
      if (!owner.rows[0]) { await client.query("COMMIT"); return null; }
      await lockBuildChannel(client, owner.rows[0].owner_player_id);
      const selected = await client.query<BuildRow>(`SELECT ${BUILD_RETURNING_FIELDS} FROM kitchen_build_jobs WHERE build_id=$1::uuid FOR UPDATE`, [buildId]);
      const build = selected.rows[0];
      if (!build || build.status !== "constructing" || Date.parse(String(build.completes_at)) > this.now()) { await client.query("COMMIT"); return null; }
      const manor = await client.query<{ id: string }>(
        `SELECT manor.id FROM player_manors manor WHERE manor.id=$1::uuid AND manor.owner_player_id=$2 AND manor.built_at IS NOT NULL AND manor.world_region_code=$3
           AND ST_DWithin(manor.geom::geography,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,$6) FOR SHARE OF manor`,
        [build.manor_id, build.owner_player_id, build.region_code, build.lon, build.lat, KITCHEN_MAX_MANOR_DISTANCE_M]
      );
      if (!manor.rows[0] || await hasActiveKitchen(client, build.owner_player_id)) {
        const cancelled = await this.cancelBuildInTransaction(client, build, !manor.rows[0] ? "revalidation-failed" : "owner-limit");
        await client.query("COMMIT");
        return cancelled;
      }
      const inserted = await client.query<{ kitchen_id: string }>(
        `INSERT INTO player_kitchens (manor_id,owner_player_id,world_id,region_code,lat,lon,geom,built_at)
         VALUES ($1,$2,$3,$4,$5,$6,ST_SetSRID(ST_MakePoint($6,$5),4326),$7) RETURNING kitchen_id`,
        [build.manor_id, build.owner_player_id, build.world_id, build.region_code, build.lat, build.lon, build.completes_at]
      );
      const kitchenId = requireRow(inserted.rows[0], "Kitchen placement failed").kitchen_id;
      await client.query(`UPDATE kitchen_build_jobs SET status='completed',kitchen_id=$2::uuid,updated_at=clock_timestamp() WHERE build_id=$1::uuid`, [build.build_id, kitchenId]);
      await client.query(
        `INSERT INTO kitchen_operations (operation_key,player_id,request_id,action,request_hash,kitchen_id)
         VALUES ($1,$2,$3,'build',$4,$5)`,
        [operationKey(build.owner_player_id, build.request_id), build.owner_player_id, build.request_id, build.request_hash, kitchenId]
      );
      const kitchen = await requireKitchen(client, kitchenId);
      const inventory = await this.inventory.snapshotInTransaction(client, build.owner_player_id);
      await client.query("COMMIT");
      return { playerId: build.owner_player_id, requestId: build.request_id, kitchen: mapKitchen(kitchen), inventory };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async cancelBuildInTransaction(client: pg.PoolClient, build: BuildRow, reason: string): Promise<KitchenBuildCancellation> {
    const refund = await this.inventory.grantItemsForOperationInTransaction(client, {
      operationKey: `kitchen:build:${build.owner_player_id}:${build.request_id}:refund`,
      playerId: build.owner_player_id,
      source: "kitchen_construction_cancelled",
      sourceEntityType: "kitchen_build",
      sourceEntityId: build.build_id,
      metadata: { requestId: build.request_id, reason },
      allowPartial: true,
      grants: [
        { itemId: "stone", variant: null, quantity: KITCHEN_BUILD_COST.stone },
        { itemId: "wood", variant: null, quantity: KITCHEN_BUILD_COST.wood }
      ]
    });
    const droppedItems = await createSystemGroundDropsInTransaction(client, {
      operationKey: `kitchen:build:${build.owner_player_id}:${build.request_id}:refund-drop`,
      droppedByPlayerId: build.owner_player_id,
      regionCode: build.region_code,
      position: { lat: build.lat, lon: build.lon },
      reason: "kitchen_construction_cancelled",
      lines: [
        { itemId: "stone", quantity: Math.max(0, KITCHEN_BUILD_COST.stone - (refund.grants.find((grant) => grant.itemId === "stone")?.grantedQuantity ?? 0)), variant: null },
        { itemId: "wood", quantity: Math.max(0, KITCHEN_BUILD_COST.wood - (refund.grants.find((grant) => grant.itemId === "wood")?.grantedQuantity ?? 0)), variant: null }
      ].filter((line) => line.quantity > 0)
    });
    await client.query(`UPDATE kitchen_build_jobs SET status='cancelled',cancel_reason=$2,updated_at=clock_timestamp() WHERE build_id=$1::uuid AND status='constructing'`, [build.build_id, reason]);
    return { playerId: build.owner_player_id, requestId: build.request_id, buildId: build.build_id, inventory: refund.inventory, droppedItems, reason };
  }

  private async requireInRange(queryable: Pick<pg.Pool | pg.PoolClient, "query">, player: PlayerRecord, kitchenId: string, lock: boolean): Promise<KitchenRow> {
    const result = await queryable.query<KitchenRow>(
      `${KITCHEN_SELECT} WHERE kitchen.kitchen_id=$1::uuid AND kitchen.removed_at IS NULL AND kitchen.world_id=$2 AND kitchen.region_code=$3
         AND ST_DWithin(kitchen.geom::geography,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,$6) ${lock ? "FOR UPDATE OF kitchen" : ""}`,
      [kitchenId, this.worldId, player.regionCode, player.position.lon, player.position.lat, KITCHEN_INTERACTION_RADIUS_M]
    );
    if (!result.rows[0]) throw new KitchenError("KITCHEN_RANGE_REQUIRED", `Move within ${KITCHEN_INTERACTION_RADIUS_M}m of the Kitchen to use it.`);
    return result.rows[0];
  }
}

const KITCHEN_SELECT = `SELECT kitchen.kitchen_id,kitchen.manor_id,kitchen.owner_player_id,
  owner.username AS owner_username,kitchen.region_code,kitchen.lat,kitchen.lon,kitchen.built_at,
  kitchen.placement_revision::text FROM player_kitchens kitchen JOIN players owner ON owner.id=kitchen.owner_player_id`;
const BUILD_RETURNING_FIELDS = `build_id,owner_player_id,request_id,request_hash,manor_id,world_id,region_code,lat,lon,status,started_at,completes_at,kitchen_id,cancel_reason`;

async function requireKitchen(queryable: Pick<pg.Pool | pg.PoolClient, "query">, kitchenId: string): Promise<KitchenRow> {
  const result = await queryable.query<KitchenRow>(`${KITCHEN_SELECT} WHERE kitchen.kitchen_id=$1::uuid AND kitchen.removed_at IS NULL`, [kitchenId]);
  return requireRow(result.rows[0], "Kitchen no longer exists");
}
async function buildForRequest(queryable: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string, requestId: string): Promise<BuildRow | null> {
  const result = await queryable.query<BuildRow>(`SELECT ${BUILD_RETURNING_FIELDS} FROM kitchen_build_jobs WHERE owner_player_id=$1 AND request_id=$2`, [playerId, requestId]);
  return result.rows[0] ?? null;
}
async function activeBuild(queryable: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string, lock: boolean): Promise<BuildRow | null> {
  const result = await queryable.query<BuildRow>(`SELECT ${BUILD_RETURNING_FIELDS} FROM kitchen_build_jobs WHERE owner_player_id=$1 AND status='constructing' ORDER BY started_at,build_id LIMIT 1 ${lock ? "FOR UPDATE" : ""}`, [playerId]);
  return result.rows[0] ?? null;
}
async function hasActiveKitchen(queryable: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string): Promise<boolean> {
  const result = await queryable.query(`SELECT 1 FROM player_kitchens WHERE owner_player_id=$1 AND removed_at IS NULL LIMIT 1`, [playerId]);
  return result.rows[0] !== undefined;
}
async function currentJobs(queryable: Pick<pg.Pool | pg.PoolClient, "query">, kitchenId: string): Promise<JobRow[]> {
  const result = await queryable.query<JobRow>(`SELECT job_id,kitchen_id,owner_player_id,recipe_id,requested_input_quantity,output_quantity,collected_quantity,started_at,completes_at,cleared_at FROM kitchen_jobs WHERE kitchen_id=$1::uuid AND cleared_at IS NULL ORDER BY started_at,created_at,job_id`, [kitchenId]);
  return result.rows;
}
function stateSnapshot(kitchen: KitchenWorldSnapshot, jobs: readonly JobRow[], nowMs: number, occupiedSlots = jobs.length): KitchenStateSnapshot {
  return { kitchen, jobs: jobs.map((job) => mapJob(job, nowMs)), queueCapacity: KITCHEN_QUEUE_CAPACITY, occupiedSlots, serverTime: nowMs };
}
function jobFinishesAt(job: JobRow): number { return new Date(job.completes_at).getTime(); }
function mapKitchen(row: KitchenRow): KitchenWorldSnapshot {
  return { kitchenId: row.kitchen_id, manorId: row.manor_id, ownerPlayerId: row.owner_player_id, ownerUsername: row.owner_username, regionCode: row.region_code, lat: Number(row.lat), lon: Number(row.lon), builtAt: new Date(row.built_at).toISOString(), placementRevision: Number(row.placement_revision) };
}
function mapBuild(row: BuildRow): KitchenBuildSnapshot {
  const startedAt = new Date(row.started_at).getTime();
  const completesAt = new Date(row.completes_at).getTime();
  return { buildId: row.build_id, position: { lat: Number(row.lat), lon: Number(row.lon) }, startedAt, completesAt, durationMs: completesAt - startedAt };
}
function mapJob(row: JobRow, nowMs: number): KitchenJobSnapshot {
  const startedAt = new Date(row.started_at).getTime();
  const completesAt = new Date(row.completes_at).getTime();
  const productionFinished = nowMs >= completesAt;
  return { jobId: row.job_id, recipeId: row.recipe_id, inputItemId: row.recipe_id, outputItemId: "simple_food", outputDisplayName: "Simple Food", requestedInputQuantity: row.requested_input_quantity, outputQuantity: row.output_quantity, collectedQuantity: row.collected_quantity, readyQuantity: productionFinished ? Math.max(0, row.output_quantity - row.collected_quantity) : 0, startedAt: new Date(startedAt).toISOString(), completesAt: new Date(completesAt).toISOString(), productionFinished };
}
async function lockOperation(client: pg.PoolClient, playerId: string, requestId: string): Promise<void> { await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kitchen-operation:${playerId}:${requestId}`]); }
async function lockBuildChannel(client: pg.PoolClient, playerId: string): Promise<void> { await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`outdoor-station-build-player:${playerId}`]); }
async function previousOperation(queryable: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string, requestId: string): Promise<OperationRow | null> {
  const result = await queryable.query<OperationRow>(`SELECT action,request_hash,kitchen_id,job_id,result_quantity FROM kitchen_operations WHERE player_id=$1 AND request_id=$2`, [playerId, requestId]);
  return result.rows[0] ?? null;
}
function requireMatchingOperation(operation: OperationRow, action: OperationRow["action"], hash: string): void {
  if (operation.action !== action || operation.request_hash !== hash) throw new KitchenError("KITCHEN_REPLAY_CONFLICT", "That request ID was already used for a different Kitchen action.");
}
function requestHash(action: string, ...parts: Array<string | number>): string { return createHash("sha256").update(JSON.stringify([action, ...parts])).digest("hex"); }
function operationKey(playerId: string, requestId: string): string { return `kitchen:${playerId}:${requestId}`; }
function requireRequestId(requestId: string): void { if (!requestId || requestId.length > 128) throw new KitchenError("KITCHEN_INVALID_REQUEST", "A valid request ID is required."); }
/** Output of a job; legacy meat jobs (no longer startable) always cooked Simple Food. */
function kitchenJobOutput(recipeId: string): "simple_food" | "crude_oil" {
  return Object.hasOwn(KITCHEN_RECIPES, recipeId) ? KITCHEN_RECIPES[recipeId as KitchenRecipeId].outputItemId : "simple_food";
}

function requireRecipeQuantity(recipeId: KitchenRecipeId, quantity: number): void {
  const recipe = requireKitchenRecipe(recipeId);
  if (!Number.isSafeInteger(quantity) || quantity < recipe.minimumQuantity || quantity > recipe.maximumQuantity || quantity % recipe.inputPerOutput !== 0) throw new KitchenError("KITCHEN_INVALID_QUANTITY", `Choose a multiple of ${recipe.inputPerOutput} between ${recipe.minimumQuantity} and ${recipe.maximumQuantity} ${recipe.inputDisplayName}.`);
}
function requirePosition(player: PlayerRecord): void { if (!Number.isFinite(player.position.lat) || !Number.isFinite(player.position.lon)) throw new KitchenError("KITCHEN_INVALID_POSITION", "Your world position is unavailable."); }
function requireRow<T>(value: T | undefined, message: string): T { if (!value) throw new KitchenError("KITCHEN_CONFLICT", message); return value; }

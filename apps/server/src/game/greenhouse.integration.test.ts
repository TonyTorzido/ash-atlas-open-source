import {
  GREENHOUSE_BUILD_COST,
  GREENHOUSE_FARM_PLOT_PLACEMENT_COST,
  GREENHOUSE_FERTILIZER_RECIPE,
  GREENHOUSE_RIVERBANK_POLICY_DISTANCE_M,
  GREENHOUSE_RIVERBANK_POLICY_ID,
  GREENHOUSE_STARTING_TANK_WATER_TENTHS
} from "@ash-atlas/shared";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { GreenhouseService } from "./greenhouses.js";
import { enabledGreenhouseCropDefinition } from "./greenhouseCrops.js";
import { InventoryService } from "./inventory.js";
import type { PlayerRecord } from "./state.js";

const databaseUrl = process.env.GREENHOUSE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const TEST_CROP_PACK_ID = "a".repeat(64);
const WHEAT_CROP = enabledGreenhouseCropDefinition("wheat");
if (!WHEAT_CROP) throw new Error("The wheat crop fixture must exist in the server crop catalog");

describeDatabase("Greenhouse farming PostgreSQL authority", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let nowMs: number;

  beforeAll(async () => {
    const databaseName = new URL(databaseUrl!).pathname.slice(1);
    if (!databaseName.startsWith("ash_atlas_stability")) {
      throw new Error("GREENHOUSE_TEST_DATABASE_URL must target a disposable ash_atlas_stability database");
    }
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
    inventory = new InventoryService(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    nowMs = Date.UTC(2026, 0, 1);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists final-placement riverbank eligibility and exact stage durations", async () => {
    expect(GREENHOUSE_BUILD_COST).toEqual([
      { itemId: "wood", quantity: 100 },
      { itemId: "iron_bar", quantity: 10 },
      { itemId: "stone", quantity: 30 }
    ]);
    const riverPlayer = await createPlayer("river-owner");
    const inlandPlayer = await createPlayer("inland-owner", 35.1, -106.1);
    const riverService = greenhouseService();

    await grantBuildMaterials(riverPlayer.playerId, "river-materials");
    await grantBuildMaterials(inlandPlayer.playerId, "inland-materials");

    await expect(riverService.previewBuild(riverPlayer)).resolves.toMatchObject({
      position: riverPlayer.position,
      eligibility: { isRiverbank: true, policyId: GREENHOUSE_RIVERBANK_POLICY_ID, policyDistanceM: GREENHOUSE_RIVERBANK_POLICY_DISTANCE_M },
      stageDurationMs: WHEAT_CROP.stageDurationMs.riverbank,
      serverTime: nowMs
    });
    await expect(riverService.previewBuild(inlandPlayer)).resolves.toMatchObject({
      position: inlandPlayer.position,
      eligibility: { isRiverbank: false, policyId: GREENHOUSE_RIVERBANK_POLICY_ID, policyDistanceM: GREENHOUSE_RIVERBANK_POLICY_DISTANCE_M },
      stageDurationMs: WHEAT_CROP.stageDurationMs.inland,
      serverTime: nowMs
    });

    const riverBuild = await riverService.build(riverPlayer, "river-build");
    expect(riverBuild).toMatchObject({
      status: "constructing",
      replayed: false,
      build: {
        eligibility: {
          isRiverbank: true,
          policyId: GREENHOUSE_RIVERBANK_POLICY_ID,
          policyDistanceM: GREENHOUSE_RIVERBANK_POLICY_DISTANCE_M
        },
        durationMs: 30_000
      }
    });

    if (riverBuild.status !== "constructing") throw new Error("Expected a constructing riverbank greenhouse");
    const riverReplay = await riverService.build(riverPlayer, "river-build");
    expect(riverReplay).toMatchObject({ status: "constructing", replayed: true });

    const inlandBuild = await riverService.build(inlandPlayer, "inland-build");
    if (inlandBuild.status !== "constructing") throw new Error("Expected a constructing inland greenhouse");
    expect(inlandBuild).toMatchObject({
      status: "constructing",
      build: {
        eligibility: {
          isRiverbank: false,
          policyId: GREENHOUSE_RIVERBANK_POLICY_ID,
          policyDistanceM: GREENHOUSE_RIVERBANK_POLICY_DISTANCE_M
        }
      }
    });
    expect((await inventory.getInventorySnapshot(riverPlayer.playerId)).totals.iron_bar).toBe(0);
    expect((await inventory.getInventorySnapshot(inlandPlayer.playerId)).totals.iron_bar).toBe(0);

    expect(WHEAT_CROP.stageDurationMs).toEqual({
      riverbank: 8 * 60 * 60 * 1_000,
      inland: 12 * 60 * 60 * 1_000
    });

    await pool.query(
      "UPDATE greenhouse_build_jobs SET completes_at=clock_timestamp()-interval '1 second' WHERE build_id = ANY($1::uuid[])",
      [[riverBuild.build.buildId, inlandBuild.build.buildId]]
    );
    const completed = (await riverService.reconcileDueBuilds()).completed;
    expect(completed).toHaveLength(2);
    const riverGreenhouse = completed.find((entry) => entry.playerId === riverPlayer.playerId)?.greenhouse;
    const inlandGreenhouse = completed.find((entry) => entry.playerId === inlandPlayer.playerId)?.greenhouse;
    expect(riverGreenhouse).toMatchObject({
      ownerPlayerId: riverPlayer.playerId,
      planterCapacity: 15,
      roomCount: 1,
      tankWaterTenths: GREENHOUSE_STARTING_TANK_WATER_TENTHS,
      eligibility: { isRiverbank: true }
    });
    expect(inlandGreenhouse).toMatchObject({
      ownerPlayerId: inlandPlayer.playerId,
      eligibility: { isRiverbank: false }
    });
    expect(riverGreenhouse?.anchors).toHaveLength(15);
    expect(new Set(riverGreenhouse?.anchors.map((anchor) => anchor.anchorId)).size).toBe(15);
    expect(riverGreenhouse?.waterStorage.placed).toBe(false);
  });

  it("crafts Fertilizer from Simple Food, Flux Plant and any Bones (lowest first) once per request", async () => {
    expect(GREENHOUSE_FERTILIZER_RECIPE).toEqual([
      { itemId: "simple_food", quantity: 5 },
      { itemId: "flux_plant", quantity: 1 }
    ]);
    const owner = await createPlayer("fertilizer-owner");
    const service = greenhouseService();
    await inventory.grantItemsForOperation({
      operationKey: "greenhouse-test:fertilizer-inputs",
      playerId: owner.playerId,
      source: "greenhouse_test",
      grants: [
        ...GREENHOUSE_FERTILIZER_RECIPE.map((ingredient) => ({
          itemId: ingredient.itemId,
          variant: null,
          quantity: ingredient.quantity
        })),
        { itemId: "fang" as never, variant: null, quantity: 1 },
        { itemId: "bone", variant: null, quantity: 1 }
      ]
    });

    const first = await service.craftFertilizer(owner, "fertilizer-craft");
    expect(first.replayed).toBe(false);
    // Plain Bone (grade 1) is spent before the Fang (grade 2).
    expect(first.inventory.totals).toMatchObject({ simple_food: 0, bone: 0, fang: 1, flux_plant: 0, fertilizer: 1 });
    await expect(service.craftFertilizer(owner, "fertilizer-craft")).resolves.toMatchObject({
      replayed: true,
      inventory: { totals: { fertilizer: 1 } }
    });
  });

  it("pauses dry plants, advances exactly three watering transitions, and replays harvest", async () => {
    const owner = await createPlayer("growth-owner");
    const other = await createPlayer("other-owner", 35.2, -106.2);
    const service = greenhouseService();
    await grantBuildMaterials(owner.playerId, "growth-materials");
    const build = await service.build(owner, "growth-build");
    if (build.status !== "constructing") throw new Error("Expected a constructing growth greenhouse");
    const completedAt = await completeBuild(service, build.build.buildId, owner.playerId);
    const anchor = completedAt.greenhouse.anchors[0]!.anchorId;
    const anchorPosition = completedAt.greenhouse.anchors[0]!;
    await grantPlotPlacementMaterials(owner.playerId, "growth-plot");
    await service.place(owner, "place-growth-pot", completedAt.greenhouse.greenhouseId, "pot", anchorPosition.x, anchorPosition.y, anchor);
    await service.place(owner, "place-growth-tank", completedAt.greenhouse.greenhouseId, "water_tank", completedAt.greenhouse.waterStorage.x, completedAt.greenhouse.waterStorage.y);

    const planted = await service.plant(owner, "plant-anchor-0", completedAt.greenhouse.greenhouseId, anchor, TEST_CROP_PACK_ID);
    expect(planted.replayed).toBe(false);
    expect(planted.state.greenhouse.anchors[0]?.plant).toMatchObject({ cropId: "wheat", stage: 1 });
    expect(planted.inventory.totals.wheat_seed).toBe(14);
    await expect(service.plant(owner, "plant-anchor-0", completedAt.greenhouse.greenhouseId, anchor, TEST_CROP_PACK_ID))
      .resolves.toMatchObject({ replayed: true, inventory: { totals: { wheat_seed: 14 } } });
    await expect(service.plant(owner, "plant-anchor-0", completedAt.greenhouse.greenhouseId, anchor, TEST_CROP_PACK_ID, "moonbean"))
      .rejects.toMatchObject({ code: "GREENHOUSE_REPLAY_CONFLICT" });
    await expect(service.plant(owner, "plant-anchor-0", completedAt.greenhouse.greenhouseId, anchor, "b".repeat(64)))
      .rejects.toMatchObject({ code: "GREENHOUSE_REPLAY_CONFLICT" });
    await expect(service.plant(owner, "unsupported-crop", completedAt.greenhouse.greenhouseId, anchor, TEST_CROP_PACK_ID, "moonbean"))
      .rejects.toMatchObject({ code: "GREENHOUSE_CROP_UNAVAILABLE" });

    await expect(service.snapshot(other, completedAt.greenhouse.greenhouseId))
      .rejects.toMatchObject({ code: "GREENHOUSE_OWNER_REQUIRED" });
    await expect(service.plant(other, "other-plant", completedAt.greenhouse.greenhouseId, completedAt.greenhouse.anchors[1]!.anchorId, TEST_CROP_PACK_ID))
      .rejects.toMatchObject({ code: "GREENHOUSE_OWNER_REQUIRED" });

    const dryBeforeWater = await service.snapshot(owner, completedAt.greenhouse.greenhouseId);
    expect(dryBeforeWater.greenhouse.anchors[0]?.plant).toMatchObject({
      stage: 1,
      dry: true,
      wateredAt: null,
      nextStageAt: null
    });
    expect(await service.reconcileDuePlants()).toEqual([]);

    await inventory.grantItemsForOperation({
      operationKey: "growth-water-bucket",
      playerId: owner.playerId,
      source: "greenhouse_test",
      grants: [{ itemId: "water_bucket", variant: null, quantity: 1 }]
    });
    await pool.query(
      `UPDATE greenhouse_water_buckets
       SET water_bucket_tenths=50,gardening_bucket_tenths=0
       WHERE player_id=$1`,
      [owner.playerId]
    );
    await pool.query(
      "UPDATE player_greenhouses SET tank_water_tenths=195 WHERE greenhouse_id=$1",
      [completedAt.greenhouse.greenhouseId]
    );
    const deposit = await service.depositWater(owner, "deposit-cap", completedAt.greenhouse.greenhouseId);
    expect(deposit.state.greenhouse.tankWaterTenths).toBe(200);
    expect(deposit.state.waterBucketGallons).toBe(4.5);
    const refill = await service.refillGardeningBucket(owner, "refill-cap", completedAt.greenhouse.greenhouseId);
    expect(refill.state.greenhouse.tankWaterTenths).toBe(190);
    expect(refill.state.gardeningBucketGallons).toBe(1);

    for (const [index, expectedStage] of [2, 3, 4].entries()) {
      const watered = await service.water(
        owner,
        `water-anchor-0-${index}`,
        completedAt.greenhouse.greenhouseId,
        anchor
      );
      const nextStageAt = watered.state.greenhouse.anchors[0]?.plant?.nextStageAt;
      expect(nextStageAt).not.toBeNull();
      expect(Date.parse(nextStageAt!) - nowMs).toBe(WHEAT_CROP.stageDurationMs.riverbank);
      await expirePlant(completedAt.greenhouse.greenhouseId, anchor);
      const transitions = await service.reconcileDuePlants();
      expect(transitions).toContainEqual({
        greenhouseId: completedAt.greenhouse.greenhouseId,
        anchorId: anchor,
        fromStage: expectedStage - 1,
        toStage: expectedStage
      });
      const state = await service.snapshot(owner, completedAt.greenhouse.greenhouseId);
      expect(state.greenhouse.anchors[0]?.plant).toMatchObject({ stage: expectedStage, dry: true });
    }

    const harvested = await service.harvest(owner, "harvest-anchor-0", completedAt.greenhouse.greenhouseId, anchor);
    expect(harvested).toMatchObject({ replayed: false, yieldQuantity: 5, inventory: { totals: { wheat: 5 } } });
    expect(harvested.state.greenhouse.anchors[0]?.plant).toBeNull();
    await expect(service.harvest(owner, "harvest-anchor-0", completedAt.greenhouse.greenhouseId, anchor))
      .resolves.toMatchObject({ replayed: true, yieldQuantity: 0, inventory: { totals: { wheat: 5 } } });
  });

  it("validates authored pot and tank placement with owner and replay authority", async () => {
    const owner = await createPlayer("placement-owner");
    const other = await createPlayer("placement-other", 35.2, -106.2);
    const service = greenhouseService();
    await grantBuildMaterials(owner.playerId, "placement-materials");
    const build = await service.build(owner, "placement-build");
    if (build.status !== "constructing") throw new Error("Expected a constructing placement greenhouse");
    const completed = await completeBuild(service, build.build.buildId, owner.playerId);

    await expect(service.plant(owner, "plant-before-pot", completed.greenhouse.greenhouseId, completed.greenhouse.anchors[0]!.anchorId, TEST_CROP_PACK_ID))
      .rejects.toMatchObject({ code: "GREENHOUSE_PLACEMENT_REQUIRED" });

    await grantPlotPlacementMaterials(owner.playerId, "placement-plot");
    const firstAnchor = completed.greenhouse.anchors[0]!;
    const placed = await service.place(owner, "place-pot", completed.greenhouse.greenhouseId, "pot", firstAnchor.x, firstAnchor.y);
    expect(placed).toMatchObject({ replayed: false, placementKind: "pot" });
    expect(placed.placedAnchorId).toBeTruthy();
    expect(placed.state.greenhouse.anchors.find((anchor) => anchor.anchorId === placed.placedAnchorId)).toMatchObject({
      placed: true,
      x: firstAnchor.x,
      y: firstAnchor.y
    });
    expect((await inventory.getInventorySnapshot(owner.playerId)).totals).toMatchObject({
      wood: 0,
      fertilizer: 0
    });
    expect((await pool.query<{ gardening_bucket_tenths: number }>(
      "SELECT gardening_bucket_tenths FROM greenhouse_water_buckets WHERE player_id=$1",
      [owner.playerId]
    )).rows[0]?.gardening_bucket_tenths).toBe(0);
    await expect(service.place(owner, "place-pot", completed.greenhouse.greenhouseId, "pot", firstAnchor.x, firstAnchor.y))
      .resolves.toMatchObject({ replayed: true, placementKind: "pot", placedAnchorId: placed.placedAnchorId });
    await expect(service.place(other, "place-other", completed.greenhouse.greenhouseId, "pot", firstAnchor.x, firstAnchor.y))
      .rejects.toMatchObject({ code: "GREENHOUSE_OWNER_REQUIRED" });
    await expect(service.place(owner, "place-overlap", completed.greenhouse.greenhouseId, "pot", firstAnchor.x, firstAnchor.y))
      .rejects.toMatchObject({ code: "GREENHOUSE_INVALID_PLACEMENT" });

    const tankPosition = completed.greenhouse.waterStorage;
    const movedTank = await service.place(owner, "move-tank", completed.greenhouse.greenhouseId, "water_tank", tankPosition.x, tankPosition.y);
    expect(movedTank).toMatchObject({ replayed: false, placementKind: "water_tank" });
    expect(movedTank.state.greenhouse.waterStorage).toMatchObject({ placed: true, x: tankPosition.x, y: tankPosition.y });
    await expect(service.place(owner, "move-tank", completed.greenhouse.greenhouseId, "water_tank", tankPosition.x, tankPosition.y))
      .resolves.toMatchObject({ replayed: true, placementKind: "water_tank" });
  });

  it("cancels construction once with a full refund and permits a new request", async () => {
    const owner = await createPlayer("cancel-owner");
    const service = greenhouseService();
    await grantBuildMaterials(owner.playerId, "cancel-materials");
    const build = await service.build(owner, "cancel-build");
    if (build.status !== "constructing") throw new Error("Expected a constructing greenhouse");

    const cancelled = await service.cancelBuild(owner.playerId, "cancel-request");
    expect(cancelled).toMatchObject({
      playerId: owner.playerId,
      requestId: "cancel-build",
      buildId: build.build.buildId,
      message: "Greenhouse construction was cancelled; materials were refunded."
    });
    expect((await inventory.getInventorySnapshot(owner.playerId)).totals).toMatchObject({
      wood: 100,
      iron_bar: 10,
      stone: 30
    });

    await expect(service.build(owner, "cancel-build"))
      .rejects.toMatchObject({ code: "GREENHOUSE_BUILD_CANCELLED" });
    await expect(service.cancelBuild(owner.playerId, "cancel-request")).resolves.toMatchObject({
      buildId: build.build.buildId,
      requestId: "cancel-build"
    });
    expect((await inventory.getInventorySnapshot(owner.playerId)).totals).toMatchObject({
      wood: 100,
      iron_bar: 10,
      stone: 30
    });

    const retry = await service.build(owner, "cancel-retry");
    expect(retry).toMatchObject({ status: "constructing", replayed: false });
  });

  it("enforces owner/range destroy authority and replays the durable result", async () => {
    const owner = await createPlayer("destroy-owner");
    const other = await createPlayer("destroy-other");
    const service = greenhouseService();
    await grantBuildMaterials(owner.playerId, "destroy-materials");
    const build = await service.build(owner, "destroy-build");
    if (build.status !== "constructing") throw new Error("Expected a constructing greenhouse");
    const completed = await completeBuild(service, build.build.buildId, owner.playerId);

    await expect(service.destroy(other, "destroy-denied-owner", completed.greenhouse.greenhouseId))
      .rejects.toMatchObject({ code: "GREENHOUSE_OWNER_OR_RANGE_REQUIRED" });
    const farOwner = { ...owner, position: { lat: 35.1, lon: -106.1 } };
    await expect(service.destroy(farOwner, "destroy-denied-range", completed.greenhouse.greenhouseId))
      .rejects.toMatchObject({ code: "GREENHOUSE_OWNER_OR_RANGE_REQUIRED" });

    const destroyed = await service.destroy(owner, "destroy-greenhouse", completed.greenhouse.greenhouseId);
    expect(destroyed).toMatchObject({
      greenhouseId: completed.greenhouse.greenhouseId,
      placementRevision: completed.greenhouse.placementRevision + 1,
      replayed: false
    });
    await expect(service.destroy(owner, "destroy-greenhouse", completed.greenhouse.greenhouseId))
      .resolves.toMatchObject({
        greenhouseId: completed.greenhouse.greenhouseId,
        placementRevision: destroyed.placementRevision,
        replayed: true
      });
    await expect(service.snapshot(owner, completed.greenhouse.greenhouseId))
      .rejects.toMatchObject({ code: "GREENHOUSE_OWNER_REQUIRED" });
    expect((await service.listNear(owner)).some((greenhouse) =>
      greenhouse.greenhouseId === completed.greenhouse.greenhouseId
    )).toBe(false);
  });

  it("rejects stage-two clippings and returns three seeds from stage three", async () => {
    const owner = await createPlayer("clipping-owner");
    const service = greenhouseService();
    await grantBuildMaterials(owner.playerId, "clipping-materials");
    const build = await service.build(owner, "clipping-build");
    if (build.status !== "constructing") throw new Error("Expected a constructing clipping greenhouse");
    const completedAt = await completeBuild(service, build.build.buildId, owner.playerId);

    await grantPlotPlacementMaterials(owner.playerId, "clip-stage-two-plot");
    const stageTwoAnchor = completedAt.greenhouse.anchors[1]!.anchorId;
    const stageTwoPosition = completedAt.greenhouse.anchors[1]!;
    await service.place(owner, "place-clip-stage-two-pot", completedAt.greenhouse.greenhouseId, "pot", stageTwoPosition.x, stageTwoPosition.y, stageTwoAnchor);
    await pool.query(
      "UPDATE greenhouse_water_buckets SET gardening_bucket_tenths=1 WHERE player_id=$1",
      [owner.playerId]
    );
    await service.plant(owner, "clip-stage-two-plant", completedAt.greenhouse.greenhouseId, stageTwoAnchor, TEST_CROP_PACK_ID);
    await service.water(owner, "clip-stage-two-water", completedAt.greenhouse.greenhouseId, stageTwoAnchor);
    await expirePlant(completedAt.greenhouse.greenhouseId, stageTwoAnchor);
    await service.reconcileDuePlants();
    await expect(service.clip(owner, "clip-stage-two", completedAt.greenhouse.greenhouseId, stageTwoAnchor))
      .rejects.toMatchObject({ code: "GREENHOUSE_CLIPPING_UNAVAILABLE" });
    expect((await service.snapshot(owner, completedAt.greenhouse.greenhouseId)).greenhouse.anchors[1]?.plant).not.toBeNull();

    const stageThreeAnchor = completedAt.greenhouse.anchors[2]!.anchorId;
    const stageThreePosition = completedAt.greenhouse.anchors[2]!;
    await grantPlotPlacementMaterials(owner.playerId, "clip-stage-three-plot");
    await service.place(owner, "place-clip-stage-three-pot", completedAt.greenhouse.greenhouseId, "pot", stageThreePosition.x, stageThreePosition.y, stageThreeAnchor);
    await pool.query(
      "UPDATE greenhouse_water_buckets SET gardening_bucket_tenths=2 WHERE player_id=$1",
      [owner.playerId]
    );
    await service.plant(owner, "clip-stage-three-plant", completedAt.greenhouse.greenhouseId, stageThreeAnchor, TEST_CROP_PACK_ID);
    await service.water(owner, "clip-stage-three-water-1", completedAt.greenhouse.greenhouseId, stageThreeAnchor);
    await expirePlant(completedAt.greenhouse.greenhouseId, stageThreeAnchor);
    await service.reconcileDuePlants();
    await pool.query(
      "UPDATE greenhouse_water_buckets SET gardening_bucket_tenths=1 WHERE player_id=$1",
      [owner.playerId]
    );
    await service.water(owner, "clip-stage-three-water-2", completedAt.greenhouse.greenhouseId, stageThreeAnchor);
    await expirePlant(completedAt.greenhouse.greenhouseId, stageThreeAnchor);
    await service.reconcileDuePlants();
    const stageThree = await service.clip(owner, "clip-stage-three", completedAt.greenhouse.greenhouseId, stageThreeAnchor);
    expect(stageThree).toMatchObject({ replayed: false, yieldQuantity: 3 });
    expect(stageThree.state.greenhouse.anchors[2]?.plant).toBeNull();
    expect(stageThree.inventory.totals.wheat_seed).toBe(16);
  });

  it("persists Giving Berry tree gathering, resin tapping, chopping, replay, and ownership", async () => {
    const owner = await createPlayer("tree-owner");
    const other = await createPlayer("tree-other", 35.2, -106.2);
    const service = greenhouseService();
    await grantBuildMaterials(owner.playerId, "tree-materials");
    const build = await service.build(owner, "tree-build");
    if (build.status !== "constructing") throw new Error("Expected a constructing tree greenhouse");
    const completed = await completeBuild(service, build.build.buildId, owner.playerId);
    const anchorId = completed.greenhouse.anchors[0]!.anchorId;
    const anchorPosition = completed.greenhouse.anchors[0]!;

    await grantPlotPlacementMaterials(owner.playerId, "tree-plot");
    await service.place(owner, "place-tree-plot", completed.greenhouse.greenhouseId, "pot", anchorPosition.x, anchorPosition.y, anchorId);
    await inventory.grantItemsForOperation({
      operationKey: "greenhouse-test:tree-seed",
      playerId: owner.playerId,
      source: "greenhouse_test",
      grants: [{ itemId: "giving_berry", variant: null, quantity: 1 }]
    });
    await service.plant(
      owner,
      "plant-tree",
      completed.greenhouse.greenhouseId,
      anchorId,
      TEST_CROP_PACK_ID,
      "giving_berry_tree"
    );
    await pool.query(
      `UPDATE greenhouse_plants
       SET stage=3,dry=true,watered_at=NULL,next_stage_at=NULL,berries_remaining=3
       WHERE greenhouse_id=$1 AND anchor_id=$2`,
      [completed.greenhouse.greenhouseId, anchorId]
    );

    await expect(service.clip(other, "tree-other-clip", completed.greenhouse.greenhouseId, anchorId))
      .rejects.toMatchObject({ code: "GREENHOUSE_OWNER_REQUIRED" });
    const berries = await service.clip(owner, "tree-berries", completed.greenhouse.greenhouseId, anchorId);
    expect(berries).toMatchObject({ replayed: false, yieldQuantity: 3 });
    expect(berries.inventory.totals.giving_berry).toBe(3);
    expect(berries.state.greenhouse.anchors[0]?.plant).toBeNull();
    await expect(service.clip(owner, "tree-berries", completed.greenhouse.greenhouseId, anchorId))
      .resolves.toMatchObject({ replayed: true, yieldQuantity: 0, inventory: { totals: { giving_berry: 3 } } });

    await inventory.grantItemsForOperation({
      operationKey: "greenhouse-test:tree-seed-again",
      playerId: owner.playerId,
      source: "greenhouse_test",
      grants: [{ itemId: "giving_berry", variant: null, quantity: 1 }]
    });
    await service.plant(owner, "plant-tree-again", completed.greenhouse.greenhouseId, anchorId, TEST_CROP_PACK_ID, "giving_berry_tree");
    await pool.query(
      `UPDATE greenhouse_plants
       SET stage=4,dry=true,watered_at=NULL,next_stage_at=NULL,berries_remaining=0
       WHERE greenhouse_id=$1 AND anchor_id=$2`,
      [completed.greenhouse.greenhouseId, anchorId]
    );
    const resin = await service.tapTree(owner, "tree-resin", completed.greenhouse.greenhouseId, anchorId);
    expect(resin).toMatchObject({ replayed: false, yieldQuantity: 1, inventory: { totals: { balsam_resin: 1 } } });
    expect(resin.state.greenhouse.anchors[0]?.plant).toBeNull();
    await expect(service.tapTree(owner, "tree-resin", completed.greenhouse.greenhouseId, anchorId))
      .resolves.toMatchObject({ replayed: true, yieldQuantity: 0, inventory: { totals: { balsam_resin: 1 } } });
    await expect(service.tapTree(owner, "tree-resin-again", completed.greenhouse.greenhouseId, anchorId))
      .rejects.toMatchObject({ code: "GREENHOUSE_PLANT_REQUIRED" });
    await expect(service.harvest(owner, "tree-chop-after-tap", completed.greenhouse.greenhouseId, anchorId))
      .rejects.toMatchObject({ code: "GREENHOUSE_PLANT_REQUIRED" });

    await inventory.grantItemsForOperation({
      operationKey: "greenhouse-test:tree-seed-for-chop",
      playerId: owner.playerId,
      source: "greenhouse_test",
      grants: [{ itemId: "giving_berry", variant: null, quantity: 1 }]
    });
    await service.plant(owner, "plant-tree-for-chop", completed.greenhouse.greenhouseId, anchorId, TEST_CROP_PACK_ID, "giving_berry_tree");
    await pool.query(
      `UPDATE greenhouse_plants
       SET stage=4,dry=true,watered_at=NULL,next_stage_at=NULL,berries_remaining=0
       WHERE greenhouse_id=$1 AND anchor_id=$2`,
      [completed.greenhouse.greenhouseId, anchorId]
    );

    const chopped = await service.harvest(owner, "tree-chop", completed.greenhouse.greenhouseId, anchorId);
    expect(chopped).toMatchObject({ replayed: false, yieldQuantity: 4, inventory: { totals: { wood: 4 } } });
    expect(chopped.state.greenhouse.anchors[0]?.plant).toBeNull();
    await expect(service.harvest(owner, "tree-chop", completed.greenhouse.greenhouseId, anchorId))
      .resolves.toMatchObject({ replayed: true, yieldQuantity: 0, inventory: { totals: { wood: 4 } } });
    await expect(service.tapTree(owner, "tree-tap-after-chop", completed.greenhouse.greenhouseId, anchorId))
      .rejects.toMatchObject({ code: "GREENHOUSE_PLANT_REQUIRED" });

    const otherAnchor = completed.greenhouse.anchors[1]!;
    await grantPlotPlacementMaterials(owner.playerId, "tree-unrelated-plot");
    await service.place(owner, "place-tree-unrelated-plot", completed.greenhouse.greenhouseId, "pot", otherAnchor.x, otherAnchor.y, otherAnchor.anchorId);
    await service.plant(owner, "plant-tree-unrelated-wheat", completed.greenhouse.greenhouseId, otherAnchor.anchorId, TEST_CROP_PACK_ID, "wheat");
    await inventory.grantItemsForOperation({
      operationKey: "greenhouse-test:legacy-tapped-tree-seed",
      playerId: owner.playerId,
      source: "greenhouse_test",
      grants: [{ itemId: "giving_berry", variant: null, quantity: 1 }]
    });
    await service.plant(owner, "plant-legacy-tapped-tree", completed.greenhouse.greenhouseId, anchorId, TEST_CROP_PACK_ID, "giving_berry_tree");
    await pool.query(
      `UPDATE greenhouse_plants
       SET stage=4,dry=true,watered_at=NULL,next_stage_at=NULL,berries_remaining=0,resin_harvested=true
       WHERE greenhouse_id=$1 AND anchor_id=$2`,
      [completed.greenhouse.greenhouseId, anchorId]
    );
    await expect(service.harvest(owner, "legacy-tree-chop", completed.greenhouse.greenhouseId, anchorId))
      .rejects.toMatchObject({ code: "GREENHOUSE_HARVEST_UNAVAILABLE" });
    const legacyCleared = await service.snapshot(owner, completed.greenhouse.greenhouseId);
    expect(legacyCleared.greenhouse.anchors[0]?.plant).toBeNull();
    expect(legacyCleared.greenhouse.anchors[1]?.plant?.cropId).toBe("wheat");
    expect((await service.snapshot(owner, completed.greenhouse.greenhouseId)).greenhouse.anchors[0]?.plant).toBeNull();
    expect((await inventory.getInventorySnapshot(owner.playerId)).totals).toMatchObject({ balsam_resin: 1, wood: 4 });
    const persistedPlant = await pool.query(
      "SELECT 1 FROM greenhouse_plants WHERE greenhouse_id=$1 AND anchor_id=$2",
      [completed.greenhouse.greenhouseId, anchorId]
    );
    expect(persistedPlant.rowCount).toBe(0);
  });

  it("limits each carried bucket to one and preserves the crafting debit on rejection", async () => {
    const owner = await createPlayer("bucket-limit-owner");
    const service = greenhouseService();
    await inventory.grantItemsForOperation({
      operationKey: "greenhouse-test:bucket-limit-iron",
      playerId: owner.playerId,
      source: "greenhouse_test",
      grants: [{ itemId: "iron", variant: null, quantity: 20 }]
    });

    const crafted = await service.craftWaterBucket(owner, "bucket-craft-one");
    expect(crafted.inventory.totals.water_bucket).toBe(1);
    expect(crafted.inventory.totals.iron).toBe(10);
    await expect(service.craftWaterBucket(owner, "bucket-craft-two"))
      .rejects.toMatchObject({ code: "GREENHOUSE_WATER_BUCKET_LIMIT" });
    expect((await inventory.getInventorySnapshot(owner.playerId)).totals).toMatchObject({
      water_bucket: 1,
      iron: 10
    });

    await grantBuildMaterials(owner.playerId, "bucket-limit-build");
    const build = await service.build(owner, "bucket-limit-build-request");
    if (build.status !== "constructing") throw new Error("Expected a constructing bucket-limit greenhouse");
    const completed = await completeBuild(service, build.build.buildId, owner.playerId);
    expect(completed.inventory.totals.gardening_bucket).toBe(1);
    await expect(inventory.grantItemsForOperation({
      operationKey: "greenhouse-test:bucket-limit-gardening-duplicate",
      playerId: owner.playerId,
      source: "greenhouse_test",
      grants: [{ itemId: "gardening_bucket", variant: null, quantity: 1 }]
    })).rejects.toMatchObject({ name: "InventoryCapacityError" });
    const retained = await service.snapshot(owner, completed.greenhouse.greenhouseId);
    expect(retained.inventory.totals.gardening_bucket).toBe(1);
  });

  function greenhouseService(): GreenhouseService {
    const worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironment" | "lookupCanonicalWaterbodyNear"> = {
      lookupGameplayEnvironment: async (lat) => ({
        ok: true,
        isRiverbank: lat < 35.05
      } as never),
      lookupCanonicalWaterbodyNear: async () => ({
        kind: "river",
        sourceId: "test-river",
        sourceName: "Test River",
        distanceM: 0,
        searchComplete: true,
        resolutionStatus: "resolved",
        sourceRevision: "test-world"
      } as never)
    };
    return new GreenhouseService(pool, "test-world", inventory, worldLookup, () => nowMs);
  }

  async function createPlayer(role: string, lat = 35, lon = -106): Promise<PlayerRecord> {
    const playerId = `greenhouse-${role}-${randomUUID()}`;
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,'world-test',$3,$4,$3,$4,2000,true,ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [playerId, role, lat, lon]
    );
    return {
      playerId,
      username: role,
      displayColor: null,
      regionCode: "world-test",
      position: { lat, lon },
      anchor: { lat, lon },
      moveLeashRadiusM: 2_000,
      movementRevision: 0,
      target: null,
      online: true,
      updatedAt: new Date()
    };
  }

  async function grantBuildMaterials(playerId: string, key: string): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `greenhouse-test:${key}`,
      playerId,
      source: "greenhouse_test",
      grants: GREENHOUSE_BUILD_COST.map((cost) => ({ itemId: cost.itemId, variant: null, quantity: cost.quantity }))
    });
  }

  async function grantPlotPlacementMaterials(playerId: string, key: string): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `greenhouse-test:${key}`,
      playerId,
      source: "greenhouse_test",
      grants: GREENHOUSE_FARM_PLOT_PLACEMENT_COST.map((cost) => ({
        itemId: cost.itemId,
        variant: null,
        quantity: cost.quantity
      }))
    });
    await pool.query(
      "UPDATE greenhouse_water_buckets SET gardening_bucket_tenths=10 WHERE player_id=$1",
      [playerId]
    );
  }

  async function completeBuild(service: GreenhouseService, buildId: string, playerId: string) {
    await pool.query(
      "UPDATE greenhouse_build_jobs SET completes_at=clock_timestamp()-interval '1 second' WHERE build_id=$1",
      [buildId]
    );
    const completed = (await service.reconcileDueBuilds()).completed;
    const result = completed.find((entry) => entry.playerId === playerId);
    if (!result) throw new Error(`Missing completed greenhouse for ${playerId}`);
    return result;
  }

  async function expirePlant(greenhouseId: string, anchorId: string): Promise<void> {
    await pool.query(
      "UPDATE greenhouse_plants SET next_stage_at=clock_timestamp()-interval '1 second' WHERE greenhouse_id=$1 AND anchor_id=$2",
      [greenhouseId, anchorId]
    );
  }
});

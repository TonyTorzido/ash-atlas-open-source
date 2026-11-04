import { randomUUID } from "node:crypto";

import {
  FURNACE_BUILD_COST,
  TANNERY_BUILD_COST,
  TANNERY_BUILD_DURATION_MS,
  TANNERY_PROCESS_DURATION_MS,
  TANNERY_RARE_HIDE_IDS,
  TANNERY_RECIPES,
  wgs84DestinationPoint,
  type ResourceType,
  type TanneryRecipeId
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { FurnaceService } from "./furnaces.js";
import { InventoryService } from "./inventory.js";
import type { PlayerRecord } from "./state.js";
import { TanneryService } from "./tanneries.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Tannery PostgreSQL authority", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let nowMs: number;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
    inventory = new InventoryService(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         'owner','Ash','world-test',35,-106,35,-106,
         2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`
    );
    const manor = await pool.query<{ id: string }>(
      "INSERT INTO player_manors (owner_player_id) VALUES ('owner') RETURNING id"
    );
    await pool.query(
      `UPDATE player_manors
       SET world_region_code='world-test',world_lat=35,world_lon=-106,
           built_at=now(),geom=ST_SetSRID(ST_MakePoint(-106,35),4326)
       WHERE id=$1`,
      [manor.rows[0]!.id]
    );
    nowMs = Date.UTC(2026, 0, 1);
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("upgrades populated data, installs exact rarity rows, and is empty on repeat", async () => {
    await grant("leather", 7);
    const manorBefore = await pool.query<{ id: string }>(
      "SELECT id FROM player_manors WHERE owner_player_id='owner'"
    );
    await pool.query(
      "DROP TABLE tannery_operations, tannery_jobs, tannery_build_jobs, player_tanneries"
    );
    await pool.query(
      "DELETE FROM item_definitions WHERE item_id = ANY($1::text[])",
      [[...TANNERY_RARE_HIDE_IDS]]
    );
    await pool.query(
      `DELETE FROM schema_migrations
       WHERE version IN ('0763_creature_loot_tannery.sql','0817_rare_hide_tannery_jackpots.sql','1106_artificer_bulk_bonus.sql')`
    );

    await expect(runMigrations(databaseUrl!))
      .resolves.toEqual(["0763_creature_loot_tannery.sql", "0817_rare_hide_tannery_jackpots.sql", "1106_artificer_bulk_bonus.sql"]);
    // Re-creating 0763 restores its rare-hide recipe pin; reapply 1052's relaxed check as production has it.
    await pool.query(
      `ALTER TABLE tannery_jobs DROP CONSTRAINT IF EXISTS tannery_jobs_recipe_id_check;
       ALTER TABLE tannery_jobs ADD CONSTRAINT tannery_jobs_recipe_id_check
         CHECK (recipe_id ~ '^[a-z][a-z0-9_]{0,63}$')`
    );
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
    expect((await pool.query(
      "SELECT id FROM player_manors WHERE owner_player_id='owner'"
    )).rows[0]?.id).toBe(manorBefore.rows[0]?.id);
    expect(await inventoryQuantity("leather")).toBe(7);
    expect((await pool.query<{ item_id: string; rarity: string }>(
      `SELECT item_id,rarity FROM item_definitions
       WHERE item_id = ANY($1::text[]) ORDER BY item_id`,
      [[...TANNERY_RARE_HIDE_IDS]]
    )).rows).toEqual([
      { item_id: "alligator_hide", rarity: "uncommon" },
      { item_id: "bear_hide", rarity: "uncommon" },
      { item_id: "deer_hide", rarity: "common" },
      { item_id: "hog_hide", rarity: "common" },
      { item_id: "wolf_pelt", rarity: "uncommon" }
    ]);
  });

  it("reserves the modest build cost once, survives restart, and enforces placement and station limits", async () => {
    const service = tanneryService();
    const outside = wgs84DestinationPoint({ lat: 35, lon: -106 }, 651, 90);
    await grantBuildMaterials();
    await expect(service.build(player(outside.lat, outside.lon), randomUUID()))
      .rejects.toMatchObject({ code: "TANNERY_MANOR_RANGE_REQUIRED" });
    expect(await inventoryQuantity("wood")).toBe(TANNERY_BUILD_COST.wood);
    expect(await inventoryQuantity("stone")).toBe(TANNERY_BUILD_COST.stone);

    const started = await service.build(player(35, -106), "durable-build");
    expect(started).toMatchObject({
      status: "constructing",
      replayed: false,
      build: { durationMs: TANNERY_BUILD_DURATION_MS },
      inventory: { totals: { wood: 0, stone: 0 } }
    });
    await expect(service.build(player(35, -106), "durable-build"))
      .resolves.toMatchObject({ status: "constructing", replayed: true });
    nowMs += TANNERY_BUILD_DURATION_MS;
    const completed = await tanneryService().reconcileDueBuilds();
    expect(completed.completed).toHaveLength(1);
    await expect(service.build(player(35, -106), "durable-build"))
      .resolves.toMatchObject({ status: "completed", replayed: true });
    await grantBuildMaterials();
    await expect(service.build(player(35, -106), randomUUID()))
      .rejects.toMatchObject({ code: "TANNERY_OWNER_LIMIT" });
  });

  it("refunds movement cancellation and cannot overlap Furnace construction", async () => {
    const service = tanneryService();
    await grantBuildMaterials();
    await service.build(player(35, -106), "cancel-build");
    await expect(service.cancelBuildForMovement("owner")).resolves.toMatchObject({
      requestId: "cancel-build",
      reason: "movement",
      droppedItems: [],
      inventory: { totals: TANNERY_BUILD_COST }
    });
    await expect(service.build(player(35, -106), "cancel-build"))
      .resolves.toMatchObject({ status: "cancelled", replayed: true });

    await grant("stone", FURNACE_BUILD_COST.stone);
    await grant("wood", FURNACE_BUILD_COST.wood);
    await grant("coal", FURNACE_BUILD_COST.coal);
    const furnace = new FurnaceService(pool, "test-world", inventory, () => nowMs);
    await furnace.build(player(35, -106), "furnace-build");
    await grantBuildMaterials();
    await expect(service.build(player(35, -106), "blocked-tannery-build"))
      .rejects.toMatchObject({ code: "TANNERY_BUILD_ACTIVE" });
  });

  it("debits five batched species inputs, queues them durably, and credits exact Leather equivalents once", async () => {
    const service = tanneryService();
    const built = await buildTannery(service);
    await expect(service.start(
      player(35, -106),
      "missing-input",
      built.tannery.tanneryId,
      "deer_hide",
      1
    )).rejects.toMatchObject({ code: "TANNERY_MATERIALS_REQUIRED" });

    const recipes = [...TANNERY_RARE_HIDE_IDS] as TanneryRecipeId[];
    for (const recipeId of recipes) await grant(recipeId, 2);
    let lastState = null;
    for (const recipeId of recipes) {
      const requestId = `batch-${recipeId}`;
      const result = await service.start(
        player(35, -106), requestId, built.tannery.tanneryId, recipeId, 2
      );
      lastState = result.state;
      expect(result.inventory.totals[recipeId]).toBe(0);
      await expect(service.start(
        player(36, -105), requestId, built.tannery.tanneryId, recipeId, 2
      )).resolves.toMatchObject({ replayed: true });
    }
    expect(lastState).toMatchObject({ queueCapacity: 5, occupiedSlots: 5 });
    expect(lastState!.jobs.map((job) => job.outputQuantity)).toEqual([500, 800, 1_600, 2_400, 2_000]);
    expect(lastState!.jobs.slice(1).map((job, index) =>
      Date.parse(job.startedAt) - Date.parse(lastState!.jobs[index]!.startedAt)
    )).toEqual([5_000, 5_000, 5_000, 5_000]);
    await expect(service.start(
      player(35, -106), "queue-full", built.tannery.tanneryId, "deer_hide", 1
    )).rejects.toMatchObject({ code: "TANNERY_QUEUE_FULL" });

    nowMs += recipes.length * TANNERY_PROCESS_DURATION_MS;
    const restarted = tanneryService();
    const collected = await restarted.collect(
      player(35, -106), "collect-all", built.tannery.tanneryId
    );
    expect(collected).toMatchObject({
      collectedQuantity: 7_300,
      replayed: false,
      state: { occupiedSlots: 0, jobs: [] },
      inventory: { totals: { leather: 7_300 } }
    });
    await expect(restarted.collect(
      player(36, -105), "collect-all", built.tannery.tanneryId
    )).resolves.toMatchObject({ collectedQuantity: 7_300, replayed: true });
  });

  it("collects only fitting Leather and durably retains the remainder", async () => {
    const service = tanneryService();
    const built = await buildTannery(service);
    await grant("bear_hide", 1);
    await service.start(
      player(35, -106), "bear-batch", built.tannery.tanneryId, "bear_hide", 1
    );
    nowMs += TANNERY_PROCESS_DURATION_MS;
    await grant("wood", 19_500);
    await grant("leather", 499);

    const partial = await service.collect(
      player(35, -106), "partial-output", built.tannery.tanneryId
    );
    expect(partial).toMatchObject({
      collectedQuantity: 1,
      inventory: { totals: { leather: 500 } },
      state: { jobs: [{ collectedQuantity: 1, readyQuantity: 1_199 }] }
    });
    await expect(service.collect(
      player(35, -106), "partial-output", built.tannery.tanneryId
    )).resolves.toMatchObject({ collectedQuantity: 1, replayed: true });

    await debit("wood", 19_500);
    const final = await tanneryService().collect(
      player(35, -106), "remaining-output", built.tannery.tanneryId
    );
    expect(final).toMatchObject({ collectedQuantity: 1_199, state: { jobs: [] } });
    expect(final.inventory.totals.leather).toBe(1_699);
  });

  it("breaks down graded drops, guards Epic inputs and never spends kept items", async () => {
    const service = tanneryService();
    const built = await buildTannery(service);
    await grant("chimera_horn" as ResourceType, 1);
    await grant("fang" as ResourceType, 5);
    await pool.query(
      `INSERT INTO player_item_keep_policies (player_id,item_id,variant,keep_quantity,revision)
       VALUES ('owner','fang','default',3,1)`
    );
    // Epic trophy: refused without confirmation, nothing spent (R5).
    await expect(service.start(player(35, -106), "horn-guard", built.tannery.tanneryId, "chimera_horn", 1))
      .rejects.toMatchObject({ code: "HIGH_GRADE_CONFIRMATION_REQUIRED", message: "This will use your Chimera Horn (Epic)." });
    expect((await inventory.getInventorySnapshot("owner")).totals.chimera_horn).toBe(1);
    await service.start(player(35, -106), "horn-guard", built.tannery.tanneryId, "chimera_horn", 1, true);
    // Three Fangs are kept: only two can be broken down (R4).
    await expect(service.start(player(35, -106), "fang-kept", built.tannery.tanneryId, "fang", 3))
      .rejects.toMatchObject({ code: "TANNERY_MATERIALS_REQUIRED" });
    await service.start(player(35, -106), "fang-ok", built.tannery.tanneryId, "fang", 2);
    nowMs += 2 * TANNERY_PROCESS_DURATION_MS;
    const collected = await service.collect(player(35, -106), "bone-collect", built.tannery.tanneryId);
    expect(collected).toMatchObject({ collectedQuantity: 12, inventory: { totals: { bone: 12, fang: 3 } } });
    await expect(service.collect(player(35, -106), "bone-collect", built.tannery.tanneryId))
      .resolves.toMatchObject({ replayed: true, collectedQuantity: 12 });
    expect((await inventory.getInventorySnapshot("owner")).totals.bone).toBe(12);
  });

  function tanneryService(): TanneryService {
    return new TanneryService(pool, "test-world", inventory, () => nowMs);
  }

  async function buildTannery(service: TanneryService) {
    await grantBuildMaterials();
    await service.build(player(35, -106), randomUUID());
    nowMs += TANNERY_BUILD_DURATION_MS;
    const reconciled = await service.reconcileDueBuilds();
    expect(reconciled.completed).toHaveLength(1);
    return reconciled.completed[0]!;
  }

  async function grantBuildMaterials(): Promise<void> {
    await grant("wood", TANNERY_BUILD_COST.wood);
    await grant("stone", TANNERY_BUILD_COST.stone);
  }

  async function grant(itemId: ResourceType, quantity: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `tannery-test:${randomUUID()}`,
      playerId: "owner",
      source: "tannery_test",
      grants: [{ itemId, variant: null, quantity }]
    });
  }

  async function debit(itemId: ResourceType, quantity: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `tannery-test-debit:${randomUUID()}`,
        playerId: "owner",
        source: "tannery_test",
        debits: [{ itemId, variant: null, quantity }]
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function inventoryQuantity(itemId: ResourceType): Promise<number> {
    const snapshot = await inventory.getInventorySnapshot("owner");
    return snapshot.totals[itemId] ?? 0;
  }
});

function player(lat: number, lon: number): PlayerRecord {
  return {
    playerId: "owner",
    username: "Ash",
    displayColor: null,
    regionCode: "world-test",
    position: { lat, lon },
    anchor: { lat: 35, lon: -106 },
    moveLeashRadiusM: 2_000,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date()
  };
}

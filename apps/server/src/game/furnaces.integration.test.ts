import { randomUUID } from "node:crypto";

import {
  DEFAULT_PLAYER_BASE_INVENTORY_SLOTS,
  FURNACE_BAR_DURATION_MS,
  FURNACE_BUILD_COST,
  FURNACE_BUILD_DURATION_MS,
  FURNACE_METAL_BAR_DURATION_MS,
  RESOURCE_STACK_LIMITS,
  distanceMeters,
  furnaceRecipeInputs,
  professionXpThresholds,
  startableFurnaceRecipes,
  wgs84DestinationPoint,
  type ResourceType
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { FurnaceService } from "./furnaces.js";
import { InventoryService } from "./inventory.js";
import type { PlayerRecord } from "./state.js";

/** A plain material that satisfies each switched category input. */
const CATEGORY_BASIC: Record<string, ResourceType> = {
  "any Bones": "bone",
  "any Scales": "chitin",
  "any Scales (grade 2+)": "merfolk_scale" as ResourceType,
  "any Venoms (grade 2+)": "venom_sac" as ResourceType,
  "any Fish": "freshwater_fish"
};

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Furnace PostgreSQL authority", () => {
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

  it("places one Furnace inside the inclusive Manor radius and rejects another", async () => {
    const service = furnaceService();
    const inside = wgs84DestinationPoint({ lat: 35, lon: -106 }, 649, 90);
    const boundary = wgs84DestinationPoint({ lat: 35, lon: -106 }, 600, 180);
    const outside = wgs84DestinationPoint({ lat: 35, lon: -106 }, 651, 90);

    await expect(service.build(player(outside.lat, outside.lon), randomUUID()))
      .rejects.toMatchObject({ code: "FURNACE_MANOR_RANGE_REQUIRED" });
    const built = await buildFurnace(service, player(boundary.lat, boundary.lon));
    expect(built.furnace).toMatchObject({
      ownerPlayerId: "owner",
      lat: boundary.lat,
      lon: boundary.lon
    });
    await grantBuildMaterials();
    await expect(service.build(player(inside.lat, inside.lon), randomUUID()))
      .rejects.toMatchObject({ code: "FURNACE_OWNER_LIMIT" });
    expect(await service.listNear(player(35, -106))).toEqual([
      expect.objectContaining({
        furnaceId: built.furnace.furnaceId,
        manorId: built.furnace.manorId,
        ownerPlayerId: "owner",
        ownerUsername: "Ash",
        placementRevision: 1
      })
    ]);

    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         'other','Bex','world-test',35,-106,35,-106,
         2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`
    );
    await expect(service.build(otherPlayer(), randomUUID()))
      .rejects.toMatchObject({ code: "FURNACE_MANOR_RANGE_REQUIRED" });
    await expect(service.state(otherPlayer(), built.furnace.furnaceId))
      .rejects.toMatchObject({ code: "FURNACE_OWNER_OR_RANGE_REQUIRED" });
  });

  it("rejects a Furnace near a completed Tannery before debit and accepts its safe suggestion", async () => {
    const service = furnaceService();
    const occupied = wgs84DestinationPoint({ lat: 35, lon: -106 }, 100, 90);
    const manor = await pool.query<{ id: string }>(
      "SELECT id FROM player_manors WHERE owner_player_id='owner'"
    );
    await pool.query(
      `INSERT INTO player_tanneries (
         manor_id,owner_player_id,world_id,region_code,lat,lon,geom
       ) VALUES (
         $1,'owner','test-world','world-test',$2,$3,
         ST_SetSRID(ST_MakePoint($3,$2),4326)
       )`,
      [manor.rows[0]!.id, occupied.lat, occupied.lon]
    );
    await grantBuildMaterials();
    const before = {
      stone: await inventoryQuantity("stone"),
      wood: await inventoryQuantity("wood"),
      coal: await inventoryQuantity("coal")
    };

    let rejection: unknown;
    try {
      await service.build(player(occupied.lat, occupied.lon), randomUUID());
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      code: "OUTDOOR_STATION_CLEARANCE_REQUIRED",
      suggestedPosition: { lat: expect.any(Number), lon: expect.any(Number) }
    });
    expect({
      stone: await inventoryQuantity("stone"),
      wood: await inventoryQuantity("wood"),
      coal: await inventoryQuantity("coal")
    }).toEqual(before);

    const suggestion = (rejection as { suggestedPosition: { lat: number; lon: number } }).suggestedPosition;
    expect(distanceMeters(occupied, suggestion)).toBeGreaterThanOrEqual(30);
    await expect(service.build(player(suggestion.lat, suggestion.lon), randomUUID()))
      .resolves.toMatchObject({ status: "constructing", replayed: false });
  });

  it("reserves once and completes after restart at thirty seconds", async () => {
    const service = furnaceService();
    await grantBuildMaterials();
    const started = await service.build(player(35, -106), "timed-build");
    expect(started).toMatchObject({
      status: "constructing",
      replayed: false,
      inventory: { totals: { stone: 0, wood: 0, coal: 0 } },
      build: { durationMs: FURNACE_BUILD_DURATION_MS }
    });
    await expect(service.build(player(35, -106), "timed-build"))
      .resolves.toMatchObject({ status: "constructing", replayed: true });
    nowMs += FURNACE_BUILD_DURATION_MS - 1;
    expect((await service.reconcileDueBuilds()).completed).toHaveLength(0);
    nowMs += 1;
    const completed = await furnaceService().reconcileDueBuilds();
    expect(completed.completed).toHaveLength(1);
    expect((await service.reconcileDueBuilds()).completed).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM player_furnaces")).rowCount).toBe(1);
  });

  it("refunds a cancelled Furnace construction on movement", async () => {
    const service = furnaceService();
    await grantBuildMaterials();
    await service.build(player(35, -106), "cancel-build");
    const cancelled = await service.cancelBuildForMovement("owner");
    expect(cancelled).toMatchObject({
      requestId: "cancel-build",
      inventory: {
        totals: {
          stone: FURNACE_BUILD_COST.stone,
          wood: FURNACE_BUILD_COST.wood,
          coal: FURNACE_BUILD_COST.coal
        }
      },
      droppedItems: [],
      reason: "movement"
    });
    expect(await service.activeBuildForPlayer("owner")).toBeNull();
    nowMs += FURNACE_BUILD_DURATION_MS;
    expect((await service.reconcileDueBuilds()).completed).toHaveLength(0);
    await expect(service.build(player(35, -106), "cancel-build"))
      .resolves.toMatchObject({ status: "cancelled", replayed: true });
  });

  it("rejects a missing construction material without debiting the others", async () => {
    const service = furnaceService();
    await grant("stone", FURNACE_BUILD_COST.stone);
    await grant("wood", FURNACE_BUILD_COST.wood);
    await grant("coal", FURNACE_BUILD_COST.coal - 1);
    await expect(service.build(player(35, -106), randomUUID()))
      .rejects.toMatchObject({ code: "FURNACE_BUILD_MATERIALS_REQUIRED" });
    expect(await inventoryQuantity("stone")).toBe(FURNACE_BUILD_COST.stone);
    expect(await inventoryQuantity("wood")).toBe(FURNACE_BUILD_COST.wood);
    expect(await inventoryQuantity("coal")).toBe(FURNACE_BUILD_COST.coal - 1);
    expect(await service.activeBuildForPlayer("owner")).toBeNull();
  });

  it("debits once, completes sequentially, permits partial collection, and survives restart", async () => {
    const service = furnaceService();
    const built = await buildFurnace(service, player(35, -106), "build-replay");
    await expect(service.build(player(35, -106), "build-replay"))
      .resolves.toMatchObject({ status: "completed", replayed: true, furnace: { furnaceId: built.furnace.furnaceId } });
    await grant("iron", 15);
    await grant("wood", 300);

    const started = await service.start(player(35, -106), "start-replay", built.furnace.furnaceId, 3);
    expect(started.inventory.totals).toMatchObject({ iron: 0, wood: 0, iron_bar: 0 });
    await expect(service.start(player(36, -105), "start-replay", built.furnace.furnaceId, 3))
      .resolves.toMatchObject({ replayed: true });
    await expect(service.start(player(35, -106), randomUUID(), built.furnace.furnaceId, 3))
      .rejects.toMatchObject({ code: "FURNACE_QUEUE_FULL" });

    nowMs += FURNACE_BAR_DURATION_MS;
    await expect(service.state(player(35, -106), built.furnace.furnaceId))
      .resolves.toMatchObject({ jobs: [{ completedQuantity: 1, readyQuantity: 1 }] });
    const first = await service.collect(player(35, -106), "collect-one", built.furnace.furnaceId);
    expect(first).toMatchObject({ collectedQuantity: 1, state: { jobs: [{ collectedQuantity: 1 }] } });
    expect(first.inventory.totals.iron_bar).toBe(1);
    await expect(service.collect(player(36, -105), "collect-one", built.furnace.furnaceId))
      .resolves.toMatchObject({ replayed: true, collectedQuantity: 1 });

    nowMs += 2 * FURNACE_BAR_DURATION_MS;
    const restarted = furnaceService();
    const final = await restarted.collect(player(35, -106), "collect-rest", built.furnace.furnaceId);
    expect(final).toMatchObject({ collectedQuantity: 2, state: { jobs: [] } });
    expect(final.inventory.totals.iron_bar).toBe(3);
    await expect(restarted.start(player(35, -106), randomUUID(), built.furnace.furnaceId, 1))
      .rejects.toMatchObject({ code: "FURNACE_MATERIALS_REQUIRED" });
  });

  it("spends one Artisan Glove use per unit and refuses a job the worn glove cannot cover", async () => {
    const service = furnaceService();
    const built = await buildFurnace(service, player(35, -106));
    await grant("iron", 15);
    await grant("wood", 300);
    const gloveId = randomUUID();
    await pool.query(
      "INSERT INTO equipment_operations (operation_key,player_id,action,completed_at) VALUES ($1,'owner','package_grant',now())",
      [`seed-glove:${gloveId}`]
    );
    await pool.query(
      `INSERT INTO equipment_instances (instance_id,definition_id,owner_player_id,location,equipped_slot,
         created_by_operation_key,item_level,uses_remaining)
       VALUES ($1,'artisan_glove','owner','equipped','gloves',$2,0,2)`,
      [gloveId, `seed-glove:${gloveId}`]
    );
    const glove = async () => (await pool.query<{ uses_remaining: number; location: string }>(
      "SELECT uses_remaining,location FROM equipment_instances WHERE instance_id=$1", [gloveId]
    )).rows[0];

    await expect(service.start(player(35, -106), randomUUID(), built.furnace.furnaceId, 3))
      .rejects.toMatchObject({ code: "FURNACE_GLOVE_USES_SHORT" });
    expect(await inventoryQuantity("iron")).toBe(15);
    expect(await glove()).toMatchObject({ uses_remaining: 2, location: "equipped" });

    const requestId = randomUUID();
    await service.start(player(35, -106), requestId, built.furnace.furnaceId, 2);
    await service.start(player(35, -106), requestId, built.furnace.furnaceId, 2);
    expect(await glove()).toMatchObject({ uses_remaining: 0, location: "destroyed" });
    const jobs = await pool.query<{ duration_ms: number | null }>(
      "SELECT duration_ms FROM furnace_smelt_jobs WHERE furnace_id=$1", [built.furnace.furnaceId]
    );
    expect(jobs.rows).toEqual([{ duration_ms: 1000 }]);
  });

  it("rejects missing Iron Ore atomically and accepts exact resources", async () => {
    const service = furnaceService();
    const ironShort = await buildFurnace(service, player(35, -106));
    await grant("iron", 4);
    await grant("wood", 100);
    await expect(service.start(player(35, -106), randomUUID(), ironShort.furnace.furnaceId, 1))
      .rejects.toMatchObject({ code: "FURNACE_MATERIALS_REQUIRED" });
    expect(await inventoryQuantity("iron")).toBe(4);
    expect(await inventoryQuantity("wood")).toBe(100);
    await grant("iron", 1);
    await expect(service.start(player(35, -106), randomUUID(), ironShort.furnace.furnaceId, 1))
      .resolves.toMatchObject({ inventory: { totals: { iron: 0, wood: 0 } } });
  });

  it("rejects missing Wood atomically and accepts exact resources", async () => {
    const service = furnaceService();
    const woodShort = await buildFurnace(service, player(35, -106));
    await grant("iron", 5);
    await grant("wood", 99);
    await expect(service.start(player(35, -106), randomUUID(), woodShort.furnace.furnaceId, 1))
      .rejects.toMatchObject({ code: "FURNACE_MATERIALS_REQUIRED" });
    expect(await inventoryQuantity("iron")).toBe(5);
    expect(await inventoryQuantity("wood")).toBe(99);
    await grant("wood", 1);
    await expect(service.start(player(35, -106), randomUUID(), woodShort.furnace.furnaceId, 1))
      .resolves.toMatchObject({ inventory: { totals: { iron: 0, wood: 0 } } });
  });

  it("gates metal bars by Metallurgy rank and refuses retired core recipes", async () => {
    const service = furnaceService();
    const built = await buildFurnace(service, player(35, -106));
    for (const [recipeId, quantity] of [["revenant_bar", 1]] as const) {
      for (const input of furnaceRecipeInputs(recipeId, quantity)) await grant(input.itemId, input.quantity);
    }
    await grant("bone", 10);
    await expect(service.start(
      player(35, -106), "dead-rank-0", built.furnace.furnaceId, "revenant_bar", 1
    )).rejects.toMatchObject({ code: "FURNACE_PROFESSION_RANK_REQUIRED" });
    expect(await inventoryQuantity("iron_bar")).toBe(5);

    await setMetallurgyRank(1);
    for (const input of furnaceRecipeInputs("venomsteel_bar", 1)) await grant(input.itemId, input.quantity);
    await expect(service.start(
      player(35, -106), "venom-rank-1", built.furnace.furnaceId, "venomsteel_bar", 1
    )).rejects.toMatchObject({ code: "FURNACE_PROFESSION_RANK_REQUIRED" });
    await expect(service.start(
      player(35, -106), "dead-rank-1", built.furnace.furnaceId, "revenant_bar", 1
    )).resolves.toMatchObject({ state: { jobs: [{ recipeId: "revenant_bar" }] } });

    await expect(service.start(
      player(35, -106), "core-retired", built.furnace.furnaceId, "venomsteel_core", 1
    )).rejects.toMatchObject({ code: "FURNACE_RECIPE_RETIRED" });
  });

  it("smelts metal bars one hour each, grants Metallurgy XP per bar, and replays collection", async () => {
    const service = furnaceService();
    const built = await buildFurnace(service, player(35, -106));
    await setMetallurgyRank(1);
    for (const input of furnaceRecipeInputs("revenant_bar", 2)) await grant(input.itemId, input.quantity);
    await grant("bone", 20);
    await service.start(player(35, -106), "dead-start", built.furnace.furnaceId, "revenant_bar", 2);
    expect(await inventoryQuantity("lichen")).toBe(0);
    expect(await inventoryQuantity("bone")).toBe(0);

    nowMs += FURNACE_METAL_BAR_DURATION_MS - 1;
    await expect(service.collect(player(35, -106), "dead-early", built.furnace.furnaceId))
      .rejects.toMatchObject({ code: "FURNACE_OUTPUT_NOT_READY" });
    nowMs += 1;
    await expect(service.collect(player(35, -106), "dead-first", built.furnace.furnaceId))
      .resolves.toMatchObject({ collectedQuantity: 1, inventory: { totals: { revenant_bar: 1 } } });
    nowMs += FURNACE_METAL_BAR_DURATION_MS;
    await expect(service.collect(player(35, -106), "dead-second", built.furnace.furnaceId))
      .resolves.toMatchObject({ collectedQuantity: 1, state: { jobs: [] }, inventory: { totals: { revenant_bar: 2 } } });
    await expect(service.collect(player(35, -106), "dead-second", built.furnace.furnaceId))
      .resolves.toMatchObject({ replayed: true });
    expect((await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(requested_xp),0)::text AS total
       FROM mastery_progression_operations WHERE player_id='owner' AND source_type='furnace'`
    )).rows[0]?.total).toBe("6000");
  });

  it("consumes every metal bar recipe's inputs exactly once and produces its bar", async () => {
    const service = furnaceService();
    const built = await buildFurnace(service, player(35, -106));
    await setMetallurgyRank(5);
    for (const recipe of startableFurnaceRecipes().filter((candidate) => candidate.recipeId.endsWith("_bar") &&
      candidate.recipeId !== "iron_bar")) {
      for (const input of furnaceRecipeInputs(recipe.recipeId, 1)) await grant(input.itemId, input.quantity);
      for (const input of recipe.categoryInputs ?? []) await grant(CATEGORY_BASIC[input.category.label]!, input.quantity);
      const requestId = `${recipe.recipeId}-start`;
      await expect(service.start(
        player(35, -106), requestId, built.furnace.furnaceId, recipe.recipeId, 1
      )).resolves.toMatchObject({ replayed: false });
      await expect(service.start(
        player(35, -106), requestId, built.furnace.furnaceId, recipe.recipeId, 1
      )).resolves.toMatchObject({ replayed: true });
      for (const input of furnaceRecipeInputs(recipe.recipeId, 1)) {
        expect(await inventoryQuantity(input.itemId)).toBe(0);
      }
      nowMs += FURNACE_METAL_BAR_DURATION_MS;
      await expect(service.collect(
        player(35, -106), `${recipe.recipeId}-collect`, built.furnace.furnaceId
      )).resolves.toMatchObject({ collectedQuantity: 1 });
      expect(await inventoryQuantity(recipe.outputItemId)).toBe(1);
    }
  });

  it("settles independent Iron outcomes once, awards outcome XP, and recovers Slag by rank", async () => {
    const service = furnaceService(() => 0.99);
    const built = await buildFurnace(service, player(35, -106));
    await grant("iron", 15);
    await grant("wood", 300);
    await service.start(player(35, -106), "metallurgy-start", built.furnace.furnaceId, "iron_bar", 3);
    nowMs += 3 * FURNACE_BAR_DURATION_MS;

    const collected = await service.collect(player(35, -106), "metallurgy-collect", built.furnace.furnaceId);
    expect(collected).toMatchObject({
      collectedQuantity: 3,
      inventory: { totals: { iron_bar: 1, slag: 2 } },
      state: { jobs: [] }
    });
    await expect(service.collect(player(35, -106), "metallurgy-collect", built.furnace.furnaceId))
      .resolves.toMatchObject({ replayed: true, collectedQuantity: 3 });
    expect((await pool.query<{ outcome: string; settled_at: Date | null }>(
      `SELECT outcome,settled_at FROM furnace_smelt_units
       WHERE job_id=(SELECT job_id FROM furnace_operations WHERE request_id='metallurgy-start')
       ORDER BY unit_index`
    )).rows).toEqual([
      { outcome: "success", settled_at: expect.any(Date) },
      { outcome: "failure", settled_at: expect.any(Date) },
      { outcome: "failure", settled_at: expect.any(Date) }
    ]);
    expect((await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(requested_xp),0)::text AS total
       FROM mastery_progression_operations WHERE player_id='owner' AND source_type='furnace'`
    )).rows[0]?.total).toBe("3500");

    await pool.query(
      `UPDATE player_profession_progress
       SET xp=7218,rank=2 WHERE player_id='owner' AND profession_id='metallurgy'`
    );
    await grant("slag", 5);
    await service.start(player(35, -106), "slag-recovery-start", built.furnace.furnaceId, "slag_recovery", 1);
    const recovered = await service.collect(player(35, -106), "slag-recovery-collect", built.furnace.furnaceId);
    expect(recovered).toMatchObject({
      collectedQuantity: 1,
      inventory: { totals: { slag: 2, iron_bar: 2 } }
    });
    expect((await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM mastery_progression_operations
       WHERE player_id='owner' AND source_type='furnace'`
    )).rows[0]?.count).toBe("3");
  });

  it("collects only what fits and retains the remainder in the Furnace", async () => {
    const service = furnaceService();
    const built = await buildFurnace(service, player(35, -106));
    await grant("iron", 10);
    await grant("wood", 200);
    await service.start(player(35, -106), randomUUID(), built.furnace.furnaceId, 2);
    nowMs += 2 * FURNACE_BAR_DURATION_MS;
    await fillInventoryWithOneIronBarSpace();

    const partial = await service.collect(
      player(35, -106),
      "capacity-partial",
      built.furnace.furnaceId
    );
    expect(partial).toMatchObject({
      collectedQuantity: 1,
      state: { jobs: [{ collectedQuantity: 1, readyQuantity: 1 }] },
      inventory: { totals: { iron_bar: 250 } }
    });
    await expect(service.collect(
      player(35, -106),
      "capacity-partial",
      built.furnace.furnaceId
    )).resolves.toMatchObject({ replayed: true, collectedQuantity: 1 });

    await debitWood(250);
    const final = await service.collect(
      player(35, -106),
      "capacity-rest",
      built.furnace.furnaceId
    );
    expect(final).toMatchObject({ collectedQuantity: 1, state: { jobs: [] } });
    expect(final.inventory.totals.iron_bar).toBe(251);
  });

  it("queues five mixed outputs in order and collects every ready recipe exactly once", async () => {
    const service = furnaceService();
    const built = await buildFurnace(service, player(35, -106));
    await grant("iron", 15);
    await grant("wood", 300);
    await setMetallurgyRank(1);
    for (const input of furnaceRecipeInputs("revenant_bar", 2)) await grant(input.itemId, input.quantity);
    await grant("bone", 20);

    await service.start(player(35, -106), "mixed-iron-one", built.furnace.furnaceId, "iron_bar", 1);
    await service.start(player(35, -106), "mixed-iron-two", built.furnace.furnaceId, "iron_bar", 2);
    const queued = await service.start(
      player(35, -106),
      "mixed-dead-two",
      built.furnace.furnaceId,
      "revenant_bar",
      2
    );

    expect(queued.state).toMatchObject({
      queueCapacity: 5,
      occupiedSlots: 5,
      jobs: [
        { recipeId: "iron_bar", requestedQuantity: 1 },
        { recipeId: "iron_bar", requestedQuantity: 2 },
        { recipeId: "revenant_bar", requestedQuantity: 2 }
      ]
    });
    expect(Date.parse(queued.state.jobs[1]!.startedAt) - Date.parse(queued.state.jobs[0]!.startedAt))
      .toBe(FURNACE_BAR_DURATION_MS);
    expect(Date.parse(queued.state.jobs[2]!.startedAt) - Date.parse(queued.state.jobs[1]!.startedAt))
      .toBe(2 * FURNACE_BAR_DURATION_MS);
    await expect(service.start(
      player(35, -106),
      "mixed-over-capacity",
      built.furnace.furnaceId,
      "iron_bar",
      1
    )).rejects.toMatchObject({ code: "FURNACE_QUEUE_FULL" });

    nowMs += 3 * FURNACE_BAR_DURATION_MS + 2 * FURNACE_METAL_BAR_DURATION_MS;
    const collected = await service.collect(
      player(35, -106),
      "mixed-collect",
      built.furnace.furnaceId
    );
    expect(collected).toMatchObject({
      collectedQuantity: 5,
      state: { occupiedSlots: 0, jobs: [] },
      inventory: { totals: { iron_bar: 3, revenant_bar: 2 } }
    });
    await expect(service.collect(
      player(35, -106),
      "mixed-collect",
      built.furnace.furnaceId
    )).resolves.toMatchObject({ replayed: true, collectedQuantity: 5 });
  });

  it("spends category inputs lowest first or as chosen, refuses changed picks, and breaks down instantly", async () => {
    const service = furnaceService();
    const built = await buildFurnace(service, player(35, -106));
    await setMetallurgyRank(1);
    for (const input of furnaceRecipeInputs("revenant_bar", 1)) await grant(input.itemId, input.quantity);
    await grant("bone", 4);
    await grant("antler" as ResourceType, 4);
    await grant("fang" as ResourceType, 6);
    const furnaceId = built.furnace.furnaceId;
    // The previewed Claws are not held: refused with nothing spent (R7).
    await expect(service.start(player(35, -106), "dead-stale", furnaceId, "revenant_bar", 1, {
      categoryPicks: [[{ itemId: "claw", quantity: 10 }]]
    })).rejects.toMatchObject({ code: "FURNACE_PICKS_CHANGED" });
    expect(await inventoryQuantity("iron_bar")).toBe(5);
    // Auto-pick: Bone, then Antler, then 2 Fang.
    await service.start(player(35, -106), "dead-auto", furnaceId, "revenant_bar", 1);
    expect([await inventoryQuantity("bone"), await inventoryQuantity("antler" as ResourceType), await inventoryQuantity("fang" as ResourceType)])
      .toEqual([0, 0, 4]);

    await grant("crow_crown" as ResourceType, 1);
    await expect(service.start(player(35, -106), "crown", furnaceId, "crow_crown", 1))
      .rejects.toMatchObject({ code: "FURNACE_HIGH_GRADE_CONFIRMATION_REQUIRED" });
    await service.start(player(35, -106), "crown", furnaceId, "crow_crown", 1, { confirmHighGrade: true });
    await expect(service.start(player(35, -106), "crown", furnaceId, "crow_crown", 1, { confirmHighGrade: true }))
      .resolves.toMatchObject({ replayed: true });
    expect([await inventoryQuantity("crow_crown" as ResourceType), await inventoryQuantity("slag")]).toEqual([0, 8]);
  });

  async function setMetallurgyRank(rank: number): Promise<void> {
    await pool.query(
      `INSERT INTO player_profession_progress (player_id,profession_id,xp,rank,curve_version)
       VALUES ('owner','metallurgy',$2,$1,2)
       ON CONFLICT (player_id,profession_id) DO UPDATE SET rank=EXCLUDED.rank,xp=EXCLUDED.xp`,
      [rank, professionXpThresholds("metallurgy")[rank - 1]]
    );
  }

  function furnaceService(random: () => number = () => 0): FurnaceService {
    return new FurnaceService(pool, "test-world", inventory, () => nowMs, undefined, random);
  }

  async function buildFurnace(
    service: FurnaceService,
    builder: PlayerRecord,
    requestId: string = randomUUID()
  ) {
    await grantBuildMaterials();
    await expect(service.build(builder, requestId))
      .resolves.toMatchObject({ status: "constructing", replayed: false });
    nowMs += FURNACE_BUILD_DURATION_MS;
    const reconciled = await service.reconcileDueBuilds();
    expect(reconciled.completed).toHaveLength(1);
    return reconciled.completed[0]!;
  }

  async function grantBuildMaterials(): Promise<void> {
    await grant("stone", FURNACE_BUILD_COST.stone);
    await grant("wood", FURNACE_BUILD_COST.wood);
    await grant("coal", FURNACE_BUILD_COST.coal);
  }

  async function grant(itemId: ResourceType, quantity: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `furnace-test:${randomUUID()}`,
      playerId: "owner",
      source: "furnace_test",
      grants: [{ itemId, variant: null, quantity }]
    });
  }

  async function fillInventoryWithOneIronBarSpace(): Promise<void> {
    const ironBarStacks = Math.ceil(249 / RESOURCE_STACK_LIMITS.iron_bar);
    const fullWoodStacks = DEFAULT_PLAYER_BASE_INVENTORY_SLOTS - ironBarStacks - 1;
    await inventory.grantItemsForOperation({
      operationKey: `furnace-test-fill-wood:${randomUUID()}`,
      playerId: "owner",
      source: "furnace_test",
      grants: [{
        itemId: "wood",
        variant: null,
        quantity: fullWoodStacks * RESOURCE_STACK_LIMITS.wood + 250
      }]
    });
    await inventory.grantItemsForOperation({
      operationKey: `furnace-test-fill-bars:${randomUUID()}`,
      playerId: "owner",
      source: "furnace_test",
      grants: [{ itemId: "iron_bar", variant: null, quantity: 249 }]
    });
  }

  async function inventoryQuantity(
    itemId: ResourceType
  ): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      `SELECT quantity::text FROM player_inventory
       WHERE player_id='owner' AND resource_type=$1 AND variant='default'`,
      [itemId]
    );
    return Number(result.rows[0]?.quantity ?? 0);
  }

  async function debitWood(quantity: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `furnace-test-free-slot:${randomUUID()}`,
        playerId: "owner",
        source: "furnace_test",
        debits: [{ itemId: "wood", variant: null, quantity }]
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

function otherPlayer(): PlayerRecord {
  return { ...player(35, -106), playerId: "other", username: "Bex" };
}

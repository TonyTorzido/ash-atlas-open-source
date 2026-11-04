import { randomUUID } from "node:crypto";

import {
  KITCHEN_BUILD_COST,
  KITCHEN_BUILD_DURATION_MS,
  KITCHEN_PROCESS_DURATION_MS,
  KITCHEN_QUEUE_CAPACITY,
  type KitchenWorldSnapshot
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";
import { KitchenService } from "./kitchens.js";
import type { PlayerRecord } from "./state.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Kitchen shared exterior access PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let nowMs: number;
  let kitchen: KitchenWorldSnapshot;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
    inventory = new InventoryService(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayer("owner", "Ash");
    await createPlayer("guest", "Bex");
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
    const inserted = await pool.query<{ kitchen_id: string }>(
      `INSERT INTO player_kitchens (
         manor_id,owner_player_id,world_id,region_code,lat,lon,geom
       ) VALUES (
         $1,'owner','test-world','world-test',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )
       RETURNING kitchen_id`,
      [manor.rows[0]!.id]
    );
    kitchen = {
      kitchenId: inserted.rows[0]!.kitchen_id,
      manorId: manor.rows[0]!.id,
      ownerPlayerId: "owner",
      ownerUsername: "Ash",
      regionCode: "world-test",
      lat: 35,
      lon: -106,
      builtAt: new Date().toISOString(),
      placementRevision: 1
    };
    nowMs = Date.UTC(2026, 0, 1);
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("reserves construction once, completes after restart, and enforces one owned Kitchen", async () => {
    await grantBuildMaterials();
    const service = kitchenService();
    // The fixture station is removed so this test exercises the build path.
    await pool.query("DELETE FROM player_kitchens WHERE kitchen_id=$1", [kitchen.kitchenId]);
    const started = await service.build(owner(), "durable-build");
    expect(started).toMatchObject({
      status: "constructing",
      replayed: false,
      inventory: { totals: { wood: 0, stone: 0 } }
    });
    await expect(service.build(owner(), "durable-build"))
      .resolves.toMatchObject({ status: "constructing", replayed: true });
    nowMs += KITCHEN_BUILD_DURATION_MS;
    const completed = await service.reconcileDueBuilds();
    expect(completed).toMatchObject({ completed: [{ kitchen: { ownerPlayerId: "owner" } }] });
    await expect(service.build(owner(), "different-build"))
      .rejects.toMatchObject({ code: "KITCHEN_OWNER_LIMIT" });
  });

  it("lets a nearby non-owner use the shared station while scoping jobs to each owner", async () => {
    await grant("owner", 10, "freshwater_fish");
    await grant("guest", 10, "freshwater_fish");
    const service = kitchenService();

    const ownerStart = await service.start(owner(), "owner-start", kitchen.kitchenId, "freshwater_fish", 10);
    expect(ownerStart.state).toMatchObject({ occupiedSlots: 1, jobs: [{ outputQuantity: 1 }] });
    const guestState = await service.state(guest(), kitchen.kitchenId);
    expect(guestState).toMatchObject({ occupiedSlots: 1, jobs: [] });
    const guestStart = await service.start(guest(), "guest-start", kitchen.kitchenId, "freshwater_fish", 10);
    expect(guestStart).toMatchObject({
      replayed: false,
      inventory: { totals: { freshwater_fish: 0 } },
      state: { occupiedSlots: 2, jobs: [{ outputQuantity: 1 }] }
    });
  });

  it("keeps displayed multi-batch quantities in the raw-input contract and replays without a second debit", async () => {
    await grant("owner", 30, "freshwater_fish");
    const service = kitchenService();

    const first = await service.start(owner(), "multi-batch-start", kitchen.kitchenId, "freshwater_fish", 20);
    expect(first).toMatchObject({
      replayed: false,
      inventory: { totals: { freshwater_fish: 10 } },
      state: {
        occupiedSlots: 1,
        jobs: [{ requestedInputQuantity: 20, outputQuantity: 2, collectedQuantity: 0 }]
      }
    });

    const replay = await service.start(owner(), "multi-batch-start", kitchen.kitchenId, "freshwater_fish", 20);
    expect(replay).toMatchObject({
      replayed: true,
      inventory: { totals: { freshwater_fish: 10 } },
      state: { jobs: [{ requestedInputQuantity: 20, outputQuantity: 2 }] }
    });
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM kitchen_jobs
       WHERE owner_player_id='owner' AND requested_input_quantity=20 AND output_quantity=2`
    )).rows[0]?.count).toBe(1);
    expect((await inventory.getInventorySnapshot("owner")).totals.freshwater_fish).toBe(10);

    nowMs += KITCHEN_PROCESS_DURATION_MS;
    const collected = await service.collect(owner(), "multi-batch-collect", kitchen.kitchenId);
    expect(collected).toMatchObject({
      replayed: false,
      collectedQuantity: 2,
      inventory: { totals: { freshwater_fish: 10, simple_food: 2 } },
      state: { occupiedSlots: 0, jobs: [] }
    });
    await expect(service.collect(owner(), "multi-batch-collect", kitchen.kitchenId))
      .resolves.toMatchObject({ replayed: true, collectedQuantity: 2 });
    expect((await inventory.getInventorySnapshot("owner")).totals.simple_food).toBe(2);
  });

  it("persists Freshwater Fish batches, collects one output, and rejects invalid input before persistence", async () => {
    await grant("owner", 20, "freshwater_fish");
    const service = kitchenService();

    const first = await service.start(owner(), "freshwater-start", kitchen.kitchenId, "freshwater_fish", 10);
    expect(first).toMatchObject({
      replayed: false,
      inventory: { totals: { freshwater_fish: 10 } },
      state: {
        occupiedSlots: 1,
        jobs: [{ recipeId: "freshwater_fish", requestedInputQuantity: 10, outputQuantity: 1 }]
      }
    });
    await expect(pool.query<{ requested_input_quantity: number; output_quantity: number }>(
      `SELECT requested_input_quantity, output_quantity
       FROM kitchen_jobs
       WHERE owner_player_id='owner' AND recipe_id='freshwater_fish' AND cleared_at IS NULL`
    )).resolves.toMatchObject({ rows: [{ requested_input_quantity: 10, output_quantity: 1 }] });

    const replay = await service.start(owner(), "freshwater-start", kitchen.kitchenId, "freshwater_fish", 10);
    expect(replay).toMatchObject({
      replayed: true,
      inventory: { totals: { freshwater_fish: 10 } },
      state: { occupiedSlots: 1, jobs: [{ recipeId: "freshwater_fish", outputQuantity: 1 }] }
    });
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM kitchen_jobs
       WHERE owner_player_id='owner' AND recipe_id='freshwater_fish'`
    )).rows[0]?.count).toBe(1);

    nowMs += KITCHEN_PROCESS_DURATION_MS;
    const collected = await service.collect(owner(), "freshwater-collect", kitchen.kitchenId);
    expect(collected).toMatchObject({
      replayed: false,
      collectedQuantity: 1,
      inventory: { totals: { freshwater_fish: 10, simple_food: 1 } },
      state: { occupiedSlots: 0, jobs: [] }
    });
    await expect(service.collect(owner(), "freshwater-collect", kitchen.kitchenId))
      .resolves.toMatchObject({ replayed: true, collectedQuantity: 1 });
    expect((await inventory.getInventorySnapshot("owner")).totals.simple_food).toBe(1);

    const jobsBeforeInvalid = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM kitchen_jobs WHERE owner_player_id='owner'"
    );
    await expect(service.start(owner(), "invalid-freshwater", kitchen.kitchenId, "freshwater_fish", 11))
      .rejects.toMatchObject({ code: "KITCHEN_INVALID_QUANTITY" });
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM kitchen_jobs WHERE owner_player_id='owner'"
    )).resolves.toMatchObject({ rows: [{ count: jobsBeforeInvalid.rows[0]!.count }] });
    expect((await inventory.getInventorySnapshot("owner")).totals).toMatchObject({
      freshwater_fish: 10,
      simple_food: 1
    });
    await expect(pool.query(
      "SELECT 1 FROM kitchen_operations WHERE player_id='owner' AND request_id='invalid-freshwater'"
    )).resolves.toMatchObject({ rows: [] });
  });

  it("enforces one global five-slot queue and schedules after every player's work", async () => {
    await grant("owner", 20, "freshwater_fish");
    await grant("guest", 30, "freshwater_fish");
    const service = kitchenService();
    await service.start(owner(), "owner-one", kitchen.kitchenId, "freshwater_fish", 10);
    await service.start(owner(), "owner-two", kitchen.kitchenId, "freshwater_fish", 10);
    const guestOne = await service.start(guest(), "guest-one", kitchen.kitchenId, "freshwater_fish", 10);
    await service.start(guest(), "guest-two", kitchen.kitchenId, "freshwater_fish", 10);
    const guestThree = await service.start(guest(), "guest-three", kitchen.kitchenId, "freshwater_fish", 10);
    expect(guestThree.state).toMatchObject({
      queueCapacity: KITCHEN_QUEUE_CAPACITY,
      occupiedSlots: KITCHEN_QUEUE_CAPACITY,
      jobs: [{}, {}, {}]
    });
    expect(Date.parse(guestOne.state.jobs[0]!.startedAt) - nowMs)
      .toBe(2 * KITCHEN_PROCESS_DURATION_MS);
    await expect(service.start(guest(), "over-capacity", kitchen.kitchenId, "freshwater_fish", 10))
      .rejects.toMatchObject({ code: "KITCHEN_QUEUE_FULL" });
  });

  it("collects and replays only the actor's output without duplicating Simple Food", async () => {
    await grant("owner", 10, "freshwater_fish");
    await grant("guest", 10, "freshwater_fish");
    const service = kitchenService();
    await service.start(owner(), "owner-start", kitchen.kitchenId, "freshwater_fish", 10);
    await service.start(guest(), "guest-start", kitchen.kitchenId, "freshwater_fish", 10);
    nowMs += 2 * KITCHEN_PROCESS_DURATION_MS;

    const first = await service.collect(guest(), "guest-collect", kitchen.kitchenId);
    expect(first).toMatchObject({
      collectedQuantity: 1,
      inventory: { totals: { simple_food: 1 } },
      state: { occupiedSlots: 1, jobs: [] }
    });
    const replay = await service.collect(guest(), "guest-collect", kitchen.kitchenId);
    expect(replay).toMatchObject({ replayed: true, collectedQuantity: 1 });
    expect((await inventory.getInventorySnapshot("guest")).totals.simple_food).toBe(1);
    const ownerCollect = await service.collect(owner(), "guest-collect", kitchen.kitchenId);
    expect(ownerCollect).toMatchObject({
      collectedQuantity: 1,
      inventory: { totals: { simple_food: 1 } },
      state: { occupiedSlots: 0, jobs: [] }
    });
    expect((await inventory.getInventorySnapshot("owner")).totals.simple_food).toBe(1);
  });

  it("rejects access outside the station range even for a non-owner", async () => {
    const service = kitchenService();
    const farGuest = guest(35.01, -106.01);
    await expect(service.state(farGuest, kitchen.kitchenId))
      .rejects.toMatchObject({ code: "KITCHEN_RANGE_REQUIRED" });
    await expect(service.start(farGuest, "far-start", kitchen.kitchenId, "freshwater_fish", 10))
      .rejects.toMatchObject({ code: "KITCHEN_RANGE_REQUIRED" });
  });

  it("cooks any Meat / Fish lowest first, reports leftover, replays once and refuses changed picks", async () => {
    await grantItems("owner", { wolf_cut: 60, jaguar_cut: 60, pike_fillet: 60 });
    const service = kitchenService();
    // Previewed picks no longer held: refused before anything is spent (R7).
    await expect(service.startCookAny(owner(), "any-stale", kitchen.kitchenId, 5, [[{ itemId: "lion_mane", quantity: 5 }]]))
      .rejects.toMatchObject({ code: "KITCHEN_PICKS_CHANGED" });
    const before = (await inventory.getInventorySnapshot("owner")).totals;
    expect(before.wolf_cut).toBe(60);

    // Three items of 60 split into 50 + 10 jobs: five slots fit 170, so 10 stay behind.
    const first = await service.startCookAny(owner(), "any-1", kitchen.kitchenId, 180);
    expect(first.state.jobs).toHaveLength(5);
    expect(first.leftoverQuantity).toBe(10);
    const replay = await service.startCookAny(owner(), "any-1", kitchen.kitchenId, 180);
    expect(replay).toMatchObject({ replayed: true, leftoverQuantity: 10 });
    const after = (await inventory.getInventorySnapshot("owner")).totals;
    expect([after.wolf_cut ?? 0, after.jaguar_cut ?? 0, after.pike_fillet ?? 0].reduce((a, b) => a + b, 0)).toBe(10);
  }, 30_000);

  it("fills only free slots and leaves the rest in the inventory", async () => {
    await grantItems("owner", { wolf_cut: 300 });
    const service = kitchenService();
    const result = await service.startCookAny(owner(), "any-big", kitchen.kitchenId, 250);
    expect(result.state.jobs).toHaveLength(5);
    expect(result.leftoverQuantity).toBe(0);
    await expect(service.startCookAny(owner(), "any-full", kitchen.kitchenId, 50))
      .rejects.toMatchObject({ code: "KITCHEN_QUEUE_FULL" });
    expect((await inventory.getInventorySnapshot("owner")).totals.wolf_cut).toBe(50);
  }, 30_000);

  it("renders Blubber to Crude Oil and grants Oil Worker XP once", async () => {
    await grantItems("owner", { blubber: 3 });
    const service = kitchenService();
    await service.start(owner(), "render-1", kitchen.kitchenId, "blubber", 3);
    nowMs += 10_000;
    const collected = await service.collect(owner(), "render-collect", kitchen.kitchenId);
    expect(collected.collectedQuantity).toBe(12);
    await service.collect(owner(), "render-collect", kitchen.kitchenId);
    expect((await inventory.getInventorySnapshot("owner")).totals.crude_oil).toBe(12);
    const xp = await pool.query<{ xp: string }>(
      "SELECT xp::text FROM player_profession_progress WHERE player_id='owner' AND profession_id='oil_worker'"
    );
    expect(Number(xp.rows[0]?.xp ?? 0)).toBeGreaterThan(0);
  }, 30_000);

  function kitchenService(): KitchenService {
    return new KitchenService(pool, "test-world", inventory, () => nowMs);
  }

  async function grant(
    playerId: string,
    quantity: number,
    itemId: "freshwater_fish"
  ): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `kitchen-access-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "kitchen_access_test",
      grants: [{ itemId, variant: null, quantity }]
    });
  }

  async function grantItems(playerId: string, items: Record<string, number>): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `kitchen-category-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "kitchen_access_test",
      grants: Object.entries(items).map(([itemId, quantity]) => ({ itemId: itemId as never, variant: null, quantity }))
    });
  }

  async function grantBuildMaterials(): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `kitchen-build-test:${randomUUID()}`,
      playerId: "owner",
      source: "test_fixture",
      grants: [
        { itemId: "wood", variant: null, quantity: KITCHEN_BUILD_COST.wood },
        { itemId: "stone", variant: null, quantity: KITCHEN_BUILD_COST.stone }
      ]
    });
  }

  async function createPlayer(playerId: string, username: string): Promise<void> {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,'world-test',35,-106,35,-106,
         2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [playerId, username]
    );
  }
});

function owner(lat = 35, lon = -106): PlayerRecord {
  return player("owner", "Ash", lat, lon);
}

function guest(lat = 35, lon = -106): PlayerRecord {
  return player("guest", "Bex", lat, lon);
}

function player(playerId: string, username: string, lat: number, lon: number): PlayerRecord {
  return {
    playerId,
    username,
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

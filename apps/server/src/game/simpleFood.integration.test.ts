import { randomUUID } from "node:crypto";

import { HUNGER_BASE_CAPACITY } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";
import { SimpleFoodService } from "./simpleFood.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Simple Food authoritative hunger integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let simpleFood: SimpleFoodService;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    inventory = new InventoryService(pool);
    simpleFood = new SimpleFoodService(pool, inventory);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom,hunger,hunger_base_capacity
       ) VALUES (
         'food-player','Ash','world-test',35,-106,35,-106,
         2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326),0,$1
       )`,
      [HUNGER_BASE_CAPACITY]
    );
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("debits once, restores and persists Hunger, and replays without duplication", async () => {
    await grant(2);
    const first = await simpleFood.consume("food-player", "eat-once");
    expect(first).toMatchObject({
      restoredQuantity: 100,
      replayed: false,
      hunger: { current: 100, baseCapacity: HUNGER_BASE_CAPACITY },
      inventory: { totals: { simple_food: 1 } }
    });
    expect((await pool.query<{ hunger: number }>("SELECT hunger FROM players WHERE id='food-player'")).rows[0]!.hunger)
      .toBe(100);

    const replay = await simpleFood.consume("food-player", "eat-once");
    expect(replay).toMatchObject({ restoredQuantity: 100, replayed: true });
    expect((await inventory.getInventorySnapshot("food-player")).totals.simple_food).toBe(1);
  });

  it("caps partial restoration and refuses full-stomach consumption without debit", async () => {
    await grant(1);
    await pool.query("UPDATE players SET hunger=1950 WHERE id='food-player'");
    await expect(simpleFood.consume("food-player", "eat-partial")).resolves.toMatchObject({
      restoredQuantity: 50,
      hunger: { current: HUNGER_BASE_CAPACITY }
    });
    await pool.query("UPDATE players SET hunger=$1 WHERE id='food-player'", [HUNGER_BASE_CAPACITY]);
    await expect(simpleFood.consume("food-player", "eat-full"))
      .rejects.toMatchObject({ code: "SIMPLE_FOOD_FULL" });
    expect((await inventory.getInventorySnapshot("food-player")).totals.simple_food).toBe(0);
  });

  it("serializes concurrent requests so each food restores at most one 100-point step", async () => {
    await grant(2);
    const results = await Promise.all([
      simpleFood.consume("food-player", "eat-a"),
      simpleFood.consume("food-player", "eat-b")
    ]);
    expect(results.map((result) => result.restoredQuantity).sort()).toEqual([100, 100]);
    expect((await pool.query<{ hunger: number }>("SELECT hunger FROM players WHERE id='food-player'")).rows[0]!.hunger)
      .toBe(200);
    expect((await inventory.getInventorySnapshot("food-player")).totals.simple_food).toBe(0);
  });

  async function grant(quantity: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `simple-food-test:${randomUUID()}`,
      playerId: "food-player",
      source: "simple_food_test",
      grants: [{ itemId: "simple_food", variant: null, quantity }]
    });
  }
});

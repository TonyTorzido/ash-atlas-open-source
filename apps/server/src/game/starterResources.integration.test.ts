import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";
import { ensureStarterResources } from "./starterResources.js";

const databaseUrl = process.env.FLAG_RESOURCE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("starter resources PostgreSQL integration", () => {
  const pool = new pg.Pool({ connectionString: validatedDatabaseUrl(databaseUrl), max: 6 });
  const inventory = new InventoryService(pool);
  const playerId = `starter-${randomUUID()}`;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await pool.query(
      `INSERT INTO players (id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom)
       VALUES ($1,$1,'starter-test',0,0,0,0,1250,true,ST_SetSRID(ST_MakePoint(0,0),4326))`,
      [playerId]
    );
  });

  afterAll(async () => {
    await pool.query("ALTER TABLE inventory_events DISABLE TRIGGER inventory_events_immutable");
    await pool.query("ALTER TABLE inventory_operations DISABLE TRIGGER inventory_operations_immutable");
    await pool.query("ALTER TABLE player_inventory DISABLE TRIGGER player_inventory_identity_guard");
    await pool.query("DELETE FROM inventory_events WHERE player_id=$1", [playerId]);
    await pool.query("DELETE FROM inventory_operations WHERE player_id=$1", [playerId]);
    await pool.query("DELETE FROM player_inventory WHERE player_id=$1", [playerId]);
    await pool.query("ALTER TABLE player_inventory ENABLE TRIGGER player_inventory_identity_guard");
    await pool.query("ALTER TABLE inventory_operations ENABLE TRIGGER inventory_operations_immutable");
    await pool.query("ALTER TABLE inventory_events ENABLE TRIGGER inventory_events_immutable");
    await pool.query("DELETE FROM players WHERE id=$1", [playerId]);
    await pool.end();
  });

  it("applies exactly once under concurrent initialization and never tops up spent balances", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureStarterResources(inventory, playerId)));
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(await inventory.getInventorySnapshot(playerId)).toMatchObject({
      totals: { wood: 15, leather: 10, stone: 0 }
    });
    const operation = await pool.query<{ operations: string; events: string }>(
      `SELECT
         (SELECT count(*) FROM inventory_operations WHERE operation_key=$1) AS operations,
         (SELECT count(*) FROM inventory_events WHERE operation_key=$1) AS events`,
      [`starter-resources-v1:${playerId}`]
    );
    expect(operation.rows[0]).toEqual({ operations: "1", events: "2" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `spend-starter:${playerId}`,
        playerId,
        source: "starter_test_spend",
        debits: [
          { itemId: "wood", variant: null, quantity: 15 },
          { itemId: "leather", variant: null, quantity: 10 }
        ]
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect((await ensureStarterResources(inventory, playerId)).applied).toBe(false);
    expect(await inventory.getInventorySnapshot(playerId)).toMatchObject({ totals: { wood: 0, leather: 0, stone: 0 } });
  });
});

function validatedDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!/\/ash_atlas_stability[^/?]*/.test(value)) {
    throw new Error("FLAG_RESOURCE_TEST_DATABASE_URL must target an ash_atlas_stability database");
  }
  return value;
}

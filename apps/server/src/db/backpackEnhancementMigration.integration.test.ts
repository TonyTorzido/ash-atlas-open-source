import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";
import { InventoryService } from "../game/inventory.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "0849_backpack_enhancement_contract.sql";

describeDatabase("Backpack +N enhancement forward migration", () => {
  const databaseName = `ash_atlas_stability_backpack_enhancement_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repositoryMigrations = path.resolve(process.cwd(), "../../db/migrations");
  let migrationsDirectory = "";
  let databaseUrl = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-backpack-enhancement-"));
    for (const name of (await readdir(repositoryMigrations))
      .filter((name) => name.endsWith(".sql") && name < MIGRATION)
      .sort()) {
      await copyFile(
        path.join(repositoryMigrations, name),
        path.join(migrationsDirectory, name)
      );
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    await seedPlayer("backpack-enhancement-inventory", "inventory", 0);
    await seedPlayer("backpack-enhancement-equipped", "equipped", 3);
    await new InventoryService(pool).grantItemsForOperation({
      playerId: "backpack-enhancement-inventory",
      operationKey: "backpack-enhancement-retained-inventory",
      source: "backpack_migration_test",
      grants: [{ itemId: "leather", variant: null, quantity: 321 }]
    });
    await copyFile(
      path.join(repositoryMigrations, MIGRATION),
      path.join(migrationsDirectory, MIGRATION)
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.end();
    if (migrationsDirectory) {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("gifts every existing backpack to +10, preserves custody, and reruns empty", async () => {
    const before = await pool!.query<{
      instance_id: string;
      owner_player_id: string;
      definition_id: string;
      location: string;
      equipped_slot: number | null;
      upgrade_level: number;
    }>(
      `SELECT instance_id::text,owner_player_id,definition_id,location,
              equipped_slot,upgrade_level
       FROM player_backpack_instances
       ORDER BY instance_id`
    );
    const balances = await pool!.query(
      `SELECT player_id,resource_type,variant,quantity::text,version::text
       FROM player_inventory
       WHERE player_id='backpack-enhancement-inventory'`
    );
    expect(before.rows).toHaveLength(2);
    expect(before.rows.map((row) => row.upgrade_level).sort()).toEqual([0, 3]);

    await expect(runMigrations(databaseUrl, { migrationsDirectory }))
      .resolves.toEqual([MIGRATION]);

    const after = await pool!.query(
      `SELECT instance_id::text,owner_player_id,definition_id,location,
              equipped_slot,upgrade_level
       FROM player_backpack_instances
       ORDER BY instance_id`
    );
    expect(after.rows).toEqual(before.rows.map((row) => ({ ...row, upgrade_level: 10 })));
    await expect(pool!.query(
      `SELECT player_id,resource_type,variant,quantity::text,version::text
       FROM player_inventory
       WHERE player_id='backpack-enhancement-inventory'`
    )).resolves.toEqual(balances);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
  }, 90_000);

  async function seedPlayer(
    playerId: string,
    location: "inventory" | "equipped",
    upgradeLevel: number
  ): Promise<void> {
    const accountId = randomUUID();
    const operationKey = `backpack-enhancement-seed:${playerId}`;
    await pool!.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool!.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,$3,'GLOBAL',0,0,0,0,1250,false,
                 ST_SetSRID(ST_MakePoint(0,0),4326))`,
      [playerId, accountId, `Backpack Migration ${playerId}`]
    );
    await pool!.query(
      "INSERT INTO player_inventory_capacities (player_id) VALUES ($1)",
      [playerId]
    );
    await pool!.query(
      `INSERT INTO backpack_operations (
         operation_key,player_id,account_id,request_id,action,request_hash
       ) VALUES ($1,$2,$3,$4,'create',$5)`,
      [operationKey, playerId, accountId, operationKey, "a".repeat(64)]
    );
    await pool!.query(
      `INSERT INTO player_backpack_instances (
         instance_id,owner_player_id,definition_id,location,equipped_slot,
         inventory_slot_index,created_by_operation_key,upgrade_level
       ) VALUES ($1,$2,'starter_backpack',$3,$4,NULL,$5,$6)`,
      [
        randomUUID(),
        playerId,
        location,
        location === "equipped" ? 0 : null,
        operationKey,
        upgradeLevel
      ]
    );
  }
});

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error(
      "Backpack enhancement migration test requires local ash_atlas_stability"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

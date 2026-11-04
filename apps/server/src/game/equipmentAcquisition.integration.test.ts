import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireEquipmentDefinition } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { EquipmentService } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { WalletService } from "./wallet.js";

const adminUrl =
  process.env.EQUIPMENT_TEST_ADMIN_URL ??
  process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "0758_equipment_acquisition.sql";

describeDatabase("equipment acquisition PostgreSQL lifecycle", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_acquisition_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repoMigrations = fileURLToPath(
    new URL("../../../../db/migrations/", import.meta.url)
  );
  const playerId = `equipment-acquisition-${suffix}`;
  const accountId = randomUUID();
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let appliedMigrations: string[] = [];

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-equipment-acquisition-")
    );
    for (const name of (await readdir(repoMigrations))
      .filter((name) => name.endsWith(".sql") && name < MIGRATION)
      .sort()) {
      await copyFile(
        path.join(repoMigrations, name),
        path.join(precedingMigrations, name)
      );
    }
    await admin.query(
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter'
         ) THEN
           CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
         END IF;
       END $$`
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });
    await seedPopulatedPlayer();
    await copyFile(path.join(repoMigrations, MIGRATION), path.join(precedingMigrations, MIGRATION));
    appliedMigrations = await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("migrates populated operations forward and reruns without work", async () => {
    expect(appliedMigrations).toEqual([MIGRATION]);
    await expect(pool.query(
      `SELECT action,completed_at IS NOT NULL AS completed
       FROM equipment_operations
       WHERE operation_key='pre-acquisition-operation'`
    )).resolves.toMatchObject({
      rows: [{ action: "starter_loadout", completed: true }]
    });
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([]);
    await runMigrations(databaseUrl); // Current services below require the current schema.
  });

  it("crafts once across exact request replays", async () => {
    const service = new EquipmentService(pool, {
      now: () => new Date("2026-08-17T12:00:00Z")
    });
    const actor = { playerId, accountId };
    const authority = manorSmithAuthority();

    const crafted = await service.craftStockEquipment(
      actor,
      "sword",
      "craft-stock-sword",
      authority
    );
    expect(crafted).toMatchObject({
      applied: true,
      replayed: false,
      action: "craft",
      definitionId: "starter_sword",
      materialCosts: [
        { itemId: "iron_bar", quantity: 10 },
        { itemId: "wood", quantity: 50 }
      ],
      goldCost: "0"
    });
    await expect(service.craftStockEquipment(
      actor,
      "sword",
      "craft-stock-sword",
      authority
    )).resolves.toMatchObject({
      applied: false,
      replayed: true,
      instanceId: crafted.instanceId
    });
    await expect(service.craftStockEquipment(
      actor,
      "axe",
      "craft-stock-sword",
      authority
    )).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_IDEMPOTENCY_CONFLICT"
    }));

    await expect(pool.query(
      `SELECT
         (SELECT quantity::text FROM player_inventory
          WHERE player_id=$1 AND resource_type='iron_bar' AND variant='default') AS iron,
         (SELECT quantity::text FROM player_inventory
          WHERE player_id=$1 AND resource_type='wood' AND variant='default') AS wood,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id=$1) AS gold,
         (SELECT count(*)::int FROM equipment_instances
          WHERE owner_player_id=$1 AND definition_id='starter_sword') AS swords,
         (SELECT count(*)::int FROM inventory_events
          WHERE player_id=$1 AND source='equipment_craft') AS material_events`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [{
        iron: "90",
        wood: "450",
        gold: "6000",
        swords: 1,
        material_events: 2
      }]
    });
  });

  it("rejects removed limited sales without granting items", async () => {
    const authority = manorSmithAuthority();
    const activeService = new EquipmentService(pool, {
      now: () => new Date("2026-08-17T12:00:00Z")
    });
    for (const definitionId of ["double_axe", "hammer"] as const) {
      await expect(activeService.purchaseLimitedEquipment(
        { playerId, accountId },
        requireEquipmentDefinition(definitionId).definitionId,
        `removed-${definitionId}`,
        authority
      )).rejects.toEqual(expect.objectContaining({
        code: "EQUIPMENT_LIMITED_SALE_UNAVAILABLE"
      }));
    }
    await expect(pool.query(
      `SELECT
         (SELECT gold_balance::text FROM player_wallets WHERE player_id=$1) AS gold,
         (SELECT count(*)::int FROM equipment_instances
          WHERE owner_player_id=$1 AND definition_id IN ('double_axe', 'hammer')) AS cosmetics,
         (SELECT count(*)::int FROM equipment_operations
          WHERE player_id=$1 AND action='limited_purchase') AS completed_operations`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [{ gold: "6000", cosmetics: 0, completed_operations: 0 }]
    });
  });

  async function seedPopulatedPlayer(): Promise<void> {
    await pool.query(
      `INSERT INTO accounts (id,status,trust_tier)
       VALUES ($1,'active','standard')`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,$1,$1,'equipment-test',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [playerId, accountId]
    );
    await pool.query(
      `INSERT INTO equipment_operations (
         operation_key,player_id,action,result,completed_at
       ) VALUES ('pre-acquisition-operation',$1,'starter_loadout','{}'::jsonb,now())`,
      [playerId]
    );
    await new InventoryService(pool).grantItemsForOperation({
      operationKey: `equipment-acquisition-materials:${playerId}`,
      playerId,
      source: "equipment_acquisition_test_opening",
      grants: [
        { itemId: "iron_bar", variant: "default", quantity: 100 },
        { itemId: "wood", variant: "default", quantity: 500 }
      ]
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await new WalletService().creditForOperationInTransaction(client, {
        playerId,
        accountId,
        amount: 6_000n,
        operationKey: `equipment-acquisition-opening:${playerId}`,
        reason: "equipment_acquisition_test_opening"
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

function manorSmithAuthority() {
  return {
    kind: "manor_smith" as const,
    manorId: "00000000-0000-4000-8000-000000000020",
    manorSessionId: "00000000-0000-4000-8000-000000000021",
    movementSequence: 1,
    authorize: async () => undefined
  };
}

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !database.startsWith("ash_atlas_stability")
  ) {
    throw new Error(
      "Equipment acquisition tests require a local disposable ash_atlas_stability admin database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable equipment acquisition database name");
  }
  return `"${value}"`;
}

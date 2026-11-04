import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  EQUIPMENT_SWAG_CRAFT_RECIPES,
  baseAppearanceForEquipment,
  requireEquipmentDefinition
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EquipmentService } from "../game/equipment.js";
import { InventoryService } from "../game/inventory.js";
import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1080_swag_weapons.sql";

describeDatabase("swag weapons migration and crafting", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_swag_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const fixturePlayerId = `swag-fixture-${suffix}`;
  const playerId = `swag-crafter-${suffix}`;
  const accountId = randomUUID();
  const actor = { playerId, accountId };
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-swag-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-swag-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name !== TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      }
      await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });
    await seedFixtureInventory();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, matches the startup catalog, and is empty on a second run", async () => {
    // Before 1080 the startup check refuses the compiled catalog: the swag items are missing.
    await expect(validateItemDefinitionCatalog(pool!)).rejects.toThrow();
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);
    await expect(pool!.query(
      "SELECT quantity::text FROM player_inventory WHERE player_id=$1 AND resource_type='leather'",
      [fixturePlayerId]
    )).resolves.toMatchObject({ rows: [{ quantity: "40" }] });
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
    const rows = await pool!.query<{ item_id: string; equipment_family_id: string; equipment_role: string }>(
      `SELECT item_id,equipment_family_id,equipment_role FROM item_definitions
       WHERE item_id = ANY($1::text[]) ORDER BY item_id`,
      [EQUIPMENT_SWAG_CRAFT_RECIPES.map((recipe) => recipe.definitionId)]
    );
    expect(rows.rows).toHaveLength(24);
    for (const row of rows.rows) {
      expect(row.equipment_role).toBe("cosmetic");
      expect(row.equipment_family_id)
        .toBe(EQUIPMENT_SWAG_CRAFT_RECIPES.find((recipe) => recipe.definitionId === row.item_id)!.familyId);
    }
    // Equipment market tradability lives on the equipment definition (the market listing check);
    // the item_definitions market columns are the fungible order book, off for all equipment.
    const marketColumns = await pool!.query<{ item_id: string; market_tradable: boolean; market_fungible: boolean; market_identity: string | null }>(
      `SELECT item_id,market_tradable,market_fungible,market_identity FROM item_definitions
       WHERE item_id IN ('double_axe','legion_gladius','troll_cleaver')`
    );
    const axeRow = marketColumns.rows.find((row) => row.item_id === "double_axe")!;
    for (const row of marketColumns.rows) {
      expect({ ...row, item_id: "" }, row.item_id).toEqual({ ...axeRow, item_id: "" });
    }
    expect(requireEquipmentDefinition("double_axe").marketTradable).toBe(true);
    for (const recipe of EQUIPMENT_SWAG_CRAFT_RECIPES) {
      expect(requireEquipmentDefinition(recipe.definitionId).marketTradable, recipe.definitionId).toBe(true);
    }
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([]);
    await runMigrations(databaseUrl); // Services below need any later migrations too.
    await seedCrafter();
  }, 120_000);

  it("crafts a swag weapon once at +0 with the stock weapon's stats, replay and double-submit safe", async () => {
    const service = new EquipmentService(pool!, { now: () => new Date("2026-10-05T12:00:00Z") });
    const authority = manorSmithAuthority();
    const stock = await service.craftStockEquipment(actor, "sword", "stock-sword", authority);

    const [first, second] = await Promise.all([
      service.craftStockEquipment(actor, "sword", "swag-gladius", authority, swagId("legion_gladius")),
      service.craftStockEquipment(actor, "sword", "swag-gladius", authority, swagId("legion_gladius"))
    ]);
    const applied = [first, second].filter((result) => result.applied);
    expect(applied).toHaveLength(1);
    expect(first.instanceId).toBe(second.instanceId);
    expect(applied[0]).toMatchObject({
      action: "craft",
      definitionId: "legion_gladius",
      materialCosts: [
        { itemId: "iron_bar", quantity: 10 },
        { itemId: "wood", quantity: 50 },
        { itemId: "rusted_legion_blade", quantity: 3 },
        { itemId: "ancient_coin", quantity: 3 }
      ],
      goldCost: "0"
    });
    await expect(service.craftStockEquipment(
      actor, "sword", "swag-gladius", authority, swagId("legion_gladius")
    )).resolves.toMatchObject({ applied: false, replayed: true, instanceId: first.instanceId });
    // The same request ID for the stock sword is a different intent.
    await expect(service.craftStockEquipment(actor, "sword", "swag-gladius", authority))
      .rejects.toEqual(expect.objectContaining({ code: "EQUIPMENT_IDEMPOTENCY_CONFLICT" }));

    const instances = applied[0]!.equipment.instances;
    const swag = instances.find((instance) => instance.instanceId === first.instanceId)!;
    const sword = instances.find((instance) => instance.instanceId === stock.instanceId)!;
    expect(swag).toMatchObject({ definitionId: "legion_gladius", displayName: "Legion Gladius", itemLevel: 0 });
    expect(sword.itemLevel).toBe(0);
    const { definitionId: _swagId, instanceId: _swagInstance, ...swagDerived } = swag.derived;
    const { definitionId: _swordId, instanceId: _swordInstance, ...swordDerived } = sword.derived;
    expect(swagDerived).toEqual(swordDerived);
    for (const field of [
      "attackPowerBonus", "defenseBonus", "weaponCategory", "armorCategory",
      "twoHanded", "category", "maximumItemLevel", "nextUpgradeLevel", "nextUpgradeCost"
    ] as const) {
      expect(swag[field], field).toEqual(sword[field]);
    }
    expect(requireEquipmentDefinition(swag.definitionId)).toMatchObject({
      equipmentRole: "cosmetic",
      gameplayFamilyId: "sword",
      marketTradable: true
    });
    expect(baseAppearanceForEquipment(DEFAULT_PLAYER_APPEARANCE_CATALOG, swag.definitionId)?.appearanceId)
      .toBe("legion_gladius");

    await expect(materials()).resolves.toEqual({
      iron_bar: "0", wood: "0", rusted_legion_blade: "0", ancient_coin: "0"
    });
    await expect(instanceCount()).resolves.toBe(2);
  });

  it("refuses without materials and for non-swag cosmetics, spending nothing", async () => {
    const service = new EquipmentService(pool!, { now: () => new Date("2026-10-05T12:00:00Z") });
    const authority = manorSmithAuthority();
    await new InventoryService(pool!).grantItemsForOperation({
      operationKey: `swag-refusal-materials:${playerId}`,
      playerId,
      source: "swag_test_opening",
      grants: [
        { itemId: "iron_bar", variant: "default", quantity: 20 },
        { itemId: "wood", variant: "default", quantity: 100 },
        { itemId: "barrow_torc", variant: "default", quantity: 3 }
      ]
    });
    // Barrow Blade also needs 2 Rimed Draugr Mail, which the player lacks.
    await expect(service.craftStockEquipment(
      actor, "sword", "swag-barrow", authority, swagId("barrow_blade")
    )).rejects.toEqual(expect.objectContaining({ code: "EQUIPMENT_CRAFT_MATERIALS_REQUIRED" }));
    await expect(service.craftStockEquipment(
      actor, "axe", "cosmetic-double-axe", authority, swagId("double_axe")
    )).rejects.toEqual(expect.objectContaining({ code: "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE" }));
    await expect(service.craftStockEquipment(
      actor, "tunic", "cosmetic-non-swag-cloth", authority, swagId("non-swag-cloth")
    )).rejects.toEqual(expect.objectContaining({ code: "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE" }));
    // A swag ID sent with another family is refused rather than crafted.
    await expect(service.craftStockEquipment(
      actor, "axe", "swag-wrong-family", authority, swagId("legion_gladius")
    )).rejects.toEqual(expect.objectContaining({ code: "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE" }));

    await expect(materials()).resolves.toMatchObject({ iron_bar: "20", wood: "100" });
    await expect(pool!.query(
      `SELECT quantity::text FROM player_inventory
       WHERE player_id=$1 AND resource_type='barrow_torc' AND variant='default'`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ quantity: "3" }] });
    await expect(instanceCount()).resolves.toBe(2);
  });

  async function materials(): Promise<Record<string, string>> {
    const result = await pool!.query<{ resource_type: string; quantity: string }>(
      `SELECT resource_type,quantity::text FROM player_inventory
       WHERE player_id=$1 AND variant='default'
         AND resource_type IN ('iron_bar','wood','rusted_legion_blade','ancient_coin')`,
      [playerId]
    );
    const quantities = Object.fromEntries(result.rows.map((row) => [row.resource_type, row.quantity]));
    return Object.fromEntries(
      ["iron_bar", "wood", "rusted_legion_blade", "ancient_coin"]
        .map((itemId) => [itemId, quantities[itemId] ?? "0"])
    );
  }

  async function instanceCount(): Promise<number> {
    const result = await pool!.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM equipment_instances WHERE owner_player_id=$1",
      [playerId]
    );
    return result.rows[0]!.count;
  }

  async function seedFixtureInventory(): Promise<void> {
    await pool!.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Swag fixture','world-test',35,-106,35,-106,
         900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [fixturePlayerId]
    );
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO inventory_operations (operation_key,player_id,source,metadata)
         VALUES ($1,$2,'swag_migration_fixture','{}'::jsonb)`,
        [`swag-inventory:${fixturePlayerId}`, fixturePlayerId]
      );
      await client.query(
        `INSERT INTO player_inventory (player_id,resource_type,variant,quantity,version)
         VALUES ($1,'leather','default',40,1)`,
        [fixturePlayerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,metadata
         ) VALUES ($1,$2,'leather','default',40,40,1,'swag_migration_fixture','{}'::jsonb)`,
        [`swag-inventory:${fixturePlayerId}`, fixturePlayerId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedCrafter(): Promise<void> {
    await pool!.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool!.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,$1,$1,'equipment-test',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [playerId, accountId]
    );
    await new InventoryService(pool!).grantItemsForOperation({
      operationKey: `swag-materials:${playerId}`,
      playerId,
      source: "swag_test_opening",
      grants: [
        { itemId: "iron_bar", variant: "default", quantity: 20 },
        { itemId: "wood", variant: "default", quantity: 100 },
        { itemId: "rusted_legion_blade", variant: "default", quantity: 3 },
        { itemId: "ancient_coin", variant: "default", quantity: 3 }
      ]
    });
  }
});

function swagId(value: string) {
  return requireEquipmentDefinition(value).definitionId;
}

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
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Swag weapons test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

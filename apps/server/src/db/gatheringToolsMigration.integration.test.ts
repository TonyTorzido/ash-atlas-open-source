import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireEquipmentDefinition } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EquipmentService } from "../game/equipment.js";
import { InventoryService } from "../game/inventory.js";
import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TOOLS_MIGRATION = "1190_gathering_tools.sql";
const SLOTS_MIGRATION = "1191_gathering_tool_slots.sql";
const HATCHET_MIGRATION = "1216_double_axe_stock_axe.sql";
const TOOL_IDS = ["wooden_axe", "stone_axe", "wooden_pickaxe", "stone_pickaxe", "starter_fishing_pole"];

describeDatabase("gathering tools migrations, crafting and the three tool slots", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_tools_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const fixturePlayerId = `tools-fixture-${suffix}`;
  const playerId = `tools-crafter-${suffix}`;
  const accountId = randomUUID();
  const actor = { playerId, accountId };
  let databaseUrl = "";
  let precedingDirectory = "";
  let toolsDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-tools-pre-"));
    toolsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-tools-1190-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-tools-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      // 1216 renames these tools (Hatchets), so it runs with 1190 rather than before it.
      if (name !== TOOLS_MIGRATION && name !== SLOTS_MIGRATION && name !== HATCHET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      }
      if (name !== SLOTS_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(toolsDirectory, name));
      }
      await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });
    await seedFixtureInventory();
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (toolsDirectory) await rm(toolsDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, matches the startup catalog, and is empty on a second run", async () => {
    await expect(validateItemDefinitionCatalog(pool!)).rejects.toThrow();
    await expect(runMigrations(databaseUrl, { migrationsDirectory: toolsDirectory }))
      .resolves.toEqual([TOOLS_MIGRATION, HATCHET_MIGRATION]);
    await expect(pool!.query(
      "SELECT quantity::text FROM player_inventory WHERE player_id=$1 AND resource_type='leather'",
      [fixturePlayerId]
    )).resolves.toMatchObject({ rows: [{ quantity: "40" }] });
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
    const rows = await pool!.query<{ item_id: string; equipment_family_id: string; equipment_role: string }>(
      `SELECT item_id,equipment_family_id,equipment_role FROM item_definitions
       WHERE item_id = ANY($1::text[]) ORDER BY item_id`,
      [TOOL_IDS]
    );
    expect(rows.rows).toEqual(TOOL_IDS.slice().sort().map((itemId) => ({
      item_id: itemId, equipment_family_id: itemId, equipment_role: "stock"
    })));
    await seedCrafter();

    // A pickaxe equipped (and saved in gear set 1) under the old single `tool` slot.
    const service = new EquipmentService(pool!, { now: () => new Date("2026-10-06T11:00:00Z") });
    const pickaxe = await service.craftStockEquipment(actor, "stone_pickaxe", "craft-old-pickaxe", manorSmithAuthority());
    await service.getSnapshot(playerId);
    await pool!.query(
      "UPDATE equipment_instances SET location='equipped', equipped_slot='tool' WHERE instance_id=$1",
      [pickaxe.instanceId]
    );
    await pool!.query(
      "INSERT INTO combat_kit_items (player_id,kit_index,equipment_slot,instance_id) VALUES ($1,1,'tool',$2)",
      [playerId, pickaxe.instanceId]
    );
    await pool!.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action,instance_id,requested_slot,completed_at)
       VALUES ($1,$2,'equip',$3,'tool',now())`,
      [`old-tool-equip:${playerId}`, playerId, pickaxe.instanceId]
    );

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([SLOTS_MIGRATION]);
    await expect(pool!.query(
      "SELECT location,equipped_slot FROM equipment_instances WHERE instance_id=$1", [pickaxe.instanceId]
    )).resolves.toMatchObject({ rows: [{ location: "equipped", equipped_slot: "tool_pickaxe" }] });
    await expect(pool!.query(
      "SELECT equipment_slot FROM combat_kit_items WHERE player_id=$1 AND kit_index=1", [playerId]
    )).resolves.toMatchObject({ rows: [{ equipment_slot: "tool_pickaxe" }] });
    await expect(pool!.query(
      "SELECT requested_slot FROM equipment_operations WHERE operation_key=$1", [`old-tool-equip:${playerId}`]
    )).resolves.toMatchObject({ rows: [{ requested_slot: "tool_pickaxe" }] });
    await expect(pool!.query(
      "UPDATE equipment_instances SET equipped_slot='tool' WHERE instance_id=$1", [pickaxe.instanceId]
    )).rejects.toThrow(/equipped_slot_check/u);
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
    const migrated = await service.getSnapshot(playerId);
    expect(migrated.active.tool_pickaxe?.instanceId).toBe(pickaxe.instanceId);

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([]);
    await service.unequip(playerId, pickaxe.instanceId!, "unequip-old-pickaxe");
  }, 180_000);

  it("crafts a wooden axe once, equips it only in the axe slot with no stat change, and unequips it", async () => {
    const service = new EquipmentService(pool!, { now: () => new Date("2026-10-06T12:00:00Z") });
    const authority = manorSmithAuthority();
    const [first, second] = await Promise.all([
      service.craftStockEquipment(actor, "wooden_axe", "craft-wooden-axe", authority),
      service.craftStockEquipment(actor, "wooden_axe", "craft-wooden-axe", authority)
    ]);
    expect([first, second].filter((result) => result.applied)).toHaveLength(1);
    expect(first.instanceId).toBe(second.instanceId);
    await expect(service.craftStockEquipment(actor, "wooden_axe", "craft-wooden-axe", authority))
      .resolves.toMatchObject({ applied: false, replayed: true, instanceId: first.instanceId });
    await expect(wood()).resolves.toBe("25");
    await expect(instanceCount()).resolves.toBe(2);

    const before = (await service.getSnapshot(playerId)).derivedStats;
    // Denied: a tool never goes in a weapon slot.
    await expect(service.equip(playerId, first.instanceId!, "melee", "equip-axe-melee"))
      .rejects.toBeDefined();
    // Denied: an axe never goes in the pickaxe slot.
    await expect(service.equip(playerId, first.instanceId!, "tool_pickaxe", "equip-axe-pickaxe-slot"))
      .rejects.toBeDefined();
    const equipped = await service.equip(playerId, first.instanceId!, "tool_axe", "equip-axe-tool");
    expect(equipped.equipment.active.tool_axe?.instanceId).toBe(first.instanceId);
    expect(equipped.equipment.active.melee).toBeNull();
    const { items: _beforeItems, ...beforeTotals } = before;
    const { items: _afterItems, ...afterTotals } = equipped.equipment.derivedStats;
    void _beforeItems; void _afterItems;
    expect(afterTotals).toEqual(beforeTotals);

    // Axe, pickaxe and pole equipped together, still with no stat change.
    const pickaxe = (await service.getSnapshot(playerId)).instances
      .find((item) => item.definitionId === "stone_pickaxe")!;
    const pole = await service.craftStockEquipment(actor, "starter_fishing_pole", "craft-pole", authority);
    await service.equip(playerId, pickaxe.instanceId, "tool_pickaxe", "equip-pickaxe");
    const all = await service.equip(playerId, pole.instanceId!, "tool_fishing_pole", "equip-pole");
    expect(all.equipment.active.tool_axe?.definitionId).toBe("wooden_axe");
    expect(all.equipment.active.tool_pickaxe?.definitionId).toBe("stone_pickaxe");
    expect(all.equipment.active.tool_fishing_pole?.definitionId).toBe("starter_fishing_pole");
    const { items: _allItems, ...allTotals } = all.equipment.derivedStats;
    void _allItems;
    expect(allTotals).toEqual(beforeTotals);

    const unequipped = await service.unequip(playerId, first.instanceId!, "unequip-axe");
    expect(unequipped.equipment.active.tool_axe).toBeNull();
    expect(unequipped.equipment.active.tool_pickaxe?.instanceId).toBe(pickaxe.instanceId);
    expect(requireEquipmentDefinition("wooden_axe").slot).toBe("tool_axe");
  });

  it("crafts a starter tool on the player without a Smithing Station, once on replay", async () => {
    const service = new EquipmentService(pool!, { now: () => new Date("2026-10-06T12:00:00Z") });
    await new InventoryService(pool!).grantItemsForOperation({
      operationKey: `tools-portable-materials:${playerId}`,
      playerId,
      source: "tools_test_opening",
      grants: [{ itemId: "wood", variant: "default", quantity: 40 }]
    });
    const woodBefore = BigInt(await wood());
    const countBefore = await instanceCount();
    const portable = { kind: "portable_craft" as const, authorize: async () => undefined };
    const [first, second] = await Promise.all([
      service.craftStockEquipment(actor, "wooden_pickaxe", "craft-portable-pickaxe", portable),
      service.craftStockEquipment(actor, "wooden_pickaxe", "craft-portable-pickaxe", portable)
    ]);
    expect([first, second].filter((result) => result.applied)).toHaveLength(1);
    expect(first.instanceId).toBe(second.instanceId);
    await expect(service.craftStockEquipment(actor, "wooden_pickaxe", "craft-portable-pickaxe", portable))
      .resolves.toMatchObject({ applied: false, replayed: true, instanceId: first.instanceId });
    await expect(wood()).resolves.toBe(String(woodBefore - 20n));
    await expect(instanceCount()).resolves.toBe(countBefore + 1);

    // Denied: a non-portable recipe never crafts on the player.
    await expect(service.craftStockEquipment(actor, "bow", "craft-portable-bow", portable))
      .rejects.toMatchObject({ code: "MANOR_SMITH_ACCESS_DENIED" });
    await expect(wood()).resolves.toBe(String(woodBefore - 20n));
  });

  async function wood(): Promise<string> {
    const result = await pool!.query<{ quantity: string }>(
      `SELECT quantity::text FROM player_inventory
       WHERE player_id=$1 AND variant='default' AND resource_type='wood'`,
      [playerId]
    );
    return result.rows[0]?.quantity ?? "0";
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
       ) VALUES ($1,'Tools fixture','world-test',35,-106,35,-106,
         900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [fixturePlayerId]
    );
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO inventory_operations (operation_key,player_id,source,metadata)
         VALUES ($1,$2,'tools_migration_fixture','{}'::jsonb)`,
        [`tools-inventory:${fixturePlayerId}`, fixturePlayerId]
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
         ) VALUES ($1,$2,'leather','default',40,40,1,'tools_migration_fixture','{}'::jsonb)`,
        [`tools-inventory:${fixturePlayerId}`, fixturePlayerId]
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
      operationKey: `tools-materials:${playerId}`,
      playerId,
      source: "tools_test_opening",
      grants: [
        { itemId: "wood", variant: "default", quantity: 60 },
        { itemId: "stone", variant: "default", quantity: 20 },
        { itemId: "flax_fiber", variant: "default", quantity: 10 }
      ]
    });
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
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Gathering tools test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

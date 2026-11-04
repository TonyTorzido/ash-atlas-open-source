import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { HOTBAR_DEFAULT_ROW_POSITIONS, HOTBAR_PLAYER_SLOT_IDS } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";
import { HotbarService } from "../game/hotbar.js";
import { InventoryService } from "../game/inventory.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "0851_quickslot_cumulative_backpack_capacity.sql";

const TARGET_PLAYER_ID = "quickslot-migration-target";
const OTHER_PLAYER_ID = "quickslot-migration-other";

describeDatabase("quick-slot and cumulative backpack forward migration", () => {
  const databaseName = `ash_atlas_stability_quickslot_backpack_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repositoryMigrations = path.resolve(process.cwd(), "../../db/migrations");
  let migrationsDirectory = "";
  let databaseUrl = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-quickslot-backpack-"));
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
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });
    await seedPlayer(TARGET_PLAYER_ID, "Quickslot Migration Target");
    await seedPlayer(OTHER_PLAYER_ID, "Quickslot Migration Other");
    const manor = await pool.query<{ id: string }>(
      "INSERT INTO player_manors (owner_player_id) VALUES ($1) RETURNING id::text",
      [TARGET_PLAYER_ID]
    );
    const manorId = manor.rows[0]!.id;

    await pool.query(
      `INSERT INTO player_hotbar_settings (player_id,revision,slots)
       VALUES ($1,7,$2::jsonb),($3,3,$4::jsonb)`,
      [TARGET_PLAYER_ID, JSON.stringify(legacySixSlots()), OTHER_PLAYER_ID, JSON.stringify(legacyEightSlots())]
    );

    await seedBackpack({
      playerId: TARGET_PLAYER_ID,
      location: "inventory",
      inventorySlotIndex: null,
      manorId: null,
      manorSlotIndex: null,
      equippedSlot: null,
      upgradeLevel: 1,
      version: "11"
    });
    await seedBackpack({
      playerId: TARGET_PLAYER_ID,
      location: "equipped",
      inventorySlotIndex: null,
      manorId: null,
      manorSlotIndex: null,
      equippedSlot: 0,
      upgradeLevel: 2,
      version: "12"
    });
    await seedBackpack({
      playerId: TARGET_PLAYER_ID,
      location: "manor_storage",
      inventorySlotIndex: null,
      manorId,
      manorSlotIndex: 4,
      equippedSlot: null,
      upgradeLevel: 3,
      version: "13"
    });
    await seedBackpack({
      playerId: TARGET_PLAYER_ID,
      location: "destroyed",
      inventorySlotIndex: null,
      manorId: null,
      manorSlotIndex: null,
      equippedSlot: null,
      upgradeLevel: 4,
      version: "14"
    });
    await seedBackpack({
      playerId: OTHER_PLAYER_ID,
      location: "inventory",
      inventorySlotIndex: null,
      manorId: null,
      manorSlotIndex: null,
      equippedSlot: null,
      upgradeLevel: 5,
      version: "21"
    });

    // This representative ledger row is unrelated to either migration change.
    await new InventoryService(pool).grantItemsForOperation({
      playerId: TARGET_PLAYER_ID,
      operationKey: "quickslot-migration-retained-inventory",
      source: "quickslot_migration_test",
      sourceEntityType: "test",
      sourceEntityId: TARGET_PLAYER_ID,
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

  it("normalizes legacy hotbars, counts owned custody once, preserves rows, and reruns empty", async () => {
    const beforeBackpacks = await backpackRows();
    const beforePlayers = await pool!.query(
      `SELECT id,account_id,username,username_normalized,region_code,lat,lon
       FROM players
       WHERE id IN ($1,$2)
       ORDER BY id`,
      [TARGET_PLAYER_ID, OTHER_PLAYER_ID]
    );
    const beforeAccounts = await pool!.query(
      `SELECT accounts.id,accounts.status,accounts.trust_tier
       FROM accounts JOIN players ON players.account_id=accounts.id
       WHERE players.id IN ($1,$2)
       ORDER BY accounts.id`,
      [TARGET_PLAYER_ID, OTHER_PLAYER_ID]
    );
    const beforeManors = await pool!.query(
      "SELECT id::text,owner_player_id FROM player_manors ORDER BY id"
    );
    const beforeInventory = await pool!.query(
      `SELECT player_id,resource_type,variant,quantity::text,entry_id::text
       FROM player_inventory
       WHERE player_id=$1`,
      [TARGET_PLAYER_ID]
    );
    const beforeMaximum = await pool!.query<{ maximum: string }>(
      "SELECT player_inventory_maximum_grams($1)::text AS maximum",
      [TARGET_PLAYER_ID]
    );
    expect(beforeMaximum.rows[0]?.maximum).toBe("115000");

    await expect(runMigrations(databaseUrl, { migrationsDirectory }))
      .resolves.toEqual([MIGRATION]);

    const rawHotbars = await pool!.query<{
      player_id: string;
      revision: number;
      slots: unknown[];
      row_count: number;
      row_positions: number[];
    }>(
      `SELECT player_id,revision,slots,row_count,row_positions
       FROM player_hotbar_settings
       WHERE player_id IN ($1,$2)
       ORDER BY player_id`,
      [TARGET_PLAYER_ID, OTHER_PLAYER_ID]
    );
    expect(rawHotbars.rows).toEqual([
      {
        player_id: OTHER_PLAYER_ID,
        revision: 3,
        slots: legacyEightSlots(),
        row_count: 4,
        row_positions: [...HOTBAR_DEFAULT_ROW_POSITIONS]
      },
      {
        player_id: TARGET_PLAYER_ID,
        revision: 7,
        slots: legacySixSlots(),
        row_count: 4,
        row_positions: [...HOTBAR_DEFAULT_ROW_POSITIONS]
      }
    ]);

    const hotbar = new HotbarService(pool!);
    const targetSettings = await hotbar.get(TARGET_PLAYER_ID);
    const otherSettings = await hotbar.get(OTHER_PLAYER_ID);
    expect(targetSettings).toMatchObject({
      revision: 7,
      rowCount: 4,
      rowPositions: [...HOTBAR_DEFAULT_ROW_POSITIONS]
    });
    expect(otherSettings).toMatchObject({
      revision: 3,
      rowCount: 4,
      rowPositions: [...HOTBAR_DEFAULT_ROW_POSITIONS]
    });
    expect(targetSettings.slots.map((slot) => slot.slotId)).toEqual([...HOTBAR_PLAYER_SLOT_IDS]);
    expect(otherSettings.slots.map((slot) => slot.slotId)).toEqual([...HOTBAR_PLAYER_SLOT_IDS]);

    // A canonical write after the migration proves legacy reads can be persisted
    // in the ten-slot contract without losing the saved bindings.
    await expect(hotbar.update(TARGET_PLAYER_ID, targetSettings)).resolves.toMatchObject({
      revision: 8,
      rowCount: 4,
      rowPositions: [...HOTBAR_DEFAULT_ROW_POSITIONS],
      slots: targetSettings.slots
    });
    const persistedCanonical = await pool!.query<{ slots: unknown[]; revision: number }>(
      `SELECT slots,revision FROM player_hotbar_settings WHERE player_id=$1`,
      [TARGET_PLAYER_ID]
    );
    expect(persistedCanonical.rows[0]).toEqual({
      slots: targetSettings.slots,
      revision: 8
    });

    const maximums = await pool!.query<{ player_id: string; maximum: string }>(
      `SELECT player_id,player_inventory_maximum_grams(player_id)::text AS maximum
       FROM player_inventory_capacities
       WHERE player_id IN ($1,$2)
       ORDER BY player_id`,
      [TARGET_PLAYER_ID, OTHER_PLAYER_ID]
    );
    // 100000 + level 1 (10000) + level 2 (15000) + level 3 (20000).
    // The destroyed level 4 and the other player's level 5 are excluded.
    expect(maximums.rows).toEqual([
      { player_id: OTHER_PLAYER_ID, maximum: "130000" },
      { player_id: TARGET_PLAYER_ID, maximum: "145000" }
    ]);

    await expect(backpackRows()).resolves.toEqual(beforeBackpacks);
    await expect(pool!.query(
      `SELECT id,account_id,username,username_normalized,region_code,lat,lon
       FROM players
       WHERE id IN ($1,$2)
       ORDER BY id`,
      [TARGET_PLAYER_ID, OTHER_PLAYER_ID]
    )).resolves.toEqual(beforePlayers);
    await expect(pool!.query(
      `SELECT accounts.id,accounts.status,accounts.trust_tier
       FROM accounts JOIN players ON players.account_id=accounts.id
       WHERE players.id IN ($1,$2)
       ORDER BY accounts.id`,
      [TARGET_PLAYER_ID, OTHER_PLAYER_ID]
    )).resolves.toEqual(beforeAccounts);
    await expect(pool!.query(
      "SELECT id::text,owner_player_id FROM player_manors ORDER BY id"
    )).resolves.toEqual(beforeManors);
    await expect(pool!.query(
      `SELECT player_id,resource_type,variant,quantity::text,entry_id::text
       FROM player_inventory
       WHERE player_id=$1`,
      [TARGET_PLAYER_ID]
    )).resolves.toEqual(beforeInventory);

    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
  }, 90_000);

  async function seedPlayer(playerId: string, username: string): Promise<void> {
    const accountId = randomUUID();
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
      [playerId, accountId, username]
    );
    await pool!.query(
      "INSERT INTO player_inventory_capacities (player_id,base_capacity_grams) VALUES ($1,100000)",
      [playerId]
    );
  }

  async function seedBackpack(input: {
    playerId: string;
    location: "inventory" | "equipped" | "manor_storage" | "destroyed";
    equippedSlot: number | null;
    inventorySlotIndex: number | null;
    manorId: string | null;
    manorSlotIndex: number | null;
    upgradeLevel: number;
    version: string;
  }): Promise<void> {
    const instanceId = randomUUID();
    const operationKey = `quickslot-migration-seed:${input.playerId}:${input.location}`;
    const account = await pool!.query<{ account_id: string }>(
      "SELECT account_id FROM players WHERE id=$1",
      [input.playerId]
    );
    await pool!.query(
      `INSERT INTO backpack_operations (
         operation_key,player_id,account_id,request_id,action,request_hash
       ) VALUES ($1,$2,$3,$4,'create',$5)`,
      [operationKey, input.playerId, account.rows[0]!.account_id, operationKey, "b".repeat(64)]
    );
    await pool!.query(
      `INSERT INTO player_backpack_instances (
         instance_id,owner_player_id,definition_id,location,equipped_slot,
         inventory_slot_index,manor_id,manor_slot_index,version,
         created_by_operation_key,upgrade_level
       ) VALUES ($1,$2,'starter_backpack',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        instanceId,
        input.playerId,
        input.location,
        input.equippedSlot,
        input.inventorySlotIndex,
        input.manorId,
        input.manorSlotIndex,
        input.version,
        operationKey,
        input.upgradeLevel
      ]
    );
  }

  async function backpackRows(): Promise<unknown[]> {
    const result = await pool!.query(
      `SELECT instance_id::text,owner_player_id,definition_id,location,
              equipped_slot,inventory_slot_index,manor_id::text,manor_slot_index,
              version::text,created_by_operation_key,upgrade_level
       FROM player_backpack_instances
       ORDER BY instance_id`
    );
    return result.rows;
  }
});

function legacySixSlots(): unknown[] {
  return [
    { slotId: "left-1", binding: { kind: "consumable", itemId: "balsam_resin", variant: null } },
    { slotId: "left-2", binding: null },
    { slotId: "left-3", binding: null },
    { slotId: "right-1", binding: null },
    { slotId: "right-2", binding: { kind: "fishing_rod", rodId: "legacy-rod-7" } },
    { slotId: "right-3", binding: null }
  ];
}

function legacyEightSlots(): unknown[] {
  return [
    ...legacySixSlots().slice(0, 3),
    { slotId: "left-4", binding: null },
    ...legacySixSlots().slice(3),
    { slotId: "right-4", binding: null }
  ];
}

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.pathname.slice(1).startsWith("ash_atlas_stability")
  ) {
    throw new Error(
      "Quick-slot/backpack migration test requires local disposable ash_atlas_stability"
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

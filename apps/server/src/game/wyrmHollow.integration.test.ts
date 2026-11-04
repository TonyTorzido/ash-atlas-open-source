import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { EquipmentService } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { validateItemDefinitionCatalog } from "./items.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const ITEM_MIGRATION = "1197_wyrm_hollow_item_definitions.sql";
// Dragon Scale is defined by trunk's 1101 dungeon-loot migration; this migration adds the Wyrm Egg.
const NEW_ITEM_IDS = ["wyrm_egg"];

describeDatabase("Wyrm Hollow items and Rare Beast Mastery recipes", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_wyrm_hollow_${suffix}`;
  const playerId = `dragon-player-${suffix}`;
  const accountId = randomUUID();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let inventory: InventoryService;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) throw new Error("Use a loopback disposable database");
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-wyrm-hollow-"));
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < ITEM_MIGRATION).sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 8 });
    inventory = new InventoryService(pool);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("upgrades a populated database, passes the startup catalog check and reruns empty", async () => {
    await pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES (
         $1, $2, 'Dragon Tester', '#f97316', 'NM', 35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326)
       )`,
      [playerId, accountId]
    );
    await pool.query("INSERT INTO player_progression_profiles (player_id,level) VALUES ($1,25)", [playerId]);
    await pool.query("INSERT INTO player_equipment_state (player_id) VALUES ($1)", [playerId]);
    await grant("iron_bar", 40);
    await expect(pool.query("SELECT 1 FROM item_definitions WHERE item_id = ANY($1::text[])", [NEW_ITEM_IDS]))
      .resolves.toMatchObject({ rowCount: 0 });

    await expect(runMigrations(databaseUrl)).resolves.toEqual(expect.arrayContaining([ITEM_MIGRATION]));

    await expect(pool.query("SELECT 1 FROM item_definitions WHERE item_id = ANY($1::text[])", [NEW_ITEM_IDS]))
      .resolves.toMatchObject({ rowCount: NEW_ITEM_IDS.length });
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    expect(await quantity("iron_bar")).toBe(40);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 300_000);

  it("refuses the Chain Mail recipe without Rare Beast Mastery and crafts it once at rank 1", async () => {
    const service = new EquipmentService(pool, { now: () => new Date("2026-10-05T12:00:00Z") });
    const actor = { playerId, accountId };
    await grant("dragon_scale", 10);

    await expect(service.craftStockEquipment(actor, "chain_mail", "dragon-mail-denied", smithAuthority()))
      .rejects.toMatchObject({ code: "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE" });
    expect(await quantity("dragon_scale")).toBe(10);

    await pool.query(
      "INSERT INTO player_skill_ranks (player_id, skill_id, rank, points_spent) VALUES ($1, 'rare_beast_mastery', 1, 1)",
      [playerId]
    );
    const crafted = await service.craftStockEquipment(actor, "chain_mail", "dragon-mail", smithAuthority());
    expect(crafted).toMatchObject({ applied: true, definitionId: "chain_armor" });
    await expect(service.craftStockEquipment(actor, "chain_mail", "dragon-mail", smithAuthority()))
      .resolves.toMatchObject({ replayed: true, instanceId: crafted.instanceId });
    expect(await quantity("dragon_scale")).toBe(0);
    expect(await quantity("iron_bar")).toBe(32);
  }, 120_000);

  async function grant(itemId: string, amount: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `dragon-test:${randomUUID()}`,
      playerId,
      source: "wyrm_hollow_test",
      grants: [{ itemId: itemId as never, variant: null, quantity: amount }]
    });
  }

  async function quantity(itemId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT COALESCE(SUM(quantity),0)::text AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type=$2",
      [playerId, itemId]
    );
    return Number(result.rows[0]!.quantity);
  }
});

function smithAuthority() {
  return {
    kind: "manor_smith" as const,
    manorId: "00000000-0000-4000-8000-000000000020",
    manorSessionId: "00000000-0000-4000-8000-000000000021",
    movementSequence: 1,
    authorize: async () => undefined
  };
}

import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";
import { validateItemDefinitionCatalog } from "./items.js";
import { offerGeneralSkill } from "./skills/skillOfferings.js";
import { SkillService } from "./skills/skillService.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const ZEPHYR_MIGRATION = "1120_zephyr_item_definition.sql";

describeDatabase("Monastery Zephyr item and the Perfect Strike offering", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_monastery_${suffix}`;
  const playerId = `monastery-player-${suffix}`;
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
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-monastery-"));
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < ZEPHYR_MIGRATION).sort()) {
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
         $1, $2, 'Monastery Tester', '#f59e0b', 'NM', 35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326)
       )`,
      [playerId, accountId]
    );
    await pool.query("INSERT INTO player_progression_profiles (player_id,level) VALUES ($1,20)", [playerId]);
    await grant("iron_bar", 40);
    await expect(pool.query("SELECT 1 FROM item_definitions WHERE item_id = 'zephyr'")).resolves.toMatchObject({ rowCount: 0 });

    await expect(runMigrations(databaseUrl)).resolves.toEqual(expect.arrayContaining([ZEPHYR_MIGRATION]));

    await expect(pool.query("SELECT 1 FROM item_definitions WHERE item_id = 'zephyr'")).resolves.toMatchObject({ rowCount: 1 });
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    expect(await quantity("iron_bar")).toBe(40);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 300_000);

  it("takes 6 Zephyr once for Perfect Strike: short is refused uncharged, a replay never charges twice", async () => {
    const skills = new SkillService(pool);
    await grant("zephyr", 4);
    await expect(offerGeneralSkill(skills, inventory, playerId, "perfect_strike", "zephyr-short"))
      .rejects.toMatchObject({ code: "SKILL_OFFERING_ITEMS_REQUIRED" });
    expect(await quantity("zephyr")).toBe(4);

    await grant("zephyr", 3);
    await expect(offerGeneralSkill(skills, inventory, playerId, "perfect_strike", "zephyr-offer"))
      .resolves.toMatchObject({ result: { replayed: false } });
    expect(await quantity("zephyr")).toBe(2);
    await expect(offerGeneralSkill(skills, inventory, playerId, "perfect_strike", "zephyr-offer"))
      .resolves.toMatchObject({ result: { replayed: true } });
    await expect(offerGeneralSkill(skills, inventory, playerId, "perfect_strike", "zephyr-again"))
      .rejects.toMatchObject({ code: "SKILL_WORLD_ALREADY_REVEALED" });
    expect(await quantity("zephyr")).toBe(2);
    expect((await skills.unlockState(playerId)).discoveredGeneralSkills).toContain("perfect_strike");
  }, 120_000);

  async function grant(itemId: string, amount: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `monastery-test:${randomUUID()}`,
      playerId,
      source: "monastery_test",
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

import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { AchievementService } from "./achievements.js";
import { EquipmentService } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { JewelStationService } from "./jewelStation.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const FIRST_METAL_MIGRATION = "0958_metals_materials_and_bars.sql";
const SECOND_METAL_MIGRATION = "0959_metals_furnace_and_reforge.sql";
const NEW_ITEM_IDS = [
  "lichen", "thistle", "umbral_essence", "dusk_heart", "bloom_petal", "gearwork_essence",
  "gale_splinter", "griffin_plume", "edict_seal", "skyrise_stone", "mist_drop",
  "revenant_bar", "expel_bar", "mirage_bar", "gale_bar", "fleet_bar", "whetted_bar",
  "vengeance_bar", "gloom_bar", "skyrise_bar", "vital_bar"
];

describeDatabase("metal framework", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_metal_framework_${suffix}`;
  const playerId = `metal-player-${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let accountId = "";
  let inventory: InventoryService;
  let jewelStation: JewelStationService;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-metal-framework-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < FIRST_METAL_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 8 });
    inventory = new InventoryService(pool);
    const equipment = new EquipmentService(pool);
    jewelStation = new JewelStationService(
      pool,
      inventory,
      equipment,
      new AchievementService(pool, () => Date.UTC(2026, 0, 1))
    );
  }, 180_000);


  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("upgrades a populated database to the metal migrations and reruns empty", async () => {
    accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES (
         $1, $2, 'Metal Tester', '#38bdf8', 'NM', 35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326)
       )`,
      [playerId, accountId]
    );
    await pool.query("INSERT INTO player_progression_profiles (player_id,level) VALUES ($1,0)", [playerId]);
    await pool.query("INSERT INTO player_equipment_state (player_id) VALUES ($1)", [playerId]);
    await pool.query("BEGIN");
    await pool.query(
      "INSERT INTO player_wallets (player_id, account_id, gold_balance, version) VALUES ($1, $2, 250, 1)",
      [playerId, accountId]
    );
    await pool.query(
      `INSERT INTO wallet_events (
         operation_key, player_id, account_id, delta_gold, balance_after, version_after, reason
       ) VALUES ('legacy-gold', $1, $2, 250, 250, 1, 'reward')`,
      [playerId, accountId]
    );
    await pool.query("COMMIT");
    const legacy = await createEquipment("double_axe", "enh:v1:ruby:fire");
    await expect(pool.query(
      "SELECT 1 FROM item_definitions WHERE item_id = ANY($1::text[])", [NEW_ITEM_IDS]
    )).resolves.toMatchObject({ rowCount: 0 });

    await expect(runMigrations(databaseUrl)).resolves.toEqual(
      expect.arrayContaining([FIRST_METAL_MIGRATION, SECOND_METAL_MIGRATION])
    );

    await expect(pool.query(
      "SELECT 1 FROM item_definitions WHERE item_id = ANY($1::text[])", [NEW_ITEM_IDS]
    )).resolves.toMatchObject({ rowCount: NEW_ITEM_IDS.length });
    const constraint = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname='furnace_smelt_jobs_recipe_id_check'`
    );
    for (const recipe of ["revenant_bar", "vital_bar", "venomsteel_core", "slag_recovery"]) {
      expect(constraint.rows[0]!.definition).toContain(`'${recipe}'`);
    }
    expect(constraint.rows[0]!.definition).not.toContain("skyrise_bar");
    await expect(pool.query(
      "SELECT enchantment_identity FROM equipment_instances WHERE instance_id=$1", [legacy]
    )).resolves.toMatchObject({ rows: [{ enchantment_identity: "enh:v1:ruby:fire" }] });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);

  }, 180_000);

  it("infuses with four bars, keeps the identity gem-less, and replays without a second debit", async () => {
    const axe = await createEquipment("double_axe", null);
    await grant("gale_bar", 2);
    await expect(jewelStation.imbue(playerId, "wind-short", axe, "gale"))
      .rejects.toMatchObject({ code: "JEWEL_MATERIALS_REQUIRED" });
    expect(await quantity("gale_bar")).toBe(2);
    await expect(identity(axe)).resolves.toBeNull();

    await grant("gale_bar", 2);
    const first = await jewelStation.imbue(playerId, "wind-infuse", axe, "gale");
    expect(first).toMatchObject({ action: "imbue", metal: "gale", gemstone: null, replayed: false });
    await expect(identity(axe)).resolves.toBe("enh:v1:none:gale");
    expect(await quantity("gale_bar")).toBe(0);
    await expect(jewelStation.imbue(playerId, "wind-infuse", axe, "gale"))
      .resolves.toMatchObject({ replayed: true });
    expect(await quantity("gale_bar")).toBe(0);

    await grant("gale_bar", 3);
    await expect(jewelStation.imbue(playerId, "wind-again", axe, "gale"))
      .rejects.toMatchObject({ code: "EQUIPMENT_ALREADY_INFUSED" });
    expect(await quantity("gale_bar")).toBe(3);
  });

  it("accepts one legacy core instead of bars and keeps Venom behind Bitter Blood", async () => {
    const axe = await createEquipment("double_axe", null);
    await grant("fire_core", 1);
    await grant("fire_bar", 3);
    await jewelStation.imbue(playerId, "fire-core", axe, "fire");
    await expect(identity(axe)).resolves.toBe("enh:v1:none:fire");
    expect(await quantity("fire_core")).toBe(0);
    expect(await quantity("fire_bar")).toBe(3);

    const second = await createEquipment("double_axe", null);
    await grant("venomsteel_bar", 3);
    await expect(jewelStation.imbue(playerId, "venom-locked", second, "venomsteel"))
      .rejects.toMatchObject({ code: "JEWEL_ACHIEVEMENT_REQUIRED" });
    expect(await quantity("venomsteel_bar")).toBe(3);
  });

  it("keeps an existing gem when infusing and when reforging", async () => {
    const prepared = await createEquipment("double_axe", "enh:v1:ruby:prepared");
    await grant("vital_bar", 4);
    await jewelStation.imbue(playerId, "life-gem", prepared, "vital");
    await expect(identity(prepared)).resolves.toBe("enh:v1:ruby:vital");
    await grant("lumen", 1_000);
    await jewelStation.reforge(playerId, "life-reforge", prepared);
    await expect(identity(prepared)).resolves.toBe("enh:v1:ruby:prepared");
    expect(await quantity("vital_bar")).toBe(3);
  });

  it("reforges for 230 Lumen, returns three bars, and replays once", async () => {
    const axe = await createEquipment("double_axe", "enh:v1:none:whetted");
    await grant("lumen", 500);
    const before = await quantity("lumen");
    const first = await jewelStation.reforge(playerId, "whetted-reforge", axe);
    expect(first).toMatchObject({ action: "reforge", metal: "whetted", replayed: false });
    expect(await quantity("lumen")).toBe(before - 230);
    await expect(identity(axe)).resolves.toBeNull();
    expect(await quantity("whetted_bar")).toBe(3);

    await expect(jewelStation.reforge(playerId, "whetted-reforge", axe))
      .resolves.toMatchObject({ replayed: true, metal: "whetted" });
    expect(await quantity("lumen")).toBe(before - 230);
    expect(await quantity("whetted_bar")).toBe(3);
    await expect(jewelStation.reforge(playerId, "whetted-nothing", axe))
      .rejects.toMatchObject({ code: "EQUIPMENT_NOT_INFUSED" });
  });

  it("refuses a reforge without enough Lumen and leaves the metal in place", async () => {
    const axe = await createEquipment("double_axe", "enh:v1:none:fleet");
    const balance = await quantity("lumen");
    const spendable = Math.floor(balance / 230);
    expect(spendable).toBeGreaterThanOrEqual(0);
    for (let spend = 0; spend < spendable; spend += 1) {
      const spent = await createEquipment("double_axe", "enh:v1:none:fleet");
      await jewelStation.reforge(playerId, `swift-spend-${spend}`, spent);
    }
    const left = await quantity("lumen");
    expect(left).toBeLessThan(230);
    const bars = await quantity("fleet_bar");
    await expect(jewelStation.reforge(playerId, "swift-poor", axe))
      .rejects.toMatchObject({ code: "JEWEL_LUMEN_REQUIRED" });
    await expect(identity(axe)).resolves.toBe("enh:v1:none:fleet");
    expect(await quantity("fleet_bar")).toBe(bars);
    expect(await quantity("lumen")).toBe(left);
  });

  it("changes the gem for 120 Lumen keeping the metal, and both for one 230 fee", async () => {
    await grant("lumen", 600);
    await grant("enchantment_stone", 1, "opal");
    await grant("enchantment_stone", 1, "sapphire");
    const axe = await createEquipment("double_axe", "enh:v1:ruby:vital");
    const lumen = await quantity("lumen");
    await expect(jewelStation.reforge(playerId, "gem-only", axe, { gemstone: "opal", changeMetal: false }))
      .resolves.toMatchObject({ gemstoneChanged: true, metalChanged: false, replayed: false });
    await expect(identity(axe)).resolves.toBe("enh:v1:opal:vital");
    expect(await quantity("lumen")).toBe(lumen - 120);
    await jewelStation.reforge(playerId, "gem-only", axe, { gemstone: "opal", changeMetal: false });
    expect(await quantity("lumen")).toBe(lumen - 120);

    const both = await createEquipment("double_axe", "enh:v1:ruby:vital");
    await jewelStation.reforge(playerId, "gem-and-metal", both, { gemstone: "sapphire", changeMetal: true });
    await expect(identity(both)).resolves.toBe("enh:v1:sapphire:prepared");
    expect(await quantity("lumen")).toBe(lumen - 350);
  });

  async function createEquipment(definitionId: string, enchantmentIdentity: string | null): Promise<string> {
    const instanceId = randomUUID();
    const creationKey = `metal-equipment:${randomUUID()}`;
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action,completed_at)
       VALUES ($1,$2,'starter_loadout',now())`,
      [creationKey, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,item_level,balance_version,created_by_operation_key,enchantment_identity
       ) VALUES ($1,$2,$3,'inventory',NULL,NULL,0,1,$4,$5)`,
      [instanceId, definitionId, playerId, creationKey, enchantmentIdentity]
    );
    return instanceId;
  }

  async function identity(instanceId: string): Promise<string | null> {
    const result = await pool.query<{ enchantment_identity: string | null }>(
      "SELECT enchantment_identity FROM equipment_instances WHERE instance_id=$1", [instanceId]
    );
    return result.rows[0]!.enchantment_identity;
  }

  async function grant(itemId: string, amount: number, variant: string | null = null): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `metal-test:${randomUUID()}`,
      playerId,
      source: itemId === "lumen" ? "lumen_admin_grant" : "metal_framework_test",
      grants: [{ itemId: itemId as never, variant: variant as never, quantity: amount }]
    });
  }

  async function quantity(itemId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      `SELECT COALESCE(SUM(quantity),0)::text AS quantity FROM player_inventory
       WHERE player_id=$1 AND resource_type=$2`,
      [playerId, itemId]
    );
    return Number(result.rows[0]!.quantity);
  }

});

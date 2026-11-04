import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FURNACE_BUILD_COST, FURNACE_BUILD_DURATION_MS } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { FurnaceService } from "./furnaces.js";
import { InventoryService } from "./inventory.js";
import { PremiumWalletService } from "./premiumWallet.js";
import type { PlayerRecord } from "./state.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0911_glimmer_oil.sql";

describeDatabase("Furnace Glimmer Oil refining", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_glimmer_oil_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const playerId = `glimmer-oil-${suffix}`;
  const accountId = randomUUID();
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let inventory: InventoryService;
  let wallet: PremiumWalletService;
  let service: FurnaceService;
  let furnaceId = "";
  let nowMs = Date.UTC(2026, 9, 2);

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-glimmer-oil-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 12 });
    inventory = new InventoryService(pool);
    wallet = new PremiumWalletService(pool);
    service = new FurnaceService(pool, "test-world", inventory, () => nowMs, undefined, () => 0, wallet);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("upgrades a populated database to Glimmer Oil and reruns empty", async () => {
    await pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,'Oiler','world-test',35,-106,35,-106,
         2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [playerId, accountId]
    );
    const manor = await pool.query<{ id: string }>(
      "INSERT INTO player_manors (owner_player_id) VALUES ($1) RETURNING id",
      [playerId]
    );
    await pool.query(
      `UPDATE player_manors
       SET world_region_code='world-test',world_lat=35,world_lon=-106,
           built_at=now(),geom=ST_SetSRID(ST_MakePoint(-106,35),4326)
       WHERE id=$1`,
      [manor.rows[0]!.id]
    );
    // Populate pre-upgrade Furnace history: a built Furnace and a queued smelt.
    await grant("stone", FURNACE_BUILD_COST.stone);
    await grant("wood", FURNACE_BUILD_COST.wood + 100);
    await grant("coal", FURNACE_BUILD_COST.coal);
    await grant("iron", 5);
    await service.build(player(), randomUUID());
    nowMs += FURNACE_BUILD_DURATION_MS;
    const built = await service.reconcileDueBuilds();
    furnaceId = built.completed[0]!.furnace.furnaceId;
    await service.start(player(), "legacy-smelt", furnaceId, "iron_bar", 1);
    const operationsBefore = await pool.query("SELECT operation_key,action FROM furnace_operations ORDER BY operation_key");
    expect(operationsBefore.rows.map((row) => row.action).sort()).toEqual(["build", "start"]);

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(pool.query("SELECT display_name FROM item_definitions WHERE item_id='refined_oil'"))
      .resolves.toMatchObject({ rows: [{ display_name: "Glimmer Oil" }] });
    await expect(pool.query("SELECT operation_key,action FROM furnace_operations ORDER BY operation_key"))
      .resolves.toMatchObject({ rows: operationsBefore.rows });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM pg_constraint
       WHERE conrelid='furnace_operations'::regclass AND contype='c'
         AND pg_get_constraintdef(oid) LIKE '%action%'`
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 240_000);

  it("refines a quantity in one transaction and replays a retried request without charging again", async () => {
    await grant("crude_oil", 30);
    await creditGlimmer(25n);

    const first = await service.refineGlimmerOil(player(), "refine-20", furnaceId, 20);
    expect(first).toMatchObject({
      replayed: false,
      refinedQuantity: 20,
      inventory: { totals: { crude_oil: 10, refined_oil: 20 } },
      premiumWallet: { accountId, balances: { glimmer: { balance: "5" } } },
      state: { occupiedSlots: 1 }
    });
    const replay = await service.refineGlimmerOil(player(), "refine-20", furnaceId, 20);
    expect(replay).toMatchObject({
      replayed: true,
      refinedQuantity: 20,
      inventory: { totals: { crude_oil: 10, refined_oil: 20 } },
      premiumWallet: { balances: { glimmer: { balance: "5" } } }
    });
    await expect(service.refineGlimmerOil(player(), "refine-20", furnaceId, 5))
      .rejects.toMatchObject({ code: "FURNACE_REPLAY_CONFLICT" });
    await expect(pool.query(
      `SELECT delta::text,reason,ref_type,ref_id FROM premium_wallet_events
       WHERE account_id=$1 AND reason='spend'`,
      [accountId]
    )).resolves.toMatchObject({
      rows: [{ delta: "-20", reason: "spend", ref_type: "furnace_glimmer_oil", ref_id: "refine-20" }]
    });
  });

  it("rejects short Glimmer or short Crude Oil without a partial charge", async () => {
    // Balance: 10 Crude Oil, 5 Glimmer.
    await expect(service.refineGlimmerOil(player(), "refine-short-glimmer", furnaceId, 6))
      .rejects.toMatchObject({ code: "FURNACE_GLIMMER_REQUIRED", message: "Refining 6 Glimmer Oil requires 6 Glimmer." });
    await creditGlimmer(20n);
    await expect(service.refineGlimmerOil(player(), "refine-short-crude", furnaceId, 11))
      .rejects.toMatchObject({ code: "FURNACE_MATERIALS_REQUIRED", message: "Refining 11 Glimmer Oil requires 11 Crude Oil." });
    expect(await balances()).toEqual({ crudeOil: 10, glimmerOil: 20, glimmer: 25 });
  });

  it("serializes concurrent refines against the Glimmer balance and charges a repeated request once", async () => {
    // Balance: 10 Crude Oil, 25 Glimmer.
    await service.refineGlimmerOil(player(), "refine-spend-down", furnaceId, 1);
    const before = await balances();
    expect(before).toEqual({ crudeOil: 9, glimmerOil: 21, glimmer: 24 });
    await grant("crude_oil", 100);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        service.refineGlimmerOil(player(), `refine-race-${index}`, furnaceId, 5))
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(4);
    expect(rejected.map((result) => (result.reason as { code?: string }).code))
      .toEqual(["FURNACE_GLIMMER_REQUIRED", "FURNACE_GLIMMER_REQUIRED"]);
    expect(await balances()).toEqual({ crudeOil: 89, glimmerOil: 41, glimmer: 4 });

    await grant("crude_oil", 3);
    const repeated = await Promise.all(
      Array.from({ length: 4 }, () => service.refineGlimmerOil(player(), "refine-same", furnaceId, 3))
    );
    expect(repeated.filter((result) => !result.replayed)).toHaveLength(1);
    expect(repeated.every((result) => result.refinedQuantity === 3)).toBe(true);
    expect(await balances()).toEqual({ crudeOil: 89, glimmerOil: 44, glimmer: 1 });
    await expect(pool.query("SELECT validate_premium_wallet_event_chain($1,'glimmer')", [accountId]))
      .resolves.toBeTruthy();
  });

  async function grant(itemId: "coal" | "crude_oil" | "iron" | "stone" | "wood", quantity: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `glimmer-oil-test:${randomUUID()}`,
      playerId,
      source: "furnace_test",
      grants: [{ itemId, variant: null, quantity }]
    });
  }

  async function creditGlimmer(amount: bigint): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await wallet.creditForOperationInTransaction(client, {
        accountId,
        currency: "glimmer",
        amount,
        operationKey: `glimmer-oil-test-credit:${randomUUID()}`,
        reason: "admin",
        actorPlayerId: playerId
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function balances(): Promise<{ crudeOil: number; glimmerOil: number; glimmer: number }> {
    const items = await pool.query<{ resource_type: string; quantity: string }>(
      `SELECT resource_type,sum(quantity)::text AS quantity FROM player_inventory
       WHERE player_id=$1 AND resource_type IN ('crude_oil','refined_oil') GROUP BY resource_type`,
      [playerId]
    );
    const byItem = new Map(items.rows.map((row) => [row.resource_type, Number(row.quantity)]));
    const snapshot = await wallet.snapshot(accountId);
    return {
      crudeOil: byItem.get("crude_oil") ?? 0,
      glimmerOil: byItem.get("refined_oil") ?? 0,
      glimmer: Number(snapshot.balances.glimmer.balance)
    };
  }

  function player(): PlayerRecord {
    return {
      playerId,
      username: "Oiler",
      displayColor: null,
      regionCode: "world-test",
      position: { lat: 35, lon: -106 },
      anchor: { lat: 35, lon: -106 },
      moveLeashRadiusM: 2_000,
      movementRevision: 0,
      target: null,
      online: true,
      updatedAt: new Date()
    };
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      parsed.port === "35432" ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Glimmer Oil tests require a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";
import { PlayerService } from "./players.js";
import { GameState } from "./state.js";
import { WaterTravelService, raftLaunchOperationKey } from "./waterTravel.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const MIGRATION = "1046_player_afloat.sql";

databaseSuite("1046 player afloat migration and raft launch", () => {
  const databaseName = `ash_atlas_stability_water_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const playerId = `water-${randomUUID().slice(0, 8)}`;
  const config = loadConfig({ NODE_ENV: "test" });
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let directory = "";
  let databaseUrl = "";

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/ash_atlas_stability") {
      throw new Error("Migration tests require a local disposable ash_atlas_stability admin");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-water-"));
    const migrations = path.resolve(process.cwd(), "../../db/migrations");
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare(MIGRATION) < 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    // Populated: a player standing somewhere before the column exists.
    await pool.query(
      `INSERT INTO players (
         id, username, personal_flag_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, hunger,
         hunger_base_capacity, geom
       ) VALUES ($1,'Water Test','blue','GLOBAL',40,-105,40,-105,600,false,2000,2000,
                 ST_SetSRID(ST_MakePoint(-105,40),4326))`,
      [playerId]
    );
    await copyFile(path.join(migrations, MIGRATION), path.join(directory, MIGRATION));
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([MIGRATION]);
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("keeps existing players on land and has an empty second run", async () => {
    const row = await pool!.query<{ lat: number; afloat: boolean }>(
      "SELECT lat, afloat FROM players WHERE id = $1",
      [playerId]
    );
    expect(row.rows[0]).toEqual({ lat: 40, afloat: false });
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([]);
  });

  it("charges one raft per request id and survives a reconnect afloat", async () => {
    const inventory = new InventoryService(pool!);
    await inventory.grantItemsForOperation({
      operationKey: `water-test-seed:${playerId}`,
      playerId,
      source: "test_seed",
      grants: [
        { itemId: "wood", variant: null, quantity: 10 },
        { itemId: "crude_oil", variant: null, quantity: 4 },
        { itemId: "leather", variant: null, quantity: 10 }
      ]
    });
    const gameState = new GameState(config);
    const players = new PlayerService(pool!, config);
    const loaded = await players.loadPlayer(playerId);
    gameState.connectPlayer(loaded!);
    const waterTravel = new WaterTravelService({
      pool: pool!, inventory, gameState, logger: { warn: vi.fn() }
    });

    const quantities = async () => Object.fromEntries((await pool!.query<{ resource_type: string; quantity: string }>(
      `SELECT resource_type, quantity::text FROM player_inventory
        WHERE player_id = $1 AND resource_type IN ('wood','crude_oil','leather')`,
      [playerId]
    )).rows.map((row) => [row.resource_type, Number(row.quantity)]));

    const first = await waterTravel.launchRaft(playerId, "launch-1");
    expect(first.status).toBe("launched");
    expect(gameState.isAfloat(playerId)).toBe(true);
    expect(await quantities()).toEqual({ wood: 7, crude_oil: 1, leather: 8 });

    // Replay: same request id, no second debit, no second raft.
    gameState.setAfloat(playerId, false);
    expect(await waterTravel.launchRaft(playerId, "launch-1")).toEqual({ status: "replayed" });
    expect(gameState.isAfloat(playerId)).toBe(false);
    expect(await quantities()).toEqual({ wood: 7, crude_oil: 1, leather: 8 });
    expect((await pool!.query(
      "SELECT 1 FROM inventory_operations WHERE operation_key = $1",
      [raftLaunchOperationKey(playerId, "launch-1")]
    )).rowCount).toBe(1);

    // Not enough crude oil for a second raft: nothing is taken.
    expect(await waterTravel.launchRaft(playerId, "launch-2")).toEqual({ status: "insufficient" });
    expect(await quantities()).toEqual({ wood: 7, crude_oil: 1, leather: 8 });

    // Reconnect while afloat: the persisted flag comes back.
    gameState.setAfloat(playerId, true, true);
    await players.persistPlayerSnapshot(gameState.snapshotForPlayer(playerId));
    gameState.markOffline(playerId);
    const reloaded = await players.loadPlayer(playerId);
    expect(reloaded?.afloat).toBe(true);
    const reconnected = new GameState(config);
    reconnected.connectPlayer(reloaded!);
    expect(reconnected.snapshotForPlayer(playerId).afloat).toBe(true);

    // Landing is persisted too.
    reconnected.setAfloat(playerId, false);
    await players.persistPlayerSnapshot(reconnected.snapshotForPlayer(playerId));
    expect((await players.loadPlayer(playerId))?.afloat).toBe(false);
  });
});

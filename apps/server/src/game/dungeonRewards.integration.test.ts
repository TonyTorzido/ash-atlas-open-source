import { randomUUID } from "node:crypto";

import { DUNGEON_CATALOG, type DungeonCatalog } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { DungeonRewardService } from "./dungeonRewards.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("dungeon reward PostgreSQL authority", () => {
  const databaseName = `ash_atlas_stability_dungeon_reward_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const databaseUrl = parsed.toString();
    await runMigrations(databaseUrl);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });

    const accountId = randomUUID();
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES (
         'dungeon-reward-player',$1,'DungeonRewardPlayer','dungeonrewardplayer','GLOBAL',
         40,-105,40,-105,100,true,ST_SetSRID(ST_MakePoint(-105,40),4326)
       )`,
      [accountId]
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
  });

  it("serializes concurrent replay into one claim, one item grant, and one wallet credit", async () => {
    const catalog = rewardCatalog();
    const first = new DungeonRewardService(pool, catalog);
    const second = new DungeonRewardService(pool, catalog);
    const input = {
      instanceId: "dungeon:orc-cave:player:dungeon-reward-player",
      runId: randomUUID(),
      playerId: "dungeon-reward-player",
      dungeonId: "cistern_warrens",
      rewardSourceId: "final-chest",
      rewardTableId: "basic_dungeon_chest"
    };

    const results = await Promise.all([first.grant(input), second.grant(input)]);
    expect(results.map((result) => result.applied).sort()).toEqual([false, true]);
    expect(results[0]!.inventory).toEqual(results[1]!.inventory);
    expect(results[0]!.wallet).toEqual(results[1]!.wallet);

    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM dungeon_reward_claims
          WHERE run_id=$1::uuid AND player_id=$2 AND reward_source_id=$3) AS claims,
         COALESCE((SELECT quantity::int FROM player_inventory
          WHERE player_id=$2 AND resource_type='coal'),0) AS coal,
         COALESCE((SELECT gold_balance::int FROM player_wallets WHERE player_id=$2),0) AS gold`,
      [input.runId, input.playerId, input.rewardSourceId]
    )).resolves.toMatchObject({ rows: [{ claims: 1, coal: 4, gold: 20 }] });
  });

  it("rolls rarity and slots once under concurrent claims and survives service restart", async () => {
    const catalog = rewardCatalog();
    const table = catalog.rewardTables.find((value) => value.id === "basic_dungeon_chest")!;
    table.items = []; table.gold = 0; table.revision = "rarity-loot-v1";
    table.chestLoot = { rarities: (["common", "uncommon", "rare", "epic", "legendary"] as const).map((rarity) => ({
      rarity, chance: rarity === "legendary" ? 100 : 0, slots: 3,
      loot: [{ itemId: "stone", weight: 1, minQuantity: 2, maxQuantity: 2 }]
    })) };
    const input = { instanceId: "rarity-test", runId: randomUUID(), playerId: "dungeon-reward-player",
      dungeonId: "cistern_warrens", rewardSourceId: "rarity-chest", rewardTableId: table.id };
    const results = await Promise.all([new DungeonRewardService(pool, catalog).grant(input), new DungeonRewardService(pool, catalog).grant(input)]);
    expect(results.map((result) => result.applied).sort()).toEqual([false, true]);
    expect((await new DungeonRewardService(pool, catalog).grant(input)).applied).toBe(false);
    const result = await pool.query(`SELECT quantity::int FROM player_inventory WHERE player_id=$1 AND resource_type='stone'`, [input.playerId]);
    expect(result.rows).toEqual([{ quantity: 6 }]);
    const claims = await pool.query("SELECT count(*)::int AS count FROM dungeon_reward_claims WHERE run_id=$1", [input.runId]);
    expect(claims.rows).toEqual([{ count: 1 }]);
  });
});

function rewardCatalog(): DungeonCatalog {
  const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
  catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!.rewardTableIds = ["basic_dungeon_chest"];
  return catalog;
}

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
    throw new Error("Dungeon reward tests require a local disposable ash_atlas_stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable database name");
  }
  return `"${value}"`;
}

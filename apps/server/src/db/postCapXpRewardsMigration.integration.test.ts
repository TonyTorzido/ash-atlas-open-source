import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENCHANTMENT_STONE_VARIANTS } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { InventoryService } from "../game/inventory.js";
import { validateItemDefinitionCatalog } from "../game/items.js";
import { ProgressionService } from "../game/progression.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "0748_post_cap_xp_rewards.sql";

describeDatabase("post-cap XP reward migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_post_cap_xp_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-post-cap-xp-"));
    for (const name of await readdir(sourceMigrations)) {
      if (!name.endsWith(".sql") || name.localeCompare(migration) >= 0) continue;
      await copyFile(path.join(sourceMigrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    const accountId = randomUUID();
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES (
         'post-cap-player',$1,'PostCapPlayer','postcapplayer','#38bdf8','NM',
         35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO player_progression_profiles (
         player_id,total_xp,level,curve_version,persistence_version
       ) VALUES ('post-cap-player',1000000,25,3,9)`
    );
    await new InventoryService(pool).grantItemsForOperation({
      operationKey: "post-cap-migration:retained-wood",
      playerId: "post-cap-player",
      source: "migration_test_fixture",
      grants: [{ itemId: "wood", variant: null, quantity: 7 }]
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("preserves populated state, awards one non-stacking stone, and replays once", async () => {
    await expect(runMigrations(databaseUrl)).resolves.toContain(migration);
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    await expect(pool.query(
      `SELECT total_xp::text,level,persistence_version::text
       FROM player_progression_profiles WHERE player_id='post-cap-player'`
    )).resolves.toMatchObject({
      rows: [{ total_xp: "1000000", level: 25, persistence_version: "9" }]
    });
    await expect(pool.query(
      `SELECT quantity::text FROM player_inventory
       WHERE player_id='post-cap-player' AND resource_type='wood'`
    )).resolves.toMatchObject({ rows: [{ quantity: "7" }] });

    const inventory = new InventoryService(pool);
    const progression = new ProgressionService(pool, inventory);
    const input = {
      operationKey: "post-cap-integration:cycle-1",
      playerId: "post-cap-player",
      sourceType: "development" as const,
      sourceId: "post-cap-integration",
      requestedXp: 250_000
    };
    const first = await progression.grantXp(input);
    const replay = await progression.grantXp(input);
    expect(first).toMatchObject({
      grantedXp: 250_000,
      discardedXp: 0,
      resultingXp: 1_250_000,
      resultingLevel: 25,
      replayed: false,
      progression: { xpIntoLevel: 0, xpForNextLevel: 250_000 }
    });
    expect(first.enchantmentStoneRewards).toHaveLength(1);
    expect(ENCHANTMENT_STONE_VARIANTS).toContain(
      first.enchantmentStoneRewards![0]!.variant
    );
    expect(replay).toMatchObject({ replayed: true, resultingXp: 1_250_000 });
    expect(replay.enchantmentStoneRewards).toEqual(first.enchantmentStoneRewards);

    const stones = await pool.query<{
      variant: string;
      quantity: string;
      slot_count: string;
    }>(
      `SELECT inventory.variant,inventory.quantity::text,
              count(slot.stack_id)::text AS slot_count
       FROM player_inventory inventory
       JOIN player_inventory_slots slot
         ON slot.player_id=inventory.player_id
        AND slot.resource_type=inventory.resource_type
        AND slot.variant=inventory.variant
       WHERE inventory.player_id='post-cap-player'
         AND inventory.resource_type='enchantment_stone'
       GROUP BY inventory.variant,inventory.quantity`
    );
    expect(stones.rows).toEqual([{
      variant: first.enchantmentStoneRewards![0]!.variant,
      quantity: "1",
      slot_count: "1"
    }]);
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM inventory_operations
       WHERE source='post_cap_xp_reward'`
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query(
      `SELECT COALESCE(sum(value),0)::int AS value
       FROM weekly_leaderboard_events
       WHERE player_id='post-cap-player' AND category='exp_earned'`
    )).resolves.toMatchObject({ rows: [{ value: 250_000 }] });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!parsed.pathname.toLowerCase().includes("ash_atlas_stability")) {
    throw new Error("Post-cap XP migration tests require an ash_atlas_stability admin database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

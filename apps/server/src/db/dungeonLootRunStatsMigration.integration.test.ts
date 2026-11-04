import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DUNGEON_CATALOG } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { endDungeonRunStats, recordDungeonRunEntry } from "../game/dungeon.js";
import { DungeonRewardService } from "../game/dungeonRewards.js";
import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATIONS = ["1101_dungeon_loot_item_definitions.sql", "1102_dungeon_run_stats.sql"];
const MEMBERS = ["wp2-member-1", "wp2-member-2", "wp2-member-3", "wp2-member-4", "wp2-member-5"];

describeDatabase("dungeon loot items and run stats migrations", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_dungeon_wp2_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  // The upgrade applies ours and every later migration, so the startup item catalog check sees trunk's items too.
  const upgradeMigrations: string[] = [];
  let pool: DisposableTestPool | undefined;
  const legacyRunId = randomUUID();

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-dungeon-wp2-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-dungeon-wp2-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name < TARGET_MIGRATIONS[0]!) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      } else {
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
        upgradeMigrations.push(name);
      }
    }
    // Trunk migrations grant to this cluster-level role (see fallenPrisonMigrations.integration.test.ts).
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });

    // Populate the pre-upgrade database: players, a live run, and a prior reward claim.
    for (const playerId of MEMBERS) {
      const accountId = randomUUID();
      await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,username_normalized,region_code,lat,lon,
           anchor_lat,anchor_lon,move_leash_radius_m,online,geom
         ) VALUES ($1,$2,$1,$1,'GLOBAL',40,-105,40,-105,100,true,ST_SetSRID(ST_MakePoint(-105,40),4326))`,
        [playerId, accountId]
      );
    }
    await pool.query(
      "INSERT INTO dungeon_instance_runs (instance_id,run_id) VALUES ('dungeon:fangrock:party:p1',$1::uuid)",
      [legacyRunId]
    );
    await pool.query(
      `INSERT INTO dungeon_reward_claims
         (instance_id,run_id,player_id,reward_source_id,dungeon_id,reward_table_id,reward_revision)
       VALUES ('dungeon:fangrock:party:p1',$1::uuid,$2,'den_chest_reward:reward:0','fangrock_cavern',
         'fangrock_cavern_den_chest_reward','fangrock-cavern-den-chest-reward-v1')`,
      [legacyRunId, MEMBERS[0]]
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, matches the startup catalog, and is empty on a second run", async () => {
    const applied = await runMigrations(databaseUrl, { migrationsDirectory: targetDirectory });
    expect(applied).toEqual([...upgradeMigrations].sort());
    expect(applied.slice(0, TARGET_MIGRATIONS.length)).toEqual(TARGET_MIGRATIONS);
    await expect(pool!.query(
      `SELECT item_id,display_name,stackable,max_stack,market_tradable,unit_weight_grams,rarity
         FROM item_definitions
        WHERE item_id IN ('cave_lichen','gale_plume','heartsap','dragon_scale','maw_bloom_petal')
        ORDER BY item_id`
    )).resolves.toMatchObject({ rows: [
      { item_id: "cave_lichen", display_name: "Cave Lichen", stackable: true, max_stack: 25, market_tradable: true, unit_weight_grams: 10, rarity: "rare" },
      { item_id: "dragon_scale", display_name: "Dragon Scale" },
      { item_id: "gale_plume", display_name: "Gale Plume" },
      { item_id: "heartsap", display_name: "Heartsap" },
      { item_id: "maw_bloom_petal", display_name: "Maw Bloom Petal" }
    ] });
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
    // Pre-existing rows are untouched.
    await expect(pool!.query("SELECT count(*)::int AS count FROM dungeon_reward_claims WHERE run_id=$1::uuid", [legacyRunId]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool!.query("SELECT count(*)::int AS count FROM dungeon_run_stats"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([]);
  }, 180_000);

  it("pays five members one completion claim each, and a replay pays nothing", async () => {
    const service = new DungeonRewardService(pool!, DUNGEON_CATALOG);
    const runId = randomUUID();
    const grant = (playerId: string) => service.grant({
      instanceId: "dungeon:fangrock:party:p2", runId, playerId, dungeonId: "fangrock_cavern",
      rewardSourceId: "raptor_chieftain_completion_reward:reward:0",
      rewardTableId: "fangrock_cavern_completion_reward", torchTotal: 1
    });
    const first = await Promise.all(MEMBERS.map(grant));
    expect(first.map((result) => result.applied)).toEqual(MEMBERS.map(() => true));
    // The Raptor Scale is a per-member chance roll (30%, torch scaled): at most one each.
    expect(first.every((result) => result.items.length <= 1 &&
      result.items.every((item) => item.itemId === "raptor_scale" && item.quantity === 1))).toBe(true);
    const scaleHolders = MEMBERS.filter((_, index) => first[index]!.items.length === 1);
    const replay = await Promise.all([...MEMBERS, ...MEMBERS].map(grant));
    expect(replay.every((result) => !result.applied)).toBe(true);
    await expect(pool!.query(
      `SELECT player_id,count(*)::int AS claims FROM dungeon_reward_claims WHERE run_id=$1::uuid
        GROUP BY player_id ORDER BY player_id`, [runId]
    )).resolves.toMatchObject({ rows: MEMBERS.map((player_id) => ({ player_id, claims: 1 })) });
    await expect(pool!.query(
      `SELECT player_id,quantity::int FROM player_inventory WHERE resource_type='raptor_scale' ORDER BY player_id`
    )).resolves.toMatchObject({ rows: scaleHolders.map((player_id) => ({ player_id, quantity: 1 })) });
  }, 60_000);

  it("records a run's start, entrants, deaths and end", async () => {
    const client = await pool!.connect();
    try {
      const cleared = randomUUID();
      const entry = { runId: cleared, instanceId: "dungeon:fangrock:party:p3", dungeonId: "fangrock_cavern",
        tier: null, torchTotal: 1 };
      const startedAt = await recordDungeonRunEntry(client, { ...entry, playerId: MEMBERS[0]! });
      expect(startedAt).toEqual(expect.any(Number));
      await expect(recordDungeonRunEntry(client, { ...entry, playerId: MEMBERS[1]! })).resolves.toBe(startedAt);
      await recordDungeonRunEntry(client, { ...entry, playerId: MEMBERS[0]! });
      await client.query(
        `UPDATE dungeon_run_stats SET deaths_by_player=jsonb_set(deaths_by_player,ARRAY[$2::text],
           to_jsonb(COALESCE((deaths_by_player->>$2::text)::integer,0)+1)) WHERE run_id=$1::uuid AND ended_at IS NULL`,
        [cleared, MEMBERS[1]]
      );
      await client.query(
        `UPDATE dungeon_run_stats SET ended_at=now(),result='cleared',
           duration_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000))::bigint
         WHERE run_id=$1::uuid AND ended_at IS NULL`, [cleared]
      );
      // A cleared run is never re-ended as abandoned when its instance later rotates.
      await endDungeonRunStats(client, cleared);
      await expect(client.query("SELECT party_size,result,deaths_by_player,duration_ms >= 0 AS timed FROM dungeon_run_stats WHERE run_id=$1::uuid", [cleared]))
        .resolves.toMatchObject({ rows: [{ party_size: 2, result: "cleared", timed: true,
          deaths_by_player: { [MEMBERS[0]!]: 0, [MEMBERS[1]!]: 1 } }] });

      const wiped = randomUUID();
      await recordDungeonRunEntry(client, { ...entry, runId: wiped, tier: "t05", playerId: MEMBERS[2]! });
      await client.query(
        `UPDATE dungeon_run_stats SET deaths_by_player=jsonb_set(deaths_by_player,ARRAY[$2::text],'2'::jsonb) WHERE run_id=$1::uuid`,
        [wiped, MEMBERS[2]]
      );
      await endDungeonRunStats(client, wiped);
      const abandoned = randomUUID();
      await recordDungeonRunEntry(client, { ...entry, runId: abandoned, playerId: MEMBERS[3]! });
      await endDungeonRunStats(client, abandoned);
      await expect(client.query("SELECT run_id::text,result,tier FROM dungeon_run_stats WHERE run_id = ANY($1::uuid[]) ORDER BY result", [[wiped, abandoned]]))
        .resolves.toMatchObject({ rows: [{ run_id: abandoned, result: "abandoned", tier: null }, { run_id: wiped, result: "wiped", tier: "t05" }] });
      await expect(client.query("UPDATE dungeon_run_stats SET result='graded_s' WHERE run_id=$1::uuid", [abandoned]))
        .rejects.toThrow(/dungeon_run_stats_result_valid/u);
    } finally {
      client.release();
    }
  }, 60_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Dungeon WP2 migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

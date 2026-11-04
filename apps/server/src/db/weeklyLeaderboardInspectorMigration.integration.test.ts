import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0741_weekly_leaderboard_inspector.sql";

describeDatabase("weekly leaderboard inspector migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_leaderboard_inspector_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-leaderboard-inspector-")
    );
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("backfills only the active Mountain week and installs idempotent completion triggers", async () => {
    await createPlayer(pool, "owner");
    await insertHarvest(pool, "current-tree", "wood", "completed", "now()");
    await insertHarvest(pool, "old-tree", "wood", "completed", "now() - interval '14 days'");
    await insertHarvest(pool, "cancelled-tree", "wood", "cancelled", "now()");
    await insertSettlement(pool, "current-traveler", "completed", "now()");
    await insertSettlement(pool, "old-traveler", "completed", "now() - interval '14 days'");
    await insertSettlement(pool, "pending-traveler", "pending", "NULL");

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(pool.query(
      `SELECT category,count(*)::int AS count
       FROM weekly_leaderboard_events
       WHERE category IN ('trees_chopped','mysterious_travelers_killed')
       GROUP BY category ORDER BY category`
    )).resolves.toMatchObject({
      rows: [
        { category: "mysterious_travelers_killed", count: 1 },
        { category: "trees_chopped", count: 1 }
      ]
    });

    await pool.query(
      `UPDATE combat_reward_settlements
       SET status='completed',completed_at=now()
       WHERE settlement_key='pending-traveler'`
    );
    await pool.query(
      `UPDATE combat_reward_settlements SET updated_at=now()
       WHERE settlement_key='pending-traveler'`
    );
    await insertHarvest(pool, "future-tree", "wood", "active", "NULL");
    await pool.query(
      `UPDATE harvest_sessions SET status='completed',completed_at=now()
       WHERE operation_key='future-tree'`
    );
    await pool.query(
      `UPDATE harvest_sessions SET updated_at=now()
       WHERE operation_key='future-tree'`
    );

    await expect(pool.query(
      `SELECT category,count(*)::int AS count
       FROM weekly_leaderboard_events
       WHERE category IN ('trees_chopped','mysterious_travelers_killed')
       GROUP BY category ORDER BY category`
    )).resolves.toMatchObject({
      rows: [
        { category: "mysterious_travelers_killed", count: 2 },
        { category: "trees_chopped", count: 2 }
      ]
    });
    await expect(pool.query(
      `INSERT INTO weekly_leaderboard_totals (
         week_start,player_id,category,value,reached_at
       ) VALUES (
         weekly_leaderboard_week_start(now()),'owner','trees_chopped',1,now()
       )`
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);
});

async function createPlayer(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id,username,username_normalized,region_code,lat,lon,
       anchor_lat,anchor_lon,move_leash_radius_m,online,geom
     ) VALUES (
       $1,'Owner','owner','US-NM',35,-106,35,-106,1250,false,
       ST_SetSRID(ST_MakePoint(-106,35),4326)
     )`,
    [id]
  );
}

async function insertHarvest(
  pool: pg.Pool,
  operationKey: string,
  resourceType: string,
  status: "active" | "completed" | "cancelled",
  completedExpression: string
): Promise<void> {
  const completedAt = status === "completed" ? completedExpression : "NULL";
  const cancelledAt = status === "cancelled" ? "now()" : "NULL";
  await pool.query(
    `INSERT INTO harvest_sessions (
       id,player_id,node_id,resource_type,operation_key,status,
       started_at,completes_at,expires_at,completed_at,cancelled_at
     ) VALUES (
       $1,'owner',$2,$3,$4,$5,now()-interval '3 minutes',
       now()-interval '2 minutes',now()+interval '1 hour',
       ${completedAt},${cancelledAt}
     )`,
    [randomUUID(), `node-${operationKey}`, resourceType, operationKey, status]
  );
}

async function insertSettlement(
  pool: pg.Pool,
  key: string,
  status: "pending" | "completed",
  completedExpression: string
): Promise<void> {
  await pool.query(
    `INSERT INTO combat_reward_settlements (
       settlement_key,defeated_mob_instance_id,mob_life_generation,
       mob_archetype,server_tick,status,candidate,reward_player_id,completed_at
     ) VALUES (
       $1,$1,1,'mysterious_traveler',1,$2,'{}'::jsonb,'owner',${completedExpression}
     )`,
    [key, status]
  );
}

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Leaderboard migration tests require a local stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

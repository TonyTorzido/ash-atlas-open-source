import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0816_dungeon_creator_expansion.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Dungeon Creator expansion populated migration", () => {
  const migrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_dungeon_creator_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const instanceId = "dungeon:creator-migration";
  const runId = randomUUID();
  const playerId = `dungeon-migration-${randomUUID()}`;
  const accountId = randomUUID();
  const sessionId = randomUUID();
  let precedingMigrations = "";
  let targetMigrations = "";
  let databaseUrl = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-dungeon-creator-pre-"));
    targetMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-dungeon-creator-target-"));
    const precedingNames: string[] = [];
    for (const name of (await readdir(migrations)).filter((value) => value.endsWith(".sql"))) {
      if (name.localeCompare(TARGET_MIGRATION) < 0) {
        precedingNames.push(name);
        await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
        await copyFile(path.join(migrations, name), path.join(targetMigrations, name));
      } else if (name === TARGET_MIGRATION) {
        await copyFile(path.join(migrations, name), path.join(targetMigrations, name));
      }
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const applied = await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    expect(applied).toHaveLength(precedingNames.length);
    expect(new Set(applied)).toEqual(new Set(precedingNames));
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedRetainedDungeonState(pool, { accountId, instanceId, playerId, runId, sessionId });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
    if (targetMigrations) await rm(targetMigrations, { recursive: true, force: true });
  });

  it("preserves populated dungeon/player/run/reward/presence rows and reruns empty", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetMigrations }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool!.query(
      `SELECT p.id AS player_id, r.instance_id, r.run_id,
              presence.space_id, claim.reward_table_id
       FROM players p
       JOIN dungeon_instance_runs r ON r.instance_id = $1 AND r.run_id = $2
       JOIN dungeon_presence presence ON presence.player_id = p.id
       JOIN dungeon_reward_claims claim ON claim.run_id = r.run_id AND claim.player_id = p.id
       WHERE p.id = $3`,
      [instanceId, runId, playerId]
    )).resolves.toMatchObject({ rows: [{
      player_id: playerId,
      instance_id: instanceId,
      run_id: runId,
      space_id: "room:entrance",
      reward_table_id: "starter-reward"
    }] });

    await pool!.query(
      `INSERT INTO dungeon_instance_state (
         instance_id, run_id, revision, object_states, object_availability,
         portal_locks, flags, trigger_states, encounter_states, completed, cues
       ) VALUES ($1,$2,3,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,false,$9::jsonb)`,
      [
        instanceId,
        runId,
        JSON.stringify({ chest: "looted" }),
        JSON.stringify({ chest: false }),
        JSON.stringify({ exit: true }),
        JSON.stringify({ "key-found": true }),
        JSON.stringify({ "entered-room": "complete" }),
        JSON.stringify({ encounter: "active" }),
        JSON.stringify(["resource_spawned"])
      ]
    );
    await pool!.query(
      `INSERT INTO dungeon_resource_states (
         instance_id, run_id, resource_id, room_id, resource_type, x, y,
         quantity, state, available_at, min_yield, max_yield,
         respawn_seconds, reset_on_run, life_revision
       ) VALUES ($1,$2,'resource:wood:1','room:entrance','wood',120,240,3,'available',NULL,1,3,90,true,2)`,
      [instanceId, runId]
    );

    await expect(pool!.query(
      `INSERT INTO dungeon_resource_states (
         instance_id, run_id, resource_id, room_id, resource_type, x, y,
         quantity, state, min_yield, max_yield
       ) VALUES ($1,$2,'resource:invalid','room:entrance','wood',120,240,3,'invalid',1,3)`,
      [instanceId, runId]
    )).rejects.toThrow();
    await expect(pool!.query(
      `INSERT INTO dungeon_resource_states (
         instance_id, run_id, resource_id, room_id, resource_type, x, y,
         quantity, state, min_yield, max_yield
       ) VALUES ($1,$2,'resource:negative','room:entrance','wood',120,240,-1,'available',1,3)`,
      [instanceId, runId]
    )).rejects.toThrow();

    await expect(pool!.query(
      `SELECT revision::int, object_states, completed
       FROM dungeon_instance_state WHERE instance_id = $1 AND run_id = $2`,
      [instanceId, runId]
    )).resolves.toMatchObject({ rows: [{
      revision: 3,
      object_states: { chest: "looted" },
      completed: false
    }] });
    await expect(pool!.query(
      `SELECT resource_id, quantity, state, min_yield, max_yield, respawn_seconds, life_revision::int
       FROM dungeon_resource_states WHERE instance_id = $1 AND run_id = $2`,
      [instanceId, runId]
    )).resolves.toMatchObject({ rows: [{
      resource_id: "resource:wood:1",
      quantity: 3,
      state: "available",
      min_yield: 1,
      max_yield: 3,
      respawn_seconds: 90,
      life_revision: 2
    }] });

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetMigrations }))
      .resolves.toEqual([]);
  }, 180_000);
});

async function seedRetainedDungeonState(
  pool: DisposableTestPool,
  values: { accountId: string; instanceId: string; playerId: string; runId: string; sessionId: string }
): Promise<void> {
  await pool.query(
    "INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')",
    [values.accountId]
  );
  await pool.query(
    `INSERT INTO players (
       id, account_id, username, username_normalized, display_color, region_code,
       lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
     ) VALUES ($1,$2,'dungeon-migration-player','dungeon-migration-player','#38bdf8','NM',
               35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
    [values.playerId, values.accountId]
  );
  await pool.query(
    `INSERT INTO dungeon_instance_runs (instance_id, run_id)
     VALUES ($1, $2)`,
    [values.instanceId, values.runId]
  );
  await pool.query(
    `INSERT INTO dungeon_presence (
       player_id, entrance_id, dungeon_id, instance_id, run_id, session_id,
       space_id, local_x, local_y, return_region_code, return_lat, return_lon
     ) VALUES ($1,'entrance:creator','creator-dungeon',$2,$3,$4,
               'room:entrance',120,240,'NM',35,-106)`,
    [values.playerId, values.instanceId, values.runId, values.sessionId]
  );
  await pool.query(
    `INSERT INTO dungeon_reward_claims (
       instance_id, run_id, player_id, reward_source_id, dungeon_id,
       reward_table_id, reward_revision
     ) VALUES ($1,$2,$3,'encounter:starter','creator-dungeon','starter-reward','v1')`,
    [values.instanceId, values.runId, values.playerId]
  );
}

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !["postgres:", "postgresql:"].includes(parsed.protocol)
    || parsed.port === "35432"
    || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(database)
  ) {
    throw new Error("Dungeon Creator migration test requires a local disposable ash_atlas_stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

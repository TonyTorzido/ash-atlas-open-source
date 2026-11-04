import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.XORAL_MIGRATION_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const PREVIOUS_MIGRATION = "0744_profession_and_attack_rings.sql";
const TARGET_MIGRATION = "0745_xoral_world_boss.sql";

describeDatabase("Xoral world boss populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_xoral_migration_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let migrationDirectory = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  const playerId = `xoral-migration-player-${suffix}`;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-xoral-migration-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name <= PREVIOUS_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(migrationDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    const accountId = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,$1,$1,'#38bdf8','GLOBAL',35,-106,35,-106,650,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [playerId, accountId]
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("preserves players, creates durable reward truth, and has an empty second run", async () => {
    await copyFile(
      path.join(migrations, TARGET_MIGRATION),
      path.join(migrationDirectory, TARGET_MIGRATION)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);
    await expect(pool.query("SELECT id FROM players WHERE id=$1", [playerId]))
      .resolves.toMatchObject({ rows: [{ id: playerId }] });

    const generationId = randomUUID();
    const event = await pool.query<{ event_id: string }>(
      `INSERT INTO xoral_events (
         source_tree_entity_id,population_zone_id,population_generation_id,
         owner_player_id,combat_entity_id,region_code,zone_id,lat,lon,
         status,locked_participant_ids
       ) VALUES ($1,$2,$3,$4,$5,'GLOBAL',$2,35,-106,'active',$6::jsonb)
       RETURNING event_id::text`,
      [
        `tree:${suffix}`,
        `zone:${suffix}`,
        generationId,
        playerId,
        `xoral:${suffix}`,
        JSON.stringify([playerId])
      ]
    );
    const eventId = event.rows[0]!.event_id;
    await pool.query(
      `INSERT INTO xoral_event_rewards (
         event_id,player_id,authoritative_damage,ring_definition_id,
         ring_delivery,xp_amount,class_xp_amount
       ) VALUES ($1,$2,1,'chopping_ring','ground',100,100)`,
      [eventId, playerId]
    );
    await pool.query(
      `INSERT INTO xoral_ring_drops (
         event_id,owner_player_id,ring_definition_id,region_code,zone_id,lat,lon
       ) VALUES ($1,$2,'chopping_ring','GLOBAL',$3,35,-106)`,
      [eventId, playerId, `zone:${suffix}`]
    );

    await expect(pool.query(
      `INSERT INTO xoral_event_rewards (
         event_id,player_id,authoritative_damage,ring_definition_id,
         ring_delivery,xp_amount,class_xp_amount
       ) VALUES ($1,$2,2,'attack_ring','inventory',100,100)`,
      [eventId, playerId]
    )).rejects.toMatchObject({ code: "23505" });
    await expect(pool.query(
      `INSERT INTO xoral_events (
         source_tree_entity_id,population_zone_id,population_generation_id,
         owner_player_id,combat_entity_id,region_code,zone_id,lat,lon
       ) VALUES ($1,$2,$3,$4,$5,'GLOBAL',$2,35,-106)`,
      [`tree:other:${suffix}`, `zone:${suffix}`, generationId, playerId, `xoral:other:${suffix}`]
    )).rejects.toMatchObject({ code: "23505" });
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([]);
  }, 120_000);
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = parsed.pathname.replace(/^\/+/, "");
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !database.startsWith("ash_atlas_stability")
  ) {
    throw new Error("Xoral migration tests require a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

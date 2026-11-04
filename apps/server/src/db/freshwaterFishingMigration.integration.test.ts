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
const TARGET_MIGRATION = "0824_fishing_control_intents.sql";

describeDatabase("Freshwater Fishing migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_fishing_migration_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const playerId = `fishing-migration-${randomUUID()}`;
  const operationKey = `fishing-migration:${playerId}`;
  const fishingHutId = randomUUID();
  const fishingEncounterId = randomUUID();
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: DisposableTestPool | undefined;
  let databaseCreated = false;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-fishing-migration-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedRepresentativeData(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (databaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    }
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  }, 30_000);

  it("upgrades populated prerequisite data, installs fishing, and reruns empty", async () => {
    const applied = await runMigrations(databaseUrl);
    expect(applied).toContain(TARGET_MIGRATION);

    await expect(pool!.query(
      `SELECT p.username,
              inventory.resource_type,
              inventory.quantity,
              inventory.version,
              event.delta_quantity,
              event.quantity_after,
              event.version_after
       FROM players p
       JOIN player_inventory inventory ON inventory.player_id = p.id
       JOIN inventory_events event
         ON event.player_id = p.id
        AND event.item_id = inventory.resource_type
        AND event.variant = inventory.variant
       WHERE p.id = $1
         AND event.operation_key = $2`,
      [playerId, operationKey]
    )).resolves.toMatchObject({
      rows: [{
        username: "Fishing migration fixture",
        resource_type: "wood",
        quantity: "17",
        version: "1",
        delta_quantity: "17",
        quantity_after: "17",
        version_after: "1"
      }]
    });

    await expect(pool!.query(
      `SELECT item_id, display_name, market_tradable
       FROM item_definitions
       WHERE item_id IN ('simple_food', 'freshwater_fish', 'ashen_fish')
       ORDER BY item_id`
    )).resolves.toMatchObject({
      rows: [
        { item_id: "ashen_fish", display_name: "Ashen Fish", market_tradable: true },
        { item_id: "freshwater_fish", display_name: "Freshwater Fish", market_tradable: true },
        { item_id: "simple_food", display_name: "Simple Food", market_tradable: true }
      ]
    });

    await expect(pool!.query(
      `SELECT to_regclass('public.fishing_hut_build_jobs') IS NOT NULL AS build_jobs,
              to_regclass('public.player_fishing_huts') IS NOT NULL AS huts,
              to_regclass('public.fishing_encounters') IS NOT NULL AS encounters,
              to_regclass('public.fishing_catch_records') IS NOT NULL AS records,
              to_regclass('public.fishing_operations') IS NOT NULL AS operations`
    )).resolves.toMatchObject({
      rows: [{
        build_jobs: true,
        huts: true,
        encounters: true,
        records: true,
        operations: true
      }]
    });

    await expect(pool!.query(
      `SELECT count(*) FILTER (WHERE column_name = 'cast_lat')::int AS cast_lat,
              count(*) FILTER (WHERE column_name = 'cast_lon')::int AS cast_lon,
              count(*) FILTER (WHERE column_name = 'control_direction')::int AS control_direction,
              count(*) FILTER (WHERE column_name = 'control_reeling')::int AS control_reeling
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'fishing_encounters'`
    )).resolves.toMatchObject({ rows: [{ cast_lat: 1, cast_lon: 1, control_direction: 1, control_reeling: 1 }] });

    await expect(pool!.query(
      `SELECT hut.fishing_hut_id, encounter.encounter_id, encounter.waterbody_source_id,
              encounter.cast_lat, encounter.cast_lon,
              encounter.control_direction, encounter.control_reeling
       FROM player_fishing_huts hut
       JOIN fishing_encounters encounter ON encounter.fishing_hut_id = hut.fishing_hut_id
       WHERE hut.fishing_hut_id = $1 AND encounter.encounter_id = $2`,
      [fishingHutId, fishingEncounterId]
    )).resolves.toMatchObject({
      rows: [{ fishing_hut_id: fishingHutId, encounter_id: fishingEncounterId, waterbody_source_id: "migration-river", cast_lat: null, cast_lon: null, control_direction: "neutral", control_reeling: false }]
    });

    await expect(pool!.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'kitchen_jobs'::regclass
         AND conname = 'kitchen_jobs_recipe_id_check'`
    )).resolves.toMatchObject({
      rows: [{ definition: expect.stringContaining("freshwater_fish") }]
    });

    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);

  async function seedRepresentativeData(queryable: DisposableTestPool): Promise<void> {
    const client = await queryable.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO players (
           id, username, username_normalized, display_color, region_code,
           lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
         ) VALUES ($1, 'Fishing migration fixture', 'fishing migration fixture', '#38bdf8',
                   'NM', 35, -106, 35, -106, 900, false,
                   ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
        [playerId]
      );
      await client.query(
        `INSERT INTO inventory_operations (operation_key, player_id, source, metadata)
         VALUES ($1, $2, 'freshwater_fishing_migration_fixture', '{}'::jsonb)`,
        [operationKey, playerId]
      );
      await client.query(
        `INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
         VALUES ($1, 'wood', 'default', 17, 1)`,
        [playerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key, player_id, item_id, variant, delta_quantity,
           quantity_after, version_after, source, metadata
         ) VALUES ($1, $2, 'wood', 'default', 17, 17, 1,
                   'freshwater_fishing_migration_fixture', '{}'::jsonb)`,
        [operationKey, playerId]
      );
      await client.query(
        `INSERT INTO player_fishing_huts (
           fishing_hut_id, owner_player_id, world_id, region_code, lat, lon, geom,
           waterbody_kind, waterbody_source_id, waterbody_name, waterbody_distance_m,
           world_source_revision, built_at
         ) VALUES ($1, $2, 'migration-world', 'world_v1_lat35_lon-106', 35, -106,
                   ST_SetSRID(ST_MakePoint(-106, 35), 4326), 'river', 'migration-river',
                   'Migration River', 125, 'migration-r1', clock_timestamp())`,
        [fishingHutId, playerId]
      );
      await client.query(
        `INSERT INTO fishing_encounters (
           encounter_id, player_id, fishing_hut_id, waterbody_kind, waterbody_source_id,
           waterbody_name, phase, behavior_profile, seed, difficulty, bite_at,
           reconnect_deadline_at
         ) VALUES ($1, $2, $3, 'river', 'migration-river', 'Migration River', 'cast',
                   'runner', 17, .35, clock_timestamp() + interval '1 hour',
                   clock_timestamp() + interval '1 hour')`,
        [fishingEncounterId, playerId, fishingHutId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !database.startsWith("ash_atlas_stability")
  ) {
    throw new Error("Freshwater Fishing migration test requires a local stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

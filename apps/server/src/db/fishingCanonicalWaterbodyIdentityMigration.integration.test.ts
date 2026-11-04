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
const TARGET_MIGRATION = "0826_fishing_canonical_waterbody_identity.sql";
const LEGACY_RIVER_ID = "e2535b48a911bc1795c2f22cfaa290dc12978933964b815a609979d1d1321274";
const CANONICAL_RIVER_ID = "4bdb931c-d880-5cb0-b8b2-e9c8c220e83a";

describeDatabase("canonical fishing waterbody identity migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_canonical_waterbody_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const playerId = `canonical-waterbody-migration-${randomUUID()}`;
  const lakePlayerId = `canonical-waterbody-lake-${randomUUID()}`;
  const fishingHutId = randomUUID();
  const lakeHutId = randomUUID();
  const buildId = randomUUID();
  const activeEncounterId = randomUUID();
  const landedEncounterId = randomUUID();
  const escapedEncounterId = randomUUID();
  const catchId = randomUUID();
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: DisposableTestPool | undefined;
  let databaseCreated = false;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-canonical-waterbody-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedRepresentativeData();
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

  it("migrates every persisted river binding while preserving state and reruns empty", async () => {
    const targetRows = [
      ["fishing_hut_build_jobs", "build_id", buildId],
      ["player_fishing_huts", "fishing_hut_id", fishingHutId],
      ["fishing_encounters", "encounter_id", activeEncounterId],
      ["fishing_encounters", "encounter_id", landedEncounterId],
      ["fishing_encounters", "encounter_id", escapedEncounterId],
      ["fishing_catch_records", "catch_id", catchId]
    ] as const;
    const before = await Promise.all(targetRows.map(([table, key, id]) => snapshot(table, key, id)));
    const lakeBefore = await snapshot("player_fishing_huts", "fishing_hut_id", lakeHutId);

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);

    const after = await Promise.all(targetRows.map(([table, key, id]) => snapshot(table, key, id)));
    for (const [index, row] of after.entries()) {
      expect(row.sourceId).toBe(CANONICAL_RIVER_ID);
      expect(row.rest).toEqual(before[index]!.rest);
    }
    expect((await snapshot("player_fishing_huts", "fishing_hut_id", lakeHutId)).sourceId)
      .toBe(LEGACY_RIVER_ID);
    expect((await snapshot("player_fishing_huts", "fishing_hut_id", lakeHutId)).rest)
      .toEqual(lakeBefore.rest);

    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
    const rerun = await Promise.all(targetRows.map(([table, key, id]) => snapshot(table, key, id)));
    expect(rerun).toEqual(after);
  }, 120_000);

  async function seedRepresentativeData(): Promise<void> {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO players (
           id, username, username_normalized, display_color, region_code,
           lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
         ) VALUES
           ($1, 'Canonical migration fixture', 'canonical migration fixture', '#38bdf8',
            'world_v1_lat32_lon-107', 32.3199, -106.7637, 32.3199, -106.7637,
            2000, false, ST_SetSRID(ST_MakePoint(-106.7637, 32.3199), 4326)),
           ($2, 'Canonical lake guard fixture', 'canonical lake guard fixture', '#f59e0b',
            'world_v1_lat32_lon-107', 32.3199, -106.7637, 32.3199, -106.7637,
            2000, false, ST_SetSRID(ST_MakePoint(-106.7637, 32.3199), 4326))`,
        [playerId, lakePlayerId]
      );
      await client.query(
        `INSERT INTO player_fishing_huts (
           fishing_hut_id, owner_player_id, world_id, region_code, lat, lon, geom,
           waterbody_kind, waterbody_source_id, waterbody_name, waterbody_distance_m,
           world_source_revision, placement_revision, built_at, removed_at, removal_reason,
           passive_last_produced_at, passive_stored_quantity, created_at, updated_at
         ) VALUES
           ($1, $3, 'migration-world', 'world_v1_lat32_lon-107', 32.3199, -106.7637,
            ST_SetSRID(ST_MakePoint(-106.7637, 32.3199), 4326), 'river', $4,
            'Unnamed River', 78, 'migration-rio-r1', 3, '2026-09-12T10:00:00Z', NULL, NULL,
            '2026-09-12T10:00:00Z', 4, '2026-09-12T10:00:00Z', '2026-09-12T10:00:00Z'),
           ($2, $5, 'migration-world', 'world_v1_lat32_lon-107', 32.3199, -106.7637,
            ST_SetSRID(ST_MakePoint(-106.7637, 32.3199), 4326), 'lake', $4,
            'Guard Lake', 90, 'migration-lake-r1', 1, '2026-09-12T10:00:00Z',
            '2026-09-12T11:00:00Z', 'guard fixture', '2026-09-12T10:00:00Z', 2,
            '2026-09-12T10:00:00Z', '2026-09-12T10:00:00Z')`,
        [fishingHutId, lakeHutId, playerId, LEGACY_RIVER_ID, lakePlayerId]
      );
      await client.query(
        `INSERT INTO fishing_hut_build_jobs (
           build_id, owner_player_id, request_id, request_hash, world_id, region_code,
           lat, lon, geom, waterbody_kind, waterbody_source_id, waterbody_name,
           waterbody_distance_m, world_source_revision, status, started_at, completes_at,
           fishing_hut_id, created_at, updated_at
         ) VALUES ($1, $2, 'canonical-migration-build', $3, 'migration-world',
           'world_v1_lat32_lon-107', 32.3199, -106.7637,
           ST_SetSRID(ST_MakePoint(-106.7637, 32.3199), 4326), 'river', $4,
           'Unnamed River', 78, 'migration-rio-r1', 'completed', '2026-09-12T09:00:00Z',
           '2026-09-12T10:00:00Z', $5, '2026-09-12T10:00:00Z', '2026-09-12T10:00:00Z')`,
        [buildId, playerId, "a".repeat(64), LEGACY_RIVER_ID, fishingHutId]
      );
      await client.query(
        `INSERT INTO fishing_encounters (
           encounter_id, player_id, fishing_hut_id, waterbody_kind, waterbody_source_id,
           waterbody_name, phase, behavior_profile, seed, difficulty, ashen, cast_quality,
           length_in, weight_lb, size_percentile, score, perfect, tension, distance, stamina,
           slack_ms, critical_ms, fish_direction, fish_pull, execution_quality, started_at,
           bite_at, hooked_at, last_action_at, reconnect_deadline_at, completed_at,
           result_quantity, cast_lat, cast_lon, control_direction, control_reeling,
           created_at, updated_at
         ) VALUES
           ($1, $2, $3, 'river', $4, 'Unnamed River', 'fighting', 'runner', 101, .42, false,
            .75, 28, 9.5, .85, 860, true, 63, 42, 77, 120, 45, 'right', 1.4, .61,
            '2026-09-12T10:01:00Z', '2026-09-12T10:02:00Z', '2026-09-12T10:02:01Z',
            '2026-09-12T10:02:05Z', '2026-09-12T11:02:05Z', NULL, 0, 32.3199,
            -106.7637, 'right', true, '2026-09-12T10:01:00Z', '2026-09-12T10:02:05Z'),
           ($5, $2, $3, 'river', $4, 'Unnamed River', 'landed', 'tank', 202, .68, true,
            .9, 31, 12.25, .95, 940, false, 28, 8, 12, 0, 0, 'left', .8, .88,
            '2026-09-12T08:00:00Z', '2026-09-12T08:02:00Z', '2026-09-12T08:02:01Z',
            '2026-09-12T08:02:04Z', '2026-09-12T09:02:04Z', '2026-09-12T08:03:00Z', 1,
            32.3199, -106.7637, 'neutral', false, '2026-09-12T08:00:00Z',
            '2026-09-12T08:03:00Z'),
           ($6, $2, $3, 'river', $4, 'Unnamed River', 'escaped', 'feinter', 303, .51, false,
            .35, NULL, NULL, NULL, NULL, false, 91, 96, 0, 800, 200, 'neutral', 1.1, .1,
            '2026-09-12T07:00:00Z', '2026-09-12T07:02:00Z', '2026-09-12T07:02:01Z',
            '2026-09-12T07:02:04Z', '2026-09-12T08:02:04Z', '2026-09-12T07:03:00Z', 0,
            32.3199, -106.7637, 'neutral', false, '2026-09-12T07:00:00Z',
            '2026-09-12T07:03:00Z')`,
        [activeEncounterId, playerId, fishingHutId, LEGACY_RIVER_ID, landedEncounterId, escapedEncounterId]
      );
      await client.query(
        `INSERT INTO fishing_catch_records (
           catch_id, encounter_id, player_id, fishing_hut_id, waterbody_kind,
           waterbody_source_id, waterbody_name, fish_item_id, ashen, behavior_profile,
           difficulty, world_source_revision, environment_schema_version, length_in,
           weight_lb, score, perfect, duration_ms, week_start, created_at
         ) VALUES ($1, $2, $3, $4, 'river', $5, 'Unnamed River', 'freshwater_fish', true,
           'tank', .68, 'migration-rio-r1', 'gameplay-environment-v1', 31, 12.25, 940,
           false, 180000, '2026-09-07', '2026-09-12T08:03:00Z')`,
        [catchId, landedEncounterId, playerId, fishingHutId, LEGACY_RIVER_ID]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function snapshot(
    table: "fishing_hut_build_jobs" | "player_fishing_huts" | "fishing_encounters" | "fishing_catch_records",
    keyColumn: "build_id" | "fishing_hut_id" | "encounter_id" | "catch_id",
    key: string
  ): Promise<{ sourceId: string; rest: unknown }> {
    const result = await pool!.query<{ waterbody_source_id: string; rest: unknown }>(
      `SELECT t.waterbody_source_id,
              to_jsonb(t) - ARRAY[
                'waterbody_source_id',
                'rod_id',
                'waterbody_source_revision',
                'waterbody_candidates',
                'origin_lat',
                'origin_lon',
                'region_name',
                'country_name',
                'cast_range_m',
                'matching_specialization',
                'fish_species',
                'percentile',
                'source',
                'cast_lat',
                'cast_lon'
              ]::text[] AS rest
       FROM ${table} AS t WHERE t.${keyColumn} = $1`,
      [key]
    );
    expect(result.rows).toHaveLength(1);
    return { sourceId: result.rows[0]!.waterbody_source_id, rest: result.rows[0]!.rest };
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
    throw new Error("Canonical waterbody migration test requires a local stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

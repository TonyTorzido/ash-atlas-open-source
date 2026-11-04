import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0942_flags_restore_safe_schema.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

/**
 * pg_restore loads rows with an empty search_path and no user triggers, while
 * CHECK constraints and generated columns are already in place. Each probe
 * copies a table's rows into a trigger-free temporary twin carrying the same
 * CHECK constraints and generated columns, under that same empty search_path.
 */
describeDatabase("flags restore-safe schema migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_flags_restore_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const flagId = randomUUID();
  let databaseUrl = "";
  let preceding = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = disposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-0942-"));
    for (const name of (await readdir(sourceMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)) {
      await copyFile(path.join(sourceMigrations, name), path.join(preceding, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedFlagWithDependent();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  }, 30_000);

  it("makes flags rows loadable under an empty search_path without changing health, and reruns empty", async () => {
    await expect(probeRestoreLoad("public", "flags"))
      .rejects.toThrow(/function flag_warfare_maximum_health\(.*\) does not exist/u);

    await expect(runMigrations(databaseUrl)).resolves.toEqual([TARGET_MIGRATION]);

    for (const relation of await functionCheckedRelations()) {
      await expect(probeRestoreLoad(relation.schema, relation.table), `${relation.schema}.${relation.table}`)
        .resolves.toBeGreaterThanOrEqual(0);
    }
    await expect(probeRestoreLoad("public", "flags")).resolves.toBe(1);

    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = ''");
      const profiles = await client.query<{ six: number; nine: number; war_tower: number }>(
        `SELECT public.flag_warfare_maximum_health(
                  'flag', 'personal', false, NULL::uuid, NULL::uuid, 1::smallint
                ) AS six,
                public.flag_warfare_maximum_health(
                  'flag', 'kingdom', false, NULL::uuid, gen_random_uuid(), 0::smallint,
                  NULL::smallint, 3::smallint, NULL::text
                ) AS nine,
                public.flag_warfare_maximum_health(
                  'flag', 'kingdom', false, NULL::uuid, gen_random_uuid(), 0::smallint,
                  1::smallint, NULL::smallint, 'war_tower'
                ) AS war_tower`
      );
      expect(profiles.rows).toEqual([{ six: 200, nine: 6000, war_tower: 10000 }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    await expect(pool!.query(
      `SELECT f.health, f.maximum_health, c.request_id
         FROM flags f JOIN flag_travel_commands c ON c.flag_id = f.id
        WHERE f.id = $1`,
      [flagId]
    )).resolves.toMatchObject({ rows: [{ health: 100, maximum_health: 100, request_id: "restore-probe-1" }] });
    await expect(pool!.query(
      "UPDATE flags SET reinforcement_level = 1 WHERE id = $1 RETURNING health, maximum_health",
      [flagId]
    )).resolves.toMatchObject({ rows: [{ health: 100, maximum_health: 200 }] });

    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);

  async function seedFlagWithDependent(): Promise<void> {
    await pool!.query(
      `INSERT INTO players (
         id, username, lat, lon, anchor_lat, anchor_lon, geom, personal_flag_color,
         onboarding_completed_at, initial_spawn_latitude, initial_spawn_longitude,
         initial_spawn_algorithm_version, initial_spawn_land_mask_version,
         initial_spawn_world_identity, initial_spawn_rejected_candidates, initial_spawn_assigned_at
       )
       SELECT id, id, 35.08, -106.65, 35.08, -106.65, ST_SetSRID(ST_MakePoint(-106.65, 35.08), 4326),
              'blue', now(), 35.08, -106.65, 'v1', 'mask', 'world', 0, now()
         FROM unnest(ARRAY['restore-probe-owner', 'restore-probe-traveler']) AS id`
    );
    await pool!.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, geom)
       VALUES ($1, 'restore-probe-owner', 'Restore Probe', 35.08, -106.65,
               ST_SetSRID(ST_MakePoint(-106.65, 35.08), 4326))`,
      [flagId]
    );
    await pool!.query(
      `INSERT INTO flag_travel_commands (
         traveler_player_id, request_id, flag_id, owner_player_id, access_mode, toll_gold
       ) VALUES ('restore-probe-traveler', 'restore-probe-1', $1, 'restore-probe-owner', 'normal', 0)`,
      [flagId]
    );
  }

  /** Tables whose CHECK constraints or generated columns call a non-extension user function. */
  async function functionCheckedRelations(): Promise<Array<{ schema: string; table: string }>> {
    const result = await pool!.query<{ schema: string; table: string }>(
      `WITH user_functions AS (
         SELECT p.oid
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND NOT EXISTS (
              SELECT 1 FROM pg_depend e
               WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e'
            )
       ), relations AS (
         SELECT c.conrelid AS relid
           FROM pg_constraint c
           JOIN pg_depend d ON d.classid = 'pg_constraint'::regclass AND d.objid = c.oid
          WHERE c.contype = 'c' AND d.refclassid = 'pg_proc'::regclass
            AND d.refobjid IN (SELECT oid FROM user_functions)
         UNION
         SELECT ad.adrelid
           FROM pg_attrdef ad
           JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum AND a.attgenerated = 's'
           JOIN pg_depend d ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid
          WHERE d.refclassid = 'pg_proc'::regclass
            AND d.refobjid IN (SELECT oid FROM user_functions)
       )
       SELECT n.nspname AS schema, r.relname AS table
         FROM relations
         JOIN pg_class r ON r.oid = relations.relid
         JOIN pg_namespace n ON n.oid = r.relnamespace
        ORDER BY 1, 2`
    );
    expect(result.rows).toContainEqual({ schema: "public", table: "flags" });
    return result.rows;
  }

  /** Loads every row of the table into a trigger-free twin under an empty search_path; returns the row count. */
  async function probeRestoreLoad(schema: string, table: string): Promise<number> {
    const client = await pool!.connect();
    try {
      const columns = await client.query<{ name: string }>(
        `SELECT a.attname AS name
           FROM pg_attribute a
          WHERE a.attrelid = format('%I.%I', $1::text, $2::text)::regclass
            AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
          ORDER BY a.attnum`,
        [schema, table]
      );
      const columnList = columns.rows.map((column) => quoteIdentifier(column.name)).join(", ");
      const source = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = ''");
      await client.query(
        `CREATE TEMP TABLE restore_probe (LIKE ${source} INCLUDING CONSTRAINTS INCLUDING GENERATED) ON COMMIT DROP`
      );
      const loaded = await client.query(
        `INSERT INTO pg_temp.restore_probe (${columnList}) SELECT ${columnList} FROM ${source}`
      );
      return loaded.rowCount ?? 0;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
});

function disposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Flags restore-safe schema migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "0795_goblin_village_population_override.sql";

describeDatabase("Goblin Village Population V2 override migration", () => {
  const databaseName = `ash_atlas_stability_goblin_override_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-goblin-override-"));
    await writeFile(path.join(migrationsDirectory, "0001_fixture.sql"), fixture, "utf8");
    await runMigrations(databaseUrl, { migrationsDirectory });
    await copyFile(
      fileURLToPath(new URL(`../../../../db/migrations/${migration}`, import.meta.url)),
      path.join(migrationsDirectory, migration)
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("preserves populated rows, suppresses future zone projections, and has an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([migration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);

    await pool.query(
      `INSERT INTO goblin_village_population_overrides (city_id,zone_id)
       VALUES ('11111111-1111-4111-8111-111111111111','ppz2-eag1/test/zone')`
    );
    await pool.query(
      `UPDATE generated_world_mobs SET population_flag_suppressed=false
       WHERE entity_id='retained-mob'`
    );
    await pool.query(
      `INSERT INTO generated_world_mobs (
         entity_id,physical_population_zone_v2_id,population_flag_suppressed
       ) VALUES ('future-mob','ppz2-eag1/test/zone',false),
                ('outside-mob','ppz2-eag1/other/zone',true)`
    );

    await expect(pool.query(
      `SELECT entity_id,population_flag_suppressed
       FROM generated_world_mobs ORDER BY entity_id`
    )).resolves.toMatchObject({ rows: [
      { entity_id: "future-mob", population_flag_suppressed: true },
      { entity_id: "outside-mob", population_flag_suppressed: false },
      { entity_id: "retained-mob", population_flag_suppressed: true }
    ] });
    await expect(pool.query("SELECT id FROM players WHERE id='retained-player'"))
      .resolves.toMatchObject({ rowCount: 1 });
  }, 30_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
    throw new Error("Goblin override migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe disposable database name");
  return `"${value}"`;
}

const fixture = `
CREATE TABLE players (id text PRIMARY KEY);
CREATE TABLE cities (id uuid PRIMARY KEY);
CREATE TABLE generated_world_mobs (
  entity_id text PRIMARY KEY,
  physical_population_zone_v2_id text NULL,
  population_flag_suppressed boolean NOT NULL DEFAULT false
);
INSERT INTO players (id) VALUES ('retained-player');
INSERT INTO cities (id) VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO generated_world_mobs (
  entity_id,physical_population_zone_v2_id,population_flag_suppressed
) VALUES ('retained-mob','ppz2-eag1/test/zone',false);
`;

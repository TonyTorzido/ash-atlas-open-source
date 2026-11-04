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
const migration = "0785_equipped_class_technique.sql";

describeDatabase("class technique loadout forward migration", () => {
  const databaseName = `ash_atlas_stability_class_technique_${randomUUID().replaceAll("-", "")}`;
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
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-class-technique-"));
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

  it("preserves specialization state, accepts only registered techniques, and has an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([migration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);

    await expect(pool.query(
      `SELECT player_id, committed_specialization_id, active_specialization_id,
              equipped_class_technique_id, revision
       FROM player_specialization_state`
    )).resolves.toMatchObject({ rows: [{
      player_id: "retained-player",
      committed_specialization_id: "ranger",
      active_specialization_id: "ranger",
      equipped_class_technique_id: null,
      revision: "7"
    }] });
    await expect(pool.query(
      `UPDATE player_specialization_state
       SET equipped_class_technique_id = 'v3_ranger_double_tap'
       WHERE player_id = 'retained-player'`
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      `UPDATE player_specialization_state
       SET equipped_class_technique_id = 'forged_technique'
       WHERE player_id = 'retained-player'`
    )).rejects.toThrow();
  }, 30_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
    throw new Error("Class technique migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe disposable database name");
  return `"${value}"`;
}

const fixture = `
CREATE TABLE players (id text PRIMARY KEY);
CREATE TABLE player_specialization_state (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  committed_specialization_id text NULL,
  active_specialization_id text NULL,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO players (id) VALUES ('retained-player');
INSERT INTO player_specialization_state (
  player_id, committed_specialization_id, active_specialization_id, revision
) VALUES ('retained-player', 'ranger', 'ranger', 7);
`;

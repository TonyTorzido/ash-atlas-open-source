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
const migration = "0780_single_specialization_commitment.sql";

describeDatabase("single specialization commitment forward migration", () => {
  const databaseName = `ash_atlas_stability_spec_commit_${randomUUID().replaceAll("-", "")}`;
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
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-spec-commit-"));
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

  it("backfills only active or unambiguous positive choices and preserves every rank", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([migration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);

    await expect(pool.query(
      `SELECT player_id, committed_specialization_id, active_specialization_id
       FROM player_specialization_state ORDER BY player_id`
    )).resolves.toMatchObject({ rows: [
      { player_id: "active", committed_specialization_id: "paladin", active_specialization_id: "paladin" },
      { player_id: "ambiguous", committed_specialization_id: null, active_specialization_id: null },
      { player_id: "mixed", committed_specialization_id: null, active_specialization_id: null },
      { player_id: "paid", committed_specialization_id: "knight", active_specialization_id: null },
      { player_id: "single", committed_specialization_id: "ranger", active_specialization_id: null },
      { player_id: "zero", committed_specialization_id: null, active_specialization_id: null }
    ] });
    await expect(pool.query(
      `SELECT player_id, specialization_id, rank, points_spent, grandfathered
       FROM player_specialization_ranks ORDER BY player_id, specialization_id`
    )).resolves.toMatchObject({ rows: [
      { player_id: "active", specialization_id: "paladin", rank: 0, points_spent: 0, grandfathered: true },
      { player_id: "active", specialization_id: "warrior", rank: 4, points_spent: 0, grandfathered: true },
      { player_id: "ambiguous", specialization_id: "knight", rank: 1, points_spent: 0, grandfathered: true },
      { player_id: "ambiguous", specialization_id: "warrior", rank: 2, points_spent: 0, grandfathered: true },
      { player_id: "mixed", specialization_id: "knight", rank: 1, points_spent: 1, grandfathered: false },
      { player_id: "mixed", specialization_id: "warrior", rank: 2, points_spent: 0, grandfathered: true },
      { player_id: "paid", specialization_id: "knight", rank: 5, points_spent: 5, grandfathered: false },
      { player_id: "single", specialization_id: "ranger", rank: 3, points_spent: 0, grandfathered: true },
      { player_id: "zero", specialization_id: "cleric", rank: 0, points_spent: 0, grandfathered: true }
    ] });
    await expect(pool.query(
      `UPDATE player_specialization_state SET active_specialization_id='warrior' WHERE player_id='active'`
    )).rejects.toThrow();
    await expect(pool.query(
      `UPDATE player_specialization_state SET active_specialization_id='warrior' WHERE player_id='ambiguous'`
    )).rejects.toThrow();
  }, 30_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
    throw new Error("Commitment migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe disposable database name");
  return `"${value}"`;
}

const fixture = `
CREATE TABLE players (id text PRIMARY KEY);
CREATE TABLE player_specialization_ranks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  specialization_id text NOT NULL,
  rank smallint NOT NULL,
  points_spent integer NOT NULL,
  grandfathered boolean NOT NULL,
  PRIMARY KEY (player_id, specialization_id)
);
CREATE TABLE player_specialization_state (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  active_specialization_id text NULL,
  revision bigint NOT NULL DEFAULT 0,
  FOREIGN KEY (player_id, active_specialization_id)
    REFERENCES player_specialization_ranks(player_id, specialization_id) ON DELETE RESTRICT
);
INSERT INTO players (id) VALUES ('active'),('ambiguous'),('mixed'),('paid'),('single'),('zero');
INSERT INTO player_specialization_ranks (player_id,specialization_id,rank,points_spent,grandfathered) VALUES
  ('active','paladin',0,0,true),('active','warrior',4,0,true),
  ('ambiguous','knight',1,0,true),('ambiguous','warrior',2,0,true),
  ('mixed','knight',1,1,false),('mixed','warrior',2,0,true),
  ('paid','knight',5,5,false),
  ('single','ranger',3,0,true),('zero','cleric',0,0,true);
INSERT INTO player_specialization_state (player_id,active_specialization_id) VALUES
  ('active','paladin'),('ambiguous',NULL),('mixed',NULL),('paid',NULL),('single',NULL),('zero',NULL);
`;

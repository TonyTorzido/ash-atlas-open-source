import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "0782_skill_point_launch_entitlement.sql";

describeDatabase("Skill Point launch entitlement migration", () => {
  const databaseName = `ash_atlas_stability_skill_points_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool, pool: pg.Pool, databaseUrl = "", migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
      throw new Error("Migration test requires a local disposable ash_atlas_stability database");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-skill-points-"));
    await writeFile(path.join(migrationsDirectory, "0001_fixture.sql"), fixture, "utf8");
    await runMigrations(databaseUrl, { migrationsDirectory });
    await copyFile(fileURLToPath(new URL(`../../../../db/migrations/${migration}`, import.meta.url)), path.join(migrationsDirectory, migration));
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("reconciles populated balances, preserves overspending, and has an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([migration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(pool.query(`SELECT player_id,total_earned,total_spent,total_earned-total_spent AS available,revision FROM player_skill_point_state ORDER BY player_id`))
      .resolves.toMatchObject({ rows: [
        { player_id: "level-25", total_earned: 25, total_spent: 10, available: 15, revision: "1" },
        { player_id: "over-budget", total_earned: 30, total_spent: 30, available: 0, revision: "1" }
      ] });
    await expect(pool.query(`SELECT skill_id,rank,points_spent FROM player_skill_ranks WHERE player_id='over-budget'`))
      .resolves.toMatchObject({ rows: [{ skill_id: "retained", rank: 3, points_spent: 20 }] });
    await expect(pool.query(`SELECT player_id,committed_specialization_id,active_specialization_id,revision FROM player_specialization_state ORDER BY player_id`))
      .resolves.toMatchObject({ rows: [
        { player_id: "level-25", committed_specialization_id: "warrior", active_specialization_id: "warrior", revision: "0" },
        { player_id: "over-budget", committed_specialization_id: "assassin", active_specialization_id: null, revision: "1" }
      ] });
    await expect(pool.query(`SELECT specialization_id,points_spent FROM player_specialization_ranks WHERE player_id='over-budget'`))
      .resolves.toMatchObject({ rows: [{ specialization_id: "assassin", points_spent: 10 }] });
  }, 30_000);
});

const fixture = `
CREATE TABLE player_progression_profiles (player_id text PRIMARY KEY, level integer NOT NULL);
CREATE TABLE player_skill_point_state (player_id text PRIMARY KEY, total_earned smallint NOT NULL CHECK (total_earned BETWEEN 0 AND 50), total_spent smallint NOT NULL CHECK (total_spent BETWEEN 0 AND total_earned), revision bigint NOT NULL DEFAULT 0);
CREATE TABLE player_skill_ranks (player_id text NOT NULL, skill_id text NOT NULL, rank smallint NOT NULL, points_spent smallint NOT NULL, PRIMARY KEY(player_id,skill_id));
CREATE TABLE player_specialization_ranks (player_id text NOT NULL, specialization_id text NOT NULL, points_spent smallint NOT NULL, PRIMARY KEY(player_id,specialization_id));
CREATE TABLE player_specialization_state (player_id text PRIMARY KEY, committed_specialization_id text, active_specialization_id text, revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO player_progression_profiles VALUES ('level-25',25),('over-budget',10);
INSERT INTO player_skill_point_state VALUES ('level-25',50,10,0),('over-budget',50,30,0);
INSERT INTO player_skill_ranks VALUES ('level-25','retained',3,7),('over-budget','retained',3,20);
INSERT INTO player_specialization_ranks VALUES ('level-25','warrior',3),('over-budget','assassin',10);
INSERT INTO player_specialization_state (player_id,committed_specialization_id,active_specialization_id) VALUES ('level-25','warrior','warrior'),('over-budget','assassin','assassin');
`;

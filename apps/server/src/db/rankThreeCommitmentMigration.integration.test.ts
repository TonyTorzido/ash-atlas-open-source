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
const migration = "0783_rank_three_specialization_commitment.sql";

describeDatabase("Rank 3 specialization commitment migration", () => {
  const databaseName = `ash_atlas_stability_rank_three_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
    ) {
      throw new Error("Migration test requires a local disposable ash_atlas_stability database");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-rank-three-"));
    await writeFile(path.join(migrationsDirectory, "0001_fixture.sql"), fixture, "utf8");
    await runMigrations(databaseUrl, { migrationsDirectory });
    await copyFile(
      fileURLToPath(new URL(`../../../../db/migrations/${migration}`, import.meta.url)),
      path.join(migrationsDirectory, migration)
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("reconciles populated commitments deterministically, retains ranks, and has an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([migration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);

    await expect(pool.query(
      `SELECT player_id, committed_specialization_id, active_specialization_id
       FROM player_specialization_state ORDER BY player_id`
    )).resolves.toMatchObject({ rows: [
      { player_id: "active-choice", committed_specialization_id: "ranger", active_specialization_id: "ranger" },
      { player_id: "deterministic", committed_specialization_id: "ninja", active_specialization_id: null },
      { player_id: "multi-existing", committed_specialization_id: "ranger", active_specialization_id: null },
      { player_id: "old-rank-1", committed_specialization_id: null, active_specialization_id: "warrior" },
      { player_id: "old-rank-2", committed_specialization_id: null, active_specialization_id: "warrior" },
      { player_id: "old-rank-3", committed_specialization_id: "warrior", active_specialization_id: null }
    ] });

    await expect(pool.query(
      `SELECT player_id, specialization_id, rank FROM player_specialization_ranks
       ORDER BY player_id, specialization_id`
    )).resolves.toMatchObject({ rows: [
      { player_id: "active-choice", specialization_id: "ranger", rank: 3 },
      { player_id: "active-choice", specialization_id: "warrior", rank: 2 },
      { player_id: "deterministic", specialization_id: "ninja", rank: 5 },
      { player_id: "deterministic", specialization_id: "paladin", rank: 5 },
      { player_id: "deterministic", specialization_id: "warrior", rank: 3 },
      { player_id: "multi-existing", specialization_id: "ranger", rank: 3 },
      { player_id: "multi-existing", specialization_id: "warrior", rank: 5 },
      { player_id: "old-rank-1", specialization_id: "warrior", rank: 1 },
      { player_id: "old-rank-2", specialization_id: "warrior", rank: 2 },
      { player_id: "old-rank-3", specialization_id: "warrior", rank: 3 }
    ] });

    await expect(pool.query(
      `SELECT player_id, previous_committed_specialization_id,
              resulting_committed_specialization_id, resulting_active_specialization_id, reason
       FROM specialization_commitment_reconciliation_audit ORDER BY player_id`
    )).resolves.toMatchObject({ rows: [
      {
        player_id: "active-choice",
        previous_committed_specialization_id: "warrior",
        resulting_committed_specialization_id: "ranger",
        resulting_active_specialization_id: "ranger",
        reason: "preferred_active_rank_three"
      },
      {
        player_id: "deterministic",
        previous_committed_specialization_id: null,
        resulting_committed_specialization_id: "ninja",
        resulting_active_specialization_id: null,
        reason: "selected_highest_rank_three"
      },
      {
        player_id: "multi-existing",
        previous_committed_specialization_id: "ranger",
        resulting_committed_specialization_id: "ranger",
        resulting_active_specialization_id: null,
        reason: "preserved_rank_three_commitment"
      },
      {
        player_id: "old-rank-1",
        previous_committed_specialization_id: "warrior",
        resulting_committed_specialization_id: null,
        resulting_active_specialization_id: "warrior",
        reason: "cleared_without_rank_three"
      },
      {
        player_id: "old-rank-2",
        previous_committed_specialization_id: "warrior",
        resulting_committed_specialization_id: null,
        resulting_active_specialization_id: "warrior",
        reason: "cleared_without_rank_three"
      }
    ] });
  }, 30_000);
});

const fixture = `
CREATE TABLE players (id text PRIMARY KEY);
CREATE TABLE player_specialization_ranks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  specialization_id text NOT NULL,
  rank smallint NOT NULL,
  PRIMARY KEY (player_id, specialization_id)
);
CREATE TABLE player_specialization_state (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  committed_specialization_id text NULL,
  active_specialization_id text NULL,
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO players (id) VALUES
  ('old-rank-1'),('old-rank-2'),('old-rank-3'),
  ('multi-existing'),('active-choice'),('deterministic');
INSERT INTO player_specialization_ranks (player_id,specialization_id,rank) VALUES
  ('old-rank-1','warrior',1),
  ('old-rank-2','warrior',2),
  ('old-rank-3','warrior',3),
  ('multi-existing','ranger',3),('multi-existing','warrior',5),
  ('active-choice','warrior',2),('active-choice','ranger',3),
  ('deterministic','warrior',3),('deterministic','ninja',5),('deterministic','paladin',5);
INSERT INTO player_specialization_state (
  player_id,committed_specialization_id,active_specialization_id
) VALUES
  ('old-rank-1','warrior','warrior'),
  ('old-rank-2','warrior','warrior'),
  ('old-rank-3','warrior',NULL),
  ('multi-existing','ranger','ranger'),
  ('active-choice','warrior','warrior'),
  ('deterministic',NULL,NULL);
UPDATE player_specialization_state SET active_specialization_id='warrior'
WHERE player_id='multi-existing';
UPDATE player_specialization_state SET active_specialization_id='ranger'
WHERE player_id='active-choice';
ALTER TABLE player_specialization_state
  ADD CONSTRAINT player_specialization_state_active_commitment_check CHECK (
    active_specialization_id IS NULL OR (
      committed_specialization_id IS NOT NULL AND
      active_specialization_id = committed_specialization_id
    )
  ) NOT VALID;
`;

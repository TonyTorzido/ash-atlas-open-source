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
const migration = "0781_specialization_ultimate_mastery_trials.sql";

describeDatabase("specialization Ultimate Mastery Trial migration", () => {
  const databaseName = `ash_atlas_stability_ultimate_mastery_${randomUUID().replaceAll("-", "")}`;
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
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-ultimate-mastery-"));
    await writeFile(path.join(migrationsDirectory, "0001_fixture.sql"), "CREATE TABLE players (id text PRIMARY KEY); INSERT INTO players (id) VALUES ('player-1'),('player-2');", "utf8");
    await runMigrations(databaseUrl, { migrationsDirectory });
    await copyFile(fileURLToPath(new URL(`../../../../db/migrations/${migration}`, import.meta.url)), path.join(migrationsDirectory, migration));
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("creates an empty durable ledger, admits valid completion once, and has an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([migration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(pool.query("SELECT count(*)::int AS count FROM player_specialization_ultimate_unlocks"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });

    await pool.query(
      `INSERT INTO specialization_ultimate_completion_identities
         (completion_identity,player_id,specialization_id,mastery_quest_id)
       VALUES ('trusted:trial:1','player-1','warrior','warrior_mastery_trial')`
    );
    await pool.query(
      `INSERT INTO player_specialization_ultimate_unlocks
         (player_id,specialization_id,mastery_quest_id,completion_identity)
       VALUES ('player-1','warrior','warrior_mastery_trial','trusted:trial:1')`
    );
    await expect(pool.query(
      `INSERT INTO specialization_ultimate_completion_identities
         (completion_identity,player_id,specialization_id,mastery_quest_id)
       VALUES ('trusted:trial:1','player-2','warrior','warrior_mastery_trial')`
    )).rejects.toThrow();
    await expect(pool.query(
      `INSERT INTO specialization_ultimate_completion_identities
         (completion_identity,player_id,specialization_id,mastery_quest_id)
       VALUES ('trusted:trial:2','player-2','warrior','ranger_mastery_trial')`
    )).rejects.toThrow();

    await expect(pool.query("DELETE FROM players WHERE id='player-1'")).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query("SELECT count(*)::int AS count FROM player_specialization_ultimate_unlocks"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query("SELECT count(*)::int AS count FROM specialization_ultimate_completion_identities"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 30_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
    throw new Error("Ultimate Mastery migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe disposable database name");
  return `"${value}"`;
}

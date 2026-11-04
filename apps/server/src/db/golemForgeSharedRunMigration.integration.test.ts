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
const TARGET_MIGRATION = "1104_golem_forge_shared_run.sql";

describeDatabase("golem forge shared run migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_gf_shared_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;
  const runId = randomUUID();

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-gf-shared-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-gf-shared-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name < TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      } else if (name === TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      }
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    // Populate the pre-upgrade database: a player, a live run and its persisted instance state.
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ('gf-shared-player',$1,'gf-shared-player','gf-shared-player','GLOBAL',40,-105,40,-105,100,true,
         ST_SetSRID(ST_MakePoint(-105,40),4326))`,
      [accountId]
    );
    await pool.query("INSERT INTO dungeon_instance_runs (instance_id,run_id) VALUES ('dungeon:gf-site',$1::uuid)", [runId]);
    await pool.query(
      `INSERT INTO dungeon_instance_state (instance_id,run_id,encounter_states,completed)
       VALUES ('dungeon:gf-site',$1::uuid,'{"quarry_boss":{"state":"completed"}}'::jsonb,false)`,
      [runId]
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, keeps existing instance state, and is empty on a second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([TARGET_MIGRATION]);
    await expect(pool!.query(
      "SELECT encounter_states,party_entries,boss_credits FROM dungeon_instance_state WHERE run_id=$1::uuid", [runId]
    )).resolves.toMatchObject({ rows: [{
      encounter_states: { quarry_boss: { state: "completed" } }, party_entries: {}, boss_credits: {}
    }] });
    const admission = (torches: number, partyTorchTotal: number) => pool!.query(
      `INSERT INTO dungeon_run_admissions
         (admission_id,party_entry_id,instance_id,run_id,dungeon_id,player_id,torches,party_torch_total,bosses_alive)
       VALUES ($1::uuid,$2::uuid,'dungeon:gf-site',$3::uuid,'golem_forge','gf-shared-player',$4,$5,2)`,
      [randomUUID(), randomUUID(), runId, torches, partyTorchTotal]
    );
    await expect(admission(2, 3)).resolves.toMatchObject({ rowCount: 1 });
    await expect(admission(4, 3)).rejects.toMatchObject({ code: "23514" });
    await expect(admission(0, 0)).rejects.toMatchObject({ code: "23514" });
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([]);
  }, 180_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Golem Forge migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0820_personal_flag_warfare_phase.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("personal Flag warfare populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_flag_warfare_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const sourceMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const ownerId = `flag-migration-owner-${suffix}`;
  const attackerId = `flag-migration-attacker-${suffix}`;
  const baseFlagId = randomUUID();
  const breachedStoneId = randomUUID();
  const burningStoneId = randomUUID();
  const burnOperationId = randomUUID();
  const historicalAttackId = randomUUID();
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-flag-warfare-"));
    for (const name of (await readdir(sourceMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(sourceMigrations, name), path.join(migrationsDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("upgrades populated flags without inventing contributors and reruns empty", async () => {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES
         ($1,'Flag migration owner','world-test',35,-106,35,-106,600,false,
          ST_SetSRID(ST_MakePoint(-106,35),4326)),
         ($2,'Flag migration attacker','world-test',35,-106,35,-106,600,false,
          ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [ownerId, attackerId]
    );
    await insertFlag(baseFlagId, ownerId, "Legacy Base", 0, 100, 100, null, 35);
    await insertFlag(breachedStoneId, ownerId, "Breached Stone", 1, 100, 200, null, 35.01);
    await insertFlag(
      burningStoneId,
      ownerId,
      "Burning Stone",
      1,
      100,
      200,
      {
        burningStartedAt: "now() - interval '1 hour'",
        burningUntil: "now() + interval '11 hours'",
        burningReason: "flag_burn"
      },
      35.02
    );
    await pool.query(
      `INSERT INTO flag_attack_operations (
         operation_id,flag_id,player_id,request_id,damage
       ) VALUES ($1,$2,$3,'historical-attack',25)`,
      [historicalAttackId, breachedStoneId, attackerId]
    );
    await pool.query(
      `INSERT INTO flag_burn_operations (
         operation_id,burner_player_id,victim_player_id,flag_id,request_id,
         flag_name,flag_lat,flag_lon,notice_message,started_at,completes_at,
         reinforcement_level,burn_duration_ms
       ) VALUES ($1,$2,$3,$4,'historical-paid-burn','Burning Stone',35,-106,
                 'historical burn',now()-interval '1 hour',now()+interval '11 hours',1,43200000)`,
      [burnOperationId, attackerId, ownerId, burningStoneId]
    );

    await copyFile(
      path.join(sourceMigrations, TARGET_MIGRATION),
      path.join(migrationsDirectory, TARGET_MIGRATION)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool.query(
      `SELECT health,maximum_health,damage_cycle_id
       FROM flags WHERE id=$1`,
      [baseFlagId]
    )).resolves.toMatchObject({ rows: [{ health: 200, maximum_health: 200, damage_cycle_id: null }] });
    await expect(pool.query(
      `SELECT health,maximum_health,damage_cycle_id
       FROM flags WHERE id=$1`,
      [breachedStoneId]
    )).resolves.toMatchObject({ rows: [{ health: 100, maximum_health: 200, damage_cycle_id: expect.any(String) }] });
    await expect(pool.query(
      `SELECT status,damage_cycle_id,remaining_duration_ms
       FROM flag_burn_operations WHERE operation_id=$1`,
      [burnOperationId]
    )).resolves.toMatchObject({ rows: [{ status: "active", damage_cycle_id: expect.any(String), remaining_duration_ms: expect.any(String) }] });
    await expect(pool.query(
      `SELECT damage_cycle_id FROM flag_attack_operations WHERE operation_id=$1`,
      [historicalAttackId]
    )).resolves.toMatchObject({ rows: [{ damage_cycle_id: null }] });

    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
  }, 120_000);

  async function insertFlag(
    id: string,
    owner: string,
    name: string,
    reinforcementLevel: number,
    health: number,
    maximumHealth: number,
    burning: Readonly<{
      burningStartedAt: string;
      burningUntil: string;
      burningReason: string;
    }> | null = null,
    lat = 35
  ): Promise<void> {
    const burningColumns = burning
      ? `,burning_started_at,burning_until,burning_reason`
      : "";
    const burningValues = burning
      ? `,${burning.burningStartedAt},${burning.burningUntil},$8`
      : "";
    const values = burning
      ? [id, owner, name, reinforcementLevel, health, maximumHealth, lat, burning.burningReason]
      : [id, owner, name, reinforcementLevel, health, maximumHealth, lat];
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
         control_type,anchor_kind,system_controlled,reinforcement_level,
         access_mode,health,maximum_health,geom${burningColumns}
       ) VALUES ($1,$2,$3,$7,-106,500,650,'personal','flag',false,$4,
                 'public',$5,$6,ST_SetSRID(ST_MakePoint(-106,$7),4326)${burningValues})`,
      values
    );
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Flag warfare migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

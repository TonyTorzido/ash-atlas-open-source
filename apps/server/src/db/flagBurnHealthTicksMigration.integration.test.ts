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
const migration = "0863_flag_burn_health_ticks.sql";

describeDatabase("durable Flag burn health tick upgrade", () => {
  const databaseName = `ash_atlas_stability_burn_ticks_${randomUUID().replaceAll("-", "")}`;
  const source = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let preceding = "";
  let pool: DisposableTestPool;
  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
        !parsed.pathname.startsWith("/ash_atlas_stability")) throw new Error("Disposable local database required");
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-burn-ticks-"));
    for (const name of (await readdir(source)).filter((entry) => entry.endsWith(".sql") && entry < migration)) {
      await copyFile(path.join(source, name), path.join(preceding, name));
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  });

  it("preserves populated HP, paused progress and identities; the second migration run is empty", async () => {
    await pool.query(
      `INSERT INTO players (id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
       VALUES ('burn-tick-owner','Owner','world-test',35,-106,35,-106,600,true,ST_SetSRID(ST_MakePoint(-106,35),4326)),
              ('burn-tick-attacker','Attacker','world-test',35,-106,35,-106,600,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`
    );
    const flagIds = [randomUUID(), randomUUID()];
    for (const [index, flagId] of flagIds.entries()) {
      const lat = 35 + index;
      await pool.query(
        `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
           control_type,anchor_kind,system_controlled,reinforcement_level,access_mode,health,maximum_health,geom,
           damage_cycle_id,burning_started_at,burning_until,burning_reason)
         VALUES ($1,'burn-tick-owner','Retained Tower',$2,-106,20,650,'personal','flag',false,3,'public',200,2700,
           ST_SetSRID(ST_MakePoint(-106,$2),4326),gen_random_uuid(),now()-interval '12 hours',now()+interval '12 hours','flag_burn')`,
        [flagId, lat]
      );
      await pool.query(
        `INSERT INTO flag_burn_operations (burner_player_id,victim_player_id,flag_id,request_id,flag_name,
           flag_lat,flag_lon,notice_message,started_at,completes_at,reinforcement_level,burn_duration_ms,
           remaining_duration_ms,damage_cycle_id,paused_at)
         SELECT 'burn-tick-attacker',owner_id,id,id::text,name,lat,lon,'Retained notice',burning_started_at,burning_until,
           reinforcement_level,79200000,43200000,damage_cycle_id,CASE WHEN $2 THEN now() ELSE NULL END
         FROM flags WHERE id=$1`, [flagId, index === 1]
      );
    }
    const before = (await pool.query("SELECT id,owner_id,health,damage_cycle_id FROM flags ORDER BY id")).rows;
    await copyFile(path.join(source, migration), path.join(preceding, migration));
    expect(await runMigrations(databaseUrl, { migrationsDirectory: preceding })).toEqual([migration]);
    expect((await pool.query("SELECT id,owner_id,health,damage_cycle_id FROM flags ORDER BY id")).rows).toEqual(before);
    expect((await pool.query(
      "SELECT burn_start_health,burn_damage_applied FROM flag_burn_operations ORDER BY flag_id"
    )).rows).toEqual([
      { burn_start_health: 200, burn_damage_applied: 90 },
      { burn_start_health: 200, burn_damage_applied: 90 }
    ]);
    expect(await runMigrations(databaseUrl, { migrationsDirectory: source })).toEqual(["0864_flag_burn_fixed_budget.sql"]);
    expect((await pool.query("SELECT id,owner_id,health,damage_cycle_id FROM flags ORDER BY id")).rows).toEqual(before);
    expect((await pool.query(
      "SELECT burn_start_health,burn_damage_budget,burn_damage_applied FROM flag_burn_operations ORDER BY flag_id"
    )).rows).toEqual([
      { burn_start_health: 200, burn_damage_budget: 1350, burn_damage_applied: 613 },
      { burn_start_health: 200, burn_damage_budget: 1350, burn_damage_applied: 613 }
    ]);
    const after = (await pool.query("SELECT * FROM flag_burn_operations ORDER BY flag_id")).rows;
    expect(await runMigrations(databaseUrl, { migrationsDirectory: source })).toEqual([]);
    expect((await pool.query("SELECT * FROM flag_burn_operations ORDER BY flag_id")).rows).toEqual(after);
    expect((await pool.query("SELECT count(*)::int AS count FROM players")).rows).toEqual([{ count: 2 }]);
  }, 60_000);
});

import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "1005_death_backpack_drop.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("death backpack drop migration", () => {
  const databaseName = `ash_atlas_stability_death_drop_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let pool: pg.Pool;
  let preceding = "";

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (parsed.hostname !== "127.0.0.1" || !parsed.pathname.includes("ash_atlas_stability")) {
      throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must target the local ash_atlas_stability lab");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-1005-"));
    const source = path.resolve(process.cwd(), "../../db/migrations");
    for (const name of (await readdir(source)).filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)) {
      await copyFile(path.join(source, name), path.join(preceding, name));
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  }, 60_000);

  it("keeps existing backpack drops, adds expiry and the death record, and reruns cleanly", async () => {
    const active = await seedBackpackDrop("active-owner", "active");
    const picked = await seedBackpackDrop("picked-owner", "picked_up");
    await expect(pool.query("UPDATE world_backpack_drops SET status='expired' WHERE id=$1", [active]))
      .rejects.toThrow();

    expect(await runMigrations(databaseUrl)).toEqual([TARGET_MIGRATION]); // populated upgrade
    const rows = await pool.query<{ id: string; status: string }>(
      "SELECT id::text,status FROM world_backpack_drops ORDER BY status"
    );
    expect(rows.rows).toEqual([{ id: active, status: "active" }, { id: picked, status: "picked_up" }]);
    await pool.query("UPDATE world_backpack_drops SET status='expired',expired_at=now() WHERE id=$1", [active]);
    await expect(pool.query("UPDATE world_backpack_drops SET expired_at=NULL WHERE id=$1", [active])).rejects.toThrow();
    await pool.query(
      `INSERT INTO player_death_backpack_drops (operation_key,player_id,outcome,result)
       VALUES ('player-death:m1','active-owner','protected','{}'::jsonb)`
    );
    await expect(pool.query(
      `INSERT INTO player_death_backpack_drops (operation_key,player_id,outcome,result)
       VALUES ('player-death:m2','active-owner','dropped','{}'::jsonb)`
    )).rejects.toThrow();

    expect(await runMigrations(databaseUrl)).toEqual([]); // empty second run
  }, 300_000);

  async function seedBackpackDrop(playerId: string, status: "active" | "picked_up"): Promise<string> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$1,'#38bdf8','NM',35,-106,35,-106,900,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId]
    );
    const instanceId = randomUUID();
    const dropId = randomUUID();
    const create = `migration-pack:${instanceId}`;
    await pool.query(
      `WITH operation AS (
         INSERT INTO backpack_operations(operation_key,player_id,account_id,request_id,action,request_hash)
         VALUES($1,$2,$3,$1,'create',$4) RETURNING operation_key
       ) INSERT INTO player_backpack_instances(instance_id,owner_player_id,definition_id,location,created_by_operation_key)
         SELECT $5,$2,'starter_backpack',$6,operation_key FROM operation`,
      [create, playerId, accountId, "0".repeat(64), instanceId, status === "active" ? "world_drop" : "inventory"]
    );
    const dropOperation = `migration-drop:${dropId}`;
    await pool.query(
      `INSERT INTO backpack_drop_operations (operation_key,player_id,request_id,action,request_hash,instance_id,drop_id)
       VALUES ($1,$2,$1,'pickup',$3,$4,$5)`,
      [dropOperation, playerId, "1".repeat(64), instanceId, dropId]
    );
    await pool.query(
      `INSERT INTO world_backpack_drops (
         id,operation_key,backpack_instance_id,dropped_by,region_code,zone_id,pile_id,status,lat,lon,geom,
         created_at,expires_at,pickup_operation_key,picked_up_by,picked_up_at
       ) VALUES (
         $1,$2,$3,$4,'NM','zone:NM','pile',$5,35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326),
         now(),now()+interval '1 hour',$6,$7,$8
       )`,
      [
        dropId, dropOperation, instanceId, playerId, status,
        status === "picked_up" ? dropOperation : null,
        status === "picked_up" ? playerId : null,
        status === "picked_up" ? new Date() : null
      ]
    );
    return dropId;
  }
});

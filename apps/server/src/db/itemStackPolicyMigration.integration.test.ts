import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { validateItemDefinitionCatalog } from "../game/items.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "0767_dynamic_item_stack_policy.sql";

describeDatabase("dynamic item stack policy migration", () => {
  const migrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_stack_policy_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let preceding = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-stack-policy-"));
    for (const name of await readdir(migrations)) {
      if (name.endsWith(".sql") && name !== migration) {
        await copyFile(path.join(migrations, name), path.join(preceding, name));
      }
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  });

  it("upgrades populated stacks without loss and enforces all future stack writes", async () => {
    const accountId = randomUUID();
    const playerId = `stack-policy-${randomUUID()}`;
    const stackId = randomUUID();
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,$3,'#38bdf8','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId, `stack${randomUUID().slice(0, 8)}`]
    );
    await pool.query(
      `INSERT INTO player_inventory_slots (
         stack_id,player_id,slot_index,resource_type,variant,quantity,manual_split
       ) VALUES ($1,$2,0,'iron_bar','default',75,false)`,
      [stackId, playerId]
    );

    await expect(runMigrations(databaseUrl)).resolves.toEqual([migration]);
    await expect(pool.query(
      "SELECT quantity::integer FROM player_inventory_slots WHERE stack_id=$1",
      [stackId]
    )).resolves.toMatchObject({ rows: [{ quantity: 75 }] });
    await expect(pool.query(
      "UPDATE player_inventory_slots SET quantity=74 WHERE stack_id=$1",
      [stackId]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      "UPDATE player_inventory_slots SET quantity=75 WHERE stack_id=$1",
      [stackId]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `INSERT INTO player_inventory_slots (
         player_id,slot_index,resource_type,variant,quantity,manual_split
       ) VALUES ($1,1,'iron_bar','default',51,false)`,
      [playerId]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !parsed.pathname.slice(1).startsWith("ash_atlas_stability")
  ) {
    throw new Error("Stack policy migration verification requires a disposable local database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

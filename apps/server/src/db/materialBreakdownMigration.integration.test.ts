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
const TARGET_MIGRATION = "1062_material_breakdown_category_recipes.sql";

describeDatabase("Material breakdown and category recipe migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_breakdown_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const playerId = `mob-drops-${randomUUID()}`;
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-breakdown-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-breakdown-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name < TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      }
      if (name <= TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      }
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedPlayerInventory();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, relaxes the station recipe pins, and is empty on a second run", async () => {
    const definitions = async () => Object.fromEntries((await pool!.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname IN ('tannery_jobs_recipe_id_check','loom_jobs_recipe_id_check','loom_jobs_output_quantity_check',
         'kitchen_jobs_recipe_id_check','furnace_smelt_jobs_recipe_id_check','furnace_operations_action_check')`
    )).rows.map((row) => [row.conname, row.def]));
    const before = await definitions();
    expect(before.tannery_jobs_recipe_id_check).toContain("deer_hide");
    expect(before.furnace_smelt_jobs_recipe_id_check).not.toContain("skyrise_bar");

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool!.query<{ quantity: string }>(
      "SELECT quantity::text FROM player_inventory WHERE player_id = $1 AND resource_type = 'leather'",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ quantity: "40" }] });
    const after = await definitions();
    for (const name of ["tannery_jobs_recipe_id_check", "loom_jobs_recipe_id_check", "kitchen_jobs_recipe_id_check"]) {
      expect(after[name], name).toContain("~");
      expect(after[name], name).not.toContain("deer_hide");
    }
    expect(after.loom_jobs_output_quantity_check).toContain("flax_fiber");
    expect(after.furnace_smelt_jobs_recipe_id_check).toContain("skyrise_bar");
    expect(after.furnace_operations_action_check).toContain("breakdown");

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([]);
  }, 120_000);

  async function seedPlayerInventory(): Promise<void> {
    await pool!.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Mob drops fixture','world-test',35,-106,35,-106,
         900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId]
    );
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO inventory_operations (operation_key,player_id,source,metadata)
         VALUES ($1,$2,'mob_drops_migration_fixture','{}'::jsonb)`,
        [`mob-drops-inventory:${playerId}`, playerId]
      );
      await client.query(
        `INSERT INTO player_inventory (player_id,resource_type,variant,quantity,version)
         VALUES ($1,'leather','default',40,1)`,
        [playerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,metadata
         ) VALUES ($1,$2,'leather','default',40,40,1,'mob_drops_migration_fixture','{}'::jsonb)`,
        [`mob-drops-inventory:${playerId}`, playerId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Mob drop item migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

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
const migration = "0769_enchantment_stone_variants.sql";

describeDatabase("Enchantment Stone variant migration", () => {
  const migrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_gem_variants_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let preceding = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-gem-variants-"));
    for (const name of await readdir(migrations)) {
      if (name.endsWith(".sql") && name.localeCompare(migration) < 0) {
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

  it("adds Onyx and Topaz while preserving existing stones and reruns empty", async () => {
    const accountId = randomUUID();
    const playerId = `gem-variants-${randomUUID()}`;
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
      [playerId, accountId, `gems${randomUUID().slice(0, 8)}`]
    );
    await pool.query(
      `INSERT INTO player_inventory_slots (
         player_id,slot_index,resource_type,variant,quantity,manual_split
       ) VALUES ($1,0,'enchantment_stone','emerald',1,false)`,
      [playerId]
    );

    await expect(runMigrations(databaseUrl)).resolves.toContain(migration);
    await expect(pool.query(
      "SELECT supported_variants FROM item_definitions WHERE item_id='enchantment_stone'"
    )).resolves.toMatchObject({
      rows: [{
        supported_variants: [
          "diamond", "onyx", "opal", "amethyst", "topaz", "sapphire", "ruby", "emerald"
        ]
      }]
    });
    await expect(pool.query(
      `SELECT variant,quantity::integer FROM player_inventory_slots
       WHERE player_id=$1 ORDER BY slot_index`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ variant: "emerald", quantity: 1 }] });
    await expect(pool.query(
      `INSERT INTO player_inventory_slots (
         player_id,slot_index,resource_type,variant,quantity,manual_split
       ) VALUES
         ($1,1,'enchantment_stone','onyx',1,false),
         ($1,2,'enchantment_stone','topaz',1,false)`,
      [playerId]
    )).resolves.toMatchObject({ rowCount: 2 });
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || parsed.port === "35432"
    || parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error("Gem variant migration verification requires a local disposable ash_atlas_stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

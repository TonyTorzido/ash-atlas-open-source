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
const migration = "0749_jellyfish_venom_item_definition.sql";

describeDatabase("Jellyfish Venom item catalog migration", () => {
  const sourceMigrations = fileURLToPath(
    new URL("../../../../db/migrations", import.meta.url)
  );
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const databases: string[] = [];
  let precedingMigrations = "";

  beforeAll(async () => {
    assertDisposableDatabase(adminUrl!);
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-jellyfish-venom-catalog-")
    );
    for (const name of await readdir(sourceMigrations)) {
      if (!name.endsWith(".sql") || name >= migration) continue;
      await copyFile(
        path.join(sourceMigrations, name),
        path.join(precedingMigrations, name)
      );
    }
  });

  afterAll(async () => {
    for (const database of databases.reverse()) {
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
      );
    }
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("adds Venom without changing retained catalog or inventory rows", async () => {
    const url = await createDatabase("retained");
    await runMigrations(url, { migrationsDirectory: precedingMigrations });
    const pool = new DisposableTestPool({ connectionString: url, max: 1 });
    try {
      await pool.query(
        `INSERT INTO accounts (id,status,trust_tier)
         VALUES ('10000000-0000-4000-8000-000000000749','active','standard')`
      );
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,region_code,lat,lon,anchor_lat,anchor_lon,
           move_leash_radius_m,online,geom
         ) VALUES (
           '20000000-0000-4000-8000-000000000749',
           '10000000-0000-4000-8000-000000000749','VenomKeeper',
           'GLOBAL',35,-106,35,-106,100,false,
           ST_SetSRID(ST_MakePoint(-106,35),4326)
         )`
      );
      await pool.query(
         `INSERT INTO player_inventory (
           player_id,resource_type,variant,quantity
         ) VALUES (
           '20000000-0000-4000-8000-000000000749','wood','default',0
         )`
      );
      const unrelatedBefore = await unrelatedItemDefinitions(pool);

      await copyFile(path.join(sourceMigrations, migration), path.join(precedingMigrations, migration));
      await expect(runMigrations(url, { migrationsDirectory: precedingMigrations })).resolves.toEqual([migration]);
      await expect(itemDefinition(pool)).resolves.toEqual({
        item_id: "jellyfish_venom",
        display_name: "Jellyfish Venom",
        max_stack: 250,
        market_tradable: true
      });
      await expect(unrelatedItemDefinitions(pool)).resolves.toEqual(
        unrelatedBefore
      );
      await expect(pool.query(
         `SELECT resource_type,quantity::integer
         FROM player_inventory
         WHERE player_id='20000000-0000-4000-8000-000000000749'`
      )).resolves.toMatchObject({
        rows: [{ resource_type: "wood", quantity: 0 }]
      });
      await runMigrations(url);
      await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
      await expect(runMigrations(url)).resolves.toEqual([]);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("creates the canonical item on a fresh database and reruns empty", async () => {
    const url = await createDatabase("fresh");
    await expect(runMigrations(url)).resolves.toContain(migration);
    const pool = new DisposableTestPool({ connectionString: url, max: 1 });
    try {
      await expect(itemDefinition(pool)).resolves.toMatchObject({
        item_id: "jellyfish_venom",
        display_name: "Jellyfish Venom"
      });
      await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
      await expect(runMigrations(url)).resolves.toEqual([]);
    } finally {
      await pool.end();
    }
  }, 120_000);

  async function createDatabase(suffix: string): Promise<string> {
    const parsed = new URL(adminUrl!);
    const database = `ash_atlas_stability_jellyfish_venom_${suffix}`;
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    databases.push(database);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  }
});

async function itemDefinition(pool: pg.Pool): Promise<unknown> {
  const result = await pool.query(
    `SELECT item_id,display_name,max_stack,market_tradable
     FROM item_definitions WHERE item_id='jellyfish_venom'`
  );
  return result.rows[0];
}

async function unrelatedItemDefinitions(pool: pg.Pool): Promise<unknown[]> {
  const result = await pool.query(
    `SELECT * FROM item_definitions
     WHERE item_id<>'jellyfish_venom' ORDER BY item_id`
  );
  return result.rows;
}

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !["postgres:", "postgresql:"].includes(parsed.protocol)
    || parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error(
      "Jellyfish Venom migration verification requires the local ash_atlas_stability database"
    );
  }
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

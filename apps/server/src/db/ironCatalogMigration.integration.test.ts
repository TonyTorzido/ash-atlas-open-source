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
const migration = "0736_iron_ore_catalog.sql";

describeDatabase("iron item catalog migration", () => {
  const sourceMigrations = fileURLToPath(
    new URL("../../../../db/migrations", import.meta.url)
  );
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const databases: string[] = [];
  let precedingMigrations = "";

  beforeAll(async () => {
    assertDisposableDatabase(adminUrl!);
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-iron-catalog-"));
    for (const name of await readdir(sourceMigrations)) {
      if (!name.endsWith(".sql") || name === migration) continue;
      await copyFile(path.join(sourceMigrations, name), path.join(precedingMigrations, name));
    }
  });

  afterAll(async () => {
    for (const database of databases.reverse()) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
    }
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("upgrades the retained Iron label without changing unrelated item definitions", async () => {
    const url = await createDatabase("retained");
    await runMigrations(url, { migrationsDirectory: precedingMigrations });
    const pool = new DisposableTestPool({ connectionString: url, max: 1 });
    try {
      await expect(displayName(pool, "iron")).resolves.toBe("Iron");
      const unrelatedBefore = await unrelatedItemDefinitions(pool);

      await expect(runMigrations(url)).resolves.toEqual([migration]);
      await expect(displayName(pool, "iron")).resolves.toBe("Iron Ore");
      await expect(unrelatedItemDefinitions(pool)).resolves.toEqual(unrelatedBefore);
      await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
      await expect(runMigrations(url)).resolves.toEqual([]);
      await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("creates the canonical catalog on a fresh database and reruns empty", async () => {
    const url = await createDatabase("fresh");
    await expect(runMigrations(url)).resolves.toContain(migration);
    const pool = new DisposableTestPool({ connectionString: url, max: 1 });
    try {
      await expect(displayName(pool, "iron")).resolves.toBe("Iron Ore");
      await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
      await expect(runMigrations(url)).resolves.toEqual([]);
    } finally {
      await pool.end();
    }
  }, 120_000);

  async function createDatabase(suffix: string): Promise<string> {
    const parsed = new URL(adminUrl!);
    const database = `ash_atlas_stability_iron_catalog_${suffix}`;
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    databases.push(database);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  }
});

async function displayName(pool: pg.Pool, itemId: string): Promise<string | undefined> {
  const result = await pool.query<{ display_name: string }>(
    "SELECT display_name FROM item_definitions WHERE item_id = $1",
    [itemId]
  );
  return result.rows[0]?.display_name;
}

async function unrelatedItemDefinitions(pool: pg.Pool): Promise<unknown[]> {
  const result = await pool.query(
    "SELECT * FROM item_definitions WHERE item_id <> 'iron' ORDER BY item_id"
  );
  return result.rows;
}

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error(
      "iron catalog migration verification requires the local ash_atlas_stability database"
    );
  }
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

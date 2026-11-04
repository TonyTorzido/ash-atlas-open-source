import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("hunger foundation migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_hunger_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-hunger-"));
    const hungerMigration = await readFile(
      path.resolve(process.cwd(), "../../db/migrations/0813_hunger_foundation.sql"),
      "utf8"
    );
    await Promise.all([
      writeFile(path.join(migrationsDirectory, "0001_players.sql"), `
        CREATE TABLE players (
          id text PRIMARY KEY,
          sentinel text NOT NULL DEFAULT 'new'
        );
        INSERT INTO players (id, sentinel)
        VALUES ('existing-player', 'preserve-me');
      `, "utf8"),
      writeFile(path.join(migrationsDirectory, "0002_hunger_foundation.sql"), hungerMigration, "utf8")
    ]);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("backfills existing rows, defaults new rows, preserves data, and is idempotent", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_players.sql",
      "0002_hunger_foundation.sql"
    ]);

    const verification = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      await verification.query("INSERT INTO players (id) VALUES ('new-player')");
      await expect(
        verification.query(
          "SELECT id, sentinel, hunger, hunger_base_capacity FROM players ORDER BY id"
        )
      ).resolves.toMatchObject({
        rows: [
          {
            id: "existing-player",
            sentinel: "preserve-me",
            hunger: 2000,
            hunger_base_capacity: 2000
          },
          {
            id: "new-player",
            sentinel: "new",
            hunger: 2000,
            hunger_base_capacity: 2000
          }
        ]
      });

      await verification.query(
        "UPDATE players SET hunger = 1337 WHERE id = 'existing-player'"
      );
      await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
      await expect(
        verification.query("SELECT sentinel, hunger, hunger_base_capacity FROM players WHERE id = 'existing-player'")
      ).resolves.toMatchObject({
        rows: [{ sentinel: "preserve-me", hunger: 1337, hunger_base_capacity: 2000 }]
      });
    } finally {
      await verification.end();
    }
  });
});

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Hunger foundation migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

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

describeDatabase("player hotbar settings migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_hotbar_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-hotbar-"));
    await writeFile(path.join(migrationsDirectory, "0001_players.sql"), `
      CREATE FUNCTION set_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END;
      $$;
      CREATE TABLE players (
        id text PRIMARY KEY,
        retained_marker text NOT NULL
      );
      INSERT INTO players (id, retained_marker) VALUES ('legacy-player', 'preserve-me');
    `, "utf8");
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("upgrades populated data, preserves players, and is empty on its second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual(["0001_players.sql"]);
    const hotbarMigration = await readFile(
      path.resolve(process.cwd(), "../../db/migrations/0848_player_hotbar_settings.sql"),
      "utf8"
    );
    await writeFile(path.join(migrationsDirectory, "0848_player_hotbar_settings.sql"), hotbarMigration, "utf8");
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual(["0848_player_hotbar_settings.sql"]);

    const verification = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      const retained = await verification.query("SELECT id, retained_marker FROM players");
      expect(retained.rows).toEqual([{ id: "legacy-player", retained_marker: "preserve-me" }]);
      const defaults = await verification.query(
        "SELECT revision, slots FROM player_hotbar_settings WHERE player_id = $1",
        ["legacy-player"]
      );
      expect(defaults.rows).toEqual([]);
      await verification.query(
        "INSERT INTO player_hotbar_settings (player_id, slots) VALUES ($1, $2::jsonb)",
        ["legacy-player", JSON.stringify([
          { slotId: "left-1", binding: { kind: "consumable", itemId: "simple_food", variant: "default" } },
          { slotId: "left-2", binding: null },
          { slotId: "left-3", binding: null },
          { slotId: "right-1", binding: null },
          { slotId: "right-2", binding: null },
          { slotId: "right-3", binding: null }
        ])]
      );
      const persisted = await verification.query(
        "SELECT revision, slots->0->>'slotId' AS first_slot FROM player_hotbar_settings WHERE player_id = $1",
        ["legacy-player"]
      );
      expect(persisted.rows).toEqual([{ revision: 0, first_slot: "left-1" }]);
      await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    } finally {
      await verification.end();
    }
  });
});

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error("Hotbar migration test requires local ash_atlas_stability");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

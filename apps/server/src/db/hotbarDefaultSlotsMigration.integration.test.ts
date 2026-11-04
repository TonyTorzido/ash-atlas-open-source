import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decodePersistedHotbarSlots } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

const BUILD = { kind: "action", actionId: "anchor_build" };
const BERRY = { kind: "consumable", itemId: "giving_berry", variant: null };
const FOOD = { kind: "consumable", itemId: "simple_food", variant: "default" };
const ALL_IDS = ["left-1", "left-2", "left-3", "left-4", "left-5", "right-1", "right-2", "right-3", "right-4", "right-5"];

describeDatabase("hotbar default build and heal slots migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_hotbar_seed_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-hotbar-seed-"));
    await writeFile(path.join(migrationsDirectory, "0001_players.sql"), `
      CREATE FUNCTION set_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END;
      $$;
      CREATE TABLE players (id text PRIMARY KEY);
      INSERT INTO players (id) VALUES ('empty'), ('chosen'), ('legacy'), ('hidden'), ('three-rows');
    `, "utf8");
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("seeds only empty bottom-row slots once and is empty on its second run", async () => {
    const hotbarMigration = await readFile(
      path.resolve(process.cwd(), "../../db/migrations/0848_player_hotbar_settings.sql"),
      "utf8"
    );
    await writeFile(path.join(migrationsDirectory, "0848_player_hotbar_settings.sql"), hotbarMigration, "utf8");
    // Only the hotbar layout columns from 0851; its backpack function needs unrelated tables.
    await writeFile(path.join(migrationsDirectory, "0851_hotbar_layout.sql"), `
      ALTER TABLE player_hotbar_settings
        ADD COLUMN IF NOT EXISTS row_count smallint NOT NULL DEFAULT 4 CHECK (row_count BETWEEN 0 AND 5),
        ADD COLUMN IF NOT EXISTS row_positions jsonb NOT NULL DEFAULT '[0,21,42,63,84]'::jsonb;
    `, "utf8");
    await runMigrations(databaseUrl, { migrationsDirectory });

    const slots = (bindings: Record<string, unknown> = {}, ids = ALL_IDS) =>
      JSON.stringify(ids.map((slotId) => ({ slotId, binding: bindings[slotId] ?? null })));
    const pool = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      const insert = (playerId: string, value: string, rowCount = 4) => pool.query(
        "INSERT INTO player_hotbar_settings (player_id, revision, slots, row_count) VALUES ($1, 2, $2::jsonb, $3)",
        [playerId, value, rowCount]
      );
      await insert("empty", slots());
      await insert("chosen", slots({ "left-4": FOOD, "right-1": FOOD }));
      await insert("legacy", slots({ "left-1": FOOD }, ["left-1", "left-2", "left-3", "right-1", "right-2", "right-3"]));
      await insert("hidden", slots(), 0);
      await insert("three-rows", slots(), 3);

      const migration = await readFile(
        path.resolve(process.cwd(), "../../db/migrations/0867_hotbar_default_build_and_heal_slots.sql"),
        "utf8"
      );
      await writeFile(path.join(migrationsDirectory, "0867_hotbar_default_build_and_heal_slots.sql"), migration, "utf8");
      await expect(runMigrations(databaseUrl, { migrationsDirectory }))
        .resolves.toEqual(["0867_hotbar_default_build_and_heal_slots.sql"]);

      const rows = new Map((await pool.query<{ player_id: string; revision: number; slots: unknown }>(
        "SELECT player_id, revision, slots FROM player_hotbar_settings"
      )).rows.map((row) => [row.player_id, row]));
      const binding = (playerId: string, slotId: string) =>
        decodePersistedHotbarSlots(rows.get(playerId)!.slots)!.find((slot) => slot.slotId === slotId)!.binding;

      expect(binding("empty", "left-4")).toEqual(BUILD);
      expect(binding("empty", "right-4")).toEqual(BERRY);
      expect(binding("empty", "right-3")).toBeNull();
      expect(rows.get("empty")!.revision).toBe(3);

      expect(binding("chosen", "left-4")).toEqual(FOOD);
      expect(binding("chosen", "right-4")).toEqual(BERRY);
      expect(binding("chosen", "right-1")).toEqual(FOOD);

      expect(decodePersistedHotbarSlots(rows.get("legacy")!.slots)).toHaveLength(10);
      expect(binding("legacy", "left-1")).toEqual(FOOD);
      expect(binding("legacy", "left-4")).toEqual(BUILD);

      expect(binding("hidden", "left-4")).toBeNull();
      expect(rows.get("hidden")!.revision).toBe(2);

      expect(binding("three-rows", "left-3")).toEqual(BUILD);
      expect(binding("three-rows", "right-3")).toEqual(BERRY);

      await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    } finally {
      await pool.end();
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

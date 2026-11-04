import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_HEAL_TARGET_SETTINGS } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HealTargetService, loadHolyArcRelations } from "../game/healTargets.js";
import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "1218_cleric_scepter_heal_targets.sql";

describeDatabase("migration 1218: Scepter stock item and heal-target settings", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_cleric_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const cleric = `cleric-${suffix}`;
  const friend = `friend-${suffix}`;
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-cleric-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-cleric-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name !== MIGRATION) await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    for (const [id, name] of [[cleric, "Cleric fixture"], [friend, "Friend fixture"]] as const) {
      await pool.query(
        `INSERT INTO players (id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
         VALUES ($1,$2,'world-test',35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
        [id, name]
      );
    }
    const [low, high] = [cleric, friend].sort();
    await pool.query("INSERT INTO friendships (player_low_id, player_high_id) VALUES ($1,$2)", [low, high]);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, matches the startup catalog, and is empty on a second run", async () => {
    await expect(validateItemDefinitionCatalog(pool!)).rejects.toThrow();
    const playersBefore = await pool!.query("SELECT id, username FROM players ORDER BY id");
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([MIGRATION]);
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
    await expect(pool!.query(
      "SELECT item_id, equipment_family_id, equipment_role FROM item_definitions WHERE item_id = 'training_scepter'"
    )).resolves.toMatchObject({ rows: [{ item_id: "training_scepter", equipment_family_id: "scepter", equipment_role: "stock" }] });
    // Existing rows are untouched and nobody gets a settings row (missing = defaults).
    await expect(pool!.query("SELECT id, username FROM players ORDER BY id")).resolves.toMatchObject({ rows: playersBefore.rows });
    await expect(pool!.query("SELECT count(*)::int AS count FROM player_heal_target_settings"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([]);
  });

  it("persists heal-target settings per player as partial updates over the defaults", async () => {
    const service = new HealTargetService(pool!);
    await expect(service.get(cleric)).resolves.toEqual(DEFAULT_HEAL_TARGET_SETTINGS);
    await expect(service.update(cleric, { neutral: true })).resolves.toEqual({ ...DEFAULT_HEAL_TARGET_SETTINGS, neutral: true });
    await expect(service.update(cleric, { kingdom: false })).resolves.toEqual({
      ...DEFAULT_HEAL_TARGET_SETTINGS, neutral: true, kingdom: false
    });
    await expect(service.get(cleric)).resolves.toEqual({ ...DEFAULT_HEAL_TARGET_SETTINGS, neutral: true, kingdom: false });
    await expect(service.get(friend)).resolves.toEqual(DEFAULT_HEAL_TARGET_SETTINGS);
    await expect(service.update(cleric, {} as never)).rejects.toMatchObject({ code: "HEAL_TARGETS_INVALID" });
  });

  it("loads friends and settings for the engine's holy arc sync", async () => {
    const relations = await loadHolyArcRelations(pool!, [cleric, friend]);
    expect(relations.get(cleric)).toMatchObject({
      kingdomId: null, cityId: null, settings: { neutral: true, kingdom: false }
    });
    expect([...relations.get(cleric)!.friendIds]).toEqual([friend]);
    expect([...relations.get(friend)!.friendIds]).toEqual([cleric]);
    expect(relations.get(friend)!.settings).toEqual(DEFAULT_HEAL_TARGET_SETTINGS);
  });
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Migration 1218 test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

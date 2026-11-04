import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("player announcement dismissal populated migration", () => {
  const databaseName = `ash_atlas_stability_announcement_dismissal_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const playerId = `announcement-player-${randomUUID()}`;
  const announcementId = randomUUID();
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname)
      || parsed.port === "35432"
      || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
    ) {
      throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must target a local disposable ash_atlas_stability database");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-announcement-dismissal-"));
    await copyFile(
      path.resolve(process.cwd(), "../../db/migrations/0802_player_announcement_dismissals.sql"),
      path.join(migrationsDirectory, "0802_player_announcement_dismissals.sql")
    );
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await pool.query("CREATE TABLE players (id text PRIMARY KEY)");
    await pool.query("CREATE TABLE player_announcements (id uuid PRIMARY KEY)");
    await pool.query("INSERT INTO players (id) VALUES ($1)", [playerId]);
    await pool.query("INSERT INTO player_announcements (id) VALUES ($1)", [announcementId]);
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("preserves populated player and announcement rows and has an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0802_player_announcement_dismissals.sql"
    ]);
    await pool.query(
      "INSERT INTO player_announcement_dismissals (player_id, announcement_id) VALUES ($1, $2)",
      [playerId, announcementId]
    );
    await expect(pool.query("SELECT id FROM players WHERE id = $1", [playerId]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query("SELECT id FROM player_announcements WHERE id = $1", [announcementId]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      "SELECT dismissed_at FROM player_announcement_dismissals WHERE player_id = $1 AND announcement_id = $2",
      [playerId, announcementId]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
  });
});

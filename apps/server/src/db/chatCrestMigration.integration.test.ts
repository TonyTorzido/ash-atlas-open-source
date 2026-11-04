import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "0853_chat_crests.sql";

describeDatabase("Chat Crest durable selection migration", () => {
  const databaseName = `ash_atlas_stability_chat_crest_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(pathJoin(tmpdir(), "ash-atlas-chat-crest-"));
    await writeFile(
      pathJoin(migrationsDirectory, "0001_profile.sql"),
      `
        CREATE TABLE players (id text PRIMARY KEY);
        CREATE TABLE player_profiles (
          player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
          title text NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO players (id) VALUES ('retained-chat-crest-player');
        INSERT INTO player_profiles (player_id, title)
        VALUES ('retained-chat-crest-player', 'Retained profile');
      `,
      "utf8"
    );
    await writeFile(
      pathJoin(migrationsDirectory, MIGRATION),
      await readFile(pathResolve(`../../db/migrations/${MIGRATION}`), "utf8"),
      "utf8"
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("adds the nullable equipped crest column, preserves profiles, and is repeatable", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_profile.sql",
      MIGRATION
    ]);
    await expect(pool!.query<{ title: string; equipped_chat_crest_id: string | null }>(
      `SELECT title, equipped_chat_crest_id
         FROM player_profiles
        WHERE player_id = 'retained-chat-crest-player'`
    )).resolves.toMatchObject({
      rows: [{ title: "Retained profile", equipped_chat_crest_id: null }]
    });
    await pool!.query(
      `UPDATE player_profiles
          SET equipped_chat_crest_id = 'stag'
        WHERE player_id = 'retained-chat-crest-player'`
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(pool!.query<{ equipped_chat_crest_id: string }>(
      `SELECT equipped_chat_crest_id
         FROM player_profiles
        WHERE player_id = 'retained-chat-crest-player'`
    )).resolves.toMatchObject({ rows: [{ equipped_chat_crest_id: "stag" }] });
  }, 30_000);
});

function pathJoin(...parts: string[]): string {
  return parts.join("/").replaceAll("\\", "/");
}

function pathResolve(relativePath: string): string {
  return pathJoin(process.cwd(), relativePath);
}

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error("Chat Crest migration test requires local ash_atlas_stability");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

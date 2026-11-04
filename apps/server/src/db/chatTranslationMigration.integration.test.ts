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
const MIGRATION = "0852_chat_translation_google.sql";

describeDatabase("Google chat translation cache and budget migration", () => {
  const databaseName = `ash_atlas_stability_chat_translation_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-chat-translation-"));
    await writeFile(path.join(migrationsDirectory, "0001_chat.sql"), `
      CREATE FUNCTION set_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$;
      CREATE TABLE chat_messages (
        id uuid PRIMARY KEY,
        body text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO chat_messages (id, body)
      VALUES ('05000000-0000-4000-8000-000000000001', 'retained message');
    `, "utf8");
    await writeFile(
      path.join(migrationsDirectory, MIGRATION),
      await readFile(path.resolve(process.cwd(), `../../db/migrations/${MIGRATION}`), "utf8"),
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

  it("upgrades a populated chat schema and leaves the second migration run empty", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_chat.sql",
      MIGRATION
    ]);

    await pool!.query(
      `INSERT INTO chat_translation_cache (
         message_id, target_language, provider, model, version,
         translated_text, source_language, source_characters
       ) VALUES ($1,'en','google-cloud-translation-basic-v2','nmt','v1','Retained','es',15)`,
      ["05000000-0000-4000-8000-000000000001"]
    );
    await pool!.query(
      `INSERT INTO chat_translation_usage (usage_month, source_characters)
       VALUES (date_trunc('month', now() AT TIME ZONE 'UTC')::date, 15)`
    );

    await expect(pool!.query<{ body: string }>(
      "SELECT body FROM chat_messages WHERE id = '05000000-0000-4000-8000-000000000001'"
    )).resolves.toMatchObject({ rows: [{ body: "retained message" }] });
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(pool!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chat_translation_cache"
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(pool!.query<{ source_characters: string }>(
      "SELECT source_characters::text FROM chat_translation_usage"
    )).resolves.toMatchObject({ rows: [{ source_characters: "15" }] });
  }, 30_000);
});

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error("Chat translation migration test requires local ash_atlas_stability");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

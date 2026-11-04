import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";

const databaseUrl = process.env.CHAT_MIGRATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const repairMigration = "0660_repair_public_chat_channels.sql";

describeDatabase("public chat catalog repair migration database matrix", () => {
  const sourceMigrations = fileURLToPath(
    new URL("../../../../db/migrations", import.meta.url)
  );
  let prefixMigrations = "";
  const databases: string[] = [];

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl!);
    prefixMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-chat-migrations-"));
    for (const name of await readdir(sourceMigrations)) {
      if (!name.endsWith(".sql") || name === repairMigration) continue;
      await copyFile(path.join(sourceMigrations, name), path.join(prefixMigrations, name));
    }
  });

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl! });
    await admin.connect();
    try {
      for (const database of databases.reverse()) {
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [database]);
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
      }
    } finally {
      await admin.end();
      if (prefixMigrations) await rm(prefixMigrations, { recursive: true, force: true });
    }
  });

  it("repairs a populated pre-fix database without losing durable history or read state", async () => {
    const url = await createDatabase("populated");
    await runMigrations(url, { migrationsDirectory: prefixMigrations });
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO players (
          id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
          move_leash_radius_m, geom
        ) VALUES (
          'chat-migration-player', 'ChatMigration', '#38bdf8', 'NM',
          35.0844, -106.6504, 35.0844, -106.6504, 900,
          ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)
        )
      `);
      await client.query(`
        UPDATE chat_channel_sequences
        SET last_sequence = 1
        WHERE channel_id = '05000000-0000-4000-8000-000000000001'
      `);
      await client.query(`
        INSERT INTO chat_messages (
          id, channel_id, sequence_number, sender_player_id, sender_display_name,
          body, client_request_id, message_status, moderation_status
        ) VALUES (
          '06600000-0000-4000-8000-000000000001',
          '05000000-0000-4000-8000-000000000001', 1,
          'chat-migration-player', 'ChatMigration', 'durable history survives',
          '06600000-0000-4000-8000-000000000002', 'visible', 'clear'
        )
      `);
      await client.query(`
        INSERT INTO chat_channel_read_states (player_id, channel_id, last_read_sequence)
        VALUES (
          'chat-migration-player',
          '05000000-0000-4000-8000-000000000001',
          1
        )
      `);
      await client.query(`
        UPDATE chat_channels
        SET active = false, display_name = 'stale'
        WHERE channel_key IN ('public:general', 'public:trading', 'public:hunting', 'local:map')
      `);
    } finally {
      await client.end();
    }

    expect(await runMigrations(url)).toEqual([repairMigration]);
    await expectCatalogAndHistory(url, true);
  }, 120_000);

  it("creates the catalog in a fresh database and reruns empty when already migrated", async () => {
    const url = await createDatabase("fresh");
    expect(await runMigrations(url)).toContain(repairMigration);
    await expectCatalogAndHistory(url, false);
    expect(await runMigrations(url)).toEqual([]);
    await expectCatalogAndHistory(url, false);
  }, 120_000);

  async function createDatabase(suffix: string): Promise<string> {
    const base = new URL(databaseUrl!);
    const database = `${base.pathname.slice(1)}_${suffix}`;
    if (!database.startsWith("ash_atlas_stability")) {
      throw new Error("derived migration database is not disposable");
    }
    const admin = new pg.Client({ connectionString: databaseUrl! });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    } finally {
      await admin.end();
    }
    databases.push(database);
    base.pathname = `/${database}`;
    return base.toString();
  }
});

async function expectCatalogAndHistory(url: string, populated: boolean): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const channels = await client.query<{
      channel_key: string;
      display_name: string;
      channel_type: string;
      active: boolean;
    }>(`
      SELECT channel_key, display_name, channel_type, active
      FROM chat_channels
      WHERE channel_key IN ('public:general', 'public:trading', 'public:hunting', 'local:map')
      ORDER BY CASE channel_key
        WHEN 'public:general' THEN 1
        WHEN 'public:trading' THEN 2
        WHEN 'public:hunting' THEN 3
        WHEN 'local:map' THEN 4
      END
    `);
    expect(channels.rows).toEqual([
      { channel_key: "public:general", display_name: "General", channel_type: "public", active: true },
      { channel_key: "public:trading", display_name: "Trading", channel_type: "public", active: true },
      { channel_key: "public:hunting", display_name: "Hunting", channel_type: "public", active: true },
      { channel_key: "local:map", display_name: "Local", channel_type: "local", active: true }
    ]);
    const preservation = await client.query<{
      messages: string;
      read_states: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM chat_messages
         WHERE id = '06600000-0000-4000-8000-000000000001') AS messages,
        (SELECT count(*)::text FROM chat_channel_read_states
         WHERE player_id = 'chat-migration-player') AS read_states
    `);
    expect(preservation.rows[0]).toEqual({
      messages: populated ? "1" : "0",
      read_states: populated ? "1" : "0"
    });
  } finally {
    await client.end();
  }
}

function assertDisposableDatabase(value: string): void {
  const url = new URL(value);
  const database = url.pathname.slice(1);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error("chat migration verification requires local PostgreSQL");
  }
  if (!database.startsWith("ash_atlas_stability")) {
    throw new Error("chat migration verification requires an ash_atlas_stability database");
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

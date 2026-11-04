import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0702_party_member_slots.sql";
const adminUrl = process.env.PARTY_SLOTS_MIGRATION_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("stable party member slots populated migration", () => {
  const databaseName =
    `ash_atlas_stability_party_slots_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-party-slots-"));
    for (const name of (await readdir(repoMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)
      .sort()) {
      await copyFile(
        path.join(repoMigrations, name),
        path.join(precedingMigrations, name)
      );
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 3 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("backfills join-order slots, preserves membership, and has an empty second run", async () => {
    await pool.query(
      `INSERT INTO players (
         id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES
         ('slot-a','slot-a','GLOBAL',35,-106,35,-106,900,false,
          ST_SetSRID(ST_MakePoint(-106,35),4326)),
         ('slot-b','slot-b','GLOBAL',35,-106,35,-106,900,false,
          ST_SetSRID(ST_MakePoint(-106,35),4326)),
         ('slot-c','slot-c','GLOBAL',35,-106,35,-106,900,false,
          ST_SetSRID(ST_MakePoint(-106,35),4326))`
    );
    await pool.query("BEGIN");
    try {
      await pool.query("SET CONSTRAINTS ALL DEFERRED");
      await pool.query(
        `INSERT INTO parties (party_id, leader_player_id, revision)
         VALUES ('party:slots', 'slot-b', 7)`
      );
      await pool.query(
        `INSERT INTO party_members (party_id, player_id, joined_at)
         VALUES
           ('party:slots', 'slot-b', '2026-07-01T00:00:00Z'),
           ('party:slots', 'slot-c', '2026-07-02T00:00:00Z'),
           ('party:slots', 'slot-a', '2026-07-03T00:00:00Z')`
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(pool.query(
      `SELECT player_id, slot_index
       FROM party_members
       WHERE party_id = 'party:slots'
       ORDER BY slot_index`
    )).resolves.toMatchObject({
      rows: [
        { player_id: "slot-b", slot_index: 0 },
        { player_id: "slot-c", slot_index: 1 },
        { player_id: "slot-a", slot_index: 2 }
      ]
    });
    await expect(pool.query(
      `SELECT leader_player_id, revision::int, membership_revision::int
       FROM parties WHERE party_id = 'party:slots'`
    )).resolves.toMatchObject({
      rows: [{
        leader_player_id: "slot-b",
        revision: 7,
        membership_revision: 7
      }]
    });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 60_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !database.startsWith("ash_atlas_stability")
  ) {
    throw new Error(
      "Party slot migration tests require a local disposable ash_atlas_stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

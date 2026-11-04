import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0703_party_invite_operation.sql";
const adminUrl = process.env.PARTY_INVITE_OPERATION_MIGRATION_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("party invite operation migration", () => {
  const databaseName =
    `ash_atlas_stability_party_invite_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-party-invite-"));
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

  it("preserves existing operations, permits atomic create-and-invite, and has an empty second run", async () => {
    await pool.query(
      `INSERT INTO players (
         id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES
         ('existing-player','existing-player','GLOBAL',35,-106,35,-106,900,false,
          ST_SetSRID(ST_MakePoint(-106,35),4326)),
         ('leader','leader','GLOBAL',35,-106,35,-106,900,false,
          ST_SetSRID(ST_MakePoint(-106,35),4326))`
    );
    await pool.query(
      `INSERT INTO party_operations (player_id, request_id, action, payload, completed_at)
       VALUES ('existing-player', 'existing-request', 'invite', '{"targetPlayerId":"target"}', now())`
    );

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(pool.query(
      `INSERT INTO party_operations (player_id, request_id, action, payload)
       VALUES ('leader', 'atomic-invite', 'invite_to_party', '{"targetPlayerId":"target"}')
       RETURNING action`
    )).resolves.toMatchObject({
      rows: [{ action: "invite_to_party" }]
    });
    await expect(pool.query(
      `SELECT player_id, request_id, action
       FROM party_operations
       ORDER BY player_id, request_id`
    )).resolves.toMatchObject({
      rows: [
        {
          player_id: "existing-player",
          request_id: "existing-request",
          action: "invite"
        },
        {
          player_id: "leader",
          request_id: "atomic-invite",
          action: "invite_to_party"
        }
      ]
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
      "Party invite migration tests require a local disposable ash_atlas_stability database"
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

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

describeDatabase("Salon mask populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_salon_mask_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-salon-mask-"));
    const maskMigration = await readFile(
      path.resolve(process.cwd(), "../../db/migrations/0739_salon_masks.sql"),
      "utf8"
    );
    await Promise.all([
      writeFile(path.join(migrationsDirectory, "0001_players.sql"), `
        CREATE TABLE players (
          id text PRIMARY KEY,
          username text NOT NULL,
          hair_appearance_id text NULL,
          eyes_appearance_id text NULL,
          nose_mouth_appearance_id text NULL,
          base_appearance_revision bigint NOT NULL DEFAULT 0
        );
        INSERT INTO players (
          id, username, hair_appearance_id, eyes_appearance_id,
          nose_mouth_appearance_id, base_appearance_revision
        ) VALUES ('retained-player', 'Retained', 'hair-1', 'eyes-1', 'face-1', 7);
      `, "utf8"),
      writeFile(path.join(migrationsDirectory, "0002_salon_masks.sql"), maskMigration, "utf8")
    ]);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("preserves existing styles, adds mask persistence, and has an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_players.sql",
      "0002_salon_masks.sql"
    ]);

    const verification = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      const retained = await verification.query(
        `SELECT username,hair_appearance_id,eyes_appearance_id,nose_mouth_appearance_id,
                mask_appearance_id,base_appearance_revision
         FROM players WHERE id='retained-player'`
      );
      expect(retained.rows).toEqual([{
        username: "Retained",
        hair_appearance_id: "hair-1",
        eyes_appearance_id: "eyes-1",
        nose_mouth_appearance_id: "face-1",
        mask_appearance_id: null,
        base_appearance_revision: "7"
      }]);
      await verification.query(
        "UPDATE players SET mask_appearance_id='mask-1' WHERE id='retained-player'"
      );
      await expect(
        verification.query("SELECT mask_appearance_id FROM players WHERE id='retained-player'")
      ).resolves.toMatchObject({ rows: [{ mask_appearance_id: "mask-1" }] });
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
    throw new Error("Salon mask migration test requires the local stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

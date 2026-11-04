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

describeDatabase("default character appearance populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_default_face_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-default-face-"));
    const appearanceMigration = await readFile(
      path.resolve(process.cwd(), "../../db/migrations/0742_default_character_appearance.sql"),
      "utf8"
    );
    await Promise.all([
      writeFile(path.join(migrationsDirectory, "0001_players.sql"), `
        CREATE TABLE players (
          id text PRIMARY KEY,
          hair_appearance_id text NULL,
          eyes_appearance_id text NULL,
          nose_mouth_appearance_id text NULL,
          mask_appearance_id text NULL,
          base_appearance_revision bigint NOT NULL DEFAULT 0
        );
        INSERT INTO players (
          id, hair_appearance_id, eyes_appearance_id,
          nose_mouth_appearance_id, mask_appearance_id, base_appearance_revision
        ) VALUES ('existing-player', NULL, NULL, NULL, 'mask-2', 7);
      `, "utf8"),
      writeFile(path.join(migrationsDirectory, "0002_default_character_appearance.sql"), appearanceMigration, "utf8")
    ]);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("resets existing players, defaults new players, and permits later Salon overrides", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_players.sql",
      "0002_default_character_appearance.sql"
    ]);

    const verification = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      await verification.query("INSERT INTO players (id) VALUES ('new-player')");
      const appearances = await verification.query(
        `SELECT id,hair_appearance_id,eyes_appearance_id,nose_mouth_appearance_id,
                mask_appearance_id,base_appearance_revision
         FROM players ORDER BY id`
      );
      expect(appearances.rows).toEqual([
        {
          id: "existing-player",
          hair_appearance_id: "hair-1",
          eyes_appearance_id: "eyes-2",
          nose_mouth_appearance_id: "mouth-1",
          mask_appearance_id: null,
          base_appearance_revision: "8"
        },
        {
          id: "new-player",
          hair_appearance_id: "hair-1",
          eyes_appearance_id: "eyes-2",
          nose_mouth_appearance_id: "mouth-1",
          mask_appearance_id: null,
          base_appearance_revision: "0"
        }
      ]);

      await verification.query(
        `UPDATE players
         SET hair_appearance_id='hair-3', eyes_appearance_id='eyes-1',
             nose_mouth_appearance_id='mouth-2', mask_appearance_id='mask-1',
             base_appearance_revision=base_appearance_revision + 1
         WHERE id='existing-player'`
      );
      await expect(
        verification.query(
          `SELECT hair_appearance_id,eyes_appearance_id,nose_mouth_appearance_id,
                  mask_appearance_id,base_appearance_revision
           FROM players WHERE id='existing-player'`
        )
      ).resolves.toMatchObject({ rows: [{
        hair_appearance_id: "hair-3",
        eyes_appearance_id: "eyes-1",
        nose_mouth_appearance_id: "mouth-2",
        mask_appearance_id: "mask-1",
        base_appearance_revision: "9"
      }] });
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
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Default appearance migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

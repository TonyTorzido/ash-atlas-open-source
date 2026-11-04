import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "0957_player_face_features.sql";

describeDatabase("Player face features migration", () => {
  const databaseName = `ash_atlas_stability_face_features_${randomUUID()
    .replaceAll("-", "").slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(pathJoin(tmpdir(), "ash-atlas-face-features-"));
    await writeFile(
      pathJoin(migrationsDirectory, "0001_players.sql"),
      `
        CREATE TABLE players (
          id text PRIMARY KEY,
          hair_appearance_id text NULL DEFAULT 'spikey-hair',
          eyes_appearance_id text NULL DEFAULT 'brown-eyes',
          nose_mouth_appearance_id text NULL,
          beard_appearance_id text NULL,
          base_appearance_revision bigint NOT NULL DEFAULT 0,
          retained_marker text NOT NULL
        );
        INSERT INTO players (
          id, hair_appearance_id, eyes_appearance_id, base_appearance_revision, retained_marker
        ) VALUES
          ('styled', 'custom-hair', 'blue-eyes', 9, 'keep-me'),
          ('plain', 'spikey-hair', 'brown-eyes', 2, 'also-keep');
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

  it("keeps existing looks unchanged, bounds feature points, and is repeatable", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_players.sql",
      MIGRATION
    ]);
    await expect(pool!.query(
      `SELECT id, hair_appearance_id, eyes_appearance_id, nose_appearance_id,
              mouth_appearance_id, eyes_feature_x, eyes_feature_y, nose_feature_x,
              mouth_feature_y, base_appearance_revision, retained_marker
         FROM players ORDER BY id`
    )).resolves.toMatchObject({
      rows: [
        {
          id: "plain", hair_appearance_id: "spikey-hair", eyes_appearance_id: "brown-eyes",
          nose_appearance_id: null, mouth_appearance_id: null, eyes_feature_x: null,
          eyes_feature_y: null, nose_feature_x: null, mouth_feature_y: null,
          base_appearance_revision: "2", retained_marker: "also-keep"
        },
        {
          id: "styled", hair_appearance_id: "custom-hair", eyes_appearance_id: "blue-eyes",
          nose_appearance_id: null, mouth_appearance_id: null, eyes_feature_x: null,
          eyes_feature_y: null, nose_feature_x: null, mouth_feature_y: null,
          base_appearance_revision: "9", retained_marker: "keep-me"
        }
      ]
    });
    await pool!.query(
      `UPDATE players SET nose_appearance_id = 'button-nose', eyes_feature_x = 0.5,
              eyes_feature_y = 8.25 WHERE id = 'styled'`
    );
    for (const invalid of [
      "eyes_feature_x = 1, eyes_feature_y = NULL",
      "nose_feature_x = 'NaN', nose_feature_y = 1",
      "mouth_feature_x = 'Infinity', mouth_feature_y = 1",
      "mouth_feature_x = 600, mouth_feature_y = 1"
    ]) {
      await expect(pool!.query(`UPDATE players SET ${invalid} WHERE id = 'plain'`))
        .rejects.toMatchObject({ code: "23514" });
    }
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(pool!.query(
      `SELECT nose_appearance_id, eyes_feature_x, eyes_feature_y
         FROM players WHERE id = 'styled'`
    )).resolves.toMatchObject({
      rows: [{ nose_appearance_id: "button-nose", eyes_feature_x: 0.5, eyes_feature_y: 8.25 }]
    });
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
    throw new Error("Player face features migration requires local ash_atlas_stability");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "0856_player_appearance_model3.sql";

describeDatabase("Player Appearance Model 3 migration", () => {
  const databaseName = `ash_atlas_stability_appearance_model3_${randomUUID()
    .replaceAll("-", "").slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(pathJoin(
      tmpdir(),
      "ash-atlas-player-appearance-model3-"
    ));
    await writeFile(
      pathJoin(migrationsDirectory, "0001_players.sql"),
      `
        CREATE TABLE players (
          id text PRIMARY KEY,
          hair_appearance_id text NULL,
          eyes_appearance_id text NULL,
          nose_mouth_appearance_id text NULL,
          mask_appearance_id text NULL,
          legs_overlay_appearance_id text NULL,
          base_appearance_revision bigint NOT NULL DEFAULT 0,
          retained_marker text NOT NULL
        );
        INSERT INTO players (
          id, hair_appearance_id, eyes_appearance_id, nose_mouth_appearance_id,
          mask_appearance_id, legs_overlay_appearance_id, base_appearance_revision,
          retained_marker
        ) VALUES
          ('legacy', 'old-hair', 'old-eyes', 'old-mouth', 'old-mask', 'old-legs', 7, 'keep-me'),
          ('canonical', 'spikey-hair', 'brown-eyes', NULL, NULL, 'black-pants', 4, 'also-keep');
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

  it("resets existing players, applies defaults to new players, and is repeatable", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_players.sql",
      MIGRATION
    ]);
    await expect(pool!.query(
      `SELECT id, hair_appearance_id, eyes_appearance_id, nose_mouth_appearance_id,
              beard_appearance_id, mask_appearance_id, legs_overlay_appearance_id,
              skin_tone_id, base_appearance_revision, retained_marker
         FROM players
        ORDER BY id`
    )).resolves.toMatchObject({
      rows: [
        {
          id: "canonical",
          hair_appearance_id: "spikey-hair",
          eyes_appearance_id: "brown-eyes",
          nose_mouth_appearance_id: null,
          beard_appearance_id: null,
          mask_appearance_id: null,
          legs_overlay_appearance_id: "black-pants",
          skin_tone_id: "light",
          base_appearance_revision: "4",
          retained_marker: "also-keep"
        },
        {
          id: "legacy",
          hair_appearance_id: "spikey-hair",
          eyes_appearance_id: "brown-eyes",
          nose_mouth_appearance_id: null,
          beard_appearance_id: null,
          mask_appearance_id: null,
          legs_overlay_appearance_id: "black-pants",
          skin_tone_id: "light",
          base_appearance_revision: "8",
          retained_marker: "keep-me"
        }
      ]
    });
    await pool!.query("INSERT INTO players (id, retained_marker) VALUES ('new-player', 'new')");
    await expect(pool!.query(
      `SELECT hair_appearance_id, eyes_appearance_id, nose_mouth_appearance_id,
              beard_appearance_id, mask_appearance_id, legs_overlay_appearance_id,
              skin_tone_id, base_appearance_revision
         FROM players WHERE id = 'new-player'`
    )).resolves.toMatchObject({
      rows: [{
        hair_appearance_id: "spikey-hair",
        eyes_appearance_id: "brown-eyes",
        nose_mouth_appearance_id: null,
        beard_appearance_id: null,
        mask_appearance_id: null,
        legs_overlay_appearance_id: "black-pants",
        skin_tone_id: "light",
        base_appearance_revision: "0"
      }]
    });
    await pool!.query(
      `UPDATE players
          SET hair_appearance_id = 'custom-hair', skin_tone_id = 'dark'
        WHERE id = 'legacy'`
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(pool!.query(
      "SELECT hair_appearance_id, skin_tone_id FROM players WHERE id = 'legacy'"
    )).resolves.toMatchObject({ rows: [{ hair_appearance_id: "custom-hair", skin_tone_id: "dark" }] });
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
    throw new Error("Player Appearance Model 3 migration requires local ash_atlas_stability");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

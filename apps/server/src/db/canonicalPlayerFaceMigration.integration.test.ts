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

describeDatabase("canonical player face populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_face_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-face-"));
    const faceMigration = await readFile(
      path.resolve(process.cwd(), "../../db/migrations/0799_canonical_player_face.sql"),
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
          legs_overlay_appearance_id text NULL,
          base_appearance_revision bigint NOT NULL DEFAULT 0,
          equipment_marker text NULL
        );
        INSERT INTO players (
          id, hair_appearance_id, eyes_appearance_id, nose_mouth_appearance_id,
          mask_appearance_id, legs_overlay_appearance_id,
          base_appearance_revision, equipment_marker
        ) VALUES
          ('legacy', 'hair-3', NULL, 'mouth-2', 'mask-1', 'cloth-pants-black', 7, 'retained'),
          ('canonical', 'hair-2', 'brown-eyes-1', NULL, NULL, NULL, 4, 'untouched');
      `, "utf8"),
      writeFile(path.join(migrationsDirectory, "0002_canonical_face.sql"), faceMigration, "utf8")
    ]);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("normalizes legacy and null faces once while preserving unrelated player data", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_players.sql",
      "0002_canonical_face.sql"
    ]);

    const verification = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      await verification.query("INSERT INTO players (id) VALUES ('new-player')");
      const result = await verification.query(
        `SELECT id,hair_appearance_id,eyes_appearance_id,nose_mouth_appearance_id,
                mask_appearance_id,legs_overlay_appearance_id,
                base_appearance_revision,equipment_marker
         FROM players ORDER BY id`
      );
      expect(result.rows).toEqual([
        {
          id: "canonical", hair_appearance_id: "hair-2",
          eyes_appearance_id: "brown-eyes-1", nose_mouth_appearance_id: null,
          mask_appearance_id: null, legs_overlay_appearance_id: null,
          base_appearance_revision: "4", equipment_marker: "untouched"
        },
        {
          id: "legacy", hair_appearance_id: "hair-3",
          eyes_appearance_id: "brown-eyes-1", nose_mouth_appearance_id: null,
          mask_appearance_id: "mask-1", legs_overlay_appearance_id: "cloth-pants-black",
          base_appearance_revision: "8", equipment_marker: "retained"
        },
        {
          id: "new-player", hair_appearance_id: null,
          eyes_appearance_id: "brown-eyes-1", nose_mouth_appearance_id: null,
          mask_appearance_id: null, legs_overlay_appearance_id: null,
          base_appearance_revision: "0", equipment_marker: null
        }
      ]);
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
    throw new Error(
      "Canonical face migration test requires local ash_atlas_stability"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

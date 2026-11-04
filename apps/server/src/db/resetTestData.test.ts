import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RESET_CONFIRMATION,
  assertExactTableClassification,
  assertForeignKeyClosure,
  resetManifest,
  validateRealResetAuthorization,
  verifiedRemoteBackupPath
} from "./resetTestData.js";

describe("test-data reset safety guards", () => {
  it("requires the exact environment authorization and confirmation", () => {
    expect(() => validateRealResetAuthorization(RESET_CONFIRMATION, {}))
      .toThrow(/ALLOW_TEST_DATA_RESET/);
    expect(() => validateRealResetAuthorization("wrong", {
      ALLOW_TEST_DATA_RESET: "1"
    })).toThrow(/confirmation phrase/);
    expect(() => validateRealResetAuthorization(RESET_CONFIRMATION, {
      ALLOW_TEST_DATA_RESET: "1"
    })).not.toThrow();
  });

  it("rejects unknown and missing table classifications", () => {
    const complete = [
      ...resetManifest.preserve,
      ...resetManifest.wipe,
      ...resetManifest.derivedReseed
    ];
    expect(() => assertExactTableClassification(complete)).not.toThrow();
    expect(() => assertExactTableClassification([
      ...complete,
      "future_unclassified_gameplay"
    ])).toThrow(/unclassified public tables/);
    expect(() => assertExactTableClassification(complete.slice(1)))
      .toThrow(/classified public tables are missing/);
  });

  it("wipes permanent-stone state without classifying its projection view", () => {
    expect(resetManifest.wipe).toEqual(expect.arrayContaining([
      "population_permanent_stone_authority_v2",
      "population_plan_permanent_stones_v2",
      "population_stone_conflict_repair_receipts_v2"
    ]));
    expect([
      ...resetManifest.preserve,
      ...resetManifest.wipe,
      ...resetManifest.derivedReseed
    ]).not.toContain("population_plan_spawn_slots_v2");
  });

  it("wipes legendary bird event state and cooldowns", () => {
    expect(resetManifest.wipe).toEqual(expect.arrayContaining([
      "legendary_bird_cycles",
      "legendary_bird_events",
      "legendary_bird_species_cooldowns"
    ]));
  });

  it("preserves immutable river suppression receipts", () => {
    expect(resetManifest.preserve).toContain(
      "population_river_water_suppressions_v1"
    );
  });

  it("rejects protected-table references to reset tables", () => {
    expect(() => assertForeignKeyClosure([{
      childSchema: "public",
      childTable: "test_access_events",
      parentSchema: "public",
      parentTable: "players"
    }])).toThrow(/protected or unclassified tables/);
  });

  it("accepts only a matching verified remote-backup acknowledgment", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ash-atlas-reset-ack-"));
    const releaseSha = "a".repeat(40);
    const remotePath =
      `/mnt/seagate/ash-atlas/database-resets/` +
      `ash_atlas_game-gameplay-reset-20260726T021500Z-${releaseSha}-` +
      `00000000-0000-4000-8000-000000000001.dump`;
    const valid = {
      acknowledgmentVersion: 1,
      event: "ash_atlas_gameplay_reset_backup_verified",
      acknowledgmentId: "00000000-0000-4000-8000-000000000002",
      database: "ash_atlas_game",
      releaseSha,
      restoreCatalogVerified: true,
      sha256: "b".repeat(64),
      bytes: 1024,
      backupFileName: path.basename(remotePath),
      remoteVerifiedAtUtc: "2026-07-26T02:16:00Z",
      remotePath
    };
    const acknowledgment = path.join(root, "ack.json");
    writeFileSync(acknowledgment, JSON.stringify(valid));
    expect(verifiedRemoteBackupPath(
      { host: "127.0.0.1", port: 5432, database: "ash_atlas_game" },
      releaseSha,
      acknowledgment
    )).toBe(remotePath);

    writeFileSync(acknowledgment, JSON.stringify({
      ...valid,
      remotePath: "/mnt/seagate/ash-atlas/database-resets/../escaped.dump"
    }));
    expect(() => verifiedRemoteBackupPath(
      { host: "127.0.0.1", port: 5432, database: "ash_atlas_game" },
      releaseSha,
      acknowledgment
    )).toThrow(/missing, malformed, or mismatched/);

    const linked = path.join(root, "linked.json");
    symlinkSync(acknowledgment, linked);
    expect(() => verifiedRemoteBackupPath(
      { host: "127.0.0.1", port: 5432, database: "ash_atlas_game" },
      releaseSha,
      linked
    )).toThrow(/unsafe/);
  });
});

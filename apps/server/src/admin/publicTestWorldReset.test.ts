import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

// The deployed administrative command is plain ESM so it can run from an immutable
// release without a TypeScript runtime.
const resetModuleUrl = new URL("../../../../tools/admin/reset-public-test-world.mjs", import.meta.url).href;
const constants = callResetModule<Record<string, unknown>>("constants", []);
const DESTRUCTIVE_TOKEN = String(constants.DESTRUCTIVE_TOKEN);
const RESET_CONFIRMATION = String(constants.RESET_CONFIRMATION);
const preservedTables = constants.preservedTables as string[];
const resetTables = constants.resetTables as string[];

function callResetModule<T>(name: string, args: unknown[]): T {
  const script = `
    const module = await import(${JSON.stringify(resetModuleUrl)});
    try {
      const value = ${name === "constants"
        ? "{ DESTRUCTIVE_TOKEN: module.DESTRUCTIVE_TOKEN, RESET_CONFIRMATION: module.RESET_CONFIRMATION, preservedTables: module.preservedTables, resetTables: module.resetTables }"
        : `module[${JSON.stringify(name)}](...${JSON.stringify(args)})`};
      process.stdout.write(JSON.stringify({ value }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "reset module subprocess failed");
  const parsed = JSON.parse(result.stdout) as { value?: T; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed.value as T;
}

const validateResetGuards = (value: unknown) => callResetModule("validateResetGuards", [value]);
const assertExactTableClassification = (value: unknown) => callResetModule("assertExactTableClassification", [value]);
const buildResetSql = (value: unknown) => callResetModule<string>("buildResetSql", [value]);

const SHA = "a".repeat(40);

function valid(overrides: Record<string, unknown> = {}) {
  return {
    destructiveToken: DESTRUCTIVE_TOKEN,
    confirmation: RESET_CONFIRMATION,
    expectedDatabase: "ash_atlas_game",
    actualDatabase: "ash_atlas_game",
    expectedRuntimeLabel: "production",
    actualRuntimeLabel: "production",
    expectedSha: SHA,
    actualSha: SHA,
    runtimeBranch: "master",
    gameServiceActive: false,
    worldServiceActive: true,
    rehearsal: false,
    ...overrides
  };
}

describe("public test world reset", () => {
  it("refuses without the destructive token", () => {
    expect(() => validateResetGuards(valid({ destructiveToken: undefined })))
      .toThrow(/destructive reset token/);
  });

  it("refuses an unknown database", () => {
    expect(() => validateResetGuards(valid({
      expectedDatabase: "unknown_game",
      actualDatabase: "unknown_game"
    }))).toThrow(/exactly ash_atlas_game/);
  });

  it("refuses a World database before any mutation", () => {
    expect(() => validateResetGuards(valid({
      expectedDatabase: "ash_atlas_world",
      actualDatabase: "ash_atlas_world"
    }))).toThrow(/World database/);
  });

  it("refuses an unclassified production table", () => {
    expect(() => assertExactTableClassification([
      ...preservedTables,
      ...resetTables,
      "unexpected_gameplay_table"
    ])).toThrow(/unclassified public tables/);
  });

  it("preserves player identity while clearing gameplay and restoring the radius contract", () => {
    const sql = buildResetSql({
      spawnLat: 35.0844,
      spawnLon: -106.6504,
      releaseSha: SHA
    });
    expect(sql).toContain("CREATE TEMP TABLE preserved_player_identities");
    expect(sql).toContain("account_id, created_at FROM players");
    expect(sql).toMatch(/TRUNCATE TABLE[\s\S]*"players"/);
    expect(sql).toMatch(/FROM preserved_player_identities/);
    expect(sql).toMatch(/move_leash_radius_m[\s\S]*600/);
    expect(sql).toContain("current_flag_id, current_kingdom_seat_id");
    expect(sql).toContain("NULL, NULL");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(
  new URL("../../../../db/migrations/0816_dungeon_creator_expansion.sql", import.meta.url)
), "utf8");

describe("Dungeon Creator expansion migration", () => {
  it("creates replay-safe per-run encounter and resource state", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS dungeon_instance_state");
    expect(migration).toContain("PRIMARY KEY (instance_id, run_id)");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS dungeon_resource_states");
    expect(migration).toContain("PRIMARY KEY (instance_id, run_id, resource_id)");
    expect(migration).toContain("state IN ('available', 'depleted')");
    expect(migration).toContain("dungeon_resource_states_available_idx");
  });

  it("is forward-safe for an already-created disposable database", () => {
    expect(migration.match(/CREATE TABLE IF NOT EXISTS/gu)).toHaveLength(2);
    expect(migration.match(/CREATE INDEX IF NOT EXISTS/gu)).toHaveLength(1);
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)/iu);
  });
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../db/migrations/0804_authored_dungeon_runtime.sql"),
  "utf8"
);

describe("authored dungeon runtime migration", () => {
  it("extends canonical locations and adds durable presence and reward claims forward-only", () => {
    expect(migration).toContain("'cistern_warrens', 'dungeon'");
    expect(migration).toContain("CREATE TABLE dungeon_presence");
    expect(migration).toContain("CREATE TABLE dungeon_instance_runs");
    expect(migration).toContain("run_id uuid NOT NULL");
    expect(migration).toContain("FOREIGN KEY (instance_id, run_id)");
    expect(migration).toContain("CREATE TABLE dungeon_reward_claims");
    expect(migration).toContain("PRIMARY KEY (run_id, player_id, reward_source_id)");
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM players/i);
  });
});

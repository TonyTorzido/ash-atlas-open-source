import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "../../db/migrations/0750_default_cleric_unlock.sql"), "utf8");

describe("default Cleric unlock migration", () => {
  it("makes Cleric free and grants the entitlement to every existing player", () => {
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS player_class_unlocks_check");
    expect(migration).toContain("class_id = 'cleric' AND gold_paid IN (0, 50000)");
    expect(migration).toContain("class_id NOT IN ('warrior', 'cleric') AND gold_paid = 50000");
    expect(migration).toContain("SELECT id, 'cleric', 'launch-default-cleric:' || id, 0");
    expect(migration).toContain("ON CONFLICT (player_id, class_id) DO NOTHING");
  });
});

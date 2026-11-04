import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../../db/migrations/0012_basic_combat.sql", import.meta.url)
  ),
  "utf8"
);

describe("0012_basic_combat migration", () => {
  it("creates one normalized durable profile per authenticated player", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS player_combat_profiles");
    expect(migration).toContain("player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE");
  });

  it("enforces positive bounded combat stats and valid current health", () => {
    expect(migration).toContain("CHECK (max_health BETWEEN 1 AND 1000000)");
    expect(migration).toContain("CHECK (current_health BETWEEN 0 AND max_health)");
    expect(migration).toContain("CHECK (base_attack_damage BETWEEN 1 AND 100000)");
    expect(migration).not.toMatch(/target|chase|mob_instance|due_attack/i);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(
  new URL("../../../../../db/migrations/0732_warrior_pve_rework.sql", import.meta.url)
), "utf8");

describe("Warrior PvE cutover migration", () => {
  it("reconciles legacy loadouts to deterministic level-safe defaults", () => {
    expect(migration).toContain("ARRAY['warrior_empowered_hit', 'warrior_anger_explosion']");
    expect(migration).toContain("ARRAY['warrior_empowered_hit', NULL]");
    expect(migration).toContain("reset_active_ids = ARRAY[NULL, NULL]");
    for (const passive of ["warrior_heavy_handed", "warrior_relentless", "warrior_desperate_fury"]) {
      expect(migration).toContain(passive);
    }
  });

  it("clears Warrior combat residue without touching progression or equipment", () => {
    expect(migration).toContain("SET current_value = 0");
    expect(migration).toContain("rage = 0");
    expect(migration).toContain("rage_reserved = 0");
    expect(migration).toContain("queued_ability_id = NULL");
    expect(migration).toContain("cooldown_ends_at = '{}'::jsonb");
    expect(migration).toContain("effect->>'sourceTechniqueId' IS NULL");
    expect(migration).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP)\b/i);
    expect(migration).not.toMatch(/UPDATE\s+(?:player_class_progress|equipment|player_progression)/i);
  });

  it("qualifies revisions in updates that join another revision-bearing table", () => {
    expect(migration).toContain("revision = loadout.revision + 1");
    expect(migration).toContain("revision = resource.revision + 1");
    expect(migration).toContain("revision = runtime.revision + 1");
  });
});

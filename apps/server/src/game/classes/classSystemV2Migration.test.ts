import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "../../db/migrations/0771_class_system_v2.sql"), "utf8");

describe("Class System V2 migration", () => {
  it("adds the dedicated ultimate and preserves retained durable domains", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS ultimate_active_id text NULL");
    for (const ultimate of ["warrior_v2_worldbreaker", "ranger_v2_black_rain", "paladin_v2_last_bastion", "ninja_v2_thousand_shadows", "cleric_v2_divine_sanctuary"]) {
      expect(migration).toContain(ultimate);
    }
    for (const retainedTable of ["player_inventory", "player_wallet", "player_class_progress", "player_class_unlocks", "player_equipment_state"]) {
      expect(migration).not.toMatch(new RegExp(`(?:DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?|DROP\\s+TABLE)\\s+${retainedTable}`, "i"));
    }
  });

  it("clears only obsolete launch-class runtime projections", () => {
    expect(migration).toContain("queued_ability_id = NULL");
    expect(migration).toContain("cooldown_ends_at = '{}'::jsonb");
    expect(migration).toContain("status_effects = '[]'::jsonb");
    expect(migration).toContain("counters = '{}'::jsonb");
    expect(migration).toContain("active_class_id IN ('warrior','ranger','paladin','ninja','cleric')");
    expect(migration).toContain("revision = loadout.revision + 1");
    expect(migration).toContain("combat_generation = runtime.combat_generation + 1, revision = runtime.revision + 1");
  });
});

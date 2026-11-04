import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../../db/migrations/0671_population_v2_generation_lifecycle.sql",
    import.meta.url
  ),
  "utf8"
);

describe("0671 Population v2 generation lifecycle reset", () => {
  it("explicitly removes only legacy and obsolete population state", () => {
    for (const statement of [
      "DELETE FROM collectible_nodes",
      "DELETE FROM generated_world_mobs",
      "DELETE FROM population_runtime_entity_leases_v2",
      "DELETE FROM population_entity_state_v2",
      "DELETE FROM population_spawn_slots_v2",
      "DELETE FROM population_zone_cutover_operations_v2",
      "DELETE FROM population_v2_rollout_audit",
      "DELETE FROM population_v2_rollout_control",
      "DROP TABLE IF EXISTS environmental_population_areas"
    ]) {
      expect(migration).toContain(statement);
    }
    expect(migration).not.toMatch(
      /(?:DELETE FROM|TRUNCATE(?: TABLE)?)\s+(?:players|accounts|flags|cities|kingdoms|player_inventory|player_progression)\b/iu
    );
    expect(migration).toContain("DELETE FROM player_discovered_mines;");
    expect(migration).not.toContain(
      "DROP CONSTRAINT IF EXISTS player_discovered_mines_node_id_fkey"
    );
  });

  it("creates one current generation with fixed expiry and scoped slots", () => {
    expect(migration).toContain("CREATE TABLE population_zone_generations_v2");
    expect(migration).toContain(
      "status IN ('active', 'expired', 'refresh-pending')"
    );
    expect(migration).toContain(
      "CHECK (expires_at = generated_at + interval '48 hours')"
    );
    expect(migration).toContain(
      "CREATE UNIQUE INDEX population_zone_generations_v2_one_current_idx"
    );
    expect(migration).toContain("unreferenced_at timestamptz NULL");
    expect(migration).toContain(
      "WHERE is_current"
    );
    expect(migration).toContain(
      "(entity_kind = 'stone' AND generation_id IS NULL)"
    );
    expect(migration).toContain(
      "(entity_kind <> 'stone' AND generation_id IS NOT NULL)"
    );
  });

  it("replaces legacy owner checks with V2-only projection shapes", () => {
    expect(migration).toContain(
      "DROP CONSTRAINT IF EXISTS collectible_nodes_flag_generation_complete"
    );
    expect(migration).toContain(
      "DROP CONSTRAINT IF EXISTS generated_world_mobs_population_owner_complete"
    );
    expect(migration).toContain(
      "ADD CONSTRAINT collectible_nodes_population_v2_owner_complete CHECK"
    );
    expect(migration).toContain(
      "ADD CONSTRAINT repeatable_resource_nodes_population_v2_owner_complete CHECK"
    );
    expect(migration).toContain("AND id = population_v2_entity_id");
    expect(migration).toContain("DROP COLUMN source_population_area_id");
    expect(migration).toContain("DROP COLUMN source_generation");
    expect(migration).toContain("DROP COLUMN source_flag_id");
    expect(migration).not.toContain(
      "generic resources cannot acquire population ownership"
    );
    expect(migration).not.toContain("ELSIF OLD.placement_version");
  });

  it("forbids non-stone respawn and fixes stone regeneration at 5h50", () => {
    expect(migration).toContain(
      "non-stone generation entities never individually respawn"
    );
    expect(migration).toContain(
      "NEW.killed_or_harvested_at + interval '5 hours 50 minutes'"
    );
    expect(migration).toContain(
      "regeneration_interval = interval '5 hours 50 minutes'"
    );
    expect(migration).not.toContain(
      "regeneration_interval = interval '48 hours'"
    );
  });
});

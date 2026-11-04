import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../../db/migrations/0704_population_generation_mob_rollouts.sql",
    import.meta.url
  ),
  "utf8"
);

describe("0702 Population V2 registered-mob manifest", () => {
  it("adds one generic generation/mob/revision receipt without backfill", () => {
    expect(migration).toContain(
      "CREATE TABLE population_generation_mob_rollouts_v2"
    );
    expect(migration).toContain(
      "PRIMARY KEY (generation_id, mob_kind, rollout_revision)"
    );
    expect(migration).toContain(
      "source IN ('generation', 'top_up')"
    );
    expect(migration).toContain(
      "'completed_with_shortfall'"
    );
    expect(migration).toContain(
      "WHERE status = 'retryable_failure'"
    );
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*population_/iu);
  });

  it("opens registry slots and projections while preserving shape integrity", () => {
    expect(migration).toContain(
      "ALTER TABLE population_spawn_slots_v2"
    );
    expect(migration).toContain("btrim(entity_kind) <> ''");
    expect(migration).toContain("char_length(entity_kind) <= 64");
    expect(migration).toContain(
      "entity_kind ~ '^[a-z][a-z0-9_]*$'"
    );
    expect(migration).toContain(
      "archetype IN ('tree', 'stone_mine')"
    );
    expect(migration).toContain(
      "(pack_id IS NULL AND pack_member_index IS NULL)"
    );
    expect(migration).toContain(
      "(pack_id IS NOT NULL AND pack_member_index IS NOT NULL)"
    );
    expect(migration).toContain(
      "ALTER TABLE generated_world_mobs"
    );
    expect(migration).toContain("btrim(mob_archetype) <> ''");
    expect(migration).toContain("char_length(mob_archetype) <= 64");
    expect(migration).toContain(
      "mob_archetype ~ '^[a-z][a-z0-9_]*$'"
    );
    expect(migration).toContain(
      "validate_population_v2_generated_mob_registry_shape"
    );
    expect(migration).toContain(
      "slot_archetype IS DISTINCT FROM NEW.mob_archetype"
    );
    expect(migration).toContain(
      "slot_encounter_id IS DISTINCT FROM NEW.encounter_id"
    );
    expect(migration).toContain(
      "slot_pack_id IS DISTINCT FROM NEW.pack_id"
    );
    expect(migration).not.toMatch(/\b(?:TRUNCATE|DROP\s+TABLE)\b/iu);
    expect(migration).not.toMatch(
      /\b(?:players|inventor(?:y|ies)|progression|collectible_nodes|population_entity_state_v2)\b/iu
    );
    expect(migration).toContain(
      "absence never affects Population V2 generation servability"
    );
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../../db/migrations/0705_suppress_non_authoritative_population_trees.sql",
    import.meta.url
  ),
  "utf8"
);
const diagnostic = readFileSync(
  new URL(
    "../../../../tools/diagnostics/population-v2-tree-authority.sql",
    import.meta.url
  ),
  "utf8"
);

describe("0703 Population V2 tree authority quarantine", () => {
  it("suppresses only tree projections outside current serving authority", () => {
    expect(migration).toContain("UPDATE collectible_nodes AS tree");
    expect(migration).toContain("SET population_cutover_suppressed=true");
    expect(migration).toContain("tree.resource_type='wood'");
    expect(migration).toContain("generation.is_current");
    expect(migration).toContain("generation.zone_id=plan.zone_id");
    expect(migration).toContain("generation.status='active'");
    expect(migration).toContain(
      "generation.expires_at > statement_timestamp()"
    );
    expect(migration).toContain("plan.status='ready'");
    expect(migration).toContain("cutover.selected_plan_id=plan.plan_id");
    expect(migration).toContain("cutover.serving_version='v2'");
    expect(migration).toContain("cutover.status='stable'");
    expect(migration).toContain(
      "cutover.cutover_revision=tree.population_cutover_revision"
    );
    expect(migration).toContain(
      "state.state_revision=tree.population_v2_state_revision"
    );
    expect(migration).toContain("state.state='ready'");
    expect(migration).toContain("tree.state='available'");
  });

  it("is forward-only and preserves retained identities and canonical history", () => {
    expect(migration).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP)\b/iu);
    expect(migration).not.toMatch(
      /\bUPDATE\s+(?:population_spawn_slots_v2|population_entity_state_v2|population_zone_generations_v2|population_zones_v2)\b/iu
    );
    expect(migration).not.toMatch(
      /\bSET\s+(?:id|population_v2_entity_id|population_v2_plan_id|population_v2_state_revision)\s*=/iu
    );
    expect(migration).not.toContain("population_cutover_suppressed=false");
  });

  it("keeps the companion audit read-only, time-bounded, and result-bounded", () => {
    expect(diagnostic).toContain("BEGIN TRANSACTION READ ONLY");
    expect(diagnostic).toContain("SET LOCAL statement_timeout = '5s'");
    expect(diagnostic.match(/\bLIMIT 200\b/gu)).toHaveLength(2);
    expect(diagnostic).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/iu
    );
    expect(diagnostic).toContain("available_from_non_current_generation");
    expect(diagnostic).toContain("available_from_non_selected_plan");
    expect(diagnostic).toContain("projection_canonical_state_mismatch");
    expect(diagnostic).toContain(
      "state.state NOT IN ('ready', 'harvested')"
    );
    expect(diagnostic).toContain("missing_generation_ownership");
    expect(diagnostic).toContain("generation_zone_mismatch");
    expect(diagnostic).toContain(
      "harvested_canonical_projection_available"
    );
    expect(diagnostic).toContain("first_selected_plan_id");
    expect(diagnostic).toContain("second_selected_plan_id");
    expect(diagnostic).toContain("first_canonical_state");
    expect(diagnostic).toContain("second_canonical_state");
  });
});

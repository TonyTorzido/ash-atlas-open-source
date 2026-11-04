import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../db/migrations/0713_permanent_resource_lifecycle.sql",
      import.meta.url
    )
  ),
  "utf8"
);

describe("permanent-resource lifecycle migration", () => {
  it("generalizes authority and separates permanent projection synchronization", () => {
    expect(migration).toContain(
      "CREATE VIEW population_permanent_resource_authority_v2"
    );
    expect(migration).toContain(
      "CREATE VIEW population_plan_permanent_resources_v2"
    );
    expect(migration).toContain(
      "synchronize_permanent_resource_projection_v2"
    );
    expect(migration).toContain(
      "population_entity_state_v2_synchronize_permanent_resources"
    );
    expect(migration).toContain(
      "population_entity_state_v2_permanent_resource_regeneration"
    );
    expect(migration).toContain(
      "NEW.killed_or_harvested_at IS NULL"
    );
    expect(migration).toContain("NEW.respawn_at IS NULL");
    expect(migration).toContain(
      "population_entity_state_v2_permanent_resource_retained_lifecycle"
    );
    expect(migration).toContain(
      "canonical.killed_or_harvested_at + authority.regeneration_interval"
    );
    expect(migration).toContain("cutover.status = 'stable'");
    expect(migration).toContain("NOT projection.population_v2_suppressed");
  });
});

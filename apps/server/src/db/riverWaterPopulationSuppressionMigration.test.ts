import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../../db/migrations/0720_river_water_population_suppressions.sql", import.meta.url),
  "utf8"
);

describe("river water population suppression migration", () => {
  it("records immutable exact-source conflicts without changing player-owned tables", () => {
    expect(migration).toContain("CREATE TABLE population_river_water_suppressions_v1");
    expect(migration).toContain("REFERENCES population_spawn_slots_v2(entity_id) ON DELETE RESTRICT");
    expect(migration).toContain("river_manifest_sha256");
    expect(migration).toContain("river_row_id");
    expect(migration).toContain("river_column_id");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).not.toMatch(/UPDATE\s+(flags|city_structures|kingdom_)/iu);
    expect(migration).not.toMatch(/DELETE\s+FROM/iu);
  });
});

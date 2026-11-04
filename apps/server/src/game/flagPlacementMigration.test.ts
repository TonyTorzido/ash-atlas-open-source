import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0612_database_flag_placement_invariant.sql", import.meta.url)
  ),
  "utf8"
);

describe("database flag placement invariant migration", () => {
  it("serializes writers and checks the new center against existing claim radii", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("ash-atlas-flag-placement-v1");
    expect(migration).toContain("existing.claim_radius_m + 0.05");
    expect(migration).toContain("flags_center_outside_existing_claim");
    expect(migration).toMatch(/BEFORE INSERT OR UPDATE OF lat, lon, geom ON flags/);
  });

  it("does not replace center legality with symmetric radius exclusion", () => {
    expect(migration).not.toMatch(/NEW\.claim_radius_m/);
    expect(migration).not.toMatch(/existing\.claim_radius_m\s*\+\s*NEW\./);
  });
});

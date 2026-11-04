import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0613_indexed_territory_candidates.sql", import.meta.url)
  ),
  "utf8"
);

describe("indexed territory candidate migration", () => {
  it("preflights and enforces the exact operational radius ceiling", () => {
    expect(migration).toContain("claim_radius_m > 10000");
    expect(migration).toContain("flags_claim_radius_m_domain");
    expect(migration).toContain("claim_radius_m <= 10000");
  });

  it("adds the geography expression index used by territory predicates", () => {
    expect(migration).toMatch(
      /CREATE INDEX flags_geography_gix[\s\S]*USING gist \(\(geom::geography\)\)/
    );
  });
});

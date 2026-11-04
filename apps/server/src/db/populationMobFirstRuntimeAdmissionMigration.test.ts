import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "../../db/migrations/0772_population_mob_first_runtime_admission.sql"
), "utf8");

describe("0772 Population V2 first runtime admission", () => {
  it("adds a nullable marker and grandfathers only existing ready mobs", () => {
    expect(migration).toContain(
      "ADD COLUMN first_runtime_admitted_at timestamptz NULL"
    );
    expect(migration).toContain("state.state = 'ready'");
    expect(migration).toContain(
      "slot.entity_kind NOT IN ('tree', 'stone', 'coal', 'iron')"
    );
    expect(migration).not.toMatch(/DEFAULT\s+clock_timestamp/iu);
  });
});

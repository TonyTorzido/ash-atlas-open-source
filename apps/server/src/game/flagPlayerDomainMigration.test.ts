import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0614_flag_player_domain_constraints.sql", import.meta.url)
  ),
  "utf8"
);

describe("flag and player domain constraint migration", () => {
  it("preflights coordinate ranges and geometry consistency", () => {
    expect(migration).toContain("flags_coordinate_domain");
    expect(migration).toContain("players_coordinate_domain");
    expect(migration).toContain("lat BETWEEN -90 AND 90");
    expect(migration).toContain("lon BETWEEN -180 AND 180");
    expect(migration).toContain("anchor_lat BETWEEN -90 AND 90");
    expect(migration).toContain("abs(ST_Y(geom) - lat) <= 0.000000001");
    expect(migration).toContain("abs(ST_X(geom) - lon) <= 0.000000001");
  });

  it("makes flag ownership restrictive and validates every new constraint", () => {
    expect(migration).toMatch(
      /FOREIGN KEY \(owner_id\) REFERENCES players\(id\) ON DELETE RESTRICT NOT VALID/
    );
    for (const constraint of [
      "flags_coordinate_domain",
      "players_coordinate_domain",
      "flags_owner_id_fkey"
    ]) {
      expect(migration).toContain(`VALIDATE CONSTRAINT ${constraint}`);
    }
    expect(migration).not.toMatch(/ON DELETE CASCADE/);
  });
});

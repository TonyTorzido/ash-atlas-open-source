import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0618_recent_players.sql", import.meta.url)),
  "utf8"
);
const suppressionMigration = readFileSync(
  fileURLToPath(new URL(
    "../../../../db/migrations/0619_recent_player_pair_suppressions.sql",
    import.meta.url
  )),
  "utf8"
);

describe("recent players migration", () => {
  it("creates one directional pair row with bounded recent-first retrieval", () => {
    expect(migration).toContain("PRIMARY KEY (owner_player_id, recent_player_id)");
    expect(migration).toContain("recent_players_no_self");
    expect(suppressionMigration).toContain("recent_player_pair_suppressions");
    expect(suppressionMigration).toContain("PRIMARY KEY (player_low_id, player_high_id)");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).toContain("owner_player_id, interaction_at DESC, recent_player_id");
  });

  it("stores only interaction reason and time, never player location", () => {
    expect(migration).toContain("'nearby', 'local_chat', 'party', 'trade'");
    expect(migration).not.toMatch(/\b(lat|lon|location|coordinate|flag_id|zone_id|region_code|destination)\b/i);
  });
});

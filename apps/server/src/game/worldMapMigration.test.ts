import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0645_world_map_city_discovery.sql", import.meta.url)
  ),
  "utf8"
);
const visibilityMigration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0754_world_map_destination_visibility.sql", import.meta.url)
  ),
  "utf8"
);

describe("world map city discovery migration", () => {
  it("stores one durable player-city discovery with conservative founder backfill", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS player_discovered_cities");
    expect(migration).toContain("PRIMARY KEY (player_id, city_id)");
    expect(migration).toContain("founder_player_id");
    expect(migration).not.toMatch(/city_memberships[\s\S]*INSERT INTO player_discovered_cities/i);
  });

  it("stores bounded per-player visibility overrides without changing discovery", () => {
    expect(visibilityMigration).toContain(
      "CREATE TABLE IF NOT EXISTS player_world_map_destination_preferences"
    );
    expect(visibilityMigration).toContain(
      "PRIMARY KEY (player_id, destination_kind, destination_id)"
    );
    expect(visibilityMigration).toContain("CHECK (destination_kind IN");
    expect(visibilityMigration).not.toContain("player_discovered_cities");
  });
});

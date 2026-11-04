import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(
  new URL("../../../../db/migrations/0813_creature_book_plants.sql", import.meta.url)
), "utf8");
const developerPlantMigration = readFileSync(fileURLToPath(
  new URL("../../../../db/migrations/0814_developer_spawned_plants.sql", import.meta.url)
), "utf8");

describe("Creature Book plants migration", () => {
  it("adds idempotent durable Flax harvest history and preserves completed harvests", () => {
    expect(migration).toContain("CREATE TABLE creature_book_plant_harvests");
    expect(migration).toContain("PRIMARY KEY (player_id, plant_key, source_id)");
    expect(migration).toContain("CHECK (plant_key IN ('flax'))");
    expect(migration).toContain("FROM harvest_sessions");
    expect(migration).toContain("WHERE status = 'completed'");
    expect(migration).toContain("AND resource_type = 'flax_fiber'");
    expect(migration).toContain("ON CONFLICT DO NOTHING");
  });

  it("adds durable developer plant rows with replay-safe lifecycle state", () => {
    expect(developerPlantMigration).toContain("CREATE TABLE developer_spawned_plants");
    expect(developerPlantMigration).toContain("UNIQUE (creator_player_id, request_id)");
    expect(developerPlantMigration).toContain("state IN ('available', 'harvested')");
    expect(developerPlantMigration).toContain("state_revision BIGINT NOT NULL DEFAULT 0");
    expect(developerPlantMigration).toContain("REFERENCES players(id) ON DELETE SET NULL");
    expect(developerPlantMigration).toContain("developer_spawned_plants_available_idx");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0605_manor_world_placement.sql", import.meta.url)),
  "utf8"
);
const relocationMigration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0606_manor_relocation.sql", import.meta.url)),
  "utf8"
);
const guestAccessMigration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0662_manor_guest_access.sql", import.meta.url)),
  "utf8"
);
const gridStorageMigration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0676_manor_grid_storage.sql", import.meta.url)),
  "utf8"
);
const localPositionMigration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0706_manor_local_position.sql", import.meta.url)),
  "utf8"
);
const storageUpgradeMigration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0837_manor_storage_upgrades.sql", import.meta.url)),
  "utf8"
);
const starterDecorationMigration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0844_manor_universal_starter_decorations.sql", import.meta.url)),
  "utf8"
);

describe("manor world placement migration", () => {
  it("enforces complete durable placement and indexes built world objects", () => {
    expect(migration).toContain("player_manors_world_placement_complete");
    expect(migration).toContain("built_at IS NULL AND world_region_code IS NULL");
    expect(migration).toContain("built_at IS NOT NULL AND world_region_code IS NOT NULL");
    expect(migration).toContain("USING gist (geom)");
    expect(migration).toContain("WHERE built_at IS NOT NULL");
  });

  it("preserves manor and storage rows while invalidating old automatic presence", () => {
    expect(migration).toContain("DELETE FROM player_manor_presence");
    expect(migration).not.toMatch(/DELETE FROM (player_manors|manor_storage_stacks)/);
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS manor_build_operations");
    expect(migration).toContain("UNIQUE (player_id, request_id)");
  });
});

describe("manor relocation migration", () => {
  it("adds revisions, unified replay operations, and immutable lifecycle events", () => {
    expect(relocationMigration).toContain("placement_revision bigint NOT NULL DEFAULT 0");
    expect(relocationMigration).toContain("CREATE TABLE IF NOT EXISTS manor_placement_operations");
    expect(relocationMigration).toContain("operation_type IN ('build', 'destroy')");
    expect(relocationMigration).toContain("CREATE TABLE IF NOT EXISTS manor_placement_events");
    expect(relocationMigration).toContain("manor placement events are append-only");
    expect(relocationMigration).toContain("ON CONFLICT DO NOTHING");
  });
});

describe("manor guest access migration", () => {
  it("allows multiple occupants while preserving one presence per player", () => {
    expect(guestAccessMigration).toContain("DROP CONSTRAINT IF EXISTS player_manor_presence_manor_id_key");
    expect(guestAccessMigration).toContain("access_source text NOT NULL DEFAULT 'OWNER'");
    expect(guestAccessMigration).toContain("admission_travel_invite_id uuid");
    expect(guestAccessMigration).toContain("player_manor_presence_travel_invite_uidx");
  });

  it("persists indexed manor-scoped bans with cascade cleanup", () => {
    expect(guestAccessMigration).toContain("CREATE TABLE IF NOT EXISTS manor_bans");
    expect(guestAccessMigration).toContain("PRIMARY KEY (manor_id, banned_player_id)");
    expect(guestAccessMigration).toContain("REFERENCES player_manors(id) ON DELETE CASCADE");
    expect(guestAccessMigration).toContain("manor_bans_player_manor_idx");
  });

  it("records completed manor jumps for durable duplicate-request replay", () => {
    expect(guestAccessMigration).toContain("CREATE TABLE IF NOT EXISTS manor_jump_operations");
    expect(guestAccessMigration).toContain("PRIMARY KEY (player_id, request_id)");
    expect(guestAccessMigration).toContain("relocation_revision bigint NOT NULL");
  });
});

describe("manor grid storage migration", () => {
  it("deterministically splits legacy totals into 60 live slots and retained overflow", () => {
    expect(gridStorageMigration).toContain("CHECK (slot_index BETWEEN 0 AND 59)");
    expect(gridStorageMigration).toContain("COALESCE(definition.max_stack::bigint");
    expect(gridStorageMigration).toContain(
      'ORDER BY lower(display_name) COLLATE "C", variant COLLATE "C", item_id COLLATE "C", part'
    );
    expect(gridStorageMigration).toContain("WHERE slot_index < 60");
    expect(gridStorageMigration).toContain("WHERE slot_index >= 60");
    expect(gridStorageMigration).toContain("manor storage backfill quantity validation failed");
  });

  it("keeps overflow and stack events immutable and isolates request replay", () => {
    expect(gridStorageMigration).toContain("BEFORE INSERT OR UPDATE OR DELETE ON manor_storage_overflow");
    expect(gridStorageMigration).toContain("manor storage overflow is migration-retained and read-only");
    expect(gridStorageMigration).toContain("UNIQUE (player_id, request_id)");
    expect(gridStorageMigration).toContain("manor storage stack events are append-only");
  });
});

describe("manor local position migration", () => {
  it("adds nullable paired bounded coordinates without changing storage or presence rows", () => {
    expect(localPositionMigration).toContain("local_position_x double precision");
    expect(localPositionMigration).toContain("local_position_y double precision");
    expect(localPositionMigration).toContain("player_manor_presence_local_position_pair_check");
    expect(localPositionMigration).toContain("BETWEEN 24 AND 976");
    expect(localPositionMigration).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE)\b/i);
  });
});

describe("manor storage upgrades migration", () => {
  it("preserves existing manors at tier zero and records atomic replay operations", () => {
    expect(storageUpgradeMigration).toContain("storage_upgrade_level integer NOT NULL DEFAULT 0");
    expect(storageUpgradeMigration).toContain("CHECK (storage_upgrade_level BETWEEN 0 AND 3)");
    expect(storageUpgradeMigration).toContain("CREATE TABLE IF NOT EXISTS manor_storage_upgrade_operations");
    expect(storageUpgradeMigration).toContain("UNIQUE (player_id, request_id)");
    expect(storageUpgradeMigration).toContain("CREATE TABLE IF NOT EXISTS manor_storage_upgrade_events");
    expect(storageUpgradeMigration).toContain("manor storage upgrade events are append-only");
  });
});

describe("universal Manor starter decoration migration", () => {
  it("detaches legacy item custody without destructive table operations", () => {
    expect(starterDecorationMigration).toContain("ALTER COLUMN item_id DROP NOT NULL");
    expect(starterDecorationMigration).toContain("ALTER COLUMN item_variant DROP NOT NULL");
    expect(starterDecorationMigration).toContain("SET definition_id = 'simple_double_bed'");
    expect(starterDecorationMigration).toContain("item_id = NULL");
    expect(starterDecorationMigration).not.toContain("CREATE UNIQUE INDEX");
    expect(starterDecorationMigration).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP TABLE)\b/i);
  });
});

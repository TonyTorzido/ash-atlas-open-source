import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0651_equipment_progression_combat_kits.sql", import.meta.url)
  ),
  "utf8"
);

describe("equipment progression and combat-kit migration", () => {
  it("makes level 0 durable and accepts exactly the seven launch slots", () => {
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS item_level smallint NOT NULL DEFAULT 0"
    );
    expect(migration).toContain("CHECK (item_level BETWEEN 0 AND 25)");
    for (const slot of [
      "head",
      "chest",
      "gloves",
      "boots",
      "ring",
      "melee",
      "secondary"
    ]) {
      expect(migration).toContain(`'${slot}'`);
    }
    expect(migration).toContain("WHEN definition_id = 'starter_sword' THEN 'melee'");
    expect(migration).toContain(
      "WHEN definition_id IN ('starter_bow', 'starter_staff') THEN 'secondary'"
    );
    expect(migration).toContain(
      "('training_heavy_helm', 'Training Heavy Helm', 'equipment', false, 1"
    );
    expect(migration).toContain(
      "('training_shield', 'Training Shield', 'equipment', false, 1"
    );
    expect(migration).toContain(
      "('training_light_hood', 'Training Light Hood', 'equipment', false, 1"
    );
    expect(migration).not.toMatch(/DELETE FROM equipment_instances/i);
  });

  it("creates exactly six normalized saved-kit identities with unique references", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS combat_kits");
    expect(migration).toContain("CHECK (kit_index BETWEEN 1 AND 6)");
    expect(migration).toContain("CROSS JOIN generate_series(1, 6)");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS combat_kit_items");
    expect(migration).toContain("PRIMARY KEY (player_id, kit_index, equipment_slot)");
    expect(migration).toContain("UNIQUE (player_id, kit_index, instance_id)");
  });

  it("owns revisions, replay ledgers, wallet provenance, and bounded audit events", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS player_equipment_state");
    expect(migration).toContain("inventory_revision bigint NOT NULL DEFAULT 0");
    expect(migration).toContain("active_revision bigint NOT NULL DEFAULT 0");
    expect(migration).toContain("checkpoint_revision bigint NOT NULL DEFAULT 0");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS combat_kit_operations");
    expect(migration).toContain(
      "CHECK (action IN ('save', 'rename', 'clear', 'toggle_readied', 'activate'))"
    );
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS equipment_upgrade_operations");
    expect(migration).toContain("REFERENCES wallet_events(operation_key, player_id)");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS equipment_audit_events");
    expect(migration).toContain("CHECK (octet_length(details::text) <= 4096)");
    expect(migration).toContain("equipment audit events are append-only");
  });

  it("normalizes retained health once without killing, healing injured players to full, or resetting", () => {
    expect(migration).toContain("WHEN current_health = 0 THEN 0");
    expect(migration).toContain("WHEN current_health >= max_health THEN 100");
    expect(migration).toContain("LEAST(");
    expect(migration).toContain("99,");
    expect(migration).toContain("GREATEST(1,");
    expect(migration).toContain("max_health = 100");
    expect(migration).toContain("persistence_version = persistence_version + 1");
    expect(migration).toContain("WHERE max_health <> 100");
  });
});

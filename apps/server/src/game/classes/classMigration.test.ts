import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const foundation = migration("0300_class_progression_foundation.sql");
const devOperations = migration("0301_dev_progression_operations.sql");
const simplified = migration("0302_simplified_warrior_and_queue_combat.sql");
const telemetry = migration("0303_combat_balance_telemetry.sql");
const hunter = migration("0304_hunter_and_multiclass_foundation.sql");
const paladinCleric = migration("0305_paladin_cleric_foundation.sql");
const clericStarterStaff = migration("0306_cleric_starter_staff.sql");
const damageMatrixV1 = migration("0756_damage_matrix_v1_and_ninja.sql");

describe("simplified Warrior forward migration", () => {
  it("keeps the published 0300 and 0301 migrations byte-for-byte immutable", () => {
    expect(sha256(foundation)).toBe("c4974add2da7f35af44b871c6dbea2047185ce894cf49dff0b2605c60cc429ae");
    expect(sha256(devOperations)).toBe("dee149c9efc16e1e7fd8d272d095e62f9a1c01b13622bd361f92cc6175886d7a");
  });

  it("keeps every published pre-Hunter migration byte-for-byte immutable", () => {
    expect(sha256(simplified)).toBe("f28a7498ede878d7904950d25af6c1e81c3792f61b4db9a1349043c3ca5ba058");
    expect(sha256(telemetry)).toBe("5b8cfe5b3335650aad3e7a6cc1657253d33f7302bb7eda1056c009600ab7fd30");
  });

  it("keeps the published Hunter migration byte-for-byte immutable", () => {
    expect(sha256(hunter)).toBe("865a476b42020e6d967aa674b4167e70238e3727cf7cfc9dafcb20c8bd003db2");
  });

  it("keeps the published Paladin and Cleric migration byte-for-byte immutable", () => {
    expect(sha256(paladinCleric)).toBe("c9890a3a8bf04601031a6435da26e29e3f0f92e3b2876df21f4af3af6ad4b4a3");
  });

  it("allows new Warriors to start at Level 0 and permits Level-0 operation history", () => {
    expect(simplified).toContain("ALTER COLUMN mastery_rank SET DEFAULT 0");
    expect(simplified).toContain("CHECK (mastery_rank BETWEEN 0 AND 25)");
    expect(simplified).toContain("CHECK (previous_rank >= 0)");
    expect(simplified).toContain("'character_level', 'warrior_level', 'warrior_mastery'");
  });

  it("contains the exact 26-entry retained-level XP reconciliation", () => {
    for (const [level, xp] of [
      [0, 0], [1, 100], [2, 300], [3, 700], [4, 1200], [5, 1800],
      [6, 2500], [7, 3300], [8, 4200], [9, 5200], [10, 6300], [11, 7500],
      [12, 8800], [13, 10200], [14, 11700], [15, 13300], [16, 15000],
      [17, 16800], [18, 18700], [19, 20700], [20, 22800], [21, 25000],
      [22, 27500], [23, 30500], [24, 34000], [25, 38000]
    ]) expect(simplified).toContain(`(${level}, ${xp})`);
    expect(simplified).toContain("progress.mastery_rank = thresholds.warrior_level");
  });

  it("adds exact reset, normal, and passive-tier storage with deterministic reconciliation", () => {
    expect(simplified).toContain("reset_active_ids text[] NOT NULL");
    expect(simplified).toContain("normal_active_ids text[] NOT NULL");
    expect(simplified).toContain("passive_tier_ids text[] NOT NULL");
    expect(simplified).toContain("cardinality(reset_active_ids) = 2");
    expect(simplified).toContain("cardinality(normal_active_ids) = 2");
    expect(simplified).toContain("cardinality(passive_tier_ids) = 3");
    expect(simplified).toContain("array_position(loadout.base_active_ids, 'warrior_cleave')");
    expect(simplified).toContain("array_position(loadout.base_active_ids, 'warrior_fortify')");
    expect(simplified).not.toContain("warrior_sundering_blow");
    expect(simplified).not.toContain("warrior_executioners_blow");
  });

  it("archives obsolete learning, zeros dormant Training Points, and never touches legacy rows", () => {
    expect(simplified).toContain("CREATE TABLE IF NOT EXISTS archived_class_technique_unlocks");
    expect(simplified).toContain("ON CONFLICT (player_id, technique_id) DO NOTHING");
    expect(simplified).toContain("DELETE FROM player_class_technique_unlocks");
    expect(simplified).toContain("training_points_spent = 0, training_points_earned = 0");
    expect(simplified).not.toMatch(/DELETE FROM player_class_legacy_unlocks/i);
    expect(simplified).not.toMatch(/UPDATE player_class_legacy_unlocks/i);
  });

  it("invalidates obsolete reconnect actions without deleting earned Rage", () => {
    expect(simplified).toContain("UPDATE player_class_runtime");
    expect(simplified).toContain("rage_reserved = 0");
    expect(simplified).toContain("queued_ability_id = NULL");
    expect(simplified).toContain("cooldown_ends_at = '{}'::jsonb");
    expect(simplified).toContain("status_effects = '[]'::jsonb");
    expect(simplified).toContain("combat_generation = combat_generation + 1");
    expect(simplified).not.toMatch(/SET\s+rage\s*=/i);
  });

  it("uses forward-safe creation and preserves historical subclass progress", () => {
    expect(simplified).toContain("ADD COLUMN IF NOT EXISTS reset_active_ids");
    expect(simplified).toContain("ADD COLUMN IF NOT EXISTS reset_id");
    expect(simplified).not.toMatch(/DELETE FROM player_subclass_progress/i);
    expect(simplified).not.toMatch(/UPDATE player_subclass_progress\s+SET\s+unlocked/i);
    expect(simplified).not.toMatch(/DELETE FROM players|DELETE FROM player_progression_profiles/i);
  });
});

describe("Hunter and multi-class forward migration", () => {
  it("backfills all Hunter-owned state and independent resources idempotently", () => {
    expect(hunter).toContain("Hunter and multi-class foundation");
    expect(hunter).toContain("SELECT id, 'hunter', 0, 0, 0, 0 FROM players");
    expect(hunter).toContain("SELECT id, 'hunter' FROM players");
    expect(hunter).toContain("(VALUES ('sharpshooter'), ('stalker'))");
    expect(hunter).toContain("CREATE TABLE IF NOT EXISTS player_class_resources");
    expect(hunter).toContain("SELECT player_id, 'warrior', 'rage', rage, rage_reserved");
    expect(hunter).toContain("SELECT id, 'hunter', 'focus', 100 FROM players");
    expect((hunter.match(/ON CONFLICT/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it("grants exactly one unequipped starter bow and expands telemetry forward-only", () => {
    expect(hunter).toContain("definition_id = 'starter_bow'");
    expect(hunter).toContain("'starter_bow', players.id, 'inventory', NULL");
    expect(hunter).toContain("equipment_starter_definition_once_idx");
    expect(hunter).toContain("schema_version IN (1, 2)");
    expect(hunter).toContain("active_class_level");
    expect(hunter).not.toMatch(/DELETE FROM players|DELETE FROM player_class_progress|TRUNCATE/i);
  });
});

describe("Paladin and Cleric forward migration", () => {
  it("widens every class, subclass, resource, development, and legacy constraint", () => {
    expect(paladinCleric).toContain("Paladin and Cleric foundation");
    expect(paladinCleric).toContain("active_class_id IN ('warrior', 'hunter', 'paladin', 'cleric')");
    expect(paladinCleric).toContain("'justicar', 'vindicator', 'hierophant', 'exorcist'");
    expect(paladinCleric).toContain("'paladin_level', 'cleric_level'");
    expect(paladinCleric).toContain("resource_id IN ('rage', 'focus', 'conviction', 'faith')");
    expect(paladinCleric).toContain("class_id = 'paladin' AND resource_id = 'conviction'");
    expect(paladinCleric).toContain("class_id = 'cleric' AND resource_id = 'faith'");
    expect(paladinCleric).toContain("'paladin_legacy_sacred_endurance'");
    expect(paladinCleric).toContain("'cleric_legacy_lasting_grace'");
  });

  it("backfills both Level-0 classes, four subclasses, loadouts, resources, and selection keys idempotently", () => {
    expect(paladinCleric).toContain("(VALUES ('paladin'), ('cleric')) AS classes(class_id)");
    expect(paladinCleric).toContain("('paladin', 'justicar')");
    expect(paladinCleric).toContain("('paladin', 'vindicator')");
    expect(paladinCleric).toContain("('cleric', 'hierophant')");
    expect(paladinCleric).toContain("('cleric', 'exorcist')");
    expect(paladinCleric).toContain("('paladin', 'conviction', 0)");
    expect(paladinCleric).toContain("('cleric', 'faith', 0)");
    expect(paladinCleric).toContain("selected_subclasses->'paladin'");
    expect(paladinCleric).toContain("selected_subclasses->'cleric'");
    expect((paladinCleric.match(/ON CONFLICT \(player_id,/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(paladinCleric).not.toMatch(/DELETE FROM|TRUNCATE|DROP TABLE/i);
  });

  it("preserves all previous class selections and rows", () => {
    expect(paladinCleric).toContain("selected_subclasses = selected_subclasses || jsonb_build_object");
    expect(paladinCleric).not.toMatch(/UPDATE player_class_progress\s+SET/i);
    expect(paladinCleric).not.toMatch(/UPDATE player_subclass_progress\s+SET/i);
    expect(paladinCleric).not.toMatch(/UPDATE player_class_resources\s+SET/i);
    expect(paladinCleric).not.toMatch(/UPDATE player_class_legacy_unlocks\s+SET/i);
  });

  it("grants exactly one unequipped Cleric starter staff through the existing equipment ledger", () => {
    expect(paladinCleric).toContain("VALUES ('starter_staff', 'Starter Staff', 'equipment', false, 1)");
    expect(paladinCleric).toContain("'starter_staff', players.id, 'inventory', NULL");
    expect(paladinCleric).toContain("'cleric-starter-staff:' || players.id || ':v1'");
    expect(paladinCleric).toContain("definition_id IN ('starter_sword', 'starter_bow', 'starter_staff', 'padded_tunic')");
    expect(paladinCleric).toContain("equipment.definition_id = 'starter_staff'");
  });
});

describe("Cleric starter-staff retained-database correction", () => {
  it("repeats only the idempotent staff definition, index, operation, and unequipped instance backfill", () => {
    expect(clericStarterStaff).toContain("retained databases that recorded 0305");
    expect(clericStarterStaff).toContain("VALUES ('starter_staff', 'Starter Staff', 'equipment', false, 1)");
    expect(clericStarterStaff).toContain("definition_id IN ('starter_sword', 'starter_bow', 'starter_staff', 'padded_tunic')");
    expect(clericStarterStaff).toContain("'cleric-starter-staff:' || id || ':v1'");
    expect(clericStarterStaff).toContain("'starter_staff', players.id, 'inventory', NULL");
    expect(clericStarterStaff).toContain("equipment.definition_id = 'starter_staff'");
    expect((clericStarterStaff.match(/ON CONFLICT/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("does not revisit class state or destructively alter retained data", () => {
    expect(clericStarterStaff).not.toMatch(/player_class_|player_subclass_|class_progression/i);
    expect(clericStarterStaff).not.toMatch(/DELETE FROM|TRUNCATE|DROP TABLE/i);
  });
});

describe("Damage Matrix V1 and Ninja forward migration", () => {
  it("adds Ninja to durable class state while retaining historical class rows", () => {
    expect(damageMatrixV1).toContain("SELECT id, 'ninja', 0, 0, 3, 0, 0 FROM players");
    expect(damageMatrixV1).toContain("SELECT id, 'ninja' FROM players ON CONFLICT");
    expect(damageMatrixV1).toContain("SELECT id, 'ninja', 'none', 0 FROM players");
    expect(damageMatrixV1).toContain("'master_ninja'");
    expect(damageMatrixV1).toContain("'Master Ninja'");
    expect(damageMatrixV1).toContain("'ninja_level'");
    expect(damageMatrixV1).toContain("'druid','ranger','paladin','knight','cleric','ninja','hunter'");
  });

  it("falls active Druid and Knight players back to Warrior and invalidates runtime state", () => {
    expect(damageMatrixV1).toContain("active_class_id IN ('druid','knight')");
    expect(damageMatrixV1).toContain("SET active_class_id = 'warrior', active_subclass_id = NULL");
    expect(damageMatrixV1).toContain("queued_ability_id = NULL");
    expect(damageMatrixV1).toContain("status_effects = '[]'::jsonb");
    expect(damageMatrixV1).toContain("combat_generation = combat_generation + 1");
    expect(damageMatrixV1).not.toMatch(/DELETE FROM player_class_(?:progress|unlocks|resources)/i);
  });

  it("registers the four new catalog items and preserves staff instances while changing slots", () => {
    for (const itemId of ["starter_shuriken", "starter_wand", "chain_armor", "ranged_shield"]) {
      expect(damageMatrixV1).toContain(`('${itemId}'`);
    }
    expect(damageMatrixV1).toContain("definition_id = 'starter_staff'");
    expect(damageMatrixV1).toContain("SET location = 'inventory', equipped_slot = NULL");
    expect(damageMatrixV1).toContain("SET equipped_slot = 'melee'");
    expect(damageMatrixV1).not.toMatch(/DELETE FROM equipment_instances/i);
    expect(damageMatrixV1).not.toMatch(/TRUNCATE/i);
  });
});

function migration(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../../db/migrations/${file}`, import.meta.url)),
    "utf8"
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

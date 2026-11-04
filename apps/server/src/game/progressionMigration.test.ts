import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const progression = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0014_player_progression.sql", import.meta.url)),
  "utf8"
);
const settlement = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0015_combat_reward_settlement.sql", import.meta.url)),
  "utf8"
);
const curveV3 = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0732_progression_curve_v3.sql", import.meta.url)),
  "utf8"
);

describe("progression migrations", () => {
  it("enforces one capped versioned profile and one XP operation key", () => {
    expect(progression).toContain("player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE");
    expect(progression).toContain("CHECK (total_xp BETWEEN 0 AND 500000)");
    expect(progression).toContain("CHECK (level BETWEEN 0 AND 25)");
    expect(progression).toContain("persistence_version bigint NOT NULL DEFAULT 0");
    expect(progression).toContain("operation_key text NOT NULL UNIQUE");
    expect(progression).toContain("CHECK (requested_xp = granted_xp + discarded_xp)");
  });

  it("separates unique equipment instances and durable encounter settlement", () => {
    expect(settlement).toContain("CREATE TABLE IF NOT EXISTS equipment_instances");
    expect(settlement).toContain("equipment_one_slot_per_player_idx");
    expect(settlement).toContain("equipment_starter_definition_once_idx");
    expect(settlement).toContain("UNIQUE (defeated_mob_instance_id, mob_life_generation)");
    expect(settlement).toContain("PRIMARY KEY (settlement_key, player_id)");
  });

  it("migrates Curve V3 through an append-only reconciliation ledger", () => {
    expect(curveV3).toContain("character_xp_curve_adjustments");
    expect(curveV3).toContain("CHECK (total_xp BETWEEN 0 AND 1000000)");
    expect(curveV3).toContain("'progression-curve:v2-to-v3:' || player_id");
    expect(curveV3).toContain("profile.curve_version = 2");
    expect(curveV3).not.toContain("UPDATE xp_operations");
    expect(curveV3).not.toContain("UPDATE xp_events");
  });
});

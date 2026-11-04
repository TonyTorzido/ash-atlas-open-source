import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0647_menu_pet_raising.sql", import.meta.url)),
  "utf8"
);

describe("menu pet raising migration", () => {
  it("enforces one active pet, one species completion, bounded progress, and UTC-day uniqueness", () => {
    expect(migration).toContain("UNIQUE (player_id, species)");
    expect(migration).toContain("player_pets_one_active_per_player");
    expect(migration).toContain("WHERE status = 'active'");
    expect(migration).toContain("care_days BETWEEN 0 AND 30");
    expect(migration).toContain("PRIMARY KEY (pet_id, care_date)");
  });

  it("requires complete daily evidence and unique durable milestones", () => {
    expect(migration).toContain("pet_daily_care_progress_complete");
    expect(migration).toContain("checked_in_at IS NOT NULL");
    expect(migration).toContain("fed_at IS NOT NULL");
    expect(migration).toContain("interacted_at IS NOT NULL");
    expect(migration).toContain("PRIMARY KEY (pet_id, milestone_key)");
  });
});

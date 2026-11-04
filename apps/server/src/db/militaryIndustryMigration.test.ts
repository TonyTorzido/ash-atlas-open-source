import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(
  new URL("../../../../db/migrations/0821_military_industry_foundation.sql", import.meta.url)
), "utf8");

describe("Military Industry Foundation migration", () => {
  it("creates repeat-safe Lodge, roster, and personal facility-job persistence", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS player_lodges");
    expect(migration).toContain("player_lodges_active_owner_idx");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS military_personnel");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS military_facility_jobs");
    expect(migration).toContain("UNIQUE(owner_player_id,request_id)");
    expect(migration).toContain("military_personnel_training_job_fk");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS military_job_operations");
  });

  it("keeps the foundation free of deployed warfare state and adds all four City facilities", () => {
    expect(migration).toContain("'barracks', 'siege_workshop', 'powder_works'");
    expect(migration).toContain("'weaponsmith', 'barracks', 'siege_workshop', 'powder_works'");
    expect(migration).not.toContain("CREATE TABLE deployed_siege");
    expect(migration).not.toContain("black_powder");
    expect(migration).not.toContain("demolition_charge");
  });
});

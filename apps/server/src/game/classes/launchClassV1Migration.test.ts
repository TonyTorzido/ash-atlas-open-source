import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../../../db/migrations/0734_launch_class_system_v1.sql", import.meta.url), "utf8");

describe("launch class V1 migration policy", () => {
  it("uses durable v1 authority and records deterministic v3 projections", () => {
    expect(migration).toContain("curve_version = 1");
    expect(migration).toContain("class_xp_curve_adjustments");
    expect(migration).toContain("source_max_xp = 38000");
    expect(migration).not.toMatch(/CASE\s+WHEN\s+previous_xp\s+[<>]=?\s+38000\s+THEN\s+1/iu);
  });

  it("keeps Ranger class and Hunter profession storage separate", () => {
    expect(migration).toContain("CASE class_id WHEN 'hunter' THEN 'ranger'");
    expect(migration).not.toContain("UPDATE player_profession_progress");
  });

  it("makes Warrior free, paid unlocks exactly 50k, and invalid active classes safe", () => {
    expect(migration).toContain("class_id = 'warrior' AND gold_paid = 0");
    expect(migration).toContain("class_id <> 'warrior' AND gold_paid = 50000");
    expect(migration).toContain("SET active_class_id = 'warrior'");
  });

  it("registers Hammer and Leather Armor without changing profession or character curves", () => {
    expect(migration).toContain("('hammer','Hammer','equipment',false,1,false,true,false,false");
    expect(migration).toContain("('leather_armor','Leather Armor','equipment',false,1,false,true,false,false");
    expect(migration).not.toContain("player_progression_profiles SET total_xp");
  });
});

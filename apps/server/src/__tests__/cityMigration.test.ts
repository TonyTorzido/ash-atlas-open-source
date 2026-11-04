import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "../../db/migrations/0200_city_foundation.sql"), "utf8");
const mayorSql = readFileSync(
  resolve(process.cwd(), "../../db/migrations/0643_city_mayoral_control.sql"),
  "utf8"
);
const membershipLifecycleSql = readFileSync(
  resolve(process.cwd(), "../../db/migrations/0644_city_membership_lifecycle.sql"),
  "utf8"
);
const founderMayorClaimRepairSql = readFileSync(
  resolve(process.cwd(), "../../db/migrations/0708_city_founder_mayor_claim.sql"),
  "utf8"
);
const allCityMonumentsSql = readFileSync(
  resolve(process.cwd(), "../../db/migrations/0791_all_city_monuments.sql"),
  "utf8"
);

describe("city foundation migration", () => {
  it("enforces lifecycle, membership, one active city per settlement, spatial halls, and flag linkage", () => {
    expect(sql).toContain("UNIQUE (founder_player_id, founding_request_id)");
    expect(sql).toMatch(/UNIQUE INDEX[\s\S]+world_settlement_id[\s\S]+WHERE active/);
    expect(sql).toContain("hall_geom geometry(Point, 4326)");
    expect(sql).toContain("city_id uuid NULL REFERENCES cities(id)");
    expect(sql).toContain("rebuild_available_at timestamptz NULL");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS city_memberships");
    expect(sql).toContain("cities_rebuild_cooldown_idx");
    expect(sql).toContain("'destroyed', 'abandoned'");
    expect(sql).toContain("Backfill authoritative founder membership");
  });

  it("backfills transferable mayor control without replacing immutable founder history", () => {
    expect(mayorSql).toContain("ADD COLUMN IF NOT EXISTS mayor_player_id");
    expect(mayorSql).toContain("SET mayor_player_id = founder_player_id");
    expect(mayorSql).toContain("cities_one_active_mayoralty_per_player");
    expect(mayorSql).toContain("'claim_city_mayor'");
    expect(mayorSql).toContain("'relinquish_city_mayor'");
  });

  it("enforces one active membership per player and world while retaining history", () => {
    expect(membershipLifecycleSql).toContain("SET world_id = city.world_id");
    expect(membershipLifecycleSql).toContain(
      "city_memberships_one_active_per_player_world_idx"
    );
    expect(membershipLifecycleSql).toMatch(
      /ON city_memberships \(player_id, world_id\)[\s\S]+WHERE left_at IS NULL/
    );
    expect(membershipLifecycleSql).toContain(
      "duplicate active city memberships exist for one player and world"
    );
    expect(membershipLifecycleSql).toContain("'leave_city'");
  });

  it("repairs automatic founder Mayors while preserving durable explicit claims", () => {
    expect(founderMayorClaimRepairSql).toContain("operation.action = 'claim_mayor'");
    expect(founderMayorClaimRepairSql).toContain(
      "event.event_type = 'promoted_to_mayor_house'"
    );
    expect(founderMayorClaimRepairSql).toContain(
      "SET structure_type = 'city_house'"
    );
    expect(founderMayorClaimRepairSql).toContain("SET role = 'member'");
    expect(founderMayorClaimRepairSql).toContain(
      "candidate.created_at + interval '15 minutes'"
    );
  });

  it("preserves legacy Monuments while reserving one live row per supported type", () => {
    expect(allCityMonumentsSql).toContain("SET district_type = 'mining'");
    expect(allCityMonumentsSql).toContain("SET selected_district = 'mining'");
    expect(allCityMonumentsSql).toMatch(
      /ON city_structures \(city_id, district_type\)[\s\S]+state IN \('constructing', 'active'\)/
    );
    expect(allCityMonumentsSql).toContain(
      "district_type IN ('mining', 'forestry', 'hunting')"
    );
  });
});

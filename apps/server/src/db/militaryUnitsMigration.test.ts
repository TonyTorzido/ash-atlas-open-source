import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(
  new URL("../../../../db/migrations/0822_military_units_war_camp.sql", import.meta.url)
), "utf8");

describe("military units and War Camp migration", () => {
  it("retires legacy Siege Crew rows through a repeat-safe value-preserving ledger", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS military_siege_crew_retirements");
    expect(migration).toContain("ON CONFLICT (personnel_id) DO NOTHING");
    expect(migration).toContain("military-siege-crew-retirement:");
    expect(migration).toContain("version_after");
    expect(migration).toContain("UPDATE player_lodges lodge");
    expect(migration).toContain("DELETE FROM military_personnel WHERE personnel_type = 'siege_crew'");
    expect(migration).not.toMatch(/INSERT INTO military_units[\s\S]*FROM military_personnel/);
  });

  it("creates durable member, group, rally, and siege state without organization warfare", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS military_units");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS military_unit_groups");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS war_camps");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS military_rally_operations");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS military_siege_operations");
    expect(migration).toContain("status IN ('pending','complete','cancelled')");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).not.toMatch(/CREATE TABLE IF NOT EXISTS (?:city|kingdom|organization).*war/i);
  });

  it("registers Demolition Charge as Player Market and Manor-storable, but not Goblin Market", () => {
    expect(migration).toContain("'demolition_charge', 'Demolition Charge'");
    expect(migration).toContain("manor_storable, market_tradable, market_fungible");
    expect(migration).toContain("market_tradable = EXCLUDED.market_tradable");
  });
});

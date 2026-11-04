import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(process.cwd(), "../../db/migrations/0400_kingdom_foundation.sql");
const hardeningPath = path.resolve(process.cwd(), "../../db/migrations/0401_kingdom_ledger_immutability.sql");
const foundationHardeningPath = path.resolve(process.cwd(), "../../db/migrations/0402_kingdom_foundation_hardening.sql");
const correctnessIndexPath = path.resolve(process.cwd(), "../../db/migrations/0403_kingdom_request_retention_index.sql");
const kingdomFlagAffiliationPath = path.resolve(process.cwd(), "../../db/migrations/0620_kingdom_flag_affiliation.sql");
const kingdomFlagControlPath = path.resolve(process.cwd(), "../../db/migrations/0621_kingdom_flag_control.sql");
const kingdomSeatSourceFlagPath = path.resolve(process.cwd(), "../../db/migrations/0622_kingdom_seat_source_flag.sql");
const kingdomSeatPhysicalPlacementPath = path.resolve(
  process.cwd(),
  "../../db/migrations/0676_kingdom_seat_physical_placement.sql"
);
const advancementProjectsPath = path.resolve(
  process.cwd(),
  "../../db/migrations/0699_kingdom_advancement_projects.sql"
);

describe("0400 Kingdom foundation migration", () => {
  it("encodes durable membership, placement, ledger, and spatial invariants", async () => {
    const sql = await readFile(migrationPath, "utf8");
    for (const table of [
      "kingdoms",
      "kingdom_seats",
      "kingdom_memberships",
      "kingdom_invitations",
      "kingdom_chat_messages",
      "kingdom_chat_mutes",
      "kingdom_treasury_balances",
      "kingdom_donations",
      "kingdom_xp_ledger",
      "kingdom_cots",
      "kingdom_decoration_definitions",
      "kingdom_decorations",
      "kingdom_requests",
      "kingdom_audit_events"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("kingdom_memberships_one_active_per_player_idx");
    expect(sql).toContain("kingdom_memberships_one_leader_idx");
    expect(sql).toContain("kingdom_seats_one_active_per_kingdom_idx");
    expect(sql).toContain("kingdom_cots_one_active_per_member_idx");
    expect(sql).toContain("kingdom_seats_geom_active_gix");
    expect(sql).toContain("kingdom_decorations_geom_active_gix");
    expect(sql).toContain("kingdom_donations_donor_request_unique");
    expect(sql).not.toMatch(/03\d\d_/);
  });

  it("enforces append-only financial, XP, and audit history", async () => {
    const sql = await readFile(hardeningPath, "utf8");
    expect(sql).toContain("kingdom_donations_append_only");
    expect(sql).toContain("kingdom_xp_ledger_append_only");
    expect(sql).toContain("kingdom_audit_events_append_only");
    expect(sql).toContain("BEFORE UPDATE OR DELETE");
  });

  it("indexes the geography expressions and redacts retained chat replay payloads", async () => {
    const sql = await readFile(foundationHardeningPath, "utf8");
    expect(sql).toContain("kingdom_seats_geography_active_gix");
    expect(sql).toContain("kingdom_cots_geography_active_gix");
    expect(sql).toContain("kingdom_decorations_geography_active_gix");
    expect(sql).toContain("operation = 'chat_send'");
    expect(sql).toContain("messageId");
  });

  it("indexes actor-scoped replay retention cleanup", async () => {
    const sql = await readFile(correctnessIndexPath, "utf8");
    expect(sql).toContain("kingdom_requests_actor_created_idx");
    expect(sql).toContain("(actor_player_id, created_at)");
  });

  it("adds exclusive, indexed, history-preserving Kingdom Flag affiliation", async () => {
    const sql = await readFile(kingdomFlagAffiliationPath, "utf8");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS kingdom_id uuid NULL");
    expect(sql).toContain("flags_city_kingdom_exclusive");
    expect(sql).toContain("flags_kingdom_affiliation_lifecycle_valid");
    expect(sql).toContain("flags_kingdom_active_idx");
    expect(sql).toContain("flags_kingdom_owner_idx");
    expect(sql).toContain("flags_kingdom_geom_gix");
    expect(sql).toContain("flags_prevent_affiliated_owner_transfer");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS kingdom_flag_affiliation_history");
    expect(sql).toContain("players_current_kingdom_seat_id_fkey");
    expect(sql).toContain("players_current_destination_exclusive");
  });

  it("adds explicit control transfer, Kingdom color, attribution, and mixed geometry enforcement forward-only", async () => {
    const sql = await readFile(kingdomFlagControlPath, "utf8");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS display_color");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS control_type");
    expect(sql).toContain("original_owner_player_id");
    expect(sql).toContain("contributed_by_player_id");
    expect(sql).toContain("original_personal_color");
    expect(sql).toContain("flags_control_state_valid");
    expect(sql).toContain("flags_mixed_control_geometry");
    expect(sql).toContain("tolerance_m constant double precision := 0.05");
    expect(sql).not.toContain("UPDATE flags\nSET control_type = 'kingdom'\nWHERE kingdom_id IS NULL");
  });

  it("links transformed source flags to Seats without rewriting historical rows", async () => {
    const sql = await readFile(kingdomSeatSourceFlagPath, "utf8");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS source_flag_id uuid NULL");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS kingdom_founding_request_id text NULL");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS kingdom_founding_reserved_at timestamptz NULL");
    expect(sql).toContain("kingdom_seats_source_flag_id_fkey");
    expect(sql).toContain("kingdom_seats_source_flag_unique_idx");
    expect(sql).toContain("control_type IN ('personal', 'kingdom', 'kingdom_seat')");
    expect(sql).toContain("kingdom_seats_source_flag_identity");
    expect(sql).toContain("flags_kingdom_seat_source_identity");
    expect(sql).toContain("seat.source_flag_id IS DISTINCT FROM NEW.id");
    expect(sql).not.toMatch(/UPDATE\s+flags\s+SET\s+control_type\s*=\s*'kingdom_seat'/i);
  });

  it("allows a Castle anywhere inside its unchanged source territory", async () => {
    const sql = await readFile(kingdomSeatPhysicalPlacementPath, "utf8");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION enforce_kingdom_seat_source_flag()");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION enforce_source_flag_kingdom_seat_identity()");
    expect(sql).toContain("source.claim_radius_m + tolerance_m");
    expect(sql).toContain("NEW.claim_radius_m + tolerance_m");
    expect(sql).not.toContain("source.geom = NEW.geom");
    expect(sql).not.toMatch(/\bUPDATE\s+(flags|kingdom_seats)\b/i);
  });

  it("adds lifecycle-constrained advancement projects and immutable treasury spending", async () => {
    const sql = await readFile(advancementProjectsPath, "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS kingdom_projects");
    expect(sql).toContain("kingdom_projects_one_pending_advancement_idx");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS kingdom_treasury_expenditures");
    expect(sql).toContain("kingdom_treasury_expenditures_append_only");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("'advancement_project'");
    expect(sql).not.toMatch(/\bUPDATE\s+kingdoms\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+kingdom_donations\b/i);
  });
});

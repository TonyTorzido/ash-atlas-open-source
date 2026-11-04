import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0608_player_travel_invites.sql", import.meta.url)),
  "utf8"
);
const layerAnchorMigration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0648_travel_invite_layer_anchors.sql", import.meta.url)),
  "utf8"
);
const sendRateMigration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0752_travel_invite_send_rate.sql", import.meta.url)),
  "utf8"
);

describe("0607 player travel invite migration", () => {
  it("stores one authoritative invite with exact expiration and two linked inbox perspectives", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS travel_invites");
    expect(migration).toContain("expires_at = created_at + interval '10 minutes'");
    expect(migration).toContain("travel_invites_one_active_pair_idx");
    expect(migration).toContain("WHERE status IN ('pending', 'accepting')");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS player_inbox_entries");
    expect(migration).toContain("UNIQUE (travel_invite_id, perspective)");
    expect(migration).toContain("perspective IN ('sender', 'recipient')");
  });

  it("binds destinations to server-owned sessions and flags and persists idempotency", () => {
    expect(migration).toContain("inviter_session_id uuid NOT NULL");
    expect(migration).not.toContain("inviter_session_id uuid NOT NULL REFERENCES auth_sessions");
    expect(migration).toContain("source_flag_id uuid NOT NULL REFERENCES flags(id)");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS travel_invite_operations");
    expect(migration).toContain("PRIMARY KEY (player_id, request_id)");
  });

  it("adds opt-in party travel settings and resets leader permission on succession", () => {
    expect(migration).toContain("allow_party_travel boolean NOT NULL DEFAULT false");
    expect(migration).toContain("auto_follow_party_leader boolean NOT NULL DEFAULT false");
    expect(migration).toMatch(/leader_player_id = successor,[\s\S]*allow_party_travel = false/);
  });
});

describe("0648 Travel Invite layer anchors", () => {
  it("makes flags optional and stores the authoritative layer identity and epochs", () => {
    expect(layerAnchorMigration).toContain("ALTER COLUMN source_flag_id DROP NOT NULL");
    expect(layerAnchorMigration).toContain("layer_scope_id");
    expect(layerAnchorMigration).toContain("layer_id");
    expect(layerAnchorMigration).toContain("layer_relocation_revision");
    expect(layerAnchorMigration).toContain("layer_generation");
    expect(layerAnchorMigration).toContain("source_type");
    expect(layerAnchorMigration).toContain("source_id");
  });

  it("invalidates unverified pre-anchor invites and preserves terminal history", () => {
    expect(layerAnchorMigration).toContain("WHERE status IN ('pending', 'accepting')");
    expect(layerAnchorMigration).toContain("gameplay layer must be reconfirmed");
    expect(layerAnchorMigration).not.toContain("DELETE FROM travel_invites");
  });
});

describe("0752 Travel Invite send rate", () => {
  it("bounds recent authoritative sender history lookups", () => {
    expect(sendRateMigration).toContain("travel_invites_inviter_created_idx");
    expect(sendRateMigration).toContain("inviter_player_id, created_at DESC");
  });
});

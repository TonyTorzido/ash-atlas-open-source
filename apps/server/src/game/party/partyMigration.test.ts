import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const durablePartyMigration = readFileSync(
  fileURLToPath(new URL("../../../../../db/migrations/0307_durable_party_authority.sql", import.meta.url)),
  "utf8"
);
const consentReplayMigration = readFileSync(
  fileURLToPath(new URL("../../../../../db/migrations/0308_party_consent_replay_and_lease.sql", import.meta.url)),
  "utf8"
);

describe("durable explicit-party migration", () => {
  it("enforces one party per player and leader membership", () => {
    expect(durablePartyMigration).toContain("CREATE TABLE IF NOT EXISTS parties");
    expect(durablePartyMigration).toContain("CREATE TABLE IF NOT EXISTS party_members");
    expect(durablePartyMigration).toContain("party_members_one_party_per_player_key UNIQUE (player_id)");
    expect(durablePartyMigration).toContain("FOREIGN KEY (party_id, leader_player_id)");
    expect(durablePartyMigration).toContain("DEFERRABLE INITIALLY DEFERRED");
  });

  it("owns deterministic leader succession and revision changes in the database", () => {
    expect(durablePartyMigration).toContain("maintain_party_after_member_delete");
    expect(durablePartyMigration).toContain("SELECT min(player_id) INTO successor");
    expect(durablePartyMigration).toContain("revision = revision + 1");
    expect(durablePartyMigration).toContain("DELETE FROM parties WHERE party_id = OLD.party_id");
  });

  it("is forward-only and explicitly prohibits inferred kingdom membership", () => {
    expect(durablePartyMigration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM players/i);
    expect(durablePartyMigration).toContain("never derive membership from kingdom");
    expect(durablePartyMigration).not.toMatch(/kingdom_id|region_code|zone_id|distance/i);
    expect(durablePartyMigration).toContain("IF NOT EXISTS");
    expect(durablePartyMigration).toContain("DROP CONSTRAINT IF EXISTS party_leader_membership_fk");
    expect(durablePartyMigration).toContain("DROP TRIGGER IF EXISTS");
  });
});

describe("party consent and replay migration", () => {
  it("stores expiring target consent without creating membership", () => {
    expect(consentReplayMigration).toContain("CREATE TABLE IF NOT EXISTS party_invites");
    expect(consentReplayMigration).toContain("PRIMARY KEY (party_id, target_player_id)");
    expect(consentReplayMigration).toContain("REFERENCES party_members(party_id, player_id)");
    expect(consentReplayMigration).toContain("expires_at > issued_at");
    expect(consentReplayMigration).not.toMatch(/INSERT INTO party_members/i);
  });

  it("reserves request IDs durably per authenticated actor and payload", () => {
    expect(consentReplayMigration).toContain("CREATE TABLE IF NOT EXISTS party_operations");
    expect(consentReplayMigration).toContain("PRIMARY KEY (player_id, request_id)");
    expect(consentReplayMigration).toContain("payload jsonb NOT NULL");
    expect(consentReplayMigration).toContain("completed_at timestamptz NULL");
    for (const action of ["create", "invite", "accept", "decline", "remove", "leave", "change_leader"]) {
      expect(consentReplayMigration).toContain(`'${action}'`);
    }
  });

  it("is forward-only, idempotent, and explicitly rejects inferred authority", () => {
    expect(consentReplayMigration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM players/i);
    expect(consentReplayMigration).toContain("IF NOT EXISTS");
    expect(consentReplayMigration).toContain("no kingdom, region, proximity, or combat state");
  });
});

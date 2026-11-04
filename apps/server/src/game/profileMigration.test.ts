import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0100_profile_social_foundation.sql", import.meta.url)),
  "utf8"
);
const socialInboxMigration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0698_social_inbox_entries.sql", import.meta.url)),
  "utf8"
);

describe("0100 profile/social migration", () => {
  it("creates separate normalized relationship tables in the owned range", () => {
    for (const table of ["player_profiles", "friend_requests", "friendships", "player_enemy_marks", "player_blocks"]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration).not.toMatch(/jsonb|email|last_seen/i);
  });

  it("enforces canonical pairs, no self relationships, uniqueness, and cascades", () => {
    expect(migration).toContain("PRIMARY KEY (player_low_id, player_high_id)");
    expect(migration).toContain("CHECK (player_low_id < player_high_id)");
    expect(migration).toContain("CHECK (requester_id <> recipient_id)");
    expect(migration).toContain("CHECK (owner_id <> target_id)");
    expect(migration).toContain("CHECK (blocker_id <> blocked_id)");
    expect(migration.match(/ON DELETE CASCADE/g)?.length).toBeGreaterThanOrEqual(9);
  });

  it("indexes incoming, outgoing, friend, enemy, block, and target lookups", () => {
    for (const index of [
      "friend_requests_recipient_created_idx",
      "friend_requests_requester_created_idx",
      "friendships_low_created_idx",
      "friendships_high_created_idx",
      "player_enemy_marks_owner_created_idx",
      "player_blocks_blocker_created_idx",
      "player_blocks_blocked_idx"
    ]) expect(migration).toContain(index);
  });
});

describe("0698 social inbox migration", () => {
  it("extends the existing inbox with durable idempotent social event projections", () => {
    expect(socialInboxMigration).toContain("ALTER TABLE player_inbox_entries");
    expect(socialInboxMigration).toContain("player_inbox_entries_friend_request_unique");
    expect(socialInboxMigration).toContain("player_inbox_entries_enemy_declaration_unique");
    expect(socialInboxMigration).toContain("friend_requests_id_unique");
    expect(socialInboxMigration).toContain("player_enemy_marks_id_unique");
  });
});

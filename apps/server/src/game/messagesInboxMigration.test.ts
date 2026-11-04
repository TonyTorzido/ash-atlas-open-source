import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0667_authoritative_messages_receipts.sql", import.meta.url)),
  "utf8"
);

describe("authoritative Messages receipts migration", () => {
  it("adds durable revision-aware read state without destructive player changes", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS player_inbox_read_receipts");
    expect(migration).toContain("PRIMARY KEY (player_id, entry_key)");
    expect(migration).toContain("read_revision text NOT NULL");
    expect(migration).not.toMatch(/TRUNCATE|DELETE FROM players|DROP TABLE/i);
  });

  it("converts party invitations to retained uniquely identified lifecycle records", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS id uuid");
    expect(migration).toContain("ADD CONSTRAINT party_invites_pkey PRIMARY KEY (id)");
    for (const status of ["pending", "accepted", "declined", "cancelled", "expired", "invalidated"]) {
      expect(migration).toContain(`'${status}'`);
    }
    expect(migration).toContain("party_invites_one_pending_target_idx");
  });
});

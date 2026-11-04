import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../../db/migrations/0609_durable_combat_reward_inbox.sql", import.meta.url)
  ),
  "utf8"
);

describe("0609 durable combat reward inbox migration", () => {
  it("stores raw candidates and supports retryable leased claims", () => {
    expect(migration).toContain("candidate jsonb");
    expect(migration).toContain("failure_count integer");
    expect(migration).toContain("next_retry_at timestamptz");
    expect(migration).toContain("lease_expires_at timestamptz");
    expect(migration).toContain("combat_reward_inbox_claim_idx");
    expect(migration).toContain("combat_reward_inbox_expired_lease_idx");
  });
});

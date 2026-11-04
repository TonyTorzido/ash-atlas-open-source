import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0850_sign_in_with_apple.sql", import.meta.url)),
  "utf8"
);

describe("0850 Sign in with Apple migration", () => {
  it("keeps provider identity and session invariants explicit", () => {
    expect(migration).toContain("CHECK (provider IN ('google', 'apple'))");
    expect(migration).toContain("provider = 'apple'");
    expect(migration).toContain("apple_email_forwarding_enabled boolean NULL");
    expect(migration).toContain("ALTER COLUMN identity_id SET NOT NULL");
    expect(migration).toContain("FOREIGN KEY (identity_id) REFERENCES account_identities(id)");
    expect(migration).toContain("identity_status IN ('active', 'revoked')");
  });

  it("adds single-use state, encrypted-token metadata, and durable revocation jobs", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS apple_auth_transactions");
    expect(migration).toContain("state_hash text NOT NULL UNIQUE");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS apple_revocation_jobs");
    expect(migration).toContain("apple_refresh_token_ciphertext");
    expect(migration).toContain("apple_revocation_completed_at");
    expect(migration).not.toMatch(/access_token|id_token|private_key|raw_code|raw_nonce/i);
  });
});

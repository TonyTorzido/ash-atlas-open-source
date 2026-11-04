import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0848_account_deletion_requests.sql", import.meta.url)),
  "utf8"
);

describe("0848 account deletion requests migration", () => {
  it("creates a durable request queue with explicit verification states", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS account_deletion_requests");
    expect(migration).toContain("account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL");
    expect(migration).toContain("request_source IN ('authenticated', 'public')");
    expect(migration).toContain("'pending_verification'");
    expect(migration).toContain("'pending_processing'");
    expect(migration).toContain("'processing'");
    expect(migration).toContain("account_deletion_requests_active_key_idx");
    expect(migration).toContain("account_deletion_requests_active_email_idx");
  });

  it("does not perform destructive account or player writes", () => {
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+(accounts|players)/i);
    expect(migration).not.toMatch(/\bUPDATE\s+(accounts|players)\b/i);
  });
});

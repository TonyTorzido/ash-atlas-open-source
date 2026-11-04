import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0880_email_login_identity.sql", import.meta.url)),
  "utf8"
);

describe("0880 email login identity migration", () => {
  it("admits the email provider with the Google-style verified-email shape", () => {
    expect(migration).toContain("CHECK (provider IN ('google', 'apple', 'email'))");
    expect(migration).toContain("provider IN ('google', 'email') AND email IS NOT NULL AND email_verified = true");
    expect(migration).toContain("claimed_provider IN ('google', 'apple', 'email')");
    expect(migration).toContain("claimed_provider IN ('apple', 'email')");
  });

  it("stores only hashed, single-use, attempt-bounded codes", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS email_login_codes");
    expect(migration).toContain("code_hash text NOT NULL CHECK (char_length(code_hash) = 64)");
    expect(migration).toContain("attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5)");
    expect(migration).toContain("CHECK (consumed_at IS NULL OR invalidated_at IS NULL)");
    expect(migration).toContain("REFERENCES auth_sessions(id)");
    expect(migration).toContain("REFERENCES device_installations(id) ON DELETE SET NULL");
    expect(migration).not.toMatch(/\braw_code\b|\bcode text\b/i);
  });
});

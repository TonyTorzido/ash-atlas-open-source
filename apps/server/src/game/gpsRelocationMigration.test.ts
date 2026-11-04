import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0812_gps_relocation.sql", import.meta.url)),
  "utf8"
).replace(/\r\n/gu, "\n");

describe("0812 GPS relocation migration", () => {
  it("adds nullable durable relocation state and a selective lookup index", () => {
    expect(migration).toContain(
      "ALTER TABLE players\n  ADD COLUMN IF NOT EXISTS last_relocated_at timestamptz NULL"
    );
    expect(migration).toContain(
      "CREATE INDEX IF NOT EXISTS players_last_relocated_at_idx"
    );
    expect(migration).toContain("WHERE last_relocated_at IS NOT NULL");
  });

  it("is additive and safe to reapply", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS");
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM)\b/iu);
  });
});

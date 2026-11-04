import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../../db/migrations/0757_free_class_unlocks.sql", import.meta.url)),
  "utf8"
);

describe("free class unlock migration policy", () => {
  it("allows free unlock records while preserving historical payments", () => {
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS player_class_unlocks_gold_paid_check");
    expect(migration).toContain("CHECK (gold_paid IN (0, 50000))");
    expect(migration).toContain("new class unlocks are free");
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE\s+FROM)\s+player_class_unlocks\b/iu);
  });
});

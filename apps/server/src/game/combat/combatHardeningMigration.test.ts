import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../../db/migrations/0013_combat_runtime_hardening.sql", import.meta.url)
  ),
  "utf8"
);

describe("0013 combat runtime hardening migration", () => {
  it("adds a monotonic durable combat profile version", () => {
    expect(migration).toContain("persistence_version bigint NOT NULL DEFAULT 0");
    expect(migration).toContain("CHECK (persistence_version >= 0)");
  });
});

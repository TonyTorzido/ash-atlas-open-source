import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../../db/migrations/0707_population_kind_manifest.sql",
    import.meta.url
  ),
  "utf8"
);

describe("0707 Population V2 kind manifest", () => {
  it("separates common schema identity from per-kind revisions", () => {
    expect(migration).toContain(
      "ADD COLUMN common_schema_revision text NULL"
    );
    expect(migration).toContain(
      "CREATE TABLE population_generation_kind_manifest_v2"
    );
    expect(migration).toContain("kind_key text NOT NULL");
    expect(migration).toContain("placement_revision text NOT NULL");
    expect(migration).toContain("lifecycle_revision text NOT NULL");
    expect(migration).toContain(
      "source IN ('generation', 'top_up')"
    );
    expect(migration).toContain("group_atomic boolean NOT NULL");
  });

  it("does not relabel, regenerate, or delete existing generations", () => {
    expect(migration).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO|FROM)?\s*population_/iu
    );
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    expect(migration).toContain(
      "absence preserves legacy-reader compatibility"
    );
  });
});

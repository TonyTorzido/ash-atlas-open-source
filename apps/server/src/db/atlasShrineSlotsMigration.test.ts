import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../db/migrations/0700_authoritative_atlas_shrine_slots.sql",
      import.meta.url
    )
  ),
  "utf8"
);

describe("authoritative Atlas Shrine slot migration", () => {
  it("adds bounded owner-unique active shrine slots", () => {
    expect(migration).toContain("atlas_shrine_slot_number smallint");
    expect(migration).toContain("atlas_shrine_slot_number BETWEEN 1 AND 25");
    expect(migration).toContain("flags_active_atlas_shrine_owner_slot_unique");
    expect(migration).toContain("ON flags (owner_id, atlas_shrine_slot_number)");
  });

  it("orders the backfill stably and repairs only generated names", () => {
    expect(migration).toContain(
      "ORDER BY flag.reinforced_at NULLS LAST, flag.created_at, flag.id"
    );
    expect(migration).toContain("btrim(flag.name) ~ '^Flag [0-9]+$'");
    expect(migration).toContain("btrim(flag.name) = 'Atlas Shrine'");
    expect(migration).toContain("left(player.username, 25) || '''s Atlas Shrine'");
    expect(migration).not.toMatch(/OR\s+btrim\(flag\.name\)\s*=\s*'Home'/);
  });
});

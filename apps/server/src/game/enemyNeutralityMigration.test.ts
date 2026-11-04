import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0639_mutual_enemies_and_neutrality.sql", import.meta.url)),
  "utf8"
);

describe("0639 mutual enemies and neutrality migration", () => {
  it("normalizes directional marks into a canonical pair without dropping relationship history", () => {
    expect(migration).toContain("LEAST(owner_id, target_id)");
    expect(migration).toContain("GREATEST(owner_id, target_id)");
    expect(migration).toContain("MIN(created_at)");
    expect(migration).toContain("ON CONFLICT (owner_id, target_id) DO UPDATE");
    expect(migration).toContain("CHECK (owner_id < target_id)");
  });

  it("creates one durable expiring neutrality negotiation per canonical enemy pair", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS enemy_neutrality_requests");
    expect(migration).toContain("PRIMARY KEY (player_low_id, player_high_id)");
    expect(migration).toContain("CHECK (player_low_id < player_high_id)");
    expect(migration).toContain("enemy_neutrality_requests_expiry_idx");
    expect(migration).toContain("ON DELETE CASCADE");
  });
});

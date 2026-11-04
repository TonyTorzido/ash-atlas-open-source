import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(new URL(
  "../../../../db/migrations/0783_rank_three_specialization_commitment.sql",
  import.meta.url
)), "utf8");

describe("Rank 3 specialization commitment migration", () => {
  it("preserves qualifying commitment, prefers qualifying active, then uses deterministic rank and ID order", () => {
    expect(migration).toContain("WHEN committed.rank >= 3 THEN state.committed_specialization_id");
    expect(migration).toContain("WHEN active.rank >= 3 THEN state.active_specialization_id");
    expect(migration).toContain("ORDER BY ranks.rank DESC, ranks.specialization_id ASC");
    expect(migration).toContain("'cleared_without_rank_three'");
  });

  it("records changed reconciliation without deleting ranks and allows uncommitted learned activation", () => {
    expect(migration).toContain("specialization_commitment_reconciliation_audit");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+player_specialization_ranks/iu);
    expect(migration).toContain("OR committed_specialization_id IS NULL");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0647_durable_world_environment_profiles.sql", import.meta.url)
  ),
  "utf8"
).replaceAll("\r\n", "\n");

describe("0647 durable World environment profiles migration", () => {
  it("keys immutable cell profiles to World data and profile contracts", () => {
    expect(migration).toContain("CREATE TABLE world_environment_cells");
    for (const identity of [
      "world_identity_key",
      "release_id",
      "profile_set_fingerprint",
      "build_contract_fingerprint",
      "boundary_release_id",
      "profile_version",
      "candidate_slot_version",
      "source_runtime_sha"
    ]) {
      expect(migration).toContain(identity);
    }
    expect(migration).toContain(
      "PRIMARY KEY (\n    world_identity_key,\n    profile_version,\n    candidate_slot_version,\n    cell_id"
    );
    expect(migration).toContain("world_environment_cells_reject_update");
    expect(migration).toContain("jsonb_array_length(candidate_slots) BETWEEN 96 AND 128");
  });

  it("provides deduplicated, fenced and recoverable durable leases", () => {
    expect(migration).toContain("CREATE TABLE world_environment_profile_jobs");
    expect(migration).toContain(
      "status IN ('pending', 'leased', 'ready', 'retryable-failure', 'terminal-failure')"
    );
    expect(migration).toContain("owner_generation");
    expect(migration).toContain("lease_expires_at");
    expect(migration).toContain("attempt_count");
    expect(migration).toContain("next_retry_at");
    expect(migration).toContain("world_environment_profile_jobs_claim_idx");
    expect(migration).toContain("world_environment_profile_jobs_expired_lease_idx");
    expect(migration).toContain("world_environment_profile_jobs_operational_metrics_idx");
    expect(migration).toContain("WHERE status <> 'ready'");
  });

  it("adds immutable normalized environment references to generated mobs", () => {
    expect(migration).toContain("environment_world_identity_key");
    expect(migration).toContain("environment_cell_id");
    expect(migration).toContain("environment_slot_id");
    expect(migration).toContain("environment_snapshot jsonb");
    expect(migration).toContain("generated_world_mobs_environment_cell_fk");
    expect(migration).toContain("NEW.environment_snapshot IS DISTINCT FROM OLD.environment_snapshot");
  });

  it("admits every versioned tree-density profile without weakening historical ownership", () => {
    expect(migration).toContain("CHECK (rolled_tree_count BETWEEN 1 AND 9)");
    expect(migration).toContain("CHECK (actual_tree_count BETWEEN 0 AND 9)");
  });
});

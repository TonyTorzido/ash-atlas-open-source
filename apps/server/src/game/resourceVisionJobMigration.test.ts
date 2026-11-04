import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0611_durable_resource_vision_jobs.sql", import.meta.url)
  ),
  "utf8"
);

describe("0611 durable resource vision jobs migration", () => {
  it("persists release-keyed ownership, leases, retries, and finite failure state", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS resource_vision_jobs");
    for (const column of [
      "layout_version",
      "world_release_id",
      "profile_set_fingerprint",
      "build_contract_fingerprint",
      "boundary_release_id",
      "owner_generation",
      "lease_expires_at",
      "attempt_count",
      "next_retry_at",
      "last_error"
    ]) expect(migration).toContain(column);
    expect(migration).toContain("resource_vision_jobs_claim_idx");
    expect(migration).toContain("resource_vision_jobs_expired_lease_idx");
  });
});

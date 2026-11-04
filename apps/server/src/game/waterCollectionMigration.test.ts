import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0610_durable_water_collection_cadence.sql", import.meta.url)
  ),
  "utf8"
);

describe("0610 durable water collection cadence migration", () => {
  it("persists per-player timing and completed idempotent outcomes", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS player_water_collection_cadence");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS water_collection_operations");
    expect(migration).toContain("player_id text PRIMARY KEY");
    expect(migration).toContain("operation_key text PRIMARY KEY");
    expect(migration).toContain("REFERENCES inventory_operations(operation_key)");
    expect(migration).toContain("UNIQUE (player_id, request_id)");
    expect(migration).toContain("CHECK (next_allowed_at >= collected_at)");
  });
});

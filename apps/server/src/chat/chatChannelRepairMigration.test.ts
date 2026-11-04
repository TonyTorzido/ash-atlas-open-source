import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0660_repair_public_chat_channels.sql", import.meta.url)),
  "utf8"
);

describe("public chat catalog repair migration", () => {
  it("upserts and reactivates the stable authoritative channel catalog", () => {
    expect(migration).toContain("'05000000-0000-4000-8000-000000000001', 'public:general'");
    expect(migration).toContain("'05000000-0000-4000-8000-000000000002', 'public:trading'");
    expect(migration).toContain("'05000000-0000-4000-8000-000000000003', 'public:hunting'");
    expect(migration).toContain("'05000000-0000-4000-8000-000000000004', 'local:map'");
    expect(migration).toContain("ON CONFLICT (channel_key) DO UPDATE SET");
    expect(migration).toContain("active = true");
  });

  it("repairs sequences without deleting messages or read state", () => {
    expect(migration).toContain("INSERT INTO chat_channel_sequences");
    expect(migration).toContain("ON CONFLICT (channel_id) DO NOTHING");
    expect(migration).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP TABLE)\b/i);
  });
});

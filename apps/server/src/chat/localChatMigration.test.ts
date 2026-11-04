import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0617_local_chat.sql", import.meta.url)),
  "utf8"
);

describe("local chat migration", () => {
  it("adds one stable live-AOI channel and its authoritative sequence", () => {
    expect(migration).toContain("'05000000-0000-4000-8000-000000000004'");
    expect(migration).toContain("'local:map'");
    expect(migration).toContain("'authoritative_aoi_v1'");
    expect(migration).toContain("'live_session_v1'");
    expect(migration).toContain("INSERT INTO chat_channel_sequences");
  });

  it("keeps moderation persistence while declaring Local as a distinct channel type", () => {
    expect(migration).toContain("channel_type IN ('public', 'local'");
    expect(migration).toContain("'public_chat_v1'");
    expect(migration).not.toMatch(/CREATE TABLE .*local_chat_history/i);
  });
});

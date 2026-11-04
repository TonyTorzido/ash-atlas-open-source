import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(
  new URL("../../../../db/migrations/0616_direct_messages.sql", import.meta.url)
), "utf8");
const profiles = readFileSync(fileURLToPath(
  new URL("../game/profiles.ts", import.meta.url)
), "utf8");
const service = readFileSync(fileURLToPath(
  new URL("./directMessageService.ts", import.meta.url)
), "utf8");

describe("0616 durable direct messages migration", () => {
  it("reuses the chat message and sequence authorities instead of duplicating them", () => {
    expect(migration).toContain("REFERENCES chat_channels(id)");
    expect(migration).toContain("REFERENCES chat_messages(id)");
    expect(migration).not.toMatch(/CREATE TABLE IF NOT EXISTS direct_message_messages/);
    expect(migration).not.toMatch(/CREATE TABLE IF NOT EXISTS direct_messages/);
  });

  it("enforces one canonical pair with its exact two participant state rows", () => {
    expect(migration).toContain("direct_conversations_canonical_pair");
    expect(migration).toContain("UNIQUE (player_low_id, player_high_id)");
    expect(migration).toContain("validate_direct_conversation_participants");
    expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/g);
    for (const state of [
      "last_read_sequence", "last_delivered_sequence", "last_read_at",
      "last_delivered_at", "unread_count", "muted", "last_active_at"
    ]) expect(migration).toContain(state);
  });

  it("adds indexed reconnect events, preferences, and a shared database rate window", () => {
    for (const table of [
      "direct_message_events",
      "direct_message_event_cursors",
      "player_direct_message_preferences",
      "direct_message_rate_windows"
    ]) expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    for (const index of [
      "direct_conversations_low_recent_idx",
      "direct_conversations_high_recent_idx",
      "direct_participants_player_recent_idx",
      "direct_message_events_player_cursor_idx",
      "direct_message_rate_windows_cleanup_idx"
    ]) expect(migration).toContain(index);
  });

  it("uses the same canonical advisory lock expression as blocking", () => {
    const lock = /hashtextextended\(LEAST\(\$1, \$2\) \|\| chr\(31\) \|\| GREATEST\(\$1, \$2\), 0\)/;
    expect(profiles).toMatch(lock);
    expect(service).toMatch(lock);
    expect(service.indexOf("await lockPlayerPair(client, low, high)")).toBeLessThan(
      service.indexOf("SELECT 1 FROM player_blocks")
    );
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0500_chat_foundation.sql", import.meta.url)),
  "utf8"
);

describe("0500 chat foundation migration", () => {
  it("creates the bounded public-chat persistence tables in the Chats range", () => {
    for (const table of [
      "chat_channels",
      "chat_channel_sequences",
      "chat_messages",
      "chat_channel_read_states",
      "chat_moderation_decisions",
      "chat_mutes"
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration).not.toMatch(/kingdom_membership|party_membership|direct_message/i);
  });

  it("seeds exactly the three stable public channel keys without duplicate reruns", () => {
    for (const key of ["public:general", "public:trading", "public:hunting"]) {
      expect(migration.match(new RegExp(`'${key}'`, "g"))?.length).toBeGreaterThanOrEqual(2);
    }
    expect(migration).toContain("ON CONFLICT (channel_key) DO NOTHING");
    expect(migration).toContain("ON CONFLICT (channel_id) DO NOTHING");
    expect(migration).toContain("public_trading_v1");
  });

  it("assigns authoritative per-channel ordering and durable request idempotency", () => {
    expect(migration).toContain("last_sequence bigint NOT NULL DEFAULT 0");
    expect(migration).toContain("sequence_number bigint NOT NULL CHECK (sequence_number > 0)");
    expect(migration).toMatch(
      /UNIQUE INDEX IF NOT EXISTS chat_messages_channel_sequence_unique_idx[\s\S]*channel_id, sequence_number DESC/
    );
    expect(migration).toMatch(
      /UNIQUE INDEX IF NOT EXISTS chat_messages_sender_request_unique_idx[\s\S]*sender_player_id, client_request_id/
    );
  });

  it("guards message text, status, timestamps, read cursors, and indexed history", () => {
    expect(migration).toContain("char_length(body) BETWEEN 1 AND 400");
    expect(migration).toContain("body ~ '[^[:space:]]'");
    expect(migration).toContain("position(chr(13) in body) = 0");
    expect(migration).toContain("moderation_status IN ('pending', 'clear', 'flagged', 'actioned', 'failed')");
    expect(migration).toContain("PRIMARY KEY (player_id, channel_id)");
    expect(migration).toContain("last_read_sequence bigint NOT NULL DEFAULT 0");
    expect(migration).toContain("chat_messages_moderation_status_idx");
  });

  it("enforces scoped, expiring, revocable, idempotent mutes with active lookup indexes", () => {
    expect(migration).toContain("(scope = 'global' AND channel_id IS NULL)");
    expect(migration).toContain("(scope = 'channel' AND channel_id IS NOT NULL)");
    expect(migration).toContain("CHECK (expires_at > created_at)");
    expect(migration).toContain("chat_mutes_idempotency_unique_idx");
    expect(migration).toContain("chat_mutes_decision_unique_idx");
    expect(migration).toContain("chat_mutes_active_global_idx");
    expect(migration).toContain("chat_mutes_active_channel_idx");
  });

  it("persists bounded moderation decisions, action safeguards, review, and reversal state", () => {
    expect(migration).toContain("confidence BETWEEN 0 AND 1");
    expect(migration).toContain("cardinality(categories) BETWEEN 0 AND 16");
    expect(migration).toContain("temporary_channel_mute");
    expect(migration).toContain("temporary_global_mute");
    expect(migration).toContain("human_review_status IN ('not_required', 'pending', 'approved', 'rejected')");
    expect(migration).toContain("processing_status = 'reversed'");
    expect(migration).toContain("chat_moderation_decisions_processing_idx");
    expect(migration).toContain("chat_moderation_decisions_review_idx");
  });
});

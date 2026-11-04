import type pg from "pg";
import { CHAT_LOCAL_CHANNEL_KEY } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { BoundedChatRateLimiter, BoundedRecentChatCache } from "./boundedMemory.js";
import { ChatService } from "./chatService.js";

describe("ChatService PostgreSQL authority", () => {
  it("normalizes, sequences, stores, emits moderation, and durably replays a request", async () => {
    const database = chatDatabase();
    const enqueue = vi.fn((event: unknown) => {
      void event;
      return true;
    });
    const service = new ChatService(database.pool, {
      moderationDispatcher: { enqueue }
    });
    const input = {
      channelKey: "public:general",
      senderPlayerId: "player-1",
      senderDisplayName: "  Ash  Scout ",
      clientRequestId: "05000000-0000-4000-8000-000000000111",
      body: "  hello\r\nworld  "
    };

    const first = await service.send(input);
    const replay = await service.send(input);

    expect(first).toMatchObject({
      replayed: false,
      moderationQueued: true,
      message: {
        sequence: 1,
        senderPlayerId: "player-1",
        senderDisplayName: "Ash Scout",
        body: "hello\nworld"
      }
    });
    expect(replay).toMatchObject({ replayed: true, message: { id: first.message.id } });
    expect(database.messages).toHaveLength(1);
    expect(database.lastSequence()).toBe(1);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0]).not.toHaveProperty("sessionToken");
    expect(enqueue.mock.calls[0]?.[0]).not.toHaveProperty("location");
  });

  it("rejects request-id conflicts, blank text, and active durable mutes", async () => {
    const database = chatDatabase();
    const service = new ChatService(database.pool);
    const base = {
      channelKey: "public:general",
      senderPlayerId: "player-1",
      senderDisplayName: "Ash",
      clientRequestId: "05000000-0000-4000-8000-000000000112",
      body: "first"
    };
    await service.send(base);
    await expect(service.send({ ...base, body: "different" })).rejects.toMatchObject({
      code: "CHAT_IDEMPOTENCY_CONFLICT"
    });
    await expect(service.send({ ...base, clientRequestId: "05000000-0000-4000-8000-000000000113", body: " \n " }))
      .rejects.toMatchObject({ code: "CHAT_BODY_EMPTY" });

    database.setMute({ reason: "Temporary mute", expires_at: new Date(Date.now() + 60_000) });
    await expect(service.send({
      ...base,
      clientRequestId: "05000000-0000-4000-8000-000000000114",
      body: "after mute"
    })).rejects.toMatchObject({ code: "CHAT_MUTED" });
  });

  it("uses bounded sequence cursors for initial, older, catch-up, and large-gap snapshots", async () => {
    const database = chatDatabase(200);
    const service = new ChatService(database.pool);

    const initial = await service.history({ playerId: "viewer", channelKey: "public:general" });
    expect(initial.messages).toHaveLength(50);
    expect(initial.messages[0]?.sequence).toBe(151);
    expect(initial.messages.at(-1)?.sequence).toBe(200);

    const older = await service.history({
      playerId: "viewer",
      channelKey: "public:general",
      beforeSequence: 151
    });
    expect(older.mode).toBe("older");
    expect(older.messages[0]?.sequence).toBe(101);
    expect(older.messages.at(-1)?.sequence).toBe(150);
    expect(older.hasMore).toBe(true);

    const catchUp = await service.history({
      playerId: "viewer",
      channelKey: "public:general",
      afterSequence: 195
    });
    expect(catchUp.mode).toBe("catch-up");
    expect(catchUp.messages.map(({ sequence }) => sequence)).toEqual([196, 197, 198, 199, 200]);

    const reset = await service.history({
      playerId: "viewer",
      channelKey: "public:general",
      afterSequence: 1
    });
    expect(reset).toMatchObject({ mode: "bounded-snapshot", resetRequired: true });
    expect(reset.messages).toHaveLength(50);
    expect(reset.messages.at(-1)?.sequence).toBe(200);
  });

  it("returns only visible durable messages for translation and reuses channel access", async () => {
    const database = chatDatabase(1);
    const service = new ChatService(database.pool);
    const messageId = database.messages[0]!.id;

    await expect(service.getMessageForTranslation("viewer", messageId)).resolves.toMatchObject({
      id: messageId,
      body: "Message 1"
    });
    await expect(service.getMessageForTranslation("", messageId)).rejects.toMatchObject({
      code: "CHAT_ACCESS_DENIED"
    });
    await expect(service.getMessageForTranslation("viewer", "not-a-uuid")).rejects.toMatchObject({
      code: "CHAT_REQUEST_INVALID"
    });

    database.messages[0]!.message_status = "deleted";
    database.messages[0]!.deleted_at = new Date();
    await expect(service.getMessageForTranslation("viewer", messageId)).rejects.toMatchObject({
      code: "CHAT_MESSAGE_NOT_FOUND"
    });
  });

  it("attaches cached translations to visible history messages with one batched query", async () => {
    const database = chatDatabase(3);
    const [first, second, third] = database.messages;
    database.translations.push(
      { message_id: first!.id, target_language: "en", translated_text: "Hello", source_language: "es" },
      { message_id: first!.id, target_language: "fr", translated_text: "Bonjour", source_language: null },
      { message_id: second!.id, target_language: "en", translated_text: "Deleted", source_language: "es" },
      { message_id: third!.id, target_language: "en", translated_text: "Hidden", source_language: "es" }
    );
    second!.message_status = "deleted";
    second!.deleted_at = new Date();
    third!.message_status = "hidden";
    const service = new ChatService(database.pool);

    const history = await service.history({ playerId: "viewer", channelKey: "public:general" });

    expect(history.messages[0]?.translations).toEqual({
      en: { translatedText: "Hello", sourceLanguage: "es" },
      fr: { translatedText: "Bonjour" }
    });
    expect(history.messages[1]).not.toHaveProperty("translations");
    expect(history.messages[2]).not.toHaveProperty("translations");
    expect(database.translationQueryCount()).toBe(1);
  });

  it("projects the sender's equipped crest and normalizes legacy rows", async () => {
    const database = chatDatabase(2);
    database.messages[0]!.equipped_chat_crest_id = "stag";
    database.messages[1]!.equipped_chat_crest_id = "old-crest";
    const service = new ChatService(database.pool);
    const history = await service.history({ playerId: "viewer", channelKey: "public:general" });
    expect(history.messages.map((message) => message.chatCrestId)).toEqual(["stag", "leaf"]);
  });

  it("clamps and monotonically advances persisted read sequence", async () => {
    const database = chatDatabase(10);
    const service = new ChatService(database.pool);
    expect(await service.markRead("player-1", "public:general", 7)).toMatchObject({
      lastReadSequence: 7,
      latestSequence: 10,
      unreadCount: 3
    });
    expect(await service.markRead("player-1", "public:general", 2)).toMatchObject({
      lastReadSequence: 7,
      unreadCount: 3
    });
    expect(await service.markRead("player-1", "public:general", 999)).toMatchObject({
      lastReadSequence: 10,
      unreadCount: 0
    });
  });

  it("honors bounded runtime history settings and caps the channel snapshot query", async () => {
    const database = chatDatabase(20);
    const service = new ChatService(database.pool, { historyPageSize: 7, catchUpLimit: 9 });
    expect(service.historyPageSize).toBe(7);
    expect(service.catchUpLimit).toBe(9);
    expect((await service.history({ playerId: "viewer", channelKey: "public:general" })).messages)
      .toHaveLength(7);
    await service.listChannels();
    expect(database.listLimit()).toBe(32);
    expect(() => new ChatService(database.pool, { historyPageSize: 10, catchUpLimit: 9 }))
      .toThrow(/catch-up limit/i);
  });

  it("rolls back a rate reservation when persistence fails so the request is retryable", async () => {
    const database = chatDatabase();
    const service = new ChatService(database.pool);
    const input = {
      channelKey: "public:general",
      senderPlayerId: "player-1",
      senderDisplayName: "Ash",
      clientRequestId: "05000000-0000-4000-8000-000000000991",
      body: "retry after database failure"
    };
    database.failNextInsert();
    await expect(service.send(input)).rejects.toThrow(/temporary insert failure/i);
    await expect(service.send(input)).resolves.toMatchObject({ replayed: false });
  });

  it("accepts and moderates Local messages without caching or exposing history/read state", async () => {
    const database = chatDatabase();
    const enqueue = vi.fn(() => true);
    const service = new ChatService(database.pool, {
      moderationDispatcher: { enqueue }
    });
    const input = {
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      senderPlayerId: "player-1",
      senderDisplayName: "Ash",
      clientRequestId: "05000000-0000-4000-8000-000000000993",
      body: "visible right now"
    };

    const accepted = await service.send(input);
    const replay = await service.send(input);

    expect(accepted).toMatchObject({
      replayed: false,
      moderationQueued: true,
      message: { channelKey: CHAT_LOCAL_CHANNEL_KEY, body: "visible right now" }
    });
    expect(replay).toMatchObject({ replayed: true, message: { id: accepted.message.id } });
    expect(database.messages).toHaveLength(1);
    expect(service.metricsSnapshot()).toMatchObject({ recentCacheMessages: 0 });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      channelType: "local"
    }));
    await expect(service.history({ playerId: "player-1", channelKey: CHAT_LOCAL_CHANNEL_KEY }))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
    await expect(service.markRead("player-1", CHAT_LOCAL_CHANNEL_KEY, 1))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
  });

  it("requires current Community Rules acceptance before any player-visible chat post", async () => {
    const database = chatDatabase();
    const service = new ChatService(database.pool, {
      requireCurrentTermsAcceptance: async () => false
    });
    const base = {
      senderPlayerId: "player-1",
      senderDisplayName: "Ash",
      body: "needs rules"
    };

    await expect(service.send({
      ...base,
      channelKey: "public:general",
      clientRequestId: "05000000-0000-4000-8000-000000000995"
    })).rejects.toMatchObject({ code: "CHAT_TERMS_REQUIRED" });
    await expect(service.send({
      ...base,
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      clientRequestId: "05000000-0000-4000-8000-000000000996"
    })).rejects.toMatchObject({ code: "CHAT_TERMS_REQUIRED" });
  });

  it("prunes idle cache and limiter state during production metrics snapshots", async () => {
    const database = chatDatabase();
    let now = 0;
    const service = new ChatService(database.pool, {
      now: () => now,
      rateLimiter: new BoundedChatRateLimiter(10, 50, 1_000),
      recentCache: new BoundedRecentChatCache(10, 10, 50)
    });
    await service.send({
      channelKey: "public:general",
      senderPlayerId: "player-1",
      senderDisplayName: "Ash",
      clientRequestId: "05000000-0000-4000-8000-000000000992",
      body: "expires from memory"
    });
    expect(service.metricsSnapshot()).toMatchObject({ recentCacheMessages: 1, rateLimitKeys: 2 });
    now = 51;
    expect(service.metricsSnapshot()).toMatchObject({ recentCacheMessages: 0, rateLimitKeys: 0 });
  });
});

type StoredMessage = {
  id: string;
  channel_id: string;
  channel_key: string;
  sequence_number: number;
  sender_player_id: string;
  sender_display_name: string;
  equipped_chat_crest_id: string | null;
  body: string;
  client_request_id: string;
  message_status: string;
  moderation_status: string;
  edited_at: null;
  deleted_at: Date | string | null;
  created_at: Date;
  updated_at: Date;
};

function chatDatabase(seedMessages = 0): {
  pool: pg.Pool;
  messages: StoredMessage[];
  lastSequence(): number;
  listLimit(): number | null;
  failNextInsert(): void;
  translations: Array<{
    message_id: string;
    target_language: string;
    translated_text: string;
    source_language: string | null;
  }>;
  translationQueryCount(): number;
  setMute(value: { reason: string; expires_at: Date } | null): void;
} {
  const channelId = "05000000-0000-4000-8000-000000000001";
  const localChannelId = "05000000-0000-4000-8000-000000000004";
  let sequence = seedMessages;
  let mute: { reason: string; expires_at: Date } | null = null;
  let requestedListLimit: number | null = null;
  let insertFailurePending = false;
  const readByPlayer = new Map<string, number>();
  const translations: ReturnType<typeof chatDatabase>["translations"] = [];
  let translationQueries = 0;
  const messages: StoredMessage[] = Array.from({ length: seedMessages }, (_, index) => {
    const value = index + 1;
    return storedMessage(channelId, value, `05000000-0000-4000-8000-${String(value).padStart(12, "0")}`);
  });

  const query = async (sql: string, values: readonly unknown[] = []) => {
    const compact = sql.replace(/\s+/g, " ").trim();
    if (compact === "BEGIN" || compact === "COMMIT" || compact === "ROLLBACK") {
      return result([]);
    }
    if (compact.startsWith("SELECT pg_advisory_xact_lock")) {
      return result([{ pg_advisory_xact_lock: null }]);
    }
    if (compact.includes("FROM chat_channels c") && compact.includes("WHERE c.channel_key = $1")) {
      if (values[0] === "public:general") return result([channelRow(channelId, sequence)]);
      if (values[0] === CHAT_LOCAL_CHANNEL_KEY) return result([localChannelRow(localChannelId, sequence)]);
      return result([]);
    }
    if (compact.includes("FROM chat_channels c") && compact.includes("c.channel_type IN ('public', 'local')")) {
      requestedListLimit = Number(values.at(-1));
      return result([localChannelRow(localChannelId, sequence), channelRow(channelId, sequence)]);
    }
    if (compact.includes("m.sender_player_id = $1") && compact.includes("m.client_request_id = $2")) {
      return result(messages.filter((message) =>
        message.sender_player_id === values[0] && message.client_request_id === values[1]
      ));
    }
    if (compact.includes("FROM chat_messages m JOIN chat_channels c") && compact.includes("WHERE m.id = $1")) {
      return result(messages.filter((message) => message.id === values[0]));
    }
    if (compact.includes("FROM chat_translation_cache")) {
      translationQueries += 1;
      const ids = values[0] as string[];
      return result(translations.filter((row) => ids.includes(row.message_id)));
    }
    if (compact.startsWith("SELECT mute.id")) {
      return result(mute ? [{
        id: "05000000-0000-4000-8000-000000000900",
        scope: "global",
        channel_key: null,
        reason: mute.reason,
        expires_at: mute.expires_at
      }] : []);
    }
    if (compact.startsWith("UPDATE chat_channel_sequences")) {
      sequence += 1;
      return result([{ last_sequence: sequence }]);
    }
    if (compact.startsWith("INSERT INTO chat_messages")) {
      if (insertFailurePending) {
        insertFailurePending = false;
        throw new Error("temporary insert failure");
      }
      const now = new Date();
      const row: StoredMessage = {
        id: String(values[0]),
        channel_id: String(values[1]),
        channel_key: values[1] === localChannelId ? CHAT_LOCAL_CHANNEL_KEY : "public:general",
        sequence_number: Number(values[2]),
        sender_player_id: String(values[3]),
        sender_display_name: String(values[4]),
        equipped_chat_crest_id: null,
        body: String(values[5]),
        client_request_id: String(values[6]),
        message_status: "visible",
        moderation_status: "pending",
        edited_at: null,
        deleted_at: null,
        created_at: now,
        updated_at: now
      };
      messages.push(row);
      return result([row]);
    }
    if (compact.includes("FROM chat_messages m JOIN chat_channels c") && compact.includes("m.channel_id = $1")) {
      let selected = messages.filter((message) => message.channel_id === values[0]);
      if (compact.includes("m.sequence_number < $2")) {
        selected = selected.filter((message) => message.sequence_number < Number(values[1]));
      }
      if (compact.includes("m.sequence_number > $2")) {
        selected = selected.filter((message) => message.sequence_number > Number(values[1]));
      }
      const descending = compact.includes("ORDER BY m.sequence_number DESC");
      selected.sort((left, right) => descending
        ? right.sequence_number - left.sequence_number
        : left.sequence_number - right.sequence_number);
      return result(selected.slice(0, Number(values.at(-1))));
    }
    if (compact.startsWith("INSERT INTO chat_channel_read_states")) {
      const playerId = String(values[0]);
      const requested = Number(values[2]);
      const stored = Math.max(readByPlayer.get(playerId) ?? 0, requested);
      readByPlayer.set(playerId, stored);
      return result([{ last_read_sequence: stored, updated_at: new Date() }]);
    }
    throw new Error(`Unexpected chat SQL: ${compact}`);
  };
  const client = { query, release: () => undefined };
  const pool = { query, connect: async () => client } as unknown as pg.Pool;
  return {
    pool,
    messages,
    lastSequence: () => sequence,
    listLimit: () => requestedListLimit,
    failNextInsert: () => { insertFailurePending = true; },
    translations,
    translationQueryCount: () => translationQueries,
    setMute: (value) => { mute = value; }
  };
}

function channelRow(id: string, sequence: number) {
  return {
    id,
    channel_key: "public:general",
    channel_type: "public",
    display_name: "General",
    visibility_policy: "authenticated_public_v1",
    send_access_policy: "authenticated_public_v1",
    history_retention_policy: "bounded_public_v1",
    rate_limit_policy: "public_standard_v1",
    moderation_policy: "public_chat_v1",
    active: true,
    latest_sequence: sequence,
    created_at: new Date(0),
    updated_at: new Date(0)
  };
}

function localChannelRow(id: string, sequence: number) {
  return {
    id,
    channel_key: CHAT_LOCAL_CHANNEL_KEY,
    channel_type: "local",
    display_name: "Local",
    visibility_policy: "authoritative_aoi_v1",
    send_access_policy: "authenticated_local_v1",
    history_retention_policy: "live_session_v1",
    rate_limit_policy: "public_standard_v1",
    moderation_policy: "public_chat_v1",
    active: true,
    latest_sequence: sequence,
    created_at: new Date(0),
    updated_at: new Date(0)
  };
}

function storedMessage(channelId: string, sequence: number, id: string): StoredMessage {
  const date = new Date(sequence);
  return {
    id,
    channel_id: channelId,
    channel_key: "public:general",
    sequence_number: sequence,
    sender_player_id: `player-${sequence}`,
    sender_display_name: `Player ${sequence}`,
    equipped_chat_crest_id: null,
    body: `Message ${sequence}`,
    client_request_id: `05000000-0000-4000-9000-${String(sequence).padStart(12, "0")}`,
    message_status: "visible",
    moderation_status: "clear",
    edited_at: null,
    deleted_at: null,
    created_at: date,
    updated_at: date
  };
}

function result<T>(rows: T[]): { rows: T[]; rowCount: number } {
  return { rows, rowCount: rows.length };
}

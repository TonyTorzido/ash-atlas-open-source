import { describe, expect, it } from "vitest";

import {
  CHAT_ACTIVE_MESSAGE_LIMIT,
  CHAT_CHANNEL_KEYS,
  CHAT_FAILED_MESSAGE_LIMIT,
  CHAT_INACTIVE_MESSAGE_LIMIT,
  CHAT_LOCAL_CHANNEL_KEY,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_PENDING_MESSAGE_LIMIT,
  CHAT_PUBLIC_CHANNEL_KEYS,
  boundedChatPreview,
  isLiveSessionChatChannel,
  isPublicChatChannelKey
} from "./chat.js";
import { parseClientMessage } from "./protocol.js";

describe("shared chat contract", () => {
  it("defines one stable generic public-channel set", () => {
    expect(CHAT_PUBLIC_CHANNEL_KEYS).toEqual([
      "public:general",
      "public:trading",
      "public:hunting"
    ]);
    expect(CHAT_CHANNEL_KEYS).toEqual([
      "public:general",
      "public:trading",
      "public:hunting",
      CHAT_LOCAL_CHANNEL_KEY
    ]);
    expect(isPublicChatChannelKey("public:general")).toBe(true);
    expect(CHAT_LOCAL_CHANNEL_KEY).toBe("local:map");
    expect(isPublicChatChannelKey(CHAT_LOCAL_CHANNEL_KEY)).toBe(false);
    expect(isPublicChatChannelKey("kingdom:future")).toBe(false);
    expect(isLiveSessionChatChannel({ historyRetentionPolicy: "live-session" })).toBe(true);
    expect(isLiveSessionChatChannel({ historyRetentionPolicy: "durable" })).toBe(false);
  });

  it("keeps every client collection and payload policy explicitly bounded", () => {
    expect(CHAT_ACTIVE_MESSAGE_LIMIT).toBe(200);
    expect(CHAT_INACTIVE_MESSAGE_LIMIT).toBe(10);
    expect(CHAT_PENDING_MESSAGE_LIMIT).toBe(20);
    expect(CHAT_FAILED_MESSAGE_LIMIT).toBe(20);
    expect(CHAT_MESSAGE_MAX_LENGTH).toBe(400);
  });

  it("normalizes previews without retaining a full oversized body", () => {
    const preview = boundedChatPreview(`  hello\n${"x".repeat(200)}  `);
    expect(preview).not.toContain("\n");
    expect(Array.from(preview)).toHaveLength(120);
    expect(preview.endsWith("…")).toBe(true);

    const astralPreview = boundedChatPreview("😀".repeat(121));
    expect(Array.from(astralPreview)).toHaveLength(120);
    expect(astralPreview).not.toContain("�");
  });

  it("parses chat intent while rejecting identity and timestamp spoof fields", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "CHAT_SEND",
      requestId: "11111111-1111-4111-8111-111111111111",
      channelKey: "public:general",
      body: "hello"
    }))).toMatchObject({ type: "CHAT_SEND", body: "hello" });
    expect(parseClientMessage(JSON.stringify({
      type: "CHAT_SEND",
      requestId: "22222222-2222-4222-8222-222222222222",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      body: "nearby only"
    }))).toEqual({
      type: "CHAT_SEND",
      requestId: "22222222-2222-4222-8222-222222222222",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      body: "nearby only"
    });

    for (const spoof of [
      { senderPlayerId: "someone-else" },
      { serverCreatedAt: "2099-01-01T00:00:00.000Z" },
      { sequence: 99 },
      { lat: 35.0844, lon: -106.6504 },
      { range: 99_999 },
      { worldInstanceId: "forged-world" },
      { recipientPlayerIds: ["someone-else"] }
    ]) {
      expect(() => parseClientMessage(JSON.stringify({
        type: "CHAT_SEND",
        requestId: "11111111-1111-4111-8111-111111111111",
        channelKey: "public:general",
        body: "hello",
        ...spoof
      }))).toThrow();
    }
  });

  it("requires cursors and caps history pages", () => {
    expect(() => parseClientMessage(JSON.stringify({
      type: "CHAT_HISTORY_REQUEST",
      requestId: "history-1",
      channelKey: "public:general",
      direction: "older",
      cursorSequence: 52,
      limit: 51
    }))).toThrow();
    expect(parseClientMessage(JSON.stringify({
      type: "CHAT_HISTORY_REQUEST",
      requestId: "history-1",
      channelKey: "public:general",
      direction: "older",
      cursorSequence: 52,
      limit: 50
    }))).toMatchObject({ cursorSequence: 52, limit: 50 });
  });
});

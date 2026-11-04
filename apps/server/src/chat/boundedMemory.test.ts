import type { ChatMessage } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  BoundedChatRateLimiter,
  BoundedRecentChatCache,
  ChatSubscriptionRegistry
} from "./boundedMemory.js";
import { CHAT_RATE_POLICIES } from "./policy.js";

describe("bounded chat server memory", () => {
  it("never exceeds recent-message or channel caps after thousands of messages", () => {
    const cache = new BoundedRecentChatCache(20, 3, 1_000);
    for (let channel = 0; channel < 20; channel += 1) {
      for (let sequence = 1; sequence <= 1_000; sequence += 1) {
        cache.append(message(`public:${channel}`, sequence), channel * 10 + sequence / 10_000);
      }
    }
    expect(cache.metrics()).toMatchObject({ channels: 3, maximumChannelSize: 20 });
    expect(cache.metrics().messages).toBeLessThanOrEqual(60);
  });

  it("deduplicates cache entries and expires inactive channel state", () => {
    const cache = new BoundedRecentChatCache(2, 2, 50);
    cache.append(message("public:general", 1), 0);
    cache.append({ ...message("public:general", 1), body: "replacement" }, 1);
    cache.append(message("public:general", 2), 2);
    cache.append(message("public:general", 3), 3);
    expect(cache.recent("public:general", 10, 3).map(({ sequence }) => sequence)).toEqual([2, 3]);
    cache.prune(54);
    expect(cache.metrics().channels).toBe(0);
  });

  it("bounds and expires rate buckets while enforcing channel-specific repeat policy", () => {
    const limiter = new BoundedChatRateLimiter(3, 100, 1, 3);
    expect(limiter.consume("a", "public:general", "Hello", CHAT_RATE_POLICIES.public_standard_v1, 0)).toEqual({ allowed: true });
    expect(limiter.consume("a", "public:general", "hello", CHAT_RATE_POLICIES.public_standard_v1, 1)).toMatchObject({ allowed: false, reason: "duplicate" });
    for (const id of ["b", "c", "d", "e"]) {
      limiter.consume(id, "public:general", id, CHAT_RATE_POLICIES.public_standard_v1, 2);
    }
    expect(limiter.size).toBeLessThanOrEqual(6);
    limiter.prune(200);
    expect(limiter.size).toBe(0);
    expect(CHAT_RATE_POLICIES.public_trading_v1.duplicateWindowMs)
      .toBeGreaterThan(CHAT_RATE_POLICIES.public_standard_v1.duplicateWindowMs);

    const sustained = new BoundedChatRateLimiter(10, 1_000);
    for (let index = 0; index < CHAT_RATE_POLICIES.public_standard_v1.burst; index += 1) {
      expect(sustained.consume(
        "burst",
        "public:general",
        `message-${index}`,
        CHAT_RATE_POLICIES.public_standard_v1,
        0
      )).toEqual({ allowed: true });
    }
    expect(sustained.consume(
      "burst",
      "public:general",
      "overflow",
      CHAT_RATE_POLICIES.public_standard_v1,
      0
    )).toMatchObject({ allowed: false, reason: "rate" });
  });

  it("rolls back rate reservations without leaving duplicate fingerprints or spent tokens", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000);
    const first = limiter.reserve(
      "player",
      "public:general",
      "retry me",
      CHAT_RATE_POLICIES.public_standard_v1,
      0
    );
    const later = limiter.reserve(
      "player",
      "public:general",
      "later message",
      CHAT_RATE_POLICIES.public_standard_v1,
      1
    );
    expect(first.allowed).toBe(true);
    expect(later.allowed).toBe(true);
    if (first.allowed) first.reservation.rollback();
    if (later.allowed) later.reservation.rollback();

    expect(limiter.consume(
      "player",
      "public:general",
      "retry me",
      CHAT_RATE_POLICIES.public_standard_v1,
      2
    )).toEqual({ allowed: true });
    expect(limiter.consume(
      "player",
      "public:general",
      "retry me",
      CHAT_RATE_POLICIES.public_standard_v1,
      3
    )).toMatchObject({ allowed: false, reason: "duplicate" });
  });

  it("R1: room rotation cannot multiply burst beyond aggregate cap", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000);
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.consume("room-rot", "public:trading", `trade-${i}`, CHAT_RATE_POLICIES.public_trading_v1, 0)).toEqual({ allowed: true });
      expect(limiter.consume("room-rot", "public:general", `gen-${i}`, CHAT_RATE_POLICIES.public_standard_v1, 0)).toEqual({ allowed: true });
    }
    for (let i = 0; i < 2; i += 1) {
      expect(limiter.consume("room-rot", "public:hunting", `hunt-${i}`, CHAT_RATE_POLICIES.public_standard_v1, 0)).toEqual({ allowed: true });
    }
    const ninth = limiter.reserve("room-rot", "public:hunting", "ninth", CHAT_RATE_POLICIES.public_standard_v1, 0);
    expect(ninth).toEqual({ allowed: false, reason: "rate", retryAfterMs: 1_500 });
  });

  it("R2: different players have independent aggregate buckets", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000);
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.consume("player-a", "public:general", `a-gen-${i}`, CHAT_RATE_POLICIES.public_standard_v1, 0)).toEqual({ allowed: true });
    }
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.consume("player-a", "public:trading", `a-tr-${i}`, CHAT_RATE_POLICIES.public_trading_v1, 0)).toEqual({ allowed: true });
    }
    const overflow = limiter.reserve("player-a", "public:hunting", "a-overflow", CHAT_RATE_POLICIES.public_standard_v1, 0);
    expect(overflow.allowed).toBe(false);
    expect(limiter.consume("player-b", "public:general", "b-can-send", CHAT_RATE_POLICIES.public_standard_v1, 0)).toEqual({ allowed: true });
  });

  it("R3: cross-channel duplicate is rejected by shared normalization", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000);
    limiter.consume("dup-player", "public:general", "  hello   world ", CHAT_RATE_POLICIES.public_standard_v1, 0);
    const result = limiter.reserve("dup-player", "public:hunting", "HELLO WORLD", CHAT_RATE_POLICIES.public_standard_v1, 0);
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: "duplicate" });
  });

  it("rejects zero-width and alternating Local duplicate spam without blocking natural bursts", () => {
    const limiter = new BoundedChatRateLimiter(10, 60_000);
    expect(limiter.consume("local-player", "local:map", "Meet at the gate", CHAT_RATE_POLICIES.public_standard_v1, 0))
      .toEqual({ allowed: true });
    expect(limiter.consume("local-player", "local:map", "Me\u200bet at the gate", CHAT_RATE_POLICIES.public_standard_v1, 1))
      .toMatchObject({ allowed: false, reason: "duplicate" });

    const alternating = new BoundedChatRateLimiter(10, 60_000);
    expect(alternating.consume("same-player", "local:map", "A", CHAT_RATE_POLICIES.public_standard_v1, 0).allowed).toBe(true);
    expect(alternating.consume("same-player", "local:map", "B", CHAT_RATE_POLICIES.public_standard_v1, 1).allowed).toBe(true);
    expect(alternating.consume("same-player", "local:map", "A", CHAT_RATE_POLICIES.public_standard_v1, 2))
      .toMatchObject({ allowed: false, reason: "duplicate" });

    const conversation = new BoundedChatRateLimiter(10, 60_000);
    for (let index = 0; index < CHAT_RATE_POLICIES.public_standard_v1.burst; index += 1) {
      expect(conversation.consume(
        "conversational-player",
        "local:map",
        `Natural sentence ${index}`,
        CHAT_RATE_POLICIES.public_standard_v1,
        0
      ).allowed).toBe(true);
    }
    expect(conversation.consume(
      "conversational-player",
      "local:map",
      "Flood sentence",
      CHAT_RATE_POLICIES.public_standard_v1,
      0
    )).toMatchObject({ allowed: false, reason: "rate" });
  });

  it("retains duplicate history across a full burst and subsequent refill", () => {
    const limiter = new BoundedChatRateLimiter(10, 60_000);
    for (const body of ["first", "second", "third", "fourth", "fifth"]) {
      expect(limiter.consume(
        "history-player",
        "local:map",
        body,
        CHAT_RATE_POLICIES.public_standard_v1,
        0
      ).allowed).toBe(true);
    }
    expect(limiter.consume(
      "history-player",
      "local:map",
      "first",
      CHAT_RATE_POLICIES.public_standard_v1,
      1_500
    )).toMatchObject({ allowed: false, reason: "duplicate" });
  });

  it("keeps Local rate buckets keyed to player identity across connection replacement", () => {
    const limiter = new BoundedChatRateLimiter(10, 60_000);
    for (let index = 0; index < CHAT_RATE_POLICIES.public_standard_v1.burst; index += 1) {
      expect(limiter.consume(
        "stable-player-id",
        "local:map",
        `before reconnect ${index}`,
        CHAT_RATE_POLICIES.public_standard_v1,
        0
      ).allowed).toBe(true);
    }
    expect(limiter.consume(
      "stable-player-id",
      "local:map",
      "after reconnect",
      CHAT_RATE_POLICIES.public_standard_v1,
      1
    )).toMatchObject({ allowed: false, reason: "rate" });
  });

  it("R4: duplicate window expires after the window elapses", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000);
    limiter.consume("expire", "public:general", "repeat", CHAT_RATE_POLICIES.public_standard_v1, 0);
    expect(limiter.consume("expire", "public:general", "repeat", CHAT_RATE_POLICIES.public_standard_v1, 1).allowed).toBe(false);
    expect(limiter.consume("expire", "public:general", "repeat", CHAT_RATE_POLICIES.public_standard_v1, 12_001)).toEqual({ allowed: true });
  });

  it("R5: trading duplicate returns the longer channel wait, not the shorter aggregate wait", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000);
    limiter.consume("trader", "public:trading", "Buy sword 5g", CHAT_RATE_POLICIES.public_trading_v1, 0);
    const result = limiter.reserve("trader", "public:trading", "Buy sword 5g", CHAT_RATE_POLICIES.public_trading_v1, 0);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(29_999);
    }
  });

  it("R6: channel token wait can exceed aggregate token wait and is reported correctly", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000);
    for (let i = 0; i < 3; i += 1) {
      limiter.consume("token", "public:trading", `trade-${i}`, CHAT_RATE_POLICIES.public_trading_v1, 0);
    }
    const result = limiter.reserve("token", "public:trading", "overflow", CHAT_RATE_POLICIES.public_trading_v1, 0);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(2_499);
    }
  });

  it("R7: aggregate wait can exceed channel wait when many channels are used", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000);
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.consume("agg-heavy", "public:trading", `trade-${i}`, CHAT_RATE_POLICIES.public_trading_v1, 0)).toEqual({ allowed: true });
      expect(limiter.consume("agg-heavy", "public:general", `gen-${i}`, CHAT_RATE_POLICIES.public_standard_v1, 0)).toEqual({ allowed: true });
    }
    for (let i = 0; i < 2; i += 1) {
      expect(limiter.consume("agg-heavy", "public:hunting", `hunt-${i}`, CHAT_RATE_POLICIES.public_standard_v1, 0)).toEqual({ allowed: true });
    }
    const result = limiter.reserve("agg-heavy", "public:hunting", "ninth", CHAT_RATE_POLICIES.public_standard_v1, 750);
    expect(result).toEqual({ allowed: false, reason: "rate", retryAfterMs: 750 });
  });

  it("returns the longer token wait while preserving duplicate reason precedence", () => {
    const limiter = new BoundedChatRateLimiter(10, 60_000);
    const slowTokenPolicy = {
      ...CHAT_RATE_POLICIES.public_standard_v1,
      burst: 1,
      refillIntervalMs: 20_000,
      duplicateWindowMs: 100
    };
    expect(limiter.consume("combined-token", "public:general", "repeat", slowTokenPolicy, 0)).toEqual({ allowed: true });

    expect(limiter.reserve("combined-token", "public:general", "repeat", slowTokenPolicy, 50)).toEqual({
      allowed: false,
      reason: "duplicate",
      retryAfterMs: 19_950
    });
  });

  it("returns the longer duplicate wait when token wait is shorter", () => {
    const limiter = new BoundedChatRateLimiter(10, 60_000);
    expect(limiter.consume("combined-duplicate", "public:trading", "repeat", CHAT_RATE_POLICIES.public_trading_v1, 0)).toEqual({ allowed: true });

    expect(limiter.reserve("combined-duplicate", "public:trading", "repeat", CHAT_RATE_POLICIES.public_trading_v1, 1)).toEqual({
      allowed: false,
      reason: "duplicate",
      retryAfterMs: 29_999
    });
  });

  it("R8: rejected attempt does not consume tokens or install fingerprints", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000, 30_000, 100);
    limiter.consume("no-consume", "public:general", "first", CHAT_RATE_POLICIES.public_standard_v1, 0);
    const rejected = limiter.reserve("no-consume", "public:general", "first", CHAT_RATE_POLICIES.public_standard_v1, 1);
    expect(rejected.allowed).toBe(false);
    expect(limiter.consume("no-consume", "public:general", "unique-2", CHAT_RATE_POLICIES.public_standard_v1, 12_001)).toEqual({ allowed: true });
    expect(limiter.consume("no-consume", "public:general", "unique-3", CHAT_RATE_POLICIES.public_standard_v1, 12_001)).toEqual({ allowed: true });
    expect(limiter.consume("no-consume", "public:general", "unique-4", CHAT_RATE_POLICIES.public_standard_v1, 12_001)).toEqual({ allowed: true });
    expect(limiter.consume("no-consume", "public:general", "unique-5", CHAT_RATE_POLICIES.public_standard_v1, 12_001)).toEqual({ allowed: true });
  });

  it("R9: rollback restores both aggregate and channel tokens and fingerprints", () => {
    const limiter = new BoundedChatRateLimiter(10, 1_000);
    const reservation = limiter.reserve("rollback", "public:trading", "Buy herbs", CHAT_RATE_POLICIES.public_trading_v1, 0);
    expect(reservation.allowed).toBe(true);
    if (reservation.allowed) reservation.reservation.rollback();
    expect(limiter.consume("rollback", "public:trading", "Buy herbs", CHAT_RATE_POLICIES.public_trading_v1, 0)).toEqual({ allowed: true });
    expect(limiter.consume("rollback", "public:trading", "Buy herbs", CHAT_RATE_POLICIES.public_trading_v1, 1).allowed).toBe(false);
  });

  it("R10: channel and aggregate maps remain independently bounded", () => {
    const limiter = new BoundedChatRateLimiter(4, 100, 1, 3);
    for (let i = 0; i < 10; i += 1) {
      limiter.consume(`player-${i}`, "public:general", `msg-${i}`, CHAT_RATE_POLICIES.public_standard_v1, i * 2);
    }
    expect(limiter.size).toBeLessThanOrEqual(7);
  });

  it("keeps one active room, prevents duplicate subscriptions, and fully cleans disconnects", () => {
    const subscriptions = new ChatSubscriptionRegistry(10, 3);
    subscriptions.selectActive("connection-1", "public:general");
    subscriptions.selectActive("connection-1", "public:general");
    subscriptions.replacePreviews("connection-1", ["public:general", "public:general", "public:trading"]);
    subscriptions.selectActive("connection-1", "public:trading");
    expect(subscriptions.activeConnectionIds("public:general")).toEqual([]);
    expect(subscriptions.activeConnectionIds("public:trading")).toEqual(["connection-1"]);
    expect(subscriptions.metrics()).toEqual({
      connections: 1,
      activeSubscriptions: 1,
      previewSubscriptions: 2
    });
    expect(subscriptions.removeConnection("connection-1")).toBe(true);
    expect(subscriptions.metrics()).toEqual({
      connections: 0,
      activeSubscriptions: 0,
      previewSubscriptions: 0
    });
  });
});

function message(channelKey: string, sequence: number): ChatMessage {
  const timestamp = new Date(sequence).toISOString();
  return {
    id: `${channelKey}:${sequence}`,
    channelId: channelKey,
    channelKey,
    sequence,
    senderPlayerId: "player",
    senderDisplayName: "Ash",
    body: `message ${sequence}`,
    serverCreatedAt: timestamp,
    clientRequestId: `request:${sequence}`,
    status: "confirmed",
    moderationStatus: "pending",
    editedAt: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

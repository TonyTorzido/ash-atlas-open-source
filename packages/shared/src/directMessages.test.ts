import { describe, expect, it } from "vitest";

import {
  DIRECT_MESSAGE_BODY_MAX_LENGTH,
  directMessageClientMessageSchema,
  directMessageCursorSchema,
  directMessageServerMessageSchema
} from "./directMessages.js";
import { parseClientMessage, serializeServerMessage } from "./protocol.js";

const requestId = "dm-request-1";
const conversationId = "00000000-0000-4000-8000-000000000001";
const peerPlayerId = "00000000-0000-4000-8000-000000000002";
const senderPlayerId = "00000000-0000-4000-8000-000000000003";
const clientMessageId = "00000000-0000-4000-8000-000000000004";

function sendMessage() {
  return {
    type: "DM_SEND",
    requestId,
    conversationId,
    clientMessageId,
    body: "Meet me at the northern gate."
  } as const;
}

const storedMessage = {
  id: "00000000-0000-4000-8000-000000000005",
  conversationId,
  sequence: "9223372036854775807",
  senderPlayerId,
  clientMessageId,
  body: "Meet me at the northern gate.",
  status: "sent" as const,
  serverCreatedAt: "2026-07-15T18:00:00.000Z"
};

describe("direct-message client protocol", () => {
  it.each([
    { type: "DM_BOOTSTRAP", requestId, afterEventSequence: "0" },
    { type: "DM_LIST", requestId, cursor: null, limit: 25, search: "Ranger" },
    { type: "DM_OPEN", requestId, peerPlayerId },
    { type: "DM_HISTORY", requestId, conversationId, beforeSequence: "99", limit: 50 },
    sendMessage(),
    { type: "DM_READ", requestId, conversationId, throughSequence: "9" },
    { type: "DM_DELIVERED", requestId, conversationId, throughSequence: "9" },
    { type: "DM_MUTE", requestId, conversationId, muted: true },
    {
      type: "DM_PREFERENCES",
      requestId,
      preferences: { soundsEnabled: false, suppressBannersDuringCombat: true }
    },
    { type: "DM_SYNC", requestId, afterEventSequence: "0", limit: 100 },
    { type: "DM_EVENT_ACK", requestId, throughEventSequence: "12" }
  ])("accepts valid $type intent through the aggregate protocol", (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    "senderPlayerId",
    "senderDisplayName",
    "recipientPlayerId",
    "serverCreatedAt",
    "createdAt",
    "timestamp",
    "status",
    "deliveredAt",
    "readAt",
    "sequence"
  ])("rejects forged send authority field %s", (field) => {
    expect(directMessageClientMessageSchema.safeParse({
      ...sendMessage(),
      [field]: field.endsWith("At") ? "2026-07-15T18:00:00.000Z" : "forged"
    }).success).toBe(false);
  });

  it("requires UUID idempotency keys and enforces body and page limits", () => {
    expect(directMessageClientMessageSchema.safeParse({ ...sendMessage(), clientMessageId: "retry-1" }).success)
      .toBe(false);
    expect(directMessageClientMessageSchema.safeParse({ ...sendMessage(), body: "x".repeat(DIRECT_MESSAGE_BODY_MAX_LENGTH + 1) }).success)
      .toBe(false);
    expect(directMessageClientMessageSchema.safeParse({ type: "DM_LIST", requestId, limit: 26 }).success)
      .toBe(false);
    expect(directMessageClientMessageSchema.safeParse({ type: "DM_HISTORY", requestId, conversationId, limit: 51 }).success)
      .toBe(false);
  });

  it("uses canonical signed-bigint-safe decimal strings", () => {
    for (const value of ["0", "1", "9007199254740993", "9223372036854775807"]) {
      expect(directMessageCursorSchema.safeParse(value).success).toBe(true);
    }
    for (const value of [1, "", "00", "01", "-1", "+1", "1.0", "1e3", "9223372036854775808"]) {
      expect(directMessageCursorSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("direct-message server protocol", () => {
  it("validates and serializes an authoritative idempotent send result", () => {
    const result = {
      type: "DM_SEND_RESULT",
      requestId,
      result: "duplicate",
      replayed: true,
      message: storedMessage
    } as const;
    expect(directMessageServerMessageSchema.parse(result)).toEqual(result);
    expect(JSON.parse(serializeServerMessage(result))).toEqual(result);
  });

  it("validates bounded reconnect event batches with durable cursors", () => {
    const result = {
      type: "DM_SYNC_RESULT",
      requestId,
      result: "ok",
      afterEventSequence: "40",
      latestEventSequence: "41",
      events: [{
        kind: "message_delivered",
        eventSequence: "41",
        occurredAt: "2026-07-15T18:01:00.000Z",
        conversationId,
        deliveredThroughSequence: "9223372036854775807"
      }],
      hasMore: false
    } as const;
    expect(directMessageServerMessageSchema.parse(result)).toEqual(result);
  });

  it("keeps errors request-correlated and privacy-safe", () => {
    expect(directMessageServerMessageSchema.safeParse({
      type: "DM_ERROR",
      requestId,
      code: "recipient_unavailable",
      message: "That player cannot receive messages.",
      retryable: false
    }).success).toBe(true);
    expect(directMessageServerMessageSchema.safeParse({
      type: "DM_ERROR",
      requestId,
      code: "not_allowed",
      message: "Blocked by player 00000000-0000-4000-8000-000000000099",
      retryable: false
    }).success).toBe(false);
  });
});

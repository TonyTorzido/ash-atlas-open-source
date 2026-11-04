import type {
  DirectMessage,
  DirectMessageConversationSummary,
  DirectMessageEvent
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../logger.js";
import { ConnectionRegistry, type SocketLike } from "../realtime/connectionRegistry.js";
import { DirectMessageRealtimeCoordinator } from "./directMessageRealtime.js";
import type { DirectMessageService } from "./directMessageService.js";
import { DirectMessageError } from "./types.js";

const SENDER_ID = "11111111-1111-4111-8111-111111111111";
const RECIPIENT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

class RecordingSocket implements SocketLike {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
}

describe("DirectMessageRealtimeCoordinator", () => {
  it("acknowledges the authoritative send and pushes the recipient's durable event", async () => {
    const { coordinator, service, sender, recipient, senderConnectionId } = setup(true);

    await coordinator.handle(senderConnectionId, SENDER_ID, sendRequest());

    expect(service.sendToConversation).toHaveBeenCalledWith({
      senderPlayerId: SENDER_ID,
      conversationId: CONVERSATION_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      body: "hello"
    });
    expect(sender.sent).toContainEqual(expect.objectContaining({
      type: "DM_SEND_RESULT",
      requestId: "send-1",
      replayed: false,
      message: MESSAGE
    }));
    expect(recipient.sent).toContainEqual(expect.objectContaining({
      type: "DM_EVENT",
      afterEventSequence: "0",
      latestEventSequence: "1",
      events: [MESSAGE_EVENT]
    }));
  });

  it("keeps an offline recipient undelivered and relies on durable sync", async () => {
    const { coordinator, service, sender, senderConnectionId } = setup(false);

    await coordinator.handle(senderConnectionId, SENDER_ID, sendRequest());

    expect(sender.sent).toContainEqual(expect.objectContaining({ type: "DM_SEND_RESULT" }));
    expect(service.markDelivered).not.toHaveBeenCalled();
    expect(service.syncEvents).not.toHaveBeenCalled();
  });

  it("does not repush a duplicate/replayed send", async () => {
    const fixture = setup(true);
    fixture.service.sendToConversation.mockResolvedValue({ message: MESSAGE, replayed: true });

    await fixture.coordinator.handle(fixture.senderConnectionId, SENDER_ID, sendRequest());

    expect(fixture.sender.sent).toContainEqual(expect.objectContaining({
      type: "DM_SEND_RESULT",
      result: "duplicate",
      replayed: true
    }));
    expect(fixture.service.getConversation).not.toHaveBeenCalled();
    expect(fixture.recipient.sent).toEqual([]);
  });

  it("advances delivered state only after the explicit recipient frame and pushes the sender", async () => {
    const fixture = setup(true);
    const recipientConnectionId = fixture.registry.activeConnectionIdForPlayer(RECIPIENT_ID)!;

    await fixture.coordinator.handle(recipientConnectionId, RECIPIENT_ID, {
      type: "DM_DELIVERED",
      requestId: "delivered-1",
      conversationId: CONVERSATION_ID,
      throughSequence: "1"
    });

    expect(fixture.service.markDelivered).toHaveBeenCalledWith(
      RECIPIENT_ID,
      CONVERSATION_ID,
      "1"
    );
    expect(fixture.recipient.sent).toContainEqual(expect.objectContaining({
      type: "DM_DELIVERED_RESULT",
      deliveredThroughSequence: "1"
    }));
    expect(fixture.sender.sent).toContainEqual(expect.objectContaining({ type: "DM_EVENT" }));
  });

  it("returns fixed privacy-safe block errors without exposing service details", async () => {
    const fixture = setup(false);
    fixture.service.sendToConversation.mockRejectedValue(
      new DirectMessageError("not_allowed", "sensitive internal block direction")
    );

    await fixture.coordinator.handle(fixture.senderConnectionId, SENDER_ID, sendRequest());

    expect(fixture.sender.sent).toContainEqual({
      type: "DM_ERROR",
      requestId: "send-1",
      code: "not_allowed",
      message: "You cannot perform that action.",
      retryable: false
    });
  });

  it("dispatches every bounded bootstrap, list, open, history, preference, sync, and ACK frame", async () => {
    const fixture = setup(false);
    const requests = [
      { type: "DM_BOOTSTRAP", requestId: "bootstrap", afterEventSequence: "0" },
      { type: "DM_LIST", requestId: "list", limit: 25 },
      { type: "DM_OPEN", requestId: "open", peerPlayerId: RECIPIENT_ID },
      { type: "DM_HISTORY", requestId: "history", conversationId: CONVERSATION_ID, limit: 50 },
      { type: "DM_READ", requestId: "read", conversationId: CONVERSATION_ID, throughSequence: "1" },
      { type: "DM_MUTE", requestId: "mute", conversationId: CONVERSATION_ID, muted: true },
      {
        type: "DM_PREFERENCES",
        requestId: "preferences",
        preferences: { soundsEnabled: false, suppressBannersDuringCombat: true }
      },
      { type: "DM_SYNC", requestId: "sync", afterEventSequence: "0", limit: 100 },
      { type: "DM_EVENT_ACK", requestId: "ack", throughEventSequence: "1" }
    ] as const;
    for (const request of requests) {
      await fixture.coordinator.handle(fixture.senderConnectionId, SENDER_ID, request);
    }

    expect(fixture.sender.sent.map((frame) => (frame as { type: string }).type)).toEqual([
      "DM_BOOTSTRAP_RESULT",
      "DM_LIST_RESULT",
      "DM_OPEN_RESULT",
      "DM_HISTORY_RESULT",
      "DM_READ_RESULT",
      "DM_MUTE_RESULT",
      "DM_PREFERENCES_RESULT",
      "DM_SYNC_RESULT",
      "DM_EVENT_ACKED"
    ]);
  });

  it("lets the critical sender ACK through when recipient social delivery is congested", async () => {
    const fixture = setup(true, 1);
    fixture.recipient.bufferedAmount = 2;

    await fixture.coordinator.handle(fixture.senderConnectionId, SENDER_ID, sendRequest());

    expect(fixture.sender.sent).toContainEqual(expect.objectContaining({ type: "DM_SEND_RESULT" }));
    expect(fixture.recipient.sent).toEqual([]);
    expect(fixture.registry.metricsSnapshot().recoverableSocialSkipped).toBe(1);
  });
});

function setup(recipientOnline: boolean, softBufferedBytes = 512 * 1024) {
  const registry = new ConnectionRegistry(softBufferedBytes, 4 * 1024 * 1024, 20);
  const sender = new RecordingSocket();
  const recipient = new RecordingSocket();
  const senderConnectionId = registry.add({
    accountId: "sender-account",
    playerId: SENDER_ID,
    username: "Sender",
    regionCode: "test",
    zoneId: "test:0",
    socket: sender
  });
  if (recipientOnline) {
    registry.add({
      accountId: "recipient-account",
      playerId: RECIPIENT_ID,
      username: "Recipient",
      regionCode: "test",
      zoneId: "test:0",
      socket: recipient
    });
  }

  const service = {
    sendToConversation: vi.fn().mockResolvedValue({ message: MESSAGE, replayed: false }),
    getConversation: vi.fn().mockImplementation((playerId: string) => Promise.resolve(
      playerId === SENDER_ID ? SENDER_CONVERSATION : RECIPIENT_CONVERSATION
    )),
    syncEvents: vi.fn().mockResolvedValue({
      events: [MESSAGE_EVENT],
      acknowledgedCursor: "0",
      nextCursor: "1",
      hasMore: false
    }),
    markDelivered: vi.fn().mockResolvedValue("1"),
    markRead: vi.fn().mockResolvedValue("1"),
    setMuted: vi.fn(),
    getPreferences: vi.fn().mockResolvedValue({
      soundsEnabled: true,
      suppressBannersDuringCombat: false
    }),
    updatePreferences: vi.fn().mockResolvedValue({
      soundsEnabled: false,
      suppressBannersDuringCombat: true
    }),
    listConversations: vi.fn().mockResolvedValue({
      conversations: [SENDER_CONVERSATION],
      nextCursor: null
    }),
    openConversation: vi.fn().mockResolvedValue(SENDER_CONVERSATION),
    history: vi.fn().mockResolvedValue({
      conversationId: CONVERSATION_ID,
      messages: [MESSAGE],
      hasMore: false,
      beforeSequence: "1",
      latestSequence: "1"
    }),
    acknowledgeEvents: vi.fn().mockResolvedValue("1")
  };
  service.setMuted.mockResolvedValue(true);
  const coordinator = new DirectMessageRealtimeCoordinator(
    service as unknown as DirectMessageService,
    registry,
    createLogger("test")
  );
  return { coordinator, registry, service, sender, recipient, senderConnectionId };
}

function sendRequest() {
  return {
    type: "DM_SEND" as const,
    requestId: "send-1",
    conversationId: CONVERSATION_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    body: "hello"
  };
}

const MESSAGE: DirectMessage = {
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  sequence: "1",
  senderPlayerId: SENDER_ID,
  clientMessageId: CLIENT_MESSAGE_ID,
  body: "hello",
  status: "sent",
  serverCreatedAt: "2026-07-15T12:00:00.000Z"
};

const SENDER_CONVERSATION: DirectMessageConversationSummary = {
  id: CONVERSATION_ID,
  peer: { playerId: RECIPIENT_ID, displayName: "Recipient", online: true },
  canSend: true,
  latestMessage: MESSAGE,
  latestSequence: "1",
  lastReadSequence: "0",
  deliveredThroughSequence: "0",
  unreadCount: 0,
  muted: false,
  updatedAt: MESSAGE.serverCreatedAt
};

const RECIPIENT_CONVERSATION: DirectMessageConversationSummary = {
  ...SENDER_CONVERSATION,
  peer: { playerId: SENDER_ID, displayName: "Sender", online: true },
  unreadCount: 1
};

const MESSAGE_EVENT: DirectMessageEvent = {
  kind: "message_created",
  eventSequence: "1",
  occurredAt: MESSAGE.serverCreatedAt,
  conversation: RECIPIENT_CONVERSATION,
  message: MESSAGE
};

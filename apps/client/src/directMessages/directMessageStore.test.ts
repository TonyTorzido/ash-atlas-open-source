import { describe, expect, it, vi } from "vitest";
import type {
  DirectMessage,
  DirectMessageConversationSummary,
  DirectMessageEvent,
  DirectMessagePeerSummary
} from "@ash-atlas/shared";

import { DirectMessageStore } from "./directMessageStore.js";

const SELF = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const CONVERSATION = "00000000-0000-4000-8000-000000000010";

describe("DirectMessageStore", () => {
  it("opens a transient peer immediately and reconciles an optimistic UUID without duplication", () => {
    const store = createStore();
    const firstSnapshot = store.getSnapshot();
    expect(store.getSnapshot()).toBe(firstSnapshot);

    store.openPeer(peer());
    expect(store.getSnapshot().selectedConversation?.transient).toBe(true);
    const pending = store.startOptimisticSend(" hello\r\nthere ", "00000000-0000-4000-8000-000000000101");
    expect(pending.accepted).toBe(true);
    if (!pending.accepted) return;
    expect(pending.send).toEqual({
      conversationId: null,
      clientMessageId: "00000000-0000-4000-8000-000000000101",
      recipientPlayerId: PEER,
      body: "hello\nthere"
    });
    expect(store.getSnapshot().messages[0]?.deliveryState).toBe("sending");
    expect(store.getPendingSendsForRecipient(PEER)).toEqual([pending.send]);

    store.applyConversationPage({ conversations: [summary()], nextCursor: null, reset: false });
    store.acknowledgeMessage(message("1", "00000000-0000-4000-8000-000000000101", "hello\nthere"));
    const snapshot = store.getSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({ id: "00000000-0000-4000-8001-000000000001", sequence: "1", deliveryState: "sent" });
    expect(snapshot.unresolvedSendCount).toBe(0);
    expect(store.getPendingSendsForRecipient(PEER)).toHaveLength(0);
  });

  it("fails unconfirmed sends on disconnect and only retries on explicit user action", () => {
    const store = createStore();
    store.openPeer(peer());
    const pending = store.startOptimisticSend("hello", "00000000-0000-4000-8000-000000000102");
    expect(pending.accepted).toBe(true);

    store.failPendingSends();
    expect(store.getSnapshot().messages[0]).toMatchObject({
      deliveryState: "failed",
      errorCode: "CONNECTION_LOST"
    });
    expect(store.getPendingSendsForRecipient(PEER)).toHaveLength(0);

    const retried = store.retryMessage("00000000-0000-4000-8000-000000000102");
    expect(retried).not.toBeNull();
    expect(store.getPendingSendsForRecipient(PEER)).toEqual([retried]);
  });

  it("uses authoritative bigint string ordering and monotonic delivered/read cursors", () => {
    const store = createStore();
    store.applyConversationPage({ conversations: [summary({ latestSequence: "9007199254740994" })], nextCursor: null, reset: true });
    store.openPeer(peer());
    store.applyMessagePage({
      conversationId: CONVERSATION,
      messages: [
        message("9007199254740994", "00000000-0000-4000-8000-000000000114", "later"),
        message("9007199254740993", "00000000-0000-4000-8000-000000000113", "earlier")
      ],
      hasOlder: false,
      reset: true
    });
    expect(store.getSnapshot().messages.map((item) => item.body)).toEqual(["earlier", "later"]);

    store.applyDeliveryCursor(CONVERSATION, "9007199254740994");
    expect(store.getSnapshot().messages.map((item) => item.deliveryState)).toEqual(["delivered", "delivered"]);
    store.applyPeerReadCursor(CONVERSATION, "9007199254740993");
    expect(store.getSnapshot().messages.map((item) => item.deliveryState)).toEqual(["read", "delivered"]);
    store.applyDeliveryCursor(CONVERSATION, "1");
    expect(store.getSnapshot().messages[1]?.deliveryState).toBe("delivered");
  });

  it("carries the server block state into the conversation and prevents sends", () => {
    const store = createStore();
    store.applyConversationPage({
      conversations: [summary({ canSend: false })],
      nextCursor: null,
      reset: true
    });
    store.openPeer(peer());

    expect(store.getSnapshot().selectedConversation).toMatchObject({
      blocked: true,
      canMessage: false
    });
    expect(store.startOptimisticSend("should stay hidden").accepted).toBe(false);
  });

  it("accepts gaps in globally allocated event ids and tracks paginated recovery", () => {
    const store = createStore();
    store.setEventCursor("9007199254740992");
    const eventLater = conversationEvent("9007199254740994");
    expect(store.applyEvent(eventLater)).toBe(true);
    expect(store.getSnapshot().gap).toMatchObject({
      acknowledgedEventCursor: "9007199254740994",
      highestSeenEventCursor: "9007199254740994",
      needsSync: false
    });
    expect(store.applyEvent(eventLater)).toBe(false);
    expect(store.applyEvent(conversationEvent("9007199254740993"))).toBe(false);

    store.applyEventBatch(
      "9007199254740994",
      "9007199254740998",
      [conversationEvent("9007199254740996")]
    );
    expect(store.getSnapshot().gap).toMatchObject({
      acknowledgedEventCursor: "9007199254740996",
      highestSeenEventCursor: "9007199254740998",
      needsSync: true
    });
    store.applyEventBatch(
      "9007199254740996",
      "9007199254740998",
      [conversationEvent("9007199254740998")]
    );
    expect(store.getSnapshot().gap).toMatchObject({
      acknowledgedEventCursor: "9007199254740998",
      needsSync: false
    });
  });

  it("prepends paginated history without duplicates and keeps a bounded newest window", () => {
    const store = new DirectMessageStore({
      ownPlayerId: SELF,
      activeMessageLimit: 6,
      inactiveMessageLimit: 3,
      createClientMessageId: vi.fn(() => "00000000-0000-4000-8000-000000000100")
    });
    store.applyConversationPage({ conversations: [summary({ latestSequence: "6" })], nextCursor: null, reset: true });
    store.openPeer(peer());
    store.applyMessagePage({ conversationId: CONVERSATION, messages: [4, 5, 6].map((sequence) => message(String(sequence))), hasOlder: true, reset: true });
    store.applyMessagePage({ conversationId: CONVERSATION, messages: [1, 2, 3, 4].map((sequence) => message(String(sequence))), hasOlder: false, reset: false });
    expect(store.getSnapshot().messages.map((item) => item.sequence)).toEqual(["1", "2", "3", "4", "5", "6"]);

    store.applyMessagePage({ conversationId: CONVERSATION, messages: [message("7")], hasOlder: true, reset: false });
    expect(store.getSnapshot().messages.map((item) => item.sequence)).toEqual(["2", "3", "4", "5", "6", "7"]);
    expect(store.getSnapshot().selectedConversation?.hasOlderMessages).toBe(true);
  });

  it("applies shared server frames and preferences without a transport adapter", () => {
    const store = createStore();
    const applied = store.applyServerMessage({
      type: "DM_BOOTSTRAP_RESULT",
      requestId: "bootstrap-1",
      result: "ok",
      conversations: [summary()],
      nextCursor: null,
      preferences: { soundsEnabled: false, suppressBannersDuringCombat: false },
      afterEventSequence: "20",
      latestEventSequence: "20",
      events: [],
      hasMore: false
    });
    expect(applied).toBe(true);
    expect(store.getSnapshot().preferences).toEqual({ soundsEnabled: false, suppressBannersDuringCombat: false });
    expect(store.getSnapshot().gap.acknowledgedEventCursor).toBe("20");
  });
});

function createStore(): DirectMessageStore {
  return new DirectMessageStore({
    ownPlayerId: SELF,
    now: () => Date.parse("2026-07-15T18:00:00.000Z"),
    createClientMessageId: vi.fn(() => "00000000-0000-4000-8000-000000000100")
  });
}

function peer(): DirectMessagePeerSummary {
  return { playerId: PEER, displayName: "Atlas Friend", online: true };
}

function summary(overrides: Partial<DirectMessageConversationSummary> = {}): DirectMessageConversationSummary {
  return {
    id: CONVERSATION,
    peer: peer(),
    canSend: true,
    latestMessage: null,
    latestSequence: "0",
    lastReadSequence: "0",
    deliveredThroughSequence: "0",
    unreadCount: 0,
    muted: false,
    updatedAt: "2026-07-15T18:00:00.000Z",
    ...overrides
  };
}

function message(
  sequence: string,
  clientMessageId = `00000000-0000-4000-8000-${sequence.padStart(12, "0")}`,
  body = `Message ${sequence}`
): DirectMessage {
  const suffix = (BigInt(sequence) % 1_000_000_000_000n).toString().padStart(12, "0");
  return {
    id: `00000000-0000-4000-8001-${suffix}`,
    conversationId: CONVERSATION,
    sequence,
    senderPlayerId: SELF,
    clientMessageId,
    body,
    status: "sent",
    serverCreatedAt: "2026-07-15T18:00:00.000Z"
  };
}

function conversationEvent(eventSequence: string): DirectMessageEvent {
  return {
    kind: "conversation_updated",
    eventSequence,
    occurredAt: "2026-07-15T18:00:00.000Z",
    conversation: summary()
  };
}

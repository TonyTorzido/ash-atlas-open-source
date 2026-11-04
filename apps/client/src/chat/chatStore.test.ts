import {
  CHAT_ACTIVE_MESSAGE_LIMIT,
  CHAT_DEDUPE_LIMIT,
  CHAT_FAILED_MESSAGE_LIMIT,
  CHAT_INACTIVE_MESSAGE_LIMIT,
  CHAT_LOCAL_CHANNEL_KEY,
  CHAT_PENDING_MESSAGE_LIMIT,
  type ChatChannel,
  type ChatMessage,
  type ChatReadState
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  CHAT_SELECTED_CHANNEL_STORAGE_KEY,
  ChatStore,
  chatCharacterCount,
  normalizeChatBody
} from "./chatStore.js";

const GENERAL = "public:general";
const TRADING = "public:trading";
const HUNTING = "public:hunting";
const LOCAL = CHAT_LOCAL_CHANNEL_KEY;

describe("ChatStore bounds", () => {
  it("never exceeds the active-message or dedupe caps after thousands of messages", () => {
    const store = readyStore();

    for (let sequence = 1; sequence <= 3_000; sequence += 1) {
      store.applyMessage(message(GENERAL, sequence));
    }

    const snapshot = store.getSnapshot();
    const confirmed = snapshot.messages.filter((item) => item.state === "confirmed");
    expect(confirmed).toHaveLength(CHAT_ACTIVE_MESSAGE_LIMIT);
    expect(confirmed[0]?.sequence).toBe(2_801);
    expect(confirmed.at(-1)?.sequence).toBe(3_000);
    expect(store.getDiagnostics().activeMessageCount).toBe(CHAT_ACTIVE_MESSAGE_LIMIT);
    expect(store.getDiagnostics().dedupeCount).toBeLessThanOrEqual(CHAT_DEDUPE_LIMIT);
  });

  it("prunes the previous room to the inactive cap every time rooms switch", () => {
    const store = readyStore();
    for (let sequence = 1; sequence <= 400; sequence += 1) {
      store.applyMessage(message(GENERAL, sequence));
    }

    expect(store.selectChannel(TRADING)).toBe(true);
    expect(store.getDiagnostics().largestInactiveMessageCount).toBe(CHAT_INACTIVE_MESSAGE_LIMIT);
    for (let sequence = 401; sequence <= 650; sequence += 1) {
      store.applyMessage(message(GENERAL, sequence));
    }
    expect(store.getDiagnostics().largestInactiveMessageCount).toBe(CHAT_INACTIVE_MESSAGE_LIMIT);
    for (let sequence = 1; sequence <= 80; sequence += 1) {
      store.applyMessage(message(TRADING, sequence));
    }
    expect(store.selectChannel(GENERAL)).toBe(true);

    expect(store.getDiagnostics()).toMatchObject({
      activeMessageCount: CHAT_INACTIVE_MESSAGE_LIMIT,
      largestInactiveMessageCount: CHAT_INACTIVE_MESSAGE_LIMIT
    });
  });

  it("refuses excess pending messages and evicts old failed messages", () => {
    const store = readyStore();
    for (let index = 0; index < CHAT_PENDING_MESSAGE_LIMIT; index += 1) {
      expect(startPending(store, `request-${index}`).accepted).toBe(true);
    }
    expect(startPending(store, "request-overflow")).toEqual({
      accepted: false,
      reason: "pending_limit"
    });

    for (let index = 0; index < CHAT_PENDING_MESSAGE_LIMIT; index += 1) {
      expect(store.failPending(`request-${index}`, "RATE_LIMITED", 1_000)).toBe(true);
    }
    for (let index = 0; index < 15; index += 1) {
      const requestId = `later-${index}`;
      expect(startPending(store, requestId).accepted).toBe(true);
      expect(store.failPending(requestId, "SEND_FAILED")).toBe(true);
    }

    expect(store.getDiagnostics()).toMatchObject({
      pendingCount: 0,
      failedCount: CHAT_FAILED_MESSAGE_LIMIT
    });
    expect(store.getSnapshot().messages.filter((item) => item.state === "failed")).toHaveLength(
      CHAT_FAILED_MESSAGE_LIMIT
    );
  });

  it("keeps a bounded sliding history window when older messages are prepended", () => {
    const store = readyStore();
    store.applyChannelSelected({
      channelKey: GENERAL,
      messages: messages(GENERAL, 101, 300),
      latestSequence: 300,
      hasOlder: true,
      reset: false,
      readState: readState(GENERAL, 300, 300),
      mute: unmuted(GENERAL)
    });

    store.applyHistoryResult({
      channelKey: GENERAL,
      direction: "older",
      messages: messages(GENERAL, 51, 100),
      hasMore: true,
      latestSequence: 300,
      reset: false
    });

    expect(store.getSnapshot().oldestLoadedSequence).toBe(51);
    expect(store.getSnapshot().newestLoadedSequence).toBe(250);
    expect(store.getSnapshot().selectedChannel?.hasNewer).toBe(true);
    expect(store.getDiagnostics().activeMessageCount).toBe(CHAT_ACTIVE_MESSAGE_LIMIT);

    store.setViewportAtBottom(false);
    store.applyMessage(message(GENERAL, 301));
    expect(store.getSnapshot().newestLoadedSequence).toBe(250);
    expect(store.getSnapshot().selectedChannel?.hasNewer).toBe(true);
    expect(store.getSnapshot().newMessageCount).toBe(1);
  });
});

describe("ChatStore delivery behavior", () => {
  it("keeps the newest aggregate count and account pin order", () => {
    const store = readyStore();
    expect(store.applyOnlinePlayerCount({
      count: 12,
      revision: 4,
      observedAt: "2026-07-27T18:00:00.000Z",
      players: []
    })).toBe(true);
    expect(store.applyOnlinePlayerCount({
      count: 99,
      revision: 3,
      observedAt: "2026-07-27T18:00:01.000Z",
      players: []
    })).toBe(false);
    store.applyPinnedChannelCategories(["local", "general", "trading"]);
    expect(store.getSnapshot()).toMatchObject({
      onlinePlayerCount: { count: 12, revision: 4 },
      pinnedChannelCategories: ["local", "general", "trading"]
    });
  });

  it("reconciles optimistic messages and ignores duplicate delivery without duplicate unread", () => {
    const store = readyStore();
    expect(startPending(store, "request-1").accepted).toBe(true);

    const confirmed = {
      ...message(GENERAL, 1, "request-1"),
      senderPlayerId: "self",
      senderDisplayName: "Self"
    };
    store.applySendResult(confirmed);
    store.applyMessage(confirmed);

    expect(store.getSnapshot().pendingCount).toBe(0);
    expect(store.getSnapshot().messages).toHaveLength(1);
    expect(store.getSnapshot().selectedChannel?.unreadCount).toBe(0);

    store.setViewportAtBottom(false);
    const second = message(GENERAL, 2);
    store.applyMessage(second);
    store.applyMessage(second);

    expect(store.getSnapshot().messages).toHaveLength(2);
    expect(store.getSnapshot().newMessageCount).toBe(1);
    expect(store.getSnapshot().selectedChannel?.unreadCount).toBe(1);
    expect(store.setViewportAtBottom(true)).toBe(2);
    expect(store.getSnapshot().newMessageCount).toBe(0);
    expect(store.getSnapshot().selectedChannel?.unreadCount).toBe(0);
  });

  it("sorts out-of-order delivery, detects a gap, and clears it after catch-up", () => {
    const store = readyStore();
    store.applyMessage(message(GENERAL, 1));
    store.applyMessage(message(GENERAL, 3));
    store.applyMessage(message(GENERAL, 2));

    expect(store.getSnapshot().messages.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(store.getSnapshot().selectedChannel?.needsRefresh).toBe(true);

    store.applyHistoryResult({
      channelKey: GENERAL,
      direction: "newer",
      messages: [message(GENERAL, 2), message(GENERAL, 3)],
      hasMore: false,
      latestSequence: 3,
      reset: false
    });
    expect(store.getSnapshot().messages.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(store.getSnapshot().selectedChannel?.needsRefresh).toBe(false);
  });

  it("uses authoritative preview/unread values without retaining inactive history", () => {
    const store = readyStore();
    store.applyPreviewUpdate(
      {
        id: "preview-9",
        channelKey: TRADING,
        sequence: 9,
        senderPlayerId: "trader",
        senderDisplayName: "Trader",
        body: "WTS a long but bounded preview",
        serverCreatedAt: "2026-07-10T12:00:00.000Z"
      },
      9,
      7
    );

    const trading = store.getSnapshot().channels.find((item) => item.channel.key === TRADING);
    expect(trading?.preview?.body).toBe("WTS a long but bounded preview");
    expect(trading?.unreadCount).toBe(7);
    expect(store.getDiagnostics().largestInactiveMessageCount).toBe(0);
  });

  it("bounds and disposes subscriptions", () => {
    const store = readyStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.applyMessage(message(GENERAL, 1));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getDiagnostics().subscriberCount).toBe(1);

    unsubscribe();
    store.applyMessage(message(GENERAL, 2));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getDiagnostics().subscriberCount).toBe(0);
  });

  it("reuses confirmed message views across append and preview-only publishes", () => {
    const store = readyStore();
    store.applyMessage(message(GENERAL, 1));
    const firstView = store.getSnapshot().messages[0];

    store.applyMessage(message(GENERAL, 2));
    expect(store.getSnapshot().messages[0]).toBe(firstView);
    store.applyPreviewUpdate(
      {
        id: "trading-preview",
        channelKey: TRADING,
        sequence: 1,
        senderPlayerId: "trader",
        senderDisplayName: "Trader",
        body: "Preview only",
        serverCreatedAt: "2026-07-10T12:00:00.000Z"
      },
      1,
      1
    );
    expect(store.getSnapshot().messages[0]).toBe(firstView);
  });

  it("ignores stale channel-selection responses", () => {
    const store = readyStore();
    store.selectChannel(TRADING);
    store.expectChannelSelection(TRADING, "selection-trading");
    store.selectChannel(HUNTING);
    store.expectChannelSelection(HUNTING, "selection-hunting");

    store.applyChannelSelected({
      requestId: "selection-hunting",
      channelKey: HUNTING,
      messages: [message(HUNTING, 1)],
      latestSequence: 1,
      hasOlder: false,
      reset: false,
      readState: readState(HUNTING, 0, 1),
      mute: unmuted(HUNTING)
    });
    store.applyChannelSelected({
      requestId: "selection-trading",
      channelKey: TRADING,
      messages: [message(TRADING, 1)],
      latestSequence: 1,
      hasOlder: false,
      reset: false,
      readState: readState(TRADING, 0, 1),
      mute: unmuted(TRADING)
    });

    expect(store.getSnapshot().selectedChannelKey).toBe(HUNTING);
    expect(store.getSnapshot().messages.map((item) => item.channelKey)).toEqual([HUNTING]);
  });

  it("keeps a live message and fresher read state that beat the selection snapshot", () => {
    const store = readyStore();
    store.selectChannel(TRADING);
    store.expectChannelSelection(TRADING, "selection-trading");
    store.applyMessage(message(TRADING, 11));

    store.applyChannelSelected({
      requestId: "selection-trading",
      channelKey: TRADING,
      messages: messages(TRADING, 1, 10),
      latestSequence: 10,
      hasOlder: false,
      reset: false,
      readState: readState(TRADING, 10, 10),
      mute: unmuted(TRADING)
    });

    expect(store.getSnapshot().messages.map((item) => item.sequence)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1)
    );
    expect(store.getSnapshot().selectedChannel?.readState).toMatchObject({
      lastReadSequence: 10,
      latestSequence: 11,
      unreadCount: 1
    });
  });

  it("turns every ambiguous pending send into a bounded retryable failure", () => {
    const store = readyStore();
    expect(startPending(store, "one").accepted).toBe(true);
    expect(startPending(store, "two").accepted).toBe(true);

    expect(store.failAllPending()).toBe(2);
    expect(store.getSnapshot()).toMatchObject({ pendingCount: 0, failedCount: 2 });
    expect(store.getSnapshot().messages.map((item) => item.errorCode)).toEqual([
      "CHAT_DISCONNECTED",
      "CHAT_DISCONNECTED"
    ]);
    expect(store.retryFailed("one")?.requestId).toBe("one");
  });

  it("does not let an own preview or stale read ack clear unread while away from newest", () => {
    const store = readyStore();
    store.setViewportAtBottom(false);
    store.applyMessage(message(GENERAL, 1));
    store.applyPreviewUpdate(
      {
        id: "own-preview",
        channelKey: GENERAL,
        sequence: 2,
        senderPlayerId: "self",
        senderDisplayName: "Self",
        body: "Own message",
        serverCreatedAt: "2026-07-10T12:00:00.000Z"
      },
      2,
      0
    );
    store.applyReadState(readState(GENERAL, 0, 0));

    expect(store.getSnapshot().selectedChannel?.readState).toMatchObject({
      latestSequence: 2,
      unreadCount: 1
    });
  });
});

describe("ChatStore selection and input", () => {
  it("requests durable history when a bootstrap snapshot is newer than local messages", () => {
    const store = new ChatStore({ ownPlayerId: "self", storage: null });
    store.applyChannelsSnapshot({
      channels: [{ ...channel(GENERAL, "General"), latestSequence: 7 }],
      readStates: [readState(GENERAL, 0, 7)],
      previews: [],
      selectedChannelKey: GENERAL
    });

    expect(store.getSnapshot().selectedChannel?.needsRefresh).toBe(true);
    store.applyChannelSelected({
      channelKey: GENERAL,
      messages: messages(GENERAL, 1, 7),
      latestSequence: 7,
      hasOlder: false,
      reset: false,
      readState: readState(GENERAL, 0, 7),
      mute: unmuted(GENERAL)
    });
    expect(store.getSnapshot().selectedChannel?.needsRefresh).toBe(false);
  });

  it("defaults a fresh session to General and exposes the canonical channel order", () => {
    const storage = { getItem: () => null, setItem: vi.fn() };
    const store = readyStoreWithLocal(storage);
    expect(store.getSnapshot().selectedChannelKey).toBe(GENERAL);
    expect(store.getSnapshot().channels.map(({ channel }) => channel.key)).toEqual([
      GENERAL,
      TRADING,
      HUNTING,
      LOCAL
    ]);
  });

  it("restores and persists a valid selected room", () => {
    const values = new Map<string, string>([[CHAT_SELECTED_CHANNEL_STORAGE_KEY, HUNTING]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    };
    const store = readyStore(storage);

    expect(store.getSnapshot().selectedChannelKey).toBe(HUNTING);
    expect(store.selectChannel(TRADING)).toBe(true);
    expect(values.get(CHAT_SELECTED_CHANNEL_STORAGE_KEY)).toBe(TRADING);
  });

  it("restores and persists Local through the existing channel preference", () => {
    const values = new Map<string, string>([[CHAT_SELECTED_CHANNEL_STORAGE_KEY, LOCAL]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    };
    const store = readyStoreWithLocal(storage);

    expect(store.getSnapshot().selectedChannelKey).toBe(LOCAL);
    expect(store.selectChannel(GENERAL)).toBe(true);
    expect(store.selectChannel(LOCAL)).toBe(true);
    expect(values.get(CHAT_SELECTED_CHANNEL_STORAGE_KEY)).toBe(LOCAL);
  });

  it("normalizes line endings, rejects blanks, and counts Unicode characters", () => {
    const store = readyStore();
    expect(startPending(store, "blank", " \r\n ")).toEqual({
      accepted: false,
      reason: "blank"
    });
    const result = startPending(store, "normalized", " hello\r\nworld ");
    expect(result.accepted && result.message.body).toBe("hello\nworld");
    expect(normalizeChatBody(" a\r\nb\r ")).toBe("a\nb");
    expect(chatCharacterCount("A🧭" /* compass */)).toBe(2);
  });

  it("expires an optimistic mute using the injected clock", () => {
    let now = Date.parse("2026-07-10T12:00:00.000Z");
    const store = new ChatStore({ ownPlayerId: "self", storage: null, now: () => now });
    const channels = [channel(GENERAL, "General")];
    store.applyChannelsSnapshot({
      channels,
      readStates: [readState(GENERAL, 0, 0)],
      previews: [],
      selectedChannelKey: GENERAL
    });
    store.applyMuteSnapshot(GENERAL, {
      muted: true,
      channelKey: GENERAL,
      scope: "channel",
      reason: "Temporary mute",
      expiresAt: "2026-07-10T12:00:01.000Z"
    });
    expect(store.getSnapshot().selectedChannel?.mute.muted).toBe(true);

    now += 1_001;
    expect(store.refreshTemporalState()).toBe(true);
    expect(store.getSnapshot().selectedChannel?.mute.muted).toBe(false);
  });

  it("applies and clears an authoritative global mute across every public room", () => {
    const store = readyStore();
    store.applyMuteSnapshot(GENERAL, {
      muted: true,
      channelKey: null,
      scope: "global",
      reason: "Global safety mute",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    expect(store.getSnapshot().channels.every(({ mute }) => mute.muted)).toBe(true);

    store.applyMuteSnapshot(GENERAL, {
      muted: false,
      channelKey: null,
      scope: null,
      reason: null,
      expiresAt: null
    });
    expect(store.getSnapshot().channels.every(({ mute }) => !mute.muted)).toBe(true);
  });
});

describe("ChatStore live-session channels", () => {
  it("accepts sparse Local sequences without gap recovery or inflated unread counts", () => {
    const store = readyStoreWithLocal();
    store.selectChannel(LOCAL);
    store.applyMessage(message(LOCAL, 10));
    store.applyMessage(message(LOCAL, 500));

    expect(store.getSnapshot()).toMatchObject({
      selectedChannelKey: LOCAL,
      newMessageCount: 2,
      oldestLoadedSequence: 10,
      newestLoadedSequence: 500
    });
    expect(store.getSnapshot().selectedChannel).toMatchObject({
      unreadCount: 2,
      hasOlder: false,
      hasNewer: false,
      needsRefresh: false
    });

    store.setViewportAtBottom(true, LOCAL, 500);
    store.applyMessage(message(LOCAL, 9_000));
    expect(store.getSnapshot().selectedChannel).toMatchObject({
      unreadCount: 0,
      hasOlder: false,
      hasNewer: false,
      needsRefresh: false
    });
  });

  it("retains only received Local events and ignores durable snapshot or history artifacts", () => {
    const store = readyStoreWithLocal();
    store.selectChannel(LOCAL);
    store.applyMessage(message(LOCAL, 10));
    store.applyMessage(message(LOCAL, 30));
    const receivedPreview = store.getSnapshot().selectedChannel?.preview;

    const local = localChannel(50_000);
    store.applyChannelsSnapshot({
      channels: [channel(GENERAL, "General"), local],
      readStates: [readState(GENERAL, 0, 0), readState(LOCAL, 49_999, 50_000)],
      previews: [{
        id: "not-received",
        channelKey: LOCAL,
        sequence: 50_000,
        senderPlayerId: "hidden",
        senderDisplayName: "Hidden",
        body: "must not appear",
        serverCreatedAt: "2026-07-10T12:00:00.000Z"
      }],
      selectedChannelKey: LOCAL
    });
    store.applyChannelSelected({
      channelKey: LOCAL,
      messages: [message(LOCAL, 20)],
      latestSequence: 20,
      hasOlder: true,
      reset: true,
      readState: readState(LOCAL, 20, 20),
      mute: unmuted(LOCAL)
    });
    store.applyHistoryResult({
      channelKey: LOCAL,
      direction: "older",
      messages: [message(LOCAL, 5)],
      hasMore: true,
      latestSequence: 30,
      reset: false
    });
    store.applyPreviewUpdate({
      id: "preview-not-received",
      channelKey: LOCAL,
      sequence: 60_000,
      senderPlayerId: "hidden",
      senderDisplayName: "Hidden",
      body: "also hidden",
      serverCreatedAt: "2026-07-10T12:00:00.000Z"
    }, 60_000, 1);
    store.applyReadState(readState(LOCAL, 60_000, 60_000));

    const snapshot = store.getSnapshot();
    expect(snapshot.messages.map((item) => item.sequence)).toEqual([10, 30]);
    expect(snapshot.selectedChannel?.preview).toEqual(receivedPreview);
    expect(snapshot.selectedChannel).toMatchObject({
      hasOlder: false,
      hasNewer: false,
      needsRefresh: false
    });
  });

  it("bounds Local history with the existing active and inactive caps", () => {
    const store = readyStoreWithLocal();
    store.selectChannel(LOCAL);
    for (let index = 1; index <= 500; index += 1) {
      store.applyMessage(message(LOCAL, index * 10));
    }
    expect(store.getSnapshot().messages).toHaveLength(CHAT_ACTIVE_MESSAGE_LIMIT);
    store.selectChannel(GENERAL);
    expect(store.getDiagnostics().largestInactiveMessageCount).toBe(CHAT_INACTIVE_MESSAGE_LIMIT);
  });
});

describe("ChatStore gap recovery", () => {
  it("replaces stale messages with the newest snapshot when needsRefresh is true", () => {
    const store = readyStore();
    store.applyMessage(message(GENERAL, 1));
    store.applyMessage(message(GENERAL, 2));
    for (let seq = 3; seq <= 10; seq += 1) store.applyMessage(message(GENERAL, seq));
    store.applyMessage(message(GENERAL, 100));
    expect(store.getSnapshot().selectedChannel?.needsRefresh).toBe(true);
    const snapshot = store.getSnapshot();
    const oldestBefore = snapshot.oldestLoadedSequence;

    store.applyChannelSelected({
      channelKey: GENERAL,
      messages: messages(GENERAL, 51, 100),
      latestSequence: 100,
      hasOlder: true,
      reset: false,
      readState: readState(GENERAL, 100, 100),
      mute: unmuted(GENERAL)
    });

    const after = store.getSnapshot();
    expect(after.oldestLoadedSequence).toBe(51);
    expect(after.oldestLoadedSequence).not.toBe(oldestBefore);
    expect(after.selectedChannel?.needsRefresh).toBe(false);
    expect(after.messages.map((item) => item.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => 51 + index)
    );
    expect(after.selectedChannel?.hasOlder).toBe(true);
  });

  it("preserves messages newer than the snapshot after a gap refresh", () => {
    const store = readyStore();
    store.applyMessage(message(GENERAL, 1));
    store.applyMessage(message(GENERAL, 100));
    expect(store.getSnapshot().selectedChannel?.needsRefresh).toBe(true);

    store.applyMessage(message(GENERAL, 102));

    store.applyChannelSelected({
      channelKey: GENERAL,
      messages: messages(GENERAL, 51, 100),
      latestSequence: 100,
      hasOlder: true,
      reset: false,
      readState: readState(GENERAL, 100, 100),
      mute: unmuted(GENERAL)
    });

    const after = store.getSnapshot();
    const sequences = after.messages.map((item) => item.sequence);
    expect(sequences).toContain(102);
    expect(sequences[0]).toBe(51);
    const uniqueCount = new Set(sequences).size;
    expect(uniqueCount).toBe(sequences.length);
  });

  it("resets correctly when reset flag is true", () => {
    const store = readyStore();
    const real = messages(GENERAL, 1, 5);
    for (const m of real) store.applyMessage(m);

    store.applyChannelSelected({
      channelKey: GENERAL,
      messages: messages(GENERAL, 6, 10),
      latestSequence: 10,
      hasOlder: false,
      reset: true,
      readState: readState(GENERAL, 10, 10),
      mute: unmuted(GENERAL)
    });

    const after = store.getSnapshot();
    expect(after.messages.map((item) => item.sequence)).toEqual([6, 7, 8, 9, 10]);
  });

  it("bounds the active room to the active-message limit during a gap refresh", () => {
    const store = readyStore();
    expect(store.selectChannel(HUNTING)).toBe(true);
    for (let seq = 1; seq <= 400; seq += 1) store.applyMessage(message(HUNTING, seq));
    expect(store.getSnapshot().selectedChannel?.needsRefresh).toBe(false);
    store.applyMessage(message(HUNTING, 1000));
    expect(store.getSnapshot().selectedChannel?.needsRefresh).toBe(true);

    const snap = messages(HUNTING, 801, 1000);
    store.applyChannelSelected({
      channelKey: HUNTING,
      messages: snap,
      latestSequence: 1000,
      hasOlder: true,
      reset: false,
      readState: readState(HUNTING, 1000, 1000),
      mute: unmuted(HUNTING)
    });

    const after = store.getSnapshot();
    expect(after.messages.length).toBeLessThanOrEqual(CHAT_ACTIVE_MESSAGE_LIMIT);
    expect(after.selectedChannel?.needsRefresh).toBe(false);
    expect(after.oldestLoadedSequence).toBeGreaterThanOrEqual(1000 - CHAT_ACTIVE_MESSAGE_LIMIT + 1);
  });

  it("preserves normal channel-selected merge without needsRefresh", () => {
    const store = readyStore();
    store.selectChannel(TRADING);
    store.expectChannelSelection(TRADING, "select-trading");
    store.applyMessage(message(TRADING, 1));
    store.applyMessage(message(TRADING, 2));

    store.applyChannelSelected({
      requestId: "select-trading",
      channelKey: TRADING,
      messages: messages(TRADING, 1, 3),
      latestSequence: 3,
      hasOlder: false,
      reset: false,
      readState: readState(TRADING, 3, 3),
      mute: unmuted(TRADING)
    });

    const after = store.getSnapshot();
    expect(after.messages.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });
});

function readyStore(storage?: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
}): ChatStore {
  const store = new ChatStore({
    ownPlayerId: "self",
    now: () => Date.parse("2026-07-10T12:00:00.000Z"),
    storage: storage ?? null
  });
  const channelDefinitions = [channel(GENERAL, "General"), channel(TRADING, "Trading"), channel(HUNTING, "Hunting")];
  store.applyChannelsSnapshot({
    channels: channelDefinitions,
    readStates: channelDefinitions.map((item) => readState(item.key, 0, 0)),
    previews: [],
    selectedChannelKey: GENERAL
  });
  return store;
}

function readyStoreWithLocal(storage?: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
}): ChatStore {
  const store = new ChatStore({
    ownPlayerId: "self",
    now: () => Date.parse("2026-07-10T12:00:00.000Z"),
    storage: storage ?? null
  });
  const channelDefinitions = [
    localChannel(),
    channel(GENERAL, "General"),
    channel(TRADING, "Trading"),
    channel(HUNTING, "Hunting")
  ];
  store.applyChannelsSnapshot({
    channels: channelDefinitions,
    readStates: channelDefinitions.map((item) => readState(item.key, 0, 0)),
    previews: [],
    selectedChannelKey: GENERAL
  });
  return store;
}

function channel(key: string, displayName: string): ChatChannel {
  return {
    id: `channel-${key}`,
    key,
    type: "public",
    category: key.split(":").at(-1) as "general" | "trading" | "hunting",
    displayName,
    visibilityPolicy: "authenticated",
    sendAccessPolicy: "authenticated",
    historyRetentionPolicy: "durable",
    rateLimitPolicy: key === TRADING ? "strict-repeat" : "normal",
    moderationPolicy: "public-v1",
    active: true,
    latestSequence: 0,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

function localChannel(latestSequence = 0): ChatChannel {
  return {
    ...channel(LOCAL, "Local"),
    type: "local",
    historyRetentionPolicy: "live-session",
    latestSequence
  };
}

function readState(channelKey: string, lastReadSequence: number, latestSequence: number): ChatReadState {
  return {
    channelKey,
    lastReadSequence,
    latestSequence,
    unreadCount: Math.max(0, latestSequence - lastReadSequence),
    updatedAt: "2026-07-10T12:00:00.000Z"
  };
}

function unmuted(channelKey: string) {
  return {
    muted: false as const,
    channelKey,
    scope: null,
    reason: null,
    expiresAt: null
  };
}

function message(channelKey: string, sequence: number, clientRequestId = `request-${sequence}`): ChatMessage {
  return {
    id: `message-${channelKey}-${sequence}`,
    channelId: `channel-${channelKey}`,
    channelKey,
    sequence,
    senderPlayerId: "other",
    senderDisplayName: "Other Player",
    body: `Message ${sequence}`,
    serverCreatedAt: "2026-07-10T12:00:00.000Z",
    clientRequestId,
    status: "confirmed",
    moderationStatus: "clear",
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z"
  };
}

function messages(channelKey: string, from: number, through: number): ChatMessage[] {
  return Array.from({ length: through - from + 1 }, (_, index) => message(channelKey, from + index));
}

function startPending(store: ChatStore, requestId: string, body = `Pending ${requestId}`) {
  return store.startPending({
    requestId,
    channelKey: GENERAL,
    body,
    senderPlayerId: "self",
    senderDisplayName: "Self"
  });
}

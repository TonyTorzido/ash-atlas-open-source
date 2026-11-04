import {
  CHAT_LOCAL_CHANNEL_KEY,
  type ChatChannel,
  type ChatChannelKey,
  type ChatMuteSnapshot,
  type ChatReadState,
  type ServerMessage
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { ConnectionRegistry, type SocketLike } from "../realtime/connectionRegistry.js";
import { ChatRealtimeCoordinator } from "./chatRealtime.js";
import type { ChatService } from "./chatService.js";
import type { ChatHistoryResult } from "./types.js";

const GENERAL = "public:general";
const TRADING = "public:trading";
const HUNTING = "public:hunting";
const PLAYER_ID = "player-1";

type HistoryInput = Parameters<ChatService["history"]>[0];

describe("ChatRealtimeCoordinator selection ordering", () => {
  it("installs the active subscription before deferred history resolves", async () => {
    const channel = chatChannel(TRADING, 8);
    const pendingHistory = deferred<ChatHistoryResult>();
    const service = coordinatorService({
      history: vi.fn(() => pendingHistory.promise)
    });
    const { coordinator, connectionId, socket } = connectedCoordinator(service);

    const selection = coordinator.select(
      connectionId,
      PLAYER_ID,
      TRADING,
      "select-trading"
    );
    await vi.waitFor(() => expect(service.history).toHaveBeenCalledOnce());

    expect(coordinator.subscriptions.activeConnectionIds(TRADING)).toEqual([connectionId]);
    expect(socket.messagesOfType("CHAT_CHANNEL_SELECTED")).toHaveLength(0);

    pendingHistory.resolve(historyResult(channel));
    await selection;

    expect(socket.messagesOfType("CHAT_CHANNEL_SELECTED")).toEqual([
      expect.objectContaining({ requestId: "select-trading", channelKey: TRADING })
    ]);
  });

  it("keeps the later rapid selection and suppresses the stale response", async () => {
    const tradingHistory = deferred<ChatHistoryResult>();
    const huntingHistory = deferred<ChatHistoryResult>();
    const service = coordinatorService({
      history: vi.fn((input: HistoryInput) => {
        if (input.channelKey === TRADING) return tradingHistory.promise;
        if (input.channelKey === HUNTING) return huntingHistory.promise;
        throw new Error(`Unexpected history channel: ${input.channelKey}`);
      })
    });
    const { coordinator, connectionId, socket } = connectedCoordinator(service);

    const first = coordinator.select(connectionId, PLAYER_ID, TRADING, "select-first");
    await vi.waitFor(() => {
      expect(service.history).toHaveBeenCalledWith(expect.objectContaining({ channelKey: TRADING }));
    });
    const second = coordinator.select(connectionId, PLAYER_ID, HUNTING, "select-second");
    await vi.waitFor(() => {
      expect(service.history).toHaveBeenCalledWith(expect.objectContaining({ channelKey: HUNTING }));
    });

    expect(coordinator.subscriptions.activeConnectionIds(TRADING)).toEqual([]);
    expect(coordinator.subscriptions.activeConnectionIds(HUNTING)).toEqual([connectionId]);

    huntingHistory.resolve(historyResult(chatChannel(HUNTING, 12)));
    await second;
    tradingHistory.resolve(historyResult(chatChannel(TRADING, 7)));
    await first;

    expect(coordinator.subscriptions.activeConnectionIds(HUNTING)).toEqual([connectionId]);
    expect(socket.messagesOfType("CHAT_CHANNEL_SELECTED")).toEqual([
      expect.objectContaining({ requestId: "select-second", channelKey: HUNTING })
    ]);
  });
});

describe("ChatRealtimeCoordinator connection bootstrap", () => {
  it("cleans coordinator state and avoids history fanout when preview capacity is exceeded", async () => {
    const channels = Array.from({ length: 33 }, (_, index) =>
      chatChannel(`public:test-${index}`, index)
    );
    const service = coordinatorService({
      channelsSnapshot: vi.fn(async () => ({
        channels,
        readStates: channels.map((channel) => readState(channel.key, 0, channel.latestSequence)),
        mute: unmuted()
      }))
    });
    const { coordinator, connectionId, socket } = connectedCoordinator(service);

    await expect(coordinator.connect(connectionId, PLAYER_ID)).rejects.toThrow(
      "Too many chat preview subscriptions"
    );

    expect(service.history).not.toHaveBeenCalled();
    expect(socket.messagesOfType("CHAT_CHANNELS_SNAPSHOT")).toHaveLength(0);
    expect(coordinator.metrics()).toMatchObject({
      connections: 0,
      activeSubscriptions: 0,
      previewSubscriptions: 0,
      readStateConnections: 0,
      selectionConnections: 0
    });
  });

  it("sends a fresh service read state instead of the cached connect snapshot", async () => {
    const staleChannel = chatChannel(GENERAL, 2);
    const freshChannel = chatChannel(GENERAL, 9);
    const staleReadState = readState(GENERAL, 1, 2);
    const freshReadState = readState(GENERAL, 7, 9);
    const history = vi.fn(async (input: HistoryInput) =>
      input.limit === 1 ? historyResult(staleChannel) : historyResult(freshChannel)
    );
    const service = coordinatorService({
      channelsSnapshot: vi.fn(async () => ({
        channels: [staleChannel],
        readStates: [staleReadState],
        mute: unmuted()
      })),
      history,
      readState: vi.fn(async () => freshReadState)
    });
    const { coordinator, connectionId, socket } = connectedCoordinator(service);
    await coordinator.connect(connectionId, PLAYER_ID);
    socket.clear();

    await coordinator.select(connectionId, PLAYER_ID, GENERAL, "select-fresh");

    expect(service.readState).toHaveBeenCalledWith(PLAYER_ID, GENERAL);
    expect(socket.messagesOfType("CHAT_CHANNEL_SELECTED")).toEqual([
      expect.objectContaining({
        requestId: "select-fresh",
        channelKey: GENERAL,
        latestSequence: 9,
        readState: freshReadState
      })
    ]);
  });
});

describe("ChatRealtimeCoordinator Local delivery", () => {
  it("bootstraps and selects Local without previews, history, unread state, or catch-up", async () => {
    const local = localChannel();
    const general = chatChannel(GENERAL, 4);
    const service = coordinatorService({
      channelsSnapshot: vi.fn(async () => ({
        channels: [local, general],
        readStates: [readState(GENERAL, 0, 4)],
        mute: unmuted()
      }))
    });
    const { coordinator, connectionId, socket } = connectedCoordinator(service);

    await coordinator.connect(connectionId, PLAYER_ID);
    expect(service.history).toHaveBeenCalledTimes(1);
    expect(service.history).toHaveBeenCalledWith(expect.objectContaining({ channelKey: GENERAL }));
    expect(coordinator.subscriptions.previewConnectionIds(CHAT_LOCAL_CHANNEL_KEY)).toEqual([]);
    socket.clear();

    await coordinator.select(
      connectionId,
      PLAYER_ID,
      CHAT_LOCAL_CHANNEL_KEY,
      "select-local",
      99
    );

    expect(service.history).toHaveBeenCalledTimes(1);
    expect(service.readState).not.toHaveBeenCalled();
    expect(socket.messagesOfType("CHAT_HISTORY_RESULT")).toEqual([]);
    expect(socket.messagesOfType("CHAT_CHANNEL_SELECTED")).toEqual([
      expect.objectContaining({
        requestId: "select-local",
        channelKey: CHAT_LOCAL_CHANNEL_KEY,
        messages: [],
        latestSequence: 0,
        hasOlder: false,
        readState: expect.objectContaining({ unreadCount: 0 })
      })
    ]);
    await expect(coordinator.history(connectionId, PLAYER_ID, {
      requestId: "history-local",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      direction: "newer",
      cursorSequence: 0,
      limit: 50
    })).rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
    await expect(coordinator.markRead(
      connectionId,
      PLAYER_ID,
      "read-local",
      CHAT_LOCAL_CHANNEL_KEY,
      5
    )).rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
  });

  it("delivers only to the current unblocked AOI intersection and rechecks after block filtering", async () => {
    const registry = new ConnectionRegistry();
    const sender = addPlayer(registry, "sender");
    const near = addPlayer(registry, "near");
    const blocked = addPlayer(registry, "blocked");
    const left = addPlayer(registry, "left");
    const enteredLater = addPlayer(registry, "entered-later");
    let visible = ["sender", "near", "blocked", "left"];
    const filter = deferred<string[]>();
    const audienceFilter = vi.fn(() => filter.promise);
    const onLocalDelivered = vi.fn();
    const service = coordinatorService({
      send: vi.fn(async () => sendResult(false))
    });
    const coordinator = new ChatRealtimeCoordinator(service as unknown as ChatService, registry, {
      visiblePlayerIdsFor: () => visible,
      filterDirectlyInteractable: audienceFilter,
      hasActiveWorldTransition: () => false,
      onLocalDelivered
    });
    const fanout = vi.spyOn(registry, "sendToConnectionIds");

    const sending = coordinator.send(sender.connectionId, "sender", "Sender", {
      requestId: "05000000-0000-4000-8000-000000009001",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      body: "nearby only"
    });
    await vi.waitFor(() => expect(audienceFilter).toHaveBeenCalledWith(
      "sender",
      ["sender", "near", "blocked", "left"]
    ));
    visible = ["sender", "near", "blocked", "entered-later"];
    filter.resolve(["sender", "near", "left"]);
    await sending;

    expect(sender.socket.messagesOfType("CHAT_SEND_RESULT")).toHaveLength(1);
    expect(sender.socket.messagesOfType("CHAT_MESSAGE")).toHaveLength(1);
    expect(near.socket.messagesOfType("CHAT_MESSAGE")).toHaveLength(1);
    expect(blocked.socket.messagesOfType("CHAT_MESSAGE")).toHaveLength(0);
    expect(left.socket.messagesOfType("CHAT_MESSAGE")).toHaveLength(0);
    expect(enteredLater.socket.messagesOfType("CHAT_MESSAGE")).toHaveLength(0);
    expect(fanout).toHaveBeenCalledWith(
      expect.any(Set),
      expect.objectContaining({ type: "CHAT_MESSAGE" }),
      "transient-social"
    );
    expect(onLocalDelivered).toHaveBeenCalledWith("sender", ["near"]);
  });

  it("records Recent Players only for Local recipients whose transient send succeeds", async () => {
    const registry = new ConnectionRegistry();
    const sender = addPlayer(registry, "sender");
    const slow = addPlayer(registry, "slow");
    slow.socket.bufferedAmount = 128 * 1024;
    const onLocalDelivered = vi.fn();
    const coordinator = new ChatRealtimeCoordinator(
      coordinatorService({ send: vi.fn(async () => sendResult(false)) }) as unknown as ChatService,
      registry,
      {
        visiblePlayerIdsFor: () => ["sender", "slow"],
        filterDirectlyInteractable: async (_playerId, candidates) => [...candidates],
        hasActiveWorldTransition: () => false,
        onLocalDelivered
      }
    );

    await coordinator.send(sender.connectionId, "sender", "Sender", {
      requestId: "05000000-0000-4000-8000-000000009004",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      body: "not delivered to a slow peer"
    });

    expect(sender.socket.messagesOfType("CHAT_MESSAGE")).toHaveLength(1);
    expect(slow.socket.messagesOfType("CHAT_MESSAGE")).toHaveLength(0);
    expect(onLocalDelivered).not.toHaveBeenCalled();
    expect(registry.metricsSnapshot().transientSocialSkipped).toBe(1);
  });

  it("excludes transitions, does not redeliver replays, and fails closed after acceptance", async () => {
    const registry = new ConnectionRegistry();
    const sender = addPlayer(registry, "sender");
    const transitioning = addPlayer(registry, "transitioning");
    const deliveryError = vi.fn();
    const service = coordinatorService({ send: vi.fn(async () => sendResult(false)) });
    const filter = vi.fn(async () => {
      throw new Error("block lookup unavailable");
    });
    const coordinator = new ChatRealtimeCoordinator(service as unknown as ChatService, registry, {
      visiblePlayerIdsFor: () => ["sender", "transitioning"],
      filterDirectlyInteractable: filter,
      hasActiveWorldTransition: (playerId) => playerId === "transitioning",
      onDeliveryError: deliveryError
    });

    await expect(coordinator.send(sender.connectionId, "sender", "Sender", {
      requestId: "05000000-0000-4000-8000-000000009002",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      body: "accepted before filter failed"
    })).resolves.toBeUndefined();
    expect(sender.socket.messagesOfType("CHAT_SEND_RESULT")).toHaveLength(1);
    expect(sender.socket.messagesOfType("CHAT_MESSAGE")).toHaveLength(0);
    expect(transitioning.socket.messagesOfType("CHAT_MESSAGE")).toHaveLength(0);
    expect(filter).toHaveBeenCalledWith("sender", ["sender"]);
    expect(deliveryError).toHaveBeenCalledOnce();

    service.send.mockResolvedValueOnce(sendResult(true));
    await coordinator.send(sender.connectionId, "sender", "Sender", {
      requestId: "05000000-0000-4000-8000-000000009002",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      body: "accepted before filter failed"
    });
    expect(filter).toHaveBeenCalledOnce();
    expect(sender.socket.messagesOfType("CHAT_SEND_RESULT")).toHaveLength(2);
  });

  it("rejects Local sends while the sender has an active world transition", async () => {
    const registry = new ConnectionRegistry();
    const sender = addPlayer(registry, "sender");
    const service = coordinatorService();
    const coordinator = new ChatRealtimeCoordinator(service as unknown as ChatService, registry, {
      visiblePlayerIdsFor: () => ["sender"],
      filterDirectlyInteractable: async (_playerId, candidates) => [...candidates],
      hasActiveWorldTransition: (playerId) => playerId === "sender"
    });

    await expect(coordinator.send(sender.connectionId, "sender", "Sender", {
      requestId: "05000000-0000-4000-8000-000000009003",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      body: "not during travel"
    })).rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
    expect(service.send).not.toHaveBeenCalled();
    expect(sender.socket.messagesOfType("CHAT_SEND_RESULT")).toHaveLength(0);
  });
});

describe("ChatRealtimeCoordinator shared translation broadcast", () => {
  it("sends a new translation only to authorized active subscribers of the channel", async () => {
    const registry = new ConnectionRegistry();
    const allowed = addPlayer(registry, "allowed");
    const revoked = addPlayer(registry, "revoked");
    const elsewhere = addPlayer(registry, "elsewhere");
    const authorizedRecipientPlayerIds = vi.fn(async (_key: string, playerIds: readonly string[], _messageCreatedAt?: Date) =>
      new Set(playerIds.filter((playerId) => playerId !== "revoked"))
    );
    const service = { ...coordinatorService(), authorizedRecipientPlayerIds };
    const coordinator = new ChatRealtimeCoordinator(service as unknown as ChatService, registry);
    coordinator.subscriptions.selectActive(allowed.connectionId, GENERAL);
    coordinator.subscriptions.selectActive(revoked.connectionId, GENERAL);
    coordinator.subscriptions.selectActive(elsewhere.connectionId, TRADING);

    await coordinator.broadcastTranslation({
      channelId: "05000000-0000-4000-8000-000000000001",
      channelKey: GENERAL,
      messageCreatedAt: new Date("2026-09-30T12:00:00.000Z"),
      messageId: "05000000-0000-4000-8000-000000000042",
      targetLanguage: "en",
      translatedText: "Hello",
      sourceLanguage: "es"
    });
    await coordinator.broadcastTranslation({
      channelId: "05000000-0000-4000-8000-000000000004",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      messageCreatedAt: new Date("2026-09-30T12:00:00.000Z"),
      messageId: "05000000-0000-4000-8000-000000000043",
      targetLanguage: "en",
      translatedText: "Local"
    });

    expect(allowed.socket.messagesOfType("CHAT_MESSAGE_TRANSLATION")).toEqual([{
      type: "CHAT_MESSAGE_TRANSLATION",
      channelId: "05000000-0000-4000-8000-000000000001",
      channelKey: GENERAL,
      messageId: "05000000-0000-4000-8000-000000000042",
      targetLanguage: "en",
      translatedText: "Hello",
      sourceLanguage: "es"
    }]);
    expect(revoked.socket.messagesOfType("CHAT_MESSAGE_TRANSLATION")).toHaveLength(0);
    expect(elsewhere.socket.messagesOfType("CHAT_MESSAGE_TRANSLATION")).toHaveLength(0);
    expect(authorizedRecipientPlayerIds).toHaveBeenCalledOnce();
    // Members who joined after the message must not receive its translated text.
    expect(authorizedRecipientPlayerIds.mock.calls[0]?.[2]).toEqual(new Date("2026-09-30T12:00:00.000Z"));
  });
});

type CoordinatorService = {
  historyPageSize: number;
  catchUpLimit: number;
  channelsSnapshot: ReturnType<typeof vi.fn>;
  assertDurableChannelAccess: ReturnType<typeof vi.fn>;
  assertLocalChannelAccess: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  activeMute: ReturnType<typeof vi.fn>;
  readState: ReturnType<typeof vi.fn>;
  metricsSnapshot: ReturnType<typeof vi.fn>;
};

function coordinatorService(overrides: Partial<CoordinatorService> = {}): CoordinatorService {
  const general = chatChannel(GENERAL, 0);
  return {
    historyPageSize: 50,
    catchUpLimit: 100,
    channelsSnapshot: vi.fn(async () => ({
      channels: [general],
      readStates: [readState(GENERAL, 0, 0)],
      mute: unmuted()
    })),
    assertDurableChannelAccess: vi.fn(async () => general),
    assertLocalChannelAccess: vi.fn(async () => localChannel()),
    send: vi.fn(async () => sendResult(false)),
    history: vi.fn(async () => historyResult(general)),
    activeMute: vi.fn(async () => unmuted()),
    readState: vi.fn(async (_playerId: string, channelKey: ChatChannelKey) =>
      readState(channelKey, 0, 0)
    ),
    metricsSnapshot: vi.fn(() => ({})),
    ...overrides
  };
}

function connectedCoordinator(service: CoordinatorService): {
  coordinator: ChatRealtimeCoordinator;
  connectionId: string;
  socket: RecordingSocket;
} {
  const registry = new ConnectionRegistry();
  const socket = new RecordingSocket();
  const connectionId = registry.add({
    playerId: PLAYER_ID,
    username: "Player One",
    regionCode: "NM",
    zoneId: "world:NM",
    socket
  });
  return {
    coordinator: new ChatRealtimeCoordinator(service as unknown as ChatService, registry),
    connectionId,
    socket
  };
}

function chatChannel(key: ChatChannelKey, latestSequence: number): ChatChannel {
  return {
    id: crypto.randomUUID(),
    key,
    type: "public",
    category: key.split(":").at(-1) as "general" | "trading" | "hunting",
    displayName: key.split(":").at(-1) ?? key,
    visibilityPolicy: "authenticated",
    sendAccessPolicy: "authenticated",
    historyRetentionPolicy: "durable",
    rateLimitPolicy: key === TRADING ? "strict-repeat" : "normal",
    moderationPolicy: "public-v1",
    active: true,
    latestSequence,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

function localChannel(): ChatChannel {
  return {
    ...chatChannel(CHAT_LOCAL_CHANNEL_KEY, 0),
    type: "local",
    category: "local",
    displayName: "Local",
    historyRetentionPolicy: "live-session"
  };
}

function sendResult(replayed: boolean) {
  return {
    replayed,
    moderationQueued: !replayed,
    message: {
      id: "05000000-0000-4000-8000-000000009999",
      channelId: "05000000-0000-4000-8000-000000000004",
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      sequence: 1,
      senderPlayerId: "sender",
      senderDisplayName: "Sender",
      body: "nearby only",
      serverCreatedAt: "2026-07-10T00:00:00.000Z",
      clientRequestId: "05000000-0000-4000-8000-000000009001",
      status: "confirmed" as const,
      moderationStatus: "pending" as const,
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }
  };
}

function addPlayer(registry: ConnectionRegistry, playerId: string): {
  connectionId: string;
  socket: RecordingSocket;
} {
  const socket = new RecordingSocket();
  const connectionId = registry.add({
    playerId,
    username: playerId,
    regionCode: "NM",
    zoneId: "world:NM",
    socket
  });
  return { connectionId, socket };
}

function historyResult(channel: ChatChannel): ChatHistoryResult {
  return {
    channel,
    messages: [],
    mode: "initial",
    latestSequence: channel.latestSequence,
    hasMore: false,
    resetRequired: false
  };
}

function readState(
  channelKey: ChatChannelKey,
  lastReadSequence: number,
  latestSequence: number
): ChatReadState {
  return {
    channelKey,
    lastReadSequence,
    latestSequence,
    unreadCount: Math.max(0, latestSequence - lastReadSequence),
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

function unmuted(): ChatMuteSnapshot {
  return {
    muted: false,
    channelKey: null,
    scope: null,
    reason: null,
    expiresAt: null
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class RecordingSocket implements SocketLike {
  readyState = 1;
  bufferedAmount = 0;
  private messages: ServerMessage[] = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }

  close(): void {
    this.readyState = 3;
  }

  messagesOfType<T extends ServerMessage["type"]>(
    type: T
  ): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type
    );
  }

  clear(): void {
    this.messages = [];
  }
}

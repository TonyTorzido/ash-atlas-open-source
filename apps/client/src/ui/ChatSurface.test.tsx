// @vitest-environment jsdom

import {
  CHAT_INACTIVE_MESSAGE_LIMIT,
  CHAT_LOCAL_CHANNEL_KEY,
  type ChatChannel,
  type ChatMessage
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatHistoryRequestTracker } from "../chat/chatHistoryRequestTracker.js";
import { ChatStore } from "../chat/chatStore.js";
import type { GameClient } from "../gameClient.js";
import {
  ChatSurface,
  ChatSurfaceErrorBoundary,
  PublicChatErrorBoundary
} from "./ChatSurface.js";

const GENERAL = "public:general";
const TRADING = "public:trading";
const LOCAL = CHAT_LOCAL_CHANNEL_KEY;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatSurface live-session transport", () => {
  it("contains a whole-chat failure while leaving sibling gameplay mounted", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ThrowingChat = (): never => {
      throw new Error("simulated whole-chat failure");
    };
    render(
      <>
        <div data-testid="gameplay">Map remains mounted</div>
        <ChatSurfaceErrorBoundary resetKey="player-1">
          <ThrowingChat />
        </ChatSurfaceErrorBoundary>
      </>
    );
    expect(screen.getByTestId("gameplay")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Gameplay remains available");
    expect(screen.getByRole("button", { name: "Retry Chat" })).toBeTruthy();
    consoleError.mockRestore();
  });

  it("contains a public chat child render failure and invokes the gameplay recovery path", () => {
    const onError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ThrowingChatChild = (): never => {
      throw new Error("simulated chat child failure");
    };
    const view = render(
      <PublicChatErrorBoundary resetKey onError={onError}>
        <ThrowingChatChild />
      </PublicChatErrorBoundary>
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(view.container.innerHTML).toBe("");
    consoleError.mockRestore();
  });

  it("loads existing General history immediately after bootstrap", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const store = new ChatStore({ ownPlayerId: "self", storage: null });
    store.applyChannelsSnapshot({
      channels: [{ ...publicChannel(), latestSequence: 7 }],
      readStates: [],
      previews: [],
      selectedChannelKey: GENERAL
    });
    const selectChatChannel = vi.fn(() => "bootstrap-selection");
    const client = { selectChatChannel } as unknown as GameClient;

    render(
      <ChatSurface
        store={store}
        connectionStatus="online"
        playerId="self"
        username="Self"
        serverHttpBase="http://server.test"
        csrfToken="csrf"
        socialRefreshToken={0}
        clientRef={{ current: client }}
        historyRequestTracker={new ChatHistoryRequestTracker()}
        onOpenSender={vi.fn()}
      />
    );

    await waitFor(() => expect(selectChatChannel).toHaveBeenCalledWith(GENERAL));
  });

  it("wires the default translation action to the authenticated server endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const pathname = new URL(String(input), "http://server.test").pathname;
      if (pathname === "/api/community/terms") {
        return new Response(JSON.stringify({ version: "2026-09-15-v1", accepted: true }), { status: 200 });
      }
      if (pathname === "/api/social/lists/blocked") {
        return new Response(JSON.stringify({ kind: "blocked", entries: [], offset: 0, limit: 50, hasMore: false }), { status: 200 });
      }
      if (pathname === "/api/chat/translate") {
        expect(JSON.parse(String(init?.body))).toEqual({
          messageId: "message-1",
          targetLanguage: "en"
        });
        return new Response(JSON.stringify({ translatedText: "Hello", sourceLanguage: "ES" }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = readyStore();
    store.applyMessage({
      ...localMessage(1),
      id: "message-1",
      channelId: "channel-general",
      channelKey: GENERAL,
      senderPlayerId: "other",
      senderDisplayName: "Other"
    });

    render(
      <ChatSurface
        store={store}
        connectionStatus="online"
        playerId="self"
        username="Self"
        serverHttpBase="http://server.test"
        csrfToken="csrf"
        socialRefreshToken={0}
        clientRef={{ current: null }}
        historyRequestTracker={new ChatHistoryRequestTracker()}
        onOpenSender={vi.fn()}
        openRequestRevision={1}
      />
    );

    await screen.findByRole("complementary", { name: "Chat panel" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for message from Other" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Translate" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) =>
      new URL(String(input), "http://server.test").pathname === "/api/chat/translate"
    )).toBe(true));
    expect(await screen.findByText("Hello")).toBeTruthy();
  });

  it("requests the newest page when returning to a trimmed durable channel", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const store = new ChatStore({ ownPlayerId: "self", storage: null });
    store.applyChannelsSnapshot({
      channels: [publicChannel(), tradingChannel()],
      readStates: [],
      previews: [],
      selectedChannelKey: GENERAL
    });
    for (let sequence = 1; sequence <= CHAT_INACTIVE_MESSAGE_LIMIT + 5; sequence += 1) {
      store.applyMessage({
        ...localMessage(sequence),
        id: `general-${sequence}`,
        channelId: "channel-general",
        channelKey: GENERAL
      });
    }
    const selectChatChannel = vi.fn(() => "selection-request");

    render(
      <ChatSurface
        store={store}
        connectionStatus="online"
        playerId="self"
        username="Self"
        serverHttpBase="http://server.test"
        csrfToken="csrf"
        socialRefreshToken={0}
        clientRef={{ current: { selectChatChannel } as unknown as GameClient }}
        historyRequestTracker={new ChatHistoryRequestTracker()}
        onOpenSender={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select chat room" }));
    fireEvent.click(screen.getByRole("option", { name: "Trading" }));
    expect(store.getDiagnostics().largestInactiveMessageCount).toBe(
      CHAT_INACTIVE_MESSAGE_LIMIT
    );
    fireEvent.click(screen.getByRole("button", { name: "Select chat room" }));
    fireEvent.click(screen.getByRole("option", { name: "General" }));

    expect(selectChatChannel).toHaveBeenLastCalledWith(GENERAL);
  });

  it("routes a General Chat sender's stable player ID to shared player actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        kind: "blocked",
        entries: [],
        offset: 0,
        limit: 50,
        hasMore: false
      })
    } as Response)));
    const store = readyStore();
    store.applyMessage({
      ...localMessage(71),
      id: "general-71",
      channelId: "channel-general",
      channelKey: GENERAL,
      senderPlayerId: "player-anywhere",
      senderDisplayName: "Anywhere Player"
    });
    const onOpenSender = vi.fn();
    render(
      <ChatSurface
        store={store}
        connectionStatus="online"
        playerId="self"
        username="Self"
        serverHttpBase="http://server.test"
        csrfToken="csrf"
        socialRefreshToken={0}
        clientRef={{ current: null }}
        historyRequestTracker={new ChatHistoryRequestTracker()}
        onOpenSender={onOpenSender}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open General chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Anywhere Player" }));
    expect(onOpenSender).toHaveBeenCalledWith(
      "player-anywhere",
      "Anywhere Player",
      expect.objectContaining({ left: expect.any(Number), bottom: expect.any(Number) })
    );
  });

  it("reopens Atlas Chats once after returning from a direct message", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const store = readyStore();
    const baseProps = {
      store,
      connectionStatus: "online" as const,
      playerId: "self",
      username: "Self",
      serverHttpBase: "http://server.test",
      csrfToken: "csrf",
      socialRefreshToken: 0,
      clientRef: { current: null },
      historyRequestTracker: new ChatHistoryRequestTracker(),
      onOpenSender: vi.fn()
    };
    const view = render(<ChatSurface
      {...baseProps}
      forceClosed
      openRequestRevision={1}
    />);

    expect(screen.queryByRole("complementary", { name: "Chat panel" })).toBeNull();
    view.rerender(<ChatSurface {...baseProps} openRequestRevision={1} />);
    expect(await screen.findByRole("complementary", { name: "Chat panel" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close chat panel" }));
    view.rerender(<ChatSurface {...baseProps} forceClosed openRequestRevision={1} />);
    view.rerender(<ChatSurface {...baseProps} openRequestRevision={1} />);
    expect(screen.queryByRole("complementary", { name: "Chat panel" })).toBeNull();

    view.rerender(<ChatSurface {...baseProps} openRequestRevision={2} />);
    expect(await screen.findByRole("complementary", { name: "Chat panel" })).toBeTruthy();
  });

  it("opens the same recent-login roster from the game bar and Atlas Chats with phone Back behavior", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const store = readyStore();
    store.applyOnlinePlayerCount({
      count: 2,
      revision: 1,
      observedAt: "2026-08-29T00:00:00.000Z",
      players: [
        { playerId: "recent", displayName: "Recent Player" },
        { playerId: "earlier", displayName: "Earlier Player" }
      ]
    });
    const onRosterOpenChange = vi.fn();
    render(
      <ChatSurface
        store={store}
        connectionStatus="online"
        layout="phone"
        playerId="self"
        username="Self"
        serverHttpBase="http://server.test"
        csrfToken="csrf"
        socialRefreshToken={0}
        clientRef={{ current: null }}
        historyRequestTracker={new ChatHistoryRequestTracker()}
        onOpenSender={vi.fn()}
        onRosterOpenChange={onRosterOpenChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open online players, 2 online" }));
    await waitFor(() => expect(onRosterOpenChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole("dialog", { name: "Online Players" })).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Recent Player",
      "Earlier Player"
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Back to Game" }));
    await waitFor(() => expect(onRosterOpenChange).toHaveBeenLastCalledWith(false));
    expect(screen.queryByRole("dialog", { name: "Online Players" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open General chat" }));
    const onlineControls = screen.getAllByRole("button", {
      name: "Open online players, 2 online"
    });
    fireEvent.click(onlineControls.at(-1)!);
    await waitFor(() => expect(onRosterOpenChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Back to Atlas Chats" }));
    await waitFor(() => expect(onRosterOpenChange).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole("complementary", { name: "Chat panel" })).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", {
      name: "Open online players, 2 online"
    }).at(-1)!);
    await waitFor(() => expect(onRosterOpenChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Return to Game" }));
    await waitFor(() => expect(onRosterOpenChange).toHaveBeenLastCalledWith(false));
    expect(screen.queryByRole("dialog", { name: "Online Players" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Chat panel" })).toBeNull();
  });

  it("returns to the normal composer only after the rules screen is read and accepted", async () => {
    const termsMarkup = `
      <main class="account-page-main">
        <section class="account-page-intro"><h1>Terms &amp; Community Rules</h1></section>
        <section class="account-page-section"><h2>Play fairly and keep the shared world safe</h2><p>Complete rules content.</p></section>
      </main>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), "http://server.test").pathname;
      if (pathname === "/terms") {
        return { ok: true, status: 200, text: async () => termsMarkup } as Response;
      }
      if (pathname === "/api/community/terms/accept") {
        return { ok: true, status: 200, json: async () => ({ accepted: true }) } as Response;
      }
      if (pathname === "/api/community/terms") {
        return { ok: true, status: 200, json: async () => ({ version: "2026-09-15-v1", accepted: false }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ kind: "blocked", entries: [], offset: 0, limit: 50, hasMore: false })
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = readyStore();
    render(
      <ChatSurface
        store={store}
        connectionStatus="online"
        playerId="self"
        username="Self"
        serverHttpBase="http://server.test"
        csrfToken="csrf"
        socialRefreshToken={0}
        clientRef={{ current: null }}
        historyRequestTracker={new ChatHistoryRequestTracker()}
        onOpenSender={vi.fn()}
        openRequestRevision={1}
      />
    );

    const lockedAction = await screen.findByRole("button", { name: "Review Community Rules to chat" });
    fireEvent.click(lockedAction);
    const region = await screen.findByRole("region", { name: "Community Rules content" });
    const accept = screen.getByRole("button", { name: "Accept Community Rules" }) as HTMLButtonElement;
    setScrollMetrics(region, 400, 1_000, 700);
    fireEvent.scroll(region);
    await waitFor(() => expect(accept.disabled).toBe(false));
    fireEvent.click(accept);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) =>
      new URL(String(input), "http://server.test").pathname === "/api/community/terms/accept"
    )).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Terms & Community Rules" })).toBeNull());
    expect(screen.getByPlaceholderText("Message General")).toBeTruthy();
  });

  it("selects, reads, and sends Local without server history, selection, or read traffic", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      return {
        ok: true,
        status: 200,
        json: async () => pathname === "/api/community/terms"
          ? { version: "2026-09-15-v1", accepted: true }
          : { kind: "blocked", entries: [], offset: 0, limit: 50, hasMore: false }
      } as Response;
    }));
    const store = readyStore();
    store.applyMessage(localMessage(70));
    const selectChatChannel = vi.fn(() => "selection-request");
    const requestChatHistory = vi.fn(() => "history-request");
    const updateChatRead = vi.fn(() => true);
    const sendChatMessage = vi.fn(() => "send-request");
    const client = {
      selectChatChannel,
      requestChatHistory,
      updateChatRead,
      sendChatMessage
    } as unknown as GameClient;

    render(
      <ChatSurface
        store={store}
        connectionStatus="online"
        playerId="self"
        username="Self"
        serverHttpBase="http://server.test"
        csrfToken="csrf"
        socialRefreshToken={0}
        clientRef={{ current: client }}
        historyRequestTracker={new ChatHistoryRequestTracker()}
        onOpenSender={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.queryByText("Loading chat safety settings...")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Select chat room" }));
    fireEvent.click(screen.getByRole("option", { name: "Local" }));
    expect(store.getSnapshot().selectedChannelKey).toBe(LOCAL);
    expect(selectChatChannel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open Local chat" }));
    fireEvent.change(screen.getByPlaceholderText("Message Local"), {
      target: { value: "Anyone nearby?" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(sendChatMessage).toHaveBeenCalledWith(
      LOCAL,
      "Anyone nearby?",
      expect.any(String)
    );
    expect(requestChatHistory).not.toHaveBeenCalled();
    expect(updateChatRead).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
  });
});

function readyStore(): ChatStore {
  const store = new ChatStore({ ownPlayerId: "self", storage: null });
  const channels = [localChannel(), publicChannel()];
  store.applyChannelsSnapshot({
    channels,
    readStates: [],
    previews: [],
    selectedChannelKey: GENERAL
  });
  return store;
}

function setScrollMetrics(element: HTMLElement, clientHeight: number, scrollHeight: number, scrollTop: number): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, writable: true, value: scrollTop }
  });
}

function localChannel(): ChatChannel {
  return {
    ...publicChannel(),
    id: "channel-local",
    key: LOCAL,
    type: "local",
    category: "local",
    displayName: "Local",
    historyRetentionPolicy: "live-session"
  };
}

function publicChannel(): ChatChannel {
  return {
    id: "channel-general",
    key: GENERAL,
    type: "public",
    category: "general",
    displayName: "General",
    visibilityPolicy: "authenticated",
    sendAccessPolicy: "authenticated",
    historyRetentionPolicy: "durable",
    rateLimitPolicy: "normal",
    moderationPolicy: "public-v1",
    active: true,
    latestSequence: 0,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

function tradingChannel(): ChatChannel {
  return {
    ...publicChannel(),
    id: "channel-trading",
    key: TRADING,
    category: "trading",
    displayName: "Trading"
  };
}

function localMessage(sequence: number): ChatMessage {
  return {
    id: `local-${sequence}`,
    channelId: "channel-local",
    channelKey: LOCAL,
    sequence,
    senderPlayerId: "other",
    senderDisplayName: "Other Player",
    body: "Already received",
    serverCreatedAt: "2026-07-10T12:00:00.000Z",
    clientRequestId: `request-${sequence}`,
    status: "confirmed",
    moderationStatus: "clear",
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z"
  };
}

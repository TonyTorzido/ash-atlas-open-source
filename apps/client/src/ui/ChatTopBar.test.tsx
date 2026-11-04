// @vitest-environment jsdom

import { CHAT_LOCAL_CHANNEL_KEY, type ChatChannel, type ChatChannelKey } from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatStore } from "../chat/chatStore.js";
import { ChatTopBar } from "./ChatTopBar.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Ash Atlas chat channel picker", () => {
  it("keeps the channel trigger and Messages control as the edge cells of one bar", () => {
    const view = render(
      <Picker
        onSelectChannel={vi.fn()}
        onOpenMessages={vi.fn()}
      />
    );
    const bar = screen.getByRole("region", { name: "Chat" });
    const picker = view.container.querySelector(".chat-channel-picker");
    const room = screen.getByRole("button", { name: "Select chat room" });
    const messages = screen.getByRole("button", { name: "Open Messages" });
    const onlinePlayers = screen.getByRole("button", { name: "Open online players, 2 online" });

    expect(bar.firstElementChild).toBe(picker);
    expect(picker?.firstElementChild).toBe(room);
    expect(bar.children[2]).toBe(onlinePlayers);
    expect(bar.children[3]).toBe(messages);
  });

  it("renders a custom listbox in canonical order without a native select", () => {
    const view = renderPicker();
    expect(view.container.querySelector("select")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Select chat room" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent?.replace("✓", ""))).toEqual([
      "General", "Trading", "Hunting", "Local"
    ]);
  });

  it("switches through the existing callback and does not leak pointer events", () => {
    const select = vi.fn();
    const leaked = vi.fn();
    render(<div onPointerDown={leaked}><Picker onSelectChannel={select} /></div>);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Select chat room" }));
    fireEvent.click(screen.getByRole("button", { name: "Select chat room" }));
    fireEvent.click(screen.getByRole("option", { name: "Trading" }));
    expect(select).toHaveBeenCalledWith("public:trading");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(leaked).not.toHaveBeenCalled();
  });

  it("closes outside and on Escape and supports arrow/Enter selection", () => {
    const select = vi.fn();
    renderPicker(select);
    const trigger = screen.getByRole("button", { name: "Select chat room" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(select).toHaveBeenLastCalledWith("public:trading");
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the unified Messages unread total in its own compact control", () => {
    const onOpenMessages = vi.fn();
    render(
      <Picker
        onSelectChannel={vi.fn()}
        unreadMessageCount={137}
        onOpenMessages={onOpenMessages}
      />
    );

    const messages = screen.getByRole("button", {
      name: "Open Messages, 137 unread"
    });
    expect(messages.textContent).toBe("•");
    fireEvent.click(messages);
    expect(onOpenMessages).toHaveBeenCalledOnce();
  });

  it("briefly brightens the Messages control for a new private message, then leaves it dimmed as unread", async () => {
    vi.useFakeTimers();
    const view = render(
      <Picker
        onSelectChannel={vi.fn()}
        unreadMessageCount={1}
        messageAttentionRevision={0}
        onOpenMessages={vi.fn()}
      />
    );
    const messages = screen.getByRole("button", { name: "Open Messages, 1 unread" });
    expect(messages.classList.contains("has-unread")).toBe(true);
    expect(messages.classList.contains("message-attention")).toBe(false);

    view.rerender(
      <Picker
        onSelectChannel={vi.fn()}
        unreadMessageCount={2}
        messageAttentionRevision={1}
        onOpenMessages={vi.fn()}
      />
    );
    expect(messages.classList.contains("message-attention")).toBe(true);
    await act(async () => vi.advanceTimersByTime(900));
    expect(messages.classList.contains("message-attention")).toBe(false);
    expect(messages.classList.contains("has-unread")).toBe(true);
  });

  it("keeps a short tap as one chat open and routes an authorized 500ms hold to Developer App", () => {
    vi.useFakeTimers();
    const openChat = vi.fn();
    const openDeveloperTools = vi.fn();
    render(<Picker
      onSelectChannel={vi.fn()}
      onOpen={openChat}
      developerAccessEnabled
      onOpenDeveloperTools={openDeveloperTools}
    />);
    const chat = screen.getByRole("button", { name: "Open General chat" });

    fireEvent.pointerDown(chat, { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10, isPrimary: true });
    void act(() => vi.advanceTimersByTime(499));
    fireEvent.pointerUp(chat, { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(chat);
    expect(openChat).toHaveBeenCalledOnce();
    expect(openDeveloperTools).not.toHaveBeenCalled();

    fireEvent.pointerDown(chat, { pointerId: 2, pointerType: "touch", button: 0, clientX: 10, clientY: 10, isPrimary: true });
    void act(() => vi.advanceTimersByTime(500));
    expect(openDeveloperTools).toHaveBeenCalledOnce();
    fireEvent.pointerUp(chat, { pointerId: 2, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(chat);
    expect(openChat).toHaveBeenCalledOnce();
  });

  it("does not expose or activate the hold gesture without Developer App access", () => {
    vi.useFakeTimers();
    const openChat = vi.fn();
    const openDeveloperTools = vi.fn();
    render(<Picker
      onSelectChannel={vi.fn()}
      onOpen={openChat}
      onOpenDeveloperTools={openDeveloperTools}
    />);
    const chat = screen.getByRole("button", { name: "Open General chat" });
    fireEvent.pointerDown(chat, { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10, isPrimary: true });
    void act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(chat, { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(chat);
    expect(openDeveloperTools).not.toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledOnce();
  });
});

function renderPicker(onSelectChannel = vi.fn()) {
  return render(<Picker onSelectChannel={onSelectChannel} />);
}

function Picker({
  onSelectChannel,
  unreadMessageCount = 0,
  messageAttentionRevision = 0,
  onOpenMessages,
  onOpen = vi.fn(),
  developerAccessEnabled = false,
  onOpenDeveloperTools
}: {
  onSelectChannel(channel: ChatChannelKey): void;
  unreadMessageCount?: number;
  messageAttentionRevision?: number;
  onOpenMessages?(): void;
  onOpen?(): void;
  developerAccessEnabled?: boolean;
  onOpenDeveloperTools?(): void;
}) {
  const store = new ChatStore({ ownPlayerId: "self", storage: null });
  store.applyChannelsSnapshot({
    channels: [
      channel("public:general", "General"), channel("public:trading", "Trading"),
      channel("public:hunting", "Hunting"), channel(CHAT_LOCAL_CHANNEL_KEY, "Local", "local")
    ],
    readStates: [], previews: [], selectedChannelKey: "public:general"
  });
  store.applyOnlinePlayerCount({
    count: 2,
    revision: 1,
    observedAt: "2026-08-29T00:00:00.000Z",
    players: [
      { playerId: "recent", displayName: "Recent Player" },
      { playerId: "earlier", displayName: "Earlier Player" }
    ]
  });
  return <ChatTopBar
    snapshot={store.getSnapshot()}
    unreadMessageCount={unreadMessageCount}
    messageAttentionRevision={messageAttentionRevision}
    onOpen={onOpen}
    onOpenOnlinePlayers={vi.fn()}
    developerAccessEnabled={developerAccessEnabled}
    {...(onOpenDeveloperTools ? { onOpenDeveloperTools } : {})}
    {...(onOpenMessages ? { onOpenMessages } : {})}
    onRetryBootstrap={vi.fn()}
    onSelectChannel={onSelectChannel}
  />;
}

function channel(key: string, displayName: string, type: "public" | "local" = "public"): ChatChannel {
  return {
    id: `channel-${displayName}`, key, type,
    category: type === "local" ? "local" : key.split(":").at(-1) as "general" | "trading" | "hunting",
    displayName, visibilityPolicy: "authenticated",
    sendAccessPolicy: "authenticated", historyRetentionPolicy: type === "local" ? "live-session" : "durable",
    rateLimitPolicy: "normal", moderationPolicy: "public-v1", active: true, latestSequence: 0,
    createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:00:00.000Z"
  };
}

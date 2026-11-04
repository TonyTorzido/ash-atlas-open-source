// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  CHAT_LOCAL_CHANNEL_KEY,
  type ChatChannel,
  type ChatMessage,
  type ChatReadState
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatStore } from "../chat/chatStore.js";
import {
  MOBILE_KEYBOARD_COMMITTED_EVENT,
  MOBILE_KEYBOARD_SETTLED_EVENT,
  resetMobileKeyboardDockingForTests
} from "../mobileKeyboardDocking.js";
import { ChatPanel } from "./ChatPanel.js";
import { ChatTopBar } from "./ChatTopBar.js";

const GENERAL = "public:general";
const TRADING = "public:trading";
const HUNTING = "public:hunting";
const LOCAL = CHAT_LOCAL_CHANNEL_KEY;

function installFrameHarness(): { flushAll(): void } {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return {
    flushAll(): void {
      while (callbacks.size > 0) {
        const pending = [...callbacks.entries()];
        callbacks.clear();
        for (const [, callback] of pending) callback(performance.now());
      }
    }
  };
}

function dispatchTouch(
  element: HTMLElement,
  type: "touchstart" | "touchmove",
  clientX: number,
  clientY: number
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: [{ clientX, clientY }] });
  element.dispatchEvent(event);
  return event;
}

function dispatchPointer(
  element: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: Record<string, boolean | number | string> = {}
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  act(() => { element.dispatchEvent(event); });
  return event;
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem("ashAtlas.chat.uiPreferences");
  resetMobileKeyboardDockingForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.uiProfile;
});

describe("ChatTopBar", () => {
  it("keeps empty chat as a quiet thin-frame affordance", () => {
    const store = readyStore();
    const view = render(<ChatTopBar snapshot={store.getSnapshot()} onOpen={vi.fn()} onRetryBootstrap={vi.fn()} onSelectChannel={vi.fn()} />);
    expect(view.container.textContent).not.toContain("No messages yet");
    expect(screen.getByRole("button", { name: "Open General chat" }).textContent).toContain("Open chat");
  });

  it("shows the selected room, bounded preview, and capped unread count", () => {
    const store = readyStore();
    store.applyPreviewUpdate(
      {
        id: "preview-1",
        channelKey: GENERAL,
        sequence: 12,
        senderPlayerId: "other",
        senderDisplayName: "Avery",
        body: "Anyone near Albuquerque?",
        serverCreatedAt: "2026-07-10T12:00:00.000Z"
      },
      12,
      125
    );
    const onOpen = vi.fn();
    const onSelectChannel = vi.fn();
    render(
      <ChatTopBar
        snapshot={store.getSnapshot()}
        onOpen={onOpen}
        onRetryBootstrap={vi.fn()}
        onSelectChannel={onSelectChannel}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select chat room" }));
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByRole("option", { name: "Local" })).toBeTruthy();
    expect(screen.getAllByRole("option").map((option) => option.textContent?.replace("✓", ""))).toEqual([
      "General",
      "Trading",
      "Hunting",
      "Local"
    ]);
    expect(screen.getByRole("button", { name: "Open General chat" }).textContent).toContain(
      "Avery: Anyone near Albuquerque?"
    );
    expect(screen.getByLabelText("125 unread messages").textContent).toBe("•");
    fireEvent.click(screen.getByRole("option", { name: "Trading" }));
    expect(onSelectChannel).toHaveBeenCalledWith(TRADING);
    fireEvent.click(screen.getByRole("button", { name: "Open General chat" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows explicit loading and actionable unavailable states", () => {
    const store = new ChatStore({ ownPlayerId: "player-1", storage: null });
    const retry = vi.fn();
    const view = render(
      <ChatTopBar
        snapshot={store.getSnapshot()}
        onOpen={vi.fn()}
        onRetryBootstrap={retry}
        onSelectChannel={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Select chat room").textContent).toBe("Loading");
    expect((screen.getByRole("button", { name: "Chat loading" }) as HTMLButtonElement).disabled)
      .toBe(true);

    act(() => store.applyChannelsSnapshot({
      channels: [],
      readStates: [],
      previews: [],
      selectedChannelKey: GENERAL
    }));
    view.rerender(
      <ChatTopBar
        snapshot={store.getSnapshot()}
        onOpen={vi.fn()}
        onRetryBootstrap={retry}
        onSelectChannel={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Select chat room").textContent).toBe("Unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry chat" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("ChatPanel", () => {
  it("prevents Safari page scaling gestures inside the expanded chat", () => {
    const store = readyStore();
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const panel = view.container.querySelector(".chat-panel")!;
    const gesture = new Event("gesturestart", { bubbles: true, cancelable: true });
    expect(panel.dispatchEvent(gesture)).toBe(false);
    expect(gesture.defaultPrevented).toBe(true);
  });

  it("uses the shared opaque overlay and prevents gameplay pointer leakage", () => {
    mockIosStandalone();
    const store = readyStore();
    const gameplayPointerDown = vi.fn();
    const view = render(
      <div onPointerDown={gameplayPointerDown}>
        <ChatPanel
          open
          snapshot={store.getSnapshot()}
          connectionStatus="online"
          onSelectChannel={vi.fn()}
          onSend={vi.fn()}
          onRetry={vi.fn()}
          onLoadOlder={vi.fn()}
          onClose={vi.fn()}
        />
      </div>
    );

    const panel = view.container.querySelector(".chat-panel")!;
    expect(panel.classList.contains("mobile-chat-overlay")).toBe(true);
    expect(panel.hasAttribute("data-mobile-chat-dock-layout")).toBe(true);
    expect(panel.getAttribute("data-mobile-chat-type")).toBe("public");
    expect(panel.querySelector("[data-mobile-chat-composer]")).toBeTruthy();
    expect(panel.querySelector("[data-mobile-chat-message-region]")).toBeTruthy();
    const draft = screen.getByPlaceholderText("Message General") as HTMLTextAreaElement;
    const focus = vi.spyOn(draft, "focus");
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
    expect(fireEvent.pointerDown(draft)).toBe(true);
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBe("true");
    expect(focus).toHaveBeenCalledWith();
    expect(document.activeElement).toBe(draft);
    expect(gameplayPointerDown).not.toHaveBeenCalled();
  });

  it("pins opening and both keyboard transitions to the exact bottom only while following", () => {
    const frames = installFrameHarness();
    const store = readyStore();
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const list = view.container.querySelector<HTMLElement>(".chat-message-list")!;
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 420 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 100 });
    list.scrollTop = 0;
    act(() => frames.flushAll());
    expect(list.scrollTop).toBe(320);
    expect(list.scrollHeight - list.scrollTop - list.clientHeight).toBe(0);

    list.scrollTop = 0;
    window.dispatchEvent(new Event(MOBILE_KEYBOARD_COMMITTED_EVENT));
    act(() => frames.flushAll());
    expect(list.scrollTop).toBe(320);

    list.scrollTop = 0;
    window.dispatchEvent(new Event(MOBILE_KEYBOARD_SETTLED_EVENT));
    act(() => frames.flushAll());
    expect(list.scrollTop).toBe(320);

    scrollAwayFromBottom(list);
    list.scrollTop = 120;
    window.dispatchEvent(new Event(MOBILE_KEYBOARD_COMMITTED_EVENT));
    window.dispatchEvent(new Event(MOBILE_KEYBOARD_SETTLED_EVENT));
    act(() => frames.flushAll());
    expect(list.scrollTop).toBe(120);
  });

  it("pins after the final message-list resize only while following", () => {
    const frames = installFrameHarness();
    let resize: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    });
    const store = readyStore();
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const list = view.container.querySelector<HTMLElement>(".chat-message-list")!;
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 120 });
    list.scrollTop = 0;
    act(() => resize?.([], {} as ResizeObserver));
    act(() => frames.flushAll());
    expect(list.scrollTop).toBe(380);

    scrollAwayFromBottom(list);
    list.scrollTop = 75;
    act(() => resize?.([], {} as ResizeObserver));
    act(() => frames.flushAll());
    expect(list.scrollTop).toBe(75);
  });

  it("keeps focused Send pointer presses on the textarea and submits once", () => {
    const store = readyStore();
    const onSend = vi.fn(() => true);
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={onSend}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const textarea = screen.getByPlaceholderText("Message General") as HTMLTextAreaElement;
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.change(textarea, { target: { value: "one message" } });
    textarea.focus();
    expect(fireEvent.pointerDown(send)).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("");

    textarea.blur();
    expect(document.activeElement).not.toBe(textarea);
  });

  it("preserves an unsent draft across a close and reopen", () => {
    const store = readyStore();
    const panel = (open: boolean) => (
      <ChatPanel
        open={open}
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const view = render(panel(true));
    fireEvent.change(screen.getByPlaceholderText("Message General"), {
      target: { value: "keep this public draft" }
    });

    view.rerender(panel(false));
    view.rerender(panel(true));

    expect((screen.getByPlaceholderText("Message General") as HTMLTextAreaElement).value)
      .toBe("keep this public draft");
  });

  it("opens channel selection through the expanded chat selector", () => {
    const store = readyStore();
    const onSelectChannel = vi.fn();
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={onSelectChannel}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const selector = screen.getByRole("combobox", { name: "Select expanded chat room" });
    expect((selector as HTMLSelectElement).value).toBe(GENERAL);
    expect(Array.from(selector.querySelectorAll("option"), (option) => option.textContent)).toEqual([
      "General",
      "Trading",
      "Hunting",
      "Local"
    ]);
    const wideTabs = within(screen.getByRole("tablist", { name: "Chat rooms" }));
    expect(wideTabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "General",
      "Trading",
      "Hunting",
      "Local"
    ]);
    expect(wideTabs.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.change(selector, { target: { value: TRADING } });
    expect(onSelectChannel).toHaveBeenCalledWith(TRADING);
  });

  it("renders every authorized channel in one canonical tab rail without an overflow trigger", () => {
    const store = readyStore();
    store.applyPinnedChannelCategories(["general", "trading", "hunting"]);
    const onSelectChannel = vi.fn();
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={onSelectChannel}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const rail = screen.getByRole("tablist", { name: "Chat rooms" });
    expect(rail.classList.contains("game-app-tabs")).toBe(true);
    expect(within(rail).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "General",
      "Trading",
      "Hunting",
      "Local"
    ]);
    expect(screen.queryByRole("button", { name: "All Chats" })).toBeNull();
    expect(view.container.querySelector(".chat-room-tab-strip")).toBeTruthy();

    fireEvent.keyDown(within(rail).getByRole("tab", { name: "General" }), {
      key: "ArrowRight"
    });
    expect(onSelectChannel).toHaveBeenCalledWith(TRADING);
  });

  it("opens the dedicated rules screen from the locked composer and hides it after acceptance", () => {
    const store = readyStore();
    const onOpenTerms = vi.fn();
    const props = {
      open: true,
      snapshot: store.getSnapshot(),
      connectionStatus: "online" as const,
      onSelectChannel: vi.fn(),
      onSend: vi.fn(),
      onRetry: vi.fn(),
      onLoadOlder: vi.fn(),
      onClose: vi.fn(),
      termsAccepted: false,
      onOpenTerms
    };
    const view = render(<ChatPanel {...props} />);

    const action = screen.getByRole("button", {
      name: "Review Community Rules to chat"
    });
    expect(action.getAttribute("type")).toBe("button");
    expect(action.getAttribute("aria-controls")).toBe("community-rules-acceptance");
    expect(action.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByPlaceholderText("Message General")).toBeNull();
    fireEvent.click(action);
    expect(onOpenTerms).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Community Rules" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Community Rules/ })).toBeNull();

    view.rerender(<ChatPanel {...props} termsAccepted />);
    expect((screen.getByPlaceholderText("Message General") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Review Community Rules to chat" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Community Rules/ })).toBeNull();
  });

  it("keeps the visible compose channel authoritative and opens sender actions without switching rooms", () => {
    const store = readyStore();
    store.selectChannel(LOCAL);
    store.applyMessage({
      ...message(1, "Hello nearby", "other"),
      channelId: "channel-local:map",
      channelKey: LOCAL,
      senderDisplayName: "<b>Other Player</b>"
    });
    const onSelectChannel = vi.fn();
    const onOpenSender = vi.fn();
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={onSelectChannel}
        onSend={vi.fn(() => true)}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onOpenSender={onOpenSender}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Speaking in:").parentElement?.textContent).toBe("Speaking in:Local");
    const sender = screen.getByRole("button", { name: "<b>Other Player</b>" });
    fireEvent.click(sender);
    expect(onOpenSender).toHaveBeenCalledWith(
      "other",
      "<b>Other Player</b>",
      expect.objectContaining({ left: expect.any(Number), bottom: expect.any(Number) })
    );
    expect(onSelectChannel).not.toHaveBeenCalled();
    expect(view.container.querySelector("b")).toBeNull();

    const composer = screen.getByPlaceholderText("Message Local");
    fireEvent.change(composer, { target: { value: "draft survives" } });
    store.selectChannel(TRADING);
    view.rerender(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={onSelectChannel}
        onSend={vi.fn(() => true)}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onOpenSender={onOpenSender}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("Speaking in:").parentElement?.textContent).toBe("Speaking in:Trading");
    expect((screen.getByPlaceholderText("Message Trading") as HTMLTextAreaElement).value).toBe("draft survives");
  });

  it("does not expose player actions on self-authored messages", () => {
    const store = readyStore();
    store.applyMessage(message(1, "Self message", "self"));
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onOpenSender={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Self" })).toBeNull();
    expect(screen.getByText("Self").tagName).toBe("STRONG");
  });

  it("keeps message reporting contextual and supports reactions and translation", async () => {
    const store = readyStore();
    store.applyMessage({
      ...message(1, "Hola", "other"),
      senderDisplayName: "Other"
    });
    const onReportMessage = vi.fn();
    const onReactMessage = vi.fn();
    const onTranslateMessage = vi.fn(() => ({
      translatedText: "Hello",
      sourceLanguage: "Spanish"
    }));
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onReportMessage={onReportMessage}
        onReactMessage={onReactMessage}
        onTranslateMessage={onTranslateMessage}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByRole("menuitem", { name: "Report" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Actions for message from Other" });
    const reactionTrigger = screen.getByRole("button", { name: "React to message from Other" });
    fireEvent.click(reactionTrigger);
    expect(screen.queryByRole("menuitem", { name: "React" })).toBeNull();
    const reactionPicker = screen.getByRole("group", { name: "Choose a reaction" });
    expect(reactionPicker.getAttribute("data-chat-message-popover-layer")).toBe("true");
    expect(document.querySelector(".chat-message-list")?.contains(reactionPicker)).toBe(false);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Choose a reaction" })).toBeNull();

    fireEvent.click(reactionTrigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("group", { name: "Choose a reaction" })).toBeNull();
    const actionMenu = screen.getByRole("menu", { name: "Actions for message from Other" });
    expect(actionMenu.getAttribute("data-chat-message-popover-layer")).toBe("true");
    expect(document.querySelector(".chat-message-list")?.contains(actionMenu)).toBe(false);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Actions for message from Other" })).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Actions for message from Other" })).toBeNull();
    expect(screen.getByLabelText("Chat panel")).toBeTruthy();

    fireEvent.click(reactionTrigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("group", { name: "Choose a reaction" })).toBeNull();
    fireEvent.click(reactionTrigger);
    fireEvent.click(screen.getByRole("button", { name: "React with 👍" }));
    expect(onReactMessage).toHaveBeenCalledWith("message-1", "👍", true);
    expect(screen.queryByRole("group", { name: "Choose a reaction" })).toBeNull();
    expect(screen.getByRole("button", { name: "👍 reaction, 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "👍 reaction, 1" }));
    expect(screen.queryByRole("button", { name: "👍 reaction, 1" })).toBeNull();

    fireEvent.click(trigger);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Translate" }));
    });
    expect(onTranslateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hola" }),
      expect.any(String)
    );
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText("Hola")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show original" })).toBeTruthy();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Report" }));
    expect(screen.getByRole("heading", { name: "Report message from Other" })).toBeTruthy();
  });

  it("contains scrolling and keyboard input inside open chat popovers", () => {
    const store = readyStore();
    store.applyMessage({
      ...message(1, "Scrollable actions", "other"),
      senderDisplayName: "Other"
    });
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settings = screen.getByRole("dialog", { name: "Chat settings" });
    expect(settings.getAttribute("data-chat-settings-popover-layer")).toBe("true");
    expect(document.querySelector("#public-chat-panel")?.contains(settings)).toBe(false);
    fireEvent.pointerDown(settings);
    fireEvent.touchMove(settings);
    fireEvent.wheel(settings);
    fireEvent.scroll(settings);
    fireEvent.keyDown(settings, { key: "PageDown" });
    expect(screen.getByRole("dialog", { name: "Chat settings" })).toBe(settings);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for message from Other" }));
    const actionMenu = screen.getByRole("menu", { name: "Actions for message from Other" });
    fireEvent.pointerDown(actionMenu);
    fireEvent.touchMove(actionMenu);
    fireEvent.wheel(actionMenu);
    fireEvent.scroll(actionMenu);
    fireEvent.keyDown(actionMenu, { key: "PageDown" });
    expect(screen.getByRole("menu", { name: "Actions for message from Other" })).toBe(actionMenu);

    fireEvent.click(screen.getByRole("button", { name: "React to message from Other" }));
    const reactionPicker = screen.getByRole("group", { name: "Choose a reaction" });
    fireEvent.pointerDown(reactionPicker);
    fireEvent.touchMove(reactionPicker);
    fireEvent.wheel(reactionPicker);
    fireEvent.scroll(reactionPicker);
    fireEvent.keyDown(reactionPicker, { key: "PageDown" });
    expect(screen.getByRole("group", { name: "Choose a reaction" })).toBe(reactionPicker);
  });

  it("keeps manual Unicode emoji input and persists reaction settings", () => {
    const store = readyStore();
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const textarea = screen.getByPlaceholderText("Message General") as HTMLTextAreaElement;
    expect(screen.queryByRole("button", { name: "Open emoji picker" })).toBeNull();
    fireEvent.change(textarea, { target: { value: "🔥" } });
    expect(textarea.value).toBe("🔥");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByRole("checkbox", { name: "Show emoji picker" })).toBeNull();
    const reactionSetting = screen.getByRole("checkbox", { name: "Show message reactions" });
    fireEvent.click(reactionSetting);
    expect(window.localStorage.getItem("ashAtlas.chat.uiPreferences")).toContain(
      '"showReactions":false'
    );
  });

  it("keeps the composer compact and expands multiline drafts within a bound", () => {
    const store = readyStore();
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const textarea = screen.getByPlaceholderText("Message General") as HTMLTextAreaElement;
    expect(textarea.rows).toBe(1);

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 72 });
    fireEvent.change(textarea, { target: { value: "first line\nsecond line" } });
    expect(textarea.style.height).toBe("72px");
    expect(textarea.style.overflowY).toBe("hidden");

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 140 });
    fireEvent.change(textarea, { target: { value: "first line\nsecond line\nthird line" } });
    expect(textarea.style.height).toBe("104px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("only translates the message explicitly chosen from its actions", () => {
    const store = readyStore();
    store.applyMessage(message(1, "Hola", "other"));
    const onTranslateMessage = vi.fn(() => ({
      translatedText: "Hello",
      sourceLanguage: "Spanish"
    }));
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onTranslateMessage={onTranslateMessage}
        onClose={vi.fn()}
      />
    );

    expect(onTranslateMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByLabelText("Automatically translate")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for message from Other Player" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Translate" }));
    expect(onTranslateMessage).toHaveBeenCalledTimes(1);
  });

  it("translates with one click on the dedicated button on every message, including own", async () => {
    const store = readyStore();
    store.applyMessage({ ...message(1, "Hola", "other"), senderDisplayName: "Other" });
    store.applyMessage({ ...message(2, "Mine", "self"), senderDisplayName: "Self" });
    const onTranslateMessage = vi.fn(() => ({ translatedText: "Hello", sourceLanguage: "es" }));
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onTranslateMessage={onTranslateMessage}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Translate message from Self" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Translate message from Other" }));
    });
    expect(onTranslateMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Hello")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show original for message from Other" }));
    expect(screen.queryByText("Hello")).toBeNull();
    expect(onTranslateMessage).toHaveBeenCalledTimes(1);
  });

  it("shows a shared translation for the viewer language without calling the API and skips same-language sources", () => {
    const store = readyStore();
    store.applyMessage({
      ...message(1, "Hola", "other"),
      senderDisplayName: "Other",
      translations: { en: { translatedText: "Hello shared", sourceLanguage: "es" } }
    });
    store.applyMessage({
      ...message(2, "Already English", "other"),
      senderDisplayName: "Other",
      translations: { en: { translatedText: "Echo of English", sourceLanguage: "en" } }
    });
    const onTranslateMessage = vi.fn();
    const props = {
      open: true,
      connectionStatus: "online" as const,
      ownPlayerId: "self",
      onSelectChannel: vi.fn(),
      onSend: vi.fn(),
      onRetry: vi.fn(),
      onLoadOlder: vi.fn(),
      onTranslateMessage,
      onClose: vi.fn()
    };
    const view = render(<ChatPanel {...props} snapshot={store.getSnapshot()} />);

    expect(screen.getByText("Hello shared")).toBeTruthy();
    expect(screen.queryByText("Echo of English")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Show original" })[0]!);
    expect(screen.queryByText("Hello shared")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show translation" }));
    expect(screen.getByText("Hello shared")).toBeTruthy();
    expect(onTranslateMessage).not.toHaveBeenCalled();

    // A translation pushed live (or cached by another viewer) appears on an already rendered row.
    expect(store.applyTranslation("public:general", "message-2", "es", {
      translatedText: "Ya en ingles",
      sourceLanguage: "en"
    })).toBe(true);
    view.rerender(<ChatPanel {...props} snapshot={store.getSnapshot()} />);
    expect(screen.queryByText("Ya en ingles")).toBeNull();
    expect(store.applyTranslation("public:general", "message-2", "en", {
      translatedText: "Echo of English",
      sourceLanguage: "en"
    })).toBe(false);
  });

  it("does not reveal mobile actions before a completed 500ms hold or show a touch context menu", () => {
    vi.useFakeTimers();
    const store = readyStore();
    store.applyMessage(message(1, "Short touch", "other"));
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const row = view.container.querySelector<HTMLElement>(".chat-message")!;

    dispatchPointer(row, "pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10
    });
    act(() => { vi.advanceTimersByTime(499); });
    expect(row.dataset.mobileActionsRevealed).toBeUndefined();
    expect(screen.queryByRole("menu", { name: "Actions for message from Other Player" })).toBeNull();
    dispatchPointer(row, "pointerup", { pointerId: 1, pointerType: "touch" });
    const contextMenu = new Event("contextmenu", { bubbles: true, cancelable: true });
    act(() => { row.dispatchEvent(contextMenu); });
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu", { name: "Actions for message from Other Player" })).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(row.dataset.mobileActionsRevealed).toBeUndefined();
    vi.useRealTimers();
  });

  it("reveals the quick toolbar, not the actions menu, after a mobile long press", () => {
    vi.useFakeTimers();
    const store = readyStore();
    store.applyMessage(message(1, "Touch and hold", "other"));
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const row = view.container.querySelector<HTMLElement>(".chat-message")!;
    dispatchPointer(row, "pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10
    });
    act(() => { vi.advanceTimersByTime(500); });
    expect(row.dataset.mobileActionsRevealed).toBe("true");
    expect(screen.queryByRole("menu", { name: "Actions for message from Other Player" })).toBeNull();
    expect(screen.getByRole("button", { name: "React to message from Other Player" })).toBeTruthy();
    dispatchPointer(row, "pointerup", { pointerId: 1, pointerType: "touch" });
    vi.useRealTimers();
  });

  it("cancels a mobile action hold when released, moved, or canceled", () => {
    vi.useFakeTimers();
    const store = readyStore();
    store.applyMessage(message(1, "Touch and hold", "other"));
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const row = view.container.querySelector<HTMLElement>(".chat-message")!;
    const pointer = (pointerId: number) => ({
      pointerId,
      pointerType: "touch",
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10
    });

    dispatchPointer(row, "pointerdown", pointer(1));
    act(() => { vi.advanceTimersByTime(499); });
    dispatchPointer(row, "pointerup", pointer(1));
    act(() => { vi.advanceTimersByTime(1); });
    expect(row.dataset.mobileActionsRevealed).toBeUndefined();

    dispatchPointer(row, "pointerdown", pointer(2));
    dispatchPointer(row, "pointermove", { ...pointer(2), clientX: 22 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(row.dataset.mobileActionsRevealed).toBeUndefined();
    expect(screen.queryByRole("menu", { name: "Actions for message from Other Player" })).toBeNull();

    dispatchPointer(row, "pointerdown", pointer(3));
    dispatchPointer(row, "pointercancel", pointer(3));
    act(() => { vi.advanceTimersByTime(500); });
    expect(row.dataset.mobileActionsRevealed).toBeUndefined();
    expect(screen.queryByRole("menu", { name: "Actions for message from Other Player" })).toBeNull();

    dispatchPointer(row, "pointerdown", pointer(4));
    fireEvent.scroll(view.container.querySelector(".chat-message-list")!);
    act(() => { vi.advanceTimersByTime(500); });
    expect(row.dataset.mobileActionsRevealed).toBeUndefined();
    expect(screen.queryByRole("menu", { name: "Actions for message from Other Player" })).toBeNull();
    vi.useRealTimers();
  });

  it("reveals only the held message and dismisses its controls from another row or outside", () => {
    vi.useFakeTimers();
    const store = readyStore();
    store.applyMessage(message(1, "First", "other"));
    store.applyMessage({ ...message(2, "Second", "other"), senderDisplayName: "Second Player" });
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".chat-message"));
    expect(rows).toHaveLength(2);
    const hold = (row: HTMLElement, pointerId: number) => {
      dispatchPointer(row, "pointerdown", {
        pointerId,
        pointerType: "touch",
        button: 0,
        isPrimary: true,
        clientX: 10,
        clientY: 10
      });
      act(() => { vi.advanceTimersByTime(500); });
    };

    hold(rows[0]!, 1);
    expect(rows[0]!.dataset.mobileActionsRevealed).toBe("true");
    expect(rows[1]!.dataset.mobileActionsRevealed).toBeUndefined();
    dispatchPointer(rows[0]!, "pointerup", { pointerId: 1, pointerType: "touch" });

    dispatchPointer(rows[1]!, "pointerdown", {
      pointerId: 2,
      pointerType: "touch",
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10
    });
    expect(rows[0]!.dataset.mobileActionsRevealed).toBeUndefined();
    act(() => { vi.advanceTimersByTime(500); });
    expect(rows[1]!.dataset.mobileActionsRevealed).toBe("true");
    expect(rows[0]!.dataset.mobileActionsRevealed).toBeUndefined();
    dispatchPointer(rows[1]!, "pointerup", { pointerId: 2, pointerType: "touch" });

    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(rows[1]!.dataset.mobileActionsRevealed).toBeUndefined();
    vi.useRealTimers();
  });

  it("keeps desktop pointer behavior on the existing hover and context-menu path", () => {
    vi.useFakeTimers();
    const store = readyStore();
    store.applyMessage(message(1, "Desktop action", "other"));
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const row = view.container.querySelector<HTMLElement>(".chat-message")!;

    dispatchPointer(row, "pointerdown", {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10
    });
    act(() => { vi.advanceTimersByTime(500); });
    expect(row.dataset.mobileActionsRevealed).toBeUndefined();
    expect(screen.queryByRole("menu", { name: "Actions for message from Other Player" })).toBeNull();
    const contextMenu = new Event("contextmenu", { bubbles: true, cancelable: true });
    act(() => { row.dispatchEvent(contextMenu); });
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(screen.getByRole("menu", { name: "Actions for message from Other Player" })).toBeTruthy();
    vi.useRealTimers();
  });

  it("dismisses Chat Settings from every outside region while preserving inside controls", () => {
    const store = readyStore();
    store.applyMessage(message(1, "Transcript target", "other"));
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(settings.getAttribute("title")).toBe("Settings");
    expect(settings.querySelector("svg")).not.toBeNull();
    const dialog = () => screen.queryByRole("dialog", { name: "Chat settings" });
    const reopen = () => {
      fireEvent.click(settings);
      expect(dialog()).toBeTruthy();
    };

    reopen();
    const reactionSetting = screen.getByRole("checkbox", { name: "Show message reactions" });
    fireEvent.pointerDown(reactionSetting, { pointerType: "mouse" });
    expect(dialog()).toBeTruthy();
    fireEvent.click(reactionSetting);
    expect(dialog()).toBeTruthy();

    const row = view.container.querySelector<HTMLElement>(".chat-message")!;
    fireEvent.pointerDown(row, { pointerType: "mouse" });
    expect(dialog()).toBeNull();

    reopen();
    fireEvent.pointerDown(screen.getByPlaceholderText("Message General"), { pointerType: "mouse" });
    expect(dialog()).toBeNull();

    reopen();
    fireEvent.pointerDown(view.container.querySelector(".chat-panel-header")!, { pointerType: "mouse" });
    expect(dialog()).toBeNull();

    reopen();
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    expect(dialog()).toBeNull();

    reopen();
    fireEvent.click(settings);
    expect(dialog()).toBeNull();
  });

  it("groups consecutive authors below five minutes and divides only when the day changes", () => {
    const store = readyStore();
    store.applyMessage(messageAt(1, "first", "vic", "2026-07-10T12:00:00.000Z"));
    store.applyMessage(messageAt(2, "second", "vic", "2026-07-10T12:04:59.999Z"));
    store.applyMessage(messageAt(3, "exactly five", "vic", "2026-07-10T12:09:59.999Z"));
    store.applyMessage(messageAt(4, "reply", "wren", "2026-07-10T12:10:00.000Z"));
    store.applyMessage(messageAt(5, "returns", "vic", "2026-07-10T12:11:00.000Z"));
    store.applyMessage(messageAt(6, "next day", "vic", "2026-07-11T12:26:00.000Z"));
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".chat-message"));
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.dataset.messageGroup)).toEqual([
      "start",
      "continuation",
      "start",
      "start",
      "start",
      "start"
    ]);
    expect(rows.map((row) => row.querySelector(".chat-message-heading time") !== null)).toEqual([
      true,
      false,
      true,
      true,
      true,
      true
    ]);
    expect(rows.slice(0, 5).every((row) => !row.classList.contains("chat-message-time-gap"))).toBe(true);
    expect(rows[5]!.classList.contains("chat-message-time-gap")).toBe(true);
    expect(screen.getAllByText("Vic")).toHaveLength(4);
    expect(screen.getAllByText("Wren")).toHaveLength(1);
  });

  it("starts a new group for invalid, out-of-order, and non-adjacent visible messages", () => {
    const store = readyStore();
    store.applyMessage(messageAt(1, "before hidden", "vic", "2026-07-10T12:00:00.000Z"));
    store.applyMessage(messageAt(2, "hidden", "blocked", "2026-07-10T12:01:00.000Z"));
    store.applyMessage(messageAt(3, "after hidden", "vic", "2026-07-10T12:02:00.000Z"));
    store.applyMessage(messageAt(4, "invalid", "vic", "invalid"));
    store.applyMessage(messageAt(5, "out of order", "vic", "2026-07-10T11:59:00.000Z"));
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        hiddenSenderIds={new Set(["blocked"])}
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".chat-message"));
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.dataset.messageGroup === "start")).toBe(true);
    expect(rows.every((row) => !row.classList.contains("chat-message-time-gap"))).toBe(true);
  });

  it("appends a live same-sender message to the current visual group", () => {
    const store = readyStore();
    store.applyMessage(messageAt(1, "first", "vic", "2026-07-10T12:00:00.000Z"));
    const panel = () => (
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const view = render(panel());

    store.applyMessage(messageAt(2, "second", "vic", "2026-07-10T12:01:00.000Z"));
    view.rerender(panel());

    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".chat-message"));
    expect(rows.map((row) => row.dataset.messageGroup)).toEqual(["start", "continuation"]);
    expect(screen.getAllByText("Vic")).toHaveLength(1);
    expect(rows[0]!.querySelector(".chat-message-heading time")?.getAttribute("datetime"))
      .toBe("2026-07-10T12:00:00.000Z");
    expect(rows[1]!.querySelector(".chat-message-heading time")).toBeNull();
  });

  it("renders a bounded list, sends normalized text, and retries failed messages", () => {
    const store = readyStore();
    store.applyChannelSelected({
      channelKey: GENERAL,
      messages: Array.from({ length: 200 }, (_, index) => message(index + 1)),
      latestSequence: 200,
      hasOlder: false,
      reset: false,
      readState: readState(GENERAL, 200, 200),
      mute: unmuted(GENERAL)
    });
    store.startPending({
      requestId: "failed-request",
      channelKey: GENERAL,
      body: "Retry me",
      senderPlayerId: "self",
      senderDisplayName: "Self"
    });
    store.failPending("failed-request", "RATE_LIMITED", 1_000);
    const onSend = vi.fn(() => true);
    const onRetry = vi.fn();
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={onSend}
        onRetry={onRetry}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(view.container.querySelectorAll("[data-message-state]").length).toBeLessThanOrEqual(240);
    expect(within(screen.getByRole("tablist", { name: "Chat rooms" }))
      .getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("failed-request");

    const composer = screen.getByPlaceholderText("Message General");
    fireEvent.change(composer, { target: { value: " hello\r\nworld " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("hello\nworld");
    expect((composer as HTMLTextAreaElement).value).toBe("");
  });

  it("shows mute, rate-limit, and scrolled-up new-message states without raw HTML", () => {
    const store = readyStore();
    store.applyChannelSelected({
      channelKey: GENERAL,
      messages: [],
      latestSequence: 0,
      hasOlder: false,
      reset: false,
      readState: readState(GENERAL, 0, 0),
      mute: unmuted(GENERAL)
    });
    store.setViewportAtBottom(false);
    store.applyMessage(message(1, "<img src=x onerror=alert(1)>", "blocked-player"));
    store.applyMessage(message(2, "Safe message", "visible-player"));
    store.applyMuteSnapshot(GENERAL, {
      muted: true,
      channelKey: GENERAL,
      scope: "channel",
      reason: "Slow down",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
    });
    store.setSendFeedback(GENERAL, {
      code: "CHAT_RATE_LIMITED",
      message: "Too many messages.",
      retryAfterMs: 2_100
    });
    const onViewportAtBottom = vi.fn();
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        hiddenSenderIds={new Set(["blocked-player"])}
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onViewportAtBottom={onViewportAtBottom}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Chat muted: Slow down", { exact: false })).toBeTruthy();
    expect(screen.getByText("Too many messages.", { exact: false }).textContent).toContain(
      "Try again in 3s."
    );
    expect((screen.getByPlaceholderText("You are temporarily muted") as HTMLTextAreaElement).disabled).toBe(true);
    scrollAwayFromBottom(view.container.querySelector<HTMLElement>(".chat-message-list")!);
    expect(screen.getByRole("button", { name: "2 new messages" })).toBeTruthy();
    expect(view.container.querySelector("img.chat-message-crest")).not.toBeNull();
    expect(screen.queryByText("<img src=x onerror=alert(1)>")).toBeNull();
    expect(screen.getByText("Safe message")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "2 new messages" }));
    expect(onViewportAtBottom).toHaveBeenCalledWith(true, 2);
  });

  it("switches Follow live from manual scrolling and counts only deduplicated arrivals while off", () => {
    const frames = installFrameHarness();
    const store = readyStore();
    const onViewportAtBottom = vi.fn(
      (atBottom: boolean, latestSequence: number | null) =>
        store.setViewportAtBottom(atBottom, store.getSnapshot().selectedChannelKey, latestSequence)
    );
    const props = {
      open: true,
      connectionStatus: "online" as const,
      onSelectChannel: vi.fn(),
      onSend: vi.fn(() => true),
      onRetry: vi.fn(),
      onLoadOlder: vi.fn(),
      onViewportAtBottom,
      onClose: vi.fn()
    };
    const view = render(<ChatPanel {...props} snapshot={store.getSnapshot()} />);
    const list = view.container.querySelector<HTMLElement>(".chat-message-list")!;
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 200 });
    act(() => frames.flushAll());

    list.scrollTop = 371;
    fireEvent.scroll(list);
    list.scrollTop = 372;
    fireEvent.scroll(list);
    act(() => frames.flushAll());

    list.scrollTop = 100;
    fireEvent.scroll(list);
    store.applyMessage(message(1, "First arrival"));
    store.applyMessage(message(1, "Duplicate update"));
    store.applyMessage(message(2, "Second arrival"));
    view.rerender(<ChatPanel {...props} snapshot={store.getSnapshot()} />);

    expect(list.scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "2 new messages" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2 new messages" }));
    act(() => frames.flushAll());
    expect(store.getSnapshot().newMessageCount).toBe(0);
    expect(list.scrollTop).toBe(400);

    scrollAwayFromBottom(list);
    fireEvent.change(screen.getByPlaceholderText("Message General"), {
      target: { value: "draft survives room change" }
    });
    store.selectChannel(TRADING);
    view.rerender(<ChatPanel {...props} snapshot={store.getSnapshot()} />);
    expect((screen.getByPlaceholderText("Message Trading") as HTMLTextAreaElement).value).toBe(
      "draft survives room change"
    );
  });

  it("renders nothing while closed", () => {
    const store = readyStore();
    const view = render(
      <ChatPanel
        open={false}
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(view.container.innerHTML).toBe("");
  });

  it("shows Local as an explicit live-only compose target without historical controls", () => {
    const store = readyStore();
    store.selectChannel(LOCAL);
    document.documentElement.dataset.uiProfile = "phone";
    const onSelectChannel = vi.fn();
    const view = render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={onSelectChannel}
        onSend={vi.fn(() => true)}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const selector = screen.getByRole("combobox", { name: "Select expanded chat room" });
    expect((selector as HTMLSelectElement).value).toBe(LOCAL);
    expect(Array.from(selector.querySelectorAll("option"), (option) => option.textContent)).toEqual([
      "General",
      "Trading",
      "Hunting",
      "Local"
    ]);
    const wideTabs = within(screen.getByRole("tablist", { name: "Chat rooms" }));
    expect(wideTabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "General",
      "Trading",
      "Hunting",
      "Local"
    ]);
    expect(wideTabs.getByRole("tab", { name: "Local" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByPlaceholderText("Message Local")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
    expect(view.container.querySelector(".chat-panel")?.getAttribute("aria-label")).toBe("Chat panel");

    document.documentElement.dataset.uiProfile = "desktop";
  });

  it("bottom-anchors the first Local message and contains keyboard boundary pulls", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    });
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    document.documentElement.dataset.uiProfile = "phone";
    const store = readyStore();
    store.selectChannel(LOCAL);
    const props = {
      open: true,
      connectionStatus: "online" as const,
      onSelectChannel: vi.fn(),
      onSend: vi.fn(() => true),
      onRetry: vi.fn(),
      onLoadOlder: vi.fn(),
      onClose: vi.fn()
    };
    const view = render(<ChatPanel {...props} snapshot={store.getSnapshot()} />);
    const list = view.container.querySelector<HTMLElement>(".chat-message-list")!;
    expect(list.querySelector(".chat-message-spacer")).toBeNull();

    store.startPending({
      requestId: "local-first",
      channelKey: LOCAL,
      body: "Hi",
      senderPlayerId: "self",
      senderDisplayName: "Wren"
    });
    view.rerender(<ChatPanel {...props} snapshot={store.getSnapshot()} />);
    expect(list.firstElementChild?.classList.contains("chat-message-spacer")).toBe(true);

    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 200 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 200 });
    act(() => (screen.getByPlaceholderText("Message Local") as HTMLTextAreaElement).focus());
    dispatchTouch(list, "touchstart", 100, 100);
    expect(dispatchTouch(list, "touchmove", 100, 60).defaultPrevented).toBe(true);
  });

  it("keeps a draft while the selected compose channel changes", () => {
    const store = readyStore();
    const props = {
      open: true,
      connectionStatus: "online" as const,
      onSelectChannel: vi.fn(),
      onSend: vi.fn(() => true),
      onRetry: vi.fn(),
      onLoadOlder: vi.fn(),
      onClose: vi.fn()
    };
    const view = render(<ChatPanel {...props} snapshot={store.getSnapshot()} />);
    fireEvent.change(screen.getByPlaceholderText("Message General"), {
      target: { value: "Anyone near this mine?" }
    });

    store.selectChannel(LOCAL);
    view.rerender(<ChatPanel {...props} snapshot={store.getSnapshot()} />);
    expect((screen.getByPlaceholderText("Message Local") as HTMLTextAreaElement).value).toBe(
      "Anyone near this mine?"
    );
  });

  it("fails closed while block safety state loads", () => {
    const store = readyStore();
    store.applyMessage(message(1, "Potentially blocked content", "other"));
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        blockFilterReady={false}
        ownPlayerId="self"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Loading chat safety settings...")).toBeTruthy();
    expect(screen.queryByText("Potentially blocked content")).toBeNull();
  });

  it("defaults Follow live on and requests newest when opening detached history", () => {
    const store = readyStore();
    store.applyChannelSelected({
      channelKey: GENERAL,
      messages: Array.from({ length: 200 }, (_, index) => message(index + 101)),
      latestSequence: 300,
      hasOlder: true,
      reset: false,
      readState: readState(GENERAL, 300, 300),
      mute: unmuted(GENERAL)
    });
    store.applyHistoryResult({
      channelKey: GENERAL,
      direction: "older",
      messages: Array.from({ length: 50 }, (_, index) => message(index + 51)),
      hasMore: true,
      latestSequence: 300,
      reset: false
    });
    const onJumpToNewest = vi.fn();
    render(
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={vi.fn()}
        onJumpToNewest={onJumpToNewest}
        onClose={vi.fn()}
      />
    );

    expect(onJumpToNewest).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Jump to newest" })).toBeNull();
  });

  it("preserves the prior oldest-row viewport anchor when deep paging keeps equal row count", () => {
    const store = readyStore();
    store.applyChannelSelected({
      channelKey: GENERAL,
      messages: Array.from({ length: 200 }, (_, index) => message(index + 101)),
      latestSequence: 300,
      hasOlder: true,
      reset: false,
      readState: readState(GENERAL, 300, 300),
      mute: unmuted(GENERAL)
    });
    const onLoadOlder = vi.fn();
    const renderPanel = () => (
      <ChatPanel
        open
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onLoadOlder={onLoadOlder}
        onClose={vi.fn()}
      />
    );
    const view = render(renderPanel());
    const list = view.container.querySelector<HTMLElement>(".chat-message-list")!;
    scrollAwayFromBottom(list);
    const anchor = view.container.querySelector<HTMLElement>(
      '[data-chat-sequence="101"]'
    )!;
    let anchorOffsetTop = 120;
    Object.defineProperty(anchor, "offsetTop", {
      configurable: true,
      get: () => anchorOffsetTop
    });
    list.scrollTop = 100;

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    expect(onLoadOlder).toHaveBeenCalledWith(101);
    anchorOffsetTop = 620;
    store.applyHistoryResult({
      channelKey: GENERAL,
      direction: "older",
      messages: Array.from({ length: 50 }, (_, index) => message(index + 51)),
      hasMore: true,
      latestSequence: 300,
      reset: false
    });
    view.rerender(renderPanel());

    expect(list.scrollTop).toBe(600);
  });
});

/** Scrolling up is how a viewer stops following live messages. */
function scrollAwayFromBottom(list: HTMLElement): void {
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 200 });
  list.scrollTop = 0;
  fireEvent.scroll(list);
}

function readyStore(): ChatStore {
  const store = new ChatStore({
    ownPlayerId: "self",
    storage: { getItem: () => null, setItem: () => undefined }
  });
  const channels = [
    localChannel(),
    channel(GENERAL, "General"),
    channel(TRADING, "Trading"),
    channel(HUNTING, "Hunting")
  ];
  store.applyChannelsSnapshot({
    channels,
    readStates: channels.map((item) => readState(item.key, 0, 0)),
    previews: [],
    selectedChannelKey: GENERAL
  });
  return store;
}

function localChannel(): ChatChannel {
  return {
    ...channel(LOCAL, "Local"),
    type: "local",
    historyRetentionPolicy: "live-session"
  };
}

function mockIosStandalone(): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15"
  );
  vi.spyOn(navigator, "platform", "get").mockReturnValue("iPhone");
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(display-mode: standalone)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  })));
}

function channel(key: string, displayName: string): ChatChannel {
  return {
    id: `channel-${key}`,
    key,
    type: "public",
    category: key === LOCAL
      ? "local"
      : key.split(":").at(-1) as "general" | "trading" | "hunting",
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

function readState(channelKey: string, lastReadSequence: number, latestSequence: number): ChatReadState {
  return {
    channelKey,
    lastReadSequence,
    latestSequence,
    unreadCount: latestSequence - lastReadSequence,
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

function message(
  sequence: number,
  body = `Message ${sequence}`,
  senderPlayerId = "other"
): ChatMessage {
  return {
    id: `message-${sequence}`,
    channelId: `channel-${GENERAL}`,
    channelKey: GENERAL,
    sequence,
    senderPlayerId,
    senderDisplayName: senderPlayerId === "self" ? "Self" : "Other Player",
    body,
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

function messageAt(
  sequence: number,
  body: string,
  senderPlayerId: string,
  createdAt: string
): ChatMessage {
  return {
    ...message(sequence, body, senderPlayerId),
    senderDisplayName: senderPlayerId === "vic" ? "Vic" : senderPlayerId === "wren" ? "Wren" : "Blocked",
    serverCreatedAt: createdAt,
    createdAt,
    updatedAt: createdAt
  };
}

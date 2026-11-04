// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectMessage, DirectMessageConversationSummary } from "@ash-atlas/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DirectMessageStore } from "../directMessages/directMessageStore.js";
import {
  MOBILE_KEYBOARD_COMMITTED_EVENT,
  MOBILE_KEYBOARD_SETTLED_EVENT,
  resetMobileKeyboardDockingForTests
} from "../mobileKeyboardDocking.js";
import { DirectMessagesPanel, type DirectMessagesPanelProps } from "./DirectMessagesPanel.js";

const SELF = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const SECOND_PEER = "00000000-0000-4000-8000-000000000003";
const CONVERSATION = "00000000-0000-4000-8000-000000000010";

afterEach(() => {
  cleanup();
  resetMobileKeyboardDockingForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DirectMessagesPanel", () => {
  it("keeps invitation actions in the floating desktop inbox without a mobile protection sheet", () => {
    const accept = vi.fn(() => true);
    const store = readyStore();
    const view = render(<DirectMessagesPanel {...props(store)} layout="desktop"
      onAcceptTravelInvite={accept}
      travelEntries={[{
        entryId: "desktop-travel", inviteId: "travel-1", perspective: "recipient",
        counterpartPlayerId: PEER, counterpartName: "Atlas Friend", message: "Join me at the flag.",
        status: "pending", invalidationReason: null, sourceType: "flag", sourceId: "flag-1",
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), respondedAt: null
      }]} />);
    expect(view.container.querySelector(".mobile-chat-protection")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Private messages" }).getAttribute("aria-modal")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /Travel Invitation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(accept).toHaveBeenCalledWith("travel-1");
  });
  it("opens a desktop legendary bird notice and marks its exact revision read", () => {
    const store = readyStore();
    const onMarkInboxRead = vi.fn(async () => true);
    const notice = {
      eventKind: "legendary_bird_event",
      eventId: "00000000-0000-4000-8000-000000000099",
      message: "An Ice Phoenix is attacking your flag! The flag is around 412 meters northeast of Nearmere!",
      createdAt: "2026-07-22T17:15:00.000Z"
    } as const;
    render(<DirectMessagesPanel
      {...props(store)}
      layout="desktop"
      gameNotices={[notice]}
      onMarkInboxRead={onMarkInboxRead}
    />);

    const row = screen.getByRole("button", { name: /Legendary Bird Event/ });
    expect(within(row).getByText(notice.message)).toBeTruthy();
    fireEvent.click(row);
    expect(screen.getByRole("region", { name: "Legendary Bird Event from Ash Atlas" })).toBeTruthy();
    expect(screen.getAllByText(notice.message)).toHaveLength(2);
    expect(onMarkInboxRead).toHaveBeenCalledWith([{
      entryKey: `game:${notice.eventKind}:${notice.eventId}`,
      revision: notice.createdAt
    }]);
  });

  it("renders player text as plain text and never interprets message HTML", () => {
    const store = readyStore();
    store.startOptimisticSend('<img src=x onerror="alert(1)">', "00000000-0000-4000-8000-000000000101");
    render(<DirectMessagesPanel {...props(store)} layout="desktop" />);
    expect(screen.getAllByText('<img src=x onerror="alert(1)">')).toHaveLength(2);
    expect(document.body.querySelector("img")).toBeNull();
    expect(document.body.querySelector("script")).toBeNull();
  });

  it("hides blocked conversation previews and history while preserving the unblock state", () => {
    const store = new DirectMessageStore({ ownPlayerId: SELF });
    store.applyConversationPage({
      conversations: [{
        ...summary(),
        canSend: false,
        latestMessage: {
          id: "00000000-0000-4000-8001-000000000001",
          sequence: "1",
          senderPlayerId: PEER,
          body: "private blocked preview",
          status: "sent",
          serverCreatedAt: "2026-07-15T18:00:00.000Z"
        }
      }],
      nextCursor: null,
      reset: true
    });
    store.openPeer({ playerId: PEER, displayName: "Atlas Friend", online: true });
    store.applyMessagePage({
      conversationId: CONVERSATION,
      messages: [directMessage("1")],
      hasOlder: false,
      reset: true
    });

    render(<DirectMessagesPanel {...props(store)} />);

    expect(screen.getAllByText("Messages hidden")).toHaveLength(2);
    expect(screen.getByText("You blocked Atlas Friend. Unblock this player to resume messaging.")).toBeTruthy();
    expect(screen.queryByText("private blocked preview")).toBeNull();
    expect(screen.queryByText("Message 1")).toBeNull();
    expect(screen.queryByPlaceholderText("Message Atlas Friend")).toBeNull();
  });

  it("exposes deterministic desktop and phone classes and uses phone back navigation", () => {
    const store = readyStore();
    const desktop = render(<DirectMessagesPanel {...props(store)} layout="desktop" minimized />);
    const desktopPanel = document.body.querySelector(".direct-messages-panel");
    expect(desktopPanel?.getAttribute("data-layout")).toBe("desktop");
    expect(desktopPanel?.classList.contains("direct-messages-panel--minimized")).toBe(true);
    desktop.unmount();
    window.history.replaceState({}, "");

    const onSelectPeer = vi.fn();
    const onReturnToGame = vi.fn();
    const phone = render(<DirectMessagesPanel
      {...props(store)}
      layout="phone"
      onSelectPeer={onSelectPeer}
      onReturnToGame={onReturnToGame}
    />);
    const phonePanel = phone.container.querySelector(".mobile-chat-overlay");
    expect(phonePanel?.getAttribute("data-layout")).toBe("phone");
    expect(phonePanel?.classList.contains("direct-messages-panel--phone-conversation")).toBe(true);
    expect(phone.container.querySelector(".direct-messages-content--phone-conversation")).toBeTruthy();
    const back = screen.getByRole("button", { name: "Back to Messages" });
    expect(back).toBeTruthy();
    expect(back.querySelector("svg")).not.toBeNull();
    expect(window.history.state).not.toHaveProperty("ashAtlasChatOverlay");
    expect(screen.getByRole("button", { name: "Return to Game" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to conversations" })).toBeNull();
    fireEvent.click(back);
    expect(onSelectPeer).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Return to Game" }));
    expect(onReturnToGame).toHaveBeenCalledTimes(1);
  });

  it("keeps personal conversation identity and contextual Back while omitting mute and block controls", () => {
    const store = readyStore();
    const expectCleanHeader = (container: HTMLElement): void => {
      const conversation = screen.getByRole("region", { name: "Conversation with Atlas Friend" });
      const header = conversation.querySelector(".direct-message-conversation-header");

      expect(header).toBeTruthy();
      expect(within(header as HTMLElement).getByText("Atlas Friend")).toBeTruthy();
      expect(within(header as HTMLElement).getByText("Online")).toBeTruthy();
      expect(within(header as HTMLElement).queryByText(/^(?:un)?mute$/i)).toBeNull();
      expect(within(header as HTMLElement).queryByText(/^(?:un)?block$/i)).toBeNull();
      expect(header?.querySelector("button, a, [tabindex]")).toBeNull();
      expect(container.querySelector(".direct-message-peer-actions")).toBeNull();
    };

    const desktop = render(<DirectMessagesPanel {...props(store)} layout="desktop" />);
    expectCleanHeader(document.body);
    expect(screen.getByText("No messages yet")).toBeTruthy();
    desktop.unmount();

    const onSelectPeer = vi.fn();
    const view = render(<DirectMessagesPanel {...props(store)} layout="phone" onSelectPeer={onSelectPeer} />);
    expectCleanHeader(view.container);
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(onSelectPeer).toHaveBeenCalledWith(null);
  });

  it("returns a conversation to Atlas Chats when it was opened there", () => {
    const store = readyStore();
    const onConversationBack = vi.fn();
    const onSelectPeer = vi.fn();
    render(<DirectMessagesPanel
      {...props(store)}
      layout="phone"
      conversationBackLabel="Back to Atlas Chats"
      onConversationBack={onConversationBack}
      onSelectPeer={onSelectPeer}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Back to Atlas Chats" }));
    expect(onConversationBack).toHaveBeenCalledOnce();
    expect(onSelectPeer).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Return to Game" })).toBeTruthy();
  });

  it("renders the phone conversation list in the authoritative destination shell", () => {
    const store = readyStore();
    store.selectPeer(null);
    const onClose = vi.fn();
    const onReturnToGame = vi.fn();
    render(<DirectMessagesPanel
      {...props(store)}
      layout="phone"
      onClose={onClose}
      onReturnToGame={onReturnToGame}
    />);
    const shell = screen.getByRole("dialog", { name: "Messages" });
    expect(shell.classList.contains("phone-menu-layer")).toBe(true);
    expect(shell.classList.contains("phone-destination-shell")).toBe(true);
    expect(screen.queryByText("Private conversations, requests, and notices")).toBeNull();
    expect(screen.queryByText("Priority Inbox")).toBeNull();
    expect(screen.queryByText("Personal Messages")).toBeNull();
    expect(screen.queryByText("Every conversation, request, package, and notice, ordered by what needs attention.")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Inbox" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Personal" }).getAttribute("aria-selected")).toBe("true");
    expect(shell.querySelector(".mobile-inbox-ledger")?.classList.contains("category-personal")).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect(shell.querySelector(".mobile-inbox-ledger")?.classList.contains("category-notifications")).toBe(true);
    expect(shell.classList.contains("mobile-chat-overlay")).toBe(false);
    expect(document.querySelector(".mobile-chat-overlay")).toBeNull();
    expect(document.querySelector(".mobile-chat-protection")).toBeNull();
    expect(Array.from(shell.children, ({ className }) => className)).toEqual([
      "phone-menu-header phone-menu-header--ledger",
      "phone-destination-body direct-messages-phone-list-body",
      "phone-menu-footer"
    ]);
    const footer = shell.querySelector(".phone-menu-footer") as HTMLElement;
    expect(within(footer).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "Back to Game Menu",
      "Return to Game"
    ]);
    expect(screen.queryByText("Courier Ledger")).toBeNull();
    expect(screen.queryByText("Live")).toBeNull();
    fireEvent.click(within(footer).getByRole("button", { name: "Back to Game Menu" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(footer).getByRole("button", { name: "Return to Game" }));
    expect(onReturnToGame).toHaveBeenCalledTimes(1);
    expect(shell.querySelector(".direct-messages-titlebar")).toBeNull();
    expect(shell.querySelector(".direct-message-conversation-header")).toBeNull();
  });

  it("returns from a conversation to gameplay and reopens at the Messages root", () => {
    const store = readyStore();
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      const [, setRevision] = useState(0);
      const selectPeer = (peerId: string | null): void => {
        store.selectPeer(peerId);
        setRevision((current) => current + 1);
      };
      return <>
        {!open ? <button type="button" onClick={() => setOpen(true)}>Open Messages</button> : null}
        <DirectMessagesPanel
          {...props(store)}
          open={open}
          layout="phone"
          snapshot={store.getSnapshot()}
          onSelectPeer={selectPeer}
          onReturnToGame={() => {
            store.selectPeer(null);
            setOpen(false);
            setRevision((current) => current + 1);
          }}
        />
      </>;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    fireEvent.click(screen.getByRole("tab", { name: /Personal/ }));
    fireEvent.click(screen.getByRole("button", { name: /Atlas Friend/ }));
    expect(screen.getByRole("region", { name: "Conversation with Atlas Friend" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Return to Game" }));
    expect(screen.queryByRole("dialog", { name: "Messages" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Messages" }));
    expect(screen.getByRole("dialog", { name: "Messages" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Personal" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("region", { name: "Conversation with Atlas Friend" })).toBeNull();
  });

  it("uses the destination body and conversation rows as the phone-list height and scroll chain", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/ui/DirectMessagesPanel.css"), "utf8");
    expect(styles).toMatch(/\.direct-messages-panel--phone\s*\{[^}]*width: 100%;[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow: hidden;/s);
    expect(styles).not.toContain("direct-messages-panel--phone-list-shell");
    expect(styles).toMatch(/\.direct-messages-phone-list-body\s*\{[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow: hidden;/s);
    expect(styles).toMatch(/\.direct-messages-phone-list-body > \.direct-message-conversation-list\s*\{[^}]*height: 100%;[^}]*min-height: 0;/s);
    expect(styles).toMatch(/\.direct-message-conversation-list\s*\{[^}]*min-height: 0;[^}]*display: grid;[^}]*grid-template-rows: minmax\(0, 1fr\) auto;/s);
    expect(styles).toMatch(/\.direct-message-conversation-rows\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/s);
    expect(styles).toMatch(/\.direct-messages-panel--phone-conversation \.direct-messages-content--phone-conversation,[\s\S]*?\.direct-message-conversation\s*\{[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow: hidden;/s);
    const store = readyStore();
    const view = render(<DirectMessagesPanel {...props(store)} layout="phone" />);
    expect(view.container.querySelector(".direct-messages-panel--phone-conversation")?.classList.contains("phone-destination-shell")).toBe(false);
    const history = view.container.querySelector(".direct-message-history")!;
    const composer = view.container.querySelector(".direct-message-composer")!;
    expect(history.querySelector(":scope > .direct-message-history-content")).toBeTruthy();
    expect(history.parentElement).toBe(composer.parentElement);
  });

  it("bottom-aligns short histories without requiring scrollTop and keeps optimistic sends in that surface", () => {
    const frames = installFrameHarness();
    const store = readyStore();
    store.applyMessagePage({
      conversationId: CONVERSATION,
      messages: [directMessage("1")],
      hasOlder: false,
      reset: true
    });
    const panel = () => <DirectMessagesPanel {...props(store)} layout="phone" />;
    const view = render(panel());
    const history = view.container.querySelector<HTMLElement>(".direct-message-history")!;
    const content = history.querySelector<HTMLElement>(".direct-message-history-content")!;
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 200 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 200 });
    act(() => frames.flushAll());

    expect(history.scrollTop).toBe(0);
    expect(content.querySelectorAll(".direct-message-bubble")).toHaveLength(1);

    store.applyMessagePage({
      conversationId: CONVERSATION,
      messages: [directMessage("1"), directMessage("2")],
      hasOlder: false,
      reset: true
    });
    view.rerender(panel());
    expect(content.querySelectorAll(".direct-message-bubble")).toHaveLength(2);

    store.startOptimisticSend("Newest optimistic message", "00000000-0000-4000-8000-000000000101");
    view.rerender(panel());
    expect(content.textContent).toContain("Newest optimistic message");

    const styles = readFileSync(resolve(process.cwd(), "src/ui/DirectMessagesPanel.css"), "utf8");
    expect(styles).toMatch(/\.direct-message-history-content\s*\{[^}]*min-height: 100%;[^}]*display: flex;[^}]*flex-direction: column;[^}]*justify-content: flex-end;/s);
    expect(styles).toMatch(/\.direct-message-history\s*\{[^}]*padding: 0;[^}]*overflow-y: auto;[^}]*overflow-x: hidden;[^}]*touch-action: pan-y;/s);
    expect(styles).not.toContain("-webkit-overflow-scrolling");
    expect(styles).toMatch(/\.direct-messages-panel--phone-conversation \.direct-message-history\s*\{[^}]*overscroll-behavior-y: none;[^}]*scrollbar-width: none;/s);
    expect(styles).toMatch(/\.direct-messages-panel--phone \.direct-message-history::-webkit-scrollbar\s*\{[^}]*width: 0;[^}]*height: 0;[^}]*display: none;/s);
  });

  it("keeps the phone list outside iOS standalone chat protection without search controls", () => {
    mockIosStandalone();
    const store = readyStore();
    store.selectPeer(null);
    render(<DirectMessagesPanel {...props(store)} layout="phone" />);

    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
    expect(document.documentElement.dataset.mobileChatProtected).toBeUndefined();
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
    expect(document.documentElement.dataset.mobileChatProtected).toBeUndefined();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("mounts protection only for a conversation and keeps the opaque list under its safe exit", () => {
    mockIosStandalone();
    const frames = installFrameHarness();
    const store = readyStore();
    store.selectPeer(null);
    const panel = () => <DirectMessagesPanel {...props(store)} layout="phone" />;
    const view = render(panel());
    expect(view.container.querySelector(".mobile-chat-overlay")).toBeNull();

    store.openPeer({ playerId: PEER, displayName: "Atlas Friend", online: true });
    view.rerender(panel());
    expect(view.container.querySelector(".mobile-chat-overlay")).toBeTruthy();
    expect(view.container.querySelector(".mobile-chat-protection")).toBeTruthy();
    expect(document.documentElement.dataset.mobileChatProtected).toBe("true");
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();

    store.selectPeer(null);
    view.rerender(panel());
    expect(screen.getByRole("dialog", { name: "Messages" })).toBeTruthy();
    expect(view.container.querySelector(".mobile-chat-overlay")).toBeTruthy();
    act(() => frames.flushAll());
    expect(view.container.querySelector(".mobile-chat-overlay")).toBeNull();
    expect(view.container.querySelector(".mobile-chat-protection")).toBeNull();
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
  });

  it("focuses the DM draft before ensuring the root lock without preventing the tap", () => {
    mockIosStandalone();
    const store = readyStore();
    render(<DirectMessagesPanel {...props(store)} layout="phone" />);
    const draft = screen.getByPlaceholderText("Message Atlas Friend") as HTMLTextAreaElement;
    const focus = vi.spyOn(draft, "focus");

    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
    expect(fireEvent.pointerDown(draft)).toBe(true);
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBe("true");
    expect(focus).toHaveBeenCalledWith();
    expect(document.activeElement).toBe(draft);
  });

  it("dismisses the focused draft when native history returns to the conversation list", () => {
    mockIosStandalone();
    const store = readyStore();
    const panel = () => <DirectMessagesPanel {...props(store)} layout="phone" />;
    const view = render(panel());
    const draft = screen.getByPlaceholderText("Message Atlas Friend") as HTMLTextAreaElement;
    fireEvent.pointerDown(draft);
    expect(document.activeElement).toBe(draft);

    store.selectPeer(null);
    view.rerender(panel());

    expect(document.activeElement).not.toBe(draft);
    expect(screen.getByRole("dialog", { name: "Messages" })).toBeTruthy();
  });

  it("sends a normalized plain-text draft", () => {
    const store = readyStore();
    const onSend = vi.fn(() => true);
    render(<DirectMessagesPanel {...props(store)} onSend={onSend} />);
    const composer = screen.getByPlaceholderText("Message Atlas Friend");
    fireEvent.change(composer, { target: { value: " hello\r\nworld " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("hello\nworld");
    expect((composer as HTMLTextAreaElement).value).toBe("");
  });

  it("uses the shared opaque overlay and prevents gameplay pointer leakage", () => {
    const store = readyStore();
    const gameplayPointerDown = vi.fn();
    const view = render(
      <div onPointerDown={gameplayPointerDown}>
        <DirectMessagesPanel {...props(store)} layout="phone" />
      </div>
    );
    const panel = view.container.querySelector(".mobile-chat-overlay")!;
    expect(panel.classList.contains("mobile-chat-overlay")).toBe(true);
    expect(panel.querySelector("[data-mobile-chat-dock-layout]")).toBeTruthy();
    expect(panel.getAttribute("data-mobile-chat-type")).toBe("direct");
    expect(panel.querySelector("[data-mobile-chat-composer]")).toBeTruthy();
    expect(panel.querySelector("[data-mobile-chat-message-region]")).toBeTruthy();
    fireEvent.pointerDown(screen.getByPlaceholderText("Message Atlas Friend"));
    expect(gameplayPointerDown).not.toHaveBeenCalled();
  });

  it("preserves an unsent draft across a close and reopen", () => {
    const store = readyStore();
    const panel = (open: boolean) => (
      <DirectMessagesPanel {...props(store)} open={open} layout="phone" />
    );
    const view = render(panel(true));
    fireEvent.change(screen.getByPlaceholderText("Message Atlas Friend"), {
      target: { value: "keep this direct draft" }
    });

    view.rerender(panel(false));
    view.rerender(panel(true));

    expect((screen.getByPlaceholderText("Message Atlas Friend") as HTMLTextAreaElement).value)
      .toBe("keep this direct draft");
  });

  it("opens at the exact bottom, pauses for reading, counts unique appends, and jumps to newest", () => {
    const frames = installFrameHarness();
    const store = readyStore();
    store.applyMessagePage({
      conversationId: CONVERSATION,
      messages: [directMessage("1"), directMessage("2")],
      hasOlder: true,
      reset: true
    });
    const panel = () => <DirectMessagesPanel {...props(store)} />;
    const view = render(panel());
    const history = document.body.querySelector<HTMLElement>(".direct-message-history")!;
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 200 });
    act(() => frames.flushAll());
    expect(history.scrollTop).toBe(400);
    expect(history.scrollHeight - history.scrollTop - history.clientHeight).toBe(0);

    history.scrollTop = 100;
    fireEvent.scroll(history);
    store.applyMessagePage({
      conversationId: CONVERSATION,
      messages: [directMessage("3"), directMessage("4"), directMessage("5")],
      hasOlder: true,
      reset: false
    });
    view.rerender(panel());
    act(() => frames.flushAll());
    expect(history.scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "↓ 3 new messages" })).toBeTruthy();

    store.applyDeliveryCursor(CONVERSATION, "5");
    store.applyPeerReadCursor(CONVERSATION, "5");
    store.acknowledgeMessage(directMessage("6", directMessage("5").clientMessageId));
    view.rerender(panel());
    expect(screen.getByRole("button", { name: "↓ 3 new messages" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "↓ 3 new messages" }));
    act(() => frames.flushAll());
    expect(screen.queryByRole("button", { name: /new message/ })).toBeNull();
    expect(history.scrollTop).toBe(400);
  });

  it("preserves a prepended-history anchor without creating unseen messages", () => {
    const frames = installFrameHarness();
    const store = readyStore();
    store.applyMessagePage({
      conversationId: CONVERSATION,
      messages: [directMessage("3"), directMessage("4")],
      hasOlder: true,
      reset: true
    });
    const onLoadOlder = vi.fn();
    const panel = () => <DirectMessagesPanel {...props(store)} onLoadOlder={onLoadOlder} />;
    const view = render(panel());
    const history = document.body.querySelector<HTMLElement>(".direct-message-history")!;
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 200 });
    act(() => frames.flushAll());
    history.scrollTop = 100;
    fireEvent.scroll(history);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    expect(onLoadOlder).toHaveBeenCalledWith(CONVERSATION, "3");

    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 800 });
    store.applyMessagePage({
      conversationId: CONVERSATION,
      messages: [directMessage("1"), directMessage("2")],
      hasOlder: false,
      reset: false
    });
    view.rerender(panel());
    act(() => frames.flushAll());
    expect(history.scrollTop).toBe(300);
    expect(screen.queryByRole("button", { name: /new message/ })).toBeNull();
  });

  it("pins committed and settled keyboard layouts only while following", () => {
    const frames = installFrameHarness();
    const store = readyStore();
    store.applyMessagePage({
      conversationId: CONVERSATION,
      messages: [directMessage("1")],
      hasOlder: false,
      reset: true
    });
    render(<DirectMessagesPanel {...props(store)} />);
    const history = document.body.querySelector<HTMLElement>(".direct-message-history")!;
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 150 });
    act(() => frames.flushAll());

    history.scrollTop = 0;
    window.dispatchEvent(new Event(MOBILE_KEYBOARD_COMMITTED_EVENT));
    act(() => frames.flushAll());
    expect(history.scrollTop).toBe(350);
    history.scrollTop = 75;
    fireEvent.scroll(history);
    window.dispatchEvent(new Event(MOBILE_KEYBOARD_SETTLED_EVENT));
    act(() => frames.flushAll());
    expect(history.scrollTop).toBe(75);
  });

  it("keeps focused Send presses on the textarea, sends once, and resets follow state for a new peer", () => {
    const frames = installFrameHarness();
    const store = readyStore();
    const onSend = vi.fn(() => true);
    const panel = () => <DirectMessagesPanel {...props(store)} onSend={onSend} />;
    const view = render(panel());
    const textarea = screen.getByPlaceholderText("Message Atlas Friend") as HTMLTextAreaElement;
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.change(textarea, { target: { value: "one direct message" } });
    textarea.focus();
    expect(fireEvent.pointerDown(send)).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("");

    store.openPeer({ playerId: SECOND_PEER, displayName: "Second Friend", online: true });
    view.rerender(panel());
    act(() => frames.flushAll());
    expect(screen.getByPlaceholderText("Message Second Friend")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /new message/ })).toBeNull();
  });
});

function readyStore(): DirectMessageStore {
  const store = new DirectMessageStore({ ownPlayerId: SELF, createClientMessageId: () => "00000000-0000-4000-8000-000000000100" });
  store.applyConversationPage({ conversations: [summary()], nextCursor: null, reset: true });
  store.openPeer({ playerId: PEER, displayName: "Atlas Friend", online: true });
  return store;
}

function props(store: DirectMessageStore): DirectMessagesPanelProps {
  return {
    open: true,
    minimized: false,
    layout: "desktop",
    snapshot: store.getSnapshot(),
    connectionStatus: "online",
    onClose: vi.fn(),
    onReturnToGame: vi.fn(),
    onMinimizedChange: vi.fn(),
    onSelectPeer: vi.fn(),
    onSend: vi.fn(() => true),
    onRetry: vi.fn(),
    onLoadOlder: vi.fn()
  };
}

function summary(): DirectMessageConversationSummary {
  return {
    id: CONVERSATION,
    peer: { playerId: PEER, displayName: "Atlas Friend", online: true },
    canSend: true,
    latestMessage: null,
    latestSequence: "0",
    lastReadSequence: "0",
    deliveredThroughSequence: "0",
    unreadCount: 0,
    muted: false,
    updatedAt: "2026-07-15T18:00:00.000Z"
  };
}

function directMessage(
  sequence: string,
  clientMessageId = `00000000-0000-4000-8000-${sequence.padStart(12, "0")}`
): DirectMessage {
  return {
    id: `00000000-0000-4000-8001-${sequence.padStart(12, "0")}`,
    conversationId: CONVERSATION,
    sequence,
    senderPlayerId: SELF,
    clientMessageId,
    body: `Message ${sequence}`,
    status: "sent",
    serverCreatedAt: "2026-07-15T18:00:00.000Z"
  };
}

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

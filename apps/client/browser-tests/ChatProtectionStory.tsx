import {
  CHAT_LOCAL_CHANNEL_KEY,
  type ChatChannel,
  type ChatReadState
} from "@ash-atlas/shared";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import "../src/styles.css";
import { ChatStore } from "../src/chat/chatStore.js";
import {
  getMobileChatProtectionActive,
  sanitizeTransientMobileChatState,
  startMobileKeyboardDocking,
  subscribeMobileKeyboardDocking
} from "../src/mobileKeyboardDocking.js";
import { ChatPanel } from "../src/ui/ChatPanel.js";
import { ChatTopBar } from "../src/ui/ChatTopBar.js";

const GENERAL = "public:general";

export function ChatProtectionStory({
  zeroSized = false,
  keyboardModel,
  unreadMessageCount,
  messageAttentionRevision = 0,
  uiProfile = "phone"
}: {
  zeroSized?: boolean;
  keyboardModel?: "visual-only" | "layout-and-visual";
  unreadMessageCount?: number;
  messageAttentionRevision?: number;
  uiProfile?: "phone" | "tablet" | "desktop";
}): React.JSX.Element {
  const store = useMemo(createReadyStore, []);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setSelectionRevision] = useState(0);
  const chatProtected = useSyncExternalStore(
    subscribeMobileKeyboardDocking,
    getMobileChatProtectionActive
  );

  useMemo(() => {
    sanitizeTransientMobileChatState();
    if (uiProfile === "desktop") delete document.documentElement.dataset.uiProfile;
    else document.documentElement.dataset.uiProfile = uiProfile;
    document.documentElement.dataset.layoutMode = "wide";
    if (keyboardModel) installKeyboardViewportHarness(keyboardModel);
  }, []);
  useEffect(() => startMobileKeyboardDocking(), []);

  return (
    <main className={zeroSized ? "chat-protection-story force-zero-chat" : "chat-protection-story"}>
      <div
        className="phone-hud"
        data-testid="phone-hud"
        data-chat-suppressed={String(chatProtected)}
        inert={chatProtected ? true : undefined}
        aria-hidden={chatProtected}
      >
        Gameplay HUD
      </div>
      <ChatTopBar
        snapshot={store.getSnapshot()}
        open={open}
        {...(unreadMessageCount === undefined
          ? {}
          : { unreadMessageCount, onOpenMessages: () => undefined })}
        messageAttentionRevision={messageAttentionRevision}
        onOpen={() => {
          setError(null);
          setOpen(true);
        }}
        onRetryBootstrap={() => undefined}
        onSelectChannel={(key) => {
          store.selectChannel(key);
          setSelectionRevision((value) => value + 1);
        }}
      />
      {error ? <div role="alert">{error}</div> : null}
      <ChatPanel
        open={open}
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        onSelectChannel={(key) => store.selectChannel(key)}
        onSend={() => true}
        onRetry={() => undefined}
        onLoadOlder={() => undefined}
        onProtectionFailure={() => {
          setOpen(false);
          setError("Chat could not open safely. Gameplay has been restored.");
        }}
        onClose={() => setOpen(false)}
      />
      <style>{`
        .chat-protection-story { position: fixed; inset: 0; }
        .force-zero-chat .mobile-chat-overlay { width: 0 !important; height: 0 !important; }
      `}</style>
    </main>
  );
}

type KeyboardViewportHarnessWindow = Window & {
  __setChatKeyboardViewport?: (
    height: number,
    offsetTop?: number,
    notify?: boolean
  ) => void;
};

function installKeyboardViewportHarness(
  model: "visual-only" | "layout-and-visual"
): void {
  const listeners = new Map<string, Set<EventListener>>();
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetTop: 0,
    offsetLeft: 0,
    addEventListener(name: string, listener: EventListener): void {
      const entries = listeners.get(name) ?? new Set<EventListener>();
      entries.add(listener);
      listeners.set(name, entries);
    },
    removeEventListener(name: string, listener: EventListener): void {
      listeners.get(name)?.delete(listener);
    }
  };
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport
  });
  (window as KeyboardViewportHarnessWindow).__setChatKeyboardViewport = (
    height,
    offsetTop = 0,
    notify = true
  ) => {
    viewport.height = height;
    viewport.offsetTop = offsetTop;
    const overlay = document.querySelector<HTMLElement>(".mobile-chat-overlay");
    if (overlay) {
      overlay.style.height = model === "layout-and-visual" ? `${height + offsetTop}px` : "";
    }
    if (!notify) return;
    for (const listener of listeners.get("resize") ?? []) {
      listener(new Event("resize"));
    }
  };
}

function createReadyStore(): ChatStore {
  const store = new ChatStore({
    ownPlayerId: "self",
    storage: { getItem: () => null, setItem: () => undefined }
  });
  const channels = [
    channel(CHAT_LOCAL_CHANNEL_KEY, "Local", "local", "live-session"),
    channel(GENERAL, "General", "public", "durable")
  ];
  store.applyChannelsSnapshot({
    channels,
    readStates: channels.map((item) => readState(item.key)),
    previews: [],
    selectedChannelKey: GENERAL
  });
  return store;
}

function channel(
  key: string,
  displayName: string,
  type: ChatChannel["type"],
  historyRetentionPolicy: ChatChannel["historyRetentionPolicy"]
): ChatChannel {
  return {
    id: `channel-${key}`,
    key,
    type,
    category: type === "local" ? "local" : key.split(":").at(-1) as "general" | "trading" | "hunting",
    displayName,
    visibilityPolicy: "authenticated",
    sendAccessPolicy: "authenticated",
    historyRetentionPolicy,
    rateLimitPolicy: "normal",
    moderationPolicy: "public-v1",
    active: true,
    latestSequence: 0,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

function readState(channelKey: string): ChatReadState {
  return {
    channelKey,
    lastReadSequence: 0,
    latestSequence: 0,
    unreadCount: 0,
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

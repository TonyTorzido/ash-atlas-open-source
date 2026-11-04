import type { DirectMessageConversationSummary, TravelInboxEntry } from "@ash-atlas/shared";
import { useLayoutEffect, useState } from "react";

import { DirectMessageStore } from "../src/directMessages/directMessageStore.js";
import "../src/styles.css";
import { DirectMessagesPanel } from "../src/ui/DirectMessagesPanel.js";
import { useMobileGameMenuNavigation } from "../src/useMobileGameMenuNavigation.js";

const SELF = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const CONVERSATION = "00000000-0000-4000-8000-000000000010";

export function MessagesNavigationStory(): React.JSX.Element {
  const [store] = useState(() => {
    const next = new DirectMessageStore({ ownPlayerId: SELF });
    next.applyConversationPage({ conversations: [conversation()], nextCursor: null, reset: true });
    return next;
  });
  const navigation = useMobileGameMenuNavigation(true);
  const [, setRevision] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [conversationBackTarget, setConversationBackTarget] = useState<"messages" | "atlas-chats">("messages");
  const [pendingPeerId, setPendingPeerId] = useState<string | null>(null);
  const renderStore = (): void => setRevision((current) => current + 1);
  const resetMessages = (): void => {
    store.selectPeer(null);
    store.setViewingPeer(null);
    renderStore();
  };

  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousProfile = root.dataset.uiProfile;
    root.dataset.uiProfile = "phone";
    return () => {
      if (previousProfile === undefined) delete root.dataset.uiProfile;
      else root.dataset.uiProfile = previousProfile;
    };
  }, []);

  useLayoutEffect(() => {
    if (
      navigation.view !== "messages" ||
      navigation.child !== null ||
      pendingPeerId === null
    ) return;
    navigation.openMessagePeer(pendingPeerId);
    setPendingPeerId(null);
  }, [navigation, pendingPeerId]);

  return (
    <main className="messages-navigation-story">
      {navigation.view !== "messages" ? (
        <section aria-label={navigation.view === "menu" ? "Game Menu" : "Gameplay"}>
          <h1>{navigation.view === "menu" ? "Game Menu" : "Gameplay"}</h1>
          {navigation.view === "gameplay" ? (
            <>
              <button type="button" onClick={navigation.openMenu}>Open Game Menu</button>
              <button type="button" onClick={() => setChatOpen(true)}>Open Atlas Chats</button>
              {chatOpen ? (
                <aside aria-label="Atlas Chats">
                  <button
                    type="button"
                    onClick={() => {
                      setChatOpen(false);
                      setConversationBackTarget("atlas-chats");
                      store.openPeer({
                        playerId: PEER,
                        displayName: "Atlas Friend",
                        online: true
                      });
                      setPendingPeerId(PEER);
                      navigation.openDestination("messages");
                      renderStore();
                    }}
                  >
                    Message Atlas Friend
                  </button>
                </aside>
              ) : null}
            </>
          ) : (
            <>
              <button type="button" onClick={() => navigation.openDestination("messages")}>Open Messages</button>
              <button type="button" onClick={navigation.back}>Back</button>
            </>
          )}
        </section>
      ) : null}
      <DirectMessagesPanel
        open={navigation.view === "messages"}
        minimized={false}
        layout="phone"
        snapshot={store.getSnapshot()}
        connectionStatus="online"
        travelEntries={[notification()]}
        selectedNotificationKey={navigation.messageNotificationKey}
        conversationBackLabel={conversationBackTarget === "atlas-chats"
          ? "Back to Atlas Chats"
          : "Back to Messages"}
        onConversationBack={() => {
          if (conversationBackTarget === "atlas-chats") {
            resetMessages();
            setConversationBackTarget("messages");
            navigation.close();
            setChatOpen(true);
            return;
          }
          store.selectPeer(null);
          navigation.backMessageDetail();
          renderStore();
        }}
        onClose={() => {
          if (navigation.child?.destination === "messages") {
            if (navigation.child.screen === "peer") store.selectPeer(null);
            navigation.backMessageDetail();
          } else {
            resetMessages();
            navigation.back();
          }
          renderStore();
        }}
        onReturnToGame={() => {
          resetMessages();
          setConversationBackTarget("messages");
          setChatOpen(false);
          navigation.close();
        }}
        onMinimizedChange={() => undefined}
        onSelectPeer={(peerId) => {
          store.selectPeer(peerId);
          if (peerId === null) navigation.backMessageDetail();
          else {
            setConversationBackTarget("messages");
            navigation.openMessagePeer(peerId);
          }
          renderStore();
        }}
        onSelectNotification={(entryKey) => {
          if (entryKey === null) navigation.backMessageDetail();
          else navigation.openMessageNotification(entryKey);
        }}
        onSend={() => true}
        onRetry={() => undefined}
        onLoadOlder={() => undefined}
        onMarkInboxRead={async () => true}
      />
    </main>
  );
}

export function FloatingMessagesStory({ layout = "desktop" }: { layout?: "desktop" | "phone" }): React.JSX.Element {
  const [store] = useState(() => {
    const next = new DirectMessageStore({ ownPlayerId: SELF });
    next.applyConversationPage({ conversations: [conversation()], nextCursor: null, reset: true });
    return next;
  });
  const [open, setOpen] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [, setRevision] = useState(0);
  return <DirectMessagesPanel open={open} minimized={minimized} layout={layout}
    snapshot={store.getSnapshot()} connectionStatus="online"
    onClose={() => setOpen(false)} onReturnToGame={() => setOpen(false)} onMinimizedChange={setMinimized}
    onSelectPeer={(peerId) => { store.selectPeer(peerId); setRevision((value) => value + 1); }}
    onSend={() => true} onRetry={() => undefined} onLoadOlder={() => undefined} />;
}

function conversation(): DirectMessageConversationSummary {
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
    updatedAt: "2026-07-29T00:00:00.000Z"
  };
}

function notification(): TravelInboxEntry {
  return {
    entryId: "travel-declined",
    inviteId: "travel-invite",
    perspective: "recipient",
    counterpartPlayerId: "traveler",
    counterpartName: "Traveler",
    message: "Travel to the active flag.",
    status: "declined",
    invalidationReason: null,
    sourceType: "flag",
    sourceId: "flag-1",
    createdAt: "2026-07-29T00:00:00.000Z",
    expiresAt: "2026-07-30T00:00:00.000Z",
    respondedAt: "2026-07-29T00:01:00.000Z",
  };
}

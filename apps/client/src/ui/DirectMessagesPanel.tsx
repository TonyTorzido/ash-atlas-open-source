import type {
  GameInboxNotice,
  InboxReadTarget,
  KingdomInvitationSnapshot,
  PartyInviteSnapshot,
  PlayerPackageSnapshot,
  SocialAction,
  SocialInboxEntry,
  TravelInboxEntry
} from "@ash-atlas/shared";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  DIRECT_MESSAGE_BODY_MAX_LENGTH,
  type DirectConversationView,
  type DirectMessageStoreSnapshot,
  type DirectMessageView
} from "../directMessages/directMessageStore.js";
import { CommunitySafetyApi } from "../community/communitySafetyClient.js";
import {
  dismissMobileKeyboard,
  getMobileKeyboardDockingSnapshot,
  handleMobileChatInputFocus,
  isIosStandaloneMobileChat,
  MOBILE_KEYBOARD_COMMITTED_EVENT,
  MOBILE_KEYBOARD_SETTLED_EVENT,
  prepareMobileChatInputPointerDown
} from "../mobileKeyboardDocking.js";
import { ResponsiveChatOverlay as MobileChatOverlay, DesktopWindowTitle } from "./ResponsiveChatOverlay.js";
import {
  buildMobileInboxEntries,
  summarizeMobileInboxUnread,
  type MobileInboxCategory,
  type MobileInboxEntry
} from "../mobileInbox.js";
import {
  createBottomPinScheduler,
  installTouchScrollBoundaryGuard,
  preserveFocusedTextEntryOnPointerDown,
  setProgrammaticScrollTop
} from "./chatScroll.js";
import "./DirectMessagesPanel.css";
import { GameAppEmptyState, GameAppTabs } from "./GameAppShell.js";
import { GameMessageBox } from "./GameMessageBox.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { StatGlyph } from "./MenuDestinationGlyph.js";
import { PhoneMenuDestinationShell, PhoneMenuFooter } from "./PhoneMenuDestinationShell.js";

const DIRECT_MESSAGE_BOTTOM_THRESHOLD_PX = 32;

export type DirectMessagesPanelProps = {
  open: boolean;
  minimized: boolean;
  layout: "desktop" | "phone";
  snapshot: DirectMessageStoreSnapshot;
  connectionStatus: "online" | "connecting" | "offline";
  loadingOlder?: boolean;
  loadingConversations?: boolean;
  travelEntries?: readonly TravelInboxEntry[];
  partyInvites?: readonly PartyInviteSnapshot[];
  partyPlayerNames?: Readonly<Record<string, string>>;
  kingdomInvitations?: readonly KingdomInvitationSnapshot[];
  playerPackages?: readonly PlayerPackageSnapshot[];
  socialEntries?: readonly SocialInboxEntry[];
  gameNotices?: readonly GameInboxNotice[];
  ownPlayerId?: string;
  hasKingdomMembership?: boolean;
  readReceipts?: Readonly<Record<string, string>>;
  selectedNotificationKey?: string | null;
  navigationIntent?: Readonly<{ revision: number; category: MobileInboxCategory }> | null;
  conversationBackLabel?: "Back to Messages" | "Back to Atlas Chats";
  onConversationBack?(): void;
  onClose(): void;
  onReturnToGame(): void;
  onMinimizedChange(minimized: boolean): void;
  onSelectPeer(peerId: string | null): void;
  onSelectNotification?(entryKey: string | null): void;
  onSend(body: string): boolean;
  onRetry(clientMessageId: string): void;
  onLoadOlder(conversationId: string, beforeSequence: string): void;
  onLoadMoreConversations?(): void;
  onSoundsEnabledChange?(enabled: boolean): void;
  onReadDirectMessages?(targets: readonly Readonly<{ conversationId: string; throughSequence: string }>[]): Promise<boolean>;
  onMarkInboxRead?(entries: readonly InboxReadTarget[]): Promise<boolean>;
  onInboxActionConfirmed?(entryKey: string, previousRevision: string): void;
  onAcceptTravelInvite?(inviteId: string): boolean | Promise<boolean>;
  onDeclineTravelInvite?(inviteId: string): boolean | Promise<boolean>;
  onCancelTravelInvite?(inviteId: string): boolean | Promise<boolean>;
  onAcceptPartyInvite?(invitationId: string): boolean | Promise<boolean>;
  onForwardPartyInvite?(invitationId: string): boolean | Promise<boolean>;
  forwardPartyInvitesToLeader?: boolean;
  onDeclinePartyInvite?(invitationId: string): boolean | Promise<boolean>;
  onCancelPartyInvite?(invitationId: string): boolean | Promise<boolean>;
  onRespondKingdomInvitation?(invitationId: string, response: "accept" | "decline"): boolean | Promise<boolean>;
  onCancelKingdomInvitation?(invitationId: string): boolean | Promise<boolean>;
  onClaimPlayerPackage?(packageId: string, expectedRevision: string): Promise<string>;
  onRespondFriendRequest?(playerId: string, action: Extract<SocialAction, "accept_friend_request" | "decline_friend_request">): Promise<boolean>;
  onOpenPlayerProfile?(playerId: string): void;
  onOpenPeerActions?(
    playerId: string,
    displayName: string,
    anchorRect: { left: number; right: number; top: number; bottom: number }
  ): void;
  partyInviteRequiresMergeReview?: boolean;
  serverHttpBase?: string;
  csrfToken?: string;
};

export function DirectMessagesPanel({
  open,
  minimized,
  layout,
  snapshot,
  connectionStatus,
  loadingOlder = false,
  loadingConversations = false,
  travelEntries = [],
  partyInvites = [],
  partyPlayerNames = {},
  kingdomInvitations = [],
  playerPackages = [],
  socialEntries = [],
  gameNotices = [],
  ownPlayerId = "",
  hasKingdomMembership = false,
  readReceipts = {},
  selectedNotificationKey = null,
  navigationIntent = null,
  conversationBackLabel = "Back to Messages",
  onConversationBack,
  onClose,
  onReturnToGame,
  onMinimizedChange,
  onSelectPeer,
  onSelectNotification,
  onSend,
  onRetry,
  onLoadOlder,
  onLoadMoreConversations,
  onSoundsEnabledChange,
  onReadDirectMessages,
  onMarkInboxRead,
  onInboxActionConfirmed,
  onAcceptTravelInvite,
  onDeclineTravelInvite,
  onCancelTravelInvite,
  onAcceptPartyInvite,
  onForwardPartyInvite,
  forwardPartyInvitesToLeader = false,
  onDeclinePartyInvite,
  onCancelPartyInvite,
  onRespondKingdomInvitation,
  onCancelKingdomInvitation,
  onClaimPlayerPackage,
  onRespondFriendRequest,
  onOpenPlayerProfile,
  onOpenPeerActions,
  partyInviteRequiresMergeReview = false,
  serverHttpBase,
  csrfToken
}: DirectMessagesPanelProps): React.JSX.Element | null {
  const [draft, setDraft] = useState("");
  const [unseenMessageCount, setUnseenMessageCount] = useState(0);
  const [inboxCategory, setInboxCategory] = useState<MobileInboxCategory>("personal");
  const [inboxNow, setInboxNow] = useState(() => Date.now());
  const [selectedDesktopInboxKey, setSelectedDesktopInboxKey] = useState<string | null>(null);
  const communitySafety = useMemo(
    () => serverHttpBase && csrfToken ? new CommunitySafetyApi(serverHttpBase, csrfToken) : null,
    [csrfToken, serverHttpBase]
  );
  const [termsStatus, setTermsStatus] = useState<{ version: string; accepted: boolean } | null>(null);
  const [termsLoading, setTermsLoading] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  useEffect(() => {
    if (!communitySafety) return;
    let active = true;
    setTermsLoading(true);
    void communitySafety.terms().then((status) => {
      if (active) {
        setTermsStatus(status);
        setTermsError(null);
      }
    }).catch((error: unknown) => {
      if (active) setTermsError(error instanceof Error ? error.message : "Community Rules are unavailable.");
    }).finally(() => {
      if (active) setTermsLoading(false);
    });
    return () => { active = false; };
  }, [communitySafety]);
  const acceptTerms = async (): Promise<void> => {
    if (!communitySafety || !termsStatus || termsLoading) return;
    setTermsLoading(true);
    setTermsError(null);
    try {
      setTermsStatus(await communitySafety.acceptTerms(termsStatus.version));
    } catch (error) {
      setTermsError(error instanceof Error ? error.message : "Community Rules could not be accepted.");
    } finally {
      setTermsLoading(false);
    }
  };
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prependHeightRef = useRef<number | null>(null);
  const followLatestRef = useRef(true);
  const programmaticScrollRef = useRef(0);
  const selectedPeerIdRef = useRef<string | null>(null);
  const knownMessageIdsRef = useRef(new Set<string>());
  const previousMessageIdsRef = useRef<readonly string[]>([]);
  const bottomPinScheduler = useMemo(
    () =>
      createBottomPinScheduler(
        () => listRef.current,
        () => followLatestRef.current,
        programmaticScrollRef
      ),
    []
  );
  const selected = snapshot.selectedConversation;
  const phoneConversationOpen = layout === "phone" && selected !== null;
  const previousPhoneConversationOpenRef = useRef(phoneConversationOpen);
  const mobileInboxEntries = useMemo(() => buildMobileInboxEntries({
    conversations: snapshot.conversations,
    travelEntries,
    partyInvites,
    partyPlayerNames,
    kingdomInvitations,
    playerPackages,
    socialEntries,
    gameNotices,
    ownPlayerId,
    hasKingdomMembership,
    readReceipts
  }, inboxNow), [
    hasKingdomMembership,
    inboxNow,
    kingdomInvitations,
    playerPackages,
    ownPlayerId,
    partyInvites,
    partyPlayerNames,
    readReceipts,
    snapshot.conversations,
    socialEntries,
    gameNotices,
    travelEntries
  ]);
  const unreadSummary = useMemo(
    () => summarizeMobileInboxUnread(mobileInboxEntries),
    [mobileInboxEntries]
  );
  const selectedDesktopInboxEntry = selectedDesktopInboxKey
    ? mobileInboxEntries.find((entry) => entry.key === selectedDesktopInboxKey) ?? null
    : null;
  const phoneNotificationOpen = layout === "phone" && selectedNotificationKey !== null;
  useEffect(() => {
    if (layout === "desktop" && selectedNotificationKey) setSelectedDesktopInboxKey(selectedNotificationKey);
  }, [layout, selectedNotificationKey]);

  useEffect(() => {
    if (!open || minimized || phoneConversationOpen) return;
    const timer = window.setInterval(() => setInboxNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [minimized, open, phoneConversationOpen]);

  useEffect(() => {
    if (open) return;
    setInboxCategory("personal");
    setSelectedDesktopInboxKey(null);
  }, [open]);

  useEffect(() => {
    if (!open || !navigationIntent) return;
    setInboxCategory(navigationIntent.category);
    setSelectedDesktopInboxKey(null);
  },[open,navigationIntent]);

  useEffect(() => {
    const wasOpen = previousPhoneConversationOpenRef.current;
    previousPhoneConversationOpenRef.current = phoneConversationOpen;
    if (layout === "phone" && wasOpen && !phoneConversationOpen) {
      dismissMobileKeyboard();
    }
  }, [layout, phoneConversationOpen]);

  useEffect(() => {
    const followKeyboardLayout = (): void => {
      if (open && !minimized && followLatestRef.current) bottomPinScheduler.schedule();
    };
    window.addEventListener(MOBILE_KEYBOARD_COMMITTED_EVENT, followKeyboardLayout);
    window.addEventListener(MOBILE_KEYBOARD_SETTLED_EVENT, followKeyboardLayout);
    return () => {
      window.removeEventListener(MOBILE_KEYBOARD_COMMITTED_EVENT, followKeyboardLayout);
      window.removeEventListener(MOBILE_KEYBOARD_SETTLED_EVENT, followKeyboardLayout);
    };
  }, [bottomPinScheduler, minimized, open]);

  useEffect(() => {
    const list = listRef.current;
    if (!open || minimized || !list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followLatestRef.current) bottomPinScheduler.schedule();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [bottomPinScheduler, minimized, open, snapshot.selectedPeerId]);

  useEffect(() => {
    const list = listRef.current;
    if (layout !== "phone" || !open || minimized || !list) return;
    const guard = installTouchScrollBoundaryGuard(list, () => (
      isIosStandaloneMobileChat() &&
      (
        document.activeElement === textareaRef.current ||
        getMobileKeyboardDockingSnapshot().phase !== "closed"
      )
    ));
    return () => guard.dispose();
  }, [layout, minimized, open, snapshot.selectedPeerId]);

  useEffect(() => () => bottomPinScheduler.cancel(), [bottomPinScheduler]);

  useLayoutEffect(() => {
    if (!open || !selected) {
      bottomPinScheduler.cancel();
      if (selectedPeerIdRef.current !== null) {
        selectedPeerIdRef.current = null;
        knownMessageIdsRef.current.clear();
        previousMessageIdsRef.current = [];
        prependHeightRef.current = null;
        followLatestRef.current = true;
        setUnseenMessageCount(0);
      }
      return;
    }
    if (minimized) {
      bottomPinScheduler.cancel();
      return;
    }
    const currentIds = snapshot.messages.map((message) => message.clientMessageId);
    const peerChanged = selectedPeerIdRef.current !== snapshot.selectedPeerId;
    if (peerChanged) {
      selectedPeerIdRef.current = snapshot.selectedPeerId;
      knownMessageIdsRef.current = new Set(currentIds);
      previousMessageIdsRef.current = currentIds;
      prependHeightRef.current = null;
      followLatestRef.current = true;
      setUnseenMessageCount(0);
      bottomPinScheduler.schedule();
      return;
    }

    const previousHeight = prependHeightRef.current;
    const list = listRef.current;
    if (!list) return;
    if (previousHeight !== null) {
      setProgrammaticScrollTop(
        list,
        list.scrollTop + Math.max(0, list.scrollHeight - previousHeight),
        programmaticScrollRef
      );
      prependHeightRef.current = null;
      for (const id of currentIds) knownMessageIdsRef.current.add(id);
      previousMessageIdsRef.current = currentIds;
      return;
    }

    const previousIds = previousMessageIdsRef.current;
    const previousLastId = previousIds.at(-1);
    const previousTailIndex = previousLastId ? currentIds.lastIndexOf(previousLastId) : -1;
    const appendedIds = (previousTailIndex >= 0
      ? currentIds.slice(previousTailIndex + 1)
      : currentIds
    ).filter((id) => !knownMessageIdsRef.current.has(id));
    for (const id of currentIds) knownMessageIdsRef.current.add(id);
    previousMessageIdsRef.current = currentIds;

    if (followLatestRef.current) {
      bottomPinScheduler.schedule();
    } else if (appendedIds.length > 0) {
      setUnseenMessageCount((count) => count + appendedIds.length);
    }
  }, [
    bottomPinScheduler,
    minimized,
    open,
    selected,
    snapshot.messages,
    snapshot.selectedPeerId
  ]);

  const submit = (): void => {
    const body = normalizeDraft(draft);
    if (!body || !onSend(body)) return;
    setDraft("");
    followLatestRef.current = true;
    setUnseenMessageCount(0);
    bottomPinScheduler.schedule();
  };

  return (
    <>
      {layout === "phone" ? (
        <PhoneMenuDestinationShell
          open={open && !phoneConversationOpen}
          className="direct-messages-panel direct-messages-panel--phone direct-messages-panel--phone-list-destination"
          title="Messages"
          menuId="messages"
          headerStatus={{ value: formatUnread(unreadSummary.all), label: "Unread" }}
          bodyClassName="direct-messages-phone-list-body"
          initialFocus="container"
          backLabel={phoneNotificationOpen ? "Back" : "Back to Game Menu"}
          onBack={() => {
            dismissMobileKeyboard();
            if (phoneNotificationOpen) {
              onSelectNotification?.(null);
              return;
            }
            onClose();
          }}
          onReturnToGame={onReturnToGame}
        >
          <MobileInboxList
            entries={mobileInboxEntries}
            category={inboxCategory}
            connected={connectionStatus === "online"}
            selectedNotificationKey={selectedNotificationKey}
            onCategory={setInboxCategory}
            onSelectPeer={onSelectPeer}
            onSelectNotification={onSelectNotification}
            onReadDirectMessages={onReadDirectMessages}
            onMarkInboxRead={onMarkInboxRead}
            onInboxActionConfirmed={onInboxActionConfirmed}
            onAcceptTravelInvite={onAcceptTravelInvite}
            onDeclineTravelInvite={onDeclineTravelInvite}
            onCancelTravelInvite={onCancelTravelInvite}
            onAcceptPartyInvite={onAcceptPartyInvite}
            onForwardPartyInvite={onForwardPartyInvite}
            forwardPartyInvitesToLeader={forwardPartyInvitesToLeader}
            onDeclinePartyInvite={onDeclinePartyInvite}
            onCancelPartyInvite={onCancelPartyInvite}
            onRespondKingdomInvitation={onRespondKingdomInvitation}
            onCancelKingdomInvitation={onCancelKingdomInvitation}
            onClaimPlayerPackage={onClaimPlayerPackage}
            onRespondFriendRequest={onRespondFriendRequest}
            onOpenPlayerProfile={onOpenPlayerProfile}
            partyInviteRequiresMergeReview={partyInviteRequiresMergeReview}
          />
        </PhoneMenuDestinationShell>
      ) : null}
      <MobileChatOverlay
        presentation={layout === "desktop" ? "desktop" : "touch"}
        open={layout === "phone" ? open && phoneConversationOpen : open}
        type="direct"
        manageHistory={layout !== "phone"}
        onRequestClose={onClose}
        onProtectionFailure={onClose}
        className={`direct-messages-panel${layout === "desktop" ? " phone-destination-shell desktop-destination-shell" : ""} direct-messages-panel--${layout}${phoneConversationOpen ? " direct-messages-panel--phone-conversation" : ""}${minimized ? " direct-messages-panel--minimized" : ""}`}
        data-layout={layout}
        aria-label="Private messages"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {layout === "desktop" ? <header className="direct-messages-titlebar">
        <div>
            <DesktopWindowTitle>Messages</DesktopWindowTitle>
          {unreadSummary.all > 0 ? (
            <span className="direct-messages-total-unread" aria-label={`${unreadSummary.all} unread messages`}>
              {formatUnread(unreadSummary.all)}
            </span>
          ) : null}
        </div>
        <div className="direct-messages-window-actions">
          <button
            type="button"
            onClick={() => onMinimizedChange(!minimized)}
            aria-label={minimized ? "Restore messages" : "Minimize messages"}
            title={minimized ? "Restore" : "Minimize"}
          >
            {minimized ? "Restore" : "Minimize"}
          </button>
          <button
            type="button"
            data-mobile-chat-close="true"
            onClick={() => {
              dismissMobileKeyboard();
              onClose();
            }}
            aria-label="Close messages"
            title="Close"
          >
            Close
          </button>
        </div>
        </header> : null}

        {!minimized && (layout === "desktop" || selected) ? (
        <div className={`direct-messages-content${phoneConversationOpen ? " direct-messages-content--phone-conversation" : ""}`}>
          {layout === "desktop" ? <ConversationList
            conversations={snapshot.conversations}
            inboxEntries={mobileInboxEntries.filter((entry) =>
              entry.sourceEntry.kind !== "direct_message"
            )}
            selectedInboxKey={selectedDesktopInboxKey}
            selectedPeerId={snapshot.selectedPeerId}
            hasMore={snapshot.hasMoreConversations}
            loading={loadingConversations}
            soundsEnabled={snapshot.preferences.soundsEnabled}
            onSelectPeer={(peerId) => {
              setSelectedDesktopInboxKey(null);
              onSelectPeer(peerId);
            }}
            onSelectInboxEntry={(key) => {
              setSelectedDesktopInboxKey(key);
              onSelectPeer(null);
              const entry = mobileInboxEntries.find((candidate) => candidate.key === key);
              if (entry?.unreadCount && onMarkInboxRead) {
                void onMarkInboxRead([{ entryKey: entry.key, revision: entry.revision }]);
              }
            }}
            onLoadMore={onLoadMoreConversations}
            onSoundsEnabledChange={onSoundsEnabledChange}
          /> : null}
          {selectedDesktopInboxEntry && selectedDesktopInboxEntry.category !== "notifications" ? (
            <section className="desktop-inbox-action-detail" aria-label="Invitation details">
              <MobileInboxRow
                entry={selectedDesktopInboxEntry}
                connected={connectionStatus === "online"}
                onSelectPeer={onSelectPeer}
                onMarkInboxRead={onMarkInboxRead}
                onInboxActionConfirmed={onInboxActionConfirmed}
                onAcceptTravelInvite={onAcceptTravelInvite}
                onDeclineTravelInvite={onDeclineTravelInvite}
                onCancelTravelInvite={onCancelTravelInvite}
                onAcceptPartyInvite={onAcceptPartyInvite}
                onForwardPartyInvite={onForwardPartyInvite}
                forwardPartyInvitesToLeader={forwardPartyInvitesToLeader}
                onDeclinePartyInvite={onDeclinePartyInvite}
                onCancelPartyInvite={onCancelPartyInvite}
                onRespondKingdomInvitation={onRespondKingdomInvitation}
                onCancelKingdomInvitation={onCancelKingdomInvitation}
                onOpenNotification={(entry) => setSelectedDesktopInboxKey(entry.key)}
                onRespondFriendRequest={onRespondFriendRequest}
                onOpenPlayerProfile={onOpenPlayerProfile}
                partyInviteRequiresMergeReview={partyInviteRequiresMergeReview}
              />
            </section>
          ) : selectedDesktopInboxEntry ? (
            <MobileInboxDetail
              entry={selectedDesktopInboxEntry}
              connected={connectionStatus === "online"}
              readError={null}
              onClaimPlayerPackage={onClaimPlayerPackage}
              onBack={() => setSelectedDesktopInboxKey(null)}
            />
          ) : selected ? (
            <section
              className="direct-message-conversation"
              data-mobile-chat-dock-layout
              aria-label={`Conversation with ${selected.peer.displayName}`}
            >
              <ConversationHeader conversation={selected} onOpenPeerActions={onOpenPeerActions} />
              {selected.blocked ? (
                <div className="direct-message-history direct-message-blocked-history" role="status">
                  <div className="direct-message-history-content">
                    <strong>Messages hidden</strong>
                    <span>Messages with {selected.peer.displayName} are hidden while this player is blocked.</span>
                  </div>
                </div>
              ) : (
                <>
                  <div
                    ref={listRef}
                    className="direct-message-history"
                    data-mobile-chat-message-region
                    role="log"
                    aria-live="off"
                    aria-label={`Messages with ${selected.peer.displayName}`}
                    onScroll={(event) => {
                      if (programmaticScrollRef.current > 0) return;
                      const list = event.currentTarget;
                      const atBottom =
                        list.scrollHeight - list.scrollTop - list.clientHeight <=
                        DIRECT_MESSAGE_BOTTOM_THRESHOLD_PX;
                      if (atBottom === followLatestRef.current) return;
                      followLatestRef.current = atBottom;
                      if (atBottom) {
                        setUnseenMessageCount(0);
                        bottomPinScheduler.schedule();
                      }
                    }}
                  >
                    <div className="direct-message-history-content">
                      {selected.hasOlderMessages && firstSequence(snapshot.messages) !== null ? (
                        <button
                          type="button"
                          className="direct-message-load-older game-app-button game-app-button-compact"
                          disabled={loadingOlder}
                          onClick={() => {
                            const beforeSequence = firstSequence(snapshot.messages);
                            const list = listRef.current;
                            if (beforeSequence === null || !list) return;
                            prependHeightRef.current = list.scrollHeight;
                            if (selected.conversationId !== null) onLoadOlder(selected.conversationId, beforeSequence);
                          }}
                        >
                          {loadingOlder ? "Loading…" : "Load older messages"}
                        </button>
                      ) : null}
                      {snapshot.messages.length === 0 ? (
                        <div className="direct-message-empty game-app-state">
                          <strong>Start a private conversation</strong>
                          <span>Only you and {selected.peer.displayName} can see messages here.</span>
                        </div>
                      ) : snapshot.messages.map((message, index) => {
                        const previous = snapshot.messages[index - 1];
                        const next = snapshot.messages[index + 1];
                        const newDay = !previous || !sameCalendarDay(previous.createdAt, message.createdAt);
                        const joinsPrevious = !newDay && previous !== undefined && messagesGroup(previous, message);
                        const joinsNext = next !== undefined && sameCalendarDay(message.createdAt, next.createdAt) && messagesGroup(message, next);
                        return (
                          <Fragment key={message.key}>
                            {newDay ? <div className="direct-message-day" role="separator"><span>{formatDayLabel(message.createdAt)}</span></div> : null}
                            <MessageBubble message={message} joinsPrevious={joinsPrevious} joinsNext={joinsNext} onRetry={onRetry} />
                          </Fragment>
                        );
                      })}
                    </div>
                  </div>
                  {unseenMessageCount > 0 ? (
                    <button
                      type="button"
                      className="direct-message-new-messages game-app-button game-app-button-compact"
                      aria-live="polite"
                      onPointerDown={(event) =>
                        preserveFocusedTextEntryOnPointerDown(event, textareaRef.current)
                      }
                      onClick={() => {
                        followLatestRef.current = true;
                        setUnseenMessageCount(0);
                        bottomPinScheduler.schedule();
                      }}
                    >
                      ↓ {unseenMessageCount} new message{unseenMessageCount === 1 ? "" : "s"}
                    </button>
                  ) : null}
                </>
              )}
              {selected.blocked ? (
                <div className="direct-message-blocked" role="status">
                  You blocked {selected.peer.displayName}. Unblock this player to resume messaging.
                </div>
              ) : communitySafety && termsStatus?.accepted !== true ? (
                <div className="direct-message-terms-gate" role="group" aria-label="Community Rules">
                  <strong>Community Rules required</strong>
                  <p>Review the <a href="https://playashatlas.com/terms" target="_blank" rel="noopener noreferrer">Community Rules</a> before sending private messages.</p>
                  {termsError ? <div role="alert">{termsError}</div> : null}
                  <button type="button" className="game-app-button game-app-button-primary" disabled={termsLoading} onClick={() => void acceptTerms()}>
                    {termsLoading ? "Loading…" : "Accept Community Rules"}
                  </button>
                </div>
              ) : (
                <form
                  className="direct-message-composer"
                  data-mobile-chat-composer
                  onSubmit={(event) => { event.preventDefault(); submit(); }}
                >
                  <label>
                    <span className="direct-message-sr-only">Message {selected.peer.displayName}</span>
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      rows={1}
                      maxLength={DIRECT_MESSAGE_BODY_MAX_LENGTH}
                      disabled={connectionStatus !== "online" || !selected.canMessage}
                      placeholder={connectionStatus === "online" ? `Message ${selected.peer.displayName}` : "Reconnect to send a message"}
                      onPointerDown={prepareMobileChatInputPointerDown}
                      onFocus={handleMobileChatInputFocus}
                      onChange={(event) => setDraft(limitDraft(event.currentTarget.value))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !(event.nativeEvent as KeyboardEvent).isComposing) {
                          event.preventDefault();
                          submit();
                        }
                      }}
                    />
                  </label>
                  <button
                    type="submit"
                    className="game-app-button game-app-button-primary direct-message-send"
                    aria-label="Send"
                    title="Send"
                    disabled={connectionStatus !== "online" || !selected.canMessage || normalizeDraft(draft).length === 0}
                    onPointerDown={(event) =>
                      preserveFocusedTextEntryOnPointerDown(event, textareaRef.current)
                    }
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"><path d="M21 3 10.5 13.5" /><path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" /></svg>
                  </button>
                </form>
              )}
            </section>
          ) : (
            <section className="direct-message-no-selection" aria-label="No private conversation selected">
              <span aria-hidden="true">✉</span>
              <strong>Select a conversation</strong>
              <small>Private messages stay synced when you reconnect.</small>
            </section>
          )}
        </div>
        ) : null}
        {layout === "phone" && selected ? (
          <PhoneMenuFooter
            backLabel={conversationBackLabel}
            showBackGlyph={false}
            onBack={() => {
              dismissMobileKeyboard();
              if (onConversationBack) onConversationBack();
              else onSelectPeer(null);
            }}
            onReturnToGame={onReturnToGame}
          />
        ) : null}
      </MobileChatOverlay>
    </>
  );
}

const MOBILE_INBOX_CATEGORIES = [
  {
    id: "personal",
    label: "Personal"
  },
  {
    id: "invites",
    label: "Requests"
  },
  {
    id: "notifications",
    label: "Notifications"
  }
] as const;

function MobileInboxList({
  entries,
  category,
  connected,
  selectedNotificationKey,
  onCategory,
  onSelectPeer,
  onSelectNotification,
  onReadDirectMessages,
  onMarkInboxRead,
  onInboxActionConfirmed,
  onAcceptTravelInvite,
  onDeclineTravelInvite,
  onCancelTravelInvite,
  onAcceptPartyInvite,
  onForwardPartyInvite,
  forwardPartyInvitesToLeader,
  onDeclinePartyInvite,
  onCancelPartyInvite,
  onRespondKingdomInvitation,
  onCancelKingdomInvitation,
  onClaimPlayerPackage,
  onRespondFriendRequest,
  onOpenPlayerProfile,
  partyInviteRequiresMergeReview
}: {
  entries: readonly MobileInboxEntry[];
  category: MobileInboxCategory;
  connected: boolean;
  selectedNotificationKey: string | null;
  onCategory(category: MobileInboxCategory): void;
  onSelectPeer(peerId: string): void;
  onSelectNotification?: DirectMessagesPanelProps["onSelectNotification"];
  onReadDirectMessages?: DirectMessagesPanelProps["onReadDirectMessages"];
  onMarkInboxRead?: DirectMessagesPanelProps["onMarkInboxRead"];
  onInboxActionConfirmed?: DirectMessagesPanelProps["onInboxActionConfirmed"];
  onAcceptTravelInvite?: DirectMessagesPanelProps["onAcceptTravelInvite"];
  onDeclineTravelInvite?: DirectMessagesPanelProps["onDeclineTravelInvite"];
  onCancelTravelInvite?: DirectMessagesPanelProps["onCancelTravelInvite"];
  onAcceptPartyInvite?: DirectMessagesPanelProps["onAcceptPartyInvite"];
  onForwardPartyInvite?: DirectMessagesPanelProps["onForwardPartyInvite"];
  forwardPartyInvitesToLeader: boolean;
  onDeclinePartyInvite?: DirectMessagesPanelProps["onDeclinePartyInvite"];
  onCancelPartyInvite?: DirectMessagesPanelProps["onCancelPartyInvite"];
  onRespondKingdomInvitation?: DirectMessagesPanelProps["onRespondKingdomInvitation"];
  onCancelKingdomInvitation?: DirectMessagesPanelProps["onCancelKingdomInvitation"];
  onClaimPlayerPackage?: DirectMessagesPanelProps["onClaimPlayerPackage"];
  onRespondFriendRequest?: DirectMessagesPanelProps["onRespondFriendRequest"];
  onOpenPlayerProfile?: DirectMessagesPanelProps["onOpenPlayerProfile"];
  partyInviteRequiresMergeReview: boolean;
}): React.JSX.Element {
  const [readAllPending, setReadAllPending] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const summary = summarizeMobileInboxUnread(entries);
  const selectedNotification = selectedNotificationKey
    ? entries.find((entry) => entry.key === selectedNotificationKey) ?? null
    : null;
  const categoryEntries = entries.filter((entry) => entry.category === category);
  const count = (target: MobileInboxCategory): number => summary[target];
  const activeCategory = MOBILE_INBOX_CATEGORIES.find((item) => item.id === category)!;
  const readAllLabel = category === "personal"
    ? "Read All Personal"
    : category === "invites"
      ? "Read All Invites"
      : "Read All Notifications";
  const markCategoryRead = async (): Promise<void> => {
    if (readAllPending || count(category) === 0) return;
    setReadAllPending(true);
    setReadError(null);
    const scope = entries.filter((entry) => entry.category === category);
    const directTargets = scope.flatMap((entry) => {
      if (entry.unreadCount === 0 || entry.sourceEntry.kind !== "direct_message") return [];
      const conversation = entry.sourceEntry.conversation;
      return conversation.conversationId && conversation.latestSequence !== "0"
        ? [{ conversationId: conversation.conversationId, throughSequence: conversation.latestSequence }]
        : [];
    });
    const receiptTargets = scope.flatMap((entry) =>
      entry.unreadCount > 0 && entry.sourceEntry.kind !== "direct_message"
        ? [{ entryKey: entry.key, revision: entry.revision }]
        : []
    );
    try {
      const results = await Promise.all([
        directTargets.length > 0
          ? onReadDirectMessages?.(directTargets) ?? Promise.resolve(false)
          : Promise.resolve(true),
        receiptTargets.length > 0
          ? onMarkInboxRead?.(receiptTargets) ?? Promise.resolve(false)
          : Promise.resolve(true)
      ]);
      if (results.some((result) => !result)) {
        throw new Error("The server did not confirm every read update.");
      }
    } catch (error) {
      setReadError(error instanceof Error ? error.message : "Could not mark Messages read.");
    } finally {
      setReadAllPending(false);
    }
  };
  const openNotification = (entry: MobileInboxEntry): void => {
    onSelectNotification?.(entry.key);
    if (entry.unreadCount === 0 || !onMarkInboxRead) return;
    setReadError(null);
    void onMarkInboxRead([{ entryKey: entry.key, revision: entry.revision }])
      .then((confirmed) => {
        if (!confirmed) setReadError("The server did not confirm the read update.");
      })
      .catch((error: unknown) => {
        setReadError(error instanceof Error ? error.message : "Could not mark this notification read.");
      });
  };
  if (selectedNotification?.category === "notifications") {
    return <MobileInboxDetail
      entry={selectedNotification}
      connected={connected}
      readError={readError}
      onClaimPlayerPackage={onClaimPlayerPackage}
    />;
  }
  return (
    <section className="mobile-inbox" aria-label="Messages inbox">
      <div className="mobile-inbox-navigation">
        <div className="mobile-inbox-categories">
          <GameAppTabs
            ariaLabel="Message categories"
            activeTab={category}
            tabs={MOBILE_INBOX_CATEGORIES.map((item) => ({
              id: item.id,
              label: item.label,
              ...(count(item.id) > 0 ? {
                badge: formatUnread(count(item.id)),
                ariaLabel: `${item.label}, ${count(item.id)} unread`
              } : {})
            }))}
            onChange={(id) => {
              const next = MOBILE_INBOX_CATEGORIES.find((item) => item.id === id);
              if (!next) return;
              onSelectNotification?.(null);
              onCategory(next.id);
            }}
          />
        </div>
        {count(category) > 0 ? <div className="mobile-inbox-category-actions">
          <button
            type="button"
            className="game-app-button game-app-button-compact"
            disabled={readAllPending}
            onClick={() => void markCategoryRead()}
          >
            {readAllPending ? "Marking…" : readAllLabel}
          </button>
        </div> : null}
        {readError ? <p className="mobile-inbox-toolbar-error" role="alert">{readError}</p> : null}
      </div>
      <div
        id="mobile-inbox-tabpanel"
        className="mobile-inbox-entries"
        role="tabpanel"
        aria-label={`${activeCategory.label} messages`}
      >
        <div className={`mobile-inbox-ledger category-${category}${categoryEntries.length === 0 ? " is-empty" : ""}`}>
          {categoryEntries.length === 0 ? <GameAppEmptyState className="mobile-inbox-empty">{mobileInboxEmptyState(category)}</GameAppEmptyState> : categoryEntries.map((entry) => (
            <MobileInboxRow
              key={entry.key}
              entry={entry}
              connected={connected}
              onSelectPeer={onSelectPeer}
              onReadDirectMessages={onReadDirectMessages}
              onMarkInboxRead={onMarkInboxRead}
              onInboxActionConfirmed={onInboxActionConfirmed}
              onAcceptTravelInvite={onAcceptTravelInvite}
              onDeclineTravelInvite={onDeclineTravelInvite}
              onCancelTravelInvite={onCancelTravelInvite}
              onAcceptPartyInvite={onAcceptPartyInvite}
              onForwardPartyInvite={onForwardPartyInvite}
              forwardPartyInvitesToLeader={forwardPartyInvitesToLeader}
              onDeclinePartyInvite={onDeclinePartyInvite}
              onCancelPartyInvite={onCancelPartyInvite}
              onRespondKingdomInvitation={onRespondKingdomInvitation}
              onCancelKingdomInvitation={onCancelKingdomInvitation}
              onOpenNotification={openNotification}
              onRespondFriendRequest={onRespondFriendRequest}
              onOpenPlayerProfile={onOpenPlayerProfile}
              partyInviteRequiresMergeReview={partyInviteRequiresMergeReview}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function MobileInboxRow({
  entry,
  connected,
  onSelectPeer,
  onMarkInboxRead,
  onInboxActionConfirmed,
  onAcceptTravelInvite,
  onDeclineTravelInvite,
  onCancelTravelInvite,
  onAcceptPartyInvite,
  onForwardPartyInvite,
  forwardPartyInvitesToLeader,
  onDeclinePartyInvite,
  onCancelPartyInvite,
  onRespondKingdomInvitation,
  onCancelKingdomInvitation,
  onOpenNotification,
  onRespondFriendRequest,
  onOpenPlayerProfile,
  partyInviteRequiresMergeReview
}: Omit<
  Parameters<typeof MobileInboxList>[0],
  "entries" | "category" | "selectedNotificationKey" | "onCategory" | "onSelectNotification"
> & {
  entry: MobileInboxEntry;
  onOpenNotification(entry: MobileInboxEntry): void;
}): React.JSX.Element {
  const [pendingAction, setPendingAction] = useState<"accept" | "forward" | "decline" | "cancel" | "read" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const source = entry.sourceEntry;
  const invoke = async (
    action: "accept" | "forward" | "decline" | "cancel",
    handler: (() => boolean | Promise<boolean>) | undefined
  ): Promise<void> => {
    if (pendingAction || !handler) {
      if (!handler) setFeedback("This action is unavailable.");
      return;
    }
    setPendingAction(action);
    setFeedback(null);
    try {
      const sent = await handler();
      if (!sent) return;
      onInboxActionConfirmed?.(entry.key, entry.revision);
      setFeedback(`${action[0]!.toUpperCase()}${action.slice(1)} request confirmed.`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "The invitation action failed.");
    } finally {
      setPendingAction(null);
    }
  };
  const actionDisabled = (allowed: boolean): boolean => !connected || !allowed || pendingAction !== null;
  const actionTitle = (reason: string | null): string | undefined =>
    !connected ? "Reconnect to use this action." : reason ?? undefined;
  const readStateClass = entry.unreadCount > 0 ? " unread" : " read";
  const compactProfileActionClass = entry.category === "notifications"
    && entry.unreadCount === 0
    && source.kind === "social"
    ? " has-compact-profile-action"
    : "";
  const notificationTitle = entry.source === "Ash Atlas" || (source.kind === "player_package" && source.package.kind === "player_gift")
    ? entry.label
    : `${entry.label} · ${entry.source}`;
  const notificationStateLabel = source.kind === "game_notice" && entry.state === "read"
    ? null
    : entry.stateLabel;
  const profileId = source.kind === "social" ? source.entry.actorPlayerId : null;
  const initialMedallion = <span className="mobile-inbox-medallion mobile-inbox-medallion--initial" aria-hidden="true">{initialOf(entry.source)}</span>;
  const leadingMedallion = source.kind === "direct_message"
    ? initialMedallion
    : entry.category === "invites"
      ? (profileId
        ? <button type="button" className="mobile-inbox-medallion mobile-inbox-medallion--initial mobile-inbox-medallion-button" aria-label="View Profile" onClick={() => onOpenPlayerProfile?.(profileId)}>{initialOf(entry.source)}</button>
        : initialMedallion)
      : <span className="mobile-inbox-medallion" aria-hidden="true"><StatGlyph icon={inboxKindGlyph(source.kind)} /></span>;
  const headingName = entry.category === "notifications"
    ? notificationTitle
    : entry.category === "invites" && profileId
      ? <button type="button" className="mobile-inbox-name-link" onClick={() => onOpenPlayerProfile?.(profileId)}>{entry.source}</button>
      : entry.source;
  const body = <>
    {leadingMedallion}
    {entry.category === "invites" ? <span className="mobile-inbox-entry-kind">{source.kind === "social" ? <StatGlyph icon="contacts" /> : null}{entry.label}</span> : null}
    <header className="mobile-inbox-entry-heading">
      <strong>{headingName}</strong>
      <time dateTime={entry.createdAt}>{formatInboxDateTime(entry.createdAt)}</time>
    </header>
    <p className="mobile-inbox-entry-message">{entry.message}</p>
    {source.kind === "direct_message" ? (
      entry.unreadCount > 0 ? <b className="mobile-inbox-seal" aria-label={`${entry.unreadCount} unread messages`}>{formatUnread(entry.unreadCount)}</b> : null
    ) : entry.category === "notifications" && (notificationStateLabel || (entry.expiresAt && entry.state === "active")) ? (
      <footer className="mobile-inbox-notification-meta">
        {notificationStateLabel ? <span className="mobile-inbox-notification-state" data-state={entry.state}>{notificationStateLabel}</span> : null}
        {entry.expiresAt && entry.state === "active" ? <time dateTime={entry.expiresAt}>Expires {formatConversationTime(entry.expiresAt)}</time> : null}
      </footer>
    ) : entry.category !== "personal" || entry.unreadCount > 0 ? (
      <footer><span data-state={entry.state}>{entry.stateLabel}</span>{entry.expiresAt && entry.state === "active" ? <time dateTime={entry.expiresAt}>Expires {formatConversationTime(entry.expiresAt)}</time> : null}</footer>
    ) : null}
  </>;
  if (source.kind === "direct_message") {
    return <button type="button" className={`mobile-inbox-entry variant-personal${readStateClass}`} onClick={() => onSelectPeer(source.conversation.peer.playerId)}>{body}</button>;
  }
  return <article className={`mobile-inbox-entry variant-${entry.variant} category-${entry.category}${readStateClass}${compactProfileActionClass}`} data-state={entry.state}>
    {entry.category === "notifications" ? (
      <button
        type="button"
        className="mobile-inbox-entry-open"
        aria-label={`Read ${entry.label} from ${entry.source}`}
        onClick={() => onOpenNotification(entry)}
      >
        {body}
      </button>
    ) : body}
    {source.kind === "travel_invite" && source.entry.status === "pending" ? <div className="mobile-inbox-actions">
      {source.entry.perspective === "recipient" ? <>
        <button type="button" className="game-app-button game-app-button-primary game-app-button-compact" disabled={actionDisabled(entry.canAccept)} title={actionTitle(entry.acceptDisabledReason)} onClick={() => void invoke("accept", onAcceptTravelInvite ? () => onAcceptTravelInvite(source.entry.inviteId) : undefined)}>{pendingAction === "accept" ? "Accepting…" : "Accept"}</button>
        <button type="button" className="secondary game-app-button game-app-button-compact" disabled={actionDisabled(entry.canDecline)} title={actionTitle(entry.declineDisabledReason)} onClick={() => void invoke("decline", onDeclineTravelInvite ? () => onDeclineTravelInvite(source.entry.inviteId) : undefined)}>{pendingAction === "decline" ? "Declining…" : "Decline"}</button>
      </> : <button type="button" className="secondary game-app-button game-app-button-compact" disabled={actionDisabled(entry.canCancel)} title={actionTitle(entry.cancelDisabledReason)} onClick={() => void invoke("cancel", onCancelTravelInvite ? () => onCancelTravelInvite(source.entry.inviteId) : undefined)}>{pendingAction === "cancel" ? "Cancelling…" : "Cancel"}</button>}
    </div> : null}
    {source.kind === "party_invite" && source.invite.status === "pending" ? <div className="mobile-inbox-actions">
      {source.invite.perspective === "incoming" ? <>
        {forwardPartyInvitesToLeader
          ? <button type="button" className="game-app-button game-app-button-primary game-app-button-compact" disabled={actionDisabled(entry.canAccept)} title={actionTitle(entry.acceptDisabledReason)} onClick={() => void invoke("forward", onForwardPartyInvite ? () => onForwardPartyInvite(source.invite.invitationId) : undefined)}>{pendingAction === "forward" ? "Sending…" : "Send to Leader"}</button>
          : <button type="button" className="game-app-button game-app-button-primary game-app-button-compact" disabled={actionDisabled(entry.canAccept)} title={actionTitle(entry.acceptDisabledReason)} onClick={() => void invoke("accept", onAcceptPartyInvite ? () => onAcceptPartyInvite(source.invite.invitationId) : undefined)}>{pendingAction === "accept" ? "Accepting…" : partyInviteRequiresMergeReview ? "Review Merge" : "Accept"}</button>}
        <button type="button" className="secondary game-app-button game-app-button-compact" disabled={actionDisabled(entry.canDecline)} title={actionTitle(entry.declineDisabledReason)} onClick={() => void invoke("decline", onDeclinePartyInvite ? () => onDeclinePartyInvite(source.invite.invitationId) : undefined)}>{pendingAction === "decline" ? "Declining…" : "Decline"}</button>
      </> : <button type="button" className="secondary game-app-button game-app-button-compact" disabled={actionDisabled(entry.canCancel)} title={actionTitle(entry.cancelDisabledReason)} onClick={() => void invoke("cancel", onCancelPartyInvite ? () => onCancelPartyInvite(source.invite.invitationId) : undefined)}>{pendingAction === "cancel" ? "Cancelling…" : "Cancel"}</button>}
    </div> : null}
    {source.kind === "kingdom_invite" && source.invitation.status === "pending" ? <div className="mobile-inbox-actions">
      {source.invitation.targetPlayerId === source.ownPlayerId ? <>
        <button type="button" className="game-app-button game-app-button-primary game-app-button-compact" disabled={actionDisabled(entry.canAccept)} title={actionTitle(entry.acceptDisabledReason)} onClick={() => void invoke("accept", onRespondKingdomInvitation ? () => onRespondKingdomInvitation(source.invitation.id, "accept") : undefined)}>{pendingAction === "accept" ? "Accepting…" : "Accept"}</button>
        <button type="button" className="secondary game-app-button game-app-button-compact" disabled={actionDisabled(entry.canDecline)} title={actionTitle(entry.declineDisabledReason)} onClick={() => void invoke("decline", onRespondKingdomInvitation ? () => onRespondKingdomInvitation(source.invitation.id, "decline") : undefined)}>{pendingAction === "decline" ? "Declining…" : "Decline"}</button>
      </> : source.invitation.invitedByPlayerId === source.ownPlayerId ? <button type="button" className="secondary game-app-button game-app-button-compact" disabled={actionDisabled(entry.canCancel)} title={actionTitle(entry.cancelDisabledReason)} onClick={() => void invoke("cancel", onCancelKingdomInvitation ? () => onCancelKingdomInvitation(source.invitation.id) : undefined)}>{pendingAction === "cancel" ? "Cancelling…" : "Cancel"}</button> : null}
    </div> : null}
    {source.kind === "social" ? <>
      <div className="mobile-inbox-actions">
        {entry.category !== "invites" ? <button type="button" className="secondary game-app-button game-app-button-compact" onClick={() => onOpenPlayerProfile?.(source.entry.actorPlayerId)}>View Profile</button> : null}
        {source.entry.kind === "friend_request" && source.entry.state === "pending" ? <>
          <button type="button" className="game-app-button game-app-button-primary game-app-button-compact" disabled={actionDisabled(entry.canAccept)} onClick={() => void invoke("accept", onRespondFriendRequest ? () => onRespondFriendRequest(source.entry.actorPlayerId, "accept_friend_request") : undefined)}>{pendingAction === "accept" ? "Accepting…" : "Accept Friend"}</button>
          <button type="button" className="secondary game-app-button game-app-button-compact" disabled={actionDisabled(entry.canDecline)} onClick={() => void invoke("decline", onRespondFriendRequest ? () => onRespondFriendRequest(source.entry.actorPlayerId, "decline_friend_request") : undefined)}>{pendingAction === "decline" ? "Declining…" : "Decline"}</button>
        </> : null}
      </div>
    </> : null}
    {entry.unreadCount > 0 ? (
      <button
        type="button"
        className="mobile-inbox-mark-read game-app-button game-app-button-quiet game-app-button-compact"
        aria-label="Mark Read"
        title="Mark Read"
        disabled={pendingAction !== null || !onMarkInboxRead}
        onClick={() => {
          if (!onMarkInboxRead || pendingAction) return;
          setPendingAction("read");
          void onMarkInboxRead([{ entryKey: entry.key, revision: entry.revision }])
            .then((confirmed) => {
              if (!confirmed) setFeedback("The server did not confirm the read update.");
            })
            .catch((error: unknown) => setFeedback(error instanceof Error ? error.message : "Could not mark this entry read."))
            .finally(() => setPendingAction(null));
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
      </button>
    ) : null}
    {feedback ? <p className="mobile-inbox-feedback" role="status">{feedback}</p> : null}
  </article>;
}

function MobileInboxDetail({
  entry,
  connected,
  readError,
  onClaimPlayerPackage,
  onBack
}: {
  entry: MobileInboxEntry;
  connected: boolean;
  readError: string | null;
  onClaimPlayerPackage?: DirectMessagesPanelProps["onClaimPlayerPackage"];
  onBack?(): void;
}): React.JSX.Element {
  const [claiming, setClaiming] = useState(false);
  const [claimFeedback, setClaimFeedback] = useState<string | null>(null);
  const playerPackage = entry.sourceEntry.kind === "player_package"
    ? entry.sourceEntry.package
    : null;
  const claim = async (): Promise<void> => {
    if (!playerPackage || claiming || !onClaimPlayerPackage) return;
    setClaiming(true);
    setClaimFeedback(null);
    try {
      setClaimFeedback(await onClaimPlayerPackage(playerPackage.packageId, playerPackage.revision));
    } catch (error) {
      setClaimFeedback(error instanceof Error ? error.message : "The package could not be claimed.");
    } finally {
      setClaiming(false);
    }
  };
  return (
    <section className="mobile-inbox-detail" aria-label={`${entry.label} from ${entry.source}`}>
      <header>
        {onBack ? <button type="button" className="game-app-button game-app-button-compact" onClick={onBack}>Back</button> : null}
        <span>{entry.label}</span>
      </header>
      <article>
        <p className="mobile-inbox-detail-source">From <strong>{entry.source}</strong></p>
        <p className="mobile-inbox-detail-message">{entry.message}</p>
        {playerPackage ? (
          <>
            <ul className="player-package-items" aria-label="Package contents">
              {playerPackage.items.map((item) => (
                <li key={item.lineNumber}>
                  {item.itemKind === "gold" || item.itemKind === "city_coins"
                    ? <span className="player-package-currency-icon" aria-hidden="true">{item.itemKind === "gold" ? "G" : "C"}</span>
                    : <ItemArtwork itemId={item.itemId} category={item.category} variant={item.variant} label={item.displayName} />}
                  <span><strong>{item.displayName}</strong><small>{item.itemKind === "city_coins" ? "Credits your active city's treasury · " : item.itemKind === "gold" ? "Credits your Gold wallet · " : ""}{item.remainingQuantity.toLocaleString()} of {item.originalQuantity.toLocaleString()} remaining</small></span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="player-package-claim game-app-button game-app-button-primary"
              disabled={!connected || claiming || playerPackage.status === "claimed" || !onClaimPlayerPackage}
              title={!connected ? (playerPackage.kind === "player_gift" ? "Reconnect to open this gift." : "Reconnect to open this package.") : undefined}
              onClick={() => void claim()}
            >
              {claiming ? "Opening…" : playerPackage.status === "partial" ? "Claim Remaining" : playerPackage.status === "claimed" ? (playerPackage.kind === "player_gift" ? "Gift Claimed" : "Package Claimed") : (playerPackage.kind === "player_gift" ? "Open Gift" : "Open Package")}
            </button>
            {claimFeedback ? <p className="mobile-inbox-feedback" role="status">{claimFeedback}</p> : null}
          </>
        ) : null}
        <footer>
          <span data-state={entry.state}>{entry.stateLabel}</span>
          <time dateTime={entry.createdAt}>{formatConversationTime(entry.createdAt)}</time>
        </footer>
      </article>
      {readError ? <p className="mobile-inbox-feedback" role="alert">{readError}</p> : null}
    </section>
  );
}

function mobileInboxEmptyState(category: MobileInboxCategory): string {
  switch (category) {
    case "personal": return "No personal messages";
    case "invites": return "No pending requests";
    case "notifications": return "No notifications";
  }
}

function ConversationList({
  conversations,
  inboxEntries,
  selectedInboxKey,
  selectedPeerId,
  hasMore,
  loading,
  soundsEnabled,
  onSelectPeer,
  onSelectInboxEntry,
  onLoadMore,
  onSoundsEnabledChange
}: {
  conversations: readonly DirectConversationView[];
  inboxEntries: readonly MobileInboxEntry[];
  selectedInboxKey: string | null;
  selectedPeerId: string | null;
  hasMore: boolean;
  loading: boolean;
  soundsEnabled: boolean;
  onSelectPeer(peerId: string): void;
  onSelectInboxEntry(key: string): void;
  onLoadMore?: (() => void) | undefined;
  onSoundsEnabledChange?: ((enabled: boolean) => void) | undefined;
}): React.JSX.Element {
  return (
    <section className="direct-message-conversation-list" aria-label="Private message conversations">
      <div className="direct-message-conversation-rows">
        {inboxEntries.map((entry) => (
          <button
            type="button"
            key={entry.key}
            className={`game-app-row direct-message-conversation-row player-package-row${selectedInboxKey === entry.key ? " selected" : ""}`}
            aria-current={selectedInboxKey === entry.key ? "true" : undefined}
            onClick={() => onSelectInboxEntry(entry.key)}
          >
            <span className="player-package-row-icon" aria-hidden="true">◆</span>
            <span className="direct-message-row-copy"><strong>{entry.label}</strong><small>{entry.message || (entry.sourceEntry.kind === "player_package" && entry.sourceEntry.package.kind === "player_gift" ? `A gift from ${entry.source}` : "A package from Ash Atlas")}</small></span>
            <span className="direct-message-row-meta">{entry.unreadCount > 0 ? <b className="game-app-count" aria-label="Unread notification">1</b> : null}<small>{entry.stateLabel}</small></span>
          </button>
        ))}
        {conversations.length === 0 ? (
          <GameAppEmptyState className="direct-message-list-empty">No private messages yet</GameAppEmptyState>
        ) : conversations.map((conversation) => (
          <button
            type="button"
            key={conversation.peer.playerId}
            className={`game-app-row direct-message-conversation-row ${conversation.unreadCount > 0 ? "unread" : "read"}${selectedPeerId === conversation.peer.playerId ? " selected" : ""}`}
            aria-current={selectedPeerId === conversation.peer.playerId ? "true" : undefined}
            onClick={() => onSelectPeer(conversation.peer.playerId)}
          >
            <span className={`direct-message-presence${conversation.peer.online === true ? " online" : conversation.peer.online === false ? " offline" : " unknown"}`} aria-label={presenceLabel(conversation.peer.online)} />
            <span className="direct-message-row-copy">
              <strong>{conversation.peer.displayName}</strong>
              <small>{conversation.blocked ? "Messages hidden" : conversation.latestMessage?.body ?? "No messages yet"}</small>
            </span>
            <span className="direct-message-row-meta">
              <time dateTime={conversation.latestMessage?.createdAt}>{formatConversationTime(conversation.latestMessage?.createdAt)}</time>
              {conversation.muted ? <span aria-label="Muted" title="Muted">Muted</span> : null}
              {conversation.unreadCount > 0 ? <b className="game-app-count" aria-label={`${conversation.unreadCount} unread messages`}>{formatUnread(conversation.unreadCount)}</b> : null}
            </span>
          </button>
        ))}
        {hasMore && onLoadMore ? (
          <button type="button" className="direct-message-load-more game-app-button game-app-button-compact" disabled={loading} onClick={onLoadMore}>
            {loading ? "Loading…" : "Load more conversations"}
          </button>
        ) : null}
      </div>
      {onSoundsEnabledChange ? (
        <label className="direct-message-sound-setting">
          <input type="checkbox" checked={soundsEnabled} onChange={(event) => onSoundsEnabledChange(event.currentTarget.checked)} />
          <span>Private message sounds</span>
        </label>
      ) : null}
    </section>
  );
}

function ConversationHeader({
  conversation,
  onOpenPeerActions
}: {
  conversation: DirectConversationView;
  onOpenPeerActions?: DirectMessagesPanelProps["onOpenPeerActions"];
}): React.JSX.Element {
  return (
    <header className="direct-message-conversation-header">
      <span className="direct-message-peer-medallion" aria-hidden="true">{initialOf(conversation.peer.displayName)}</span>
      <div>
        <small className={`direct-message-presence-label ${conversation.peer.online === true ? "online" : conversation.peer.online === false ? "offline" : "unknown"}`}>{presenceLabel(conversation.peer.online)}</small>
        <strong>{conversation.peer.displayName}</strong>
      </div>
      {onOpenPeerActions ? <button
        type="button"
        className="direct-message-peer-actions game-app-button game-app-button-compact"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenPeerActions(conversation.peer.playerId, conversation.peer.displayName, {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom
          });
        }}
      >Actions</button> : null}
    </header>
  );
}

function MessageBubble({ message, joinsPrevious, joinsNext, onRetry }: {
  message: DirectMessageView;
  joinsPrevious: boolean;
  joinsNext: boolean;
  onRetry(clientMessageId: string): void;
}): React.JSX.Element {
  const showFooter = !joinsNext || message.deliveryState === "failed" || message.deliveryState === "sending";
  return (
    <GameMessageBox
      className={`direct-message-bubble ${message.outgoing ? "outgoing" : "incoming"}${joinsPrevious ? " joins-previous" : ""}${joinsNext ? " joins-next" : ""}`}
      tone={message.outgoing ? "outgoing" : "incoming"}
      data-message-state={message.deliveryState}
      data-message-sequence={message.sequence ?? undefined}
      data-client-message-id={message.clientMessageId}
      footer={showFooter ? <>
        <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
        {message.outgoing ? <span>{deliveryLabel(message.deliveryState)}</span> : null}
        {message.deliveryState === "failed" ? (
          <button type="button" onClick={() => onRetry(message.clientMessageId)}>Retry</button>
        ) : null}
      </> : undefined}
    >
      <div className="direct-message-body">{message.body}</div>
    </GameMessageBox>
  );
}

const GROUP_WINDOW_MS = 5 * 60_000;

function messagesGroup(earlier: DirectMessageView, later: DirectMessageView): boolean {
  if (earlier.outgoing !== later.outgoing) return false;
  const gap = Date.parse(later.createdAt) - Date.parse(earlier.createdAt);
  return !Number.isFinite(gap) || Math.abs(gap) <= GROUP_WINDOW_MS;
}

function sameCalendarDay(a: string, b: string): boolean {
  const first = new Date(a);
  const second = new Date(b);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(second.getTime())) return true;
  return first.toDateString() === second.toDateString();
}

function formatDayLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

function inboxKindGlyph(kind: MobileInboxEntry["sourceEntry"]["kind"]): "messages" | "world-map" | "party" | "kingdom" | "equipment" | "contacts" | "announcements" {
  switch (kind) {
    case "travel_invite": return "world-map";
    case "party_invite": return "party";
    case "kingdom_invite": return "kingdom";
    case "player_package": return "equipment";
    case "social": return "contacts";
    case "game_notice": return "announcements";
    default: return "messages";
  }
}

function firstSequence(messages: readonly DirectMessageView[]): string | null {
  return messages.find((message) => message.sequence !== null)?.sequence ?? null;
}

function normalizeDraft(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function limitDraft(value: string): string {
  return Array.from(value).slice(0, DIRECT_MESSAGE_BODY_MAX_LENGTH).join("");
}

function formatUnread(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function presenceLabel(online: boolean | null): string {
  return online === true ? "Online" : online === false ? "Offline" : "Status unavailable";
}

function deliveryLabel(state: DirectMessageView["deliveryState"]): string {
  switch (state) {
    case "sending": return "Sending…";
    case "sent": return "Sent";
    case "delivered": return "Delivered";
    case "read": return "Read";
    case "failed": return "Failed";
  }
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

function formatConversationTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatInboxDateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
}

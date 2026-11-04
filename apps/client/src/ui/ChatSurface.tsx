import {
  chatPartyListingFallbackBody,
  chatTradeListingFallbackBody,
  isLiveSessionChatChannel,
  type ChatCrestSelection,
  type ChatChannelKey,
  type ChatPartyListingInput,
  type ChatTradeListing,
  type EquipmentSnapshotV2,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { ReactNode, RefObject } from "react";

import type { ChatMessageView, ChatStore } from "../chat/chatStore.js";
import { ChatTranslationApi, isChatTranslationTargetLanguage } from "../chat/chatTranslationClient.js";
import { ChatCrestApi } from "../chat/chatCrestClient.js";
import { ChatBlockFilter } from "../chat/chatBlockFilter.js";
import type { ChatHistoryRequestTracker } from "../chat/chatHistoryRequestTracker.js";
import { ChatReadUpdateCoalescer } from "../chat/chatReadCoalescer.js";
import {
  CommunitySafetyApi,
  type CommunityReportCategory
} from "../community/communitySafetyClient.js";
import type { GameClient } from "../gameClient.js";
import { reconcileMobileChatProtectionState } from "../mobileKeyboardDocking.js";
import { requestIdCrypto as crypto } from "../requestId.js";
import { ChatPanel, type ChatPartyCardActions, type ChatTranslationResult } from "./ChatPanel.js";
import type { ChatPartyRole } from "./ChatPartyListing.js";
import { ChatTopBar } from "./ChatTopBar.js";
import { CommunityRulesAcceptance } from "./CommunityRulesAcceptance.js";
import { OnlinePlayersPanel } from "./OnlinePlayersPanel.js";

type ChatSurfaceProps = {
  store: ChatStore;
  connectionStatus: "offline" | "connecting" | "online";
  playerId: string;
  username: string;
  serverHttpBase: string;
  csrfToken: string;
  socialRefreshToken: number;
  clientRef: RefObject<GameClient | null>;
  historyRequestTracker: ChatHistoryRequestTracker;
  onOpenSender(
    playerId: string,
    displayName: string,
    anchorRect: { left: number; right: number; top: number; bottom: number }
  ): void;
  onMessageSender?(playerId: string, displayName: string): void;
  /** Carried inventory for the Trade Sell picker, read when the listing composer opens. */
  readTradeInventory?(): { inventory: PlayerInventorySnapshot; equipment: EquipmentSnapshotV2 | null } | null;
  /** Hunting party cards: own level (Join gate), party role (Invite visibility), and profile View. */
  ownLevel?: number | null;
  partyRole?: ChatPartyRole;
  onViewPlayerProfile?(playerId: string): void;
  unreadMessageCount?: number;
  messageAttentionRevision?: number;
  messageNotice?: ReactNode;
  onOpenMessages?(): void;
  developerAccessEnabled?: boolean;
  developerMutationEnabled?: boolean;
  onOpenDeveloperTools?(): void;
  onReactMessage?(
    messageId: string,
    reaction: string,
    active: boolean
  ): void | Promise<void>;
  onTranslateMessage?(
    message: ChatMessageView,
    targetLanguage: string
  ): ChatTranslationResult | null | Promise<ChatTranslationResult | null>;
  activeSenderPlayerId?: string | null;
  onChatClosed?(): void;
  onOpenChange?(open: boolean): void;
  onRosterOpenChange?(open: boolean): void;
  openRequestRevision?: number;
  forceClosed?: boolean;
  layout?: "desktop" | "phone";
  utility?: ReactNode;
};

export class ChatSurfaceErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    reconcileMobileChatProtectionState("chat-surface-error");
  }

  override componentDidUpdate(previous: Readonly<{ resetKey: string }>): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        <div className="chat-top-bar chat-top-bar-recovery" aria-label="Chat">
          <strong>General</strong>
          <span>Chat unavailable</span>
        </div>
        <div className="chat-recovery-error" role="alert">
          <span>Chat recovered safely. Gameplay remains available.</span>
          <button type="button" onClick={() => this.setState({ failed: false })}>
            Retry Chat
          </button>
        </div>
      </>
    );
  }
}

export class PublicChatErrorBoundary extends Component<
  { children: ReactNode; onError(): void; resetKey: boolean },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onError();
  }

  override componentDidUpdate(previous: Readonly<{ resetKey: boolean }>): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export const ChatSurface = memo(function ChatSurface({
  store,
  connectionStatus,
  playerId,
  username,
  serverHttpBase,
  csrfToken,
  socialRefreshToken,
  clientRef,
  historyRequestTracker,
  onOpenSender,
  onMessageSender,
  readTradeInventory,
  ownLevel = null,
  partyRole = "none",
  onViewPlayerProfile,
  unreadMessageCount = 0,
  messageAttentionRevision = 0,
  messageNotice = null,
  onOpenMessages,
  developerAccessEnabled = false,
  developerMutationEnabled = false,
  onOpenDeveloperTools,
  onReactMessage,
  onTranslateMessage,
  activeSenderPlayerId = null,
  onChatClosed,
  onOpenChange,
  onRosterOpenChange,
  openRequestRevision = 0,
  forceClosed = false,
  layout = "desktop",
  utility
}: ChatSurfaceProps): React.JSX.Element {
  useLayoutEffect(() => {
    reconcileMobileChatProtectionState("chat-surface");
  }, []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const selectedChannelUsesLiveSession = snapshot.selectedChannel
    ? isLiveSessionChatChannel(snapshot.selectedChannel.channel)
    : false;
  const historySnapshot = useSyncExternalStore(
    historyRequestTracker.subscribe,
    historyRequestTracker.getSnapshot
  );
  const [open, setOpen] = useState(false);
  const [rosterOrigin, setRosterOrigin] = useState<"game" | "chat" | null>(null);
  const handledOpenRequestRevisionRef = useRef(0);
  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);
  useEffect(() => {
    onRosterOpenChange?.(rosterOrigin !== null);
  }, [onRosterOpenChange, rosterOrigin]);
  const [chatError, setChatError] = useState<string | null>(null);
  const communitySafety = useMemo(
    () => new CommunitySafetyApi(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const translationApi = useMemo(
    () => new ChatTranslationApi(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const chatCrestApi = useMemo(
    () => new ChatCrestApi(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const [chatCrestSelection, setChatCrestSelection] = useState<ChatCrestSelection | null>(null);
  useEffect(() => {
    if (connectionStatus !== "online") return;
    let active = true;
    void chatCrestApi.list().then((selection) => {
      if (active) setChatCrestSelection(selection);
    }).catch(() => {
      if (active) setChatCrestSelection(null);
    });
    return () => { active = false; };
  }, [chatCrestApi, connectionStatus, playerId]);
  const equipChatCrest = useCallback(async (crestId: string): Promise<void> => {
    try {
      const selection = await chatCrestApi.equip(crestId);
      setChatCrestSelection(selection);
      store.updateChatCrest(playerId, selection.equippedCrestId);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Chat crest could not be equipped.");
    }
  }, [chatCrestApi, playerId, store]);
  const translateMessage = useCallback(
    (message: ChatMessageView, targetLanguage: string): ChatTranslationResult | null | Promise<ChatTranslationResult | null> => {
      if (!message.id) return null;
      const messageId = message.id;
      return translationApi.translate(messageId, targetLanguage).then((result) => {
        if (isChatTranslationTargetLanguage(targetLanguage)) {
          store.applyTranslation(message.channelKey, messageId, targetLanguage, result);
        }
        return result;
      });
    },
    [store, translationApi]
  );
  const [termsStatus, setTermsStatus] = useState<{
    version: string;
    accepted: boolean;
  } | null>(null);
  const [termsLoading, setTermsLoading] = useState(true);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [termsSurfaceOpen, setTermsSurfaceOpen] = useState(false);
  useEffect(() => {
    let active = true;
    setTermsLoading(true);
    void communitySafety.terms().then((status) => {
      if (!active) return;
      setTermsStatus(status);
      setTermsError(null);
    }).catch((error: unknown) => {
      if (!active) return;
      setTermsError(error instanceof Error ? error.message : "Community Rules are unavailable.");
    }).finally(() => {
      if (active) setTermsLoading(false);
    });
    return () => { active = false; };
  }, [communitySafety, playerId]);
  const acceptTerms = useCallback(async (): Promise<boolean> => {
    if (!termsStatus || termsLoading) return false;
    setTermsLoading(true);
    setTermsError(null);
    try {
      const nextStatus = await communitySafety.acceptTerms(termsStatus.version);
      setTermsStatus(nextStatus);
      return nextStatus.accepted;
    } catch (error) {
      setTermsError(error instanceof Error ? error.message : "Community Rules could not be accepted.");
      return false;
    } finally {
      setTermsLoading(false);
    }
  }, [communitySafety, termsLoading, termsStatus]);
  const reportMessage = useCallback((
    messageId: string,
    category: CommunityReportCategory,
    explanation: string | null
  ): void => {
    void communitySafety.report("message", messageId, category, explanation).catch((error: unknown) => {
      setChatError(error instanceof Error ? error.message : "Message report could not be submitted.");
    });
  }, [communitySafety]);
  const closePanel = useCallback(() => {
    setOpen(false);
    setRosterOrigin(null);
    setTermsSurfaceOpen(false);
    onChatClosed?.();
  }, [onChatClosed]);
  const failPanel = useCallback(() => {
    setOpen(false);
    setRosterOrigin(null);
    setTermsSurfaceOpen(false);
    setChatError("Chat could not open safely. Gameplay has been restored.");
    onChatClosed?.();
  }, [onChatClosed]);
  useEffect(() => {
    if (forceClosed) closePanel();
  }, [closePanel, forceClosed]);
  useEffect(() => {
    if (
      forceClosed ||
      openRequestRevision <= handledOpenRequestRevisionRef.current
    ) return;
    handledOpenRequestRevisionRef.current = openRequestRevision;
    setChatError(null);
    setOpen(true);
  }, [forceClosed, openRequestRevision]);
  useEffect(() => {
    if (snapshot.bootstrapState !== "ready") closePanel();
  }, [closePanel, snapshot.bootstrapState]);
  const [readUpdateCoalescer] = useState(
    () =>
      new ChatReadUpdateCoalescer((channelKey, sequence) => {
        clientRef.current?.updateChatRead(channelKey, sequence);
      })
  );
  const [blockFilter] = useState(
    () => new ChatBlockFilter({ serverHttpBase, csrfToken })
  );
  const blockFilterSnapshot = useSyncExternalStore(
    blockFilter.subscribe,
    blockFilter.getSnapshot
  );

  const blockFilterReady = blockFilterSnapshot.hasValidData;
  const hiddenSenderIds = blockFilterSnapshot.hiddenSenderIds;
  const blockLoadError =
    blockFilterSnapshot.initialLoadError;
  const blockRefreshError = blockFilterSnapshot.refreshError;

  useEffect(() => {
    blockFilter.activate();
    return () => {
      blockFilter.deactivate();
    };
  }, [blockFilter]);

  useEffect(() => {
    blockFilter.setPlayer(playerId, socialRefreshToken);
  }, [blockFilter, playerId, socialRefreshToken]);

  const loadingOlder =
    historySnapshot.active !== null &&
    historySnapshot.active.channelKey === snapshot.selectedChannelKey;

  useEffect(() => {
    readUpdateCoalescer.flush();
    historyRequestTracker.cancelForChannelChange(snapshot.selectedChannelKey);
  }, [historyRequestTracker, readUpdateCoalescer, snapshot.selectedChannelKey]);

  useEffect(
    () => () => {
      readUpdateCoalescer.flush();
    },
    [readUpdateCoalescer]
  );

  useEffect(() => {
    if (connectionStatus !== "online") {
      historyRequestTracker.cancel();
    }
  }, [connectionStatus, historyRequestTracker]);

  useEffect(() => {
    if (
      connectionStatus === "online" &&
      snapshot.selectedChannelKey &&
      snapshot.selectedChannel?.needsRefresh &&
      !selectedChannelUsesLiveSession
    ) {
      const requestId = clientRef.current?.selectChatChannel(snapshot.selectedChannelKey);
      if (requestId) store.expectChannelSelection(snapshot.selectedChannelKey, requestId);
    }
  }, [
    clientRef,
    connectionStatus,
    selectedChannelUsesLiveSession,
    snapshot.selectedChannel?.needsRefresh,
    snapshot.selectedChannelKey,
    store
  ]);

  useEffect(() => {
    const expirations = snapshot.channels
      .map(({ mute }) =>
        mute.muted && mute.expiresAt ? Date.parse(mute.expiresAt) : Number.NaN
      )
      .filter(Number.isFinite);
    if (expirations.length === 0) return;
    const delayMs = Math.max(0, Math.min(...expirations) - Date.now());
    const timer = window.setTimeout(
      () => store.refreshTemporalState(),
      Math.min(delayMs, 2_147_483_647)
    );
    return () => window.clearTimeout(timer);
  }, [snapshot.channels, store]);

  const selectChannel = useCallback(
    (channelKey: ChatChannelKey): void => {
      store.selectChannel(channelKey);
      const selected = store.getSnapshot();
      store.setViewportAtBottom(open, channelKey, selected.newestLoadedSequence);
      if (
        selected.selectedChannel &&
        isLiveSessionChatChannel(selected.selectedChannel.channel)
      ) {
        return;
      }
      const requestId = clientRef.current?.selectChatChannel(channelKey);
      if (requestId) store.expectChannelSelection(channelKey, requestId);
    },
    [clientRef, open, store]
  );
  const handleViewportAtBottom = useCallback(
    (atBottom: boolean, latestSequence: number | null): void => {
      const channelKey = store.getSnapshot().selectedChannelKey;
      const selectedChannel = store.getSnapshot().selectedChannel;
      const readSequence = store.setViewportAtBottom(atBottom, channelKey, latestSequence);
      if (
        atBottom &&
        channelKey &&
        readSequence !== null &&
        selectedChannel &&
        !isLiveSessionChatChannel(selectedChannel.channel)
      ) {
        readUpdateCoalescer.enqueue(channelKey, readSequence);
      } else if (!atBottom) {
        readUpdateCoalescer.flush();
      }
    },
    [readUpdateCoalescer, store]
  );
  useEffect(() => {
    if (
      connectionStatus === "online" &&
      open &&
      snapshot.atBottom &&
      !snapshot.selectedChannel?.hasNewer &&
      snapshot.selectedChannelKey &&
      snapshot.newestLoadedSequence !== null &&
      !selectedChannelUsesLiveSession
    ) {
      readUpdateCoalescer.enqueue(
        snapshot.selectedChannelKey,
        snapshot.newestLoadedSequence
      );
    }
  }, [
    connectionStatus,
    open,
    readUpdateCoalescer,
    selectedChannelUsesLiveSession,
    snapshot.atBottom,
    snapshot.newestLoadedSequence,
    snapshot.selectedChannel?.hasNewer,
    snapshot.selectedChannelKey
  ]);
  const sendMessage = useCallback(
    (body: string): boolean => {
      const channelKey = store.getSnapshot().selectedChannelKey;
      if (!channelKey) return false;
      const requestId = crypto.randomUUID();
      const pending = store.startPending({
        requestId,
        channelKey,
        body,
        senderPlayerId: playerId,
        senderDisplayName: username
      });
      if (!pending.accepted) return false;
      if (!clientRef.current?.sendChatMessage(channelKey, body, requestId)) {
        store.failPending(requestId, "CHAT_DISCONNECTED");
      }
      return true;
    },
    [clientRef, playerId, store, username]
  );
  const postTradeListing = useCallback(
    (listing: ChatTradeListing): boolean => {
      const channelKey = store.getSnapshot().selectedChannelKey;
      if (!channelKey) return false;
      const requestId = crypto.randomUUID();
      const body = chatTradeListingFallbackBody(listing);
      const pending = store.startPending({
        requestId,
        channelKey,
        body,
        senderPlayerId: playerId,
        senderDisplayName: username,
        tradeListing: listing
      });
      if (!pending.accepted) return false;
      if (!clientRef.current?.sendChatMessage(channelKey, body, requestId, listing)) {
        store.failPending(requestId, "CHAT_DISCONNECTED");
      }
      return true;
    },
    [clientRef, playerId, store, username]
  );
  const postPartyListing = useCallback(
    (listing: ChatPartyListingInput): boolean => {
      const channelKey = store.getSnapshot().selectedChannelKey;
      if (!channelKey) return false;
      const requestId = crypto.randomUUID();
      const body = chatPartyListingFallbackBody(listing);
      const pending = store.startPending({
        requestId,
        channelKey,
        body,
        senderPlayerId: playerId,
        senderDisplayName: username,
        partyListing: listing
      });
      if (!pending.accepted) return false;
      if (!clientRef.current?.sendChatMessage(channelKey, body, requestId, undefined, listing)) {
        store.failPending(requestId, "CHAT_DISCONNECTED");
      }
      return true;
    },
    [clientRef, playerId, store, username]
  );
  const onViewPlayerProfileRef = useRef(onViewPlayerProfile);
  onViewPlayerProfileRef.current = onViewPlayerProfile;
  const partyCardActions = useMemo((): ChatPartyCardActions => ({
    join: (messageId) => clientRef.current?.joinPartyListing(messageId) ?? false,
    cancel: (messageId) => clientRef.current?.cancelPartyListing(messageId) ?? false,
    invite: (targetPlayerId) => clientRef.current?.inviteToParty(targetPlayerId) ?? false,
    respond: (joinRequestId, response) => clientRef.current?.respondPartyJoinRequest(joinRequestId, response) ?? false,
    view: (targetPlayerId) => onViewPlayerProfileRef.current?.(targetPlayerId)
  }), [clientRef]);
  // App passes a fresh closure each render; a stable wrapper keeps message rows memoized.
  const onMessageSenderRef = useRef(onMessageSender);
  onMessageSenderRef.current = onMessageSender;
  const messageSender = useCallback((targetPlayerId: string, displayName: string): void => {
    onMessageSenderRef.current?.(targetPlayerId, displayName);
  }, []);
  const readTradeInventoryRef = useRef(readTradeInventory);
  readTradeInventoryRef.current = readTradeInventory;
  const readTradeInventoryStable = useCallback(() => readTradeInventoryRef.current?.() ?? null, []);
  const retryMessage = useCallback(
    (requestId: string): void => {
      const pending = store.retryFailed(requestId);
      if (
        pending &&
        !clientRef.current?.sendChatMessage(pending.channelKey, pending.body, requestId, pending.tradeListing)
      ) {
        store.failPending(requestId, "CHAT_DISCONNECTED");
      }
    },
    [clientRef, store]
  );
  const deleteMessage = useCallback(
    (messageId: string): boolean =>
      (clientRef.current?.deleteChatMessage(messageId) ?? null) !== null,
    [clientRef]
  );
  const loadOlder = useCallback(
    (cursorSequence: number): void => {
      const channelKey = store.getSnapshot().selectedChannelKey;
      const selectedChannel = store.getSnapshot().selectedChannel;
      if (!channelKey || !selectedChannel || isLiveSessionChatChannel(selectedChannel.channel)) {
        return;
      }
      const requestId = clientRef.current?.requestChatHistory(channelKey, "older", cursorSequence) ?? null;
      if (requestId) {
        historyRequestTracker.start({ requestId, channelKey, beforeSequence: cursorSequence });
      }
    },
    [clientRef, historyRequestTracker, store]
  );
  const jumpToNewest = useCallback((): void => {
    const current = store.getSnapshot();
    if (!current.selectedChannelKey) return;
    if (current.selectedChannel && isLiveSessionChatChannel(current.selectedChannel.channel)) {
      return;
    }
    const requestId = clientRef.current?.selectChatChannel(current.selectedChannelKey);
    if (requestId) store.expectChannelSelection(current.selectedChannelKey, requestId);
  }, [clientRef, store]);
  const retryBlockList = useCallback((): void => {
    blockFilter.retry();
  }, [blockFilter]);
  const retryBootstrap = useCallback((): void => {
    store.beginBootstrap();
    if (!clientRef.current?.requestChatBootstrap()) {
      store.markBootstrapUnavailable();
    }
  }, [clientRef, store]);
  const openPanel = useCallback(() => {
    setChatError(null);
    setOpen(true);
  }, []);
  const openTermsSurface = useCallback(() => setTermsSurfaceOpen(true), []);
  const closeTermsSurface = useCallback(() => setTermsSurfaceOpen(false), []);
  const openRosterFromGame = useCallback(() => setRosterOrigin("game"), []);
  const openRosterFromChat = useCallback(() => setRosterOrigin("chat"), []);
  const closeRoster = useCallback(() => setRosterOrigin(null), []);
  const returnToGameFromRoster = useCallback(() => {
    setRosterOrigin(null);
    setOpen(false);
    onChatClosed?.();
  }, [onChatClosed]);
  return (
    <>
      <ChatTopBar
        snapshot={snapshot}
        disabled={connectionStatus !== "online"}
        open={open}
        hiddenSenderIds={hiddenSenderIds}
        blockFilterReady={blockFilterReady}
        blockLoadError={blockLoadError}
        onOpen={openPanel}
        onOpenOnlinePlayers={openRosterFromGame}
        onRetryBootstrap={retryBootstrap}
        onSelectChannel={selectChannel}
        unreadMessageCount={unreadMessageCount}
        messageAttentionRevision={messageAttentionRevision}
        messageNotice={messageNotice}
        developerAccessEnabled={developerAccessEnabled}
        {...(onOpenDeveloperTools ? { onOpenDeveloperTools } : {})}
        {...(onOpenMessages ? { onOpenMessages } : {})}
        utility={utility}
      />
      {chatError ? (
        <div className="chat-recovery-error" role="alert">
          <span>{chatError}</span>
          <button type="button" onClick={() => setChatError(null)}>Dismiss</button>
        </div>
      ) : null}
      <PublicChatErrorBoundary resetKey={open} onError={failPanel}>
        <ChatPanel
          open={open && rosterOrigin === null}
          snapshot={snapshot}
          connectionStatus={connectionStatus}
          loadingOlder={loadingOlder}
          hiddenSenderIds={hiddenSenderIds}
          blockFilterReady={blockFilterReady}
          blockLoadError={blockLoadError}
          blockRefreshError={blockRefreshError}
          ownPlayerId={playerId}
          onSelectChannel={selectChannel}
          onSend={sendMessage}
          onPostTradeListing={postTradeListing}
          readTradeInventory={readTradeInventoryStable}
          onPostPartyListing={postPartyListing}
          partyCardActions={partyCardActions}
          ownLevel={ownLevel}
          partyRole={partyRole}
          onRetry={retryMessage}
          onDeleteMessage={deleteMessage}
          onLoadOlder={loadOlder}
          onViewportAtBottom={handleViewportAtBottom}
          onJumpToNewest={jumpToNewest}
          onOpenSender={onOpenSender}
          activeSenderPlayerId={activeSenderPlayerId}
          {...(onMessageSender ? { onMessageSender: messageSender } : {})}
          onRetryBlockList={retryBlockList}
          onProtectionFailure={failPanel}
          onOpenOnlinePlayers={openRosterFromChat}
          onClose={closePanel}
          developerMutationEnabled={developerMutationEnabled}
          termsAccepted={termsStatus?.accepted === true}
          onOpenTerms={openTermsSurface}
          onReportMessage={reportMessage}
          {...(onReactMessage ? { onReactMessage } : {})}
          onTranslateMessage={onTranslateMessage ?? translateMessage}
          chatCrestSelection={chatCrestSelection}
          onEquipChatCrest={equipChatCrest}
        />
      </PublicChatErrorBoundary>
      <CommunityRulesAcceptance
        open={termsSurfaceOpen}
        layout={layout}
        termsLoading={termsLoading}
        termsStatusReady={termsStatus !== null}
        termsError={termsError}
        onAcceptTerms={acceptTerms}
        onClose={closeTermsSurface}
      />
      <OnlinePlayersPanel
        open={rosterOrigin !== null}
        layout={layout}
        players={snapshot.onlinePlayerCount?.players ?? []}
        phoneBackLabel={rosterOrigin === "chat" ? "Back to Atlas Chats" : "Back to Game"}
        onBack={closeRoster}
        onReturnToGame={returnToGameFromRoster}
      />
    </>
  );
});

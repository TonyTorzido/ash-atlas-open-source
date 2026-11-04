import { useUiPresentation } from "../uiEnvironment.js";
import {
  CHAT_ACTIVE_MESSAGE_LIMIT,
  CHAT_FAILED_MESSAGE_LIMIT,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_PENDING_MESSAGE_LIMIT,
  CHAT_HUNTING_CHANNEL_KEY,
  CHAT_TRADE_CHANNEL_KEY,
  CHAT_TRANSLATION_TARGET_LANGUAGES,
  type ChatCrestSelection,
  type ChatChannelKey,
  type ChatPartyListingInput,
  type ChatPartyListingState,
  type ChatTradeListing,
  type EquipmentSnapshotV2,
  type PlayerInventorySnapshot,
  type ChatTranslationTargetLanguage
} from "@ash-atlas/shared";
import {
  useCallback,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";

import {
  chatCharacterCount,
  normalizeChatBody,
  type ChatMessageView,
  type ChatStoreSnapshot
} from "../chat/chatStore.js";
import { chatCrestAssetUrl, normalizedChatCrestId } from "../chat/chatCrestPresentation.js";
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
  createBottomPinScheduler,
  installTouchScrollBoundaryGuard,
  preserveFocusedTextEntryOnPointerDown,
  setProgrammaticScrollTop
} from "./chatScroll.js";
import type { CommunityReportCategory } from "../community/communitySafetyClient.js";
import { CommunityReportPrompt } from "./CommunityReportPrompt.js";
import { GameAppTabs } from "./GameAppShell.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { ChatTradeListingCard, ChatTradeListingComposer } from "./ChatTradeListing.js";
import {
  ChatPartyJoinRequestCard,
  ChatPartyListingCard,
  ChatPartyListingComposer,
  type ChatPartyRole
} from "./ChatPartyListing.js";

/** Hunting party-card commands; one stable object so message rows stay memoized. */
export type ChatPartyCardActions = Readonly<{
  join(messageId: string): boolean;
  cancel(messageId: string): boolean;
  invite(targetPlayerId: string): boolean;
  respond(joinRequestId: string, response: "accept" | "decline"): boolean;
  view(targetPlayerId: string): void;
}>;

const BOTTOM_THRESHOLD_PX = 28;
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1_000;
const CHAT_DELETE_HOLD_CANCEL_EVENT = "ash-atlas-chat-delete-hold-cancel";
const CHAT_UI_PREFERENCES_STORAGE_KEY = "ashAtlas.chat.uiPreferences";
const MAX_RENDERED_CHAT_ROWS =
  CHAT_ACTIVE_MESSAGE_LIMIT + CHAT_PENDING_MESSAGE_LIMIT + CHAT_FAILED_MESSAGE_LIMIT;

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"] as const;
/** The draft length counter stays hidden until the limit is approaching. */
const CHAT_COUNTER_VISIBLE_AT = 350;

const TRANSLATION_LANGUAGES = [
  [CHAT_TRANSLATION_TARGET_LANGUAGES[0], "English"],
  [CHAT_TRANSLATION_TARGET_LANGUAGES[1], "Español"],
  [CHAT_TRANSLATION_TARGET_LANGUAGES[2], "Français"],
  [CHAT_TRANSLATION_TARGET_LANGUAGES[3], "Deutsch"],
  [CHAT_TRANSLATION_TARGET_LANGUAGES[4], "Português"],
  [CHAT_TRANSLATION_TARGET_LANGUAGES[5], "日本語"]
] as const;

type ChatTranslationMode = "off" | "tap";

export type ChatTranslationResult = {
  translatedText: string;
  sourceLanguage?: string;
};

type ChatTranslationState =
  | { status: "loading" | "unavailable"; visible: false }
  | {
      status: "ready";
      translatedText: string;
      sourceLanguage: string | null;
      visible: boolean;
    };

type ChatReactionState = {
  count: number;
  reacted: boolean;
};

type ChatUiPreferences = {
  showReactions: boolean;
  translationMode: ChatTranslationMode;
  preferredLanguage: string;
};

const DEFAULT_CHAT_UI_PREFERENCES: ChatUiPreferences = {
  showReactions: true,
  translationMode: "tap",
  preferredLanguage: browserLanguage()
};

type ChatPanelProps = {
  open: boolean;
  snapshot: ChatStoreSnapshot;
  connectionStatus: "offline" | "connecting" | "online";
  loadingOlder?: boolean;
  hiddenSenderIds?: ReadonlySet<string>;
  blockFilterReady?: boolean;
  blockLoadError?: boolean;
  blockRefreshError?: boolean;
  ownPlayerId?: string;
  onSelectChannel(channelKey: ChatChannelKey): void;
  onSend(body: string): boolean | void;
  /** Trade room only: posts a Buy/Sell listing card. */
  onPostTradeListing?(listing: ChatTradeListing): boolean;
  readTradeInventory?(): { inventory: PlayerInventorySnapshot; equipment: EquipmentSnapshotV2 | null } | null;
  /** Hunting room only: posts a party card. */
  onPostPartyListing?(listing: ChatPartyListingInput): boolean;
  partyCardActions?: ChatPartyCardActions;
  ownLevel?: number | null;
  partyRole?: ChatPartyRole;
  onRetry(requestId: string): void;
  onDeleteMessage?(messageId: string): boolean;
  onLoadOlder(cursorSequence: number): void;
  onViewportAtBottom?(atBottom: boolean, latestSequence: number | null): void;
  onJumpToNewest?(): void;
  onOpenSender?(
    playerId: string,
    displayName: string,
    anchorRect: { left: number; right: number; top: number; bottom: number }
  ): void;
  activeSenderPlayerId?: string | null;
  onMessageSender?(playerId: string, displayName: string): void;
  onRetryBlockList?(): void;
  onProtectionFailure?(reason: string): void;
  onOpenOnlinePlayers?(): void;
  onClose(): void;
  developerMutationEnabled?: boolean;
  termsAccepted?: boolean;
  onOpenTerms?(): void;
  onReportMessage?(
    messageId: string,
    category: CommunityReportCategory,
    explanation: string | null
  ): void | Promise<void>;
  onReactMessage?(
    messageId: string,
    reaction: string,
    active: boolean
  ): void | Promise<void>;
  onTranslateMessage?(
    message: ChatMessageView,
    targetLanguage: string
  ): ChatTranslationResult | null | Promise<ChatTranslationResult | null>;
  chatCrestSelection?: ChatCrestSelection | null;
  onEquipChatCrest?(crestId: string): void | Promise<void>;
};

type ScrollLayout = {
  channelKey: ChatChannelKey | null;
  oldestSequence: number | null;
  newestSequence: number | null;
  scrollHeight: number;
};

type HistoryAnchor = {
  sequence: number;
  viewportOffset: number;
};

type ChatMessagePopoverKind = "actions" | "reactions";

type ChatMessagePopover = {
  messageKey: string;
  kind: ChatMessagePopoverKind;
};

const CHAT_POPOVER_GUTTER_PX = 8;
const CHAT_POPOVER_GAP_PX = 4;
const CHAT_MESSAGE_POPOVER_MAX_HEIGHT_PX = 320;
const CHAT_SETTINGS_POPOVER_MAX_HEIGHT_PX = 420;

type ChatPopoverPosition = {
  left: number;
  top: number;
  maxHeight: number;
};

function measureChatPopoverPosition(
  anchor: HTMLElement,
  popover: HTMLElement,
  options: { align: "start" | "end"; maxHeight: number }
): ChatPopoverPosition {
  const anchorRect = anchor.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewportWidth = Math.max(window.innerWidth, document.documentElement.clientWidth || 0);
  const viewportHeight = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
  const panel = anchor.closest<HTMLElement>("#public-chat-panel");
  const panelRect = panel?.getBoundingClientRect();
  const panelHasGeometry = Boolean(panelRect && panelRect.width > 0 && panelRect.height > 0);
  const availableLeft = panelHasGeometry
    ? Math.max(CHAT_POPOVER_GUTTER_PX, panelRect!.left + CHAT_POPOVER_GUTTER_PX)
    : CHAT_POPOVER_GUTTER_PX;
  const availableRight = panelHasGeometry
    ? Math.min(viewportWidth - CHAT_POPOVER_GUTTER_PX, panelRect!.right - CHAT_POPOVER_GUTTER_PX)
    : viewportWidth - CHAT_POPOVER_GUTTER_PX;
  const width = Math.min(
    popoverRect.width,
    Math.max(0, availableRight - availableLeft)
  );
  const preferredLeft = options.align === "end"
    ? anchorRect.right - width
    : anchorRect.left;
  const left = Math.min(
    Math.max(availableLeft, preferredLeft),
    Math.max(availableLeft, availableRight - width)
  );
  const composer = panel?.querySelector<HTMLElement>(".chat-composer");
  const composerRect = composer?.getBoundingClientRect();
  const composerHasGeometry = Boolean(composerRect && composerRect.height > 0);
  const availableTop = panelHasGeometry
    ? Math.max(CHAT_POPOVER_GUTTER_PX, panelRect!.top + CHAT_POPOVER_GUTTER_PX)
    : CHAT_POPOVER_GUTTER_PX;
  const availableBottom = Math.max(
    availableTop,
    Math.min(
      viewportHeight - CHAT_POPOVER_GUTTER_PX,
      panelHasGeometry ? panelRect!.bottom - CHAT_POPOVER_GUTTER_PX : viewportHeight - CHAT_POPOVER_GUTTER_PX,
      composerHasGeometry ? composerRect!.top - CHAT_POPOVER_GUTTER_PX : viewportHeight - CHAT_POPOVER_GUTTER_PX
    )
  );
  const availableHeight = availableBottom - availableTop;
  const maxHeight = availableHeight > 0
    ? Math.min(options.maxHeight, availableHeight)
    : options.maxHeight;
  const contentHeight = Math.max(popover.scrollHeight, popoverRect.height);
  const height = Math.min(contentHeight || maxHeight, maxHeight);
  const belowTop = anchorRect.bottom + CHAT_POPOVER_GAP_PX;
  const aboveTop = anchorRect.top - height - CHAT_POPOVER_GAP_PX;
  const top = belowTop + height <= availableBottom
    ? belowTop
    : Math.max(availableTop, aboveTop);
  return { left, top, maxHeight };
}

export function ChatPanel({
  open,
  snapshot,
  connectionStatus,
  loadingOlder = false,
  hiddenSenderIds,
  blockFilterReady = true,
  blockLoadError = false,
  blockRefreshError = false,
  ownPlayerId,
  onSelectChannel,
  onSend,
  onPostTradeListing,
  readTradeInventory,
  onPostPartyListing,
  partyCardActions,
  ownLevel = null,
  partyRole = "none",
  onRetry,
  onDeleteMessage,
  onLoadOlder,
  onViewportAtBottom,
  onJumpToNewest,
  onOpenSender,
  activeSenderPlayerId = null,
  onMessageSender,
  onRetryBlockList,
  onProtectionFailure,
  onOpenOnlinePlayers = () => undefined,
  onClose,
  developerMutationEnabled = false,
  termsAccepted = true,
  onOpenTerms,
  onReportMessage,
  onReactMessage,
  onTranslateMessage,
  chatCrestSelection = null,
  onEquipChatCrest
}: ChatPanelProps): React.JSX.Element | null {
  const [draft, setDraft] = useState("");
  const [tradeListingOpen, setTradeListingOpen] = useState(false);
  const [partyListingOpen, setPartyListingOpen] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ReadonlySet<string>>(() => new Set());
  const [followLive, setFollowLive] = useState(true);
  const desktopPresentation = useUiPresentation() === "desktop";
  const [chatPreferences, setChatPreferences] = useState<ChatUiPreferences>(
    readChatUiPreferences
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messagePopover, setMessagePopover] = useState<ChatMessagePopover | null>(null);
  const [mobileActionsMessageKey, setMobileActionsMessageKey] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settingsPopoverRef = useRef<HTMLDivElement | null>(null);
  const [settingsPosition, setSettingsPosition] = useState<ChatPopoverPosition | null>(null);
  const followLiveRef = useRef(true);
  // True while a message's toolbar or menu is open, so live messages don't scroll it away.
  const messageInteractionRef = useRef(false);
  const programmaticScrollRef = useRef(0);
  const jumpToNewestPendingRef = useRef(false);
  const previousLayoutRef = useRef<ScrollLayout | null>(null);
  const pendingHistoryAnchorRef = useRef<HistoryAnchor | null>(null);
  const bottomPinScheduler = useMemo(
    () =>
      createBottomPinScheduler(
        () => listRef.current,
        () => followLiveRef.current && !messageInteractionRef.current,
        programmaticScrollRef
      ),
    []
  );
  const selected = snapshot.selectedChannel;
  const openMessagePopover = useCallback(
    (messageKey: string, kind: ChatMessagePopoverKind): void => {
      setMessagePopover({ messageKey, kind });
    },
    []
  );
  const closeMessagePopover = useCallback((): void => {
    setMessagePopover(null);
  }, []);
  const revealMobileActions = useCallback((messageKey: string): void => {
    setMobileActionsMessageKey(messageKey);
  }, []);
  useEffect(() => {
    const interacting = mobileActionsMessageKey !== null || messagePopover !== null;
    messageInteractionRef.current = interacting;
    // Catch up on anything that arrived while the toolbar or menu held the view still.
    if (!interacting && followLiveRef.current) bottomPinScheduler.schedule();
  }, [bottomPinScheduler, messagePopover, mobileActionsMessageKey]);
  useEffect(() => {
    writeChatUiPreferences(chatPreferences);
  }, [chatPreferences]);
  useEffect(() => {
    if (!settingsOpen) return;
    const closeSettings = (event: PointerEvent): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        (
          settingsRef.current?.contains(target) ||
          target.closest('[data-chat-settings-popover-layer="true"]')
        )
      ) return;
      setSettingsOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", closeSettings, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeSettings, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [settingsOpen]);
  useLayoutEffect(() => {
    if (!settingsOpen) {
      setSettingsPosition(null);
      return;
    }
    const anchor = settingsTriggerRef.current;
    const popover = settingsPopoverRef.current;
    if (!anchor || !popover) return;
    const positionPopover = (): void => {
      const next = measureChatPopoverPosition(anchor, popover, {
        align: document.documentElement.dataset.uiProfile === "phone" ? "end" : "start",
        maxHeight: CHAT_SETTINGS_POPOVER_MAX_HEIGHT_PX
      });
      setSettingsPosition((previous) => (
        previous &&
        Math.abs(previous.left - next.left) < 0.5 &&
        Math.abs(previous.top - next.top) < 0.5 &&
        Math.abs(previous.maxHeight - next.maxHeight) < 0.5
          ? previous
          : next
      ));
    };
    positionPopover();
    const frame = window.requestAnimationFrame(positionPopover);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(positionPopover);
    resizeObserver?.observe(anchor);
    resizeObserver?.observe(popover);
    const panel = anchor.closest<HTMLElement>("#public-chat-panel");
    if (panel) resizeObserver?.observe(panel);
    window.addEventListener("resize", positionPopover);
    window.visualViewport?.addEventListener("resize", positionPopover);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", positionPopover);
      window.visualViewport?.removeEventListener("resize", positionPopover);
    };
  }, [settingsOpen]);
  useEffect(() => {
    if (!mobileActionsMessageKey) return;
    const closeRevealedActions = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        setMobileActionsMessageKey(null);
        return;
      }
      const actionRoot = target.closest<HTMLElement>('[data-chat-message-popover-root]');
      if (actionRoot?.dataset.chatMessagePopoverRoot === mobileActionsMessageKey) return;
      const popoverLayer = target.closest<HTMLElement>('[data-chat-message-popover-layer="true"]');
      if (popoverLayer?.dataset.chatMessageKey === mobileActionsMessageKey) return;
      setMobileActionsMessageKey(null);
    };
    document.addEventListener("pointerdown", closeRevealedActions, true);
    return () => {
      document.removeEventListener("pointerdown", closeRevealedActions, true);
    };
  }, [mobileActionsMessageKey]);
  useEffect(() => {
    if (!messagePopover) return;
    const closeOutside = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-chat-message-popover-open="true"], [data-chat-message-popover-layer="true"]'
        )
      ) {
        return;
      }
      setMessagePopover(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMessagePopover(null);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [messagePopover]);
  useEffect(() => {
    if (!open) {
      setSettingsOpen(false);
      setMessagePopover(null);
      setMobileActionsMessageKey(null);
    }
  }, [open]);
  useEffect(() => {
    setMessagePopover(null);
    setMobileActionsMessageKey(null);
  }, [snapshot.selectedChannelKey]);
  useEffect(() => {
    window.dispatchEvent(new Event(CHAT_DELETE_HOLD_CANCEL_EVENT));
    setMobileActionsMessageKey(null);
  }, [connectionStatus, developerMutationEnabled, open, snapshot.selectedChannelKey]);
  const visibleMessageEntries = useMemo(
    () => snapshot.messages
      .map((message, sourceIndex) => ({ message, sourceIndex }))
      .filter(
        ({ message }) =>
          (blockFilterReady || message.senderPlayerId === ownPlayerId) &&
          !hiddenSenderIds?.has(message.senderPlayerId)
      )
      .slice(-MAX_RENDERED_CHAT_ROWS),
    [blockFilterReady, hiddenSenderIds, ownPlayerId, snapshot.messages]
  );
  const visibleMessages = useMemo(
    () => visibleMessageEntries.map(({ message }) => message),
    [visibleMessageEntries]
  );
  const messagePresentation = useMemo(
    () => visibleMessageEntries.map((entry, index) => {
      const previous = visibleMessageEntries[index - 1];
      const elapsedMs = previous
        ? elapsedChatTime(previous.message.createdAt, entry.message.createdAt)
        : null;
      const continuesGroup = previous !== undefined &&
        entry.sourceIndex === previous.sourceIndex + 1 &&
        entry.message.channelKey === previous.message.channelKey &&
        entry.message.senderPlayerId === previous.message.senderPlayerId &&
        elapsedMs !== null &&
        elapsedMs < MESSAGE_GROUP_WINDOW_MS;
      return {
        message: entry.message,
        showHeader: !continuesGroup,
        showTimeDivider: previous !== undefined &&
          !isSameChatDay(previous.message.createdAt, entry.message.createdAt)
      };
    }),
    [visibleMessageEntries]
  );
  const characterCount = chatCharacterCount(draft);
  const normalizedDraft = normalizeChatBody(draft);
  const muted = selected?.mute.muted ?? false;
  const requiresTerms = selected !== null;
  const canSend =
    connectionStatus === "online" &&
    selected !== null &&
    !muted &&
    (!requiresTerms || termsAccepted) &&
    normalizedDraft.length > 0 &&
    characterCount <= CHAT_MESSAGE_MAX_LENGTH;
  const canPostTradeListing =
    Boolean(onPostTradeListing) &&
    connectionStatus === "online" &&
    selected?.channel.key === CHAT_TRADE_CHANNEL_KEY &&
    !muted &&
    termsAccepted;
  const canPostPartyListing =
    Boolean(onPostPartyListing) &&
    connectionStatus === "online" &&
    selected?.channel.key === CHAT_HUNTING_CHANNEL_KEY &&
    !muted &&
    termsAccepted;
  const partyCards = useMemo(() => partyCardActions
    ? { actions: partyCardActions, ownLevel, partyRole }
    : undefined, [ownLevel, partyCardActions, partyRole]);
  const partyJoinRequests = selected?.channel.type === "party" ? snapshot.partyJoinRequests : [];
  const respondToJoinRequest = (joinRequestId: string, response: "accept" | "decline"): void => {
    if (!partyCardActions?.respond(joinRequestId, response)) return;
    setRespondingRequestIds((current) => new Set([...current, joinRequestId]));
    // The request leaves the list when the server answers; re-enable if it is still there.
    window.setTimeout(() => setRespondingRequestIds((current) => {
      const next = new Set(current);
      next.delete(joinRequestId);
      return next;
    }), 4_000);
  };

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const computed = window.getComputedStyle(textarea);
    const minHeight = Number.parseFloat(computed.minHeight);
    const maxHeight = Number.parseFloat(computed.maxHeight);
    const minimum = Number.isFinite(minHeight) ? minHeight : 44;
    const maximum = Number.isFinite(maxHeight) ? maxHeight : 104;
    const nextHeight = Math.min(maximum, Math.max(minimum, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maximum ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const preventPageZoom = (event: Event): void => event.preventDefault();
    panel.addEventListener("gesturestart", preventPageZoom, { passive: false });
    panel.addEventListener("gesturechange", preventPageZoom, { passive: false });
    return () => {
      panel.removeEventListener("gesturestart", preventPageZoom);
      panel.removeEventListener("gesturechange", preventPageZoom);
    };
  }, [open]);

  useEffect(() => {
    const followSettledComposer = (): void => {
      if (open && followLiveRef.current) bottomPinScheduler.schedule();
    };
    window.addEventListener(MOBILE_KEYBOARD_COMMITTED_EVENT, followSettledComposer);
    window.addEventListener(MOBILE_KEYBOARD_SETTLED_EVENT, followSettledComposer);
    return () => {
      window.removeEventListener(MOBILE_KEYBOARD_COMMITTED_EVENT, followSettledComposer);
      window.removeEventListener(MOBILE_KEYBOARD_SETTLED_EVENT, followSettledComposer);
    };
  }, [bottomPinScheduler, open]);

  useEffect(() => {
    const list = listRef.current;
    if (!open || !list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followLiveRef.current) bottomPinScheduler.schedule();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [bottomPinScheduler, open]);

  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const guard = installTouchScrollBoundaryGuard(list, () => (
      isIosStandaloneMobileChat() &&
      (
        document.activeElement === textareaRef.current ||
        getMobileKeyboardDockingSnapshot().phase !== "closed"
      )
    ));
    return () => guard.dispose();
  }, [open]);

  useEffect(() => () => bottomPinScheduler.cancel(), [bottomPinScheduler]);

  useLayoutEffect(() => {
    const rail = tabStripRef.current?.querySelector<HTMLElement>(".game-app-tabs");
    const activeTab = rail?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!rail || !activeTab) return;
    const leftEdge = activeTab.offsetLeft;
    const rightEdge = leftEdge + activeTab.offsetWidth;
    if (leftEdge < rail.scrollLeft) {
      rail.scrollLeft = leftEdge;
    } else if (rightEdge > rail.scrollLeft + rail.clientWidth) {
      rail.scrollLeft = rightEdge - rail.clientWidth;
    }
  }, [snapshot.channels, snapshot.selectedChannelKey]);

  useLayoutEffect(() => {
    if (!open) {
      bottomPinScheduler.cancel();
      previousLayoutRef.current = null;
      pendingHistoryAnchorRef.current = null;
      followLiveRef.current = true;
      setFollowLive(true);
      jumpToNewestPendingRef.current = false;
      onViewportAtBottom?.(false, snapshot.newestLoadedSequence);
      return;
    }
    const list = listRef.current;
    if (!list) {
      return;
    }
    const previous = previousLayoutRef.current;
    const channelChanged = previous?.channelKey !== snapshot.selectedChannelKey;
    const historyPrepended =
      !channelChanged &&
      previous?.oldestSequence !== null &&
      snapshot.oldestLoadedSequence !== null &&
      snapshot.oldestLoadedSequence < previous.oldestSequence;
    const newestChanged = previous?.newestSequence !== snapshot.newestLoadedSequence;
    const completedJumpToNewest =
      jumpToNewestPendingRef.current && selected?.hasNewer === false;
    const resetFollowLive = channelChanged || previous === null;

    if (resetFollowLive) {
      followLiveRef.current = true;
      setFollowLive(true);
    }

    if (resetFollowLive && selected?.hasNewer && !completedJumpToNewest) {
      pendingHistoryAnchorRef.current = null;
      if (!jumpToNewestPendingRef.current) {
        jumpToNewestPendingRef.current = true;
        onViewportAtBottom?.(false, snapshot.newestLoadedSequence);
        onJumpToNewest?.();
      }
    } else if (resetFollowLive || completedJumpToNewest) {
      pendingHistoryAnchorRef.current = null;
      bottomPinScheduler.schedule();
      followLiveRef.current = true;
      setFollowLive(true);
      jumpToNewestPendingRef.current = false;
      onViewportAtBottom?.(true, snapshot.newestLoadedSequence);
    } else if (historyPrepended) {
      const anchor = pendingHistoryAnchorRef.current;
      const anchorRow = anchor
        ? list.querySelector<HTMLElement>(`[data-chat-sequence="${anchor.sequence}"]`)
        : null;
      if (anchor && anchorRow) {
        setProgrammaticScrollTop(
          list,
          anchorRow.offsetTop - anchor.viewportOffset,
          programmaticScrollRef
        );
      } else {
        setProgrammaticScrollTop(
          list,
          list.scrollTop + Math.max(0, list.scrollHeight - previous.scrollHeight),
          programmaticScrollRef
        );
      }
      pendingHistoryAnchorRef.current = null;
    } else if (followLiveRef.current) {
      bottomPinScheduler.schedule();
      if (newestChanged) {
        onViewportAtBottom?.(true, snapshot.newestLoadedSequence);
      }
    }

    previousLayoutRef.current = {
      channelKey: snapshot.selectedChannelKey,
      oldestSequence: snapshot.oldestLoadedSequence,
      newestSequence: snapshot.newestLoadedSequence,
      scrollHeight: list.scrollHeight
    };
  }, [
    onViewportAtBottom,
    open,
    snapshot.newestLoadedSequence,
    snapshot.oldestLoadedSequence,
    snapshot.selectedChannel?.hasNewer,
    snapshot.selectedChannelKey,
    visibleMessages.length,
    onJumpToNewest,
    bottomPinScheduler
  ]);

  const submit = (): void => {
    if (!canSend) {
      return;
    }
    if (onSend(normalizedDraft) !== false) {
      setDraft("");
      followLiveRef.current = true;
      setFollowLive(true);
      bottomPinScheduler.schedule();
    }
  };

  const jumpToNewest = (): void => {
    followLiveRef.current = true;
    setFollowLive(true);
    if (
      selected &&
      (selected.hasNewer ||
        snapshot.newestLoadedSequence === null ||
        snapshot.newestLoadedSequence < selected.channel.latestSequence)
    ) {
      jumpToNewestPendingRef.current = true;
      onJumpToNewest?.();
      return;
    }
    const list = listRef.current;
    if (list) {
      bottomPinScheduler.schedule();
    }
    onViewportAtBottom?.(true, selected?.channel.latestSequence ?? null);
  };

  const settingsPopoverStyle: CSSProperties = settingsPosition
    ? {
        left: `${settingsPosition.left}px`,
        top: `${settingsPosition.top}px`,
        right: "auto",
        bottom: "auto",
        maxHeight: `${settingsPosition.maxHeight}px`
      }
    : {
        visibility: "hidden"
      };

  return (
    <MobileChatOverlay
      overlayRef={panelRef}
      open={open}
      type="public"
      onRequestClose={onClose}
      {...(onProtectionFailure ? { onProtectionFailure } : {})}
      id="public-chat-panel"
      className="chat-panel"
      aria-label="Chat panel"
      data-mobile-chat-dock-layout
      data-loaded-message-count={snapshot.messages.length}
      data-active-message-cap={CHAT_ACTIVE_MESSAGE_LIMIT}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="chat-panel-header chat-panel-header--modern phone-menu-header phone-menu-header--ledger">
        <div className="chat-panel-heading">
          <h1><DesktopWindowTitle className="chat-panel-phone-title">Atlas Chats</DesktopWindowTitle></h1>
            {connectionStatus === "online" ? (
              <button
                type="button"
                className="chat-panel-online"
                disabled={snapshot.onlinePlayerCount === null}
                onClick={onOpenOnlinePlayers}
                aria-label={snapshot.onlinePlayerCount
                  ? `Open online players, ${snapshot.onlinePlayerCount.count} online`
                  : "Online player count unavailable"}
              >
                {snapshot.onlinePlayerCount?.count.toLocaleString() ?? "—"} online
              </button>
            ) : (
              <span className="chat-panel-connection">{connectionLabel(connectionStatus)}</span>
            )}
          <select
            className="chat-panel-room"
            aria-label="Select expanded chat room"
            value={snapshot.selectedChannelKey ?? ""}
            disabled={snapshot.channels.length === 0}
            onChange={(event) => onSelectChannel(event.currentTarget.value)}
          >
            {snapshot.channels.map(({ channel }) => (
              <option key={channel.key} value={channel.key}>
                {channel.displayName}
              </option>
            ))}
          </select>
        </div>
        <div ref={settingsRef} className="chat-panel-settings">
            <button
              type="button"
              ref={settingsTriggerRef}
              className="chat-settings-trigger"
              aria-label="Settings"
              title="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((current) => !current)}
            >
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M3 5.5h8M15 5.5h2M3 10h2M9 10h8M3 14.5h8M15 14.5h2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="13" cy="5.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="7" cy="10" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="13" cy="14.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
            </button>
            {settingsOpen && typeof document !== "undefined" && document.body
              ? createPortal(
              <div
                ref={settingsPopoverRef}
                className="chat-settings-popover"
                role="dialog"
                aria-label="Chat settings"
                data-chat-settings-popover-layer="true"
                style={settingsPopoverStyle}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="chat-settings-section">
                  <strong>Chat display</strong>
                  <label>
                    <input
                      type="checkbox"
                      checked={chatPreferences.showReactions}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setChatPreferences((current) => ({
                          ...current,
                          showReactions: checked
                        }));
                      }}
                    />
                    Show message reactions
                  </label>
                </div>
                {chatCrestSelection && chatCrestSelection.crests.length > 0 ? (
                  <div className="chat-settings-section chat-settings-crest-section">
                    <strong>Chat crest</strong>
                    <div className="chat-crest-options" role="radiogroup" aria-label="Chat crest">
                      {chatCrestSelection.crests.map((crest) => {
                        const imageUrl = chatCrestAssetUrl(crest.id);
                        return (
                          <label className="chat-crest-option" key={crest.id}>
                            <input
                              type="radio"
                              name="chat-crest"
                              value={crest.id}
                              checked={chatCrestSelection.equippedCrestId === crest.id}
                              onChange={() => onEquipChatCrest?.(crest.id)}
                            />
                            {imageUrl ? (
                              <img
                                className="chat-settings-crest"
                                src={imageUrl}
                                alt=""
                                aria-hidden="true"
                              />
                            ) : null}
                            <span>{crest.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="chat-settings-section">
                  <strong>Message translation</strong>
                  {(["off", "tap"] as const).map((mode) => (
                    <label key={mode}>
                      <input
                        type="radio"
                        name="chat-translation-mode"
                        value={mode}
                        checked={chatPreferences.translationMode === mode}
                        onChange={() => setChatPreferences((current) => ({
                          ...current,
                          translationMode: mode
                        }))}
                      />
                      {translationModeLabel(mode, desktopPresentation)}
                    </label>
                  ))}
                  <label className="chat-settings-language">
                    <span>Preferred language</span>
                    <select
                      value={chatPreferences.preferredLanguage}
                      onChange={(event) => {
                        const preferredLanguage = event.currentTarget.value;
                        setChatPreferences((current) => ({
                          ...current,
                          preferredLanguage
                        }));
                      }}
                    >
                      {TRANSLATION_LANGUAGES.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  {!onTranslateMessage ? (
                    <small>Translation service is not connected yet.</small>
                  ) : null}
                </div>
              </div>,
              document.body
            )
              : null}
        </div>
        <button
          type="button"
          className="panel-close"
          data-mobile-chat-close="true"
          data-phone-label="Back"
          onClick={() => {
            dismissMobileKeyboard();
            onClose();
          }}
          aria-label="Close chat panel"
        >
          Close
        </button>
      </header>

      <div ref={tabStripRef} className="chat-room-tab-strip">
        <GameAppTabs
          ariaLabel="Chat rooms"
          activeTab={snapshot.selectedChannelKey ?? ""}
          tabs={snapshot.channels.map(({ channel, unreadCount }) => ({
            id: channel.key,
            label: channel.displayName,
            ...(unreadCount > 0
              ? {
                  badge: unreadCount > 99 ? "99+" : String(unreadCount),
                  ariaLabel: `${channel.displayName}, ${unreadCount} unread`
                }
              : {})
          }))}
          onChange={(channelKey) => onSelectChannel(channelKey)}
        />
      </div>

      <div className="chat-state-slot">
        {selected?.needsRefresh ? (
          <div className="chat-state-notice" role="status">
            Refreshing messages after a connection gap...
          </div>
        ) : blockLoadError && !blockFilterReady ? (
          <div className="chat-state-notice" role="alert">
            Safety settings unavailable.{" "}
            {onRetryBlockList ? (
              <button type="button" className="game-app-button game-app-button-compact" onClick={onRetryBlockList}>Retry</button>
            ) : null}
          </div>
        ) : blockRefreshError ? (
          <div className="chat-state-notice" role="alert">
            Safety settings could not be refreshed. Using the last successful settings.{" "}
            {onRetryBlockList ? (
              <button type="button" className="game-app-button game-app-button-compact" onClick={onRetryBlockList}>Retry</button>
            ) : null}
          </div>
        ) : !blockFilterReady ? (
          <div className="chat-state-notice" role="status">
            Loading chat safety settings...
          </div>
        ) : null}
      </div>
      <div
        ref={listRef}
        className="chat-message-list"
        data-mobile-chat-message-region
        role="log"
        aria-label={`${selected?.channel.displayName ?? "Chat"} messages`}
        aria-live="off"
        onScroll={(event) => {
          window.dispatchEvent(new Event(CHAT_DELETE_HOLD_CANCEL_EVENT));
          if (programmaticScrollRef.current > 0) {
            return;
          }
          const list = event.currentTarget;
          const atBottom = isNearBottom(list);
          if (atBottom !== followLiveRef.current) {
            followLiveRef.current = atBottom;
            setFollowLive(atBottom);
            if (!atBottom) {
              jumpToNewestPendingRef.current = false;
            }
            onViewportAtBottom?.(atBottom, snapshot.newestLoadedSequence);
            if (atBottom) bottomPinScheduler.schedule();
          }
        }}
      >
        {visibleMessages.length > 0 ? <div className="chat-message-spacer" aria-hidden="true" /> : null}
        {selected?.hasOlder && snapshot.oldestLoadedSequence !== null ? (
          <button
            type="button"
            className="chat-load-older game-app-button game-app-button-compact"
            disabled={loadingOlder}
            onClick={() => {
              const sequence = snapshot.oldestLoadedSequence!;
              const list = listRef.current;
              const anchorRow = list?.querySelector<HTMLElement>(
                `[data-chat-sequence="${sequence}"]`
              );
              pendingHistoryAnchorRef.current = anchorRow && list
                ? { sequence, viewportOffset: anchorRow.offsetTop - list.scrollTop }
                : null;
              onLoadOlder(sequence);
            }}
          >
            {loadingOlder ? "Loading..." : "Load older messages"}
          </button>
        ) : null}
        {visibleMessages.length === 0 ? (
          <div className="chat-empty-state game-app-state game-app-state-empty">No messages in this room yet.</div>
        ) : (
          messagePresentation.map(({ message, showHeader, showTimeDivider }) => (
            <ChatMessageRow
              key={message.key}
              message={message}
              showHeader={showHeader}
              showTimeDivider={showTimeDivider}
              onRetry={onRetry}
              onOpenSender={onOpenSender}
              selected={message.senderPlayerId === activeSenderPlayerId}
              ownPlayerId={ownPlayerId}
              onMessageSender={onMessageSender}
              partyCards={partyCards}
              partyListingState={message.partyListing && message.id ? snapshot.partyListingStates.get(message.id) : undefined}
              canDelete={Boolean(
                developerMutationEnabled &&
                onDeleteMessage &&
                connectionStatus === "online" &&
                selected &&
                selected.channel.historyRetentionPolicy === "durable" &&
                (selected.channel.type === "public" ||
                  selected.channel.type === "city" ||
                  selected.channel.type === "kingdom" ||
                  selected.channel.type === "party") &&
                message.state === "confirmed" &&
                message.status === "confirmed" &&
                message.moderationStatus !== "hidden"
              )}
              onDeleteMessage={onDeleteMessage}
              onReportMessage={onReportMessage}
              onReactMessage={onReactMessage}
              onTranslateMessage={onTranslateMessage}
              messagePopover={messagePopover}
              onOpenMessagePopover={openMessagePopover}
              onCloseMessagePopover={closeMessagePopover}
              mobileActionsRevealed={mobileActionsMessageKey === message.key}
              onRevealMobileActions={revealMobileActions}
              showReactions={chatPreferences.showReactions}
              translationMode={chatPreferences.translationMode}
              preferredLanguage={chatPreferences.preferredLanguage}
            />
          ))
        )}
        {partyJoinRequests.map((request) => (
          <ChatPartyJoinRequestCard
            key={request.joinRequestId}
            request={request}
            busy={respondingRequestIds.has(request.joinRequestId) || connectionStatus !== "online"}
            onView={() => partyCardActions?.view(request.requesterPlayerId)}
            onAccept={() => respondToJoinRequest(request.joinRequestId, "accept")}
            onDecline={() => respondToJoinRequest(request.joinRequestId, "decline")}
          />
        ))}
      </div>

      {!followLive && (snapshot.newMessageCount > 0 || selected?.hasNewer) ? (
        <button
          type="button"
          className="chat-new-messages game-app-button game-app-button-compact"
          aria-live="polite"
          onClick={jumpToNewest}
        >
          {snapshot.newMessageCount > 0
            ? `${snapshot.newMessageCount} new message${snapshot.newMessageCount === 1 ? "" : "s"}`
            : "Jump to newest"}
        </button>
      ) : null}

      {muted ? (
        <div className="chat-muted-state" role="status">
          Chat muted{selected?.mute.reason ? `: ${selected.mute.reason}` : ""}
          {selected?.mute.expiresAt ? ` until ${formatChatTime(selected.mute.expiresAt)}` : ""}
        </div>
      ) : null}
      {selected?.sendFeedback ? (
        <div className="chat-send-feedback" role="alert">
          {selected.sendFeedback.message}
          {selected.sendFeedback.retryAfterMs !== null
            ? ` Try again in ${Math.max(1, Math.ceil(selected.sendFeedback.retryAfterMs / 1_000))}s.`
            : ""}
        </div>
      ) : null}

      <form
        className="chat-composer"
        data-mobile-chat-composer
        data-compose-channel={selected?.channel.key ?? undefined}
        data-compose-channel-type={selected?.channel.type ?? undefined}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="chat-speaking-in" aria-live="polite">
          <span>Speaking in:</span>
          <strong>{selected?.channel.displayName ?? "Chat"}</strong>
        </div>
        {requiresTerms && !termsAccepted ? (
          <button
            type="button"
            className="chat-composer-terms-action game-app-button game-app-button-primary"
            aria-controls="community-rules-acceptance"
            aria-haspopup="dialog"
            disabled={!onOpenTerms}
            onClick={onOpenTerms}
          >
            Review Community Rules to chat
          </button>
        ) : (
          <div className="chat-composer-field">
            <label>
              <span className="sr-only">Message {selected?.channel.displayName ?? "chat"}</span>
              <textarea
                ref={textareaRef}
                value={draft}
                rows={1}
                disabled={connectionStatus !== "online" || selected === null || muted}
                placeholder={
                  muted
                    ? "You are temporarily muted"
                    : selected
                      ? `Message ${selected.channel.displayName}`
                      : "Write a message"
                }
                onPointerDown={prepareMobileChatInputPointerDown}
                onFocus={handleMobileChatInputFocus}
                onChange={(event) => setDraft(limitChatDraft(event.currentTarget.value))}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !(event.nativeEvent as KeyboardEvent).isComposing
                  ) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            </label>
          </div>
        )}
        <div className="chat-composer-actions">
          {canPostPartyListing ? (
            <button
              type="button"
              className="chat-trade-listing-trigger"
              aria-label="Post a party card"
              title="Party finder"
              aria-haspopup="dialog"
              onClick={() => setPartyListingOpen(true)}
            >
              <span aria-hidden="true">+</span>
            </button>
          ) : null}
          {canPostTradeListing ? (
            <button
              type="button"
              className="chat-trade-listing-trigger"
              aria-label="Post a Buy or Sell listing"
              title="Buy / Sell listing"
              aria-haspopup="dialog"
              onClick={() => setTradeListingOpen(true)}
            >
              <span aria-hidden="true">+</span>
            </button>
          ) : null}
          {characterCount >= CHAT_COUNTER_VISIBLE_AT ? (
            <span className={characterCount >= CHAT_MESSAGE_MAX_LENGTH - 40 ? "chat-composer-count near-limit" : "chat-composer-count"}>
              {characterCount}/{CHAT_MESSAGE_MAX_LENGTH}
            </span>
          ) : null}
          <button
            type="submit"
            className="chat-send-button"
            disabled={!canSend}
            onPointerDown={(event) =>
              preserveFocusedTextEntryOnPointerDown(event, textareaRef.current)
            }
          >
            Send
          </button>
        </div>
      </form>
      {partyListingOpen && canPostPartyListing && onPostPartyListing ? (
        <ChatPartyListingComposer
          ownLevel={ownLevel}
          onPost={(listing) => {
            const sent = onPostPartyListing(listing);
            if (sent) {
              followLiveRef.current = true;
              setFollowLive(true);
              bottomPinScheduler.schedule();
            }
            return sent;
          }}
          onClose={() => setPartyListingOpen(false)}
        />
      ) : null}
      {tradeListingOpen && canPostTradeListing && onPostTradeListing ? (
        <ChatTradeListingComposer
          readInventory={() => readTradeInventory?.() ?? null}
          onPost={(listing) => {
            const sent = onPostTradeListing(listing);
            if (sent) {
              followLiveRef.current = true;
              setFollowLive(true);
              bottomPinScheduler.schedule();
            }
            return sent;
          }}
          onClose={() => setTradeListingOpen(false)}
        />
      ) : null}
    </MobileChatOverlay>
  );
}

type ChatMessageRowProps = {
  message: ChatMessageView;
  showHeader: boolean;
  showTimeDivider: boolean;
  onRetry(requestId: string): void;
  onDeleteMessage: ((messageId: string) => boolean) | undefined;
  onReportMessage: ((
    messageId: string,
    category: CommunityReportCategory,
    explanation: string | null
  ) => void | Promise<void>) | undefined;
  onReactMessage: ((messageId: string, reaction: string, active: boolean) => void | Promise<void>) | undefined;
  onTranslateMessage: ((message: ChatMessageView, targetLanguage: string) => ChatTranslationResult | null | Promise<ChatTranslationResult | null>) | undefined;
  messagePopover: ChatMessagePopover | null;
  onOpenMessagePopover(messageKey: string, kind: ChatMessagePopoverKind): void;
  onCloseMessagePopover(): void;
  mobileActionsRevealed: boolean;
  onRevealMobileActions(messageKey: string): void;
  onOpenSender: ((
    playerId: string,
    displayName: string,
    anchorRect: { left: number; right: number; top: number; bottom: number }
  ) => void) | undefined;
  selected: boolean;
  ownPlayerId: string | undefined;
  onMessageSender: ((playerId: string, displayName: string) => void) | undefined;
  partyCards: Readonly<{ actions: ChatPartyCardActions; ownLevel: number | null; partyRole: ChatPartyRole }> | undefined;
  partyListingState: ChatPartyListingState | undefined;
  canDelete: boolean;
  showReactions: boolean;
  translationMode: ChatTranslationMode;
  preferredLanguage: string;
};

const ChatMessageRow = memo(function ChatMessageRow({
  message,
  showHeader,
  showTimeDivider,
  onRetry,
  onDeleteMessage,
  onOpenSender,
  selected,
  ownPlayerId,
  onMessageSender,
  partyCards,
  partyListingState,
  canDelete,
  onReportMessage,
  onReactMessage,
  onTranslateMessage,
  messagePopover,
  onOpenMessagePopover,
  onCloseMessagePopover,
  mobileActionsRevealed,
  onRevealMobileActions,
  showReactions,
  translationMode,
  preferredLanguage
}: ChatMessageRowProps): React.JSX.Element {
  const articleRef = useRef<HTMLElement | null>(null);
  const reactionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdPointerIdRef = useRef<number | null>(null);
  const holdStartRef = useRef<{ x: number; y: number } | null>(null);
  const holdTriggeredRef = useRef(false);
  const lastPointerTypeRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const translationRequestRef = useRef(0);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reactions, setReactions] = useState<Record<string, ChatReactionState>>({});
  const [translation, setTranslation] = useState<ChatTranslationState | null>(null);
  const [sharedTranslationHidden, setSharedTranslationHidden] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<ChatPopoverPosition | null>(null);
  const unavailable = message.status === "deleted" || message.moderationStatus === "hidden";
  const canInteract = message.state === "confirmed" && !unavailable;
  const ownMessage = message.senderPlayerId === ownPlayerId;
  const actionsOpen =
    messagePopover?.messageKey === message.key && messagePopover.kind === "actions";
  const reactionPickerOpen =
    messagePopover?.messageKey === message.key && messagePopover.kind === "reactions";
  const body =
    message.status === "deleted"
      ? "Message deleted"
      : message.moderationStatus === "hidden"
        ? "Message unavailable"
        : message.body;
  const crestId = normalizedChatCrestId(message.chatCrestId);
  const crestUrl = chatCrestAssetUrl(crestId);
  const canTranslate = translationMode !== "off";
  // A translation someone already cached for this viewer's language appears automatically, unless
  // the message is already in that language.
  const sharedTranslation = translationMode !== "off" && !unavailable
    ? message.translations?.[preferredLanguage as ChatTranslationTargetLanguage]
    : undefined;
  const shownTranslation: ChatTranslationState | null =
    translation?.status === "ready" || !sharedTranslation ||
      primaryLanguageCode(sharedTranslation.sourceLanguage) === preferredLanguage
      ? translation
      : {
          status: "ready",
          translatedText: sharedTranslation.translatedText,
          sourceLanguage: sharedTranslation.sourceLanguage ?? null,
          visible: !sharedTranslationHidden
        };
  const clearHold = (suppressClick = false): void => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdStartRef.current = null;
    if (suppressClick) suppressClickRef.current = true;
  };
  const releasePointerCapture = (target: HTMLElement, capturedPointerId?: number): void => {
    const pointerId = capturedPointerId ?? holdPointerIdRef.current;
    if (
      pointerId !== null &&
      typeof target.hasPointerCapture === "function" &&
      typeof target.releasePointerCapture === "function"
    ) {
      try {
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture may be unavailable in embedded webviews.
      }
    }
    holdPointerIdRef.current = null;
  };
  const closeActions = (): void => {
    setPopoverPosition(null);
    onCloseMessagePopover();
  };
  const openActions = (): void => {
    if (!canInteract) return;
    setPopoverPosition(null);
    onOpenMessagePopover(message.key, "actions");
  };
  const openReactions = (): void => {
    if (!canInteract || !showReactions) return;
    setPopoverPosition(null);
    onOpenMessagePopover(message.key, "reactions");
  };
  const openDeletePrompt = (): void => {
    if (!canDelete || deleteBusy || !message.id) return;
    closeActions();
    setConfirmingDelete(true);
  };
  const toggleReaction = (reaction: string): void => {
    const current = reactions[reaction] ?? { count: 0, reacted: false };
    const active = !current.reacted;
    setReactions((previous) => {
      const nextCount = Math.max(0, current.count + (active ? 1 : -1));
      const next = { ...previous };
      if (nextCount === 0) delete next[reaction];
      else next[reaction] = { count: nextCount, reacted: active };
      return next;
    });
    if (onReactMessage && message.id) {
      void Promise.resolve(onReactMessage(message.id, reaction, active)).catch(() => undefined);
    }
    onCloseMessagePopover();
  };
  const copyMessage = async (): Promise<void> => {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(body);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied && typeof document.execCommand === "function") {
      const input = document.createElement("textarea");
      input.value = body;
      input.setAttribute("readonly", "true");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      input.remove();
    }
    setCopyFeedback(copied ? "Copied" : "Copy unavailable");
    window.setTimeout(() => setCopyFeedback(null), 1_500);
  };
  const requestTranslation = (): void => {
    if (shownTranslation?.status === "ready") {
      if (translation?.status === "ready") {
        setTranslation({ ...translation, visible: !translation.visible });
      } else {
        setSharedTranslationHidden((hidden) => !hidden);
      }
      closeActions();
      return;
    }
    closeActions();
    if (!onTranslateMessage) {
      setTranslation({ status: "unavailable", visible: false });
      return;
    }
    const requestId = translationRequestRef.current + 1;
    translationRequestRef.current = requestId;
    setTranslation({ status: "loading", visible: false });
    void Promise.resolve(onTranslateMessage(message, preferredLanguage)).then((result) => {
      if (translationRequestRef.current !== requestId) return;
      if (!result || result.translatedText.trim().length === 0) {
        setTranslation({ status: "unavailable", visible: false });
        return;
      }
      setTranslation({
        status: "ready",
        translatedText: result.translatedText,
        sourceLanguage: result.sourceLanguage ?? null,
        visible: true
      });
    }).catch(() => {
      if (translationRequestRef.current === requestId) {
        setTranslation({ status: "unavailable", visible: false });
      }
    });
  };
  useEffect(() => {
    translationRequestRef.current += 1;
    setTranslation(null);
    setSharedTranslationHidden(false);
  }, [message.key, preferredLanguage, translationMode]);
  const handleMessagePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    lastPointerTypeRef.current = event.pointerType;
    if (
      !canInteract ||
      event.pointerType === "mouse" ||
      (event.button !== undefined && event.button !== 0) ||
      event.isPrimary === false ||
      (event.target instanceof Element && event.target.closest("button"))
    ) return;
    holdPointerIdRef.current = event.pointerId;
    holdStartRef.current = { x: event.clientX, y: event.clientY };
    holdTriggeredRef.current = false;
    suppressClickRef.current = false;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture may be unavailable in embedded webviews.
    }
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      holdTriggeredRef.current = true;
      suppressClickRef.current = true;
      holdStartRef.current = null;
      onRevealMobileActions(message.key);
    }, 500);
  };
  const handleMessagePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const start = holdStartRef.current;
    if (!start || holdTriggeredRef.current || event.pointerId !== holdPointerIdRef.current) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 10) {
      const pointerId = holdPointerIdRef.current;
      clearHold(true);
      releasePointerCapture(event.currentTarget, pointerId ?? undefined);
      holdTriggeredRef.current = false;
    }
  };
  const handleMessagePointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const triggered = holdTriggeredRef.current;
    const pointerId = holdPointerIdRef.current;
    clearHold(triggered);
    releasePointerCapture(event.currentTarget, pointerId ?? undefined);
    if (!triggered) holdTriggeredRef.current = false;
  };
  useEffect(() => {
    const cancelHold = (): void => {
      const activeHold =
        holdTimerRef.current !== null ||
        holdPointerIdRef.current !== null ||
        holdTriggeredRef.current;
      clearHold(activeHold);
      if (activeHold) holdTriggeredRef.current = false;
    };
    window.addEventListener(CHAT_DELETE_HOLD_CANCEL_EVENT, cancelHold);
    return () => {
      window.removeEventListener(CHAT_DELETE_HOLD_CANCEL_EVENT, cancelHold);
      clearHold();
      holdTriggeredRef.current = false;
      suppressClickRef.current = false;
    };
  }, [message.key]);
  useEffect(() => {
    if (!canDelete || message.status === "deleted" || message.moderationStatus === "hidden") {
      setConfirmingDelete(false);
      setDeleteBusy(false);
      clearHold();
      holdTriggeredRef.current = false;
      suppressClickRef.current = false;
    }
  }, [canDelete, message.moderationStatus, message.status]);
  useEffect(() => {
    if (!canInteract && (actionsOpen || reactionPickerOpen)) onCloseMessagePopover();
  }, [actionsOpen, canInteract, onCloseMessagePopover, reactionPickerOpen]);
  useEffect(() => {
    if (message.state !== "confirmed" || message.status === "deleted" || message.moderationStatus === "hidden") {
      setReporting(false);
    }
  }, [message.key, message.moderationStatus, message.state, message.status]);
  useLayoutEffect(() => {
    if (!actionsOpen && !reactionPickerOpen) {
      setPopoverPosition(null);
      return;
    }
    const anchor = reactionPickerOpen ? reactionTriggerRef.current : actionsTriggerRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const positionPopover = (): void => {
      const next = measureChatPopoverPosition(anchor, popover, {
        align: "end",
        maxHeight: CHAT_MESSAGE_POPOVER_MAX_HEIGHT_PX
      });
      setPopoverPosition((previous) => (
        previous &&
        Math.abs(previous.left - next.left) < 0.5 &&
        Math.abs(previous.top - next.top) < 0.5 &&
        Math.abs(previous.maxHeight - next.maxHeight) < 0.5
          ? previous
          : next
      ));
    };

    positionPopover();
    const frame = window.requestAnimationFrame(positionPopover);
    window.addEventListener("resize", positionPopover);
    const list = articleRef.current?.closest<HTMLElement>(".chat-message-list");
    list?.addEventListener("scroll", positionPopover, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", positionPopover);
      list?.removeEventListener("scroll", positionPopover);
    };
  }, [actionsOpen, reactionPickerOpen]);
  const popoverStyle: CSSProperties = popoverPosition
    ? {
        left: `${popoverPosition.left}px`,
        top: `${popoverPosition.top}px`,
        right: "auto",
        bottom: "auto",
        maxHeight: `${popoverPosition.maxHeight}px`
      }
    : {
        left: "8px",
        top: "8px",
        right: "auto",
        bottom: "auto",
        visibility: "hidden"
      };
  return (
    <article
      ref={articleRef}
      className={`chat-message chat-message-${message.state} ${showHeader ? "chat-message-group-start" : "chat-message-group-continuation"}${showTimeDivider ? " chat-message-time-gap" : ""}`}
      data-message-state={message.state}
      data-message-group={showHeader ? "start" : "continuation"}
      data-chat-sequence={message.sequence ?? undefined}
      data-mobile-actions-revealed={mobileActionsRevealed ? "true" : undefined}
      data-own={ownMessage ? "true" : undefined}
      onPointerDown={handleMessagePointerDown}
      onPointerMove={handleMessagePointerMove}
      onPointerUp={handleMessagePointerUp}
      onPointerCancel={(event) => {
        const pointerId = holdPointerIdRef.current;
        if (!holdTriggeredRef.current) {
          clearHold(true);
          holdTriggeredRef.current = false;
        }
        releasePointerCapture(event.currentTarget, pointerId ?? undefined);
      }}
      onLostPointerCapture={() => {
        if (!holdTriggeredRef.current) {
          clearHold(true);
          holdTriggeredRef.current = false;
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!canInteract) return;
        if (lastPointerTypeRef.current && lastPointerTypeRef.current !== "mouse") return;
        openActions();
      }}
      onClick={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        holdTriggeredRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {showTimeDivider ? (
        <div className="chat-time-divider" role="separator">
          <time dateTime={message.createdAt}>{formatChatDay(message.createdAt)}</time>
        </div>
      ) : null}
      {showHeader && crestUrl ? (
        <img
          className="chat-message-crest"
          src={crestUrl}
          alt={`${message.senderDisplayName}'s Chat Crest`}
        />
      ) : null}
      {showHeader ? <div className="chat-message-heading">
        {onOpenSender && message.state === "confirmed" && message.senderPlayerId !== ownPlayerId ? (
          <button
            type="button"
            className={selected ? "chat-player-selected" : undefined}
            aria-pressed={selected}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenSender(message.senderPlayerId, message.senderDisplayName, {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom
              });
            }}
          >
            {message.senderDisplayName}
          </button>
        ) : (
          <strong>{message.senderDisplayName}</strong>
        )}
        <time dateTime={message.createdAt}>{formatChatTime(message.createdAt)}</time>
      </div> : null}
      {!showHeader && message.state === "confirmed" ? (
        <time className="chat-message-hover-time" dateTime={message.createdAt} aria-hidden="true">
          {formatChatTime(message.createdAt)}
        </time>
      ) : null}
      {message.partyListing && !unavailable ? (
        <ChatPartyListingCard
          listing={message.partyListing}
          state={partyListingState}
          createdAt={message.createdAt}
          own={ownMessage}
          confirmed={message.state === "confirmed"}
          ownLevel={partyCards?.ownLevel ?? null}
          partyRole={partyCards?.partyRole ?? "none"}
          onJoin={partyCards && message.id ? () => partyCards.actions.join(message.id!) : undefined}
          onInvite={partyCards ? () => partyCards.actions.invite(message.senderPlayerId) : undefined}
          onClose={partyCards && message.id ? () => partyCards.actions.cancel(message.id!) : undefined}
        />
      ) : message.tradeListing && !unavailable ? (
        <ChatTradeListingCard
          listing={message.tradeListing}
          onMessage={onMessageSender && message.state === "confirmed" && !ownMessage
            ? () => onMessageSender(message.senderPlayerId, message.senderDisplayName)
            : undefined}
        />
      ) : (
        <div className={unavailable ? "chat-message-body unavailable" : "chat-message-body"}>{body}</div>
      )}
      {canInteract ? (
        <div
          className="chat-message-actions"
          data-chat-message-popover-root={message.key}
          data-chat-message-popover-open={actionsOpen || reactionPickerOpen ? "true" : undefined}
        >
          {canTranslate ? (
            <button
              type="button"
              className="chat-message-translate-trigger"
              aria-label={
                shownTranslation?.status === "ready"
                  ? `${shownTranslation.visible ? "Show original" : "Show translation"} for message from ${message.senderDisplayName}`
                  : `Translate message from ${message.senderDisplayName}`
              }
              aria-pressed={shownTranslation?.status === "ready" ? shownTranslation.visible : undefined}
              disabled={shownTranslation?.status === "loading"}
              onClick={(event) => {
                event.stopPropagation();
                requestTranslation();
              }}
            >
              <span aria-hidden="true">文A</span>
            </button>
          ) : null}
          {showReactions ? (
            <>
              <button
                type="button"
                ref={reactionTriggerRef}
                className="chat-message-reaction-trigger"
                aria-label={`React to message from ${message.senderDisplayName}`}
                aria-haspopup="true"
                aria-expanded={reactionPickerOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  if (reactionPickerOpen) closeActions();
                  else openReactions();
                }}
              >
                <span aria-hidden="true">☺</span>
              </button>
            </>
          ) : null}
          <button
            type="button"
            ref={actionsTriggerRef}
            className="chat-message-actions-trigger"
            aria-label={`Actions for message from ${message.senderDisplayName}`}
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            onClick={(event) => {
              event.stopPropagation();
              if (actionsOpen) closeActions();
              else openActions();
            }}
          >
            <span aria-hidden="true">•••</span>
          </button>
        </div>
      ) : null}
      {typeof document !== "undefined" && document.body && (actionsOpen || reactionPickerOpen)
        ? createPortal(
            actionsOpen ? (
              <div
                ref={popoverRef}
                className="chat-message-actions-menu"
                role="menu"
                aria-label={`Actions for message from ${message.senderDisplayName}`}
                data-chat-message-popover-layer="true"
                data-chat-message-key={message.key}
                style={popoverStyle}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                {canTranslate ? (
                  <button type="button" role="menuitem" onClick={requestTranslation}>
                    {shownTranslation?.status === "ready"
                      ? shownTranslation.visible ? "Show original" : "Show translation"
                      : "Translate"}
                  </button>
                ) : null}
                <button type="button" role="menuitem" onClick={() => {
                  closeActions();
                  void copyMessage();
                }}>
                  Copy message
                </button>
                {onReportMessage && message.id && !ownMessage ? (
                  <button type="button" role="menuitem" onClick={() => {
                    closeActions();
                    setReporting(true);
                  }}>
                    Report
                  </button>
                ) : null}
                {canDelete ? (
                  <button type="button" role="menuitem" onClick={openDeletePrompt}>
                    Delete message
                  </button>
                ) : null}
              </div>
            ) : (
              <div
                ref={popoverRef}
                className="chat-reaction-picker"
                role="group"
                aria-label="Choose a reaction"
                data-chat-message-popover-layer="true"
                data-chat-message-key={message.key}
                style={popoverStyle}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                {QUICK_REACTIONS.map((reaction) => (
                  <button
                    key={reaction}
                    type="button"
                    aria-label={`React with ${reaction}`}
                    onClick={() => toggleReaction(reaction)}
                  >
                    {reaction}
                  </button>
                ))}
              </div>
            ),
            document.body
          )
        : null}
      {showReactions && Object.keys(reactions).length > 0 ? (
        <div className="chat-message-reactions" aria-label="Message reactions">
          {Object.entries(reactions).map(([reaction, value]) => (
            <button
              key={reaction}
              type="button"
              aria-label={`${reaction} reaction, ${value.count}`}
              aria-pressed={value.reacted}
              onClick={() => toggleReaction(reaction)}
            >
              <span aria-hidden="true">{reaction}</span> {value.count}
            </button>
          ))}
        </div>
      ) : null}
      {unavailable ? null : shownTranslation?.status === "loading" ? (
        <div className="chat-translation-status" role="status">Translating...</div>
      ) : shownTranslation?.status === "unavailable" ? (
        <div className="chat-translation-status" role="status">
          Translation is not available yet.
        </div>
      ) : shownTranslation?.status === "ready" ? (
        <div className="chat-translation" data-showing-translation={shownTranslation.visible ? "true" : "false"}>
          <small className="chat-translation-header">
            <span aria-hidden="true">文A</span>
            <span>Translated from {languageDisplayName(shownTranslation.sourceLanguage)}</span>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={requestTranslation}>
              {shownTranslation.visible ? "Show original" : "Show translation"}
            </button>
          </small>
          {shownTranslation.visible ? <p>{shownTranslation.translatedText}</p> : null}
        </div>
      ) : null}
      {copyFeedback ? <small className="chat-message-feedback" role="status">{copyFeedback}</small> : null}
      {reporting && onReportMessage && message.id ? (
        <CommunityReportPrompt
          targetLabel={`message from ${message.senderDisplayName}`}
          onSubmit={(category, explanation) => onReportMessage(message.id!, category, explanation)}
          onCancel={() => setReporting(false)}
        />
      ) : null}
      {confirmingDelete ? (
        <GameConfirmationPrompt
          title="Delete this message?"
          detail="This message will appear as [Message deleted]."
          confirmLabel="Delete Message"
          destructive
          busy={deleteBusy}
          onConfirm={() => {
            if (deleteBusy || !onDeleteMessage) return;
            if (onDeleteMessage(message.id!) !== false) {
              setDeleteBusy(true);
            }
          }}
          onCancel={() => {
            if (deleteBusy) return;
            setConfirmingDelete(false);
          }}
        />
      ) : null}
      {message.state === "pending" ? <small>Sending...</small> : null}
      {message.state === "failed" ? (
        <div className="chat-message-failed">
          <small>{message.errorCode ?? "Message failed to send"}</small>
          <button type="button" onClick={() => onRetry(message.requestId)}>
            Retry
          </button>
        </div>
      ) : null}
    </article>
  );
}, chatMessageRowPropsEqual);

function chatMessageRowPropsEqual(
  previous: Readonly<ChatMessageRowProps>,
  next: Readonly<ChatMessageRowProps>
): boolean {
  const left = previous.message;
  const right = next.message;
  return (
    previous.onRetry === next.onRetry &&
    previous.onDeleteMessage === next.onDeleteMessage &&
    previous.onReportMessage === next.onReportMessage &&
    previous.onReactMessage === next.onReactMessage &&
    previous.onTranslateMessage === next.onTranslateMessage &&
    previous.messagePopover === next.messagePopover &&
    previous.onOpenMessagePopover === next.onOpenMessagePopover &&
    previous.onCloseMessagePopover === next.onCloseMessagePopover &&
    previous.onOpenSender === next.onOpenSender &&
    previous.showHeader === next.showHeader &&
    previous.showTimeDivider === next.showTimeDivider &&
    previous.selected === next.selected &&
    previous.ownPlayerId === next.ownPlayerId &&
    previous.onMessageSender === next.onMessageSender &&
    previous.partyCards === next.partyCards &&
    previous.partyListingState === next.partyListingState &&
    previous.canDelete === next.canDelete &&
    previous.mobileActionsRevealed === next.mobileActionsRevealed &&
    previous.showReactions === next.showReactions &&
    previous.translationMode === next.translationMode &&
    previous.preferredLanguage === next.preferredLanguage &&
    left.key === right.key &&
    left.state === right.state &&
    left.sequence === right.sequence &&
    left.senderPlayerId === right.senderPlayerId &&
    left.senderDisplayName === right.senderDisplayName &&
    left.chatCrestId === right.chatCrestId &&
    left.body === right.body &&
    left.tradeListing === right.tradeListing &&
    left.partyListing === right.partyListing &&
    left.createdAt === right.createdAt &&
    left.requestId === right.requestId &&
    left.errorCode === right.errorCode &&
    left.retryAfterMs === right.retryAfterMs &&
    left.status === right.status &&
    left.moderationStatus === right.moderationStatus &&
    left.translations === right.translations
  );
}

function languageDisplayName(code: string | null): string {
  if (!code) return "another language";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function primaryLanguageCode(code: string | null | undefined): string | null {
  return code ? code.split("-")[0]!.toLowerCase() : null;
}

function isSameChatDay(previousCreatedAt: string, createdAt: string): boolean {
  const previous = new Date(previousCreatedAt);
  const current = new Date(createdAt);
  if (!Number.isFinite(previous.getTime()) || !Number.isFinite(current.getTime())) return true;
  return previous.toDateString() === current.toDateString();
}

/** Day-change divider label: "Today", "Yesterday", or a date (year only when not this year). */
function formatChatDay(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" })
  });
}

function elapsedChatTime(previousCreatedAt: string, createdAt: string): number | null {
  const previousTime = Date.parse(previousCreatedAt);
  const currentTime = Date.parse(createdAt);
  const elapsedMs = currentTime - previousTime;
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null;
}

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX;
}

function connectionLabel(
  status: Exclude<ChatPanelProps["connectionStatus"], "online">
): string {
  switch (status) {
    case "connecting":
      return "Connecting...";
    case "offline":
      return "Offline";
  }
}

function formatChatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function limitChatDraft(value: string): string {
  return Array.from(value).slice(0, CHAT_MESSAGE_MAX_LENGTH).join("");
}

function browserLanguage(): string {
  if (typeof navigator === "undefined") return "en";
  const candidate = navigator.language?.split("-")[0]?.toLowerCase() ?? "";
  return TRANSLATION_LANGUAGES.some(([value]) => value === candidate) ? candidate : "en";
}

function readChatUiPreferences(): ChatUiPreferences {
  if (typeof window === "undefined") return DEFAULT_CHAT_UI_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(CHAT_UI_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_CHAT_UI_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_CHAT_UI_PREFERENCES;
    const candidate = parsed as Partial<ChatUiPreferences>;
    const translationMode = candidate.translationMode;
    const preferredLanguage = candidate.preferredLanguage;
    return {
      showReactions: typeof candidate.showReactions === "boolean"
        ? candidate.showReactions
        : DEFAULT_CHAT_UI_PREFERENCES.showReactions,
      translationMode: translationMode === "off" || translationMode === "tap"
        ? translationMode
        : DEFAULT_CHAT_UI_PREFERENCES.translationMode,
      preferredLanguage: typeof preferredLanguage === "string" &&
        TRANSLATION_LANGUAGES.some(([value]) => value === preferredLanguage)
        ? preferredLanguage
        : DEFAULT_CHAT_UI_PREFERENCES.preferredLanguage
    };
  } catch {
    return DEFAULT_CHAT_UI_PREFERENCES;
  }
}

function writeChatUiPreferences(preferences: ChatUiPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_UI_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences are best effort when storage is unavailable or full.
  }
}

function translationModeLabel(mode: ChatTranslationMode, desktop: boolean): string {
  switch (mode) {
    case "off":
      return "Off";
    case "tap":
      return desktop ? "Click to translate" : "Tap to translate";
  }
}

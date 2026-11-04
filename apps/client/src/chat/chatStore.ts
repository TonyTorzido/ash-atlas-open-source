import {
  CHAT_ACTIVE_MESSAGE_LIMIT,
  CHAT_CHANNEL_KEYS,
  CHAT_DEFAULT_PINNED_CATEGORIES,
  CHAT_DEDUPE_LIMIT,
  CHAT_FAILED_MESSAGE_LIMIT,
  CHAT_INACTIVE_MESSAGE_LIMIT,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_PENDING_MESSAGE_LIMIT,
  boundedChatPreview,
  isLiveSessionChatChannel,
  type ChatChannel,
  type ChatChannelCategory,
  type ChatChannelKey,
  type ChatMessage,
  type ChatMessagePreview,
  type ChatMessageStatus,
  type ChatPartyJoinRequest,
  type ChatPartyListingState,
  type ChatMessageTranslation,
  type ChatTranslationTargetLanguage,
  type ChatModerationStatus,
  type ChatMuteSnapshot,
  type ChatReadState,
  type ChatConstructionState,
  type PendingChatMessage
} from "@ash-atlas/shared";
import type { OnlinePlayerCount } from "@ash-atlas/shared";

export const CHAT_SELECTED_CHANNEL_STORAGE_KEY = "ashAtlas.chat.selectedChannel";
export const CHAT_CLIENT_CHANNEL_LIMIT = 64;
export const CHAT_STORE_SUBSCRIBER_LIMIT = 32;
export const CHAT_DEDUPE_TTL_MS = 5 * 60_000;
const CHAT_SELECTION_REQUEST_LIMIT = 64;

export type ChatSelectionStorage = Pick<Storage, "getItem" | "setItem">;

export type ChatSendFeedback = {
  code: string;
  message: string;
  retryAfterMs: number | null;
};

export type ChatChannelView = {
  channel: ChatChannel;
  preview: ChatMessagePreview | null;
  readState: ChatReadState;
  mute: ChatMuteSnapshot;
  unreadCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
  needsRefresh: boolean;
  sendFeedback: ChatSendFeedback | null;
};

export type ChatBootstrapState = "loading" | "ready" | "unavailable";

export type ChatMessageView = {
  key: string;
  id: string | null;
  state: ChatConstructionState;
  channelKey: ChatChannelKey;
  sequence: number | null;
  senderPlayerId: string;
  senderDisplayName: string;
  chatCrestId?: ChatMessage["chatCrestId"];
  body: string;
  createdAt: string;
  requestId: string;
  errorCode: string | null;
  retryAfterMs: number | null;
  status: ChatMessageStatus | null;
  moderationStatus: ChatModerationStatus | null;
  /** Shared translations already known for this message, keyed by target language. */
  translations?: ChatMessage["translations"];
  /** Trade-room Buy/Sell card shown in place of the plain body. */
  tradeListing?: ChatMessage["tradeListing"];
  /** Hunting-room party card shown in place of the plain body. */
  partyListing?: ChatMessage["partyListing"];
};

export type ChatStoreSnapshot = {
  bootstrapState: ChatBootstrapState;
  selectedChannelKey: ChatChannelKey | null;
  channels: readonly ChatChannelView[];
  selectedChannel: ChatChannelView | null;
  messages: readonly ChatMessageView[];
  newMessageCount: number;
  atBottom: boolean;
  oldestLoadedSequence: number | null;
  newestLoadedSequence: number | null;
  pendingCount: number;
  failedCount: number;
  pinnedChannelCategories: readonly ChatChannelCategory[];
  onlinePlayerCount: OnlinePlayerCount | null;
  /** Live Hunting card states by message id (server projection). */
  partyListingStates: ReadonlyMap<string, ChatPartyListingState>;
  /** Pending Hunting join requests for the party this player leads. */
  partyJoinRequests: readonly ChatPartyJoinRequest[];
};

export type ChatStoreDiagnostics = {
  channelCount: number;
  activeMessageCount: number;
  largestInactiveMessageCount: number;
  pendingCount: number;
  failedCount: number;
  dedupeCount: number;
  subscriberCount: number;
};

export type StartPendingChatInput = {
  requestId: string;
  channelKey: ChatChannelKey;
  body: string;
  senderPlayerId: string;
  senderDisplayName: string;
  clientCreatedAt?: string;
  tradeListing?: PendingChatMessage["tradeListing"];
  partyListing?: PendingChatMessage["partyListing"];
};

export type StartPendingChatResult =
  | { accepted: true; message: PendingChatMessage }
  | {
      accepted: false;
      reason: "blank" | "too_long" | "pending_limit" | "duplicate_request" | "unknown_channel";
    };

export type ChatChannelsSnapshotInput = {
  channels: readonly ChatChannel[];
  readStates: readonly ChatReadState[];
  previews: readonly ChatMessagePreview[];
  selectedChannelKey: ChatChannelKey;
  pinnedChannelCategories?: readonly ChatChannelCategory[];
  onlinePlayerCount?: OnlinePlayerCount;
};

export type ChatChannelSelectedInput = {
  requestId?: string;
  channelKey: ChatChannelKey;
  messages: readonly ChatMessage[];
  latestSequence: number;
  hasOlder: boolean;
  reset: boolean;
  deletionRevision?: number;
  readState: ChatReadState;
  mute: ChatMuteSnapshot;
};

export type ChatHistoryResultInput = {
  requestId?: string;
  channelKey: ChatChannelKey;
  direction: "older" | "newer";
  messages: readonly ChatMessage[];
  hasMore: boolean;
  latestSequence: number;
  reset: boolean;
  deletionRevision?: number;
};

type ChannelState = {
  channel: ChatChannel;
  messages: ChatMessage[];
  preview: ChatMessagePreview | null;
  readState: ChatReadState;
  mute: ChatMuteSnapshot;
  atBottom: boolean;
  newMessageCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
  needsRefresh: boolean;
  lastFullSequence: number;
  sendFeedback: ChatSendFeedback | null;
};

type ChatStoreOptions = {
  ownPlayerId: string;
  now?: () => number;
  storage?: ChatSelectionStorage | null;
  storageKey?: string;
  dedupeTtlMs?: number;
};

export class ChatStore {
  private readonly ownPlayerId: string;
  private readonly now: () => number;
  private readonly storage: ChatSelectionStorage | null;
  private readonly storageKey: string;
  private readonly dedupeTtlMs: number;
  private readonly channels = new Map<ChatChannelKey, ChannelState>();
  private readonly pending = new Map<string, PendingChatMessage>();
  private readonly failed = new Map<string, PendingChatMessage>();
  private readonly dedupe = new Map<string, number>();
  private readonly confirmedViews = new WeakMap<ChatMessage, ChatMessageView>();
  private readonly listeners = new Set<() => void>();
  private readonly selectionRequestIds = new Set<string>();
  private bootstrapState: ChatBootstrapState = "loading";
  private selectedChannelKey: ChatChannelKey | null = null;
  private latestSelectionRequestId: string | null = null;
  private preferredChannelKey: ChatChannelKey;
  private selectionResolved = false;
  private pinnedChannelCategories: ChatChannelCategory[] = [...CHAT_DEFAULT_PINNED_CATEGORIES];
  private onlinePlayerCount: OnlinePlayerCount | null = null;
  private partyListingStates: ReadonlyMap<string, ChatPartyListingState> = new Map();
  private partyJoinRequests: readonly ChatPartyJoinRequest[] = [];
  private snapshot: ChatStoreSnapshot;

  constructor(options: ChatStoreOptions) {
    this.ownPlayerId = options.ownPlayerId;
    this.now = options.now ?? Date.now;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.storageKey = options.storageKey ?? CHAT_SELECTED_CHANNEL_STORAGE_KEY;
    this.dedupeTtlMs = options.dedupeTtlMs ?? CHAT_DEDUPE_TTL_MS;
    this.preferredChannelKey =
      readSelectedChatChannel(this.storage, this.storageKey) ?? CHAT_CHANNEL_KEYS[0];
    this.snapshot = this.createSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size >= CHAT_STORE_SUBSCRIBER_LIMIT) {
      throw new Error(`ChatStore subscriber limit (${CHAT_STORE_SUBSCRIBER_LIMIT}) exceeded`);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ChatStoreSnapshot => this.snapshot;

  beginBootstrap(): void {
    if (this.bootstrapState === "loading") return;
    this.bootstrapState = "loading";
    this.onlinePlayerCount = null;
    this.publish();
  }

  markBootstrapUnavailable(): void {
    if (this.bootstrapState === "unavailable") return;
    this.bootstrapState = "unavailable";
    this.publish();
  }

  getDiagnostics(): ChatStoreDiagnostics {
    let largestInactiveMessageCount = 0;
    for (const [key, state] of this.channels) {
      if (key !== this.selectedChannelKey) {
        largestInactiveMessageCount = Math.max(largestInactiveMessageCount, state.messages.length);
      }
    }
    return {
      channelCount: this.channels.size,
      activeMessageCount:
        this.selectedChannelKey === null
          ? 0
          : (this.channels.get(this.selectedChannelKey)?.messages.length ?? 0),
      largestInactiveMessageCount,
      pendingCount: this.pending.size,
      failedCount: this.failed.size,
      dedupeCount: this.dedupe.size,
      subscriberCount: this.listeners.size
    };
  }

  applyChannelsSnapshot(input: ChatChannelsSnapshotInput): void {
    const incoming = input.channels
      .filter((channel) => channel.active)
      .slice(0, CHAT_CLIENT_CHANNEL_LIMIT)
      .sort((left, right) => {
        const leftIndex = (CHAT_CHANNEL_KEYS as readonly string[]).indexOf(left.key);
        const rightIndex = (CHAT_CHANNEL_KEYS as readonly string[]).indexOf(right.key);
        return (leftIndex < 0 ? CHAT_CHANNEL_KEYS.length : leftIndex) -
          (rightIndex < 0 ? CHAT_CHANNEL_KEYS.length : rightIndex);
      });
    const readStates = new Map(input.readStates.map((state) => [state.channelKey, state]));
    const previews = new Map(input.previews.map((preview) => [preview.channelKey, preview]));
    const nextChannels = new Map<ChatChannelKey, ChannelState>();

    for (const channel of incoming) {
      const existing = this.channels.get(channel.key);
      const liveSession = isLiveSessionChatChannel(channel);
      const readState = liveSession
        ? (existing?.readState ?? emptyLiveSessionReadState(channel, this.now()))
        : (readStates.get(channel.key) ?? existing?.readState ?? emptyReadState(channel, this.now()));
      const preview = liveSession ? undefined : previews.get(channel.key);
      const latestReceivedSequence = existing?.messages.at(-1)?.sequence ?? 0;
      const latestLoadedSequence = Math.max(
        existing?.lastFullSequence ?? 0,
        latestReceivedSequence
      );
      const existingDeletionRevision = existing?.channel.deletionRevision ?? 0;
      const incomingDeletionRevision = channel.deletionRevision ?? 0;
      nextChannels.set(channel.key, {
        channel: liveSession
          ? {
              ...channel,
              latestSequence: Math.max(
                existing?.channel.latestSequence ?? 0,
                latestReceivedSequence
              )
            }
          : {
              ...channel,
              deletionRevision: Math.max(existingDeletionRevision, incomingDeletionRevision)
            },
        messages: existing?.messages ?? [],
        preview:
          liveSession
            ? (existing?.preview ?? null)
            : preview === undefined
            ? (existing?.preview ?? null)
            : boundedPreview(preview),
        readState: { ...readState },
        mute: existing?.mute ?? unmutedSnapshot(channel.key),
        atBottom: existing?.atBottom ?? false,
        newMessageCount: existing?.newMessageCount ?? 0,
        hasOlder: liveSession ? false : (existing?.hasOlder ?? true),
        hasNewer: liveSession ? false : (existing?.hasNewer ?? false),
        needsRefresh:
          liveSession
            ? false
            : (existing?.needsRefresh === true ||
              channel.latestSequence > latestLoadedSequence ||
              incomingDeletionRevision > existingDeletionRevision),
        lastFullSequence: existing?.lastFullSequence ?? 0,
        sendFeedback: existing?.sendFeedback ?? null
      });
    }

    this.channels.clear();
    for (const [key, state] of nextChannels) {
      this.channels.set(key, state);
    }
    this.removeLocalMessagesForUnknownChannels();

    this.bootstrapState = incoming.length === 0 ? "unavailable" : "ready";
    if (input.pinnedChannelCategories && input.pinnedChannelCategories.length <= 4) {
      this.pinnedChannelCategories = [...input.pinnedChannelCategories];
    }
    if (input.onlinePlayerCount) this.applyOnlinePlayerCount(input.onlinePlayerCount, false);

    const selected = this.resolveSnapshotSelection(input.selectedChannelKey);
    this.setSelectedChannel(selected, false);
    this.enforceChannelMessageCaps();
    this.publish();
  }

  applyOnlinePlayerCount(onlinePlayerCount: OnlinePlayerCount, publish = true): boolean {
    if (
      this.onlinePlayerCount &&
      onlinePlayerCount.revision <= this.onlinePlayerCount.revision
    ) {
      return false;
    }
    this.onlinePlayerCount = { ...onlinePlayerCount };
    if (publish) this.publish();
    return true;
  }

  applyPinnedChannelCategories(categories: readonly ChatChannelCategory[]): void {
    if (categories.length > 4 || new Set(categories).size !== categories.length) return;
    this.pinnedChannelCategories = [...categories];
    this.publish();
  }

  selectChannel(channelKey: ChatChannelKey): boolean {
    if (!this.channels.has(channelKey) || this.selectedChannelKey === channelKey) {
      return this.selectedChannelKey === channelKey;
    }
    this.setSelectedChannel(channelKey, true);
    this.publish();
    return true;
  }

  expectChannelSelection(channelKey: ChatChannelKey, requestId: string): void {
    if (!this.channels.has(channelKey)) return;
    this.latestSelectionRequestId = requestId;
    this.selectionRequestIds.add(requestId);
    while (this.selectionRequestIds.size > CHAT_SELECTION_REQUEST_LIMIT) {
      const oldest = this.selectionRequestIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.selectionRequestIds.delete(oldest);
    }
  }

  applyChannelSelected(input: ChatChannelSelectedInput): void {
    if (!this.acceptSelectionResponse(input.requestId, false)) {
      return;
    }
    const state = this.channels.get(input.channelKey);
    if (!state) {
      return;
    }
    if (isLiveSessionChatChannel(state.channel)) {
      return;
    }
    const wasDetachedFromNewest = state.hasNewer;
    const wasRefreshingGap = state.needsRefresh;
    this.setSelectedChannel(input.channelKey, true);
    const messagesAfterSnapshot = state.messages.filter(
      (message) => message.sequence > input.latestSequence
    );
    const candidates = input.reset || wasDetachedFromNewest || wasRefreshingGap
      ? [...input.messages, ...messagesAfterSnapshot]
      : [...state.messages, ...input.messages];
    state.messages = normalizedMessages(
      candidates,
      input.channelKey,
      "newest",
      CHAT_ACTIVE_MESSAGE_LIMIT
    );
    state.channel = {
      ...state.channel,
      latestSequence: Math.max(state.channel.latestSequence, input.latestSequence),
      deletionRevision: Math.max(
        state.channel.deletionRevision ?? 0,
        input.deletionRevision ?? 0
      )
    };
    state.readState = mergeReadState(state.readState, input.readState);
    state.mute = { ...input.mute };
    state.hasOlder = input.hasOlder;
    state.hasNewer = false;
    state.needsRefresh = false;
    state.lastFullSequence = Math.max(
      state.lastFullSequence,
      input.latestSequence,
      state.messages.at(-1)?.sequence ?? 0
    );
    state.newMessageCount = 0;
    state.sendFeedback = null;
    this.reconcileMessages(state.messages);
    this.rememberMessages(state.messages);
    this.updatePreviewFromMessages(state);
    this.publish();
  }

  applyHistoryResult(input: ChatHistoryResultInput): void {
    if (!this.acceptSelectionResponse(input.requestId)) {
      return;
    }
    const state = this.channels.get(input.channelKey);
    if (!state) {
      return;
    }
    if (isLiveSessionChatChannel(state.channel)) {
      return;
    }
    const mode = input.direction === "older" && !input.reset ? "oldest" : "newest";
    const messagesAfterSnapshot = input.reset
      ? state.messages.filter((message) => message.sequence > input.latestSequence)
      : [];
    const candidates = input.reset
      ? [...input.messages, ...messagesAfterSnapshot]
      : [...state.messages, ...input.messages];
    const messageLimit = this.messageLimitFor(input.channelKey);
    state.messages = normalizedMessages(candidates, input.channelKey, mode, messageLimit);
    const deletionRevisionGap =
      input.deletionRevision !== undefined &&
      input.deletionRevision > (state.channel.deletionRevision ?? 0);
    state.channel = {
      ...state.channel,
      latestSequence: Math.max(state.channel.latestSequence, input.latestSequence),
      deletionRevision: Math.max(
        state.channel.deletionRevision ?? 0,
        input.deletionRevision ?? 0
      )
    };
    if (
      deletionRevisionGap &&
      input.direction === "older" &&
      !input.reset
    ) {
      state.needsRefresh = true;
    }
    if (input.direction === "older" || input.reset) {
      state.hasOlder = input.hasMore;
    }
    if (input.direction === "newer" || input.reset) {
      if (!(deletionRevisionGap && input.direction === "newer" && !input.reset)) {
        state.needsRefresh = false;
      }
      state.lastFullSequence = Math.max(
        state.lastFullSequence,
        input.latestSequence,
        state.messages.at(-1)?.sequence ?? 0
      );
    }
    const newestLoaded = state.messages.at(-1)?.sequence ?? 0;
    state.hasNewer = input.reset
      ? false
      : input.direction === "older"
        ? newestLoaded < state.channel.latestSequence
        : input.hasMore || newestLoaded < state.channel.latestSequence;
    this.reconcileMessages(input.messages);
    this.rememberMessages(input.messages);
    this.updatePreviewFromMessages(state);
    this.publish();
  }

  applySendResult(message: ChatMessage): void {
    this.applyMessage(message);
  }

  applyMessageDeleted(message: ChatMessage, deletionRevision: number): boolean {
    const state = this.channels.get(message.channelKey);
    if (!state || isLiveSessionChatChannel(state.channel)) {
      return false;
    }
    const currentRevision = state.channel.deletionRevision ?? 0;
    const revisionGap = deletionRevision > currentRevision + 1;
    let changed = false;
    const existingById = state.messages.find((item) => item.id === message.id);
    const existingBySequence = state.messages.find((item) => item.sequence === message.sequence);
    if (existingBySequence && existingBySequence.id !== message.id) {
      if (!state.needsRefresh) changed = true;
      state.needsRefresh = true;
    } else if (existingById || existingBySequence) {
      state.messages = state.messages.map((item) =>
        item.id === message.id || item.sequence === message.sequence ? message : item
      );
      changed = true;
    }
    if (deletionRevision > currentRevision) {
      state.channel = { ...state.channel, deletionRevision };
      changed = true;
    }
    if (revisionGap && !state.needsRefresh) {
      state.needsRefresh = true;
      changed = true;
    }
    if (!state.preview || message.sequence >= state.preview.sequence) {
      const nextPreview = boundedPreview(message);
      if (
        !state.preview ||
        state.preview.id !== nextPreview.id ||
        state.preview.body !== nextPreview.body
      ) {
        state.preview = nextPreview;
        changed = true;
      }
    }
    if (changed) this.publish();
    return state.needsRefresh;
  }

  /** Record a shared translation (server push or local API result) on a loaded visible message. */
  applyTranslation(
    channelKey: ChatChannelKey,
    messageId: string,
    targetLanguage: ChatTranslationTargetLanguage,
    translation: ChatMessageTranslation
  ): boolean {
    const state = this.channels.get(channelKey);
    const index = state ? state.messages.findIndex((item) => item.id === messageId) : -1;
    if (!state || index < 0) return false;
    const message = state.messages[index]!;
    if (message.status !== "confirmed" || message.moderationStatus === "hidden") return false;
    const existing = message.translations?.[targetLanguage];
    if (
      existing?.translatedText === translation.translatedText &&
      existing.sourceLanguage === translation.sourceLanguage
    ) return false;
    const next: ChatMessage = {
      ...message,
      translations: {
        ...message.translations,
        [targetLanguage]: {
          translatedText: translation.translatedText,
          ...(translation.sourceLanguage ? { sourceLanguage: translation.sourceLanguage } : {})
        }
      }
    };
    state.messages = state.messages.map((item, itemIndex) => itemIndex === index ? next : item);
    this.publish();
    return true;
  }

  applyMessage(message: ChatMessage): void {
    const state = this.channels.get(message.channelKey);
    if (!state) {
      return;
    }
    const liveSession = isLiveSessionChatChannel(state.channel);
    const reconciled = this.reconcileRequest(message.clientRequestId);
    const idKey = messageIdDedupeKey(message.id);
    const sequenceKey = messageSequenceDedupeKey(message.channelKey, message.sequence);
    this.pruneDedupe();

    const existingById = state.messages.find((item) => item.id === message.id);
    const existingBySequence = state.messages.find((item) => item.sequence === message.sequence);
    if (
      existingById ||
      (existingBySequence && existingBySequence.id === message.id) ||
      this.dedupe.has(idKey) ||
      this.dedupe.has(sequenceKey)
    ) {
      if (reconciled) {
        this.publish();
      }
      return;
    }
    if (existingBySequence && existingBySequence.id !== message.id) {
      if (!liveSession) {
        state.needsRefresh = true;
      }
      this.publish();
      return;
    }

    if (
      !liveSession &&
      !state.hasNewer &&
      state.lastFullSequence > 0 &&
      message.sequence > state.lastFullSequence + 1
    ) {
      state.needsRefresh = true;
    }
    state.lastFullSequence = Math.max(state.lastFullSequence, message.sequence);
    if (liveSession) {
      state.hasOlder = false;
      state.hasNewer = false;
      state.needsRefresh = false;
    }
    state.channel = {
      ...state.channel,
      latestSequence: Math.max(state.channel.latestSequence, message.sequence)
    };
    if (!state.hasNewer) {
      state.messages = normalizedMessages(
        [...state.messages, message],
        message.channelKey,
        "newest",
        this.messageLimitFor(message.channelKey)
      );
    }
    if (!state.preview || message.sequence >= state.preview.sequence) {
      state.preview = boundedPreview(message);
    }
    this.remember(idKey);
    this.remember(sequenceKey);

    const viewingLatest =
      message.channelKey === this.selectedChannelKey && state.atBottom && !state.hasNewer;
    if (message.senderPlayerId !== this.ownPlayerId) {
      if (viewingLatest) {
        state.readState = liveSession
          ? liveSessionReadThrough(state.readState, message.sequence, this.now())
          : readThrough(state.readState, message.sequence, this.now());
      } else {
        state.readState = liveSession
          ? liveSessionUnreadThrough(state.readState, message.sequence, this.now())
          : unreadThrough(state.readState, message.sequence, this.now());
        if (message.channelKey === this.selectedChannelKey) {
          state.newMessageCount += 1;
        }
      }
    } else if (viewingLatest) {
      state.readState = liveSession
        ? liveSessionReadThrough(state.readState, message.sequence, this.now())
        : readThrough(state.readState, message.sequence, this.now());
    } else {
      state.readState = latestPreservingUnread(state.readState, message.sequence, this.now());
    }
    this.publish();
  }

  applyPreviewUpdate(
    preview: ChatMessagePreview,
    latestSequence: number,
    unreadCount: number
  ): void {
    const state = this.channels.get(preview.channelKey);
    if (!state) {
      return;
    }
    if (isLiveSessionChatChannel(state.channel)) {
      return;
    }
    if (!state.preview || preview.sequence >= state.preview.sequence) {
      state.preview = boundedPreview(preview);
    }
    state.channel = {
      ...state.channel,
      latestSequence: Math.max(state.channel.latestSequence, latestSequence)
    };
    const locallyRead =
      preview.channelKey === this.selectedChannelKey && state.atBottom && !state.hasNewer;
    const ownMessageAwayFromLatest =
      preview.senderPlayerId === this.ownPlayerId && !locallyRead;
    state.readState = {
      ...state.readState,
      lastReadSequence: locallyRead
        ? Math.max(state.readState.lastReadSequence, latestSequence)
        : state.readState.lastReadSequence,
      latestSequence: Math.max(state.readState.latestSequence, latestSequence),
      unreadCount: locallyRead
        ? 0
        : ownMessageAwayFromLatest
          ? state.readState.unreadCount
          : Math.max(state.readState.unreadCount, Math.max(0, unreadCount)),
      updatedAt: new Date(this.now()).toISOString()
    };
    this.publish();
  }

  applyReadState(readState: ChatReadState): void {
    const state = this.channels.get(readState.channelKey);
    if (!state) {
      return;
    }
    if (isLiveSessionChatChannel(state.channel)) {
      return;
    }
    state.readState = mergeReadState(state.readState, readState);
    if (state.readState.unreadCount === 0) {
      state.newMessageCount = 0;
    }
    this.publish();
  }

  applyPartyListingStates(states: readonly ChatPartyListingState[]): void {
    this.partyListingStates = new Map(states.map((state) => {
      // Keep unchanged entries identical so memoized message rows skip re-rendering.
      const previous = this.partyListingStates.get(state.messageId);
      return [state.messageId, previous && previous.status === state.status &&
        previous.memberCount === state.memberCount ? previous : state];
    }));
    this.publish();
  }

  applyPartyJoinRequests(requests: readonly ChatPartyJoinRequest[]): void {
    this.partyJoinRequests = requests;
    this.publish();
  }

  applyMuteSnapshot(channelKey: ChatChannelKey, mute: ChatMuteSnapshot): void {
    if (mute.muted && mute.scope === "global") {
      for (const state of this.channels.values()) {
        state.mute = activeMuteSnapshot(mute, this.now());
      }
      this.publish();
      return;
    }
    if (!mute.muted && mute.channelKey === null) {
      let changed = false;
      for (const state of this.channels.values()) {
        if (state.mute.scope === "global") {
          state.mute = unmutedSnapshot(state.channel.key);
          changed = true;
        }
      }
      if (changed) this.publish();
      return;
    }
    const state = this.channels.get(channelKey);
    if (!state) {
      return;
    }
    state.mute = activeMuteSnapshot(mute, this.now());
    this.publish();
  }

  refreshTemporalState(): boolean {
    let changed = false;
    for (const state of this.channels.values()) {
      const next = activeMuteSnapshot(state.mute, this.now());
      if (state.mute.muted && !next.muted) {
        state.mute = next;
        changed = true;
      }
    }
    if (changed) this.publish();
    return changed;
  }

  setSendFeedback(channelKey: ChatChannelKey, feedback: ChatSendFeedback | null): void {
    const state = this.channels.get(channelKey);
    if (!state) {
      return;
    }
    state.sendFeedback = feedback === null ? null : { ...feedback };
    this.publish();
  }

  startPending(input: StartPendingChatInput): StartPendingChatResult {
    if (!this.channels.has(input.channelKey)) {
      return { accepted: false, reason: "unknown_channel" };
    }
    if (this.pending.has(input.requestId) || this.failed.has(input.requestId)) {
      return { accepted: false, reason: "duplicate_request" };
    }
    if (this.pending.size >= CHAT_PENDING_MESSAGE_LIMIT) {
      return { accepted: false, reason: "pending_limit" };
    }
    const body = normalizeChatBody(input.body);
    if (!body) {
      return { accepted: false, reason: "blank" };
    }
    if (chatCharacterCount(body) > CHAT_MESSAGE_MAX_LENGTH) {
      return { accepted: false, reason: "too_long" };
    }
    const message: PendingChatMessage = {
      localId: input.requestId,
      requestId: input.requestId,
      channelKey: input.channelKey,
      body,
      senderPlayerId: input.senderPlayerId,
      senderDisplayName: input.senderDisplayName,
      clientCreatedAt: input.clientCreatedAt ?? new Date(this.now()).toISOString(),
      state: "pending",
      errorCode: null,
      retryAfterMs: null,
      ...(input.tradeListing ? { tradeListing: input.tradeListing } : {}),
      ...(input.partyListing ? { partyListing: input.partyListing } : {})
    };
    this.pending.set(input.requestId, message);
    this.channels.get(input.channelKey)!.sendFeedback = null;
    this.publish();
    return { accepted: true, message };
  }

  failPending(requestId: string, errorCode: string, retryAfterMs: number | null = null): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    this.movePendingToFailed(pending, errorCode, retryAfterMs);
    this.publish();
    return true;
  }

  failAllPending(errorCode = "CHAT_DISCONNECTED"): number {
    const pending = [...this.pending.values()];
    if (pending.length === 0) return 0;
    for (const message of pending) {
      this.movePendingToFailed(message, errorCode, null);
    }
    this.publish();
    return pending.length;
  }

  channelKeyForRequest(requestId: string): ChatChannelKey | null {
    return this.pending.get(requestId)?.channelKey ?? this.failed.get(requestId)?.channelKey ?? null;
  }

  retryFailed(requestId: string): PendingChatMessage | null {
    const failed = this.failed.get(requestId);
    if (!failed || this.pending.size >= CHAT_PENDING_MESSAGE_LIMIT) {
      return null;
    }
    this.failed.delete(requestId);
    const pending: PendingChatMessage = {
      ...failed,
      state: "pending",
      errorCode: null,
      retryAfterMs: null
    };
    this.pending.set(requestId, pending);
    this.publish();
    return pending;
  }

  setViewportAtBottom(
    atBottom: boolean,
    channelKey: ChatChannelKey | null = this.selectedChannelKey,
    visibleLatestSequence?: number | null
  ): number | null {
    if (channelKey === null) {
      return null;
    }
    const state = this.channels.get(channelKey);
    if (!state) {
      return null;
    }
    const previousReadState = state.readState;
    const previousNewMessageCount = state.newMessageCount;
    const changed = state.atBottom !== atBottom;
    state.atBottom = atBottom;
    let readSequence: number | null = null;
    if (atBottom) {
      const newestLoaded = state.messages.at(-1)?.sequence ?? 0;
      readSequence = Math.min(
        state.channel.latestSequence,
        Math.max(0, visibleLatestSequence ?? newestLoaded)
      );
      state.readState = isLiveSessionChatChannel(state.channel)
        ? liveSessionReadThrough(state.readState, readSequence, this.now())
        : readThrough(state.readState, readSequence, this.now());
      if (!state.hasNewer && readSequence >= state.channel.latestSequence) {
        state.newMessageCount = 0;
      }
    }
    if (
      changed ||
      state.readState.lastReadSequence !== previousReadState.lastReadSequence ||
      state.readState.unreadCount !== previousReadState.unreadCount ||
      state.newMessageCount !== previousNewMessageCount
    ) {
      this.publish();
    }
    return atBottom ? readSequence : null;
  }

  private resolveSnapshotSelection(serverSelection: ChatChannelKey): ChatChannelKey | null {
    if (!this.selectionResolved) {
      this.selectionResolved = true;
      if (this.channels.has(this.preferredChannelKey)) {
        return this.preferredChannelKey;
      }
    }
    if (this.selectedChannelKey && this.channels.has(this.selectedChannelKey)) {
      return this.selectedChannelKey;
    }
    if (this.channels.has(serverSelection)) {
      return serverSelection;
    }
    if (this.channels.has(CHAT_CHANNEL_KEYS[0])) {
      return CHAT_CHANNEL_KEYS[0];
    }
    return this.channels.keys().next().value ?? null;
  }

  private setSelectedChannel(channelKey: ChatChannelKey | null, persist: boolean): void {
    const previousKey = this.selectedChannelKey;
    if (previousKey && previousKey !== channelKey) {
      const previous = this.channels.get(previousKey);
      if (previous) {
        previous.messages = previous.messages.slice(-CHAT_INACTIVE_MESSAGE_LIMIT);
        previous.atBottom = false;
        previous.newMessageCount = 0;
      }
    }
    this.selectedChannelKey = channelKey;
    if (channelKey) {
      const selected = this.channels.get(channelKey);
      if (selected) selected.newMessageCount = 0;
      this.preferredChannelKey = channelKey;
      if (persist) {
        writeSelectedChatChannel(channelKey, this.storage, this.storageKey);
      }
    }
  }

  private acceptSelectionResponse(requestId: string | undefined, allowUntracked = true): boolean {
    if (!requestId) return true;
    if (!this.selectionRequestIds.has(requestId)) return allowUntracked;
    this.selectionRequestIds.delete(requestId);
    if (requestId !== this.latestSelectionRequestId) return false;
    this.latestSelectionRequestId = null;
    return true;
  }

  private messageLimitFor(channelKey: ChatChannelKey): number {
    return channelKey === this.selectedChannelKey
      ? CHAT_ACTIVE_MESSAGE_LIMIT
      : CHAT_INACTIVE_MESSAGE_LIMIT;
  }

  private enforceChannelMessageCaps(): void {
    for (const [channelKey, state] of this.channels) {
      const limit = this.messageLimitFor(channelKey);
      if (state.messages.length > limit) {
        state.messages = state.messages.slice(-limit);
      }
    }
  }

  private movePendingToFailed(
    message: PendingChatMessage,
    errorCode: string,
    retryAfterMs: number | null
  ): void {
    this.pending.delete(message.requestId);
    this.failed.set(message.requestId, {
      ...message,
      state: "failed",
      errorCode,
      retryAfterMs
    });
    trimOldestMapEntries(this.failed, CHAT_FAILED_MESSAGE_LIMIT);
  }

  private reconcileMessages(messages: readonly ChatMessage[]): void {
    for (const message of messages) {
      this.reconcileRequest(message.clientRequestId);
    }
  }

  private reconcileRequest(requestId: string): boolean {
    const pending = this.pending.delete(requestId);
    const failed = this.failed.delete(requestId);
    return pending || failed;
  }

  private removeLocalMessagesForUnknownChannels(): void {
    for (const [requestId, message] of this.pending) {
      if (!this.channels.has(message.channelKey)) {
        this.pending.delete(requestId);
      }
    }
    for (const [requestId, message] of this.failed) {
      if (!this.channels.has(message.channelKey)) {
        this.failed.delete(requestId);
      }
    }
  }

  private updatePreviewFromMessages(state: ChannelState): void {
    const latest = state.messages[state.messages.length - 1];
    if (latest && (!state.preview || latest.sequence >= state.preview.sequence)) {
      state.preview = boundedPreview(latest);
    }
  }

  private rememberMessages(messages: readonly ChatMessage[]): void {
    for (const message of messages) {
      this.remember(messageIdDedupeKey(message.id));
      this.remember(messageSequenceDedupeKey(message.channelKey, message.sequence));
    }
  }

  private remember(key: string): void {
    this.pruneDedupe();
    this.dedupe.delete(key);
    this.dedupe.set(key, this.now() + this.dedupeTtlMs);
    trimOldestMapEntries(this.dedupe, CHAT_DEDUPE_LIMIT);
  }

  private pruneDedupe(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.dedupe) {
      if (expiresAt <= now) {
        this.dedupe.delete(key);
      }
    }
    trimOldestMapEntries(this.dedupe, CHAT_DEDUPE_LIMIT);
  }

  private publish(): void {
    this.pruneDedupe();
    this.snapshot = this.createSnapshot();
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private createSnapshot(): ChatStoreSnapshot {
    const channels: ChatChannelView[] = [];
    for (const state of this.channels.values()) {
      channels.push(channelView(state));
    }
    const selectedState =
      this.selectedChannelKey === null ? null : (this.channels.get(this.selectedChannelKey) ?? null);
    const selectedChannel =
      this.selectedChannelKey === null
        ? null
        : (channels.find((view) => view.channel.key === this.selectedChannelKey) ?? null);
    const messages = selectedState ? this.messageViews(selectedState) : [];
    const confirmedSequences = selectedState?.messages.map((message) => message.sequence) ?? [];
    return {
      bootstrapState: this.bootstrapState,
      selectedChannelKey: this.selectedChannelKey,
      channels,
      selectedChannel,
      messages,
      newMessageCount: selectedState?.newMessageCount ?? 0,
      atBottom: selectedState?.atBottom ?? false,
      oldestLoadedSequence: confirmedSequences[0] ?? null,
      newestLoadedSequence: confirmedSequences[confirmedSequences.length - 1] ?? null,
      pendingCount: this.pending.size,
      failedCount: this.failed.size
      ,
      pinnedChannelCategories: this.pinnedChannelCategories,
      onlinePlayerCount: this.onlinePlayerCount,
      partyListingStates: this.partyListingStates,
      partyJoinRequests: this.partyJoinRequests
    };
  }

  private messageViews(state: ChannelState): ChatMessageView[] {
    const views = state.messages.map((message) => this.confirmedMessageView(message));
    for (const message of this.pending.values()) {
      if (message.channelKey === state.channel.key) {
        views.push(localMessageView(message));
      }
    }
    for (const message of this.failed.values()) {
      if (message.channelKey === state.channel.key) {
        views.push(localMessageView(message));
      }
    }
    return views.slice(-CHAT_ACTIVE_MESSAGE_LIMIT - CHAT_PENDING_MESSAGE_LIMIT - CHAT_FAILED_MESSAGE_LIMIT);
  }

  private confirmedMessageView(message: ChatMessage): ChatMessageView {
    const existing = this.confirmedViews.get(message);
    if (existing) return existing;
    const view = confirmedMessageView(message);
    this.confirmedViews.set(message, view);
    return view;
  }

  /** Refresh loaded message projections after the local player equips a crest. */
  updateChatCrest(senderPlayerId: string, chatCrestId: NonNullable<ChatMessage["chatCrestId"]>): void {
    let changed = false;
    for (const state of this.channels.values()) {
      const next = state.messages.map((message) => {
        if (message.senderPlayerId !== senderPlayerId || message.chatCrestId === chatCrestId) {
          return message;
        }
        changed = true;
        return { ...message, chatCrestId };
      });
      state.messages = next;
    }
    if (changed) this.publish();
  }
}

export function normalizeChatBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").trim();
}

export function chatCharacterCount(body: string): number {
  return Array.from(body).length;
}

export function readSelectedChatChannel(
  storage: ChatSelectionStorage | null,
  key = CHAT_SELECTED_CHANNEL_STORAGE_KEY
): ChatChannelKey | null {
  try {
    const selected = storage?.getItem(key)?.trim();
    return selected || null;
  } catch {
    return null;
  }
}

export function writeSelectedChatChannel(
  channelKey: ChatChannelKey,
  storage: ChatSelectionStorage | null,
  key = CHAT_SELECTED_CHANNEL_STORAGE_KEY
): void {
  try {
    storage?.setItem(key, channelKey);
  } catch {
    // Local preference persistence is best effort.
  }
}

function browserStorage(): ChatSelectionStorage | null {
  return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
}

function emptyReadState(channel: ChatChannel, now: number): ChatReadState {
  return {
    channelKey: channel.key,
    lastReadSequence: 0,
    latestSequence: channel.latestSequence,
    unreadCount: channel.latestSequence,
    updatedAt: new Date(now).toISOString()
  };
}

function emptyLiveSessionReadState(channel: ChatChannel, now: number): ChatReadState {
  return {
    channelKey: channel.key,
    lastReadSequence: 0,
    latestSequence: 0,
    unreadCount: 0,
    updatedAt: new Date(now).toISOString()
  };
}

function unmutedSnapshot(channelKey: ChatChannelKey): ChatMuteSnapshot {
  return {
    muted: false,
    channelKey,
    scope: null,
    reason: null,
    expiresAt: null
  };
}

function boundedPreview(message: ChatMessage | ChatMessagePreview): ChatMessagePreview {
  return {
    id: message.id,
    channelKey: message.channelKey,
    sequence: message.sequence,
    senderPlayerId: message.senderPlayerId,
    senderDisplayName: message.senderDisplayName,
    ...(message.chatCrestId ? { chatCrestId: message.chatCrestId } : {}),
    body: boundedChatPreview(message.body),
    serverCreatedAt: message.serverCreatedAt
  };
}

function normalizedMessages(
  messages: readonly ChatMessage[],
  channelKey: ChatChannelKey,
  keep: "oldest" | "newest",
  limit: number
): ChatMessage[] {
  const byId = new Set<string>();
  const bySequence = new Set<number>();
  const normalized = messages
    .filter((message) => message.channelKey === channelKey)
    .sort((a, b) => a.sequence - b.sequence)
    .filter((message) => {
      if (byId.has(message.id) || bySequence.has(message.sequence)) {
        return false;
      }
      byId.add(message.id);
      bySequence.add(message.sequence);
      return true;
    });
  return keep === "oldest"
    ? normalized.slice(0, limit)
    : normalized.slice(-limit);
}

function channelView(state: ChannelState): ChatChannelView {
  return {
    channel: { ...state.channel },
    preview: state.preview === null ? null : { ...state.preview },
    readState: { ...state.readState },
    mute: { ...state.mute },
    unreadCount: state.readState.unreadCount,
    hasOlder: state.hasOlder,
    hasNewer: state.hasNewer,
    needsRefresh: state.needsRefresh,
    sendFeedback: state.sendFeedback === null ? null : { ...state.sendFeedback }
  };
}

function confirmedMessageView(message: ChatMessage): ChatMessageView {
  return {
    key: `message:${message.id}`,
    id: message.id,
    state: "confirmed",
    channelKey: message.channelKey,
    sequence: message.sequence,
    senderPlayerId: message.senderPlayerId,
    senderDisplayName: message.senderDisplayName,
    ...(message.chatCrestId ? { chatCrestId: message.chatCrestId } : {}),
    body: message.body,
    createdAt: message.serverCreatedAt,
    requestId: message.clientRequestId,
    errorCode: null,
    retryAfterMs: null,
    status: message.status,
    moderationStatus: message.moderationStatus,
    ...(message.translations ? { translations: message.translations } : {}),
    ...(message.tradeListing ? { tradeListing: message.tradeListing } : {}),
    ...(message.partyListing ? { partyListing: message.partyListing } : {})
  };
}

function localMessageView(message: PendingChatMessage): ChatMessageView {
  return {
    key: `local:${message.localId}`,
    id: null,
    state: message.state,
    channelKey: message.channelKey,
    sequence: null,
    senderPlayerId: message.senderPlayerId,
    senderDisplayName: message.senderDisplayName,
    body: message.body,
    createdAt: message.clientCreatedAt,
    requestId: message.requestId,
    errorCode: message.errorCode,
    retryAfterMs: message.retryAfterMs,
    status: null,
    moderationStatus: null,
    ...(message.tradeListing ? { tradeListing: message.tradeListing } : {}),
    ...(message.partyListing ? { partyListing: message.partyListing } : {})
  };
}

function readThrough(readState: ChatReadState, sequence: number, now: number): ChatReadState {
  const latestSequence = Math.max(readState.latestSequence, sequence);
  const lastReadSequence = Math.max(readState.lastReadSequence, sequence);
  return {
    ...readState,
    latestSequence,
    lastReadSequence,
    unreadCount: Math.max(0, latestSequence - lastReadSequence),
    updatedAt: new Date(now).toISOString()
  };
}

function unreadThrough(readState: ChatReadState, sequence: number, now: number): ChatReadState {
  const latestSequence = Math.max(readState.latestSequence, sequence);
  const newlyObserved = Math.max(0, latestSequence - readState.latestSequence);
  return {
    ...readState,
    latestSequence,
    unreadCount: readState.unreadCount + newlyObserved,
    updatedAt: new Date(now).toISOString()
  };
}

function liveSessionReadThrough(
  readState: ChatReadState,
  sequence: number,
  now: number
): ChatReadState {
  const latestSequence = Math.max(readState.latestSequence, sequence);
  return {
    ...readState,
    latestSequence,
    lastReadSequence: latestSequence,
    unreadCount: 0,
    updatedAt: new Date(now).toISOString()
  };
}

function liveSessionUnreadThrough(
  readState: ChatReadState,
  sequence: number,
  now: number
): ChatReadState {
  return {
    ...readState,
    latestSequence: Math.max(readState.latestSequence, sequence),
    unreadCount: readState.unreadCount + 1,
    updatedAt: new Date(now).toISOString()
  };
}

function latestPreservingUnread(
  readState: ChatReadState,
  sequence: number,
  now: number
): ChatReadState {
  return {
    ...readState,
    latestSequence: Math.max(readState.latestSequence, sequence),
    updatedAt: new Date(now).toISOString()
  };
}

function mergeReadState(previous: ChatReadState, incoming: ChatReadState): ChatReadState {
  const lastReadSequence = Math.max(previous.lastReadSequence, incoming.lastReadSequence);
  const latestSequence = Math.max(previous.latestSequence, incoming.latestSequence);
  const localReadAdvance = Math.max(0, lastReadSequence - previous.lastReadSequence);
  const incomingReadAdvance = Math.max(0, lastReadSequence - incoming.lastReadSequence);
  const preservedLocalUnread = Math.max(0, previous.unreadCount - localReadAdvance);
  const adjustedIncomingUnread = Math.max(0, incoming.unreadCount - incomingReadAdvance);
  return {
    ...previous,
    lastReadSequence,
    latestSequence,
    unreadCount: Math.max(preservedLocalUnread, adjustedIncomingUnread),
    updatedAt:
      Date.parse(incoming.updatedAt) >= Date.parse(previous.updatedAt)
        ? incoming.updatedAt
        : previous.updatedAt
  };
}

function activeMuteSnapshot(mute: ChatMuteSnapshot, now: number): ChatMuteSnapshot {
  if (!mute.muted || mute.expiresAt === null) return { ...mute };
  const expiresAt = Date.parse(mute.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt > now) return { ...mute };
  return {
    muted: false,
    channelKey: mute.channelKey,
    scope: null,
    reason: null,
    expiresAt: null
  };
}

function messageIdDedupeKey(id: string): string {
  return `id:${id}`;
}

function messageSequenceDedupeKey(channelKey: ChatChannelKey, sequence: number): string {
  return `sequence:${channelKey}:${sequence}`;
}

function trimOldestMapEntries<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

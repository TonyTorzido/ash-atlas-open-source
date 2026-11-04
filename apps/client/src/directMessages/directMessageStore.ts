import {
  DIRECT_MESSAGE_BODY_MAX_LENGTH,
  DIRECT_MESSAGE_HISTORY_LIMIT,
  DIRECT_MESSAGE_LIST_LIMIT,
  type DirectMessage,
  type DirectMessageConversationSummary,
  type DirectMessageEvent,
  type DirectMessagePeerSummary,
  type DirectMessagePreferences,
  type DirectMessageServerMessage,
  type DirectMessageServerStatus
} from "@ash-atlas/shared";

export { DIRECT_MESSAGE_BODY_MAX_LENGTH } from "@ash-atlas/shared";
export const DIRECT_MESSAGE_CONVERSATION_LIMIT = DIRECT_MESSAGE_LIST_LIMIT + 5;
export const DIRECT_MESSAGE_ACTIVE_MESSAGE_LIMIT = DIRECT_MESSAGE_HISTORY_LIMIT * 5;
export const DIRECT_MESSAGE_INACTIVE_MESSAGE_LIMIT = DIRECT_MESSAGE_HISTORY_LIMIT * 2;

export type DirectMessageDeliveryState = "sending" | "sent" | "delivered" | "read" | "failed";
export type DirectMessagePeer = Omit<DirectMessagePeerSummary, "online"> & { online: boolean | null };

export type DirectMessagePreview = {
  body: string;
  senderPlayerId: string;
  sequence: string | null;
  createdAt: string;
};

export type DirectMessageView = {
  key: string;
  id: string | null;
  conversationId: string | null;
  sequence: string | null;
  clientMessageId: string;
  senderPlayerId: string;
  recipientPlayerId: string;
  body: string;
  createdAt: string;
  outgoing: boolean;
  deliveryState: DirectMessageDeliveryState;
  errorCode: string | null;
};

export type DirectConversationView = {
  conversationId: string | null;
  peer: DirectMessagePeer;
  latestMessage: DirectMessagePreview | null;
  latestSequence: string;
  unreadCount: number;
  muted: boolean;
  blocked: boolean;
  canMessage: boolean;
  hasOlderMessages: boolean;
  lastReadSequence: string;
  deliveredThroughSequence: string;
  peerReadThroughSequence: string;
  transient: boolean;
  updatedAt: string;
};

export type DirectMessageGapState = {
  acknowledgedEventCursor: string;
  highestSeenEventCursor: string;
  needsSync: boolean;
  syncing: boolean;
};

export type DirectMessageStoreSnapshot = {
  conversations: readonly DirectConversationView[];
  selectedPeerId: string | null;
  selectedConversation: DirectConversationView | null;
  messages: readonly DirectMessageView[];
  totalUnreadCount: number;
  hasMoreConversations: boolean;
  nextConversationCursor: string | null;
  gap: DirectMessageGapState;
  preferences: DirectMessagePreferences;
  unresolvedSendCount: number;
};

export type OptimisticDirectMessage = {
  conversationId: string | null;
  clientMessageId: string;
  recipientPlayerId: string;
  body: string;
};

export type StartDirectMessageResult =
  | { accepted: true; message: DirectMessageView; send: OptimisticDirectMessage }
  | { accepted: false; reason: "blank" | "too_long" | "blocked" | "duplicate" | "no_recipient" };

export type DirectMessageStoreOptions = {
  ownPlayerId: string;
  now?: () => number;
  createClientMessageId?: () => string;
  conversationLimit?: number;
  activeMessageLimit?: number;
  inactiveMessageLimit?: number;
};

type StoredMessage = {
  key: string;
  id: string | null;
  conversationId: string | null;
  sequence: string | null;
  clientMessageId: string;
  senderPlayerId: string;
  recipientPlayerId: string;
  body: string;
  createdAt: string;
  localOrder: number;
  localState: "sending" | "failed" | null;
  serverStatus: DirectMessageServerStatus | null;
  errorCode: string | null;
};

type ConversationState = {
  conversationId: string | null;
  peer: DirectMessagePeer;
  latestMessage: DirectMessagePreview | null;
  latestSequence: string;
  unreadCount: number;
  muted: boolean;
  blocked: boolean;
  canMessage: boolean;
  hasOlderMessages: boolean;
  lastReadSequence: string;
  deliveredThroughSequence: string;
  peerReadThroughSequence: string;
  transient: boolean;
  updatedAt: string;
  messages: StoredMessage[];
  lastLocalActivity: number;
};

const DEFAULT_PREFERENCES: DirectMessagePreferences = {
  soundsEnabled: true,
  suppressBannersDuringCombat: true
};

export class DirectMessageStore {
  private readonly ownPlayerId: string;
  private readonly now: () => number;
  private readonly createClientMessageId: () => string;
  private readonly conversationLimit: number;
  private readonly activeMessageLimit: number;
  private readonly inactiveMessageLimit: number;
  private readonly conversationsByPeer = new Map<string, ConversationState>();
  private readonly listeners = new Set<() => void>();
  private selectedPeerId: string | null = null;
  private viewingPeerId: string | null = null;
  private nextConversationCursor: string | null = null;
  private preferences: DirectMessagePreferences = DEFAULT_PREFERENCES;
  private acknowledgedEventCursor = "0";
  private highestSeenEventCursor = "0";
  private syncingGap = false;
  private localOrder = 0;
  private snapshot!: DirectMessageStoreSnapshot;

  constructor(options: DirectMessageStoreOptions) {
    this.ownPlayerId = options.ownPlayerId;
    this.now = options.now ?? Date.now;
    this.createClientMessageId = options.createClientMessageId ?? (() => crypto.randomUUID());
    this.conversationLimit = options.conversationLimit ?? DIRECT_MESSAGE_CONVERSATION_LIMIT;
    this.activeMessageLimit = options.activeMessageLimit ?? DIRECT_MESSAGE_ACTIVE_MESSAGE_LIMIT;
    this.inactiveMessageLimit = options.inactiveMessageLimit ?? DIRECT_MESSAGE_INACTIVE_MESSAGE_LIMIT;
    this.rebuildSnapshot();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): DirectMessageStoreSnapshot => this.snapshot;

  openPeer(peer: DirectMessagePeer): void {
    const state = this.conversationsByPeer.get(peer.playerId) ?? this.createTransientConversation(peer);
    state.peer = peer;
    this.selectedPeerId = peer.playerId;
    state.lastLocalActivity = this.now();
    this.sortAndBoundMessages(state);
    this.emit();
  }

  selectPeer(peerId: string | null): void {
    if (peerId !== null && !this.conversationsByPeer.has(peerId)) return;
    this.selectedPeerId = peerId;
    this.emit();
  }

  setViewingPeer(peerId: string | null): void {
    this.viewingPeerId = peerId;
    if (peerId === null) return;
    const state = this.conversationsByPeer.get(peerId);
    if (!state || state.unreadCount === 0) return;
    state.unreadCount = 0;
    this.emit();
  }

  applyConversationPage(input: {
    conversations: readonly DirectMessageConversationSummary[];
    nextCursor: string | null;
    reset: boolean;
  }): void {
    if (input.reset) {
      for (const [peerId, state] of this.conversationsByPeer) {
        if (!state.transient && peerId !== this.selectedPeerId) this.conversationsByPeer.delete(peerId);
      }
    }
    for (const conversation of input.conversations) this.upsertConversation(conversation);
    this.nextConversationCursor = input.nextCursor;
    this.pruneConversations();
    this.emit();
  }

  applyMessagePage(input: {
    conversationId: string;
    peer?: DirectMessagePeer;
    messages: readonly DirectMessage[];
    hasOlder: boolean;
    reset: boolean;
  }): void {
    const state = this.findConversation(input.conversationId) ??
      (input.peer ? this.createTransientConversation(input.peer) : undefined);
    if (!state) return;
    state.conversationId = input.conversationId;
    if (input.peer) state.peer = input.peer;
    state.transient = false;
    if (input.reset) state.messages = state.messages.filter((message) => message.localState !== null);
    for (const message of input.messages) this.mergeAuthoritativeMessage(state, message);
    state.hasOlderMessages = input.hasOlder;
    this.sortAndBoundMessages(state);
    this.refreshLatestFromMessages(state);
    this.emit();
  }

  startOptimisticSend(bodyInput: string, clientMessageId = this.createClientMessageId()): StartDirectMessageResult {
    const state = this.selectedPeerId === null ? undefined : this.conversationsByPeer.get(this.selectedPeerId);
    if (!state) return { accepted: false, reason: "no_recipient" };
    const body = normalizeBody(bodyInput);
    if (body.length === 0) return { accepted: false, reason: "blank" };
    if (Array.from(body).length > DIRECT_MESSAGE_BODY_MAX_LENGTH) return { accepted: false, reason: "too_long" };
    if (state.blocked || !state.canMessage) return { accepted: false, reason: "blocked" };
    if (this.findMessageByClientId(clientMessageId)) return { accepted: false, reason: "duplicate" };

    const createdAt = new Date(this.now()).toISOString();
    const message: StoredMessage = {
      key: `client:${clientMessageId}`,
      id: null,
      conversationId: state.conversationId,
      sequence: null,
      clientMessageId,
      senderPlayerId: this.ownPlayerId,
      recipientPlayerId: state.peer.playerId,
      body,
      createdAt,
      localOrder: ++this.localOrder,
      localState: "sending",
      serverStatus: null,
      errorCode: null
    };
    state.messages.push(message);
    state.latestMessage = { body, senderPlayerId: this.ownPlayerId, sequence: null, createdAt };
    state.lastLocalActivity = this.now();
    this.sortAndBoundMessages(state);
    this.emit();
    return {
      accepted: true,
      message: this.toMessageView(state, message),
      send: { conversationId: state.conversationId, clientMessageId, recipientPlayerId: state.peer.playerId, body }
    };
  }

  acknowledgeMessage(message: DirectMessage, peer?: DirectMessagePeer): void {
    const state = this.findConversation(message.conversationId) ??
      (peer ? this.createTransientConversation(peer) : this.findConversationForMessage(message));
    if (!state) return;
    state.conversationId = message.conversationId;
    state.transient = false;
    this.mergeAuthoritativeMessage(state, message);
    this.sortAndBoundMessages(state);
    this.refreshLatestFromMessages(state);
    this.emit();
  }

  failMessage(clientMessageId: string, errorCode = "SEND_FAILED"): void {
    const found = this.findMessageByClientId(clientMessageId);
    if (!found || found.message.id !== null) return;
    found.message.localState = "failed";
    found.message.errorCode = errorCode;
    this.emit();
  }

  retryMessage(clientMessageId: string): OptimisticDirectMessage | null {
    const found = this.findMessageByClientId(clientMessageId);
    if (!found || found.message.id !== null || found.message.localState !== "failed") return null;
    found.message.localState = "sending";
    found.message.errorCode = null;
    this.emit();
    return {
      conversationId: found.state.conversationId,
      clientMessageId,
      recipientPlayerId: found.message.recipientPlayerId,
      body: found.message.body
    };
  }

  getPendingSendsForRecipient(recipientPlayerId: string): readonly OptimisticDirectMessage[] {
    const candidates: OptimisticDirectMessage[] = [];
    for (const state of this.conversationsByPeer.values()) {
      for (const message of state.messages) {
        if (
          message.id === null &&
          message.localState === "sending" &&
          message.recipientPlayerId === recipientPlayerId
        ) {
          candidates.push({
            conversationId: state.conversationId,
            clientMessageId: message.clientMessageId,
            recipientPlayerId: message.recipientPlayerId,
            body: message.body
          });
        }
      }
    }
    return candidates;
  }

  failPendingSends(errorCode = "CONNECTION_LOST"): void {
    let changed = false;
    for (const state of this.conversationsByPeer.values()) {
      for (const message of state.messages) {
        if (message.id !== null || message.localState !== "sending") continue;
        message.localState = "failed";
        message.errorCode = errorCode;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  failPendingSendsForRecipient(recipientPlayerId: string, errorCode: string): void {
    let changed = false;
    for (const state of this.conversationsByPeer.values()) {
      for (const message of state.messages) {
        if (
          message.id !== null ||
          message.localState !== "sending" ||
          message.recipientPlayerId !== recipientPlayerId
        ) continue;
        message.localState = "failed";
        message.errorCode = errorCode;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Applies the shared wire result directly; unrelated/error frames return false. */
  applyServerMessage(frame: DirectMessageServerMessage): boolean {
    switch (frame.type) {
      case "DM_BOOTSTRAP_RESULT":
        this.applyConversationPage({ conversations: frame.conversations, nextCursor: frame.nextCursor, reset: true });
        this.preferences = frame.preferences;
        this.applyEventBatch(frame.afterEventSequence, frame.latestEventSequence, frame.events);
        return true;
      case "DM_LIST_RESULT":
        this.applyConversationPage({ conversations: frame.conversations, nextCursor: frame.nextCursor, reset: false });
        return true;
      case "DM_OPEN_RESULT":
        this.upsertConversation(frame.conversation);
        this.applyMessagePage({ conversationId: frame.conversation.id, messages: frame.messages, hasOlder: frame.hasMore, reset: true });
        return true;
      case "DM_HISTORY_RESULT":
        this.applyMessagePage({ conversationId: frame.conversationId, messages: frame.messages, hasOlder: frame.hasMore, reset: false });
        return true;
      case "DM_SEND_RESULT":
        this.acknowledgeMessage(frame.message);
        return true;
      case "DM_READ_RESULT":
        this.applyOwnReadCursor(frame.conversationId, frame.readThroughSequence);
        return true;
      case "DM_DELIVERED_RESULT":
        this.applyDeliveryCursor(frame.conversationId, frame.deliveredThroughSequence);
        return true;
      case "DM_MUTE_RESULT":
        this.applyMuteByConversation(frame.conversationId, frame.muted);
        return true;
      case "DM_PREFERENCES_RESULT":
        this.preferences = frame.preferences;
        this.emit();
        return true;
      case "DM_SYNC_RESULT":
      case "DM_EVENT":
        this.applyEventBatch(frame.afterEventSequence, frame.latestEventSequence, frame.events);
        return true;
      case "DM_EVENT_ACKED":
        this.setEventCursor(frame.acknowledgedThroughEventSequence);
        this.emit();
        return true;
      case "DM_ERROR":
        return false;
    }
  }

  applyEvent(event: DirectMessageEvent): boolean {
    if (!this.acceptEventCursor(event.eventSequence)) return false;
    switch (event.kind) {
      case "message_created": {
        const state = this.upsertConversation(event.conversation);
        this.mergeAuthoritativeMessage(state, event.message);
        if (this.viewingPeerId === state.peer.playerId) state.unreadCount = 0;
        this.sortAndBoundMessages(state);
        this.refreshLatestFromMessages(state);
        break;
      }
      case "message_delivered":
        this.applyDeliveryCursor(event.conversationId, event.deliveredThroughSequence, false);
        break;
      case "message_read":
        this.applyPeerReadCursor(event.conversationId, event.readThroughSequence, false);
        break;
      case "conversation_updated":
        this.upsertConversation(event.conversation);
        break;
      case "mute_updated":
        this.applyMuteByConversation(event.conversationId, event.muted, false);
        break;
      case "preferences_updated":
        this.preferences = event.preferences;
        break;
      case "presence_updated":
        this.setPresence(event.peer.playerId, event.peer.online, false);
        break;
    }
    this.emit();
    return true;
  }

  applyEventBatch(afterCursor: string, latestCursor: string, events: readonly DirectMessageEvent[]): void {
    if (compareDecimal(afterCursor, this.acknowledgedEventCursor) > 0) this.setEventCursor(afterCursor);
    for (const event of [...events].sort((left, right) => compareDecimal(left.eventSequence, right.eventSequence))) {
      this.applyEvent(event);
    }
    this.highestSeenEventCursor = maxDecimal(this.highestSeenEventCursor, latestCursor);
    this.emit();
  }

  setEventCursor(cursor: string): void {
    if (!isCursor(cursor)) return;
    this.acknowledgedEventCursor = maxDecimal(this.acknowledgedEventCursor, cursor);
    this.highestSeenEventCursor = maxDecimal(this.highestSeenEventCursor, cursor);
  }

  setGapSyncing(syncing: boolean): void {
    if (this.syncingGap === syncing) return;
    this.syncingGap = syncing;
    this.emit();
  }

  applyDeliveryCursor(conversationId: string, throughSequence: string, emit = true): void {
    const state = this.findConversation(conversationId);
    if (!state) return;
    state.deliveredThroughSequence = maxDecimal(state.deliveredThroughSequence, throughSequence);
    if (emit) this.emit();
  }

  applyPeerReadCursor(conversationId: string, throughSequence: string, emit = true): void {
    const state = this.findConversation(conversationId);
    if (!state) return;
    state.peerReadThroughSequence = maxDecimal(state.peerReadThroughSequence, throughSequence);
    state.deliveredThroughSequence = maxDecimal(state.deliveredThroughSequence, throughSequence);
    if (emit) this.emit();
  }

  applyOwnReadCursor(conversationId: string, throughSequence: string): void {
    const state = this.findConversation(conversationId);
    if (!state) return;
    state.lastReadSequence = maxDecimal(state.lastReadSequence, throughSequence);
    state.unreadCount = 0;
    this.emit();
  }

  setMuted(peerId: string, muted: boolean): void {
    const state = this.conversationsByPeer.get(peerId);
    if (!state) return;
    state.muted = muted;
    this.emit();
  }

  setBlocked(peerId: string, blocked: boolean): void {
    const state = this.conversationsByPeer.get(peerId);
    if (!state) return;
    state.blocked = blocked;
    state.canMessage = !blocked;
    this.emit();
  }

  setPresence(peerId: string, online: boolean | null, emit = true): void {
    const state = this.conversationsByPeer.get(peerId);
    if (!state || state.peer.online === online) return;
    state.peer = { ...state.peer, online };
    if (emit) this.emit();
  }

  setPreferences(preferences: Partial<DirectMessagePreferences>): void {
    this.preferences = { ...this.preferences, ...preferences };
    this.emit();
  }

  private createTransientConversation(peer: DirectMessagePeer): ConversationState {
    const existing = this.conversationsByPeer.get(peer.playerId);
    if (existing) return existing;
    const now = this.now();
    const state: ConversationState = {
      conversationId: null,
      peer,
      latestMessage: null,
      latestSequence: "0",
      unreadCount: 0,
      muted: false,
      blocked: false,
      canMessage: true,
      hasOlderMessages: false,
      lastReadSequence: "0",
      deliveredThroughSequence: "0",
      peerReadThroughSequence: "0",
      transient: true,
      updatedAt: new Date(now).toISOString(),
      messages: [],
      lastLocalActivity: now
    };
    this.conversationsByPeer.set(peer.playerId, state);
    return state;
  }

  private upsertConversation(conversation: DirectMessageConversationSummary): ConversationState {
    const preview = conversation.latestMessage ? {
      body: conversation.latestMessage.body,
      senderPlayerId: conversation.latestMessage.senderPlayerId,
      sequence: conversation.latestMessage.sequence,
      createdAt: conversation.latestMessage.serverCreatedAt
    } : null;
    const existing = this.conversationsByPeer.get(conversation.peer.playerId);
    if (!existing) {
      const state: ConversationState = {
        conversationId: conversation.id,
        peer: conversation.peer,
        latestMessage: preview,
        latestSequence: conversation.latestSequence,
        unreadCount: conversation.unreadCount,
        muted: conversation.muted,
        blocked: !conversation.canSend,
        canMessage: conversation.canSend,
        hasOlderMessages: false,
        lastReadSequence: conversation.lastReadSequence,
        deliveredThroughSequence: conversation.deliveredThroughSequence,
        peerReadThroughSequence: "0",
        transient: false,
        updatedAt: conversation.updatedAt,
        messages: [],
        lastLocalActivity: 0
      };
      this.conversationsByPeer.set(conversation.peer.playerId, state);
      return state;
    }
    existing.conversationId = conversation.id;
    existing.peer = conversation.peer;
    existing.latestMessage = preview;
    existing.latestSequence = conversation.latestSequence;
    existing.unreadCount = conversation.unreadCount;
    existing.muted = conversation.muted;
    existing.blocked = !conversation.canSend;
    existing.canMessage = conversation.canSend;
    existing.lastReadSequence = conversation.lastReadSequence;
    existing.deliveredThroughSequence = maxDecimal(existing.deliveredThroughSequence, conversation.deliveredThroughSequence);
    existing.updatedAt = conversation.updatedAt;
    existing.transient = false;
    for (const message of existing.messages) {
      if (message.conversationId === null) message.conversationId = conversation.id;
    }
    return existing;
  }

  private mergeAuthoritativeMessage(state: ConversationState, incoming: DirectMessage): boolean {
    const byId = state.messages.find((message) => message.id === incoming.id);
    const byClientId = state.messages.find((message) => message.clientMessageId === incoming.clientMessageId);
    const existing = byId ?? byClientId;
    if (existing) {
      existing.key = `message:${incoming.id}`;
      existing.id = incoming.id;
      existing.conversationId = incoming.conversationId;
      existing.sequence = incoming.sequence;
      existing.senderPlayerId = incoming.senderPlayerId;
      existing.recipientPlayerId = incoming.senderPlayerId === this.ownPlayerId ? state.peer.playerId : this.ownPlayerId;
      existing.body = incoming.body;
      existing.createdAt = incoming.serverCreatedAt;
      existing.localState = null;
      existing.serverStatus = incoming.status;
      existing.errorCode = null;
      if (byId && byClientId && byId !== byClientId) state.messages = state.messages.filter((message) => message !== byClientId);
      state.latestSequence = maxDecimal(state.latestSequence, incoming.sequence);
      return false;
    }
    state.messages.push({
      key: `message:${incoming.id}`,
      id: incoming.id,
      conversationId: incoming.conversationId,
      sequence: incoming.sequence,
      clientMessageId: incoming.clientMessageId,
      senderPlayerId: incoming.senderPlayerId,
      recipientPlayerId: incoming.senderPlayerId === this.ownPlayerId ? state.peer.playerId : this.ownPlayerId,
      body: incoming.body,
      createdAt: incoming.serverCreatedAt,
      localOrder: ++this.localOrder,
      localState: null,
      serverStatus: incoming.status,
      errorCode: null
    });
    state.latestSequence = maxDecimal(state.latestSequence, incoming.sequence);
    return true;
  }

  private applyMuteByConversation(conversationId: string, muted: boolean, emit = true): void {
    const state = this.findConversation(conversationId);
    if (!state) return;
    state.muted = muted;
    if (emit) this.emit();
  }

  private acceptEventCursor(cursor: string): boolean {
    if (!isCursor(cursor) || compareDecimal(cursor, this.acknowledgedEventCursor) <= 0) return false;
    // Event ids are allocated globally, so another player's events legitimately
    // create gaps. A server batch is ordered for this player; the last applied id
    // is therefore the durable cursor even when it is not numerically adjacent.
    this.acknowledgedEventCursor = cursor;
    this.highestSeenEventCursor = maxDecimal(this.highestSeenEventCursor, cursor);
    return true;
  }

  private findConversation(conversationId: string): ConversationState | undefined {
    for (const state of this.conversationsByPeer.values()) if (state.conversationId === conversationId) return state;
    return undefined;
  }

  private findConversationForMessage(message: DirectMessage): ConversationState | undefined {
    if (message.senderPlayerId !== this.ownPlayerId) return this.conversationsByPeer.get(message.senderPlayerId);
    const optimistic = this.findMessageByClientId(message.clientMessageId);
    return optimistic?.state;
  }

  private findMessageByClientId(clientMessageId: string): { state: ConversationState; message: StoredMessage } | null {
    for (const state of this.conversationsByPeer.values()) {
      const message = state.messages.find((candidate) => candidate.clientMessageId === clientMessageId);
      if (message) return { state, message };
    }
    return null;
  }

  private sortAndBoundMessages(state: ConversationState): void {
    state.messages.sort(compareMessages);
    const limit = state.peer.playerId === this.selectedPeerId ? this.activeMessageLimit : this.inactiveMessageLimit;
    if (state.messages.length <= limit) return;
    const unresolved = state.messages.filter((message) => message.id === null);
    const confirmedLimit = Math.max(0, limit - unresolved.length);
    const confirmed = confirmedLimit === 0
      ? []
      : state.messages.filter((message) => message.id !== null).slice(-confirmedLimit);
    state.messages = [...confirmed, ...unresolved].sort(compareMessages).slice(-limit);
    state.hasOlderMessages = true;
  }

  private refreshLatestFromMessages(state: ConversationState): void {
    const latest = state.messages[state.messages.length - 1];
    if (!latest) return;
    state.latestMessage = { body: latest.body, senderPlayerId: latest.senderPlayerId, sequence: latest.sequence, createdAt: latest.createdAt };
  }

  private pruneConversations(): void {
    const sorted = [...this.conversationsByPeer.values()].sort(compareConversations);
    for (const state of sorted.slice(this.conversationLimit)) {
      if (state.peer.playerId === this.selectedPeerId || state.messages.some((message) => message.id === null)) continue;
      this.conversationsByPeer.delete(state.peer.playerId);
    }
  }

  private toConversationView(state: ConversationState): DirectConversationView {
    return {
      conversationId: state.conversationId,
      peer: state.peer,
      latestMessage: state.latestMessage,
      latestSequence: state.latestSequence,
      unreadCount: state.unreadCount,
      muted: state.muted,
      blocked: state.blocked,
      canMessage: state.canMessage,
      hasOlderMessages: state.hasOlderMessages,
      lastReadSequence: state.lastReadSequence,
      deliveredThroughSequence: state.deliveredThroughSequence,
      peerReadThroughSequence: state.peerReadThroughSequence,
      transient: state.transient,
      updatedAt: state.updatedAt
    };
  }

  private toMessageView(state: ConversationState, message: StoredMessage): DirectMessageView {
    const outgoing = message.senderPlayerId === this.ownPlayerId;
    let deliveryState: DirectMessageDeliveryState;
    if (message.localState === "sending") deliveryState = "sending";
    else if (message.localState === "failed") deliveryState = "failed";
    else if (outgoing && message.sequence !== null && compareDecimal(message.sequence, state.peerReadThroughSequence) <= 0) deliveryState = "read";
    else if (outgoing && message.sequence !== null && compareDecimal(message.sequence, state.deliveredThroughSequence) <= 0) deliveryState = "delivered";
    else deliveryState = message.serverStatus ?? "sent";
    return {
      key: message.key,
      id: message.id,
      conversationId: message.conversationId,
      sequence: message.sequence,
      clientMessageId: message.clientMessageId,
      senderPlayerId: message.senderPlayerId,
      recipientPlayerId: message.recipientPlayerId,
      body: message.body,
      createdAt: message.createdAt,
      outgoing,
      deliveryState,
      errorCode: message.errorCode
    };
  }

  private emit(): void {
    this.pruneConversations();
    this.rebuildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private rebuildSnapshot(): void {
    const states = [...this.conversationsByPeer.values()].sort(compareConversations);
    const selectedState = this.selectedPeerId === null ? undefined : this.conversationsByPeer.get(this.selectedPeerId);
    this.snapshot = {
      conversations: states.map((state) => this.toConversationView(state)),
      selectedPeerId: this.selectedPeerId,
      selectedConversation: selectedState ? this.toConversationView(selectedState) : null,
      messages: selectedState ? selectedState.messages.map((message) => this.toMessageView(selectedState, message)) : [],
      totalUnreadCount: states.reduce((total, state) => total + state.unreadCount, 0),
      hasMoreConversations: this.nextConversationCursor !== null,
      nextConversationCursor: this.nextConversationCursor,
      gap: {
        acknowledgedEventCursor: this.acknowledgedEventCursor,
        highestSeenEventCursor: this.highestSeenEventCursor,
        needsSync: compareDecimal(this.highestSeenEventCursor, this.acknowledgedEventCursor) > 0,
        syncing: this.syncingGap
      },
      preferences: { ...this.preferences },
      unresolvedSendCount: states.reduce((total, state) => total + state.messages.filter((message) => message.id === null).length, 0)
    };
  }
}

function compareMessages(left: StoredMessage, right: StoredMessage): number {
  if (left.sequence !== null && right.sequence !== null) {
    const compared = compareDecimal(left.sequence, right.sequence);
    return compared || left.id!.localeCompare(right.id!);
  }
  if (left.sequence !== null) return -1;
  if (right.sequence !== null) return 1;
  return left.localOrder - right.localOrder;
}

function compareConversations(left: ConversationState, right: ConversationState): number {
  const sequenceOrder = compareDecimal(right.latestMessage?.sequence ?? right.latestSequence, left.latestMessage?.sequence ?? left.latestSequence);
  if (sequenceOrder) return sequenceOrder;
  const leftTime = Date.parse(left.latestMessage?.createdAt ?? left.updatedAt) || left.lastLocalActivity;
  const rightTime = Date.parse(right.latestMessage?.createdAt ?? right.updatedAt) || right.lastLocalActivity;
  return rightTime - leftTime || left.peer.displayName.localeCompare(right.peer.displayName);
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").trim();
}

function isCursor(value: string): boolean {
  return /^(0|[1-9]\d{0,18})$/.test(value);
}

function compareDecimal(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function maxDecimal(left: string, right: string): string {
  return compareDecimal(left, right) >= 0 ? left : right;
}

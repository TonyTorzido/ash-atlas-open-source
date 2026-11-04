import type {
  ChatChannel,
  ChatChannelCategory,
  ChatChannelKey,
  ChatMessage,
  ChatMuteSnapshot,
  ChatPartyListing,
  ChatReadState,
  ChatTradeListing
} from "@ash-atlas/shared";

export type ChatSendInput = {
  channelKey: ChatChannelKey;
  senderPlayerId: string;
  senderDisplayName: string;
  clientRequestId: string;
  body: string;
  /** Trade-room Buy/Sell card; the stored body becomes its text fallback. */
  tradeListing?: ChatTradeListing;
  /** Hunting-room party card, already projected by the server (party, class, level). */
  partyListing?: ChatPartyListing;
};

export type ChatSendResult = {
  message: ChatMessage;
  replayed: boolean;
  moderationQueued: boolean;
};

export type ChatMessageDeleteResult = {
  message: ChatMessage;
  deletionRevision: number;
  replayed: boolean;
};

export type ChatHistoryMode = "initial" | "older" | "catch-up" | "bounded-snapshot";

export type ChatHistoryResult = {
  channel: ChatChannel;
  messages: ChatMessage[];
  mode: ChatHistoryMode;
  latestSequence: number;
  hasMore: boolean;
  resetRequired: boolean;
};

export type ChatChannelsSnapshot = {
  channels: ChatChannel[];
  readStates: ChatReadState[];
  mute: ChatMuteSnapshot;
  pinnedChannelCategories: ChatChannelCategory[];
};

export type ChatServiceErrorCode =
  | "CHAT_AUTH_REQUIRED"
  | "CHAT_CHANNEL_NOT_FOUND"
  | "CHAT_CHANNEL_INACTIVE"
  | "CHAT_ACCESS_DENIED"
  | "CHAT_MUTED"
  | "CHAT_RATE_LIMITED"
  | "CHAT_DUPLICATE_SPAM"
  | "CHAT_IDEMPOTENCY_CONFLICT"
  | "CHAT_HISTORY_CURSOR_INVALID"
  | "CHAT_MESSAGE_NOT_FOUND"
  | "CHAT_MESSAGE_DELETE_UNAVAILABLE"
  | "CHAT_TERMS_REQUIRED"
  | "CHAT_REQUEST_INVALID"
  | "CHAT_LISTING_INVALID";

export class ChatServiceError extends Error {
  constructor(
    readonly code: ChatServiceErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "ChatServiceError";
  }
}

export type ChatModerationEvent = {
  messageId: string;
  channelId: string;
  channelKey: ChatChannelKey;
  channelType: string;
  senderPlayerId: string;
  body: string;
  serverCreatedAt: string;
  moderationPolicyVersion: string;
};

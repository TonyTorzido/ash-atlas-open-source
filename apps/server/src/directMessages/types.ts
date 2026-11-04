import type {
  DirectMessage,
  DirectMessageConversationSummary,
  DirectMessageErrorCode,
  DirectMessageEvent
} from "@ash-atlas/shared";

export type {
  DirectMessage,
  DirectMessageConversationSummary,
  DirectMessageErrorCode,
  DirectMessageEvent,
  DirectMessagePreferences
} from "@ash-atlas/shared";

export type DirectConversationPage = {
  conversations: DirectMessageConversationSummary[];
  nextCursor: string | null;
};

export type DirectMessageHistoryPage = {
  conversationId: string;
  messages: DirectMessage[];
  hasMore: boolean;
  beforeSequence: string | null;
  latestSequence: string;
};

export type DirectMessageSendInput = {
  senderPlayerId: string;
  recipientPlayerId: string;
  clientMessageId: string;
  body: string;
};

export type DirectMessageSendResult = {
  message: DirectMessage;
  replayed: boolean;
};

export type DirectMessageEventPage = {
  events: DirectMessageEvent[];
  acknowledgedCursor: string;
  nextCursor: string;
  hasMore: boolean;
};

export class DirectMessageError extends Error {
  constructor(
    readonly code: DirectMessageErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "DirectMessageError";
  }
}

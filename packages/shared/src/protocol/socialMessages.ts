import type {
  ChatChannel,
  ChatChannelCategory,
  ChatMessage,
  ChatMessagePreview,
  ChatMuteSnapshot,
  ChatPartyJoinRequest,
  ChatPartyListingState,
  ChatReadState,
  ChatTranslationTargetLanguage
} from "../chat.js";

export type OnlinePlayerSummary = {
  playerId: string;
  displayName: string;
};

export type OnlinePlayerCount = {
  count: number;
  revision: number;
  observedAt: string;
  players: OnlinePlayerSummary[];
};

export type SocialServerMessage =
  | { type: "SOCIAL_STATE_CHANGED"; playerId: string; message?: string }
  | {
      type: "CHAT_CHANNELS_SNAPSHOT";
      channels: ChatChannel[];
      readStates: ChatReadState[];
      previews: ChatMessagePreview[];
      selectedChannelKey: string;
      pinnedChannelCategories: ChatChannelCategory[];
      onlinePlayerCount: OnlinePlayerCount;
    }
  | { type: "ONLINE_PLAYER_COUNT"; onlinePlayerCount: OnlinePlayerCount }
  | {
      type: "CHAT_PINNED_CHANNELS_UPDATED";
      requestId: string;
      pinnedChannelCategories: ChatChannelCategory[];
    }
  | { type: "CHAT_UNAVAILABLE"; message: string; retryable: true }
  | {
      type: "CHAT_CHANNEL_SELECTED";
      requestId?: string;
      channelKey: string;
      messages: ChatMessage[];
      latestSequence: number;
      hasOlder: boolean;
      reset: boolean;
      deletionRevision?: number;
      readState: ChatReadState;
      mute: ChatMuteSnapshot;
    }
  | { type: "CHAT_SEND_RESULT"; requestId: string; replayed: boolean; message: ChatMessage }
  | { type: "CHAT_MESSAGE"; message: ChatMessage }
  | {
      type: "CHAT_MESSAGE_TRANSLATION";
      channelId: string;
      channelKey: string;
      messageId: string;
      targetLanguage: ChatTranslationTargetLanguage;
      translatedText: string;
      sourceLanguage?: string;
    }
  | {
      type: "CHAT_MESSAGE_DELETED";
      requestId?: string;
      message: ChatMessage;
      deletionRevision: number;
      replayed: boolean;
    }
  | {
      type: "CHAT_HISTORY_RESULT";
      requestId: string;
      channelKey: string;
      direction: "older" | "newer";
      messages: ChatMessage[];
      hasMore: boolean;
      latestSequence: number;
      reset: boolean;
      maximumCatchUp: number;
      deletionRevision?: number;
    }
  | { type: "CHAT_PREVIEW_UPDATE"; preview: ChatMessagePreview; latestSequence: number; unreadCount: number }
  | { type: "CHAT_READ_STATE"; requestId?: string; readState: ChatReadState }
  | { type: "CHAT_MUTE_SNAPSHOT"; channelKey: string; mute: ChatMuteSnapshot }
  /** Live Hunting card states (open / Party full / Closed); the full current set, not a delta. */
  | { type: "CHAT_PARTY_LISTING_STATES"; states: ChatPartyListingState[] }
  /** Pending Hunting join requests for the party you lead; the full current set. */
  | { type: "CHAT_PARTY_JOIN_REQUESTS"; requests: ChatPartyJoinRequest[] }
  /** Party-finder outcome for you (join requested, accepted without travel and why, declined). */
  | { type: "CHAT_PARTY_LISTING_NOTICE"; requestId?: string; tone: "info" | "success" | "warning"; text: string };

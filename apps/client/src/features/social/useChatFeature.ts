import {
  isLiveSessionChatChannel,
  type ServerMessage,
  type SocialServerMessage
} from "@ash-atlas/shared";
import { useCallback, useMemo, useState } from "react";

import { ChatHistoryRequestTracker } from "../../chat/chatHistoryRequestTracker.js";
import { ChatStore } from "../../chat/chatStore.js";
import type { SocialClient } from "../../client/domains/socialClient.js";

const CHAT_FRAME_TYPES = new Set<ServerMessage["type"]>([
  "SOCIAL_STATE_CHANGED",
  "CHAT_CHANNELS_SNAPSHOT",
  "CHAT_PINNED_CHANNELS_UPDATED",
  "ONLINE_PLAYER_COUNT",
  "CHAT_UNAVAILABLE",
  "CHAT_CHANNEL_SELECTED",
  "CHAT_SEND_RESULT",
  "CHAT_MESSAGE",
  "CHAT_MESSAGE_DELETED",
  "CHAT_MESSAGE_TRANSLATION",
  "CHAT_HISTORY_RESULT",
  "CHAT_PREVIEW_UPDATE",
  "CHAT_READ_STATE",
  "CHAT_MUTE_SNAPSHOT",
  "CHAT_PARTY_LISTING_STATES",
  "CHAT_PARTY_JOIN_REQUESTS",
  "CHAT_PARTY_LISTING_NOTICE"
]);

export type ChatServerMessage = SocialServerMessage;

export interface ChatFeatureOptions {
  ownPlayerId: string;
  getCommands(): SocialClient | null;
  onSocialStateChanged(): void;
  /** Hunting party-finder outcomes (join requested, joined with or without travel, declined). */
  onPartyListingNotice?(tone: "info" | "success" | "warning", text: string): void;
}

export function isChatServerMessage(message: ServerMessage): message is ChatServerMessage {
  return CHAT_FRAME_TYPES.has(message.type);
}

export function useChatFeature({
  ownPlayerId,
  getCommands,
  onSocialStateChanged,
  onPartyListingNotice
}: ChatFeatureOptions) {
  const [store] = useState(() => new ChatStore({ ownPlayerId }));
  const [historyRequests] = useState(() => new ChatHistoryRequestTracker());

  const handleServerMessage = useCallback((message: ChatServerMessage): void => {
    switch (message.type) {
      case "SOCIAL_STATE_CHANGED":
        onSocialStateChanged();
        return;
      case "CHAT_CHANNELS_SNAPSHOT": {
        store.applyChannelsSnapshot(message);
        const chat = store.getSnapshot();
        if (
          chat.selectedChannelKey &&
          chat.selectedChannel &&
          !isLiveSessionChatChannel(chat.selectedChannel.channel)
        ) {
          const requestId = getCommands()?.selectChatChannel(
            chat.selectedChannelKey,
            chat.selectedChannel.needsRefresh || chat.selectedChannel.hasNewer
              ? undefined
              : (chat.newestLoadedSequence ?? undefined)
          );
          if (requestId) store.expectChannelSelection(chat.selectedChannelKey, requestId);
        }
        return;
      }
      case "ONLINE_PLAYER_COUNT":
        store.applyOnlinePlayerCount(message.onlinePlayerCount);
        return;
      case "CHAT_PINNED_CHANNELS_UPDATED":
        store.applyPinnedChannelCategories(message.pinnedChannelCategories);
        return;
      case "CHAT_UNAVAILABLE":
        store.markBootstrapUnavailable();
        return;
      case "CHAT_CHANNEL_SELECTED":
        store.applyChannelSelected(message);
        return;
      case "CHAT_SEND_RESULT":
        store.applySendResult(message.message);
        return;
      case "CHAT_MESSAGE":
        store.applyMessage(message.message);
        return;
      case "CHAT_MESSAGE_DELETED":
        store.applyMessageDeleted(message.message, message.deletionRevision);
        return;
      case "CHAT_MESSAGE_TRANSLATION":
        store.applyTranslation(message.channelKey, message.messageId, message.targetLanguage, {
          translatedText: message.translatedText,
          ...(message.sourceLanguage ? { sourceLanguage: message.sourceLanguage } : {})
        });
        return;
      case "CHAT_HISTORY_RESULT":
        store.applyHistoryResult(message);
        historyRequests.completeResult({
          requestId: message.requestId,
          channelKey: message.channelKey
        });
        return;
      case "CHAT_PREVIEW_UPDATE":
        store.applyPreviewUpdate(message.preview, message.latestSequence, message.unreadCount);
        return;
      case "CHAT_READ_STATE":
        store.applyReadState(message.readState);
        return;
      case "CHAT_MUTE_SNAPSHOT":
        store.applyMuteSnapshot(message.channelKey, message.mute);
        return;
      case "CHAT_PARTY_LISTING_STATES":
        store.applyPartyListingStates(message.states);
        return;
      case "CHAT_PARTY_JOIN_REQUESTS":
        store.applyPartyJoinRequests(message.requests);
        return;
      case "CHAT_PARTY_LISTING_NOTICE":
        onPartyListingNotice?.(message.tone, message.text);
        return;
    }
  }, [getCommands, historyRequests, onPartyListingNotice, onSocialStateChanged, store]);

  const handleError = useCallback((message: {
    requestId?: string;
    code: string;
    details?: { retryAfterMs?: number };
  }, formattedMessage: string): boolean => {
    if (message.requestId) historyRequests.completeError({ requestId: message.requestId });
    if (!message.requestId || !message.code.startsWith("CHAT_")) return false;
    const requestChannelKey = store.channelKeyForRequest(message.requestId);
    store.failPending(
      message.requestId,
      message.code,
      message.details?.retryAfterMs ?? null
    );
    const feedbackChannelKey = requestChannelKey ?? store.getSnapshot().selectedChannelKey;
    if (feedbackChannelKey) {
      store.setSendFeedback(feedbackChannelKey, {
        code: message.code,
        message: formattedMessage,
        retryAfterMs: message.details?.retryAfterMs ?? null
      });
      if (message.code === "CHAT_MUTED" && message.details?.retryAfterMs !== undefined) {
        store.applyMuteSnapshot(feedbackChannelKey, {
          muted: true,
          channelKey: feedbackChannelKey,
          scope: "channel",
          reason: formattedMessage,
          expiresAt: new Date(Date.now() + message.details.retryAfterMs).toISOString()
        });
      }
    }
    return true;
  }, [historyRequests, store]);

  const beginBootstrap = useCallback((): void => {
    store.beginBootstrap();
  }, [store]);
  const onDisconnected = useCallback((): void => {
    store.failAllPending();
  }, [store]);

  return useMemo(() => ({
    store,
    historyRequests,
    handleServerMessage,
    handleError,
    beginBootstrap,
    onDisconnected
  } as const), [
    beginBootstrap,
    handleError,
    handleServerMessage,
    historyRequests,
    onDisconnected,
    store
  ]);
}

export type ChatFeature = ReturnType<typeof useChatFeature>;

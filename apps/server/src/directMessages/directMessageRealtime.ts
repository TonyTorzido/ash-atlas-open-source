import {
  type DirectMessageClientMessage,
  type DirectMessageErrorCode,
  type DirectMessageServerMessage
} from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import type { DirectMessageService } from "./directMessageService.js";
import { DirectMessageError } from "./types.js";

type DirectMessageErrorFrame = Extract<DirectMessageServerMessage, { type: "DM_ERROR" }>;

const ERROR_MESSAGES: Record<DirectMessageErrorCode, DirectMessageErrorFrame["message"]> = {
  invalid_request: "Private messaging request was invalid.",
  recipient_unavailable: "That player cannot receive messages.",
  conversation_unavailable: "Conversation is unavailable.",
  not_allowed: "You cannot perform that action.",
  rate_limited: "Too many messages. Please wait and try again.",
  message_invalid: "Message contains unsupported text.",
  message_too_long: "Message is too long.",
  terms_required: "Accept the current Community Rules before sending messages.",
  idempotency_conflict: "That message identifier was already used.",
  sync_required: "Message history must be synchronized.",
  internal_error: "Private messaging is temporarily unavailable."
};

/** Authenticated WebSocket adapter for the durable direct-message service. */
export class DirectMessageRealtimeCoordinator {
  constructor(
    readonly service: DirectMessageService,
    private readonly registry: ConnectionRegistry,
    private readonly logger: AppLogger
  ) {}

  async handle(
    connectionId: string,
    playerId: string,
    message: DirectMessageClientMessage
  ): Promise<void> {
    try {
      await this.handleAuthorized(connectionId, playerId, message);
    } catch (error) {
      this.sendError(connectionId, message.requestId, error, playerId, message.type);
    }
  }

  sendInvalidRequest(connectionId: string, requestId?: string): void {
    this.registry.sendToConnection(connectionId, {
      type: "DM_ERROR",
      ...(requestId ? { requestId } : {}),
      code: "invalid_request",
      message: ERROR_MESSAGES.invalid_request,
      retryable: false
    });
  }

  private async handleAuthorized(
    connectionId: string,
    playerId: string,
    message: DirectMessageClientMessage
  ): Promise<void> {
    switch (message.type) {
      case "DM_BOOTSTRAP": {
        const [page, preferences, events] = await Promise.all([
          this.service.listConversations(playerId),
          this.service.getPreferences(playerId),
          this.service.syncEvents(playerId, message.afterEventSequence)
        ]);
        this.registry.sendToConnection(connectionId, {
          type: "DM_BOOTSTRAP_RESULT",
          requestId: message.requestId,
          result: "ok",
          conversations: page.conversations,
          nextCursor: page.nextCursor,
          preferences,
          afterEventSequence: message.afterEventSequence ?? events.acknowledgedCursor,
          latestEventSequence: events.nextCursor,
          events: events.events,
          hasMore: events.hasMore
        }, "recoverable-social");
        return;
      }
      case "DM_LIST": {
        const page = await this.service.listConversations(playerId, {
          ...(message.cursor !== undefined ? { cursor: message.cursor } : {}),
          ...(message.limit !== undefined ? { limit: message.limit } : {}),
          ...(message.search !== undefined ? { search: message.search } : {})
        });
        this.registry.sendToConnection(connectionId, {
          type: "DM_LIST_RESULT",
          requestId: message.requestId,
          result: "ok",
          conversations: page.conversations,
          nextCursor: page.nextCursor
        }, "recoverable-social");
        return;
      }
      case "DM_OPEN": {
        const conversation = await this.service.openConversation(playerId, message.peerPlayerId);
        const history = await this.service.history(playerId, conversation.id);
        this.registry.sendToConnection(connectionId, {
          type: "DM_OPEN_RESULT",
          requestId: message.requestId,
          result: "existing",
          conversation,
          messages: history.messages,
          beforeSequence: history.beforeSequence,
          hasMore: history.hasMore
        }, "recoverable-social");
        return;
      }
      case "DM_HISTORY": {
        const history = await this.service.history(playerId, message.conversationId, {
          ...(message.beforeSequence !== undefined
            ? { beforeSequence: message.beforeSequence }
            : {}),
          ...(message.limit !== undefined ? { limit: message.limit } : {})
        });
        this.registry.sendToConnection(connectionId, {
          type: "DM_HISTORY_RESULT",
          requestId: message.requestId,
          result: "ok",
          conversationId: message.conversationId,
          messages: history.messages,
          beforeSequence: history.beforeSequence,
          hasMore: history.hasMore
        }, "recoverable-social");
        return;
      }
      case "DM_SEND": {
        const result = await this.service.sendToConversation({
          senderPlayerId: playerId,
          conversationId: message.conversationId,
          clientMessageId: message.clientMessageId,
          body: message.body
        });
        this.registry.sendToConnection(connectionId, {
          type: "DM_SEND_RESULT",
          requestId: message.requestId,
          result: result.replayed ? "duplicate" : "ok",
          replayed: result.replayed,
          message: result.message
        });
        if (!result.replayed) {
          await this.pushPeerEvents(playerId, message.conversationId, "message-created");
        }
        return;
      }
      case "DM_READ": {
        const readThroughSequence = await this.service.markRead(
          playerId,
          message.conversationId,
          message.throughSequence
        );
        this.registry.sendToConnection(connectionId, {
          type: "DM_READ_RESULT",
          requestId: message.requestId,
          result: "updated",
          conversationId: message.conversationId,
          readThroughSequence
        });
        await this.pushPeerEvents(playerId, message.conversationId, "message-read");
        return;
      }
      case "DM_DELIVERED": {
        const deliveredThroughSequence = await this.service.markDelivered(
          playerId,
          message.conversationId,
          message.throughSequence
        );
        this.registry.sendToConnection(connectionId, {
          type: "DM_DELIVERED_RESULT",
          requestId: message.requestId,
          result: "updated",
          conversationId: message.conversationId,
          deliveredThroughSequence
        });
        await this.pushPeerEvents(playerId, message.conversationId, "message-delivered");
        return;
      }
      case "DM_MUTE": {
        const muted = await this.service.setMuted(playerId, message.conversationId, message.muted);
        this.registry.sendToConnection(connectionId, {
          type: "DM_MUTE_RESULT",
          requestId: message.requestId,
          result: "updated",
          conversationId: message.conversationId,
          muted
        });
        return;
      }
      case "DM_PREFERENCES": {
        const preferences = await this.service.updatePreferences(playerId, message.preferences);
        this.registry.sendToConnection(connectionId, {
          type: "DM_PREFERENCES_RESULT",
          requestId: message.requestId,
          result: "updated",
          preferences
        });
        return;
      }
      case "DM_SYNC": {
        const events = await this.service.syncEvents(
          playerId,
          message.afterEventSequence,
          message.limit
        );
        this.registry.sendToConnection(connectionId, {
          type: "DM_SYNC_RESULT",
          requestId: message.requestId,
          result: "ok",
          afterEventSequence: message.afterEventSequence,
          latestEventSequence: events.nextCursor,
          events: events.events,
          hasMore: events.hasMore
        }, "recoverable-social");
        return;
      }
      case "DM_EVENT_ACK": {
        const acknowledgedThroughEventSequence = await this.service.acknowledgeEvents(
          playerId,
          message.throughEventSequence
        );
        this.registry.sendToConnection(connectionId, {
          type: "DM_EVENT_ACKED",
          requestId: message.requestId,
          result: "updated",
          acknowledgedThroughEventSequence
        });
        return;
      }
    }
  }

  private async pushPeerEvents(
    actorPlayerId: string,
    conversationId: string,
    reason: string
  ): Promise<void> {
    try {
      const conversation = await this.service.getConversation(actorPlayerId, conversationId);
      const peerPlayerId = conversation.peer.playerId;
      if (!this.registry.activeConnectionIdForPlayer(peerPlayerId)) return;
      const events = await this.service.syncEvents(peerPlayerId);
      if (events.events.length === 0) return;
      this.registry.send(peerPlayerId, {
        type: "DM_EVENT",
        afterEventSequence: events.acknowledgedCursor,
        latestEventSequence: events.nextCursor,
        events: events.events,
        hasMore: events.hasMore
      }, "recoverable-social");
    } catch (error) {
      this.logger.warn({
        errorName: error instanceof Error ? error.name : "UnknownError",
        actorPlayerId,
        reason
      }, "failed to push durable direct-message events");
    }
  }

  private sendError(
    connectionId: string,
    requestId: string,
    error: unknown,
    playerId: string,
    requestType: DirectMessageClientMessage["type"]
  ): void {
    const code = error instanceof DirectMessageError ? error.code : "internal_error";
    const retryAfterMs = error instanceof DirectMessageError ? error.retryAfterMs : null;
    if (!(error instanceof DirectMessageError)) {
      this.logger.warn({
        errorName: error instanceof Error ? error.name : "UnknownError",
        playerId,
        requestType
      }, "direct-message request failed");
    }
    this.registry.sendToConnection(connectionId, {
      type: "DM_ERROR",
      requestId,
      code,
      message: ERROR_MESSAGES[code],
      retryable: code === "rate_limited" || code === "sync_required" || code === "internal_error",
      ...(retryAfterMs && retryAfterMs > 0 ? { retryAfterMs } : {})
    });
  }
}

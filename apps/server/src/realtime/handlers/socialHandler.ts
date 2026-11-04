import type { ServerMessage } from "@ash-atlas/shared";

import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import type { AuthService } from "../../auth/authService.js";
import { DeveloperAuthorizationError } from "../../auth/developerAuthorization.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import type { ChatRealtimeCoordinator } from "../../chat/chatRealtime.js";
import { ChatServiceError } from "../../chat/types.js";
import { ChatValidationError } from "../../chat/validation.js";
import type { DirectMessageRealtimeCoordinator } from "../../directMessages/directMessageRealtime.js";
import type { KingdomService } from "../../game/kingdoms.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import type { SocialRealtimeState } from "../socialRealtimeState.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";

export class KingdomChatRateGate {
  private readonly buckets = new Map<string, number[]>();

  consume(playerId: string, maximum: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.buckets.get(playerId) ?? [])
      .filter((timestamp) => timestamp > now - windowMs);
    if (recent.length >= maximum) {
      this.buckets.set(playerId, recent);
      return false;
    }
    recent.push(now);
    this.buckets.set(playerId, recent);
    if (this.buckets.size > 50_000) {
      for (const [key, timestamps] of this.buckets) {
        if (timestamps.every((timestamp) => timestamp <= now - windowMs)) {
          this.buckets.delete(key);
        }
        if (this.buckets.size <= 40_000) break;
      }
    }
    return true;
  }
}

export function createChatBootstrap(context: Readonly<{
  chats?: ChatRealtimeCoordinator | undefined;
  registry: ConnectionRegistry;
  logger: AppLogger;
  config?: AppConfig | undefined;
  socialRealtimeState: SocialRealtimeState;
}>): (connectionId: string, playerId: string) => Promise<void> {
  const { chats, registry, logger, config, socialRealtimeState } = context;
  return async (connectionId: string, playerId: string): Promise<void> => {
    if (socialRealtimeState.isBootstrapReady(connectionId)) return;
    const activeFlight = socialRealtimeState.bootstrapFlight(connectionId);
    if (activeFlight) {
      await activeFlight;
      return;
    }
    let ready = false;
    const flight = (async () => {
      if (!chats) {
        registry.sendToConnection(connectionId, {
          type: "CHAT_UNAVAILABLE",
          message: "Chat is temporarily unavailable.",
          retryable: true
        });
        return;
      }
      try {
        chats.disconnect(connectionId);
        await chats.connect(connectionId, playerId);
        if (registry.recordForConnection(connectionId)) {
          ready = true;
        } else {
          chats.disconnect(connectionId);
        }
      } catch (error) {
        chats.disconnect(connectionId);
        logger.warn(
          {
            err: error,
            playerId,
            connectionId,
            releaseSha: config?.RUNTIME_SHA ?? null,
            bootstrapSubsystem: "chat"
          },
          "websocket bootstrap subsystem failed"
        );
        registry.sendToConnection(connectionId, {
          type: "CHAT_UNAVAILABLE",
          message: "Chat is temporarily unavailable.",
          retryable: true
        });
      }
    })();
    socialRealtimeState.beginBootstrap(connectionId, flight);
    try {
      await flight;
    } finally {
      socialRealtimeState.finishBootstrap(connectionId, flight, ready);
    }
  };
}

export type SocialHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId" | "connectionId">;
  socket: SocketLike;
  config?: AppConfig | undefined;
  logger: AppLogger;
  registry: ConnectionRegistry;
  chats?: ChatRealtimeCoordinator | undefined;
  authenticatedSession?: AuthenticatedSession | null | undefined;
  auth?: AuthService | undefined;
  kingdoms?: KingdomService | undefined;
  directMessages?: DirectMessageRealtimeCoordinator | undefined;
  kingdomChatGate: KingdomChatRateGate;
  bootstrapChat(connectionId: string, playerId: string): Promise<void>;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
  sendCombatError(
    socket: SocketLike,
    requestId: string,
    code: string,
    message: string
  ): void;
}>;

function requireChatHello(playerId: string | null): string {
  if (!playerId) {
    throw new ChatServiceError("CHAT_AUTH_REQUIRED", "Chat requires an authenticated HELLO");
  }
  return playerId;
}

export function createSocialHandler(
  context: SocialHandlerContext
): RealtimeFamilyHandler<"social"> {
  return async (message) => {
    const {
      state,
      socket,
      logger,
      registry,
      chats,
      authenticatedSession,
      auth,
      directMessages,
      bootstrapChat,
      safeSendServerMessage,
      sendCombatError
    } = context;
    const sendChatUnavailable = (targetSocket: SocketLike, requestId: string): void => {
      safeSendServerMessage(targetSocket, {
        type: "ERROR",
        requestId,
        code: "CHAT_UNAVAILABLE",
        message: "Chat is unavailable"
      });
    };
    const sendChatError = (
      targetSocket: SocketLike,
      requestId: string,
      error: unknown,
      targetLogger: AppLogger,
      playerId: string
    ): void => {
      if (error instanceof ChatServiceError || error instanceof ChatValidationError) {
        targetLogger.info(
          { requestId, playerId, code: error.code },
          "chat request rejected"
        );
        safeSendServerMessage(targetSocket, {
          type: "ERROR",
          requestId,
          code: error.code,
          message: error.message,
          ...(error instanceof ChatServiceError && error.retryAfterMs !== null
            ? { details: { retryAfterMs: error.retryAfterMs } }
            : {})
        });
        return;
      }
      targetLogger.warn({ err: error, requestId, playerId }, "chat request failed");
      safeSendServerMessage(targetSocket, {
        type: "ERROR",
        requestId,
        code: "CHAT_INTERNAL_ERROR",
        message: "Chat request could not be completed"
      });
    };
    switch (message.type) {
      case "REQUEST_CHAT_BOOTSTRAP": {
        requireHello(state.playerId);
        if (!state.connectionId) return;
        await bootstrapChat(state.connectionId, state.playerId);
        return;
      }
      case "DM_BOOTSTRAP":
      case "DM_LIST":
      case "DM_OPEN":
      case "DM_HISTORY":
      case "DM_SEND":
      case "DM_READ":
      case "DM_DELIVERED":
      case "DM_MUTE":
      case "DM_PREFERENCES":
      case "DM_SYNC":
      case "DM_EVENT_ACK": {
        requireHello(state.playerId);
        if (!state.connectionId || !directMessages) {
          safeSendServerMessage(socket, {
            type: "DM_ERROR",
            requestId: message.requestId,
            code: "internal_error",
            message: "Private messaging is temporarily unavailable.",
            retryable: true
          });
          return;
        }
        await directMessages.handle(state.connectionId, state.playerId, message);
        return;
      }
      case "CHAT_SELECT_CHANNEL": {
        try {
          const chatPlayerId = requireChatHello(state.playerId);
          if (!state.connectionId || !chats) {
            sendChatUnavailable(socket, message.requestId);
            return;
          }
          await chats.select(
            state.connectionId,
            chatPlayerId,
            message.channelKey,
            message.requestId,
            message.afterSequence
          );
        } catch (error) {
          sendChatError(socket, message.requestId, error, logger, state.playerId ?? "unauthenticated");
        }
        return;
      }
      case "CHAT_SEND": {
        try {
          const chatPlayerId = requireChatHello(state.playerId);
          if (!state.connectionId || !chats) {
            sendChatUnavailable(socket, message.requestId);
            return;
          }
          const connection = registry.recordForConnection(state.connectionId);
          if (!connection) throw new Error("Authenticated chat connection is unavailable");
          await chats.send(state.connectionId, chatPlayerId, connection.username, message);
        } catch (error) {
          if (
            error instanceof ChatServiceError &&
            error.code === "CHAT_MUTED" &&
            state.connectionId &&
            chats &&
            state.playerId
          ) {
            try {
              const mute = await chats.service.activeMute(state.playerId, message.channelKey);
              registry.sendToConnection(state.connectionId, {
                type: "CHAT_MUTE_SNAPSHOT",
                channelKey: message.channelKey,
                mute
              });
            } catch (muteError) {
              logger.warn(
                { err: muteError, playerId: state.playerId, channelKey: message.channelKey },
                "failed to refresh chat mute snapshot after rejection"
              );
            }
          }
          sendChatError(socket, message.requestId, error, logger, state.playerId ?? "unauthenticated");
        }
        return;
      }
      case "CHAT_MESSAGE_DELETE": {
        const command = {
          capability: "developer:world-mutate" as const,
          command: "chat.message.delete",
          transport: "websocket" as const,
          target: message.messageId,
          operationKey: message.requestId
        };
        let authorized = false;
        try {
          if (!auth || !authenticatedSession?.player) {
            sendCombatError(
              socket,
              message.requestId,
              "DEVELOPER_COMMAND_FORBIDDEN",
              "Developer command is unavailable"
            );
            return;
          }
          await auth.authorizeDeveloperCommand(authenticatedSession, command);
          authorized = true;
          const chatPlayerId = requireChatHello(state.playerId);
          if (!state.connectionId || !chats) {
            throw new ChatServiceError("CHAT_ACCESS_DENIED", "Chat is unavailable");
          }
          await chats.deleteMessage(
            state.connectionId,
            chatPlayerId,
            message.requestId,
            message.messageId
          );
          await auth.recordDeveloperCommandResult(authenticatedSession, {
            ...command,
            outcome: "succeeded"
          });
        } catch (error) {
          if (error instanceof DeveloperAuthorizationError) {
            sendCombatError(
              socket,
              message.requestId,
              "DEVELOPER_COMMAND_FORBIDDEN",
              "Developer command is unavailable"
            );
            return;
          }
          if (authorized && auth && authenticatedSession) {
            try {
              await auth.recordDeveloperCommandResult(authenticatedSession, {
                ...command,
                outcome: "failed"
              });
            } catch (auditError) {
              logger.warn(
                { err: auditError, requestId: message.requestId, messageId: message.messageId },
                "failed to record chat deletion command result"
              );
            }
          }
          if (error instanceof ChatServiceError || error instanceof ChatValidationError) {
            sendChatError(socket, message.requestId, error, logger, state.playerId ?? "unauthenticated");
          } else {
            logger.warn(
              { err: error, requestId: message.requestId, messageId: message.messageId },
              "chat deletion request failed"
            );
            safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "CHAT_INTERNAL_ERROR",
              message: "Chat request could not be completed"
            });
          }
        }
        return;
      }
      case "CHAT_HISTORY_REQUEST": {
        try {
          const chatPlayerId = requireChatHello(state.playerId);
          if (!state.connectionId || !chats) {
            sendChatUnavailable(socket, message.requestId);
            return;
          }
          await chats.history(state.connectionId, chatPlayerId, message);
        } catch (error) {
          sendChatError(socket, message.requestId, error, logger, state.playerId ?? "unauthenticated");
        }
        return;
      }
      case "CHAT_READ_UPDATE": {
        try {
          const chatPlayerId = requireChatHello(state.playerId);
          if (!state.connectionId || !chats) {
            sendChatUnavailable(socket, message.requestId);
            return;
          }
          await chats.markRead(
            state.connectionId,
            chatPlayerId,
            message.requestId,
            message.channelKey,
            message.lastReadSequence
          );
        } catch (error) {
          sendChatError(socket, message.requestId, error, logger, state.playerId ?? "unauthenticated");
        }
        return;
      }
      case "CHAT_PINNED_CHANNELS_UPDATE": {
        try {
          const chatPlayerId = requireChatHello(state.playerId);
          if (!state.connectionId || !chats) {
            sendChatUnavailable(socket, message.requestId);
            return;
          }
          await chats.updatePinnedChannels(
            state.connectionId,
            chatPlayerId,
            message.requestId,
            message.categories
          );
        } catch (error) {
          sendChatError(socket, message.requestId, error, logger, state.playerId ?? "unauthenticated");
        }
        return;
      }
      case "KINGDOM_CHAT_SEND": {
        requireHello(state.playerId);
        sendCombatError(
          socket,
          message.requestId,
          "KINGDOM_CHAT_RETIRED",
          "Kingdom chat has moved to Atlas Chats."
        );
        return;
      }
    }
  };
}

export function registerSocialHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"social">
): void {
  router.register("social", handler);
}

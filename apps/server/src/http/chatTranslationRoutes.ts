import {
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_TRANSLATION_TARGET_LANGUAGES,
  type ChatTranslationTargetLanguage
} from "@ash-atlas/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import { ChatServiceError } from "../chat/types.js";
import {
  ChatTranslationUnavailableError
} from "../chat/googleCloudTranslation.js";
import type { ChatTranslationExecutor } from "../chat/chatTranslationService.js";
import type { ChatService } from "../chat/chatService.js";
import { sendError } from "./errors.js";

const translateRequestSchema = z.object({
  messageId: z.string().uuid(),
  targetLanguage: z.enum(CHAT_TRANSLATION_TARGET_LANGUAGES)
}).strict();

const TRANSLATION_UNAVAILABLE_MESSAGE = "Translation is temporarily unavailable.";

export function registerChatTranslationRoutes(
  app: FastifyInstance,
  chatService: Pick<ChatService, "getMessageForTranslation">,
  translationService: ChatTranslationExecutor
): void {
  app.post(
    "/api/chat/translate",
    {
      bodyLimit: 1_024,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          groupId: "chat-translation"
        }
      }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        const session = requireRequestSession(request);
        const playerId = session.player?.id;
        if (!playerId) {
          return sendError(reply, 409, "CHAT_TRANSLATION_PLAYER_REQUIRED", "Choose a character first.");
        }
        const parsed = translateRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return sendError(reply, 400, "CHAT_TRANSLATION_INVALID", "Translation details are invalid.");
        }
        const message = await chatService.getMessageForTranslation(playerId, parsed.data.messageId);
        if (Array.from(message.body).length > CHAT_MESSAGE_MAX_LENGTH) {
          return sendError(
            reply,
            400,
            "CHAT_TRANSLATION_INVALID",
            "Chat messages over 400 characters cannot be translated."
          );
        }
        return await translationService.translate(
          message,
          parsed.data.targetLanguage as ChatTranslationTargetLanguage
        );
      } catch (error) {
        sendChatTranslationError(reply, request, error);
      }
    }
  );
}

function sendChatTranslationError(reply: FastifyReply, request: FastifyRequest, error: unknown): void {
  if (error instanceof ChatServiceError) {
    const statusCode = error.code === "CHAT_REQUEST_INVALID"
      ? 400
      : error.code === "CHAT_MESSAGE_NOT_FOUND" ||
          error.code === "CHAT_CHANNEL_NOT_FOUND" ||
          error.code === "CHAT_CHANNEL_INACTIVE"
        ? 404
        : error.code === "CHAT_ACCESS_DENIED"
          ? 403
          : 400;
    sendError(reply, statusCode, error.code, error.message);
    return;
  }
  if (!(error instanceof ChatTranslationUnavailableError)) {
    request.log.warn({ err: error }, "chat translation provider failed");
  }
  sendError(reply, 503, "CHAT_TRANSLATION_UNAVAILABLE", TRANSLATION_UNAVAILABLE_MESSAGE);
}

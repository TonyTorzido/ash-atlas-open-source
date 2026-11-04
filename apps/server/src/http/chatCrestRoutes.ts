import { isChatCrestId } from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import { ChatCrestError, type ChatCrestService } from "../chat/chatCrestService.js";
import { sendError } from "./errors.js";

const equipRequestSchema = z.object({ crestId: z.string() }).strict();

export function registerChatCrestRoutes(
  app: FastifyInstance,
  service: ChatCrestService
): void {
  app.get(
    "/api/chat/crests",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute", groupId: "chat-crests-read" } } },
    async (request, reply) => {
      try {
        return await service.selectionFor(authenticatedPlayerId(request));
      } catch (error) {
        sendChatCrestError(reply, error);
      }
    }
  );

  app.patch(
    "/api/chat/crests",
    {
      bodyLimit: 1_024,
      config: { rateLimit: { max: 20, timeWindow: "1 minute", groupId: "chat-crests-write" } }
    },
    async (request, reply) => {
      try {
        const parsed = equipRequestSchema.safeParse(request.body);
        if (!parsed.success || !isChatCrestId(parsed.data.crestId)) {
          throw new ChatCrestError("CHAT_CREST_INVALID", "Choose a registered chat crest.", 400);
        }
        return await service.equip(authenticatedPlayerId(request), parsed.data.crestId);
      } catch (error) {
        sendChatCrestError(reply, error);
      }
    }
  );
}

function authenticatedPlayerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) {
    throw new ChatCrestError(
      "CHAT_CREST_PLAYER_REQUIRED",
      "Choose a character before selecting a chat crest.",
      409
    );
  }
  return session.player.id;
}

function sendChatCrestError(
  reply: Parameters<typeof sendError>[0],
  error: unknown
): void {
  if (error instanceof ChatCrestError) {
    sendError(reply, error.statusCode, error.code, error.message);
    return;
  }
  sendError(reply, 503, "CHAT_CREST_UNAVAILABLE", "Chat crest settings are temporarily unavailable.");
}

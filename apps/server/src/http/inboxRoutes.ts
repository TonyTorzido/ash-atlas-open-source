import { inboxReadBatchSchema } from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireRequestSession } from "../auth/authGuard.js";
import type { InboxReadReceiptService } from "../game/inboxReadReceipts.js";
import type { AppLogger } from "../logger.js";
import { sendError } from "./errors.js";

export function registerInboxRoutes(
  app: FastifyInstance,
  service: InboxReadReceiptService,
  logger: AppLogger
): void {
  app.get("/api/inbox/read-state", async (request, reply) => {
    try {
      return { receipts: await service.list(authenticatedPlayerId(request)) };
    } catch (error) {
      logger.warn({ err: error }, "Inbox read-state request failed");
      sendError(reply, 500, "INBOX_READ_STATE_FAILED", "Could not load Messages read state");
    }
  });

  app.get("/api/inbox/notices", async (request, reply) => {
    try {
      return { notices: await service.listGameNotices(authenticatedPlayerId(request)) };
    } catch (error) {
      logger.warn({ err: error }, "Inbox notices request failed");
      sendError(reply, 500, "INBOX_NOTICES_FAILED", "Could not load Messages notifications");
    }
  });

  app.post("/api/inbox/read", { bodyLimit: 64_000 }, async (request, reply) => {
    const parsed = inboxReadBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      sendError(reply, 400, "INBOX_READ_INVALID", "Messages read request is invalid");
      return;
    }
    try {
      return {
        receipts: await service.markRead(authenticatedPlayerId(request), parsed.data.entries)
      };
    } catch (error) {
      logger.warn({ err: error }, "Inbox mark-read request failed");
      sendError(reply, 500, "INBOX_READ_FAILED", "Could not mark Messages read");
    }
  });
}
function authenticatedPlayerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new Error("Player onboarding is required");
  return session.player.id;
}

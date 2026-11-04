import { publishPlayerAnnouncementRequestSchema } from "@ash-atlas/shared";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthService } from "../auth/authService.js";
import { requireRequestSession } from "../auth/authGuard.js";
import {
  PlayerAnnouncementConflictError,
  PlayerAnnouncementNotFoundError,
  type PlayerAnnouncementService
} from "../game/playerAnnouncements.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { sendError } from "./errors.js";
import { authorizeDeveloperHttp, recordDeveloperHttpResult } from "./routes/routeAuthentication.js";

const CAPABILITY = "developer:announcements-manage" as const;
const COMMAND = "announcements.publish";

export function registerAnnouncementRoutes(
  app: FastifyInstance,
  auth: AuthService,
  announcements: PlayerAnnouncementService,
  registry: ConnectionRegistry
): void {
  app.get(
    "/api/announcements",
    {
      preHandler: app.rateLimit({
        max: 30,
        timeWindow: "1 minute",
        groupId: "player-announcements-list",
        keyGenerator: (request: FastifyRequest) =>
          `player:${authenticatedPlayerId(request)}`
      })
    },
    async (request, reply) => {
      try {
        return await announcements.list(authenticatedPlayerId(request));
      } catch {
        return sendError(reply, 503, "ANNOUNCEMENTS_UNAVAILABLE", "Announcements are temporarily unavailable");
      }
    }
  );

  app.post(
    "/api/announcements/:announcementId/dismiss",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      const parsed = z.object({ announcementId: z.string().uuid() }).safeParse(request.params);
      if (!parsed.success) {
        return sendError(reply, 400, "ANNOUNCEMENT_INVALID", "Announcement id is invalid");
      }
      try {
        return await announcements.dismiss(
          authenticatedPlayerId(request),
          parsed.data.announcementId
        );
      } catch (error) {
        if (error instanceof PlayerAnnouncementNotFoundError) {
          return sendError(reply, error.statusCode, error.code, error.message);
        }
        return sendError(reply, 503, "ANNOUNCEMENT_DISMISS_UNAVAILABLE", "Announcement dismissal is temporarily unavailable");
      }
    }
  );

  app.post(
    "/api/admin/announcements",
    {
      bodyLimit: 16_384,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      const parsed = publishPlayerAnnouncementRequestSchema.safeParse(request.body);
      const operationKey = parsed.success ? parsed.data.operationKey : null;
      const session = await authorizeDeveloperHttp(
        request,
        reply,
        auth,
        CAPABILITY,
        COMMAND,
        null,
        operationKey
      );
      if (!session) return;
      if (!parsed.success) {
        await recordDeveloperHttpResult(auth, session, {
          capability: CAPABILITY, command: COMMAND, operationKey, outcome: "failed"
        });
        return sendError(reply, 400, "ANNOUNCEMENT_INVALID", "Announcement title or message is invalid");
      }
      try {
        const result = await announcements.publish(session.account.id, parsed.data);
        if (!result.replayed) {
          registry.broadcast({
            type: "PLAYER_ANNOUNCEMENT_PUBLISHED",
            announcement: result.announcement
          });
        }
        await recordDeveloperHttpResult(auth, session, {
          capability: CAPABILITY, command: COMMAND, operationKey, outcome: "succeeded"
        });
        return result;
      } catch (error) {
        await recordDeveloperHttpResult(auth, session, {
          capability: CAPABILITY, command: COMMAND, operationKey, outcome: "failed"
        });
        if (error instanceof PlayerAnnouncementConflictError) {
          return sendError(reply, error.statusCode, error.code, error.message);
        }
        return sendError(reply, 503, "ANNOUNCEMENT_PUBLISH_UNAVAILABLE", "Announcement publication is temporarily unavailable");
      }
    }
  );
}

function authenticatedPlayerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new Error("Player onboarding is required");
  return session.player.id;
}

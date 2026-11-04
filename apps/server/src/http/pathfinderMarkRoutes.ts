import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import { PathfinderMarkError, type PathfinderMarkService } from "../game/pathfinderMarks.js";
import type { AppLogger } from "../logger.js";
import { sendError } from "./errors.js";

const paramsSchema = z.object({ flagId: z.string().uuid() }).strict();
const bodySchema = z.object({ requestId: z.string().min(1).max(128) }).strict();

export function registerPathfinderMarkRoutes(
  app: FastifyInstance,
  service: PathfinderMarkService,
  logger: AppLogger
): void {
  app.post("/api/flags/:flagId/pathfinder-mark", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const { flagId } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body);
      const session = requireRequestSession(request);
      if (!session.player) throw new PathfinderMarkError("PATHFINDER_MARK_INVALID", "Player onboarding is required.");
      return { mark: await service.mark(session.player.id, body.requestId, flagId) };
    } catch (error) {
      if (error instanceof PathfinderMarkError) {
        sendError(reply, error.code === "PATHFINDER_MARK_NOT_FOUND" ? 404 : 409, error.code, error.message);
        return;
      }
      if (error instanceof z.ZodError) {
        sendError(reply, 400, "PATHFINDER_MARK_INVALID", "Invalid mark request.");
        return;
      }
      logger.warn({ err: error }, "pathfinder mark failed");
      sendError(reply, 500, "PATHFINDER_MARK_UNAVAILABLE", "Marking is temporarily unavailable.");
    }
  });
}

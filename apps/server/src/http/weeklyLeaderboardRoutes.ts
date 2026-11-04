import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import type { WeeklyLeaderboardService } from "../game/weeklyLeaderboards.js";
import { sendError } from "./errors.js";

const querySchema = z.object({
  week: z.enum(["current", "previous"]).default("current")
}).strict();

export function registerWeeklyLeaderboardRoutes(
  app: FastifyInstance,
  service: WeeklyLeaderboardService
): void {
  app.get(
    "/api/leaderboards/weekly",
    {
      preHandler: app.rateLimit({
        max: 30,
        timeWindow: "1 minute",
        groupId: "weekly-leaderboards",
        keyGenerator: (request: FastifyRequest) =>
          `player:${authenticatedPlayerId(request)}`
      })
    },
    async (request, reply) => {
      const query = querySchema.safeParse(request.query);
      if (!query.success) {
        sendError(reply, 400, "INVALID_LEADERBOARD_WEEK", "Invalid leaderboard week");
        return;
      }
      try {
        return await service.snapshot(
          authenticatedPlayerId(request),
          query.data.week
        );
      } catch {
        sendError(
          reply,
          503,
          "LEADERBOARDS_UNAVAILABLE",
          "Weekly leaderboards are temporarily unavailable"
        );
      }
    }
  );
}

function authenticatedPlayerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new Error("Player onboarding is required");
  return session.player.id;
}

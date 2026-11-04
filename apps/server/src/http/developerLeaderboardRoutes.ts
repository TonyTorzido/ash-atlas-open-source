import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AuthService } from "../auth/authService.js";
import {
  DeveloperLeaderboardError,
  type DeveloperLeaderboardService
} from "../game/developerLeaderboards.js";
import { sendError } from "./errors.js";
import {
  authorizeDeveloperHttp,
  recordDeveloperHttpResult
} from "./routes/routeAuthentication.js";

const weekQuerySchema = z.object({
  week: z.enum(["current", "previous"]).default("current")
}).strict();

const searchQuerySchema = z.object({
  search: z.string().trim().max(80).default("")
}).strict();

const playerParamsSchema = z.object({
  playerId: z.string().min(1).max(128)
}).strict();

const rankingParamsSchema = z.object({
  metricKey: z.string().min(1).max(80)
}).strict();

const CAPABILITY = "developer:leaderboards-private" as const;

export function registerDeveloperLeaderboardRoutes(
  app: FastifyInstance,
  auth: AuthService,
  leaderboards: DeveloperLeaderboardService
): void {
  app.get("/api/dev/leaderboards/players", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "leaderboards.players.search"
    );
    if (!session) return;
    try {
      const query = searchQuerySchema.safeParse(request.query);
      if (!query.success) {
        sendError(reply, 400, "INVALID_PLAYER_SEARCH", "Player search is invalid");
        return;
      }
      const result = await leaderboards.searchPlayers(query.data.search);
      await recordDeveloperHttpResult(auth, session, {
        capability: CAPABILITY,
        command: "leaderboards.players.search",
        outcome: "succeeded"
      });
      return result;
    } catch (error) {
      await recordFailure(auth, session, "leaderboards.players.search");
      routeError(reply, error);
    }
  });

  app.get("/api/dev/leaderboards/player/:playerId", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const parsedParams = playerParamsSchema.safeParse(request.params);
    const target = parsedParams.success ? parsedParams.data.playerId : null;
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "leaderboards.player.inspect", target
    );
    if (!session) return;
    try {
      const query = weekQuerySchema.safeParse(request.query);
      if (!parsedParams.success || !query.success) {
        sendError(reply, 400, "INVALID_LEADERBOARD_REQUEST", "Leaderboard request is invalid");
        return;
      }
      const result = await leaderboards.inspectPlayer(
        parsedParams.data.playerId,
        query.data.week
      );
      await recordDeveloperHttpResult(auth, session, {
        capability: CAPABILITY,
        command: "leaderboards.player.inspect",
        target: parsedParams.data.playerId,
        outcome: "succeeded"
      });
      return result;
    } catch (error) {
      await recordFailure(auth, session, "leaderboards.player.inspect", target);
      routeError(reply, error);
    }
  });

  app.get("/api/dev/leaderboards/ranking/:metricKey", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const parsedParams = rankingParamsSchema.safeParse(request.params);
    const target = parsedParams.success ? parsedParams.data.metricKey : null;
    const session = await authorizeDeveloperHttp(
      request, reply, auth, CAPABILITY, "leaderboards.private.rank", target
    );
    if (!session) return;
    try {
      const query = weekQuerySchema.safeParse(request.query);
      if (!parsedParams.success || !query.success) {
        sendError(reply, 400, "INVALID_LEADERBOARD_REQUEST", "Leaderboard request is invalid");
        return;
      }
      const result = await leaderboards.privateRanking(
        parsedParams.data.metricKey,
        query.data.week
      );
      await recordDeveloperHttpResult(auth, session, {
        capability: CAPABILITY,
        command: "leaderboards.private.rank",
        target: parsedParams.data.metricKey,
        outcome: "succeeded"
      });
      return result;
    } catch (error) {
      await recordFailure(auth, session, "leaderboards.private.rank", target);
      routeError(reply, error);
    }
  });
}

async function recordFailure(
  auth: AuthService,
  session: Parameters<typeof recordDeveloperHttpResult>[1],
  command: string,
  target: string | null = null
): Promise<void> {
  await recordDeveloperHttpResult(auth, session, {
    capability: CAPABILITY,
    command,
    target,
    outcome: "failed"
  });
}

function routeError(
  reply: Parameters<typeof sendError>[0],
  error: unknown
): void {
  if (error instanceof DeveloperLeaderboardError) {
    sendError(reply, error.statusCode, error.code, error.message);
    return;
  }
  sendError(
    reply,
    500,
    "DEVELOPER_LEADERBOARDS_UNAVAILABLE",
    "Developer leaderboards are temporarily unavailable"
  );
}

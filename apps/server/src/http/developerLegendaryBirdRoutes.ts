import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AuthService } from "../auth/authService.js";
import {
  LegendaryBirdDeveloperError,
  type LegendaryBirdEventService
} from "../game/legendaryBirdEvents.js";
import { sendError } from "./errors.js";
import { authorizeDeveloperHttp, recordDeveloperHttpResult } from "./routes/routeAuthentication.js";

const CAPABILITY = "developer:world-mutate" as const;
const searchSchema = z.object({ search: z.string().trim().max(80).default("") }).strict();
const triggerSchema = z.object({
  playerId: z.string().min(1).max(128),
  birdSpecies: z.enum(["fire", "lightning", "ice"]).optional(),
  operationKey: z.string().uuid()
}).strict();

export function registerDeveloperLegendaryBirdRoutes(
  app: FastifyInstance,
  auth: AuthService,
  events: LegendaryBirdEventService
): void {
  app.get("/api/dev/legendary-birds/players", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, "legendary-birds.players.search");
    if (!session) return;
    const parsed = searchSchema.safeParse(request.query);
    if (!parsed.success) {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: "legendary-birds.players.search", outcome: "failed" });
      return sendError(reply, 400, "INVALID_LEGENDARY_BIRD_SEARCH", "Player search is invalid");
    }
    try {
      const result = await events.searchDeveloperPlayers(parsed.data.search);
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: "legendary-birds.players.search", outcome: "succeeded" });
      return result;
    } catch {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: "legendary-birds.players.search", outcome: "failed" });
      return sendError(reply, 500, "LEGENDARY_BIRD_SEARCH_UNAVAILABLE", "Player search is temporarily unavailable");
    }
  });

  app.post("/api/dev/legendary-birds/trigger", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = triggerSchema.safeParse(request.body);
    const target = parsed.success ? parsed.data.playerId : null;
    const operationKey = parsed.success ? parsed.data.operationKey : null;
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, "legendary-birds.trigger", target, operationKey);
    if (!session) return;
    if (!parsed.success) {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: "legendary-birds.trigger", target, operationKey, outcome: "failed" });
      return sendError(reply, 400, "INVALID_LEGENDARY_BIRD_TRIGGER", "Legendary bird trigger is invalid");
    }
    try {
      const result = await events.triggerDeveloperEvent({
        playerId: parsed.data.playerId,
        operationKey: parsed.data.operationKey,
        ...(parsed.data.birdSpecies ? { birdSpecies: parsed.data.birdSpecies } : {})
      });
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: "legendary-birds.trigger", target, operationKey, outcome: "succeeded" });
      return result;
    } catch (error) {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: "legendary-birds.trigger", target, operationKey, outcome: "failed" });
      if (error instanceof LegendaryBirdDeveloperError) return sendError(reply, error.statusCode, error.code, error.message);
      return sendError(reply, 500, "LEGENDARY_BIRD_TRIGGER_UNAVAILABLE", "Legendary bird trigger is temporarily unavailable");
    }
  });
}

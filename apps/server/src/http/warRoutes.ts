import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession, sendAuthError } from "../auth/authGuard.js";
import { OrganizationWarError, type OrganizationWarService } from "../game/warStructures.js";
import type { AppLogger } from "../logger.js";
import { sendError } from "./errors.js";

const organizationSchema = z.object({
  kind: z.enum(["city", "kingdom"]),
  id: z.string().uuid()
}).strict();

const declareSchema = z.object({
  as: organizationSchema,
  target: organizationSchema
}).strict();

const warActionSchema = z.object({
  warId: z.string().uuid(),
  as: organizationSchema
}).strict();

const targetsQuerySchema = z.object({
  q: z.string().max(64).default("")
}).strict();

/**
 * Organization war state for kingdom and city settings: the active-wars list,
 * a target search, the leader / Mayor declaration, surrender and mutual
 * peace. War also starts on its own when a member attacks another
 * organization's structure, unless a forced peace holds.
 */
export function registerWarRoutes(
  app: FastifyInstance,
  wars: OrganizationWarService,
  logger: AppLogger
): void {
  app.get("/api/wars", async (request, reply) => {
    try {
      return { state: await wars.state(playerId(request)) };
    } catch (error) {
      sendWarError(reply, error, logger);
    }
  });

  app.get("/api/wars/targets", async (request, reply) => {
    try {
      const query = targetsQuerySchema.parse(request.query ?? {});
      return { targets: await wars.targets(playerId(request), query.q) };
    } catch (error) {
      sendWarError(reply, error, logger);
    }
  });

  app.post("/api/wars/declare", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actor = playerId(request);
      const body = declareSchema.parse(request.body);
      const result = await wars.declare(actor, body);
      return { ...result, state: await wars.state(actor) };
    } catch (error) {
      sendWarError(reply, error, logger);
    }
  });

  app.post("/api/wars/surrender", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actor = playerId(request);
      const result = await wars.surrender(actor, warActionSchema.parse(request.body));
      return { surrender: result, state: await wars.state(actor) };
    } catch (error) {
      sendWarError(reply, error, logger);
    }
  });

  app.post("/api/wars/peace/offer", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actor = playerId(request);
      const result = await wars.offerPeace(actor, warActionSchema.parse(request.body));
      return { ...result, state: await wars.state(actor) };
    } catch (error) {
      sendWarError(reply, error, logger);
    }
  });

  app.post("/api/wars/peace/accept", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actor = playerId(request);
      const result = await wars.acceptPeace(actor, warActionSchema.parse(request.body));
      return { ...result, state: await wars.state(actor) };
    } catch (error) {
      sendWarError(reply, error, logger);
    }
  });
}

function playerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new OrganizationWarError("WAR_PLAYER_REQUIRED", "Player onboarding is required", 401);
  return session.player.id;
}

function sendWarError(reply: FastifyReply, error: unknown, logger: AppLogger): void {
  if (error instanceof Error && error.name === "AuthError") {
    sendAuthError(reply, error);
    return;
  }
  if (error instanceof OrganizationWarError) {
    sendError(reply, error.statusCode, error.code, error.message);
    return;
  }
  if (error instanceof z.ZodError) {
    sendError(reply, 400, "WAR_REQUEST_INVALID", "Invalid war request");
    return;
  }
  logger.error({ err: error }, "war route failed");
  sendError(reply, 500, "WAR_INTERNAL_ERROR", "War state is unavailable");
}

import { MONOLITH_TYPES } from "@ash-atlas/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession, sendAuthError } from "../auth/authGuard.js";
import { MonolithError, type MonolithService } from "../game/monoliths.js";
import type { GameState } from "../game/state.js";
import type { AppLogger } from "../logger.js";
import { sendError } from "./errors.js";

const requestIdSchema = z.string().min(8).max(128);
const placeSchema = z.object({ requestId: requestIdSchema, type: z.enum(MONOLITH_TYPES) }).strict();
const monolithActionSchema = z.object({ requestId: requestIdSchema, monolithId: z.string().uuid() }).strict();

/**
 * Field Engineering monoliths. Every mutation uses the player's live,
 * server-held world position; the client never supplies coordinates.
 */
export function registerMonolithRoutes(
  app: FastifyInstance,
  monoliths: MonolithService,
  gameState: GameState,
  isOnWorldMap: (playerId: string) => Promise<boolean>,
  logger: AppLogger
): void {
  // Monoliths stand on the world map: inside an interior or dungeon the
  // player has no usable position (the service then refuses mutations).
  const livePosition = async (playerId: string) => {
    const player = gameState.getPlayer(playerId);
    if (!player || !(await isOnWorldMap(playerId))) return null;
    return { lat: player.position.lat, lon: player.position.lon };
  };

  app.get("/api/monoliths", async (request, reply) => {
    try {
      const actor = playerId(request);
      return { state: await monoliths.state(actor, await livePosition(actor)) };
    } catch (error) {
      sendMonolithError(reply, error, logger);
    }
  });

  app.post("/api/monoliths/place", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actor = playerId(request);
      const body = placeSchema.parse(request.body);
      const result = await monoliths.place(actor, await livePosition(actor), body.type, body.requestId);
      return { ...result, state: await monoliths.state(actor, await livePosition(actor)) };
    } catch (error) {
      sendMonolithError(reply, error, logger);
    }
  });

  app.post("/api/monoliths/recharge", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actor = playerId(request);
      const body = monolithActionSchema.parse(request.body);
      const result = await monoliths.recharge(actor, await livePosition(actor), body.monolithId, body.requestId);
      return { ...result, state: await monoliths.state(actor, await livePosition(actor)) };
    } catch (error) {
      sendMonolithError(reply, error, logger);
    }
  });

  app.post("/api/monoliths/ignite", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actor = playerId(request);
      const body = monolithActionSchema.parse(request.body);
      const result = await monoliths.ignite(actor, await livePosition(actor), body.monolithId, body.requestId);
      return { ...result, state: await monoliths.state(actor, await livePosition(actor)) };
    } catch (error) {
      sendMonolithError(reply, error, logger);
    }
  });
}

function playerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new MonolithError("MONOLITH_PLAYER_REQUIRED", "Player onboarding is required", 401);
  return session.player.id;
}

function sendMonolithError(reply: FastifyReply, error: unknown, logger: AppLogger): void {
  if (error instanceof Error && error.name === "AuthError") {
    sendAuthError(reply, error);
    return;
  }
  if (error instanceof MonolithError) {
    sendError(reply, error.statusCode, error.code, error.message);
    return;
  }
  if (error instanceof z.ZodError) {
    sendError(reply, 400, "MONOLITH_REQUEST_INVALID", "Invalid monolith request");
    return;
  }
  logger.error({ err: error }, "monolith route failed");
  sendError(reply, 500, "MONOLITH_INTERNAL_ERROR", "Monoliths are unavailable");
}

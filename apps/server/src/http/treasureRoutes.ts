import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession, sendAuthError } from "../auth/authGuard.js";
import { TreasureError, type TreasureService } from "../game/buriedTreasure.js";
import type { GameState } from "../game/state.js";
import type { AppLogger } from "../logger.js";
import { sendError } from "./errors.js";

const requestIdSchema = z.string().min(8).max(128);
const craftSchema = z.object({ requestId: requestIdSchema }).strict();
const digSchema = z.object({ requestId: requestIdSchema, treasureId: z.string().uuid() }).strict();

/**
 * Buried treasure. Every mutation uses the player's live, server-held world
 * position; the client never supplies coordinates, and the nearby list only
 * ever contains the tiers this player is allowed to see.
 */
export function registerTreasureRoutes(
  app: FastifyInstance,
  treasure: TreasureService,
  gameState: GameState,
  isOnWorldMap: (playerId: string) => Promise<boolean>,
  getInventory: (playerId: string) => Promise<unknown>,
  logger: AppLogger
): void {
  const livePosition = async (playerId: string) => {
    const player = gameState.getPlayer(playerId);
    if (!player || !(await isOnWorldMap(playerId))) return null;
    return { lat: player.position.lat, lon: player.position.lon };
  };

  app.get("/api/treasure", async (request, reply) => {
    try {
      const actor = playerId(request);
      return { state: await treasure.state(actor, await livePosition(actor)) };
    } catch (error) {
      sendTreasureError(reply, error, logger);
    }
  });

  app.post("/api/treasure/artisan-shovel", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actor = playerId(request);
      const body = craftSchema.parse(request.body);
      const result = await treasure.artisanShovel(actor, body.requestId);
      return { ...result, state: await treasure.state(actor, await livePosition(actor)), inventory: await getInventory(actor) };
    } catch (error) {
      sendTreasureError(reply, error, logger);
    }
  });

  app.post("/api/treasure/dig", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actor = playerId(request);
      const body = digSchema.parse(request.body);
      const result = await treasure.dig(actor, await livePosition(actor), body.treasureId, body.requestId);
      return { ...result, state: await treasure.state(actor, await livePosition(actor)), inventory: await getInventory(actor) };
    } catch (error) {
      sendTreasureError(reply, error, logger);
    }
  });
}

function playerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new TreasureError("TREASURE_PLAYER_REQUIRED", "Player onboarding is required", 401);
  return session.player.id;
}

function sendTreasureError(reply: FastifyReply, error: unknown, logger: AppLogger): void {
  if (error instanceof Error && error.name === "AuthError") {
    sendAuthError(reply, error);
    return;
  }
  if (error instanceof TreasureError) {
    sendError(reply, error.statusCode, error.code, error.message);
    return;
  }
  if (error instanceof z.ZodError) {
    sendError(reply, 400, "TREASURE_REQUEST_INVALID", "Invalid treasure request");
    return;
  }
  logger.error({ err: error }, "treasure route failed");
  sendError(reply, 500, "TREASURE_INTERNAL_ERROR", "Buried treasure is unavailable");
}

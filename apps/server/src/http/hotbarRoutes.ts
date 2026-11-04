import {
  hotbarUpdateSchema,
  preserveHotbarActionBindings,
  stripHotbarActionBindings,
  type HotbarSettings
} from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireRequestSession } from "../auth/authGuard.js";
import { HotbarError, type HotbarService } from "../game/hotbar.js";
import type { AppLogger } from "../logger.js";
import { sendError } from "./errors.js";

export function registerHotbarRoutes(
  app: FastifyInstance,
  service: HotbarService,
  logger: AppLogger
): void {
  app.get(
    "/api/profile/me/hotbar",
    { preHandler: hotbarRateLimit(app, 60, "hotbar-read") },
    async (request, reply) => {
      try {
        return { hotbar: viewForClient(request, await service.get(authenticatedPlayerId(request))) };
      } catch (error) {
        sendHotbarError(reply, error, logger, "load");
      }
    }
  );

  app.patch(
    "/api/profile/me/hotbar",
    {
      bodyLimit: 8_192,
      preHandler: hotbarRateLimit(app, 30, "hotbar-write")
    },
    async (request, reply) => {
      try {
        const body = hotbarUpdateSchema.safeParse(request.body);
        if (!body.success) throw new HotbarError("HOTBAR_INVALID", "Hotbar slots are invalid.", 400);
        const playerId = authenticatedPlayerId(request);
        const update = supportsActionBindings(request)
          ? body.data
          : preserveHotbarActionBindings(body.data, await service.get(playerId));
        return {
          hotbar: viewForClient(request, await service.update(playerId, update))
        };
      } catch (error) {
        sendHotbarError(reply, error, logger, "save");
      }
    }
  );
}
/** Clients that predate action bindings would reject them, so they never receive them. */
function supportsActionBindings(request: FastifyRequest): boolean {
  return (request.query as Record<string, unknown> | undefined)?.bindings === "actions";
}

function viewForClient(request: FastifyRequest, hotbar: HotbarSettings): HotbarSettings {
  return supportsActionBindings(request) ? hotbar : stripHotbarActionBindings(hotbar);
}

function authenticatedPlayerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new HotbarError("PLAYER_REQUIRED", "Player onboarding is required.", 409);
  return session.player.id;
}

function hotbarRateLimit(app: FastifyInstance, maximum: number, groupId: string) {
  return app.rateLimit({
    max: maximum,
    timeWindow: "1 minute",
    groupId,
    keyGenerator: (request: FastifyRequest) => `player:${authenticatedPlayerId(request)}`
  });
}

function sendHotbarError(
  reply: Parameters<typeof sendError>[0],
  error: unknown,
  logger: AppLogger,
  operation: "load" | "save"
): void {
  if (error instanceof HotbarError) {
    sendError(reply, error.statusCode, error.code, error.message);
    return;
  }
  logger.warn({ err: error }, `hotbar ${operation} request failed`);
  sendError(reply, 503, "HOTBAR_UNAVAILABLE", "Hotbar settings are temporarily unavailable.");
}

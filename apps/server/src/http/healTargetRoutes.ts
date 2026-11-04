import type { HealTargetSettings } from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireRequestSession } from "../auth/authGuard.js";
import { HealTargetError, type HealTargetService } from "../game/healTargets.js";
import type { AppLogger } from "../logger.js";
import { sendError } from "./errors.js";

/** Holy arc heal-target settings (Settings > Gameplay). `onChanged` pushes the new settings into the live engine. */
export function registerHealTargetRoutes(
  app: FastifyInstance,
  service: HealTargetService,
  logger: AppLogger,
  onChanged: (playerId: string, settings: HealTargetSettings) => void = () => {}
): void {
  app.get(
    "/api/profile/me/heal-targets",
    { preHandler: healTargetRateLimit(app, 60, "heal-targets-read") },
    async (request, reply) => {
      try {
        return { healTargets: await service.get(authenticatedPlayerId(request)) };
      } catch (error) {
        sendHealTargetError(reply, error, logger, "load");
      }
    }
  );

  app.patch(
    "/api/profile/me/heal-targets",
    { bodyLimit: 1_024, preHandler: healTargetRateLimit(app, 60, "heal-targets-write") },
    async (request, reply) => {
      try {
        const playerId = authenticatedPlayerId(request);
        const settings = await service.update(playerId, request.body as never);
        onChanged(playerId, settings);
        return { healTargets: settings };
      } catch (error) {
        sendHealTargetError(reply, error, logger, "save");
      }
    }
  );
}

function authenticatedPlayerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new HealTargetError("PLAYER_REQUIRED", "Player onboarding is required.", 409);
  return session.player.id;
}

function healTargetRateLimit(app: FastifyInstance, maximum: number, groupId: string) {
  return app.rateLimit({
    max: maximum,
    timeWindow: "1 minute",
    groupId,
    keyGenerator: (request: FastifyRequest) => `player:${authenticatedPlayerId(request)}`
  });
}

function sendHealTargetError(
  reply: Parameters<typeof sendError>[0],
  error: unknown,
  logger: AppLogger,
  operation: "load" | "save"
): void {
  if (error instanceof HealTargetError) {
    sendError(reply, error.statusCode, error.code, error.message);
    return;
  }
  logger.warn({ err: error }, `heal-target ${operation} request failed`);
  sendError(reply, 503, "HEAL_TARGETS_UNAVAILABLE", "Heal-target settings are temporarily unavailable.");
}

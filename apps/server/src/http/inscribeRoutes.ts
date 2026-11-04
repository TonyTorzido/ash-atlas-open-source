import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import { filterChatBody } from "../chat/contentPolicy.js";
import { JewelStationError, type JewelStationService } from "../game/jewelStation.js";
import type { AppLogger } from "../logger.js";
import { sendError } from "./errors.js";

const bodySchema = z.object({
  requestId: z.string().min(1).max(128),
  instanceId: z.string().uuid(),
  name: z.string().min(1).max(80)
}).strict();

export function registerInscribeRoutes(
  app: FastifyInstance,
  service: JewelStationService,
  logger: AppLogger
): void {
  app.post("/api/jewel-station/inscribe", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const body = bodySchema.parse(request.body);
      const session = requireRequestSession(request);
      if (!session.player) throw new JewelStationError("JEWEL_INVALID_REQUEST", "Player onboarding is required.");
      const result = await service.inscribe(
        session.player.id, body.requestId, body.instanceId, body.name,
        (name) => {
          const filtered = filterChatBody(name);
          return filtered.allowed && !filtered.masked;
        }
      );
      return result;
    } catch (error) {
      if (error instanceof JewelStationError) {
        sendError(reply, error.code === "EQUIPMENT_NOT_FOUND" ? 404 : 409, error.code, error.message);
        return;
      }
      if (error instanceof z.ZodError) {
        sendError(reply, 400, "JEWEL_INVALID_REQUEST", "Invalid inscription request.");
        return;
      }
      logger.warn({ err: error }, "inscribe failed");
      sendError(reply, 500, "JEWEL_UNAVAILABLE", "Inscribing is temporarily unavailable.");
    }
  });
}

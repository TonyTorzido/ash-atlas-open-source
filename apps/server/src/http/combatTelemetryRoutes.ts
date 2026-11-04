import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import type { CombatTelemetryService } from "../game/combat/combatTelemetry.js";
import type { AppLogger } from "../logger.js";
import { sendError } from "./errors.js";

const recentCombatTelemetryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
}).strict();

type CombatTelemetryExporter = Pick<CombatTelemetryService, "exportRecentForPlayer">;

export function registerCombatTelemetryRoutes(
  app: FastifyInstance,
  _config: AppConfig,
  telemetry: CombatTelemetryExporter,
  logger: Pick<AppLogger, "warn">,
  auth: AuthService
): void {
  app.get(
    "/api/dev/combat-telemetry/recent",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const session = request.authSession;
      if (!session?.player) {
        sendError(
          reply,
          403,
          "DEVELOPER_COMMAND_FORBIDDEN",
          "Developer command is unavailable"
        );
        return;
      }
      try {
        await auth.authorizeDeveloperCommand(session, {
          capability: "developer:observe",
          command: "combat-telemetry.recent",
          transport: "http",
          target: session?.player?.id ?? null
        });
      } catch {
        sendError(
          reply,
          403,
          "DEVELOPER_COMMAND_FORBIDDEN",
          "Developer command is unavailable"
        );
        return;
      }
      const playerId = session.player.id;

      const query = recentCombatTelemetryQuerySchema.safeParse(request.query);
      if (!query.success) {
        sendError(
          reply,
          400,
          "BAD_COMBAT_TELEMETRY_QUERY",
          "limit must be an integer from 1 through 200"
        );
        return;
      }

      try {
        const exported = await telemetry.exportRecentForPlayer(playerId, query.data.limit);
        return reply.type("application/json; charset=utf-8").send(exported);
      } catch (error) {
        logger.warn({ err: error, playerId }, "failed to export recent combat telemetry");
        sendError(
          reply,
          503,
          "COMBAT_TELEMETRY_UNAVAILABLE",
          "recent combat telemetry is unavailable"
        );
      }
    }
  );
}

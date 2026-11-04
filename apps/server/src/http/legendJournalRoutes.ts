import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import { AuthError } from "../auth/types.js";
import type { LegendJournalService } from "../game/legendJournal.js";
import { sendError } from "./errors.js";

export function registerLegendJournalRoutes(
  app: FastifyInstance,
  journal: Pick<LegendJournalService, "snapshot">
): void {
  app.get("/api/legends", {
    preHandler: app.rateLimit({
      max: 12,
      timeWindow: "1 minute",
      groupId: "legend-journal",
      keyGenerator: (request: FastifyRequest) => `player:${journalPlayerId(request)}`
    })
  }, async (request, reply) => {
    // Identity comes from the authenticated session, never an ID in a query.
    const playerId = journalPlayerId(request);
    if (!z.object({}).strict().safeParse(request.query).success) {
      return sendError(reply, 400, "INVALID_JOURNAL_QUERY", "The journal uses your current character.");
    }
    reply.header("Cache-Control", "private, no-store");
    try {
      return await journal.snapshot(playerId);
    } catch (error) {
      request.log.warn({ err: error, playerId }, "legend journal refresh failed");
      return sendError(reply, 503, "JOURNAL_UNAVAILABLE", "Your journal could not be refreshed. Try again.");
    }
  });
}

function journalPlayerId(request: FastifyRequest): string {
  const player = requireRequestSession(request).player;
  if (!player) throw new AuthError("ACCOUNT_UNAVAILABLE", "Choose your character first.", 409);
  return player.id;
}

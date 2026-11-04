import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import {
  CommunitySafetyError,
  CURRENT_COMMUNITY_RULES_VERSION,
  UGC_REPORT_CATEGORIES,
  type CommunitySafetyService
} from "../communitySafety.js";

const acceptTermsSchema = z.object({
  version: z.literal(CURRENT_COMMUNITY_RULES_VERSION)
}).strict();

const reportSchema = z.object({
  targetKind: z.enum(["message", "player"]),
  targetId: z.string().trim().min(1).max(128),
  category: z.enum(UGC_REPORT_CATEGORIES),
  explanation: z.string().trim().max(1_000).optional()
}).strict();

export function registerCommunitySafetyRoutes(
  app: FastifyInstance,
  service: CommunitySafetyService
): void {
  app.get("/api/community/terms", async (request, reply) => {
    try {
      const session = requireRequestSession(request);
      return {
        version: CURRENT_COMMUNITY_RULES_VERSION,
        accepted: await service.hasCurrentTermsAcceptance(authenticatedPlayerId(session.player?.id))
      };
    } catch (error) {
      sendCommunitySafetyError(reply, error);
    }
  });

  app.post(
    "/api/community/terms/accept",
    {
      bodyLimit: 1_024,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 hour",
          groupId: "community-terms"
        }
      }
    },
    async (request, reply) => {
      try {
        const session = requireRequestSession(request);
        const parsed = acceptTermsSchema.safeParse(request.body);
        if (!parsed.success) {
          throw new CommunitySafetyError(
            "TERMS_VERSION_UNSUPPORTED",
            "The current Community Rules version must be accepted."
          );
        }
        return {
          accepted: true,
          ...(await service.acceptCurrentTerms(authenticatedPlayerId(session.player?.id)))
        };
      } catch (error) {
        sendCommunitySafetyError(reply, error);
      }
    }
  );

  app.post(
    "/api/community/reports",
    {
      bodyLimit: 4_096,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 hour",
          groupId: "community-reports"
        }
      }
    },
    async (request, reply) => {
      try {
        const session = requireRequestSession(request);
        const parsed = reportSchema.safeParse(request.body);
        if (!parsed.success) {
          throw new CommunitySafetyError("REPORT_INVALID", "Report details are invalid.");
        }
        const report = await service.createReport({
          reporterPlayerId: authenticatedPlayerId(session.player?.id),
          target: parsed.data.targetKind === "message"
            ? { kind: "message", messageId: parsed.data.targetId }
            : { kind: "player", playerId: parsed.data.targetId },
          category: parsed.data.category,
          ...(parsed.data.explanation === undefined
            ? {}
            : { explanation: parsed.data.explanation })
        });
        reply.code(201);
        return { accepted: true, reportId: report.id, status: report.status };
      } catch (error) {
        sendCommunitySafetyError(reply, error);
      }
    }
  );
}

function authenticatedPlayerId(playerId: string | undefined): string {
  if (!playerId) throw new CommunitySafetyError("REPORT_INVALID", "A playable account is required.", 403);
  return playerId;
}

function sendCommunitySafetyError(reply: FastifyReply, error: unknown): void {
  if (error instanceof CommunitySafetyError) {
    reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message }
    });
    return;
  }
  reply.code(503).send({
    error: {
      code: "COMMUNITY_SAFETY_UNAVAILABLE",
      message: "Community safety is temporarily unavailable."
    }
  });
}

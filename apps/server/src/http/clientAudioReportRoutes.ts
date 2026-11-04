import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppLogger } from "../logger.js";

/**
 * Music diagnostics: the client posts one small report per session (plus one per audio error) so a silent device can be
 * diagnosed from the server log ("client audio report"). Nothing is stored; the body is bounded and the route is rate limited.
 */
const clientAudioReportSchema = z.object({
  kind: z.enum(["session", "error", "no_gesture"]),
  report: z.record(
    z.string().min(1).max(40),
    z.union([z.string().max(240), z.number().finite(), z.boolean(), z.null()])
  ).refine((value) => Object.keys(value).length <= 60)
}).strict();

export function registerClientAudioReportRoutes(app: FastifyInstance, logger: Pick<AppLogger, "info">): void {
  app.post(
    "/api/diagnostics/audio",
    { bodyLimit: 8_192, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = clientAudioReportSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_AUDIO_REPORT" } });
      logger.info({ audioReport: parsed.data.report, audioReportKind: parsed.data.kind }, "client audio report");
      return reply.code(204).send();
    }
  );
}

/**
 * Motion diagnostics (docs/plans/map-shake.md): while the player walks, the client samples about 5 s of frames once per
 * session (plus up to two more when it detects camera jitter) and posts one flat summary, logged as "client motion report".
 * Same bounds as the audio report; nothing is stored.
 */
const clientMotionReportSchema = z.object({
  kind: z.enum(["session", "jitter"]),
  report: z.record(
    z.string().min(1).max(40),
    z.union([z.string().max(240), z.number().finite(), z.boolean(), z.null()])
  ).refine((value) => Object.keys(value).length <= 80)
}).strict();

export function registerClientMotionReportRoutes(app: FastifyInstance, logger: Pick<AppLogger, "info">): void {
  app.post(
    "/api/diagnostics/motion",
    { bodyLimit: 8_192, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = clientMotionReportSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_MOTION_REPORT" } });
      logger.info({ motionReport: parsed.data.report, motionReportKind: parsed.data.kind }, "client motion report");
      return reply.code(204).send();
    }
  );
}

/**
 * Touch attack aim timings (t1559, apps/client/src/combat/attackAimTelemetry.ts): the first 50 attack-button presses of a
 * session, 10 short rows per report ("source,firstMoveMs,decideMs,distPx,peakPx,swingSide,moveSide,swung"), logged as
 * "client attack aim report". Same bounds as the motion report; nothing is stored.
 */
const clientAttackAimReportSchema = z.object({
  kind: z.enum(["batch"]),
  report: z.record(
    z.string().min(1).max(40),
    z.union([z.string().max(240), z.number().finite(), z.boolean(), z.null()])
  ).refine((value) => Object.keys(value).length <= 40)
}).strict();

export function registerClientAttackAimReportRoutes(app: FastifyInstance, logger: Pick<AppLogger, "info">): void {
  app.post(
    "/api/diagnostics/attack-aim",
    { bodyLimit: 8_192, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = clientAttackAimReportSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_ATTACK_AIM_REPORT" } });
      logger.info({ attackAimReport: parsed.data.report, attackAimReportKind: parsed.data.kind }, "client attack aim report");
      return reply.code(204).send();
    }
  );
}

/**
 * Dungeon stuck reports (apps/client/src/dungeonStuckTelemetry.ts): sent by the client when movement input was ignored
 * or produced no movement for over 2 s inside a dungeon. One flat report with positions, lock and seal states, pending
 * transfer, open modal and texture / WebGL failures, logged as "client dungeon stuck report". Same bounds as the motion
 * report; nothing is stored.
 */
const clientDungeonStuckReportSchema = z.object({
  kind: z.enum(["stuck"]),
  report: z.record(
    z.string().min(1).max(40),
    z.union([z.string().max(240), z.number().finite(), z.boolean(), z.null()])
  ).refine((value) => Object.keys(value).length <= 40)
}).strict();

export function registerClientDungeonStuckReportRoutes(app: FastifyInstance, logger: Pick<AppLogger, "info">): void {
  app.post(
    "/api/diagnostics/dungeon-stuck",
    { bodyLimit: 8_192, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = clientDungeonStuckReportSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_DUNGEON_STUCK_REPORT" } });
      logger.info({ dungeonStuckReport: parsed.data.report }, "client dungeon stuck report");
      return reply.code(204).send();
    }
  );
}

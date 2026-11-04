import { FLAG_ACCESS_MODES } from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import { FlagAccessError, type FlagAccessService } from "../game/flagAccess.js";
import { flagSetRevisionMetadata, type FlagService } from "../game/flags.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { sendError } from "./errors.js";

const flagParamsSchema = z.object({ flagId: z.string().uuid() }).strict();
const settingsSchema = z.object({
  mode: z.enum(FLAG_ACCESS_MODES),
  jumpTollGold: z.string().regex(/^(0|[1-9][0-9]{0,15})$/)
}).strict();
const passageRequestSchema = z.object({ requestId: z.string().min(1).max(128) }).strict();
const resolutionSchema = z.object({
  requestId: z.string().min(1).max(128),
  passageRequestId: z.string().uuid(),
  action: z.enum(["approve", "deny"])
}).strict();
const searchSchema = z.object({ query: z.string().min(2).max(64) }).strict();
const preferencesSchema = z.object({
  defaultFlagAccessMode: z.enum(FLAG_ACCESS_MODES),
  defaultPublicTollGold: z.string().regex(/^(0|[1-9][0-9]{0,15})$/),
  defaultNormalTollGold: z.string().regex(/^(0|[1-9][0-9]{0,15})$/)
}).strict();
const bulkTollSchema = z.object({
  mode: z.enum(["public", "normal"]),
  tollGold: z.string().regex(/^(0|[1-9][0-9]{0,15})$/)
}).strict();
const playerParamsSchema = z.object({ playerId: z.string().min(1).max(160) }).strict();

export function registerFlagAccessRoutes(
  app: FastifyInstance,
  service: FlagAccessService,
  flags: FlagService,
  connections: ConnectionRegistry,
  logger: AppLogger
): void {
  app.get("/api/flags/:flagId/access", async (request, reply) => {
    try {
      const { flagId } = flagParamsSchema.parse(request.params);
      return { access: await service.snapshotForPlayer(flagId, playerId(request)) };
    } catch (error) {
      sendFlagAccessError(reply, error, logger);
    }
  });

  app.patch("/api/flags/:flagId/access", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const { flagId } = flagParamsSchema.parse(request.params);
      const body = settingsSchema.parse(request.body);
      const actor = playerId(request);
      const access = await service.updateSettings({
        ownerPlayerId: actor, flagId,
        mode: body.mode, jumpTollGold: body.jumpTollGold
      });
      const flag = await flags.getMapFlag(flagId);
      const revisionMetadata = await flagSetRevisionMetadata(flags);
      if (flag) connections.broadcast({
        type: "FLAG_UPDATED",
        flag,
        ...revisionMetadata
      });
      connections.send(actor, {
        type: "FLAG_ACCESS_CHANGED",
        flagId,
        message: "Flag access settings saved.",
        ...revisionMetadata
      });
      return { access };
    } catch (error) {
      sendFlagAccessError(reply, error, logger);
    }
  });

  app.post("/api/flags/:flagId/passage-requests", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const { flagId } = flagParamsSchema.parse(request.params);
      const body = passageRequestSchema.parse(request.body);
      const result = await service.requestPassage({
        flagId,
        requesterPlayerId: playerId(request),
        requestId: body.requestId
      });
      connections.send(result.ownerPlayerId, {
        type: "FLAG_ACCESS_CHANGED",
        flagId,
        message: "A player requested passage to all of your current and future Normal flags."
      });
      return { request: result.request, replayed: result.replayed };
    } catch (error) {
      sendFlagAccessError(reply, error, logger);
    }
  });

  app.post("/api/flags/:flagId/passage-requests/resolve", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const { flagId } = flagParamsSchema.parse(request.params);
      const body = resolutionSchema.parse(request.body);
      const actor = playerId(request);
      const pending = await service.passageRequestForOwner(actor, body.passageRequestId);
      const access = await service.resolvePassageRequest({
        ownerPlayerId: actor,
        flagId,
        requestId: body.requestId,
        passageRequestId: body.passageRequestId,
        action: body.action
      });
      if (pending) {
        connections.send(pending.requesterPlayerId, {
          type: "FLAG_ACCESS_CHANGED",
          flagId,
          message: body.action === "approve"
            ? "Your owner-wide Normal passage request was approved."
            : "Your owner-wide Normal passage request was denied."
        });
      }
      return { access };
    } catch (error) {
      sendFlagAccessError(reply, error, logger);
    }
  });

  app.get("/api/flags/management", async (request, reply) => {
    try { return { management: await service.dashboard(playerId(request)) }; }
    catch (error) { sendFlagAccessError(reply, error, logger); }
  });

  app.patch("/api/flags/management/preferences", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const preferences = preferencesSchema.parse(request.body);
      return { preferences: await service.updatePreferences(playerId(request), preferences) };
    } catch (error) { sendFlagAccessError(reply, error, logger); }
  });

  app.post("/api/flags/management/bulk-toll", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const body = bulkTollSchema.parse(request.body);
      const actor = playerId(request);
      const updated = await service.bulkUpdateToll(actor, body.mode, body.tollGold);
      const dashboard = await service.dashboard(actor);
      const revisionMetadata = await flagSetRevisionMetadata(flags);
      for (const managed of dashboard.flags.filter((flag) => flag.mode === body.mode)) {
        const flag = await flags.getMapFlag(managed.flagId);
        if (flag) connections.broadcast({ type: "FLAG_UPDATED", flag, ...revisionMetadata });
      }
      return { updated };
    } catch (error) { sendFlagAccessError(reply, error, logger); }
  });

  app.put("/api/flags/management/normal-grants/:playerId", async (request, reply) => {
    try {
      const target = playerParamsSchema.parse(request.params);
      await service.setNormalGrant(playerId(request), target.playerId, true);
      connections.send(target.playerId, { type: "FLAG_ACCESS_CHANGED", flagId: "normal", message: "A flag owner granted you Normal passage." });
      return { ok: true };
    } catch (error) { sendFlagAccessError(reply, error, logger); }
  });

  app.delete("/api/flags/management/normal-grants/:playerId", async (request, reply) => {
    try {
      const target = playerParamsSchema.parse(request.params);
      await service.setNormalGrant(playerId(request), target.playerId, false);
      connections.send(target.playerId, { type: "FLAG_ACCESS_CHANGED", flagId: "normal", message: "A flag owner revoked your owner-wide Normal passage." });
      return { ok: true };
    } catch (error) { sendFlagAccessError(reply, error, logger); }
  });

  app.get("/api/flags/access/player-search", async (request, reply) => {
    try {
      const query = searchSchema.parse(request.query);
      return { players: await service.searchPlayers(playerId(request), query.query) };
    } catch (error) {
      sendFlagAccessError(reply, error, logger);
    }
  });
}

function playerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new FlagAccessError("FLAG_ACCESS_FORBIDDEN", "Player onboarding is required.");
  return session.player.id;
}

function sendFlagAccessError(
  reply: Parameters<typeof sendError>[0],
  error: unknown,
  logger: AppLogger
): void {
  if (error instanceof FlagAccessError) {
    const status = error.code === "FLAG_NOT_FOUND" || error.code === "PASSAGE_REQUEST_NOT_FOUND"
      ? 404
      : error.code === "FLAG_ACCESS_FORBIDDEN"
        ? 403
        : error.code === "INSUFFICIENT_GOLD" || error.code === "TOLL_CHANGED" ||
            error.code === "ACCESS_CHANGED" || error.code === "FLAG_CHANGED" ||
            error.code === "OWNER_CHANGED" ||
            error.code.includes("LIMIT") || error.code.includes("EXISTS") ||
            error.code.includes("PENDING") || error.code.includes("RATE_LIMITED")
          ? 409
          : 400;
    sendError(reply, status, error.code, error.message, error.details);
    return;
  }
  if (error instanceof z.ZodError) {
    sendError(reply, 400, "FLAG_ACCESS_INVALID", "Invalid flag access request.");
    return;
  }
  logger.warn({ err: error }, "flag access request failed");
  sendError(reply, 500, "FLAG_ACCESS_UNAVAILABLE", "Flag access is temporarily unavailable.");
}

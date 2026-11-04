import { HARVEST_ACCESS_MODES, HARVEST_TOLL_TYPES } from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import { HarvestAccessError, type HarvestAccessService } from "../game/harvestAccess.js";
import type { GameState } from "../game/state.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { sendError } from "./errors.js";

const tollSchema = z.object({
  harvestType: z.enum(HARVEST_TOLL_TYPES),
  tollGold: z.string().regex(/^(0|[1-9][0-9]{0,15})$/),
  expectedRevision: z.string().regex(/^(0|[1-9][0-9]*)$/)
}).strict();
const assetSchema = z.object({ assetId: z.string().uuid() }).strict();
const accessSchema = z.object({
  harvestType: z.enum(HARVEST_TOLL_TYPES),
  accessMode: z.enum(HARVEST_ACCESS_MODES),
  expectedRevision: z.string().regex(/^(0|[1-9][0-9]*)$/)
}).strict();

export function registerHarvestAccessRoutes(
  app: FastifyInstance,
  service: HarvestAccessService,
  connections: ConnectionRegistry,
  logger: AppLogger,
  gameState: GameState
): void {
  app.get("/api/harvest-tolls", async (request, reply) => {
    try { return { tolls: await service.dashboard(playerId(request)) }; }
    catch (error) { sendHarvestError(reply, error, logger); }
  });
  app.patch("/api/harvest-tolls", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const ownerPlayerId = playerId(request);
      const body = tollSchema.parse(request.body);
      const tolls = await service.updateToll({ ownerPlayerId, ...body });
      connections.broadcast({
        type: "HARVEST_ACCESS_CHANGED",
        ownerPlayerId,
        harvestType: body.harvestType,
        assetId: null,
        accessMode: null,
        accessRevision: null,
        tollGold: body.tollGold,
        serverTime: Date.now()
      });
      return { tolls };
    }
    catch (error) { sendHarvestError(reply, error, logger); }
  });
  app.patch("/api/harvest-tolls/assets/:assetId", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const { assetId } = assetSchema.parse(request.params);
      const ownerPlayerId = playerId(request);
      const player = gameState.getPlayer(ownerPlayerId);
      if (!player || !player.online || !connections.activeConnectionIdForPlayer(ownerPlayerId) ||
          !gameState.isWorldPresent(ownerPlayerId)) {
        throw new HarvestAccessError(
          "HARVEST_ACCESS_FORBIDDEN",
          "Harvest access can only be changed by a connected player present in the world."
        );
      }
      const body = accessSchema.parse(request.body);
      const tolls = await service.updateAsset({
        ownerPlayerId,
        assetId,
        ...body,
        position: { ...player.position }
      });
      const asset = tolls.assets.find((candidate) => candidate.assetId === assetId);
      const setting = tolls.settings.find((candidate) => candidate.harvestType === body.harvestType);
      if (!asset || !setting) throw new Error("Updated harvest access projection is unavailable");
      connections.broadcast({
        type: "HARVEST_ACCESS_CHANGED",
        ownerPlayerId,
        harvestType: body.harvestType,
        assetId,
        accessMode: asset.accessMode,
        accessRevision: asset.accessRevision,
        tollGold: setting.tollGold,
        serverTime: Date.now()
      });
      return { tolls };
    } catch (error) { sendHarvestError(reply, error, logger); }
  });
}

function playerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new HarvestAccessError("HARVEST_ACCESS_FORBIDDEN", "Player onboarding is required.");
  return session.player.id;
}
function sendHarvestError(reply: Parameters<typeof sendError>[0], error: unknown, logger: AppLogger): void {
  if (error instanceof HarvestAccessError) {
    const status = error.code.endsWith("CHANGED")
      ? 409
      : error.code.endsWith("FORBIDDEN") || error.code === "HARVEST_ACCESS_PROXIMITY_REQUIRED" ||
          error.code === "PRIVATE_UNTIL_SETTLED"
        ? 403
        : 400;
    sendError(reply, status, error.code, error.message);
  } else if (error instanceof z.ZodError) {
    sendError(reply, 400, "HARVEST_ACCESS_INVALID", "Invalid harvest access request.");
  } else {
    logger.warn({ err: error }, "harvest access request failed");
    sendError(reply, 500, "HARVEST_ACCESS_UNAVAILABLE", "Harvest access is temporarily unavailable.");
  }
}

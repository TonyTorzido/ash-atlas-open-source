import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AuthService } from "../../auth/authService.js";
import {
  collectiblePlayerFromRecord,
  WaterCollectionCadenceError,
  type CollectibleService
} from "../../game/collectibles.js";
import type { RepeatableResourceService } from "../../game/repeatableResources.js";
import { packageIdForPosition } from "../../game/spatialZones.js";
import type { GameState } from "../../game/state.js";
import type { ConnectionRegistry } from "../../realtime/connectionRegistry.js";
import { sendError } from "../errors.js";
import {
  authoritativePlayerId,
  authorizeDeveloperHttp
} from "./routeAuthentication.js";
import { createRouteFamily } from "./routeFamily.js";

const collectiblesPlayerBodySchema = z.object({
  playerId: z.string().min(1).optional()
});

const collectWaterBodySchema = z.object({
  playerId: z.string().min(1).optional(),
  requestId: z.string().min(1).max(128),
  lat: z.number().finite(),
  lon: z.number().finite()
});

const developerMinesQuerySchema = z.object({
  search: z.string().max(160).optional(),
  state: z.enum(["all", "ready", "depleted"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export function createCollectibleRoutes(context: Readonly<{
  app: FastifyInstance;
  collectibles?: CollectibleService | undefined;
  gameState: GameState;
  registry: ConnectionRegistry;
  auth?: AuthService | undefined;
  repeatableResources?: Pick<RepeatableResourceService, "listDeveloperMines"> | undefined;
}>): void {
  const { app, collectibles, gameState, registry, auth, repeatableResources } = context;
  const collectibleRoutes = createRouteFamily(app, "collectibles");
  collectibleRoutes.post("/api/collectibles/survey", async (request, reply) => {
    if (!collectibles) {
      sendError(reply, 503, "COLLECTIBLES_UNAVAILABLE", "collectibles service is unavailable");
      return;
    }
    const body = collectiblesPlayerBodySchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_SURVEY_BODY", "survey request is invalid");
      return;
    }
    const playerId = authoritativePlayerId(request, body.data.playerId ?? "");
    const player = gameState.getPlayer(playerId);
    if (!player) {
      sendError(reply, 409, "PLAYER_NOT_CONNECTED", "player is not connected");
      return;
    }
    const resourceVision = gameState.getResourceVision(player.playerId);
    const gameplayRegionCode = packageIdForPosition(
      resourceVision?.center ?? player.anchor
    );
    const resourceVisionStatus = resourceVision
      ? await collectibles.resourceVisionStatus(resourceVision.flagId)
      : null;
    const nodes = await collectibles.listAvailableInVision(gameplayRegionCode, resourceVision);
    return {
      ok: true,
      nodes,
      resourceVision,
      resourceVisionStatus,
      generatedCells: 0,
      generatedNodes: 0
    };
  });

  collectibleRoutes.get("/api/collectibles/nearby", async (request, reply) => {
    if (!collectibles) {
      sendError(reply, 503, "COLLECTIBLES_UNAVAILABLE", "collectibles service is unavailable");
      return;
    }
    const query = collectiblesPlayerBodySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "BAD_COLLECTIBLES_QUERY", "collectibles query is invalid");
      return;
    }
    const playerId = authoritativePlayerId(request, query.data.playerId ?? "");
    const player = gameState.getPlayer(playerId);
    if (!player) {
      sendError(reply, 409, "PLAYER_NOT_CONNECTED", "player is not connected");
      return;
    }
    const resourceVision = gameState.getResourceVision(player.playerId);
    const gameplayRegionCode = packageIdForPosition(
      resourceVision?.center ?? player.anchor
    );
    const resourceVisionStatus = resourceVision
      ? await collectibles.resourceVisionStatus(resourceVision.flagId)
      : null;
    return {
      nodes: await collectibles.listAvailableInVision(gameplayRegionCode, resourceVision),
      resourceVision,
      resourceVisionStatus
    };
  });

  collectibleRoutes.post("/api/collectibles/pickup", async (request, reply) => {
    sendError(
      reply,
      410,
      "HARVEST_SESSION_REQUIRED",
      "Direct collectible pickup is disabled; use a server-authoritative harvest session"
    );
  });

  collectibleRoutes.post("/api/collectibles/water/collect", async (request, reply) => {
    if (!collectibles) {
      sendError(reply, 503, "COLLECTIBLES_UNAVAILABLE", "collectibles service is unavailable");
      return;
    }
    const body = collectWaterBodySchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_WATER_BODY", "requestId, lat, and lon are required");
      return;
    }
    const playerId = authoritativePlayerId(request, body.data.playerId ?? "");
    const player = gameState.getPlayer(playerId);
    if (!player) {
      sendError(reply, 409, "PLAYER_NOT_CONNECTED", "player is not connected");
      return;
    }
    try {
      const result = await collectibles.collectWaterAt(
        collectiblePlayerFromRecord(player),
        {
          lat: body.data.lat,
          lon: body.data.lon
        },
        body.data.requestId
      );
      registry.send(player.playerId, {
        type: "PLAYER_RESOURCES_UPDATED",
        playerId: player.playerId,
        inventory: result.inventory,
        serverTime: Date.now()
      });
      return {
        ok: true,
        ...result
      };
    } catch (error) {
      if (error instanceof WaterCollectionCadenceError) {
        reply.header("Retry-After", Math.max(1, Math.ceil(error.retryAfterMs / 1_000)));
        sendError(reply, 429, error.code, error.message);
        return;
      }
      sendError(
        reply,
        400,
        "WATER_COLLECT_REJECTED",
        "water collection rejected"
      );
    }
  });

  collectibleRoutes.get("/api/dev/permanent-mines", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:observe", "permanent-mines.list"
    );
    if (!developer) return;
    if (!repeatableResources) {
      sendError(reply, 503, "PERMANENT_MINES_UNAVAILABLE", "permanent mine diagnostics are unavailable");
      return;
    }
    const query = developerMinesQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "BAD_PERMANENT_MINES_QUERY", "invalid permanent mine query");
      return;
    }
    return repeatableResources.listDeveloperMines(query.data);
  });
}

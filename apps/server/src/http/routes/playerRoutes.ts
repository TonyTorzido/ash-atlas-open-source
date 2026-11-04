import { clampToWorldEdge, type PlayerSnapshot, type ResourceVision } from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthService } from "../../auth/authService.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import type { AppLogger } from "../../logger.js";
import type { CollectibleService } from "../../game/collectibles.js";
import type { CombatEngine } from "../../game/combat/combatEngine.js";
import { flagSetRevisionMetadata, type FlagService } from "../../game/flags.js";
import type { PlayerService } from "../../game/players.js";
import { resourceVisionForArea } from "../../game/resourceVision.js";
import { zoneIdForPosition } from "../../game/spatialZones.js";
import type { GameState } from "../../game/state.js";
import { getCityConstructionBlockReason } from "../../game/travelEligibility.js";
import { validateMoveTarget } from "../../game/validation.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { ConnectionRegistry } from "../../realtime/connectionRegistry.js";
import type { PresenceService } from "../../realtime/presenceService.js";
import type { WorldLookupClient } from "../../world/worldLookupClient.js";
import { sendError } from "../errors.js";
import {
  authoritativePlayerId,
  authorizeDeveloperHttp,
  recordDeveloperHttpResult
} from "./routeAuthentication.js";
import { createRouteFamily } from "./routeFamily.js";

const playerParamsSchema = z.object({ id: z.string().min(1) });

const updatePlayerColorBodySchema = z.object({
  playerId: z.string().min(1).optional(),
  color: z.enum(["#d83a3a", "#3366cc", "#22a447", "#c58a16", "#7c3aed"])
});

const devTeleportBodySchema = z.object({
  playerId: z.string().min(1).optional(),
  lat: z.number().finite(),
  lon: z.number().finite()
});

export type DevTeleportThroughTravel = (
  playerId: string,
  requestId: string,
  destination: { lat: number; lon: number }
) => Promise<
  | { success: true }
  | { success: false; reason: { code: string; message: string } }
>;

// Fallback (no live travel path): the same area vision real world travel grants.
function devTeleportVision(
  gameState: GameState,
  playerId: string,
  destination: { lat: number; lon: number },
  regionCode: string
): ResourceVision {
  return resourceVisionForArea({
    regionCode,
    position: destination,
    movementLeashRadiusM: gameState.getPlayer(playerId)?.moveLeashRadiusM ?? 0
  });
}

const TELEPORT_COVERAGE_ERROR = "Cannot teleport outside authoritative world coverage";

export function createPlayerRoutes(context: Readonly<{
  app: FastifyInstance;
  players: PlayerService;
  flags: FlagService;
  gameState: GameState;
  auth?: AuthService | undefined;
  collectibles?: CollectibleService | undefined;
  registry: ConnectionRegistry;
  presence?: PresenceService | undefined;
  logger: AppLogger;
  worldLookup: WorldLookupClient;
  combat?: CombatEngine | undefined;
  worldRuntime?: WorldRuntime | undefined;
  schedulePopulationV2Relocation?: ((playerId: string) => void) | undefined;
  devTeleport?: DevTeleportThroughTravel | undefined;
}>): void {
  const {
    app,
    players,
    flags,
    gameState,
    auth,
    collectibles,
    registry,
    presence,
    logger,
    worldLookup,
    combat,
    worldRuntime,
    schedulePopulationV2Relocation,
    devTeleport
  } = context;
  const playerRoutes = createRouteFamily(app, "players");
  playerRoutes.get("/api/players/online", async () => {
    const snapshot = presence?.aggregateSnapshot();
    return snapshot ? {
      count: snapshot.count,
      revision: snapshot.revision,
      observedAt: snapshot.observedAt
    } : {
      count: registry.activePlayerIds().length,
      revision: 0,
      observedAt: new Date().toISOString()
    };
  });

  playerRoutes.get("/api/inventory/:id", async (request, reply) => {
    const params = playerParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 400, "BAD_PLAYER_ID", "player id is required");
      return;
    }
    if (!collectibles) {
      sendError(reply, 503, "COLLECTIBLES_UNAVAILABLE", "collectibles service is unavailable");
      return;
    }
    return {
      inventory: await collectibles.inventoryForPlayer(
        authoritativePlayerId(request, params.data.id)
      )
    };
  });

  playerRoutes.get("/api/players/:id", async (request, reply) => {
    const params = playerParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 400, "BAD_PLAYER_ID", "player id is required");
      return;
    }
    const player = await players.loadPlayer(params.data.id);
    if (!player) {
      sendError(reply, 404, "PLAYER_NOT_FOUND", "player does not exist");
      return;
    }
    const snapshot = gameState.getPlayer(player.playerId)
      ? gameState.snapshotForPlayer(player.playerId)
      : {
          playerId: player.playerId,
          username: player.username,
          displayColor: player.displayColor,
          regionCode: player.regionCode,
          zoneId: zoneIdForPosition(player.position),
          lat: player.position.lat,
          lon: player.position.lon,
          anchorLat: player.anchor.lat,
          anchorLon: player.anchor.lon,
          moveLeashRadiusM: player.moveLeashRadiusM,
          movementRevision: 0,
          targetLat: null,
          targetLon: null,
          moving: false,
          online: player.online,
          updatedAt: player.updatedAt.toISOString()
        };
    return {
      player: canReadExactPlayer(request, player.playerId, auth)
        ? snapshot
        : publicPlayerPresence(snapshot)
    };
  });

  playerRoutes.patch("/api/players/:id/color", async (request, reply) => {
    const params = playerParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 400, "BAD_PLAYER_ID", "player id is required");
      return;
    }
    const body = updatePlayerColorBodySchema.safeParse(request.body);
    if (!body.success) {
      sendError(
        reply,
        400,
        "BAD_PLAYER_COLOR",
        "choose red, blue, green, gold, or purple"
      );
      return;
    }
    const actorPlayerId = authoritativePlayerId(request, body.data.playerId ?? params.data.id);
    const targetPlayerId = params.data.id;
    let developerSession: AuthenticatedSession | null = null;
    if (actorPlayerId !== targetPlayerId) {
      developerSession = await authorizeDeveloperHttp(
        request,
        reply,
        auth,
        "developer:world-mutate",
        "player.color.update",
        targetPlayerId
      );
      if (!developerSession) return;
    }
    const existing = await players.loadPlayer(targetPlayerId);
    if (!existing) {
      sendError(reply, 404, "PLAYER_NOT_FOUND", "player does not exist");
      return;
    }
    const player = await players.updatePlayerColor(targetPlayerId, body.data.color);
    gameState.setPlayerColor(player.playerId, player.displayColor ?? body.data.color);
    const flagRevisionMetadata = await flagSetRevisionMetadata(flags);
    for (const flag of await flags.listFlagsForOwner(targetPlayerId)) {
      registry.broadcast({
        type: "FLAG_UPDATED",
        flag,
        ...flagRevisionMetadata
      });
    }
    logger.info(
      {
        playerId: player.playerId,
        requestedBy: actorPlayerId,
        color: player.displayColor,
        developerOverride: actorPlayerId !== targetPlayerId
      },
      "player flag color updated"
    );
    if (developerSession) {
      await recordDeveloperHttpResult(auth, developerSession, {
        capability: "developer:world-mutate",
        command: "player.color.update",
        target: targetPlayerId,
        outcome: "succeeded"
      });
    }
    return {
      ok: true,
      player
    };
  });

  playerRoutes.post("/api/dev/player/teleport", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:world-mutate", "player.teleport"
    );
    if (!developer) return;
    const body = devTeleportBodySchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_TELEPORT_BODY", TELEPORT_COVERAGE_ERROR);
      return;
    }
    try {
      // Developer teleports past the world edge land on the edge instead.
      Object.assign(body.data, clampToWorldEdge(validateMoveTarget(body.data.lat, body.data.lon)));
    } catch {
      sendError(reply, 400, "TELEPORT_REJECTED", TELEPORT_COVERAGE_ERROR);
      return;
    }
    const lookup = await worldLookup.lookupGameplayEnvironment(
      body.data.lat,
      body.data.lon
    );
    if (!lookup.ok || !lookup.packageId) {
      sendError(reply, 400, "TELEPORT_REJECTED", TELEPORT_COVERAGE_ERROR);
      return;
    }
    try {
      const playerId = body.data.playerId ?? developer.player!.id;
      const constructionBlock = getCityConstructionBlockReason(
        gameState,
        playerId
      );
      if (constructionBlock) {
        sendError(
          reply,
          409,
          constructionBlock.code,
          constructionBlock.message
        );
        return;
      }
      const activeConnectionId = registry.activeConnectionIdForPlayer?.(playerId) ?? null;
      const activeConnection = activeConnectionId
        ? registry.recordForConnection?.(activeConnectionId) ?? null
        : null;
      const destination = { lat: body.data.lat, lon: body.data.lon };
      let relocatedByTravel = false;
      if (devTeleport && activeConnectionId) {
        // Same path as real world travel: area resource vision, population
        // preparation, arrival publication. Only cost and eligibility are skipped.
        const travel = await devTeleport(
          playerId,
          `dev-teleport:${crypto.randomUUID()}`,
          destination
        );
        if (!travel.success) {
          sendError(reply, 409, "TELEPORT_REJECTED", travel.reason.message);
          return;
        }
        relocatedByTravel = true;
      } else if (worldRuntime && activeConnectionId && activeConnection?.accountId) {
        const cancellation = worldRuntime.enqueueTracked({
          kind: "dev-teleport",
          playerId,
          accountId: activeConnection.accountId,
          connectionId: activeConnectionId,
          requestId: `dev-teleport:${crypto.randomUUID()}`,
          destination,
          resourceVision: devTeleportVision(gameState, playerId, destination, lookup.packageId)
        });
        if (!cancellation.accepted || (await cancellation.completion) !== "processed") {
          sendError(
            reply,
            409,
            "TELEPORT_REJECTED",
            "Teleport could not safely cancel pending movement"
          );
          return;
        }
      } else {
        combat?.cancelCombat(playerId);
        gameState.stopPlayer(playerId);
        gameState.applyAuthoritativeRelocation({
          playerId,
          anchor: destination,
          resourceVision: devTeleportVision(gameState, playerId, destination, lookup.packageId)
        });
      }
      const player = gameState.snapshotForPlayer(playerId);
      await players.persistPlayerSnapshot(player);
      if (!relocatedByTravel) schedulePopulationV2Relocation?.(playerId);
      logger.warn({ playerId, lat: body.data.lat, lon: body.data.lon }, "dev tool teleported player");
      await recordDeveloperHttpResult(auth, developer, {
        capability: "developer:world-mutate",
        command: "player.teleport",
        target: playerId,
        outcome: "succeeded"
      });
      return {
        ok: true,
        player
      };
    } catch (error) {
      sendError(
        reply,
        409,
        "PLAYER_NOT_CONNECTED",
        error instanceof Error ? error.message : "player is not connected"
      );
    }
  });
}

function canReadExactPlayer(
  request: FastifyRequest,
  playerId: string,
  auth: AuthService | undefined
): boolean {
  return request.authSession?.player?.id === playerId ||
    Boolean(auth?.hasDeveloperCapability(request.authSession, "developer:observe"));
}

export function publicPlayerPresence(player: PlayerSnapshot): Omit<
  PlayerSnapshot,
  "lat" | "lon" | "anchorLat" | "anchorLon" | "moveLeashRadiusM" |
  "targetLat" | "targetLon" | "moving" | "movementRevision" | "relocationRevision" |
  "online"
> {
  return {
    playerId: player.playerId,
    username: player.username,
    displayColor: player.displayColor,
    regionCode: player.regionCode,
    zoneId: player.zoneId,
    updatedAt: player.updatedAt
  };
}

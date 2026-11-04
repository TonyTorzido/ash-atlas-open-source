import {
  distanceMeters,
  isFiniteLatLon,
  STRATEGIC_VISION_RADIUS_M,
  type FlagSnapshot,
  type StrategicVisionAuthority
} from "@ash-atlas/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AuthService } from "../../auth/authService.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import type { AppLogger } from "../../logger.js";
import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";
import { CityFoundingError } from "../../game/cities.js";
import {
  AtlasShrineError,
  FlagDestructionError,
  flagSetRevisionMetadata,
  flagEnvironmentRefreshFailureMessage,
  FlagPlacementError,
  type BBox,
  type FlagEnvironmentRefreshReport,
  type FlagPlacementFailureStage,
  type FlagService
} from "../../game/flags.js";
import { KingdomError } from "../../game/kingdoms.js";
import type { GameState } from "../../game/state.js";
import type { CityService } from "../../game/cities.js";
import type { WorldMapService } from "../../game/worldMap.js";
import type { ResourceVisionJobQueue } from "../../game/resourceVisionJobs.js";
import type { CombatEngine } from "../../game/combat/combatEngine.js";
import type { ConnectionRegistry } from "../../realtime/connectionRegistry.js";
import { publishBrokenFlags } from "../../realtime/territoryCollapsePublisher.js";
import type { WorldLookupClient } from "../../world/worldLookupClient.js";
import { sanitizeAtlasShrineRename } from "../../game/validation.js";
import type { HttpAdmissionController } from "../admission.js";
import { sendError } from "../errors.js";
import type { LandActionGate } from "../../auth/trust/trustService.js";
import {
  authoritativePlayerId,
  authorizeDeveloperHttp,
  recordDeveloperHttpResult
} from "./routeAuthentication.js";
import { createRouteFamily } from "./routeFamily.js";

const lookupQuerySchema = z.object({
  lat: z.coerce.number().finite(),
  lon: z.coerce.number().finite()
});

const placementQuoteBodySchema = z.object({
  quoteRequestId: z.string().uuid(),
  anchorKind: z.enum(["flag", "buoy"]).optional(),
  traceId: z.string().uuid().optional(),
  trigger: z.enum(["background", "build", "refresh", "diagnostic"]),
  requestedPosition: z.object({ lat: z.number().finite(), lon: z.number().finite() }).optional(),
  movementRevision: z.number().int().nonnegative().optional(),
  relocationRevision: z.number().int().nonnegative().optional()
});

const flagsQuerySchema = z.object({
  bbox: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional()
});

const createFlagBodySchema = z.object({
  ownerId: z.string().min(1).optional(),
  name: z.string().min(1).max(64).optional()
});

const deleteFlagParamsSchema = z.object({ id: z.string().uuid() });
const deleteFlagQuerySchema = z.object({ playerId: z.string().min(1).optional() });
const deleteFlagBodySchema = z.object({
  requestId: z.string().uuid()
});
const refreshFlagEnvironmentBodySchema = z
  .object({
    flagId: z.string().uuid().optional(),
    all: z.literal(true).optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
    onlyNeedsRefresh: z.boolean().optional()
  })
  .refine((body) => Boolean(body.flagId) !== Boolean(body.all), {
    message: "provide exactly one of flagId or all"
  })
  .refine((body) => !body.onlyNeedsRefresh || body.all === true, {
    message: "onlyNeedsRefresh requires all=true"
  });

const renameFlagBodySchema = z.object({
  playerId: z.string().min(1).optional(),
  name: z.string().transform((value, context) => {
    try {
      return sanitizeAtlasShrineRename(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "invalid flag name"
      });
      return z.NEVER;
    }
  })
});

const atlasShrineOperationBodySchema = z.object({
  requestId: z.string().uuid()
});

const flagUpgradeBodySchema = atlasShrineOperationBodySchema.extend({
  targetTier: z.enum(["stone", "atlas_shrine"])
});

export type FlagRoutesContext = Readonly<{
  app: FastifyInstance;
  worldLookup: WorldLookupClient;
  logger: AppLogger;
  registry: ConnectionRegistry;
  flags: FlagService;
  gameState: GameState;
  auth?: AuthService | undefined;
  resourceVisionJobs?: ResourceVisionJobQueue | undefined;
  admission: HttpAdmissionController;
  cities?: Pick<CityService, "listCitiesNear"> | undefined;
  worldMap?: Pick<WorldMapService, "strategicLandmarks"> | undefined;
  combat?: Pick<CombatEngine, "despawnMob"> | undefined;
  landActions?: Pick<LandActionGate, "check" | "recordLandAction"> | undefined;
}>;

export function createFlagRoutes(context: FlagRoutesContext): void {
  const {
    app,
    worldLookup,
    logger,
    registry,
    flags,
    gameState,
    auth,
    resourceVisionJobs,
    admission,
    cities,
    worldMap,
    combat,
    landActions
  } = context;
  const flagRoutes = createRouteFamily(app, "flags");
  flagRoutes.get("/api/dev/flags/count", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:observe", "flags.count"
    );
    if (!developer) return;
    return {
      count: await flags.countFlags()
    };
  });

  flagRoutes.delete("/api/dev/flags", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:world-mutate", "flags.clear", "all"
    );
    if (!developer) return;
    if (!combat) throw new Error("Combat authority is required to clear flags");
    const { deletedFlagIds, legendaryCombatEntityIds } = await flags.clearFlags();
    for (const entityId of legendaryCombatEntityIds) combat.despawnMob(entityId);
    const deletedCount = deletedFlagIds.length;
    gameState.clearResourceVisions();
    logger.warn({ deletedCount }, "dev tool cleared all flags");
    const revisionMetadata = await flagSetRevisionMetadata(flags);
    for (const flagId of deletedFlagIds) {
      registry.broadcast({
        type: "FLAG_DELETED",
        flagId,
        ...revisionMetadata
      });
    }
    await recordDeveloperHttpResult(auth, developer, {
      capability: "developer:world-mutate",
      command: "flags.clear",
      target: "all",
      outcome: "succeeded"
    });
    return {
      ok: true,
      deletedCount
    };
  });

  flagRoutes.post("/api/dev/flags/environment/refresh", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:world-mutate", "flag-environment.refresh"
    );
    if (!developer) return;
    const body = refreshFlagEnvironmentBodySchema.safeParse(request.body);
    if (!body.success) {
      sendError(
        reply,
        400,
        "BAD_FLAG_ENVIRONMENT_REFRESH_BODY",
        "provide exactly one of flagId or all"
      );
      return;
    }
    const report = body.data.all
      ? body.data.onlyNeedsRefresh
        ? await flags.refreshEnvironmentsNeedingRefresh(body.data.limit)
        : await flags.refreshAllEnvironments(body.data.limit)
      : await refreshOneFlagEnvironment(flags, body.data.flagId!);
    if (report.refreshed > 0) {
      const flagRevisionMetadata = await flagSetRevisionMetadata(flags);
      for (const flagId of report.refreshedFlagIds) {
        const flag = await flags.getMapFlag(flagId);
        if (flag) registry.broadcast({
          type: "FLAG_UPDATED",
          flag,
          ...flagRevisionMetadata
        });
      }
    }
    logger.warn(report, "dev tool refreshed stored flag environments");
    await recordDeveloperHttpResult(auth, developer, {
      capability: "developer:world-mutate",
      command: "flag-environment.refresh",
      target: body.data.flagId ?? "all",
      outcome: report.failures.length === 0 ? "succeeded" : "failed"
    });
    return {
      ok: report.failures.length === 0,
      ...report
    };
  });

  flagRoutes.get("/api/dev/flags/:id/environment-diagnostics", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:observe", "flag-environment.diagnostics"
    );
    if (!developer) return;
    const params = deleteFlagParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 400, "BAD_FLAG_ID", "flag id must be a UUID");
      return;
    }
    const diagnostics = await flags.getEnvironmentDiagnostics(params.data.id);
    if (!diagnostics) {
      sendError(reply, 404, "FLAG_NOT_FOUND", "flag does not exist");
      return;
    }
    return diagnostics;
  });

  flagRoutes.post("/api/flags/placement-quote", async (request, reply) => {
    const playerId = request.authSession?.player?.id;
    const player = playerId ? gameState.getPlayer(playerId) : null;
    if (!playerId || !player) {
      sendError(reply, 401, "AUTH_REQUIRED", "Authentication is required");
      return;
    }
    const parsed = placementQuoteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      sendError(reply, 400, "BAD_PLACEMENT_QUOTE_BODY", "invalid placement quote request");
      return;
    }
    const input = parsed.data;
    const traceId = input.traceId ?? input.quoteRequestId;
    const started = performance.now();
    const authoritative = player.position;
    const positionDifferenceM = input.requestedPosition
      ? distanceMeters(input.requestedPosition, authoritative)
      : null;
    gameplayLatencyTrace.record(playerId, {
      traceId,
      source: "game",
      category: "flag-preparation",
      name: "quote_request_received",
      details: {
        quoteRequestId: input.quoteRequestId,
        trigger: input.trigger,
        authoritativeLat: authoritative.lat,
        authoritativeLon: authoritative.lon,
        requestedLat: input.requestedPosition?.lat ?? null,
        requestedLon: input.requestedPosition?.lon ?? null,
        positionDifferenceM,
        targetActive: Boolean(player.target),
        movementRevision: player.movementRevision,
        relocationRevision: player.relocationRevision ?? 0,
        submittedMovementRevision: input.movementRevision ?? null,
        submittedRelocationRevision: input.relocationRevision ?? null,
        path: "dedicated-compact-quote"
      }
    });
    const structuredFailure = (
      outcome: "PLAYER_MOVING" | "REVISION_STALE" | "CLIENT_DISCONNECTED" | "INTERNAL_ERROR",
      message: string,
      retryable: boolean,
      failureStage: FlagPlacementFailureStage,
      errorClass: string
    ): object => {
      const retryAfterMs = retryable ? 150 : undefined;
      gameplayLatencyTrace.record(playerId, {
        traceId,
        source: "game",
        category: "flag-preparation",
        name: "quote_request_completed",
        details: {
          quoteRequestId: input.quoteRequestId,
          outcome,
          retryable,
          failureStage,
          errorClass,
          domainCode: outcome,
          totalMs: performance.now() - started,
          compactWorldCalls: 0,
          richWorldCalls: 0
        },
        failure: true
      });
      return {
        ok: false,
        outcome,
        message,
        retryable,
        retryAfterMs,
        placementFailure: {
          code: outcome,
          domainCode: outcome,
          message,
          retryable,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          failureStage,
          errorClass
        },
        authoritativePosition: authoritative,
        movementRevision: player.movementRevision,
        relocationRevision: player.relocationRevision ?? 0,
        traceId,
        quoteRequestId: input.quoteRequestId
      };
    };
    if (player.target) {
      return structuredFailure(
        "PLAYER_MOVING",
        "Finish moving before preparing this flag location.",
        true,
        "movement",
        "MovementStateError"
      );
    }
    if (
      (input.movementRevision !== undefined &&
        input.movementRevision !== player.movementRevision) ||
      (input.relocationRevision !== undefined &&
        input.relocationRevision !== (player.relocationRevision ?? 0))
    ) {
      return structuredFailure(
        "REVISION_STALE",
        "Your position changed. Preparing the latest location.",
        true,
        "movement",
        "MovementRevisionError"
      );
    }
    try {
      const compactStarted = performance.now();
      gameplayLatencyTrace.record(playerId, {
        traceId,
        source: "game",
        category: "world",
        name: "compact_world_request_started",
        details: {
          quoteRequestId: input.quoteRequestId,
          endpoint: "/api/gameplay-environment",
          origin: "flag-preparation"
        }
      });
      const compactMetricsBefore = worldLookup.gameplayEnvironmentMetrics();
      const prepared = await flags.tryCreatePlacementQuote(player, {
        signal: admission.signalFor(request),
        anchorKind: input.anchorKind ?? "flag"
      });
      const compactMetricsAfter = worldLookup.gameplayEnvironmentMetrics();
      const compactWorldMs = performance.now() - compactStarted;
      const compactWorldCalls = Math.max(
        0,
        compactMetricsAfter.upstreamAttempts - compactMetricsBefore.upstreamAttempts
      );
      const cacheHit =
        compactMetricsAfter.hits > compactMetricsBefore.hits ||
        compactMetricsAfter.negativeHits > compactMetricsBefore.negativeHits;
      const singleflightJoin =
        compactMetricsAfter.sharedWaits > compactMetricsBefore.sharedWaits;
      const outcome = prepared.placementQuote
        ? "QUOTE_READY"
        : compactFailureOutcome(prepared.failure?.code);
      gameplayLatencyTrace.record(playerId, {
        traceId,
        source: "game",
        category: "world",
        name: "compact_world_request_completed",
        details: {
          quoteRequestId: input.quoteRequestId,
          endpoint: "/api/gameplay-environment",
          status: prepared.placementQuote ? "ok" : "failed",
          outcome,
          totalMs: compactWorldMs,
          compactWorldCalls,
          richWorldCalls: 0,
          cacheHit,
          singleflightJoin
        },
        failure: !prepared.placementQuote
      });
      gameplayLatencyTrace.record(playerId, {
        traceId,
        source: "game",
        category: "flag-preparation",
        name: "quote_request_completed",
        details: {
          quoteRequestId: input.quoteRequestId,
          outcome,
          retryable: prepared.failure?.retryable ?? false,
          failureStage: prepared.failure?.failureStage ?? null,
          errorClass: prepared.failure?.errorClass ?? null,
          domainCode: prepared.failure?.domainCode ?? null,
          totalMs: performance.now() - started,
          worldMs: compactWorldMs,
          compactWorldCalls,
          richWorldCalls: 0,
          quoteId: prepared.placementQuote?.quoteId ?? null
        },
        failure: !prepared.placementQuote
      });
      return {
        ...(prepared.world ?? { ok: false }),
        outcome,
        traceId,
        quoteRequestId: input.quoteRequestId,
        authoritativePosition: authoritative,
        movementRevision: player.movementRevision,
        relocationRevision: player.relocationRevision ?? 0,
        ...(prepared.placementQuote ? { placementQuote: prepared.placementQuote } : {}),
        ...(prepared.failure ? { placementFailure: prepared.failure } : {})
      };
    } catch (error) {
      if (admission.signalFor(request).aborted) {
        return structuredFailure(
          "CLIENT_DISCONNECTED",
          "Flag preparation was canceled because the connection closed.",
          true,
          "unexpected",
          "RequestAbortError"
        );
      }
      logger.warn({ err: error, traceId, playerId }, "dedicated flag placement quote failed");
      return structuredFailure(
        "INTERNAL_ERROR",
        "Flag preparation is temporarily unavailable.",
        true,
        "unexpected",
        safeErrorClass(error)
      );
    }
  });

  flagRoutes.get("/api/flags", async (request, reply) => {
    const playerId = authoritativePlayerId(request, "");
    const authority = strategicVisionAuthority(gameState, playerId);
    if (!playerId || !authority) {
      sendError(reply, 401, "PLAYER_REQUIRED", "An authenticated world player is required");
      return;
    }
    const query = flagsQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "BAD_FLAGS_QUERY", "invalid flags query");
      return;
    }
    let bbox: BBox | undefined;
    if (query.data.bbox) {
      const parsed = parseBbox(query.data.bbox);
      if (!parsed) {
        sendError(reply, 400, "BAD_BBOX", "bbox must be west,south,east,north");
        return;
      }
      bbox = parsed;
    }
    const limit = query.data.limit ?? 500;
    const strategic = await loadStrategicFlagSnapshot(flags, authority);
    const listedFlags = strategic.flags
      .filter((flag) => !bbox || flagCenterWithinBbox(flag, bbox))
      .slice(0, limit);
    return {
      flags: listedFlags,
      flagSetRevision: strategic.flagSetRevision,
      complete: strategic.complete && listedFlags.length < limit
    };
  });

  flagRoutes.get("/api/map/strategic-vision", async (request, reply) => {
    const playerId = authoritativePlayerId(request, "");
    const authority = strategicVisionAuthority(gameState, playerId);
    if (!playerId || !authority) {
      sendError(reply, 401, "PLAYER_REQUIRED", "An authenticated world player is required");
      return;
    }
    if (!cities || !worldMap) {
      sendError(reply, 503, "STRATEGIC_VISION_UNAVAILABLE", "Strategic vision is unavailable");
      return;
    }
    const [flagSnapshot, nearbyCities, landmarks] = await Promise.all([
      loadStrategicFlagSnapshot(flags, authority),
      cities.listCitiesNear(authority.center, STRATEGIC_VISION_RADIUS_M, 1_000),
      worldMap.strategicLandmarks(playerId)
    ]);
    const currentAuthority = strategicVisionAuthority(gameState, playerId);
    if (!currentAuthority || strategicAuthorityKey(currentAuthority) !== strategicAuthorityKey(authority)) {
      sendError(reply, 409, "STRATEGIC_VISION_MOVED", "The player anchor changed; retry strategic vision");
      return;
    }
    return {
      authority,
      flags: flagSnapshot.flags,
      cities: nearbyCities,
      landmarks,
      flagSetRevision: flagSnapshot.flagSetRevision,
      complete: flagSnapshot.complete
    };
  });

  flagRoutes.get("/api/flags/atlas-shrines/status", async (request, reply) => {
    const playerId = authoritativePlayerId(request, "");
    if (!playerId) {
      sendError(reply, 401, "PLAYER_REQUIRED", "An authenticated player is required");
      return;
    }
    return { progression: await flags.atlasShrineProgression(playerId) };
  });

  flagRoutes.post("/api/flags/atlas-shrines/unlock", async (request, reply) => {
    const body = atlasShrineOperationBodySchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_ATLAS_SHRINE_UNLOCK", "A valid unlock request id is required");
      return;
    }
    const playerId = authoritativePlayerId(request, "");
    if (!playerId) {
      sendError(reply, 401, "PLAYER_REQUIRED", "An authenticated player is required");
      return;
    }
    try {
      return await flags.unlockAtlasShrineSlot(playerId, body.data.requestId);
    } catch (error) {
      if (error instanceof AtlasShrineError) {
        sendError(reply, 409, error.code, error.message);
        return;
      }
      throw error;
    }
  });

  flagRoutes.post("/api/flags/:id/upgrade", async (request, reply) => {
    const params = deleteFlagParamsSchema.safeParse(request.params);
    const body = flagUpgradeBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      sendError(reply, 400, "BAD_FLAG_UPGRADE", "A valid flag, tier, and request id are required");
      return;
    }
    const playerId = authoritativePlayerId(request, "");
    if (!playerId) {
      sendError(reply, 401, "PLAYER_REQUIRED", "An authenticated player is required");
      return;
    }
    if (body.data.targetTier === "stone") {
      sendError(
        reply,
        409,
        "FLAG_HARDENING_REALTIME_REQUIRED",
        "Base flags must be hardened through the timed realtime action"
      );
      return;
    }
    const accountId = request.authSession?.account.id ?? null;
    const livePosition = gameState.getPlayer(playerId)?.position ?? null;
    const landAction = accountId
      ? {
          accountId,
          playerId,
          action: "flag_upgrade" as const,
          position: livePosition ? { lat: livePosition.lat, lon: livePosition.lon } : null
        }
      : null;
    if (landActions && landAction) {
      const decision = await landActions.check(landAction);
      if (!decision.allowed) {
        reply.header("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
        sendError(reply, 429, decision.code, decision.message, {
          retryable: true,
          retryAfterMs: decision.retryAfterMs
        });
        return;
      }
    }
    try {
      const result = await flags.upgradeFlagTier(
        playerId,
        params.data.id,
        body.data.targetTier,
        body.data.requestId
      );
      if (landActions && landAction) void landActions.recordLandAction(landAction);
      registry.broadcast({
        type: "FLAG_UPDATED",
        flag: result.flag,
        ...(await flagSetRevisionMetadata(flags))
      });
      return result;
    } catch (error) {
      if (error instanceof AtlasShrineError) {
        sendError(reply, 409, error.code, error.message);
        return;
      }
      if (error instanceof KingdomError) {
        sendError(reply, error.statusCode || 403, error.code, error.message);
        return;
      }
      throw error;
    }
  });

  flagRoutes.post("/api/flags/:id/repair", async (request, reply) => {
    const params = deleteFlagParamsSchema.safeParse(request.params);
    const body = atlasShrineOperationBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      sendError(reply, 400, "BAD_FLAG_REPAIR", "A valid flag and request id are required");
      return;
    }
    const playerId = authoritativePlayerId(request, "");
    if (!playerId) {
      sendError(reply, 401, "PLAYER_REQUIRED", "An authenticated player is required");
      return;
    }
    try {
      const player = gameState.getPlayer(playerId);
      if (!player || !player.online) {
        sendError(reply, 409, "FLAG_REPAIR_DISCONNECTED", "You must be online to repair a Flag.");
        return;
      }
      if (player.target) {
        sendError(reply, 409, "FLAG_REPAIR_MOVING", "Stop moving before repairing a Flag.");
        return;
      }
      const flag = await flags.repairBurningStoneFlag(playerId, params.data.id, player.position);
      registry.broadcast({
        type: "FLAG_UPDATED",
        flag,
        ...(await flagSetRevisionMetadata(flags))
      });
      return { flag, replayed: false };
    } catch (error) {
      if (error instanceof AtlasShrineError) {
        sendError(reply, 409, error.code, error.message);
        return;
      }
      throw error;
    }
  });

  flagRoutes.get("/api/flags/:id/environment", async (request, reply) => {
    const params = deleteFlagParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 400, "BAD_FLAG_ID", "flag id must be a UUID");
      return;
    }
    const details = await flags.getEnvironmentDetails(params.data.id);
    if (!details) {
      sendError(reply, 404, "FLAG_NOT_FOUND", "flag does not exist");
      return;
    }
    return details;
  });

  flagRoutes.get("/api/territory/resolve", async (request, reply) => {
    const query = lookupQuerySchema.safeParse(request.query);
    if (!query.success || !isFiniteLatLon(query.data.lat, query.data.lon)) {
      sendError(reply, 400, "BAD_TERRITORY_QUERY", "valid lat and lon query parameters are required");
      return;
    }
    return flags.resolveTerritoryAtPoint(query.data.lat, query.data.lon);
  });

  flagRoutes.post("/api/flags", async (request, reply) => {
    const body = createFlagBodySchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_FLAG_BODY", "flag request is invalid");
      return;
    }
    const ownerId = authoritativePlayerId(request, body.data.ownerId ?? "");
    const player = gameState.getPlayer(ownerId);
    if (!player) {
      sendError(
        reply,
        409,
        "PLAYER_NOT_CONNECTED",
        "POST /api/flags uses the server-side connected player position"
      );
      return;
    }
    try {
      const result = await flags.createForPlayer(player, body.data.name);
      if (resourceVisionJobs) {
        void resourceVisionJobs
          .ensureQueued({
            flag: result.flag,
            regionCode: player.regionCode,
            movementLeashRadiusM: player.moveLeashRadiusM,
            reason: "flag-created"
          })
          .catch((error: unknown) => {
            logger.warn(
              { err: error, flagId: result.flag.id },
              "failed to enqueue flag resource vision prewarm"
            );
          });
      }
      return result;
    } catch (error) {
      const message = error instanceof FlagPlacementError
        ? error.message
        : "flag creation failed";
      sendError(reply, 400, "FLAG_CREATE_FAILED", message);
    }
  });

  flagRoutes.delete("/api/flags/:id", async (request, reply) => {
    const params = deleteFlagParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 400, "BAD_FLAG_ID", "flag id must be a UUID");
      return;
    }
    const query = deleteFlagQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "BAD_DELETE_QUERY", "playerId query parameter is invalid");
      return;
    }
    const body = deleteFlagBodySchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_FLAG_DESTROY_BODY", "requestId must be a UUID");
      return;
    }
    const flag = await flags.getFlag(params.data.id);
    const requestedBy = authoritativePlayerId(request, query.data.playerId ?? "");
    let developerOverride = false;
    let developerSession: AuthenticatedSession | null = null;
    if (flag?.controlType === "personal" && flag.ownerId !== requestedBy) {
      developerSession = await authorizeDeveloperHttp(
        request,
        reply,
        auth,
        "developer:world-mutate",
        "flag.delete.override",
        params.data.id
      );
      if (!developerSession) return;
      developerOverride = true;
    }
    let deletion;
    try {
      deletion = await flags.deleteFlag(
        params.data.id,
        requestedBy,
        developerOverride,
        body.data.requestId
      );
    } catch (error) {
      if (error instanceof FlagDestructionError) {
        sendError(reply, 409, error.code, error.message);
        return;
      }
      if (error instanceof KingdomError) {
        sendError(reply, error.statusCode || 403, error.code, error.message);
        return;
      }
      if (error instanceof CityFoundingError) {
        sendError(reply, 403, error.code, error.message);
        return;
      }
      if (error instanceof Error && error.message === "flag does not exist") {
        sendError(reply, 404, "FLAG_NOT_FOUND", error.message);
        return;
      }
      throw error;
    }
    logger.warn(
      {
        flagId: params.data.id,
        ownerId: flag?.ownerId,
        requestedBy,
        developerOverride
      },
      "flag deleted"
    );
    const revision = await flagSetRevisionMetadata(flags);
    registry.broadcast({
      type: "FLAG_DELETED",
      flagId: params.data.id,
      ...revision
    });
    for (const refund of deletion.refundInventories) {
      registry.send(refund.playerId, {
        type: "FLAG_DELETED",
        flagId: params.data.id,
        inventory: refund.inventory
      });
    }
    // Flags cut off from a city / kingdom network break with the deleted flag.
    publishBrokenFlags(registry, {
      flagIds: deletion.affectedFlagIds,
      collapseId: null,
      reason: "disconnected",
      completed: true,
      ...revision
    });
    for (const affectedPlayerId of new Set(deletion.notificationPlayerIds)) {
      registry.send(affectedPlayerId, {
        type: "KINGDOM_STATE_CHANGED",
        playerId: affectedPlayerId
      });
    }
    if (developerSession) {
      await recordDeveloperHttpResult(auth, developerSession, {
        capability: "developer:world-mutate",
        command: "flag.delete.override",
        target: params.data.id,
        outcome: "succeeded"
      });
    }
    return {
      ok: true,
      flagId: params.data.id,
      replayed: deletion.replayed,
      inventory: deletion.refundInventories.find(
        (entry) => entry.playerId === requestedBy
      )?.inventory ?? null,
      droppedItems: deletion.droppedItems
    };
  });

  flagRoutes.patch("/api/flags/:id", async (request, reply) => {
    const params = deleteFlagParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 400, "BAD_FLAG_ID", "flag id must be a UUID");
      return;
    }
    const body = renameFlagBodySchema.safeParse(request.body);
    if (!body.success) {
      sendError(
        reply,
        400,
        "BAD_FLAG_RENAME_BODY",
        body.error.issues[0]?.message ?? "Atlas Shrine name must be 15 characters or fewer"
      );
      return;
    }
    const flag = await flags.getFlag(params.data.id);
    if (!flag) {
      sendError(reply, 404, "FLAG_NOT_FOUND", "flag does not exist");
      return;
    }
    const requestedBy = authoritativePlayerId(request, body.data.playerId ?? "");
    if (
      flag.controlType !== "personal" ||
      flag.upgradeTier !== "atlas_shrine" ||
      flag.ownerId !== requestedBy
    ) {
      sendError(
        reply,
        403,
        "KINGDOM_PERMISSION_DENIED",
        "Only the owner of an active personal Atlas Shrine may rename it"
      );
      return;
    }
    let renamed;
    try {
      renamed = await flags.renameFlag(flag.id, body.data.name, requestedBy);
    } catch (error) {
      if (error instanceof KingdomError) {
        sendError(reply, error.statusCode || 403, error.code, error.message);
        return;
      }
      if (error instanceof AtlasShrineError) {
        sendError(reply, 409, error.code, error.message);
        return;
      }
      throw error;
    }
    logger.info(
      {
        flagId: renamed.id,
        ownerId: renamed.ownerId,
        requestedBy
      },
      "flag renamed"
    );
    registry.broadcast({
      type: "FLAG_UPDATED",
      flag: renamed,
      ...(await flagSetRevisionMetadata(flags))
    });
    return {
      ok: true,
      flag: renamed
    };
  });
}

function strategicVisionAuthority(
  gameState: GameState,
  playerId: string
): StrategicVisionAuthority | null {
  if (!playerId) return null;
  const anchor = gameState.getAuthoritativeTravelAnchor(playerId);
  if (!anchor) return null;
  return {
    center: { ...anchor.center },
    radiusM: STRATEGIC_VISION_RADIUS_M,
    relocationRevision: anchor.relocationRevision,
    gameplayViewGeneration: anchor.layerGeneration
  };
}

async function loadStrategicFlagSnapshot(
  flags: FlagService,
  authority: StrategicVisionAuthority
): Promise<Readonly<{
  flags: FlagSnapshot[];
  flagSetRevision: number;
  complete: boolean;
}>> {
  const visibleFlags: FlagSnapshot[] = [];
  const result = await flags.streamFlagSnapshot((chunk) => {
    visibleFlags.push(...chunk.flags);
    return true;
  }, 500, {
    center: authority.center,
    radiusM: authority.radiusM
  });
  return {
    flags: visibleFlags,
    flagSetRevision: result.flagSetRevision,
    complete: result.completed
  };
}

function strategicAuthorityKey(authority: StrategicVisionAuthority): string {
  return [
    authority.center.lat,
    authority.center.lon,
    authority.radiusM,
    authority.relocationRevision,
    authority.gameplayViewGeneration
  ].join(":");
}

function flagCenterWithinBbox(flag: FlagSnapshot, bbox: BBox): boolean {
  return flag.lon >= bbox.west && flag.lon <= bbox.east &&
    flag.lat >= bbox.south && flag.lat <= bbox.north;
}

function compactFailureOutcome(code: string | undefined): string {
  if (code?.includes("TIMEOUT")) return "COMPACT_WORLD_TIMEOUT";
  if (code?.startsWith("WORLD_")) return "COMPACT_WORLD_UNAVAILABLE";
  return code ?? "INTERNAL_ERROR";
}

function safeErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error";
}

function parseBbox(raw: string): BBox | null {
  const parts = raw.split(",").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [west, south, east, north] = parts;
  if (
    west === undefined ||
    south === undefined ||
    east === undefined ||
    north === undefined ||
    west >= east ||
    south >= north
  ) return null;
  return { west, south, east, north };
}

async function refreshOneFlagEnvironment(
  flags: FlagService,
  flagId: string
): Promise<FlagEnvironmentRefreshReport> {
  try {
    await flags.refreshEnvironment(flagId);
    return {
      requested: 1,
      refreshed: 1,
      refreshedFlagIds: [flagId],
      failures: [],
      truncated: false
    };
  } catch (error) {
    return {
      requested: 1,
      refreshed: 0,
      refreshedFlagIds: [],
      failures: [{ flagId, error: flagEnvironmentRefreshFailureMessage(error) }],
      truncated: false
    };
  }
}

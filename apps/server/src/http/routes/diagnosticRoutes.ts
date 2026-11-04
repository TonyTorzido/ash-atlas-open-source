import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthService } from "../../auth/authService.js";
import type { AppLogger } from "../../logger.js";
import type { AppConfig } from "../../config.js";
import { WORLD_RUNTIME_CONTRACT } from "../../runtime/authorityIdentity.js";
import {
  gameplayLatencyTrace,
  resolveGameplayTraceReleaseIdentity,
  type GameplayTraceCategory,
  type GameplayTraceDetails
} from "../../diagnostics/gameplayLatencyTrace.js";
import type { CollectibleService } from "../../game/collectibles.js";
import type { CombatEngine } from "../../game/combat/combatEngine.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { GameState } from "../../game/state.js";
import type { ConnectionRegistry } from "../../realtime/connectionRegistry.js";
import { directPublisherMetricsSnapshot } from "../../realtime/realtimePublisher.js";
import type { HttpAdmissionController } from "../admission.js";
import { sendError } from "../errors.js";
import type { RouteOperationalDependencies } from "./systemRoutes.js";
import {
  authorizeDeveloperHttp,
} from "./routeAuthentication.js";
import { PerfSampleStore, perfSampleSchema } from "../../diagnostics/perfSampleStore.js";
import { createRouteFamily } from "./routeFamily.js";

const gameplayTraceEventSchema = z.object({
  traceId: z.string().max(80).optional(),
  source: z.literal("client"),
  category: z.enum([
    "movement", "networking", "flag-preparation", "build",
    "world", "population", "database", "ui"
  ] as const),
  name: z.string().min(1).max(96),
  wallTimeIso: z.string().max(64).optional(),
  monotonicMs: z.number().finite().nonnegative().optional(),
  details: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()])
  ).optional(),
  failure: z.boolean().optional()
});

const gameplayTraceEventsBodySchema = z.object({
  events: z.array(gameplayTraceEventSchema).max(100)
});
const gameplayTraceMarkBodySchema = z.object({ label: z.string().min(1).max(80) });

export function createDiagnosticRoutes(context: Readonly<{
  app: FastifyInstance;
  logger: AppLogger;
  registry: ConnectionRegistry;
  gameState: GameState;
  auth?: AuthService | undefined;
  collectibles?: CollectibleService | undefined;
  combat?: (Pick<CombatEngine, "metricsSnapshot"> & Partial<Pick<CombatEngine, "tickHistorySnapshot">>) | undefined;
  perfSamples?: PerfSampleStore | undefined;
  worldRuntime?: Pick<WorldRuntime, "metricsSnapshot"> | undefined;
  admission: HttpAdmissionController;
  operational: RouteOperationalDependencies;
  config: AppConfig;
}>): void {
  const {
    app,
    logger,
    registry,
    gameState,
    auth,
    collectibles,
    combat,
    worldRuntime,
    admission,
    operational,
    config
  } = context;
  const perfSamples = context.perfSamples ?? new PerfSampleStore();
  void gameState;
  const diagnosticRoutes = createRouteFamily(app, "diagnostics");
  diagnosticRoutes.get("/api/dev/diagnostics/database", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:observe", "database.diagnostics"
    );
    if (!developer) return;
    if (!operational.database) {
      sendError(reply, 503, "DATABASE_DIAGNOSTICS_UNAVAILABLE", "database diagnostics are unavailable");
      return;
    }
    return operational.database();
  });

  diagnosticRoutes.get("/api/dev/diagnostics/realtime", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:observe", "realtime.diagnostics"
    );
    if (!developer) return;
    return {
      admission: admission.metricsSnapshot(),
      connections: registry.metricsSnapshot(),
      publisher: {
        registered: registry.realtimePublisherMetricsSnapshot(),
        direct: directPublisherMetricsSnapshot()
      }
    };
  });

  // Perf probe route: developer-gated, and independent of TELEMETRY_ENABLED.
  diagnosticRoutes.get("/api/dev/diagnostics/perf", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:observe", "perf.diagnostics"
    );
    if (!developer) return;
    return {
      sampledAtMs: Date.now(),
      combat: combat?.metricsSnapshot() ?? null,
      worldRuntime: worldRuntime?.metricsSnapshot() ?? null,
      gameplayTick: operational.gameplayTick?.() ?? null,
      serverTicks: combat?.tickHistorySnapshot?.() ?? null,
      realtimePublisher: registry.realtimePublisherMetricsSnapshot(),
      connections: registry.metricsSnapshot()
    };
  });

  diagnosticRoutes.get("/api/dev/diagnostics/perf/samples", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:observe", "perf.samples"
    );
    if (!developer) return;
    const query = z.object({
      playerId: z.string().max(80).optional(),
      sinceMs: z.coerce.number().finite().optional(),
      limit: z.coerce.number().int().min(1).max(2000).optional()
    }).safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "BAD_PERF_SAMPLES_QUERY", "perf samples query is invalid");
      return;
    }
    return { sampledAtMs: Date.now(), samples: perfSamples.read(query.data) };
  });

  // Client probe upload: only sessions with developer:observe, and only a bounded ring is kept.
  diagnosticRoutes.post("/api/diagnostics/perf-sample", async (request, reply) => {
    const playerId = request.authSession?.player?.id;
    if (!playerId || !auth?.hasDeveloperCapability(request.authSession, "developer:observe")) {
      logger.warn({ hasSession: Boolean(request.authSession), hasPlayer: Boolean(playerId) }, "perf-sample rejected: not a developer session");
      sendError(reply, 403, "DEVELOPER_TRACE_FORBIDDEN", "Perf sampling is unavailable");
      return;
    }
    const parsed = perfSampleSchema.safeParse(request.body);
    if (!parsed.success) {
      logger.warn(
        { playerId, issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
        "perf-sample rejected: invalid body"
      );
      sendError(reply, 400, "BAD_PERF_SAMPLE", "perf sample is invalid");
      return;
    }
    const stored = perfSamples.add(playerId, parsed.data);
    if (!stored) {
      logger.warn({ playerId }, "perf-sample rejected: rate limited");
      sendError(reply, 429, "PERF_SAMPLE_RATE_LIMITED", "perf samples are arriving too fast");
      return;
    }
    logger.info({ playerId, perfSample: parsed.data }, "perf-sample");
    return { ok: true };
  });

  diagnosticRoutes.get("/api/dev/diagnostics/population", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:observe", "population.diagnostics"
    );
    if (!developer) return;
    if (!operational.populationV2) {
      sendError(
        reply,
        503,
        "POPULATION_DIAGNOSTICS_UNAVAILABLE",
        "population diagnostics are unavailable"
      );
      return;
    }
    return {
      ...operational.populationV2(),
      materializations:
        await operational.populationV2Materializations?.() ?? null
    };
  });

  diagnosticRoutes.get("/api/diagnostics/gameplay-latency-trace", async (request, reply) => {
    const playerId = gameplayTracePlayerId(request, reply, auth);
    if (!playerId) return;
    return gameplayLatencyTrace.snapshot(playerId);
  });

  diagnosticRoutes.post("/api/diagnostics/gameplay-latency-trace/start", async (request, reply) => {
    const playerId = gameplayTracePlayerId(request, reply, auth);
    if (!playerId) return;
    const releaseIdentity = resolveGameplayTraceReleaseIdentity({
      runtimeSha: config.RUNTIME_SHA,
      runtimeGeneration: config.RUNTIME_GENERATION,
      telemetryReleaseGeneration: config.TELEMETRY_RELEASE_GENERATION,
      worldPipelineSha: WORLD_RUNTIME_CONTRACT.worldPipelineSha
    });
    if (!releaseIdentity) {
      sendError(
        reply,
        503,
        "GAMEPLAY_TRACE_RELEASE_IDENTITY_UNAVAILABLE",
        "Gameplay latency tracing requires immutable release identity"
      );
      return;
    }
    return gameplayLatencyTrace.start(playerId, releaseIdentity);
  });

  diagnosticRoutes.post("/api/diagnostics/gameplay-latency-trace/stop", async (request, reply) => {
    const playerId = gameplayTracePlayerId(request, reply, auth);
    if (!playerId) return;
    return gameplayLatencyTrace.stop(playerId);
  });

  diagnosticRoutes.delete("/api/diagnostics/gameplay-latency-trace", async (request, reply) => {
    const playerId = gameplayTracePlayerId(request, reply, auth);
    if (!playerId) return;
    return gameplayLatencyTrace.clear(playerId);
  });

  diagnosticRoutes.post("/api/diagnostics/gameplay-latency-trace/mark", async (request, reply) => {
    const playerId = gameplayTracePlayerId(request, reply, auth);
    if (!playerId) return;
    const parsed = gameplayTraceMarkBodySchema.safeParse(request.body);
    if (!parsed.success) {
      sendError(reply, 400, "BAD_GAMEPLAY_TRACE_MARK", "trace mark label is invalid");
      return;
    }
    gameplayLatencyTrace.record(playerId, {
      source: "game",
      category: "ui",
      name: "developer_moment_marked",
      details: { label: parsed.data.label }
    });
    return gameplayLatencyTrace.snapshot(playerId);
  });

  diagnosticRoutes.post("/api/diagnostics/gameplay-latency-trace/events", async (request, reply) => {
    const playerId = gameplayTracePlayerId(request, reply, auth);
    if (!playerId) return;
    const parsed = gameplayTraceEventsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      sendError(reply, 400, "BAD_GAMEPLAY_TRACE_EVENTS", "trace event batch is invalid");
      return;
    }
    gameplayLatencyTrace.recordClientEvents(
      playerId,
      parsed.data.events.map((event) => ({
        ...event,
        category: event.category as GameplayTraceCategory,
        details: event.details as GameplayTraceDetails | undefined
      }))
    );
    return gameplayLatencyTrace.snapshot(playerId);
  });

  diagnosticRoutes.get("/api/dev/spawns/count", async (request, reply) => {
    const developer = await authorizeDeveloperHttp(
      request, reply, auth, "developer:observe", "spawns.count"
    );
    if (!developer) return;
    if (!collectibles) {
      sendError(reply, 503, "COLLECTIBLES_UNAVAILABLE", "collectibles service is unavailable");
      return;
    }
    return collectibles.countSpawns();
  });

}

function gameplayTracePlayerId(
  request: FastifyRequest,
  reply: Parameters<typeof sendError>[0],
  auth: AuthService | undefined
): string | null {
  const playerId = request.authSession?.player?.id;
  if (!playerId || !auth?.hasDeveloperCapability(request.authSession, "developer:observe")) {
    sendError(reply, 403, "DEVELOPER_TRACE_FORBIDDEN", "Gameplay latency tracing is unavailable");
    return null;
  }
  return playerId;
}

import Fastify from "fastify";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { CombatRewardSettlementService } from "../game/combat/rewardSettlement.js";
import type { CollectibleService } from "../game/collectibles.js";
import type { FlagService } from "../game/flags.js";
import type { PlayerService } from "../game/players.js";
import type { ResourceVisionJobQueue } from "../game/resourceVisionJobs.js";
import type { GameState } from "../game/state.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { populationV2AuthorityHealth, registerRoutes } from "./routes.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("authoritative readiness", () => {
  it("detects required visible authority with no recoverable work", () => {
    const health = populationV2AuthorityHealth(
      { NODE_ENV: "production" },
      populationRuntimeSnapshot({
        incompleteActivationZones: 3,
        incompleteRequiredVisiblePreparations: 1,
        strandedRequiredVisiblePreparations: 1
      })
    );

    expect(health).toMatchObject({
      ok: false,
      reason: "required-visible-stranded",
      referencedZones: 6,
      incompleteActivationZones: 3,
      workInFlight: 0
    });
  });

  it("keeps readiness healthy while bounded v2 activation work is progressing", () => {
    const health = populationV2AuthorityHealth(
      { NODE_ENV: "production" },
      populationRuntimeSnapshot({
        incompleteActivationZones: 3,
        incompleteRequiredVisiblePreparations: 1,
        activationInFlight: 1
      })
    );

    expect(health).toMatchObject({
      ok: true,
      reason: "required-visible-preparing"
    });
  });

  it("keeps an optional background failure diagnostic healthy", () => {
    expect(populationV2AuthorityHealth(
      { NODE_ENV: "production" },
      populationRuntimeSnapshot({
        lastActivationError: "stored population plan does not match request",
        optionalBackgroundPendingZones: 3
      })
    )).toMatchObject({
      ok: true,
      reason: "optional-background-pending",
      lastError: "stored population plan does not match request"
    });
  });

  it("reports terminal failed required-visible authority as unhealthy", () => {
    expect(populationV2AuthorityHealth(
      { NODE_ENV: "production" },
      populationRuntimeSnapshot({
        incompleteRequiredVisiblePreparations: 1,
        terminalFailedRequiredVisiblePreparations: 1
      })
    )).toMatchObject({
      ok: false,
      reason: "required-visible-terminal-failure"
    });
  });

  it.each(["success", "failure"] as const)(
    "serves an authenticated %s preview without route-level fallback lookup",
    async (preview) => {
      const app = createHarness({ preview });
      const response = await app.inject({
        method: "POST",
        url: "/api/flags/placement-quote",
        payload: {
          quoteRequestId: "00000000-0000-4000-8000-000000900011",
          trigger: "background",
          requestedPosition: { lat: 35.0844, lon: -106.6504 },
          movementRevision: 4,
          relocationRevision: 2
        }
      });

      expect(response.statusCode).toBe(200);
      expect(app.testStubs.tryCreatePlacementQuote).toHaveBeenCalledOnce();
      expect(app.testStubs.lookup).not.toHaveBeenCalled();
      expect(response.json()).toMatchObject(preview === "success"
        ? { ok: true, placementQuote: { quoteId: "quote-1" } }
        : {
            ok: false,
            failure: { code: "WORLD_LOOKUP_TIMEOUT" },
            placementFailure: { code: "WORLD_LOOKUP_TIMEOUT", retryable: true }
          });
    }
  );

  it("returns 200 only when every mandatory authority is verified", async () => {
    const app = createHarness();
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "ready",
      releasePipelineCanary: "stage5-activate-fence-v1",
      checks: {
        database: { ok: true },
        worldAuthority: {
          ok: true,
          release: { releaseId: "world-packages-v1", packageCount: 64_800 },
          lookup: { ok: true, failure: null }
        },
        runtimeIdentity: { ok: true },
        marketReconciliation: { ok: true },
        combatRewards: { ok: true, reason: "healthy" },
        resourceJobs: { ok: true, reason: "healthy" },
        populationV2Authority: { ok: true, reason: "healthy" }
      }
    });
  });

  it.each([
    ["world authority", { worldOk: false }],
    ["world lookup", { worldLookupOk: false }],
    ["runtime identity", { runtimeIdentity: false }],
    ["database", { databaseOk: false }],
    ["market reconciliation", { marketOk: false }],
    ["combat reward worker", { rewardWorkerOk: false }],
    ["durable resource jobs", { resourceJobsOk: false }],
    ["population v2 authority", { populationBackendAvailable: false }]
  ] as const)("returns 503 when %s is unhealthy", async (_label, options) => {
    const app = createHarness(options);
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, status: "not_ready" });
  });

  it("keeps health diagnostic even when readiness authority fails", async () => {
    const app = createHarness({ worldOk: false });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      combatRewards: { worker: { running: true } },
      resourceVisionJobs: { active: 0 },
      waterHighlightCache: { entries: 0, approximateBytes: 0 }
    });
  });
});

function populationRuntimeSnapshot(options: {
  incompleteActivationZones?: number;
  activationInFlight?: number;
  lastActivationError?: string | null;
  incompleteRequiredVisiblePreparations?: number;
  optionalBackgroundPendingZones?: number;
  terminalFailedRequiredVisiblePreparations?: number;
  strandedRequiredVisiblePreparations?: number;
} = {}) {
  return {
    planner: {
      pendingZones: 0,
      queuedZones: 0,
      activeZonePreparations: 0,
      zones: []
    },
    runtime: {
      connectionLeases: 1,
      referencedZones: 6,
      activationRequests: 0,
      activationInFlight: options.activationInFlight ?? 0,
      priorityActivationFlights: 0,
      incompleteActivationZones: options.incompleteActivationZones ?? 0,
      incompleteRequiredVisiblePreparations:
        options.incompleteRequiredVisiblePreparations ?? 0,
      optionalBackgroundPendingZones:
        options.optionalBackgroundPendingZones ?? 0,
      terminalFailedRequiredVisiblePreparations:
        options.terminalFailedRequiredVisiblePreparations ?? 0,
      strandedRequiredVisiblePreparations:
        options.strandedRequiredVisiblePreparations ?? 0
    },
    backend: {
      activationInFlight: 0,
      lastActivationError: options.lastActivationError ?? null
    }
  };
}

function createHarness(options: {
  worldOk?: boolean;
  worldLookupOk?: boolean;
  runtimeIdentity?: boolean;
  databaseOk?: boolean;
  marketOk?: boolean;
  rewardWorkerOk?: boolean;
  resourceJobsOk?: boolean;
  populationBackendAvailable?: boolean;
  preview?: "success" | "failure";
} = {}) {
  const app = Fastify();
  apps.push(app);
  const config = loadConfig({
    NODE_ENV: "development",
    ...(options.runtimeIdentity === false
      ? {}
      : {
          RUNTIME_LABEL: "stability-lab",
          RUNTIME_BRANCH: "feature/production-stability-hardening-v1",
          RUNTIME_SHA: "a".repeat(40)
        })
  });
  const pool = {
    query: vi.fn(async () => {
      if (options.databaseOk === false) throw new Error("database unavailable");
      return { rows: [{ value: 1 }], rowCount: 1 };
    })
  } as unknown as pg.Pool;
  const release = {
    releaseId: config.WORLD_REQUIRED_RELEASE_ID,
    profileSetFingerprint: config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
    buildContractFingerprint: config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
    boundaryReleaseId: config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID,
    packageCount: 64_800
  };
  const previewPlayer = {
    playerId: "preview-player",
    username: "Preview Player",
    displayColor: "#38bdf8",
    regionCode: "world_v1_lat35_lon-107",
    position: { lat: 35.0844, lon: -106.6504 },
    anchor: { lat: 35.0844, lon: -106.6504 },
    moveLeashRadiusM: 1_250,
    movementRevision: 4,
    relocationRevision: 2,
    target: null,
    online: true,
    updatedAt: new Date()
  };
  if (options.preview) {
    app.addHook("preHandler", async (request) => {
      request.authSession = {
        player: { id: previewPlayer.playerId }
      } as never;
    });
  }
  const previewFailure = {
    code: "WORLD_LOOKUP_TIMEOUT",
    message: "World validation timed out. Try again shortly.",
    retryable: true,
    retryAfterMs: 2_000
  } as const;
  const tryCreatePlacementQuote = vi.fn(async () => options.preview === "failure"
    ? {
        world: {
          ok: false,
          packageId: null,
          failure: previewFailure
        },
        failure: previewFailure
      }
    : {
        world: {
          ok: true,
          packageId: previewPlayer.regionCode,
          latitude: previewPlayer.position.lat,
          longitude: previewPlayer.position.lon
        },
        placementQuote: {
          quoteId: "quote-1",
          expiresAt: Date.now() + 60_000
        }
      });
  const lookup = vi.fn(async () => options.worldLookupOk === false
    ? {
        ok: false,
        failure: {
          code: "WORLD_LOOKUP_TIMEOUT",
          message: "World validation timed out. Try again shortly.",
          retryable: true,
          retryAfterMs: 2_000
        }
      }
    : {
        ok: true,
        packageId: "world_v1_lat35_lon-107",
        latitude: config.DEFAULT_SPAWN_LAT,
        longitude: config.DEFAULT_SPAWN_LON
      });
  const worldLookup = {
    verifyRequiredRelease: vi.fn(async () => {
      if (options.worldOk === false) throw new Error("world unavailable");
      return release;
    }),
    lookup,
    lookupGameplayEnvironment: lookup,
    waterHighlightCacheMetrics: vi.fn(() => ({
      entries: 0,
      approximateBytes: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      staleExpirations: 0,
      authorityInvalidations: 0,
      oversizedResponses: 0
    })),
    gameplayEnvironmentMetrics: vi.fn(() => ({
      entries: 0,
      negativeEntries: 0,
      inFlight: 0,
      inFlightBatches: 0,
      hits: 0,
      negativeHits: 0,
      misses: 0,
      builds: 0,
      upstreamAttempts: 0,
      sharedWaits: 0,
      batchBuilds: 0,
      batchUpstreamAttempts: 0,
      batchSharedWaits: 0,
      batchPoints: 0,
      evictions: 0,
      staleExpirations: 0,
      negativeExpirations: 0,
      authorityInvalidations: 0,
      failureClassifications: {}
    })),
    worldBatchAdmissionMetrics: vi.fn(() => ({
      concurrency: 1,
      queueCapacity: 64,
      active: 0,
      queueDepth: 0,
      maximumActive: 1,
      maximumQueueDepth: 0,
      callers: {}
    }))
  } as unknown as WorldLookupClient;
  const collectibles = {
    countSpawns: vi.fn(async () => ({
      spawnCellCount: 0,
      availableNodeCount: 0,
      harvestedNodeCount: 0,
      resourceVisionStatusCounts: {
        pending: 0,
        generating: 0,
        ready: 1,
        failed: options.resourceJobsOk === false ? 1 : 0
      }
    }))
  } as unknown as CollectibleService;
  const resourceRuntime = {
      pending: 0,
      active: 0,
      trackedJobs: 0,
      completionSubscribers: 0,
      supervisorRunning: options.resourceJobsOk !== false,
      lastError: null,
      durable: {
        pending: 0,
        processing: 0,
        retrying: 0,
        terminalFailed: 0,
        completed: 0,
        oldestPendingAgeMs: 0,
        expiredLeases: 0
      }
  };
  const resourceJobs = {
    metricsSnapshot: vi.fn(() => resourceRuntime),
    refreshMetricsSnapshot: vi.fn(async () => resourceRuntime)
  } as unknown as ResourceVisionJobQueue;
  const marketReconciliation = {
    snapshot: vi.fn(() => ({})),
    readiness: vi.fn(() => ({ ok: options.marketOk !== false, reason: "healthy", state: {} }))
  };
  const rewardMetrics = {
    queueDepth: 0,
    oldestPendingAgeMs: 0,
    processingCount: 0,
    retries: 0,
    failures: 0,
    completed: 0,
    droppedAtCapacity: 0,
    totalLatencyMs: 0,
    averageLatencyMs: 0
  };
  const combatRewards = {
    metricsSnapshot: vi.fn(() => rewardMetrics),
    refreshMetricsSnapshot: vi.fn(async () => rewardMetrics),
    workerState: vi.fn(() => ({
      running: options.rewardWorkerOk !== false,
      flushInProgress: false,
      intervalMs: 1_000,
      lastSuccessfulRunAt: new Date().toISOString(),
      lastError: null
    }))
  } as Pick<
    CombatRewardSettlementService,
    "metricsSnapshot" | "refreshMetricsSnapshot" | "workerState"
  >;
  registerRoutes({
      infrastructure: {
          app: app,
          pool: pool,
          worldLookup: worldLookup,
          config: config,
          registry: {} as ConnectionRegistry,
          logger: loggerStub()
      },
      authority: {
          flags: {
              tryCreatePlacementQuote,
              placementQuoteMetrics: () => ({
                  quoteCreated: 0,
                  quoteReused: 0,
                  quoteSingleflightJoined: 0,
                  validQuoteReplacement: 0,
                  postBuildQuoteSuppressed: 0
              })
          } as unknown as FlagService,
          players: {} as PlayerService,
          gameState: { getPlayer: vi.fn(() => previewPlayer) } as unknown as GameState
      },
      capabilities: {
          collectibles: collectibles,
          resourceVisionJobs: resourceJobs,
          marketReconciliation: marketReconciliation as never
      },
      operational: {
          combatRewards,
          populationV2: () => ({
            ...populationRuntimeSnapshot(),
            ...(options.populationBackendAvailable === false
              ? { backend: null }
              : {})
          })
      }
  });
  return Object.assign(app, {
    testStubs: { lookup, tryCreatePlacementQuote }
  });
}

function loggerStub(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  } as unknown as AppLogger;
}

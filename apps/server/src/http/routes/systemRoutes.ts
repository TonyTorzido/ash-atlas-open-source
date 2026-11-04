import type { FastifyInstance } from "fastify";
import type pg from "pg";

import type { AppConfig } from "../../config.js";
import type { CollectibleService } from "../../game/collectibles.js";
import type { CombatRewardSettlementService } from "../../game/combat/rewardSettlement.js";
import type { FlagService } from "../../game/flags.js";
import type { MarketReconciliationSupervisor } from "../../game/marketReconciliationSupervisor.js";
import type { ResourceVisionJobQueue } from "../../game/resourceVisionJobs.js";
import { websocketSecurityMetricsSnapshot } from "../../realtime/websocket.js";
import { runtimeIdentity } from "../../runtimeIdentity.js";
import type { WorldLookupClient } from "../../world/worldLookupClient.js";
import type { HttpAdmissionController } from "../admission.js";
import { createRouteFamily } from "./routeFamily.js";

const RELEASE_PIPELINE_CANARY = "stage5-activate-fence-v1";

export type PopulationV2AuthorityRuntimeSnapshot = Readonly<{
  planner: Readonly<{
    pendingZones: number;
    queuedZones: number;
    activeZonePreparations: number;
    zones: readonly Readonly<{ lastError: string | null }>[];
  }>;
  runtime: Readonly<{
    connectionLeases: number;
    referencedZones: number;
    activationRequests: number;
    activationInFlight: number;
    priorityActivationFlights: number;
    incompleteActivationZones: number;
    incompleteRequiredVisiblePreparations?: number;
    optionalBackgroundPendingZones?: number;
    retryingRequiredVisiblePreparations?: number;
    terminalFailedRequiredVisiblePreparations?: number;
    strandedRequiredVisiblePreparations?: number;
    lateVisiblePopulation?: number;
  }>;
  backend: Readonly<{
    activationInFlight: number;
    lastActivationError: string | null;
  }> | null;
}>;

export type RouteOperationalDependencies = {
  combatRewards?: Pick<
    CombatRewardSettlementService,
    "metricsSnapshot" | "refreshMetricsSnapshot" | "workerState"
  >;
  populationV2?: () => PopulationV2AuthorityRuntimeSnapshot;
  populationV2Materializations?: () => Promise<unknown>;
  environmentProfiles?: () => unknown;
  environmentProfileJobs?: () => unknown;
  gameplayTick?: () => unknown;
  eventLoopDelay?: () => unknown;
  database?: () => unknown;
  populationFlagCleanup?: () => unknown | Promise<unknown>;
};

export type SystemRoutesContext = Readonly<{
  app: FastifyInstance;
  pool: pg.Pool;
  worldLookup: WorldLookupClient;
  config: AppConfig;
  flags: FlagService;
  collectibles?: CollectibleService | undefined;
  resourceVisionJobs?: ResourceVisionJobQueue | undefined;
  marketReconciliation?: MarketReconciliationSupervisor | undefined;
  marketMetrics?: (() => unknown) | undefined;
  admission: HttpAdmissionController;
  operational: RouteOperationalDependencies;
}>;

export function createSystemRoutes(context: SystemRoutesContext): void {
  const {
    app,
    pool,
    worldLookup,
    config,
    flags,
    collectibles,
    resourceVisionJobs,
    marketReconciliation,
    marketMetrics,
    admission,
    operational
  } = context;
  const systemRoutes = createRouteFamily(app, "system");
  systemRoutes.get("/health", async () => {
    const runtime = runtimeIdentity(config);
    const populationV2 = populationV2AuthorityHealth(
      config,
      operational.populationV2?.() ?? null
    );
    return {
      ok: true,
      service: "ash-atlas-server",
      region: config.REGION_CODE,
      serverTime: Date.now(),
      ...(runtime ? { runtime } : {}),
      marketReconciliation: marketReconciliation?.snapshot() ?? null,
      marketMetrics: marketMetrics?.() ?? null,
      combatRewards: operational.combatRewards
        ? {
            metrics: operational.combatRewards.metricsSnapshot(),
            worker: operational.combatRewards.workerState()
          }
        : null,
      resourceVisionJobs: resourceVisionJobs?.metricsSnapshot() ?? null,
      populationFlagCleanup:
        await operational.populationFlagCleanup?.() ?? null,
      waterHighlightCache: worldLookup.waterHighlightCacheMetrics(),
      gameplayEnvironment: worldLookup.gameplayEnvironmentMetrics(),
      worldBatchAdmission: worldLookup.worldBatchAdmissionMetrics(),
      flagPlacementQuotes: flags.placementQuoteMetrics(),
      websocketSecurity: websocketSecurityMetricsSnapshot(),
      httpAdmission: admission.healthMetricsSnapshot(),
      populationV2Authority: populationV2,
      environmentProfiles: operational.environmentProfiles?.() ?? null,
      environmentProfileJobs: operational.environmentProfileJobs?.() ?? null,
      gameplayTick: operational.gameplayTick?.() ?? null,
      eventLoopDelay: operational.eventLoopDelay?.() ?? null
    };
  });

  systemRoutes.get("/ready", async (_request, reply) => {
    const [db, world, combatRewards, resourceJobs] = await Promise.all([
      checkDb(pool, config.DB_READINESS_TIMEOUT_MS),
      checkWorldAuthority(
        worldLookup,
        { lat: config.DEFAULT_SPAWN_LAT, lon: config.DEFAULT_SPAWN_LON },
        config.WORLD_LOOKUP_TIMEOUT_MS
      ),
      checkCombatRewardWorker(operational.combatRewards),
      checkResourceJobs(collectibles, resourceVisionJobs)
    ]);
    const runtime = runtimeIdentity(config);
    const runtimeReady = config.NODE_ENV === "test" || runtime !== null;
    const reconciliation = marketReconciliation?.readiness() ?? null;
    const optionalInTest = config.NODE_ENV === "test";
    const reconciliationReady = reconciliation?.ok ?? optionalInTest;
    const combatRewardsReady = combatRewards?.ok ?? optionalInTest;
    const resourceJobsReady = resourceJobs?.ok ?? optionalInTest;
    const populationV2Authority = populationV2AuthorityHealth(
      config,
      operational.populationV2?.() ?? null
    );
    const ok =
      db.ok &&
      world.ok &&
      runtimeReady &&
      reconciliationReady &&
      combatRewardsReady &&
      resourceJobsReady &&
      populationV2Authority.ok;
    reply.code(ok ? 200 : 503);
    return {
      ok,
      status: ok ? "ready" : "not_ready",
      releasePipelineCanary: RELEASE_PIPELINE_CANARY,
      checks: {
        database: { ok: db.ok },
        worldAuthority: world,
        runtimeIdentity: { ok: runtimeReady, identity: runtime },
        marketReconciliation: reconciliation,
        combatRewards,
        resourceJobs,
        populationV2Authority
      }
    };
  });
}

export function populationV2AuthorityHealth(
  config: Pick<AppConfig, "NODE_ENV">,
  snapshot: PopulationV2AuthorityRuntimeSnapshot | null
): Readonly<{
  ok: boolean;
  reason: string;
  referencedZones: number;
  incompleteActivationZones: number;
  incompleteRequiredVisiblePreparations: number;
  optionalBackgroundPendingZones: number;
  retryingRequiredVisiblePreparations: number;
  terminalFailedRequiredVisiblePreparations: number;
  strandedRequiredVisiblePreparations: number;
  workInFlight: number;
  lastError: string | null;
}> {
  const base = {
    referencedZones: snapshot?.runtime.referencedZones ?? 0,
    incompleteActivationZones: snapshot?.runtime.incompleteActivationZones ?? 0,
    incompleteRequiredVisiblePreparations:
      snapshot?.runtime.incompleteRequiredVisiblePreparations ?? 0,
    optionalBackgroundPendingZones:
      snapshot?.runtime.optionalBackgroundPendingZones ?? 0,
    retryingRequiredVisiblePreparations:
      snapshot?.runtime.retryingRequiredVisiblePreparations ?? 0,
    terminalFailedRequiredVisiblePreparations:
      snapshot?.runtime.terminalFailedRequiredVisiblePreparations ?? 0,
    strandedRequiredVisiblePreparations:
      snapshot?.runtime.strandedRequiredVisiblePreparations ?? 0,
    workInFlight: snapshot
      ? snapshot.planner.pendingZones
        + snapshot.planner.queuedZones
        + snapshot.planner.activeZonePreparations
        + snapshot.runtime.activationRequests
        + snapshot.runtime.activationInFlight
        + snapshot.runtime.priorityActivationFlights
        + (snapshot.backend?.activationInFlight ?? 0)
      : 0,
    lastError: snapshot?.backend?.lastActivationError
      ?? snapshot?.planner.zones.find((zone) => zone.lastError)?.lastError
      ?? null
  };
  if (!snapshot) {
    return {
      ok: config.NODE_ENV !== "production",
      reason: config.NODE_ENV === "production" ? "runtime-not-composed" : "runtime-not-required",
      ...base
    };
  }
  if (!snapshot.backend) {
    return { ok: false, reason: "backend-unavailable", ...base };
  }
  if (base.terminalFailedRequiredVisiblePreparations > 0) {
    return { ok: false, reason: "required-visible-terminal-failure", ...base };
  }
  if (base.strandedRequiredVisiblePreparations > 0) {
    return { ok: false, reason: "required-visible-stranded", ...base };
  }
  if (base.incompleteRequiredVisiblePreparations > 0) {
    return { ok: true, reason: "required-visible-preparing", ...base };
  }
  if (base.optionalBackgroundPendingZones > 0) {
    return { ok: true, reason: "optional-background-pending", ...base };
  }
  return { ok: true, reason: "healthy", ...base };
}

async function checkDb(pool: pg.Pool, timeoutMs: number): Promise<{ ok: boolean }> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("database readiness timed out")), timeoutMs);
        timeout.unref();
      })
    ]);
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function checkWorldAuthority(
  worldLookup: WorldLookupClient,
  probe: { lat: number; lon: number },
  maximumLookupMs: number
): Promise<{
  ok: boolean;
  release: Awaited<ReturnType<WorldLookupClient["verifyRequiredRelease"]>> | null;
  lookup: {
    ok: boolean;
    latencyMs: number;
    failure: Awaited<ReturnType<WorldLookupClient["lookupGameplayEnvironment"]>>["failure"] | null;
  };
}> {
  const startedAt = performance.now();
  try {
    const release = await worldLookup.verifyRequiredRelease();
    const lookupStartedAt = performance.now();
    const result = await worldLookup.lookupGameplayEnvironment(probe.lat, probe.lon);
    const latencyMs = performance.now() - lookupStartedAt;
    const withinLatencyBudget = latencyMs <= maximumLookupMs;
    const ok = result.ok && withinLatencyBudget;
    return {
      ok,
      release,
      lookup: {
        ok,
        latencyMs,
        failure: result.failure ?? (withinLatencyBudget
          ? null
          : {
              code: "WORLD_LOOKUP_TIMEOUT",
              message: "World validation exceeded its readiness latency budget.",
              retryable: true,
              retryAfterMs: 2_000
            })
      }
    };
  } catch {
    return {
      ok: false,
      release: null,
      lookup: {
        ok: false,
        latencyMs: performance.now() - startedAt,
        failure: {
          code: "WORLD_AUTHORITY_UNAVAILABLE",
          message: "World validation is temporarily unavailable. Try again shortly.",
          retryable: true,
          retryAfterMs: 2_000
        }
      }
    };
  }
}

async function checkCombatRewardWorker(
  rewards: RouteOperationalDependencies["combatRewards"]
): Promise<{
  ok: boolean;
  reason: "healthy" | "unavailable" | "supervisor_not_running" | "worker_failed" | "stale_backlog";
  metrics: ReturnType<CombatRewardSettlementService["metricsSnapshot"]> | null;
  worker: ReturnType<CombatRewardSettlementService["workerState"]> | null;
} | null> {
  if (!rewards) return null;
  try {
    const metrics = await rewards.refreshMetricsSnapshot();
    const worker = rewards.workerState();
    const staleThresholdMs = Math.max(120_000, (worker.intervalMs ?? 1_000) * 120);
    const reason = !worker.running
      ? "supervisor_not_running"
      : worker.lastError
        ? "worker_failed"
        : metrics.queueDepth > 0 && metrics.oldestPendingAgeMs > staleThresholdMs
          ? "stale_backlog"
          : "healthy";
    return { ok: reason === "healthy", reason, metrics, worker };
  } catch {
    return { ok: false, reason: "unavailable", metrics: null, worker: null };
  }
}

async function checkResourceJobs(
  collectibles: CollectibleService | undefined,
  jobs: ResourceVisionJobQueue | undefined
): Promise<{
  ok: boolean;
  reason: "healthy" | "unavailable" | "failed_jobs";
  durableStatusCounts: Awaited<ReturnType<CollectibleService["countSpawns"]>>["resourceVisionStatusCounts"] | null;
  runtime: ReturnType<ResourceVisionJobQueue["metricsSnapshot"]> | null;
} | null> {
  if (!collectibles || !jobs) return null;
  try {
    const [counts, runtime] = await Promise.all([
      collectibles.countSpawns(),
      jobs.refreshMetricsSnapshot()
    ]);
    const unhealthy =
      !runtime.supervisorRunning ||
      runtime.lastError !== null ||
      runtime.durable.terminalFailed > 0 ||
      runtime.durable.expiredLeases > 0;
    return {
      ok: !unhealthy,
      reason: unhealthy ? "failed_jobs" : "healthy",
      durableStatusCounts: counts.resourceVisionStatusCounts,
      runtime
    };
  } catch {
    return {
      ok: false,
      reason: "unavailable",
      durableStatusCounts: null,
      runtime: jobs.metricsSnapshot()
    };
  }
}

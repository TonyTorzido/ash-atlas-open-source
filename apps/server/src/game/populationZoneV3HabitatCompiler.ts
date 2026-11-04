import { performance } from "node:perf_hooks";

import type { LatLon } from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import {
  WORLD_GAMEPLAY_ENVIRONMENT_BATCH_MAX_POINTS,
  WorldBatchBackpressureError,
  WorldBatchInvalidResponseError,
  WorldReleaseMismatchError
} from "../world/worldLookupClient.js";
import type {
  WorldBatchCaller,
  WorldBatchPriority
} from "../world/worldBatchAdmission.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import { deriveEnvironmentSpawnProfileKey } from "./environmentSpawnProfiles.js";
import { worldEnvironmentIdentityKey } from "./gameplayEnvironmentProfiles.js";
import type { PopulationZoneV2Id } from "./populationZonesV2Geometry.js";
import {
  estimatePopulationZoneV2Habitat,
  type PopulationZoneV2Habitat,
  type PopulationZoneV2HabitatFacts,
  type PopulationZoneV2HabitatSample,
  POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT,
  POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION,
  populationZoneV3CompactHabitatSamplePoints
} from "./populationZonesV2Plan.js";

export const POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION =
  "population-compact-gameplay-environment-v3-riverbank-lakeshore";
const DEFAULT_CACHE_MAXIMUM = 512;
const DEFAULT_MAXIMUM_BATCH_ATTEMPTS = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_BUDGET_MS = 5_000;
const MAXIMUM_ACTIVITY_ENTRIES = 256;

export type PopulationZoneV3CompileActivity = Readonly<{
  zoneId: PopulationZoneV2Id;
  state: "compact-lookup" | "generating" | "ready" | "failed";
  requestedSamples: number;
  uniqueSamples: number;
  readySamples: number;
  activeSamples: number;
  failedSamples: number;
  cacheHits: number;
  batchCalls: number;
  backpressureRetries: number;
  deduplicatedSamples: number;
  startedAt: string;
  lastProgressAt: string;
  completedAt: string | null;
  batchLatencyMs: number;
  samplePreparationMs: number;
  worldLookupMs: number;
  habitatEstimationMs: number;
  habitatConstructionMs: number;
  totalMs: number;
  lastError: string | null;
}>;

export type PopulationEnvironmentPrefetchDiagnostics = Readonly<{
  requestedZoneIds: readonly PopulationZoneV2Id[];
  sampleReferences: number;
  uniqueSamples: number;
  worldCacheHits: number;
  sentPointCount: number;
  chunkCount: number;
  chunkSizes: readonly number[];
  upstreamBatchCalls: number;
  backpressureRetries: number;
  admissionWaitMs: number;
  upstreamDurationMs: number;
}>;

export class PopulationEnvironmentPrefetchTerminalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PopulationEnvironmentPrefetchTerminalError";
  }
}

type CompactWorldLookup = Readonly<{
  lookupGameplayEnvironments(
    points: readonly LatLon[],
    options?: {
      signal?: AbortSignal | undefined;
      caller?: WorldBatchCaller | undefined;
      priority?: WorldBatchPriority | undefined;
      cacheClass?: "protected" | "probationary" | undefined;
    }
  ): Promise<WorldGameplayEnvironmentResult[]>;
  gameplayEnvironmentMetrics?(): Readonly<{
    hits: number;
    batchUpstreamAttempts: number;
    batchPoints: number;
  }>;
  worldBatchAdmissionMetrics?(): Readonly<{
    callers: Readonly<Record<WorldBatchCaller, Readonly<{
      totalWaitMs: number;
    }>>>;
  }>;
}>;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

export class PopulationZoneV3HabitatCompiler {
  private readonly cache = new Map<string, WorldGameplayEnvironmentResult>();
  private readonly probationaryCache =
    new Map<string, WorldGameplayEnvironmentResult>();
  private readonly cacheMetrics = {
    protectedHits: 0,
    probationaryHits: 0,
    promotions: 0,
    protectedEvictions: 0,
    probationaryEvictions: 0
  };
  private readonly inFlight = new Map<
    string,
    Promise<WorldGameplayEnvironmentResult>
  >();
  private readonly activity = new Map<
    PopulationZoneV2Id,
    PopulationZoneV3CompileActivity
  >();

  constructor(
    private readonly world: CompactWorldLookup,
    private readonly options: Readonly<{
      cacheMaximum?: number;
      maximumBatchAttempts?: number;
      retryBaseMs?: number;
      retryBudgetMs?: number;
    }> = {},
    private readonly logger?: Pick<AppLogger, "warn">
      & Partial<Pick<AppLogger, "info">>
  ) {
    const cacheMaximum = options.cacheMaximum ?? DEFAULT_CACHE_MAXIMUM;
    const attempts = options.maximumBatchAttempts
      ?? DEFAULT_MAXIMUM_BATCH_ATTEMPTS;
    if (!Number.isSafeInteger(cacheMaximum) || cacheMaximum < 1) {
      throw new Error("population compact cache maximum must be positive");
    }
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 2) {
      throw new Error("population compact batch attempts must be one or two");
    }
  }

  async prefetchWorldEnvironmentForZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    worldEnvironmentIdentityKey: string;
    priority?: WorldBatchPriority;
    cacheClass?: "protected" | "probationary";
    signal?: AbortSignal;
    onWorldAdmitted?: () => void;
  }>): Promise<PopulationEnvironmentPrefetchDiagnostics> {
    throwIfAborted(input.signal);
    const zoneIds = [...new Set(input.zoneIds)].sort();
    const samples = zoneIds.flatMap((zoneId) =>
      populationZoneV3CompactHabitatSamplePoints({
        zoneId,
        worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
      })
    );
    const uniqueSamples = new Map<string, PopulationZoneV2HabitatSample>();
    for (const sample of samples) {
      const key = sampleKey(sample);
      if (!uniqueSamples.has(key)) uniqueSamples.set(key, sample);
    }
    const ordered = [...uniqueSamples.values()];
    const chunks = chunked(
      ordered,
      WORLD_GAMEPLAY_ENVIRONMENT_BATCH_MAX_POINTS
    );
    const cacheBefore = this.world.gameplayEnvironmentMetrics?.();
    const admissionBefore = this.world.worldBatchAdmissionMetrics?.()
      .callers["population-plan"].totalWaitMs ?? 0;
    let upstreamDurationMs = 0;
    let upstreamAttempts = 0;
    let backpressureRetries = 0;
    for (const chunk of chunks) {
      throwIfAborted(input.signal);
      try {
        const lookup = await this.lookupWithBoundedRetry(
          undefined,
          chunk.map((sample) => sample.position),
          input.signal,
          input.priority,
          input.onWorldAdmitted,
          input.cacheClass
        );
        upstreamDurationMs += lookup.latencyMs;
        upstreamAttempts += lookup.attempts;
        backpressureRetries += lookup.backpressureRetries;
        if (lookup.results.length !== chunk.length) {
          throw new PopulationEnvironmentPrefetchTerminalError(
            "prefetch World batch returned the wrong result count"
          );
        }
        lookup.results.forEach((result, index) => {
          const sample = chunk[index]!;
          try {
            validateCompactResult(
              result,
              sample.position,
              input.worldEnvironmentIdentityKey
            );
          } catch (error) {
            throw new PopulationEnvironmentPrefetchTerminalError(
              "prefetch World batch returned invalid environmental facts",
              { cause: error }
            );
          }
        });
      } catch (error) {
        if (
          error instanceof PopulationEnvironmentPrefetchTerminalError
          || error instanceof WorldReleaseMismatchError
          || (
            error instanceof WorldBatchInvalidResponseError
          )
        ) {
          throw error instanceof PopulationEnvironmentPrefetchTerminalError
            ? error
            : new PopulationEnvironmentPrefetchTerminalError(
                "prefetch World authority or result mapping was invalid",
                { cause: error }
              );
        }
        throw error;
      }
    }
    const cacheAfter = this.world.gameplayEnvironmentMetrics?.();
    const admissionAfter = this.world.worldBatchAdmissionMetrics?.()
      .callers["population-plan"].totalWaitMs ?? admissionBefore;
    const diagnostics: PopulationEnvironmentPrefetchDiagnostics = {
      requestedZoneIds: zoneIds,
      sampleReferences: samples.length,
      uniqueSamples: ordered.length,
      worldCacheHits: Math.max(
        0,
        (cacheAfter?.hits ?? 0) - (cacheBefore?.hits ?? 0)
      ),
      sentPointCount: Math.max(
        0,
        (cacheAfter?.batchPoints ?? ordered.length)
          - (cacheBefore?.batchPoints ?? 0)
      ),
      chunkCount: chunks.length,
      chunkSizes: chunks.map((chunk) => chunk.length),
      upstreamBatchCalls: Math.max(
        0,
        (cacheAfter?.batchUpstreamAttempts ?? upstreamAttempts)
          - (cacheBefore?.batchUpstreamAttempts ?? 0)
      ),
      backpressureRetries,
      admissionWaitMs: boundedDuration(admissionAfter - admissionBefore),
      upstreamDurationMs: boundedDuration(upstreamDurationMs)
    };
    this.logger?.info?.(
      diagnostics,
      "population destination environment prefetch completed"
    );
    return diagnostics;
  }

  async compileZone(input: Readonly<{
    zoneId: PopulationZoneV2Id;
    worldEnvironmentIdentityKey: string;
    regionCode: string;
    signal?: AbortSignal;
    priority?: WorldBatchPriority;
    cacheClass?: "protected" | "probationary";
  }>): Promise<PopulationZoneV2Habitat> {
    const compileStarted = performance.now();
    const samples = populationZoneV3CompactHabitatSamplePoints({
      zoneId: input.zoneId,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
    });
    if (
      samples.length > POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT
      || samples.length > 64
    ) {
      throw new Error("population compact compiler exceeded its sample budget");
    }
    const startedAt = new Date().toISOString();
    this.setActivity(input.zoneId, {
      zoneId: input.zoneId,
      state: "compact-lookup",
      requestedSamples: samples.length,
      uniqueSamples: new Set(samples.map(sampleKey)).size,
      readySamples: 0,
      activeSamples: 0,
      failedSamples: 0,
      cacheHits: 0,
      batchCalls: 0,
      backpressureRetries: 0,
      deduplicatedSamples: 0,
      startedAt,
      lastProgressAt: startedAt,
      completedAt: null,
      batchLatencyMs: 0,
      samplePreparationMs: performance.now() - compileStarted,
      worldLookupMs: 0,
      habitatEstimationMs: 0,
      habitatConstructionMs: 0,
      totalMs: 0,
      lastError: null
    });
    try {
      const worldLookupStarted = performance.now();
      const resolved = await this.resolveSamples(
        input.zoneId,
        samples,
        input.worldEnvironmentIdentityKey,
        input.signal,
        input.priority,
        input.cacheClass
      );
      this.updateActivity(input.zoneId, {
        state: "generating",
        activeSamples: 0,
        readySamples: resolved.size,
        lastProgressAt: new Date().toISOString(),
        worldLookupMs: performance.now() - worldLookupStarted
      });
      const habitatEstimationStarted = performance.now();
      const estimate = await estimatePopulationZoneV2Habitat({
        zoneId: input.zoneId,
        worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
        regionCode: input.regionCode,
        samples,
        sampleVersion: POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION,
        factsForPoint: (sample) => {
          const result = resolved.get(sampleKey(sample));
          return result
            ? compactFacts(result, sample, input.worldEnvironmentIdentityKey)
            : null;
        }
      });
      if (estimate.status !== "ready") {
        throw new Error(
          `compact habitat omitted ${estimate.missingSampleIds.length} samples`
        );
      }
      const habitatEstimationMs = performance.now() - habitatEstimationStarted;
      const habitatConstructionStarted = performance.now();
      const completedAt = new Date().toISOString();
      const metrics = this.activity.get(input.zoneId)!;
      const habitat: PopulationZoneV2Habitat = {
        ...estimate.habitat,
        habitatSummary: {
          ...estimate.habitat.habitatSummary,
          planCompilerVersion: "population-zone-plan-compiler-v3",
          compactEnvironmentContractVersion:
            POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION,
          requestedSamples: metrics.requestedSamples,
          uniqueSamples: metrics.uniqueSamples,
          cacheHits: metrics.cacheHits,
          compactBatchCalls: metrics.batchCalls,
          deduplicatedSamples: metrics.deduplicatedSamples,
          compactBatchLatencyMs: boundedDuration(metrics.batchLatencyMs)
        },
        environmentSnapshot: {
          ...estimate.habitat.environmentSnapshot,
          planCompilerVersion: "population-zone-plan-compiler-v3",
          compactEnvironmentContractVersion:
            POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION
        }
      };
      this.updateActivity(input.zoneId, {
        state: "ready",
        readySamples: samples.length,
        activeSamples: 0,
        failedSamples: 0,
        lastProgressAt: completedAt,
        completedAt,
        habitatEstimationMs,
        habitatConstructionMs: performance.now() - habitatConstructionStarted,
        totalMs: performance.now() - compileStarted,
        lastError: null
      });
      return habitat;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateActivity(input.zoneId, {
        state: "failed",
        activeSamples: 0,
        failedSamples: samples.length,
        lastProgressAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalMs: performance.now() - compileStarted,
        lastError: message
      });
      throw error;
    }
  }

  snapshot(): Readonly<{
    activeLookups: number;
    cacheEntries: number;
    protectedCacheEntries: number;
    probationaryCacheEntries: number;
    cacheMetrics: Readonly<{
      protectedHits: number;
      probationaryHits: number;
      promotions: number;
      protectedEvictions: number;
      probationaryEvictions: number;
    }>;
    inFlightSamples: number;
    zones: readonly PopulationZoneV3CompileActivity[];
  }> {
    return {
      activeLookups: [...this.activity.values()].filter((entry) =>
        entry.state === "compact-lookup"
      ).length,
      cacheEntries: this.cache.size + this.probationaryCache.size,
      protectedCacheEntries: this.cache.size,
      probationaryCacheEntries: this.probationaryCache.size,
      cacheMetrics: { ...this.cacheMetrics },
      inFlightSamples: this.inFlight.size,
      zones: [...this.activity.values()].sort((left, right) =>
        left.zoneId.localeCompare(right.zoneId)
      )
    };
  }

  private async resolveSamples(
    zoneId: PopulationZoneV2Id,
    samples: readonly PopulationZoneV2HabitatSample[],
    worldEnvironmentIdentity: string,
    signal: AbortSignal | undefined,
    priority: WorldBatchPriority | undefined,
    cacheClass: "protected" | "probationary" = "protected"
  ): Promise<Map<string, WorldGameplayEnvironmentResult>> {
    const promises = new Map<string, Promise<WorldGameplayEnvironmentResult>>();
    const owned: Array<Readonly<{
      key: string;
      sample: PopulationZoneV2HabitatSample;
      deferred: Deferred<WorldGameplayEnvironmentResult>;
    }>> = [];
    let cacheHits = 0;
    let deduplicated = samples.length - new Set(samples.map(sampleKey)).size;
    for (const sample of samples) {
      const key = sampleKey(sample);
      if (promises.has(key)) continue;
      const cached = this.getCached(key, cacheClass);
      if (cached) {
        cacheHits += 1;
        promises.set(key, Promise.resolve(cached));
        continue;
      }
      const shared = this.inFlight.get(key);
      if (shared) {
        deduplicated += 1;
        promises.set(key, shared);
        continue;
      }
      const deferred = createDeferred<WorldGameplayEnvironmentResult>();
      this.inFlight.set(key, deferred.promise);
      promises.set(key, deferred.promise);
      owned.push({ key, sample, deferred });
    }
    this.updateActivity(zoneId, {
      cacheHits,
      deduplicatedSamples: deduplicated,
      activeSamples: owned.length,
      readySamples: cacheHits,
      lastProgressAt: new Date().toISOString()
    });
    if (owned.length > 0) {
      void this.resolveOwnedBatch(
        zoneId,
        owned,
        worldEnvironmentIdentity,
        signal,
        priority,
        cacheClass
      ).catch(() => undefined);
    }
    const resolved = new Map<string, WorldGameplayEnvironmentResult>();
    await Promise.all([...promises].map(async ([key, promise]) => {
      resolved.set(key, await promise);
    }));
    return resolved;
  }

  private async resolveOwnedBatch(
    zoneId: PopulationZoneV2Id,
    owned: readonly Readonly<{
      key: string;
      sample: PopulationZoneV2HabitatSample;
      deferred: Deferred<WorldGameplayEnvironmentResult>;
    }>[],
    worldEnvironmentIdentity: string,
    signal: AbortSignal | undefined,
    priority: WorldBatchPriority | undefined,
    cacheClass: "protected" | "probationary"
  ): Promise<void> {
    try {
      const lookup = await this.lookupWithBoundedRetry(
        zoneId,
        owned.map((entry) => entry.sample.position),
        signal,
        priority,
        undefined,
        cacheClass
      );
      const results = lookup.results;
      if (results.length !== owned.length) {
        throw new Error("compact World batch returned the wrong result count");
      }
      results.forEach((result, index) => {
        const entry = owned[index]!;
        validateCompactResult(
          result,
          entry.sample.position,
          worldEnvironmentIdentity
        );
        const cached = this.setCached(entry.key, result, cacheClass);
        entry.deferred.resolve(cached);
      });
      this.updateActivity(zoneId, {
        activeSamples: 0,
        readySamples: this.activity.get(zoneId)!.readySamples + owned.length,
        lastProgressAt: new Date().toISOString()
      });
    } catch (error) {
      for (const entry of owned) entry.deferred.reject(error);
      throw error;
    } finally {
      for (const entry of owned) {
        if (this.inFlight.get(entry.key) === entry.deferred.promise) {
          this.inFlight.delete(entry.key);
        }
      }
    }
  }

  private async lookupWithBoundedRetry(
    zoneId: PopulationZoneV2Id | undefined,
    points: readonly LatLon[],
    signal: AbortSignal | undefined,
    priority: WorldBatchPriority | undefined,
    onAdmitted?: () => void,
    cacheClass: "protected" | "probationary" = "protected"
  ): Promise<Readonly<{
    results: WorldGameplayEnvironmentResult[];
    latencyMs: number;
    backpressureRetries: number;
    attempts: number;
  }>> {
    const attempts = this.options.maximumBatchAttempts
      ?? DEFAULT_MAXIMUM_BATCH_ATTEMPTS;
    const budgetStartedAt = performance.now();
    const retryBudgetMs = this.options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
    let lastError: unknown;
    let latencyMs = 0;
    let backpressureRetries = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = performance.now();
      if (zoneId !== undefined) {
        this.updateActivity(zoneId, {
          batchCalls: this.activity.get(zoneId)!.batchCalls + 1
        });
      }
      try {
        const results = await this.world.lookupGameplayEnvironments(
          points,
          {
            signal,
            caller: "population-plan",
            priority,
            cacheClass,
            ...(onAdmitted ? { onAdmitted } : {})
          }
        );
        const durationMs = performance.now() - started;
        latencyMs += durationMs;
        if (zoneId !== undefined) {
          this.updateActivity(zoneId, {
            batchLatencyMs: this.activity.get(zoneId)!.batchLatencyMs
              + durationMs
          });
        }
        return { results, latencyMs, backpressureRetries, attempts: attempt };
      } catch (error) {
        lastError = error;
        const durationMs = performance.now() - started;
        latencyMs += durationMs;
        if (zoneId !== undefined) {
          this.updateActivity(zoneId, {
            batchLatencyMs: this.activity.get(zoneId)!.batchLatencyMs
              + durationMs,
            lastError: error instanceof Error ? error.message : String(error),
            lastProgressAt: new Date().toISOString()
          });
        }
        if (attempt >= attempts || signal?.aborted) break;
        const exponentialDelayMs =
          (this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) * 2 ** (attempt - 1);
        const jitteredDelayMs = Math.round(
          exponentialDelayMs * (1 + Math.random() * 0.1)
        );
        const retryAfterMs = error instanceof WorldBatchBackpressureError
          ? error.retryAfterMs
          : 0;
        const delayMs = Math.max(jitteredDelayMs, retryAfterMs);
        const elapsedMs = performance.now() - budgetStartedAt;
        if (elapsedMs + delayMs > retryBudgetMs) break;
        if (error instanceof WorldBatchBackpressureError) {
          backpressureRetries += 1;
          if (zoneId !== undefined) {
            this.updateActivity(zoneId, {
              backpressureRetries:
                this.activity.get(zoneId)!.backpressureRetries + 1
            });
          }
        }
        this.logger?.warn({
          err: error,
          zoneId,
          attempt,
          pointCount: points.length,
          retryAfterMs,
          delayMs,
          retryBudgetMs
        }, "bounded population compact batch will retry");
        await delayAbortable(delayMs, signal);
      }
    }
    throw lastError ?? new Error("compact World batch failed");
  }

  private getCached(
    key: string,
    cacheClass: "protected" | "probationary"
  ): WorldGameplayEnvironmentResult | undefined {
    const protectedValue = this.cache.get(key);
    const cached = protectedValue ?? this.probationaryCache.get(key);
    if (!cached) return undefined;
    if (protectedValue) {
      if (cacheClass === "protected") {
        this.cache.delete(key);
        this.cache.set(key, cached);
      }
      this.cacheMetrics.protectedHits += 1;
    } else if (cacheClass === "protected") {
      this.probationaryCache.delete(key);
      this.setCached(key, cached, "protected");
      this.cacheMetrics.promotions += 1;
    } else {
      this.probationaryCache.delete(key);
      this.probationaryCache.set(key, cached);
      this.cacheMetrics.probationaryHits += 1;
    }
    return cached;
  }

  private setCached(
    key: string,
    result: WorldGameplayEnvironmentResult,
    cacheClass: "protected" | "probationary"
  ): WorldGameplayEnvironmentResult {
    if (cacheClass === "probationary" && this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    const target = cacheClass === "protected" ? this.cache : this.probationaryCache;
    const maximum = cacheClass === "protected"
      ? this.options.cacheMaximum ?? DEFAULT_CACHE_MAXIMUM
      : Math.max(1, Math.floor(
          (this.options.cacheMaximum ?? DEFAULT_CACHE_MAXIMUM) / 4
        ));
    this.cache.delete(key);
    this.probationaryCache.delete(key);
    while (target.size >= maximum) {
      const oldest = target.keys().next().value as string | undefined;
      if (!oldest) break;
      target.delete(oldest);
      if (cacheClass === "protected") this.cacheMetrics.protectedEvictions += 1;
      else this.cacheMetrics.probationaryEvictions += 1;
    }
    const immutable = deepFreeze(structuredClone(result));
    target.set(key, immutable);
    return immutable;
  }

  private setActivity(
    zoneId: PopulationZoneV2Id,
    activity: PopulationZoneV3CompileActivity
  ): void {
    this.activity.delete(zoneId);
    while (this.activity.size >= MAXIMUM_ACTIVITY_ENTRIES) {
      const oldest = this.activity.keys().next().value;
      if (!oldest) break;
      this.activity.delete(oldest);
    }
    this.activity.set(zoneId, activity);
  }

  private updateActivity(
    zoneId: PopulationZoneV2Id,
    patch: Partial<PopulationZoneV3CompileActivity>
  ): void {
    const previous = this.activity.get(zoneId);
    if (!previous) return;
    this.activity.set(zoneId, { ...previous, ...patch });
  }
}

function chunked<T>(values: readonly T[], maximum: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += maximum) {
    chunks.push(values.slice(index, index + maximum));
  }
  return chunks;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function compactFacts(
  result: WorldGameplayEnvironmentResult,
  sample: PopulationZoneV2HabitatSample,
  expectedWorldEnvironmentIdentity: string
): PopulationZoneV2HabitatFacts {
  validateCompactResult(
    result,
    sample.position,
    expectedWorldEnvironmentIdentity
  );
  return {
    isLand: result.isLand === true,
    isSaltwater: result.isSaltwater === true,
    isCoastalLand: result.isCoastalLand === true,
    isRiverbank: result.isRiverbank === true,
    isLakeshore: result.isLakeshore === true,
    insideMajorLake: result.insideMajorLake === true,
    waterKind: result.waterKind ?? null,
    surfaceAuthority: compactSurfaceAuthority(result),
    isCoastal: result.isCoastal ?? null,
    elevationBand: result.elevationBand,
    terrainClass: result.terrainClass ?? null,
    landCoverClass: result.landCoverClass ?? null,
    biomeId: result.biomeId ?? null,
    biomeName: result.biomeName,
    ecoregionId: result.ecoregionId ?? null,
    ecoregionName: result.ecoregionName,
    spawnProfileKey: deriveEnvironmentSpawnProfileKey(result),
    sourceCellId: sample.sampleKey ?? sample.sampleId,
    candidateSlotVersion: POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION
  };
}

function compactSurfaceAuthority(
  result: WorldGameplayEnvironmentResult
) {
  const surface = result.waterKind === "river"
    ? result.riverSurface
    : result.waterKind === "lake"
      ? result.lakeSurface
      : result.waterKind === "ocean"
        ? result.oceanCoastSurface
        : null;
  return surface === null || surface === undefined
    ? null
    : {
        releaseId: surface.sourceReleaseId,
        manifestSha256: surface.sourceManifestSha256,
        cellSizeM: surface.cellSizeM,
        rowId: surface.rowId,
        columnId: surface.columnId
      };
}

function validateCompactResult(
  result: WorldGameplayEnvironmentResult,
  point: LatLon,
  expectedWorldEnvironmentIdentity: string
): void {
  if (!result.ok) throw new Error("compact World result was not successful");
  if (result.contractVersion !== "gameplay-environment-v1") {
    throw new Error("compact World result used an unexpected contract version");
  }
  if (result.latitude !== point.lat || result.longitude !== point.lon) {
    throw new Error(
      `compact World result coordinate mismatch: requested `
      + `${point.lat},${point.lon}; received ${result.latitude},${result.longitude}`
    );
  }
  if (
    result.isLand === null
    || result.isSaltwater === null
    || result.isCoastalLand === null
    || result.isRiverbank === null
    || result.isLakeshore === null
    || result.insideMajorLake === null
  ) {
    throw new Error("compact World result lacks authoritative land/water facts");
  }
  if (!result.release) {
    throw new Error("compact World result lacks release identity");
  }
  if (
    worldEnvironmentIdentityKey(result.release)
      !== expectedWorldEnvironmentIdentity
  ) {
    throw new Error("compact World result release identity mismatch");
  }
}

function sampleKey(sample: PopulationZoneV2HabitatSample): string {
  return sample.sampleKey ?? sample.sampleId;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delayAbortable(
  durationMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function boundedDuration(value: number): number {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

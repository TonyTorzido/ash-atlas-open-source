import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { LatLon } from "@ash-atlas/shared";

import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import type { AppLogger } from "../logger.js";
import {
  POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION,
  type PopulationEnvironmentPrefetchDiagnostics,
  type PopulationZoneV3CompileActivity,
  type PopulationZoneV3HabitatCompiler
} from "./populationZoneV3HabitatCompiler.js";
import {
  populationZoneV2Geometry,
  type PopulationZoneV2Id,
  populationZonesV2IntersectingCircle
} from "./populationZonesV2Geometry.js";
import {
  generatePopulationZonesV2Plans,
  type GeneratedPopulationZoneV2Plan,
  type PopulationZoneV2Habitat,
  type PopulationZoneV2PlanGenerationTiming,
  populationZoneV3ConservativeHabitat
} from "./populationZonesV2Plan.js";
import { POPULATION_PLAN_VERSION } from "./populationZonesV2Identity.js";
import {
  populationPlanCompletionFailureDetails,
  populationZoneV2PlanRequest,
  type ClaimedPopulationZoneV2Plan,
  type PopulationPlanFailureCode,
  type PopulationZoneV2PlanRecord,
  type PopulationZoneV2PlanRequest
} from "./populationZonesV2Store.js";
import { packageIdForPosition } from "./spatialZones.js";

const DEFAULT_PLAN_LEASE_MS = 30_000;
const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const DEFAULT_ACTIVE_PREPARATION_CONCURRENCY = 4;
const DEFAULT_BACKGROUND_PREPARATION_CONCURRENCY = 1;
const DEFAULT_BACKGROUND_STARVATION_MS = 30_000;
const DEFAULT_BACKGROUND_FAIRNESS_INTERVAL_MS = 30_000;
const DEFAULT_ZONE_QUEUE_MAX = 128;

export type PopulationPreparationClass =
  | "foreground"
  | "locality"
  | "continuation"
  | "global";

const PREPARATION_CLASSES: readonly PopulationPreparationClass[] = [
  "foreground",
  "locality",
  "continuation",
  "global"
];

export type PopulationZonesV2PlannerStore = Readonly<{
  ensurePlansForZones(
    requests: readonly PopulationZoneV2PlanRequest[]
  ): Promise<PopulationZoneV2PlanRecord[]>;
  claimPlan(
    identity: PopulationZoneV2PlanRequest["identity"],
    ownerId: string,
    leaseMs: number
  ): Promise<ClaimedPopulationZoneV2Plan | null>;
  heartbeatPlan(
    claim: ClaimedPopulationZoneV2Plan,
    leaseMs: number
  ): Promise<boolean>;
  completePlan(
    claim: ClaimedPopulationZoneV2Plan,
    plan: GeneratedPopulationZoneV2Plan
  ): Promise<boolean>;
  failPlan(
    claim: ClaimedPopulationZoneV2Plan,
    error: unknown
  ): Promise<Readonly<{
    accepted: boolean;
    status: "retryable-failure" | "terminal-failure";
    errorCode?: PopulationPlanFailureCode;
  }>>;
  supersedeObsoletePlansForZones?(
    zoneIds: readonly PopulationZoneV2Id[],
    reason: string
  ): Promise<number>;
}>;

export type PopulationZonesV2PrepareResult = Readonly<{
  disabled: boolean;
  readyZoneIds: readonly PopulationZoneV2Id[];
  pendingZoneIds: readonly PopulationZoneV2Id[];
  terminalFailureZoneIds?: readonly PopulationZoneV2Id[];
}>;

export type PopulationZonesV2EnvironmentPrefetchResult = Readonly<{
  disposition: "skipped-ready" | "prefetched";
  requestedZoneIds: readonly PopulationZoneV2Id[];
  readyPlanZoneIds: readonly PopulationZoneV2Id[];
  terminalFailureZoneIds: readonly PopulationZoneV2Id[];
  unresolvedPlanZoneIds: readonly PopulationZoneV2Id[];
  environment: PopulationEnvironmentPrefetchDiagnostics | null;
}>;

type PendingZone = Readonly<{
  zoneId: PopulationZoneV2Id;
  regionCode: string;
  reason: string;
  priority: number;
  workClass: PopulationPreparationClass;
  queuedAtMs: number;
}>;

type PlanClaimHeartbeat = Readonly<{
  claim: ClaimedPopulationZoneV2Plan;
  owned(): boolean;
  stop(): Promise<void>;
}>;

type EnvironmentPrefetchFlight = {
  controller: AbortController;
  admitted: boolean;
  waiters: number;
  settled: boolean;
  priority: number;
  workClass: PopulationPreparationClass;
  zoneIds: readonly PopulationZoneV2Id[];
  promise: Promise<PopulationEnvironmentPrefetchDiagnostics>;
};

export type PopulationZoneV2PreparationActivity = Readonly<{
  zoneId: PopulationZoneV2Id;
  state: "queued" | "preparing";
  priority: number;
  startedAt: string | null;
  planAlgorithmVersion: string;
  requiredSamples: number | null;
  readySamples: number;
  activeSamples: number;
  failedSamples: number;
  compactBatchCalls: number;
  cacheHits: number;
  deduplicatedSamples: number;
  lastProgressAt: string | null;
  lastError: string | null;
}>;

export class PopulationZonesV2Planner {
  private readonly ownerId = randomUUID();
  private readonly pendingZones = new Map<PopulationZoneV2Id, PendingZone>();
  private readonly inFlightByZone = new Map<PopulationZoneV2Id, Promise<void>>();
  private readonly queuedCompletionByZone = new Map<
    PopulationZoneV2Id,
    () => void
  >();
  private readonly activePreparationWork = new Set<Promise<void>>();
  private readonly environmentPrefetchFlights = new Map<
    string,
    EnvironmentPrefetchFlight
  >();
  private readonly preparationQueue: PendingZone[] = [];
  private readonly readyListeners = new Set<
    (zoneId: PopulationZoneV2Id) => void | Promise<void>
  >();
  private readonly failureListeners = new Set<
    (
      zoneId: PopulationZoneV2Id,
      outcome: "terminal-failure" | "cancelled"
    ) => void | Promise<void>
  >();
  private readonly terminalFailureNotifications =
    new Set<PopulationZoneV2Id>();
  private readonly preparationActivity = new Map<
    PopulationZoneV2Id,
    PopulationZoneV2PreparationActivity
  >();
  private activeZonePreparations = 0;
  private activeBackgroundPreparations = 0;
  private localityAdmissionsSinceNonlocal = 0;
  private lastGlobalAdmissionAtMs = 0;
  private readonly classMetrics = new Map<PopulationPreparationClass, {
    prefetchRequested: number;
    prefetchReady: number;
    requested: number;
    enqueued: number;
    admitted: number;
    readyOnRequest: number;
    promotions: number;
  }>(PREPARATION_CLASSES.map(
    (workClass) => [workClass, {
      prefetchRequested: 0,
      prefetchReady: 0,
      requested: 0,
      enqueued: 0,
      admitted: 0,
      readyOnRequest: 0,
      promotions: 0
    }]
  ));
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private closed = false;

  constructor(
    private readonly store: PopulationZonesV2PlannerStore,
    private readonly compiler: Pick<
      PopulationZoneV3HabitatCompiler,
      "compileZone" | "snapshot"
    > & Partial<Pick<
      PopulationZoneV3HabitatCompiler,
      "prefetchWorldEnvironmentForZones"
    >>,
    private readonly configuration: Readonly<{
      worldEnvironmentIdentityKey: string;
      worldPipelineSha: string;
      planLeaseMs?: number;
      retryMs?: number;
      retryMaxMs?: number;
      activePreparationConcurrency?: number;
      backgroundPreparationConcurrency?: number;
      backgroundStarvationMs?: number;
      backgroundFairnessIntervalMs?: number;
      zoneQueueMax?: number;
      generatePlans?(input: Readonly<{
        outputZoneIds: readonly PopulationZoneV2Id[];
        worldEnvironmentIdentityKey: string;
        worldPipelineSha: string;
        environmentProfileVersion: string;
        habitatForZone(zoneId: PopulationZoneV2Id): PopulationZoneV2Habitat;
        captureTiming?(timing: PopulationZoneV2PlanGenerationTiming): void;
      }>): GeneratedPopulationZoneV2Plan[];
    }>,
    private readonly logger?: Pick<AppLogger, "warn">
      & Partial<Pick<AppLogger, "info">>
  ) {
    assertConfiguration(configuration);
  }

  async prefetchEnvironmentForZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    regionCode: string;
    reason: string;
    priority?: number;
    workClass?: PopulationPreparationClass;
    signal?: AbortSignal;
  }>): Promise<PopulationZonesV2EnvironmentPrefetchResult> {
    if (this.closed) throw new Error("population v2 planner is closed");
    throwIfAborted(input.signal);
    const requestedZoneIds = [...new Set(input.zoneIds)].sort();
    const priority = input.priority ?? 2;
    assertPriority(priority);
    const workClass = input.workClass ?? workClassFor(priority, input.reason);
    const requests = requestedZoneIds.map((zoneId) =>
      populationZoneV2PlanRequest({
        zoneId,
        worldEnvironmentIdentityKey:
          this.configuration.worldEnvironmentIdentityKey,
        worldPipelineSha: this.configuration.worldPipelineSha,
        environmentProfileVersion:
          POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION,
        regionCode: populationZoneV2CanonicalRegionCode(zoneId)
      })
    );
    const records = requests.length === 0
      ? []
      : await this.store.ensurePlansForZones(requests);
    throwIfAborted(input.signal);
    const readyPlanZoneIds = records
      .filter((record) => record.status === "ready")
      .map((record) => record.identity.zoneId as PopulationZoneV2Id)
      .sort();
    const terminalFailureZoneIds = records
      .filter((record) => record.status === "terminal-failure")
      .map((record) => record.identity.zoneId as PopulationZoneV2Id)
      .sort();
    const unresolvedPlanZoneIds = records
      .filter((record) =>
        record.status !== "ready" && record.status !== "terminal-failure"
      )
      .map((record) => record.identity.zoneId as PopulationZoneV2Id)
      .sort();
    const prefetchMetrics = this.classMetrics.get(workClass)!;
    prefetchMetrics.prefetchRequested += records.length;
    prefetchMetrics.prefetchReady += readyPlanZoneIds.length;
    if (
      unresolvedPlanZoneIds.length > 0
      && !this.compiler.prefetchWorldEnvironmentForZones
    ) {
      throw new Error("population environment prefetch is unavailable");
    }
    const environment = unresolvedPlanZoneIds.length === 0
      ? null
      : await this.joinEnvironmentPrefetch({
          zoneIds: unresolvedPlanZoneIds,
          priority,
          workClass,
          ...(input.signal ? { signal: input.signal } : {})
        });
    const result: PopulationZonesV2EnvironmentPrefetchResult = {
      disposition: environment ? "prefetched" : "skipped-ready",
      requestedZoneIds,
      readyPlanZoneIds,
      terminalFailureZoneIds,
      unresolvedPlanZoneIds,
      environment
    };
    this.logger?.info?.({
      trigger: input.reason,
      regionCode: input.regionCode,
      priority,
      requestedZoneIds,
      readyPlanZoneCount: readyPlanZoneIds.length,
      terminalFailureZoneCount: terminalFailureZoneIds.length,
      unresolvedPlanZoneCount: unresolvedPlanZoneIds.length,
      sampleReferenceCount: environment?.sampleReferences ?? 0,
      uniqueSampleCount: environment?.uniqueSamples ?? 0,
      worldCacheHits: environment?.worldCacheHits ?? 0,
      sentPointCount: environment?.sentPointCount ?? 0,
      chunkCount: environment?.chunkCount ?? 0,
      chunkSizes: environment?.chunkSizes ?? [],
      admissionWaitMs: environment?.admissionWaitMs ?? 0,
      upstreamDurationMs: environment?.upstreamDurationMs ?? 0,
      disposition: result.disposition
    }, "population destination environment prefetch resolved plans");
    return result;
  }

  onPlanReady(
    listener: (zoneId: PopulationZoneV2Id) => void | Promise<void>
  ): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  onPlanFailed(
    listener: (
      zoneId: PopulationZoneV2Id,
      outcome: "terminal-failure" | "cancelled"
    ) => void | Promise<void>
  ): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async ensureZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    regionCode: string;
    reason: string;
    priority?: number;
    workClass?: PopulationPreparationClass;
  }>): Promise<PopulationZonesV2PrepareResult> {
    if (this.closed) return emptyPrepareResult(true);
    const requestedZoneIds = [...new Set(input.zoneIds)].sort();
    if (requestedZoneIds.length === 0) return emptyPrepareResult(false);
    const priority = input.priority ?? 2;
    assertPriority(priority);
    const workClass = input.workClass ?? workClassFor(priority, input.reason);
    const reason = input.reason.startsWith("population-v2:")
      ? input.reason
      : `population-v2:${input.reason}`;
    for (const zoneId of requestedZoneIds) {
      const pending = this.recordPendingZone({
        zoneId,
        regionCode: populationZoneV2CanonicalRegionCode(zoneId),
        reason,
        priority,
        workClass,
        queuedAtMs: Date.now()
      });
      this.promoteQueuedZone(pending);
    }
    const existing = uniquePromises(requestedZoneIds.map((zoneId) =>
      this.inFlightByZone.get(zoneId)
    ));
    if (existing.length > 0) await Promise.allSettled(existing);
    const freshZoneIds = requestedZoneIds.filter((zoneId) =>
      !this.inFlightByZone.has(zoneId)
    );
    if (freshZoneIds.length > 0) {
      const task = this.prepareBatch(freshZoneIds).then(
        () => undefined
      ).finally(() => {
        for (const zoneId of freshZoneIds) {
          if (this.inFlightByZone.get(zoneId) === task) {
            this.inFlightByZone.delete(zoneId);
          }
        }
      });
      for (const zoneId of freshZoneIds) this.inFlightByZone.set(zoneId, task);
      await task;
    }
    return this.resultForZones(requestedZoneIds);
  }

  async scheduleZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    regionCode: string;
    reason: string;
    priority?: number;
    workClass?: PopulationPreparationClass;
    signal?: AbortSignal;
  }>): Promise<PopulationZonesV2PrepareResult> {
    if (this.closed) return emptyPrepareResult(true);
    if (input.signal?.aborted) return emptyPrepareResult(false);
    const requestedZoneIds = [...new Set(input.zoneIds)].sort();
    if (requestedZoneIds.length === 0) return emptyPrepareResult(false);
    const priority = input.priority ?? 2;
    assertPriority(priority);
    const workClass = input.workClass ?? workClassFor(priority, input.reason);
    const reason = input.reason.startsWith("population-v2:")
      ? input.reason
      : `population-v2:${input.reason}`;
    await this.store.supersedeObsoletePlansForZones?.(
      requestedZoneIds,
      `superseded by ${POPULATION_PLAN_VERSION}`
    );
    if (input.signal?.aborted) return emptyPrepareResult(false);
    const records = await this.store.ensurePlansForZones(requestedZoneIds.map(
      (zoneId) => populationZoneV2PlanRequest({
        zoneId,
        worldEnvironmentIdentityKey: this.configuration.worldEnvironmentIdentityKey,
        worldPipelineSha: this.configuration.worldPipelineSha,
        environmentProfileVersion:
          POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION,
        regionCode: populationZoneV2CanonicalRegionCode(zoneId)
      })
    ));
    if (input.signal?.aborted) return emptyPrepareResult(false);
    this.classMetrics.get(workClass)!.requested += records.length;
    for (const record of records) {
      const zoneId = record.identity.zoneId as PopulationZoneV2Id;
      if (record.status === "ready") {
        this.classMetrics.get(workClass)!.readyOnRequest += 1;
        this.markReady(zoneId, record.planId, false);
      } else if (record.status === "terminal-failure") {
        this.markFailed(zoneId, "terminal-failure");
      } else {
        const pending = this.recordPendingZone({
          zoneId,
          regionCode: populationZoneV2CanonicalRegionCode(zoneId),
          reason,
          priority,
          workClass,
          queuedAtMs: Date.now()
        });
        this.enqueueZone(pending);
      }
    }
    this.drainPreparationQueue();
    return this.resultForZones(requestedZoneIds);
  }

  async scheduleZonesAndWait(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    regionCode: string;
    reason: string;
    priority?: number;
    workClass?: PopulationPreparationClass;
    signal?: AbortSignal;
  }>): Promise<PopulationZonesV2PrepareResult> {
    let result = await this.scheduleZones(input);
    if (result.disabled) return result;
    const requestedZoneIds = [
      ...result.readyZoneIds,
      ...result.pendingZoneIds,
      ...(result.terminalFailureZoneIds ?? [])
    ];
    while (
      !this.closed &&
      !input.signal?.aborted &&
      result.pendingZoneIds.length > 0
    ) {
      const active = uniquePromises(result.pendingZoneIds.map((zoneId) =>
        this.inFlightByZone.get(zoneId)
      ));
      if (active.length === 0) {
        await waitForPlannerProgress([], input.signal);
      } else {
        await waitForPlannerProgress(active, input.signal);
      }
      if (input.signal?.aborted) break;
      result = this.resultForZones(requestedZoneIds);
      if (
        result.pendingZoneIds.length > 0 &&
        result.pendingZoneIds.every((zoneId) => !this.inFlightByZone.has(zoneId))
      ) {
        result = await this.scheduleZones(input);
      }
    }
    return result;
  }

  ensureCircle(input: Readonly<{
    center: LatLon;
    radiusM: number;
    regionCode: string;
    reason: string;
    priority?: number;
    workClass?: PopulationPreparationClass;
  }>): Promise<PopulationZonesV2PrepareResult> {
    return this.scheduleZones({
      zoneIds: populationZonesV2IntersectingCircle(input.center, input.radiusM),
      regionCode: input.regionCode,
      reason: input.reason,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.workClass === undefined ? {} : { workClass: input.workClass })
    });
  }

  cancelQueuedZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    workClass: Exclude<PopulationPreparationClass, "foreground">;
  }>): number {
    let cancelled = 0;
    for (const zoneId of new Set(input.zoneIds)) {
      const queued = this.preparationQueue.find((entry) =>
        entry.zoneId === zoneId
      );
      if (!queued || queued.workClass !== input.workClass) continue;
      if (!this.releaseQueuedZone(zoneId)) continue;
      this.pendingZones.delete(zoneId);
      cancelled += 1;
    }
    return cancelled;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const zoneId of this.pendingZones.keys()) {
      this.emitFailure(zoneId, "cancelled");
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const complete of this.queuedCompletionByZone.values()) complete();
    this.queuedCompletionByZone.clear();
    for (const flight of this.environmentPrefetchFlights.values()) {
      flight.controller.abort(new DOMException(
        "Population planner closed",
        "AbortError"
      ));
    }
    this.environmentPrefetchFlights.clear();
    await Promise.allSettled(uniquePromises(this.inFlightByZone.values()));
    await Promise.allSettled(this.activePreparationWork);
    this.preparationQueue.length = 0;
    this.pendingZones.clear();
    this.preparationActivity.clear();
    this.readyListeners.clear();
    this.failureListeners.clear();
    this.terminalFailureNotifications.clear();
  }

  snapshot(): Readonly<{
    pendingZones: number;
    queuedZones: number;
    activeZonePreparations: number;
    activeBackgroundPreparations: number;
    compactLookupActive: number;
    compactSamplesInFlight: number;
    compactCacheEntries: number;
    zoneQueueLimit: number;
    zonePreparationConcurrency: number;
    backgroundPreparationConcurrency: number;
    workClasses: Readonly<Record<PopulationPreparationClass, Readonly<{
      queued: number;
      active: number;
      prefetchRequested: number;
      prefetchReady: number;
      requested: number;
      enqueued: number;
      admitted: number;
      readyOnRequest: number;
      promotions: number;
    }>>>;
    zones: readonly PopulationZoneV2PreparationActivity[];
  }> {
    const compiler = this.compiler.snapshot();
    const compileByZone = new Map(compiler.zones.map((entry) => [
      entry.zoneId,
      entry
    ]));
    return {
      pendingZones: this.pendingZones.size,
      queuedZones: this.preparationQueue.length,
      activeZonePreparations: this.activeZonePreparations,
      activeBackgroundPreparations: this.activeBackgroundPreparations,
      compactLookupActive: compiler.activeLookups,
      compactSamplesInFlight: compiler.inFlightSamples,
      compactCacheEntries: compiler.cacheEntries,
      zoneQueueLimit: this.configuration.zoneQueueMax ?? DEFAULT_ZONE_QUEUE_MAX,
      zonePreparationConcurrency: this.configuration.activePreparationConcurrency
        ?? DEFAULT_ACTIVE_PREPARATION_CONCURRENCY,
      backgroundPreparationConcurrency:
        this.configuration.backgroundPreparationConcurrency
        ?? DEFAULT_BACKGROUND_PREPARATION_CONCURRENCY,
      workClasses: Object.fromEntries(PREPARATION_CLASSES.map((workClass) => {
        const metrics = this.classMetrics.get(workClass)!;
        return [workClass, {
          queued: this.preparationQueue.filter((entry) =>
            entry.workClass === workClass).length,
          active: [...this.preparationActivity.values()].filter((entry) =>
            entry.state === "preparing"
            && this.pendingZones.get(entry.zoneId)?.workClass === workClass
          ).length,
          ...metrics
        }];
      })) as Record<PopulationPreparationClass, {
        queued: number;
        active: number;
        prefetchRequested: number;
        prefetchReady: number;
        requested: number;
        enqueued: number;
        admitted: number;
        readyOnRequest: number;
        promotions: number;
      }>,
      zones: [...this.preparationActivity.values()].map((entry) =>
        preparationWithCompileActivity(entry, compileByZone.get(entry.zoneId))
      ).sort((left, right) => left.priority - right.priority
        || left.zoneId.localeCompare(right.zoneId))
    };
  }

  private resultForZones(
    zoneIds: readonly PopulationZoneV2Id[]
  ): PopulationZonesV2PrepareResult {
    const unique = [...new Set(zoneIds)].sort();
    const terminalFailureZoneIds = unique.filter((zoneId) =>
      this.terminalFailureNotifications.has(zoneId)
    );
    const result = {
      disabled: false,
      readyZoneIds: unique.filter((zoneId) =>
        !this.pendingZones.has(zoneId)
        && !this.terminalFailureNotifications.has(zoneId)
      ),
      pendingZoneIds: unique.filter((zoneId) => this.pendingZones.has(zoneId))
    };
    return terminalFailureZoneIds.length === 0
      ? result
      : { ...result, terminalFailureZoneIds };
  }

  private enqueueZone(entry: PendingZone): void {
    if (this.promoteQueuedZone(entry) || this.inFlightByZone.has(entry.zoneId)) return;
    const queueMax = this.configuration.zoneQueueMax ?? DEFAULT_ZONE_QUEUE_MAX;
    if (this.preparationQueue.length >= queueMax) {
      const worst = this.preparationQueue.at(-1);
      if (!worst || comparePendingZones(entry, worst) >= 0) {
        this.schedulePendingRetry();
        return;
      }
      this.releaseQueuedZone(worst.zoneId);
      this.schedulePendingRetry();
    }
    this.preparationQueue.push(entry);
    this.classMetrics.get(entry.workClass)!.enqueued += 1;
    this.preparationActivity.set(entry.zoneId, {
      zoneId: entry.zoneId,
      state: "queued",
      priority: entry.priority,
      startedAt: null,
      planAlgorithmVersion: POPULATION_PLAN_VERSION,
      requiredSamples: null,
      readySamples: 0,
      activeSamples: 0,
      failedSamples: 0,
      compactBatchCalls: 0,
      cacheHits: 0,
      deduplicatedSamples: 0,
      lastProgressAt: null,
      lastError: null
    });
    let complete!: () => void;
    const task = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.queuedCompletionByZone.set(entry.zoneId, complete);
    this.inFlightByZone.set(entry.zoneId, task);
    this.preparationQueue.sort(comparePendingZones);
  }

  private recordPendingZone(entry: PendingZone): PendingZone {
    const existing = this.pendingZones.get(entry.zoneId);
    const preferred = !existing || comparePendingZones(entry, existing) < 0
      ? entry
      : existing;
    this.pendingZones.set(entry.zoneId, preferred);
    const activity = this.preparationActivity.get(entry.zoneId);
    if (activity && preferred.priority < activity.priority) {
      this.preparationActivity.set(entry.zoneId, {
        ...activity,
        priority: preferred.priority
      });
    }
    return preferred;
  }

  private promoteQueuedZone(entry: PendingZone): boolean {
    const index = this.preparationQueue.findIndex((queued) =>
      queued.zoneId === entry.zoneId
    );
    if (index < 0) return false;
    const queued = this.preparationQueue[index]!;
    if (comparePendingZones(entry, queued) < 0) {
      if (entry.workClass !== queued.workClass) {
        this.classMetrics.get(entry.workClass)!.promotions += 1;
      }
      this.preparationQueue[index] = {
        ...entry,
        queuedAtMs: queued.queuedAtMs
      };
      const activity = this.preparationActivity.get(entry.zoneId);
      if (activity) {
        this.preparationActivity.set(entry.zoneId, {
          ...activity,
          priority: entry.priority
        });
      }
      this.preparationQueue.sort(comparePendingZones);
    }
    return true;
  }

  private releaseQueuedZone(zoneId: PopulationZoneV2Id): boolean {
    const index = this.preparationQueue.findIndex((entry) => entry.zoneId === zoneId);
    if (index < 0) return false;
    this.preparationQueue.splice(index, 1);
    const complete = this.queuedCompletionByZone.get(zoneId);
    this.queuedCompletionByZone.delete(zoneId);
    this.inFlightByZone.delete(zoneId);
    this.preparationActivity.delete(zoneId);
    complete?.();
    return true;
  }

  private drainPreparationQueue(): void {
    const concurrency = this.configuration.activePreparationConcurrency
      ?? DEFAULT_ACTIVE_PREPARATION_CONCURRENCY;
    while (
      !this.closed
      && this.activeZonePreparations < concurrency
      && this.preparationQueue.length > 0
    ) {
      const entry = this.takeNextQueuedZone();
      if (!entry) break;
      if (!this.pendingZones.has(entry.zoneId)) {
        const complete = this.queuedCompletionByZone.get(entry.zoneId);
        this.queuedCompletionByZone.delete(entry.zoneId);
        this.inFlightByZone.delete(entry.zoneId);
        this.preparationActivity.delete(entry.zoneId);
        complete?.();
        continue;
      }
      const background = entry.workClass !== "foreground";
      this.activeZonePreparations += 1;
      if (background) this.activeBackgroundPreparations += 1;
      this.classMetrics.get(entry.workClass)!.admitted += 1;
      const work = this.prepareUntilReady(entry)
        .catch((error: unknown) => {
          this.updatePreparationError(entry.zoneId, error);
          this.logger?.warn(
            { err: error, zoneId: entry.zoneId },
            "population v2 background preparation failed"
          );
        })
        .finally(() => {
          this.activeZonePreparations -= 1;
          if (background) this.activeBackgroundPreparations -= 1;
          const complete = this.queuedCompletionByZone.get(entry.zoneId);
          this.activePreparationWork.delete(work);
          this.queuedCompletionByZone.delete(entry.zoneId);
          this.inFlightByZone.delete(entry.zoneId);
          if (!this.pendingZones.has(entry.zoneId)) {
            this.preparationActivity.delete(entry.zoneId);
          }
          complete?.();
          this.drainPreparationQueue();
        });
      this.activePreparationWork.add(work);
    }
  }

  private joinEnvironmentPrefetch(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    priority: number;
    workClass: PopulationPreparationClass;
    signal?: AbortSignal;
  }>): Promise<PopulationEnvironmentPrefetchDiagnostics> {
    throwIfAborted(input.signal);
    const key = input.zoneIds.join("|");
    let flight = this.environmentPrefetchFlights.get(key);
    if (
      flight
      && isMoreUrgent(input.priority, input.workClass, flight.priority, flight.workClass)
      && !flight.admitted
    ) {
      this.environmentPrefetchFlights.delete(key);
      flight.controller.abort(new DOMException(
        "Population destination prefetch was promoted",
        "AbortError"
      ));
      flight = undefined;
    }
    if (!flight) {
      const controller = new AbortController();
      const created: EnvironmentPrefetchFlight = {
        controller,
        admitted: false,
        waiters: 0,
        settled: false,
        priority: input.priority,
        workClass: input.workClass,
        zoneIds: input.zoneIds,
        promise: Promise.resolve(null as never)
      };
      created.promise = this.compiler.prefetchWorldEnvironmentForZones!({
        zoneIds: input.zoneIds,
        worldEnvironmentIdentityKey:
          this.configuration.worldEnvironmentIdentityKey,
        priority: normalizeWorldBatchPriority(input.priority),
        cacheClass: cacheClassFor(input.workClass),
        signal: controller.signal,
        onWorldAdmitted: () => {
          created.admitted = true;
        }
      });
      flight = created;
      this.environmentPrefetchFlights.set(key, flight);
      void flight.promise.then(() => {
        if (
          flight!.admitted
          && flight!.waiters === 0
          && flight!.workClass !== "locality"
          && !this.closed
        ) {
          void this.scheduleZones({
            zoneIds: flight!.zoneIds,
            regionCode: "background",
            reason: "cancelled-travel-continuation",
            priority: 3,
            workClass: "continuation"
          }).catch((error: unknown) => {
            this.logger?.warn(
              { err: error, zoneIds: flight!.zoneIds },
              "cancelled population destination could not continue warming"
            );
          });
        }
      }, () => undefined).finally(() => {
        flight!.settled = true;
        if (this.environmentPrefetchFlights.get(key) === flight) {
          this.environmentPrefetchFlights.delete(key);
        }
      });
    }
    return subscribeToEnvironmentPrefetch(flight, input.signal);
  }

  private takeNextQueuedZone(): PendingZone | null {
    const foregroundIndex = this.preparationQueue.findIndex((entry) =>
      entry.workClass === "foreground"
    );
    if (foregroundIndex >= 0) {
      return this.preparationQueue.splice(foregroundIndex, 1)[0]!;
    }
    const backgroundConcurrency =
      this.configuration.backgroundPreparationConcurrency
      ?? DEFAULT_BACKGROUND_PREPARATION_CONCURRENCY;
    if (this.activeBackgroundPreparations >= backgroundConcurrency) return null;
    const localityIndex = this.preparationQueue.findIndex((entry) =>
      entry.workClass === "locality");
    const continuationIndex = this.preparationQueue.findIndex((entry) =>
      entry.workClass === "continuation");
    const globalIndex = this.preparationQueue.findIndex((entry) =>
      entry.workClass === "global");
    const now = Date.now();
    const global = globalIndex < 0 ? null : this.preparationQueue[globalIndex]!;
    const globalStarved = global !== null
      && now - global.queuedAtMs >= (this.configuration.backgroundStarvationMs
        ?? DEFAULT_BACKGROUND_STARVATION_MS)
      && (
        this.lastGlobalAdmissionAtMs === 0
        || now - this.lastGlobalAdmissionAtMs >=
          (this.configuration.backgroundFairnessIntervalMs
            ?? DEFAULT_BACKGROUND_FAIRNESS_INTERVAL_MS)
      );
    if (
      localityIndex >= 0
      && this.localityAdmissionsSinceNonlocal < 3
      && !globalStarved
    ) {
      this.localityAdmissionsSinceNonlocal += 1;
      return this.preparationQueue.splice(localityIndex, 1)[0]!;
    }
    const nonlocalIndex = globalStarved
      ? globalIndex
      : continuationIndex >= 0 ? continuationIndex : globalIndex;
    if (nonlocalIndex >= 0) {
      if (nonlocalIndex === globalIndex) this.lastGlobalAdmissionAtMs = now;
      this.localityAdmissionsSinceNonlocal = 0;
      return this.preparationQueue.splice(nonlocalIndex, 1)[0]!;
    }
    if (localityIndex >= 0) {
      this.localityAdmissionsSinceNonlocal = Math.min(
        3,
        this.localityAdmissionsSinceNonlocal + 1
      );
      return this.preparationQueue.splice(localityIndex, 1)[0]!;
    }
    return null;
  }

  private async prepareUntilReady(entry: PendingZone): Promise<void> {
    const current = this.pendingZones.get(entry.zoneId) ?? entry;
    this.preparationActivity.set(entry.zoneId, {
      zoneId: entry.zoneId,
      state: "preparing",
      priority: current.priority,
      startedAt: new Date().toISOString(),
      planAlgorithmVersion: POPULATION_PLAN_VERSION,
      requiredSamples: null,
      readySamples: 0,
      activeSamples: 0,
      failedSamples: 0,
      compactBatchCalls: 0,
      cacheHits: 0,
      deduplicatedSamples: 0,
      lastProgressAt: new Date().toISOString(),
      lastError: null
    });
    const complete = await this.prepareBatch([entry.zoneId]);
    if (!complete && this.pendingZones.has(entry.zoneId)) {
      this.schedulePendingRetry();
    }
  }

  private async prepareBatch(
    zoneIds: readonly PopulationZoneV2Id[]
  ): Promise<boolean> {
    const pending = zoneIds.map((zoneId) => this.pendingZones.get(zoneId))
      .filter((entry): entry is PendingZone => entry !== undefined);
    if (pending.length === 0 || this.closed) return true;
    await this.store.supersedeObsoletePlansForZones?.(
      pending.map((entry) => entry.zoneId),
      `superseded by ${POPULATION_PLAN_VERSION}`
    );
    const lookupStarted = performance.now();
    const requests = pending.map((entry) => populationZoneV2PlanRequest({
      zoneId: entry.zoneId,
      worldEnvironmentIdentityKey: this.configuration.worldEnvironmentIdentityKey,
      worldPipelineSha: this.configuration.worldPipelineSha,
      environmentProfileVersion:
        POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION,
      regionCode: entry.regionCode
    }));
    const records = await this.store.ensurePlansForZones(requests);
    const databaseMs = performance.now() - lookupStarted;
    const requestByPlanId = new Map(requests.map((request) => [
      request.planId,
      request
    ]));
    for (const record of records) {
      gameplayLatencyTrace.recordActive({
        traceId: record.planId,
        source: "game",
        category: "population",
        name: "population_zone_plan_lookup",
        details: {
          zoneId: record.identity.zoneId,
          status: record.status,
          databaseMs: boundedDuration(databaseMs),
          worldCalled: false
        }
      });
      if (record.status === "ready") {
        this.markReady(
          record.identity.zoneId as PopulationZoneV2Id,
          record.planId,
          false
        );
      } else if (record.status === "terminal-failure") {
        this.markFailed(
          record.identity.zoneId as PopulationZoneV2Id,
          "terminal-failure"
        );
      }
    }
    const unresolved = records.filter((record) =>
      record.status !== "ready" && record.status !== "terminal-failure"
    );
    if (unresolved.length === 0 || this.closed) return true;
    for (const record of unresolved) {
      const request = requestByPlanId.get(record.planId);
      if (!request) continue;
      const claim = await this.store.claimPlan(
        request.identity,
        this.ownerId,
        this.configuration.planLeaseMs ?? DEFAULT_PLAN_LEASE_MS
      );
      if (!claim) continue;
      const heartbeat = this.startPlanClaimHeartbeat(claim);
      const zoneId = claim.identity.zoneId as PopulationZoneV2Id;
      const compilationStarted = performance.now();
      try {
        const pendingZone = this.pendingZones.get(zoneId);
        const habitat = await this.compiler.compileZone({
          zoneId,
          worldEnvironmentIdentityKey:
            this.configuration.worldEnvironmentIdentityKey,
          regionCode: populationZoneV2CanonicalRegionCode(zoneId),
          priority: normalizeWorldBatchPriority(
            pendingZone?.priority ?? 3
          ),
          cacheClass: cacheClassFor(pendingZone?.workClass ?? "global")
        });
        const compileActivity = this.compiler.snapshot().zones.find((activity) =>
          activity.zoneId === zoneId
        );
        let planTiming: PopulationZoneV2PlanGenerationTiming | undefined;
        const plans = (
          this.configuration.generatePlans ?? generatePopulationZonesV2Plans
        )({
          outputZoneIds: [zoneId],
          worldEnvironmentIdentityKey:
            this.configuration.worldEnvironmentIdentityKey,
          worldPipelineSha: this.configuration.worldPipelineSha,
          environmentProfileVersion:
            POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION,
          habitatForZone: (requestedZoneId) =>
            requestedZoneId === zoneId
              ? habitat
              : populationZoneV3ConservativeHabitat({
                zoneId: requestedZoneId,
                worldEnvironmentIdentityKey:
                  this.configuration.worldEnvironmentIdentityKey
              }),
          captureTiming: (timing) => {
            planTiming = timing;
          }
        });
        const plan = plans.find((candidate) =>
          candidate.planId === claim.planId
        );
        if (!heartbeat.owned()) {
          this.schedulePendingRetry();
          continue;
        }
        if (!plan) {
          const failed = await this.store.failPlan(
            claim,
            new Error("population generator omitted a claimed plan")
          );
          if (failed.accepted && failed.status === "terminal-failure") {
            this.markFailed(zoneId, "terminal-failure");
          }
          continue;
        }
        if (plan.sapCrawlerDiagnostics !== undefined) {
          const diagnostics = plan.sapCrawlerDiagnostics;
          const details = {
            zoneId,
            planId: plan.planId,
            allocatedCandidates: diagnostics.allocatedCandidates,
            successfullyPlannedGroupCount: diagnostics.finalPlannedGroups,
            plannedMemberCount: diagnostics.finalPlannedMembers,
            noEligibleClusterCandidates:
              diagnostics.noEligibleClusterCandidates,
            insufficientValidSiteCandidates:
              diagnostics.insufficientValidSiteCandidates,
            conflictRejectedCandidates:
              diagnostics.conflictRejectedCandidates,
            placementShortfallGroups:
              diagnostics.placementShortfallGroups
          };
          if (
            diagnostics.noEligibleClusterCandidates > 0
            || diagnostics.insufficientValidSiteCandidates > 0
          ) {
            this.logger?.warn(
              details,
              "Resin Crawler population plan has insufficient valid placement"
            );
          }
        }
        const durableWriteStarted = performance.now();
        const completed = await this.store.completePlan(claim, plan);
        const durableWriteMs = performance.now() - durableWriteStarted;
        gameplayLatencyTrace.recordActive({
          traceId: claim.planId,
          source: "game",
          category: "population",
          name: "population_zone_plan_compile_breakdown",
          details: {
            zoneId,
            status: completed ? "ready" : "claim-lost",
            samplePreparationMs: boundedDuration(
              compileActivity?.samplePreparationMs ?? 0
            ),
            worldLookupMs: boundedDuration(
              compileActivity?.worldLookupMs ?? 0
            ),
            habitatEstimationMs: boundedDuration(
              compileActivity?.habitatEstimationMs ?? 0
            ),
            habitatConstructionMs: boundedDuration(
              compileActivity?.habitatConstructionMs ?? 0
            ),
            candidateProcessingMs: boundedDuration(
              planTiming?.candidateProcessingMs ?? 0
            ),
            deterministicSelectionMs: boundedDuration(
              planTiming?.deterministicSelectionMs ?? 0
            ),
            serializationConstructionMs: boundedDuration(
              planTiming?.serializationConstructionMs ?? 0
            ),
            durableWriteMs: boundedDuration(durableWriteMs),
            totalCompilationMs: boundedDuration(
              performance.now() - compilationStarted
            ),
            worldCalled: (compileActivity?.batchCalls ?? 0) > 0
          }
        });
        if (completed) {
          this.markReady(zoneId, claim.planId, true);
        } else {
          this.schedulePendingRetry();
        }
      } catch (error) {
        const completionFailure =
          populationPlanCompletionFailureDetails(error);
        const failed = heartbeat.owned()
          ? await this.store.failPlan(claim, error)
          : null;
        if (failed?.accepted && failed.status === "terminal-failure") {
          this.markFailed(zoneId, "terminal-failure");
        }
        this.updatePreparationError(zoneId, error);
        this.schedulePendingRetry();
        this.logger?.warn({
          err: error,
          postgresCode: completionFailure?.postgresCode ?? null,
          constraint: completionFailure?.constraint ?? null,
          table: completionFailure?.table ?? null,
          zoneId,
          planId: claim.planId,
          spawnRulesVersion: claim.identity.spawnRulesVersion,
          slotId: completionFailure?.slotId ?? null,
          entityId: completionFailure?.entityId ?? null,
          entityKind: completionFailure?.entityKind ?? null,
          generationId: completionFailure?.generationId ?? null,
          claimGeneration: claim.claimGeneration,
          attemptCount: claim.attemptCount,
          errorCode: failed?.errorCode
            ?? completionFailure?.code
            ?? "population-plan-generation-failure"
        }, "population v3 bounded plan compilation failed");
      } finally {
        await heartbeat.stop();
      }
    }
    return unresolved.every((record) =>
      !this.pendingZones.has(record.identity.zoneId as PopulationZoneV2Id)
    );
  }

  private startPlanClaimHeartbeat(
    claim: ClaimedPopulationZoneV2Plan
  ): PlanClaimHeartbeat {
    const leaseMs = this.configuration.planLeaseMs ?? DEFAULT_PLAN_LEASE_MS;
    const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let hasOwnership = true;
    let stopped = false;
    const schedule = (): void => {
      if (stopped || !hasOwnership) return;
      timer = setTimeout(() => {
        timer = null;
        inFlight = this.store.heartbeatPlan(claim, leaseMs)
          .then((renewed) => {
            if (!renewed) hasOwnership = false;
          })
          .catch((error: unknown) => {
            hasOwnership = false;
            this.logger?.warn({
              err: error,
              zoneId: claim.identity.zoneId
            }, "population v2 plan claim heartbeat failed");
          })
          .finally(() => {
            inFlight = null;
            schedule();
          });
      }, intervalMs);
      timer.unref?.();
    };
    schedule();
    return {
      claim,
      owned: () => hasOwnership,
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        await inFlight;
      }
    };
  }

  private markReady(
    zoneId: PopulationZoneV2Id,
    planId: string,
    created: boolean
  ): void {
    this.terminalFailureNotifications.delete(zoneId);
    const existed = this.pendingZones.delete(zoneId);
    this.releaseQueuedZone(zoneId);
    this.preparationActivity.delete(zoneId);
    if (this.pendingZones.size === 0) this.retryAttempt = 0;
    gameplayLatencyTrace.recordActive({
      traceId: planId,
      source: "game",
      category: "population",
      name: created
        ? "population_zone_plan_created"
        : "population_zone_plan_reused",
      details: { zoneId, worldCalled: false }
    });
    if (!existed) return;
    for (const listener of this.readyListeners) {
      void Promise.resolve(listener(zoneId)).catch((error: unknown) => {
        this.logger?.warn({ err: error, zoneId }, "population v2 ready listener failed");
      });
    }
  }

  private markFailed(
    zoneId: PopulationZoneV2Id,
    outcome: "terminal-failure"
  ): void {
    this.pendingZones.delete(zoneId);
    this.releaseQueuedZone(zoneId);
    this.preparationActivity.delete(zoneId);
    if (this.terminalFailureNotifications.has(zoneId)) return;
    this.terminalFailureNotifications.add(zoneId);
    this.emitFailure(zoneId, outcome);
  }

  private emitFailure(
    zoneId: PopulationZoneV2Id,
    outcome: "terminal-failure" | "cancelled"
  ): void {
    for (const listener of this.failureListeners) {
      void Promise.resolve(listener(zoneId, outcome)).catch((error: unknown) => {
        this.logger?.warn(
          { err: error, zoneId, outcome },
          "population v2 failure listener failed"
        );
      });
    }
  }

  private updatePreparationError(zoneId: PopulationZoneV2Id, error: unknown): void {
    const previous = this.preparationActivity.get(zoneId);
    if (!previous) return;
    this.preparationActivity.set(zoneId, {
      ...previous,
      lastError: error instanceof Error ? error.message : String(error)
    });
  }

  private schedulePendingRetry(delayMs?: number): void {
    if (this.closed || this.pendingZones.size === 0 || this.retryTimer) return;
    const minimum = this.configuration.retryMs ?? DEFAULT_RETRY_MS;
    const maximum = this.configuration.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    const baseDelay = delayMs ?? Math.min(
      maximum,
      minimum * (2 ** Math.min(this.retryAttempt, 8))
    );
    const boundedDelay = Math.min(
      maximum,
      Math.round(baseDelay * (1 + Math.random() * 0.1))
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAttempt += 1;
      void this.retryPending();
    }, boundedDelay);
    this.retryTimer.unref?.();
  }

  private async retryPending(): Promise<void> {
    if (this.closed) return;
    const entries = [...this.pendingZones.values()];
    const groups = new Map<string, PendingZone[]>();
    for (const entry of entries) {
      const key = `${entry.regionCode}:${entry.reason}:${entry.priority}`;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      try {
        await this.scheduleZones({
          zoneIds: group.map((entry) => entry.zoneId),
          regionCode: group[0]!.regionCode,
          reason: group[0]!.reason,
          priority: group[0]!.priority
        });
      } catch (error) {
        this.logger?.warn({ err: error }, "population v2 pending plan retry failed");
      }
    }
    if (this.pendingZones.size > 0) this.schedulePendingRetry();
  }
}

export function populationZoneV2CanonicalRegionCode(
  zoneId: PopulationZoneV2Id
): string {
  return packageIdForPosition(populationZoneV2Geometry(zoneId).center);
}

function assertConfiguration(input: Readonly<{
  worldEnvironmentIdentityKey: string;
  worldPipelineSha: string;
  planLeaseMs?: number;
  retryMs?: number;
  retryMaxMs?: number;
  activePreparationConcurrency?: number;
  backgroundPreparationConcurrency?: number;
  backgroundStarvationMs?: number;
  backgroundFairnessIntervalMs?: number;
  zoneQueueMax?: number;
}>): void {
  if (!/^[a-f0-9]{64}$/u.test(input.worldEnvironmentIdentityKey)) {
    throw new Error("population planner World identity key must be SHA-256 hex");
  }
  if (!/^[a-f0-9]{40}$/u.test(input.worldPipelineSha)) {
    throw new Error("population planner World runtime SHA must be Git SHA hex");
  }
  for (const [label, value] of [
    ["plan lease", input.planLeaseMs],
    ["retry", input.retryMs],
    ["retry maximum", input.retryMaxMs],
    ["active preparation concurrency", input.activePreparationConcurrency],
    ["background preparation concurrency", input.backgroundPreparationConcurrency],
    ["zone queue maximum", input.zoneQueueMax]
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`population planner ${label} must be a positive integer`);
    }
  }
  if (
    input.backgroundPreparationConcurrency !== undefined
    && input.activePreparationConcurrency !== undefined
    && input.backgroundPreparationConcurrency > input.activePreparationConcurrency
  ) {
    throw new Error(
      "population background preparation concurrency cannot exceed total concurrency"
    );
  }
  for (const [label, value] of [
    ["background starvation interval", input.backgroundStarvationMs],
    ["background fairness interval", input.backgroundFairnessIntervalMs]
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`population planner ${label} must be non-negative`);
    }
  }
  if (
    input.retryMs !== undefined
    && input.retryMaxMs !== undefined
    && input.retryMaxMs < input.retryMs
  ) {
    throw new Error("population planner retry maximum must not be below retry");
  }
}

function preparationWithCompileActivity(
  activity: PopulationZoneV2PreparationActivity,
  compile: PopulationZoneV3CompileActivity | undefined
): PopulationZoneV2PreparationActivity {
  if (!compile) return activity;
  return {
    ...activity,
    requiredSamples: compile.requestedSamples,
    readySamples: compile.readySamples,
    activeSamples: compile.activeSamples,
    failedSamples: compile.failedSamples,
    compactBatchCalls: compile.batchCalls,
    cacheHits: compile.cacheHits,
    deduplicatedSamples: compile.deduplicatedSamples,
    lastProgressAt: compile.lastProgressAt,
    lastError: compile.lastError
  };
}

function assertPriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
    throw new Error("population planner priority must be an integer from 0 through 3");
  }
}

function normalizeWorldBatchPriority(priority: number): 0 | 1 | 2 | 3 {
  if (priority <= 0) return 0;
  if (priority === 1) return 2;
  return 3;
}

function comparePendingZones(left: PendingZone, right: PendingZone): number {
  return left.priority - right.priority
    || preparationClassRank(left.workClass) - preparationClassRank(right.workClass)
    || left.zoneId.localeCompare(right.zoneId);
}

function preparationClassRank(workClass: PopulationPreparationClass): number {
  return PREPARATION_CLASSES.indexOf(workClass);
}

function workClassFor(
  priority: number,
  reason: string
): PopulationPreparationClass {
  if (priority < 2) return "foreground";
  if (reason.includes("locality")) return "locality";
  if (reason.includes("continuation")) return "continuation";
  if (reason.includes("backfill")) return "global";
  return "foreground";
}

function cacheClassFor(
  workClass: PopulationPreparationClass
): "protected" | "probationary" {
  return workClass === "global" ? "probationary" : "protected";
}

function isMoreUrgent(
  leftPriority: number,
  leftClass: PopulationPreparationClass,
  rightPriority: number,
  rightClass: PopulationPreparationClass
): boolean {
  return leftPriority < rightPriority || (
    leftPriority === rightPriority
    && preparationClassRank(leftClass) < preparationClassRank(rightClass)
  );
}

function emptyPrepareResult(disabled: boolean): PopulationZonesV2PrepareResult {
  return { disabled, readyZoneIds: [], pendingZoneIds: [] };
}

function uniquePromises(
  promises: Iterable<Promise<void> | undefined>
): Promise<void>[] {
  return [...new Set([...promises].filter(
    (promise): promise is Promise<void> => promise !== undefined
  ))];
}

async function waitForPlannerProgress(
  promises: readonly Promise<void>[],
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return;
  const progress = promises.length > 0
    ? Promise.allSettled(promises).then(() => undefined)
    : new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10);
        timer.unref?.();
      });
  if (!signal) {
    await progress;
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void progress.then(finish);
  });
}

async function subscribeToEnvironmentPrefetch(
  flight: EnvironmentPrefetchFlight,
  signal: AbortSignal | undefined
): Promise<PopulationEnvironmentPrefetchDiagnostics> {
  throwIfAborted(signal);
  flight.waiters += 1;
  let abortListener: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        abortListener = () => reject(
          signal.reason
          ?? new DOMException("The operation was aborted", "AbortError")
        );
        signal.addEventListener("abort", abortListener, { once: true });
      })
    : null;
  try {
    return await (aborted
      ? Promise.race([flight.promise, aborted])
      : flight.promise);
  } finally {
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.admitted && !flight.settled) {
      flight.controller.abort(new DOMException(
        "Population destination no longer has an owner",
        "AbortError"
      ));
    }
  }
}

function boundedDuration(value: number): number {
  return Math.max(0, Math.min(60_000, Math.round(value * 100) / 100));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason
    ?? new DOMException("The operation was aborted", "AbortError");
}

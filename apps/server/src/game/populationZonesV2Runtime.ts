import {
  assertGameplayAreaContract,
  isGivingTreeResinCapable,
  isWolfFamilyArchetype,
  POPULATION_VISIBLE_PREPARATION_TERMINAL_MS,
  type EquipmentChallengeProfile,
  type GameplayAreaContract,
  type LatLon
} from "@ash-atlas/shared";

import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import {
  maximumPopulationStage,
  populationStageAtLeast,
  type PopulationPreparationPriority,
  type PopulationPreparationReason,
  type PopulationPreparationStage,
  type PopulationZoneAuthorityFingerprint
} from "./populationStreamingContract.js";
import {
  PopulationEnvironmentPrefetchTerminalError
} from "./populationZoneV3HabitatCompiler.js";
import {
  greatCircleDistanceMeters,
  type PopulationZoneV2Id,
  populationZoneV2Geometry,
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle
} from "./populationZonesV2Geometry.js";
export const POPULATION_V2_SLEEP_GRACE_MS = 60_000;
export const POPULATION_V2_VISIBLE_PREPARATION_STALE_MS = 15_000;
export const POPULATION_V2_VISIBLE_PREPARATION_TERMINAL_MS =
  POPULATION_VISIBLE_PREPARATION_TERMINAL_MS;
export const POPULATION_V2_VISIBLE_PREPARATION_RETRY_LIMIT = 1;
export const POPULATION_V2_DESCRIPTOR_CACHE_MAX_ZONES = 128;
export const POPULATION_V2_DESCRIPTOR_CACHE_MAX_BYTES = 16 * 1_024 * 1_024;
export const POPULATION_V2_DESCRIPTOR_CACHE_TTL_MS = 5 * 60_000;

export type PopulationZoneV2RuntimeTrigger =
  | "world-entry"
  | "reconnect"
  | "flag-travel"
  | "party-travel"
  | "separate-space-exit"
  | "administrative-relocation"
  | "flag-placement"
  | "explicit-relocation"
  | "plan-ready";

type PopulationRelocationTrigger =
  Exclude<PopulationZoneV2RuntimeTrigger, "plan-ready">;

export type PopulationZoneV2RuntimeEntity = Readonly<{
  entityId: string;
  zoneId: PopulationZoneV2Id;
  generationId: string | null;
  kind: string;
  archetype: string;
  packId?: string | null;
  position: LatLon;
  homePosition: LatLon;
  stateRevision: number;
  combatLevel?: number;
  combatTier?: EquipmentChallengeProfile["tier"];
  combatBalanceVersion?: number;
  resinAvailable?: boolean;
  berryAvailable?: boolean;
  sapReadyAt?: string | null;
}>;

export type PopulationV2HarvestedTreeTransition = Readonly<{
  entityId: string;
  entityKind: "tree";
  stateRevision: number;
  position: LatLon;
  zoneId: PopulationZoneV2Id;
  generationId: string;
  cutoverRevision: number;
}>;

export type PopulationZoneV2BackendZoneActivation = Readonly<{
  zoneId: PopulationZoneV2Id;
  generationId: string | null;
  generationExpiresAtMs?: number | null;
  materializationStatus:
    | "materialization-current"
    | "materialization-stale-but-servable"
    | "generation-missing"
    | "generation-lifecycle-pending"
    | "guarded-materialization"
    | "replacement-required-materialization"
    | "generation-invalid-or-unservable";
  status: "ready" | "pending";
  entities: readonly PopulationZoneV2RuntimeEntity[];
  removedEntityIds?: readonly string[];
  spawnedRuntimeActors: number;
  completedStage?: Exclude<PopulationPreparationStage, "PUBLISHED"> | null;
  reason?: PopulationPreparationReason;
  authority?: PopulationZoneAuthorityFingerprint | null;
}>;

export interface PopulationZonesV2RuntimeBackend {
  updateZoneReferences?(input: Readonly<{
    currentReferencesByZone: Readonly<Record<string, number>>;
    unreferencedAtByZone?: Readonly<Record<string, number>>;
  }>): void;

  prefetchPlanEnvironmentForZones?(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    trigger: PopulationZoneV2RuntimeTrigger;
    priority: PopulationPreparationPriority;
    signal?: AbortSignal;
  }>): Promise<unknown>;

  activateZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    trigger: PopulationZoneV2RuntimeTrigger;
    relocationRevision: number;
    resourceVisionRevision: number;
    priorityZoneIds?: readonly PopulationZoneV2Id[];
    priorityByZone?: Readonly<Record<string, PopulationPreparationPriority>>;
    targetStageByZone?: Readonly<
      Record<string, Exclude<PopulationPreparationStage, "PUBLISHED">>
    >;
    preparedAuthoritiesByZone?: Readonly<
      Record<string, PopulationZoneAuthorityFingerprint>
    >;
    currentReferencesByZone?: Readonly<Record<string, number>>;
    challengeProfilesByZone?: Readonly<
      Record<string, EquipmentChallengeProfile>
    >;
    activationOrderByZone?: Readonly<Record<string, number>>;
    onZoneActivated?: (
      activation: PopulationZoneV2BackendZoneActivation
    ) => void;
    activateRuntime?: boolean;
  }>): Promise<readonly PopulationZoneV2BackendZoneActivation[]>;

  sleepZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    unreferencedAtByZone?: Readonly<Record<string, number>>;
    currentReferencesByZone?: Readonly<Record<string, number>>;
  }>): Promise<Readonly<{
    removedEntityIds: readonly string[];
    sleptRuntimeActors: number;
  }>>;
}

export type PopulationZonesV2ActivationDelta = Readonly<{
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  preparationGeneration: number;
  preparationTrigger: PopulationRelocationTrigger;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
  retainedZoneIds: readonly PopulationZoneV2Id[];
  activatedZoneIds: readonly PopulationZoneV2Id[];
  releasedZoneIds: readonly PopulationZoneV2Id[];
  withheldZoneIds: readonly PopulationZoneV2Id[];
  upserts: readonly PopulationZoneV2RuntimeEntity[];
  removedEntityIds: readonly string[];
  visibleZoneCount: number;
  readyVisibleZoneCount: number;
  backgroundZoneCount: number;
  readyBackgroundZoneCount: number;
  zoneSnapshots: readonly Readonly<{
    zoneId: PopulationZoneV2Id;
    generationId: string | null;
    entityIds: readonly string[];
  }>[];
  preparationReason: PopulationPreparationReason;
  preparationResult:
    | "pending"
    | "ready"
    | "degraded"
    | "retryable-failure"
    | "stale"
    | "cancelled";
  partial: boolean;
  terminal: boolean;
}>;

export type VisibleActivationOutcome = Readonly<
  | {
      status: "ready" | "degraded";
      delta: PopulationZonesV2ActivationDelta;
      pendingVisibleZoneCount: number;
    }
  | {
      status: "stale" | "closed" | "failed";
      delta: null;
      pendingVisibleZoneCount: number;
    }
>;

export type PopulationRelocationOutcome = Readonly<{
  status: "completed" | "stale" | "closed";
  delta: PopulationZonesV2ActivationDelta | null;
}>;

export type PopulationRelocationHandle = Readonly<{
  visibleReady: Promise<VisibleActivationOutcome>;
  presentationReady: Promise<VisibleActivationOutcome>;
  completion: Promise<PopulationRelocationOutcome>;
  preparationGeneration: number;
  visibleZoneCount: number;
  pendingVisibleZoneCount(): number;
}>;

export type PopulationConnectionPreparationState = Readonly<{
  preparationGeneration: number;
  relocationRevision: number;
  resourceVisionRevision: number;
  preparationResult: PopulationZonesV2ActivationDelta["preparationResult"];
  preparationReason: PopulationPreparationReason;
  visibleZoneCount: number;
  readyVisibleZoneCount: number;
  terminal: boolean;
}>;

export type PopulationConnectionRepublishResult = Readonly<{
  status: "republished" | "retry-required" | "missing";
  state: PopulationConnectionPreparationState | null;
}>;

type VisibleReadiness = {
  settled: boolean;
  resolve(outcome: VisibleActivationOutcome): void;
};

type ConnectionLease = {
  ownershipToken: object;
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  preparationGeneration: number;
  preparationTrigger: PopulationRelocationTrigger;
  preparationResult: PopulationZonesV2ActivationDelta["preparationResult"];
  preparationReason: PopulationPreparationReason;
  relocationRevision: number;
  resourceVisionRevision: number;
  challengeProfile: EquipmentChallengeProfile | undefined;
  area: GameplayAreaContract;
  centerZoneId: PopulationZoneV2Id;
  visibleZoneIds: Set<PopulationZoneV2Id>;
  activeZoneIds: Set<PopulationZoneV2Id>;
  incompleteZoneIds: Set<PopulationZoneV2Id>;
  projectedEntityIds: Set<string>;
  visibleReadiness: VisibleReadiness;
  presentationReadiness: VisibleReadiness;
  startedAtMs: number;
  lastProgressAtMs: number;
  recoveryAttempt: number;
  staleTimer: ReturnType<typeof setTimeout> | null;
  terminalTimer: ReturnType<typeof setTimeout> | null;
  terminalDelta: PopulationZonesV2ActivationDelta | null;
};

type ActivationRequest = {
  trigger: PopulationZoneV2RuntimeTrigger;
  relocationRevision: number;
  resourceVisionRevision: number;
  priority: PopulationPreparationPriority;
  challengeProfile: EquipmentChallengeProfile | undefined;
  targetStage: Exclude<PopulationPreparationStage, "PUBLISHED">;
  activateRuntime: boolean;
  activationOrder?: number;
  resolve: (activation: PopulationZoneV2BackendZoneActivation) => void;
  reject: (error: unknown) => void;
};

type PopulationDurableDescriptorCacheEntry = Readonly<{
  zoneId: PopulationZoneV2Id;
  generationId: string | null;
  materializationStatus:
    PopulationZoneV2BackendZoneActivation["materializationStatus"];
  completedStage: Exclude<PopulationPreparationStage, "PUBLISHED">;
  authority: PopulationZoneAuthorityFingerprint;
  entities: readonly PopulationZoneV2RuntimeEntity[];
  cachedAtMs: number;
  expiresAtMs: number;
  estimatedBytes: number;
}>;

export class PopulationZonesV2Runtime {
  private readonly leases = new Map<string, ConnectionLease>();
  private readonly refCounts = new Map<PopulationZoneV2Id, number>();
  private readonly simulationRefCounts =
    new Map<PopulationZoneV2Id, number>();
  private readonly simulationResidentZones = new Set<PopulationZoneV2Id>();
  private readonly cachedEntities = new Map<
    PopulationZoneV2Id,
    readonly PopulationZoneV2RuntimeEntity[]
  >();
  private readonly cachedGenerations = new Map<
    PopulationZoneV2Id,
    string | null
  >();
  private readonly zoneIdByEntityId = new Map<string, PopulationZoneV2Id>();
  private readonly harvestedTreeFences = new Map<
    string,
    Readonly<{
      zoneId: PopulationZoneV2Id;
      generationId: string;
      stateRevision: number;
      cutoverRevision: number;
    }>
  >();
  private readonly pendingActivationZones = new Set<PopulationZoneV2Id>();
  private readonly materializationStatusByZone = new Map<
    PopulationZoneV2Id,
    PopulationZoneV2BackendZoneActivation["materializationStatus"]
  >();
  private readonly completedStageByZone = new Map<
    PopulationZoneV2Id,
    Exclude<PopulationPreparationStage, "PUBLISHED">
  >();
  private readonly authorityByZone = new Map<
    PopulationZoneV2Id,
    PopulationZoneAuthorityFingerprint
  >();
  private readonly descriptorCache = new Map<
    PopulationZoneV2Id,
    PopulationDurableDescriptorCacheEntry
  >();
  private descriptorCacheBytes = 0;
  private descriptorCacheHits = 0;
  private descriptorCacheMisses = 0;
  private descriptorCacheInvalidations = 0;
  private descriptorCacheEvictions = 0;
  private readonly stageRefCountsByZone = new Map<
    PopulationZoneV2Id,
    Map<PopulationPreparationStage, number>
  >();
  private readonly streamingSourceLeases = new Map<string, Readonly<{
    zoneIds: ReadonlySet<PopulationZoneV2Id>;
    targetStage: Exclude<PopulationPreparationStage, "PUBLISHED">;
  }>>();
  private readonly sleepTimers = new Map<
    PopulationZoneV2Id,
    ReturnType<typeof setTimeout>
  >();
  private readonly sleepGenerations = new Map<PopulationZoneV2Id, number>();
  private readonly unreferencedAtByZone = new Map<
    PopulationZoneV2Id,
    number
  >();
  private readonly zoneOwnershipTokens = new Map<PopulationZoneV2Id, object>();
  private readonly activationRequests = new Map<
    PopulationZoneV2Id,
    ActivationRequest[]
  >();
  private readonly activationWaiters = new Set<ActivationRequest>();
  private readonly activationInFlight = new Set<PopulationZoneV2Id>();
  private readonly pendingSleepZones = new Map<PopulationZoneV2Id, number>();
  private readonly sleepInFlightZones = new Set<PopulationZoneV2Id>();
  private readonly sleepFlightsByZone = new Map<
    PopulationZoneV2Id,
    Promise<void>
  >();
  private readonly priorityActivationFlights = new Set<Promise<unknown>>();
  private readonly deltaListeners = new Set<
    (delta: PopulationZonesV2ActivationDelta) => void | Promise<void>
  >();
  private readonly lastDeltaEntityCountByZone = new Map<
    PopulationZoneV2Id,
    number
  >();
  private readonly lastPublishedRevisionByZone = new Map<
    PopulationZoneV2Id,
    number
  >();
  private activationWorkTail: Promise<void> = Promise.resolve();
  private sleepWorkTail: Promise<void> = Promise.resolve();
  private activationFlush: Promise<void> | null = null;
  private sleepFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepFlush: Promise<void> | null = null;
  private preparationGeneration = 0;
  private lateVisiblePopulation = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly backend: PopulationZonesV2RuntimeBackend,
    private readonly options: Readonly<{
      sleepGraceMs?: number;
      descriptorCacheMaxZones?: number;
      descriptorCacheMaxBytes?: number;
      descriptorCacheTtlMs?: number;
      visiblePreparationStaleMs?: number;
      visiblePreparationTerminalMs?: number;
      visiblePreparationRetryLimit?: number;
      inflightResultReuseEnabled?: boolean;
      logger?: Readonly<{
        warn(context: object, message: string): void;
      }>;
      plannerStateForZones?(
        zoneIds: readonly PopulationZoneV2Id[]
      ): unknown;
    }> = {}
  ) {}

  onDelta(
    listener: (delta: PopulationZonesV2ActivationDelta) => void | Promise<void>
  ): () => void {
    this.deltaListeners.add(listener);
    return () => this.deltaListeners.delete(listener);
  }

  hasActiveReferences(zoneId: PopulationZoneV2Id): boolean {
    return (this.refCounts.get(zoneId) ?? 0) > 0;
  }

  activeZoneIds(): readonly PopulationZoneV2Id[] {
    return sorted([...this.refCounts]
      .filter(([, count]) => count > 0)
      .map(([zoneId]) => zoneId));
  }

  hasPreparedZones(
    zoneIds: readonly PopulationZoneV2Id[],
    stage: Exclude<PopulationPreparationStage, "PUBLISHED">
  ): boolean {
    return uniqueSorted(zoneIds).every((zoneId) =>
      populationStageAtLeast(
        this.completedStageByZone.get(zoneId) ?? null,
        stage
      )
      && this.authorityByZone.has(zoneId)
      && (
        stage === "PLAN_READY"
        || this.cachedEntities.has(zoneId)
      )
    );
  }

  async prepareZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    trigger: PopulationZoneV2RuntimeTrigger;
    priority: PopulationPreparationPriority;
    targetStage?: Exclude<PopulationPreparationStage, "PUBLISHED">;
    activateRuntime: boolean;
    challengeProfile?: EquipmentChallengeProfile;
    signal?: AbortSignal;
  }>): Promise<readonly PopulationZoneV2BackendZoneActivation[]> {
    if (input.signal?.aborted) return [];
    const zoneIds = uniqueSorted(input.zoneIds);
    const targetStage = input.targetStage ?? legacyTargetStage(
      input.priority,
      input.activateRuntime
    );
    if (
      shouldPrefetchDestinationEnvironment({
        zoneCount: zoneIds.length,
        targetStage,
        priority: input.priority,
        trigger: input.trigger
      })
      && this.backend.prefetchPlanEnvironmentForZones
    ) {
      try {
        await this.backend.prefetchPlanEnvironmentForZones({
          zoneIds,
          trigger: input.trigger,
          priority: input.priority,
          ...(input.signal ? { signal: input.signal } : {})
        });
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) throw error;
        if (isTerminalEnvironmentPrefetchError(error)) throw error;
        this.options.logger?.warn({
          err: error,
          trigger: input.trigger,
          priority: input.priority,
          zoneIds,
          disposition: "fallback-per-zone"
        }, "population destination environment prefetch failed; using per-zone path");
      }
      if (input.signal?.aborted) return [];
      await Promise.resolve();
    }
    if (input.signal?.aborted) return [];
    // A completed simulation zone can otherwise sleep while sibling zones are
    // still preparing. Hold only ready zones through this batch's handoff to
    // the caller; cancellation or failure also fences later completions.
    const heldSimulationZones = new Set<PopulationZoneV2Id>();
    let abandoned = false;
    const releaseBatch = (): void => {
      abandoned = true;
      const released = [...heldSimulationZones];
      heldSimulationZones.clear();
      if (this.closed) return;
      for (const zoneId of released) this.releaseZone(zoneId, "SIMULATION_READY");
      this.synchronizeZoneReferences(released);
    };
    input.signal?.addEventListener("abort", releaseBatch, { once: true });
    try {
      return await Promise.all(zoneIds.map(async (zoneId) => {
        if (input.signal?.aborted) {
          return pendingActivation(zoneId);
        }
        const activation = await this.requestActivation(zoneId, {
          trigger: input.trigger,
          relocationRevision: 0,
          resourceVisionRevision: 0,
          priority: input.priority,
          challengeProfile: strongestChallengeProfile([
            ...(input.challengeProfile === undefined
              ? []
              : [input.challengeProfile]),
            ...(strongestChallengeProfileForZone(this.leases.values(), zoneId)
              ? [strongestChallengeProfileForZone(this.leases.values(), zoneId)!]
              : [])
          ]),
          targetStage,
          activateRuntime: input.activateRuntime
        });
        if (
          !abandoned && !this.closed && !input.signal?.aborted
          && input.activateRuntime && targetStage === "SIMULATION_READY"
          && activation.status === "ready" && activation.authority
          && populationStageAtLeast(
            activation.completedStage ?? null, "SIMULATION_READY"
          )
        ) {
          heldSimulationZones.add(zoneId);
          this.acquireZone(zoneId, "SIMULATION_READY");
          this.synchronizeZoneReferences([zoneId]);
        }
        return input.signal?.aborted ? pendingActivation(zoneId) : activation;
      }));
    } finally {
      input.signal?.removeEventListener("abort", releaseBatch);
      releaseBatch();
    }
  }

  retainStreamingSource(input: Readonly<{
    sourceId: string;
    zoneIds: readonly PopulationZoneV2Id[];
    targetStage: Exclude<PopulationPreparationStage, "PUBLISHED">;
  }>): void {
    const zoneIds = new Set(uniqueSorted(input.zoneIds));
    const previous = this.streamingSourceLeases.get(input.sourceId);
    const changedReferencedZoneIds = new Set<PopulationZoneV2Id>();
    if (previous) {
      for (const zoneId of previous.zoneIds) {
        if (zoneIds.has(zoneId)) {
          if (previous.targetStage !== input.targetStage) {
            this.decrementStageReference(zoneId, previous.targetStage);
            this.incrementStageReference(zoneId, input.targetStage);
            if (previous.targetStage !== "PLAN_READY") {
              this.releaseZone(zoneId, previous.targetStage);
              changedReferencedZoneIds.add(zoneId);
            }
            if (input.targetStage !== "PLAN_READY") {
              this.acquireZone(zoneId, input.targetStage);
              changedReferencedZoneIds.add(zoneId);
            }
          }
          continue;
        }
        this.decrementStageReference(zoneId, previous.targetStage);
        if (previous.targetStage !== "PLAN_READY") {
          this.releaseZone(zoneId, previous.targetStage);
          changedReferencedZoneIds.add(zoneId);
        }
      }
    }
    for (const zoneId of zoneIds) {
      if (previous?.zoneIds.has(zoneId)) continue;
      this.incrementStageReference(zoneId, input.targetStage);
      if (input.targetStage !== "PLAN_READY") {
        this.acquireZone(zoneId, input.targetStage);
        changedReferencedZoneIds.add(zoneId);
      }
    }
    this.streamingSourceLeases.set(input.sourceId, {
      zoneIds,
      targetStage: input.targetStage
    });
    this.synchronizeZoneReferences([...changedReferencedZoneIds]);
  }

  releaseStreamingSource(sourceId: string): boolean {
    const lease = this.streamingSourceLeases.get(sourceId);
    if (!lease) return false;
    this.streamingSourceLeases.delete(sourceId);
    const changedReferencedZoneIds: PopulationZoneV2Id[] = [];
    for (const zoneId of lease.zoneIds) {
      this.decrementStageReference(zoneId, lease.targetStage);
      if (lease.targetStage !== "PLAN_READY") {
        this.releaseZone(zoneId, lease.targetStage);
        changedReferencedZoneIds.push(zoneId);
      }
    }
    this.synchronizeZoneReferences(changedReferencedZoneIds);
    return true;
  }

  adoptStreamingSource(sourceId: string, adoptedSourceId: string): boolean {
    if (sourceId === adoptedSourceId) {
      return this.streamingSourceLeases.has(sourceId);
    }
    const lease = this.streamingSourceLeases.get(sourceId);
    if (!lease || this.streamingSourceLeases.has(adoptedSourceId)) return false;
    this.streamingSourceLeases.delete(sourceId);
    this.streamingSourceLeases.set(adoptedSourceId, lease);
    return true;
  }

  streamingSourceAuthorities(
    sourceId: string
  ): readonly PopulationZoneAuthorityFingerprint[] | null {
    const lease = this.streamingSourceLeases.get(sourceId);
    if (!lease) return null;
    const authorities = [...lease.zoneIds]
      .sort()
      .map((zoneId) => this.authorityByZone.get(zoneId) ?? null);
    return authorities.every(
      (authority): authority is PopulationZoneAuthorityFingerprint =>
        authority !== null
    )
      ? authorities
      : null;
  }

  removeHarvestedTree(input: PopulationV2HarvestedTreeTransition): void {
    assertRevision(input.stateRevision, "harvested tree state revision");
    assertRevision(input.cutoverRevision, "harvested tree cutover revision");
    const indexedZoneId = this.zoneIdByEntityId.get(input.entityId);
    const candidateZoneIds = uniqueSorted([
      input.zoneId,
      ...(indexedZoneId === undefined ? [] : [indexedZoneId])
    ]) as PopulationZoneV2Id[];
    for (const zoneId of candidateZoneIds) {
      this.invalidateDurableDescriptorCache(zoneId);
    }
    const cachedMatches = candidateZoneIds.flatMap((zoneId) =>
      (this.cachedEntities.get(zoneId) ?? [])
        .filter((entity) => entity.entityId === input.entityId)
    );
    if (cachedMatches.some((entity) => entity.kind !== input.entityKind)) {
      this.options.logger?.warn({
        entityId: input.entityId,
        zoneId: input.zoneId,
        generationId: input.generationId,
        incomingRevision: cachedMatches[0]?.stateRevision,
        canonicalRevision: input.stateRevision,
        operationType: "harvested-tree-kind-mismatch"
      }, "refused to evict non-tree population entity for harvested tree transition");
      return;
    }
    const currentLife = cachedMatches.find((entity) =>
      entity.generationId !== input.generationId
    );
    if (currentLife) {
      this.options.logger?.warn({
        entityId: input.entityId,
        zoneId: currentLife.zoneId,
        generationId: currentLife.generationId,
        incomingRevision: currentLife.stateRevision,
        canonicalRevision: input.stateRevision,
        operationType: "harvested-tree-newer-life-retained"
      }, "retained a different-generation tree life during harvested tree eviction");
      return;
    }

    const existingFence = this.harvestedTreeFences.get(input.entityId);
    if (
      !existingFence
      || existingFence.generationId !== input.generationId
      || input.stateRevision >= existingFence.stateRevision
    ) {
      this.harvestedTreeFences.set(input.entityId, {
        zoneId: input.zoneId,
        generationId: input.generationId,
        stateRevision: input.stateRevision,
        cutoverRevision: input.cutoverRevision
      });
    }

    let evicted = false;
    for (const zoneId of candidateZoneIds) {
      const cached = this.cachedEntities.get(zoneId);
      if (!cached) continue;
      const retained = cached.filter((entity) =>
        entity.entityId !== input.entityId
      );
      if (retained.length === cached.length) continue;
      evicted = true;
      this.setCachedEntities(zoneId, retained);
    }
    if (this.zoneIdByEntityId.get(input.entityId) === indexedZoneId) {
      this.zoneIdByEntityId.delete(input.entityId);
    }

    gameplayLatencyTrace.recordActive({
      traceId: input.entityId,
      source: "game",
      category: "population",
      name: "harvested_tree_runtime_cache_evicted",
      details: {
        entityId: input.entityId,
        zoneId: input.zoneId,
        generationId: input.generationId,
        incomingRevision: input.stateRevision,
        canonicalRevision: input.stateRevision,
        operationType: "harvested-tree-cache-eviction",
        evicted
      }
    });

    for (const lease of this.leases.values()) {
      lease.projectedEntityIds.delete(input.entityId);
      const priorTerminal = lease.terminalDelta;
      if (priorTerminal) {
        lease.terminalDelta = {
          ...priorTerminal,
          upserts: priorTerminal.upserts.filter((entity) =>
            entity.entityId !== input.entityId
          ),
          removedEntityIds: uniqueSorted([
            ...priorTerminal.removedEntityIds,
            input.entityId
          ]),
          ...this.authorityForLease(lease)
        };
      }
      if (
        greatCircleDistanceMeters(lease.area.center, input.position) >
        lease.area.certifiedVisibleRadiusM
      ) continue;
      const removalDelta = lease.terminalDelta ?? {
        playerId: lease.playerId,
        connectionId: lease.connectionId,
        connectionGeneration: lease.connectionGeneration,
        preparationGeneration: lease.preparationGeneration,
        preparationTrigger: lease.preparationTrigger,
        relocationRevision: lease.relocationRevision,
        resourceVisionRevision: lease.resourceVisionRevision,
        gameplayViewGeneration: lease.area.generation,
        retainedZoneIds: lease.activeZoneIds.has(input.zoneId)
          ? [input.zoneId]
          : [],
        activatedZoneIds: [],
        releasedZoneIds: [],
        withheldZoneIds: [],
        upserts: [],
        removedEntityIds: [input.entityId],
        ...this.authorityForLease(lease, [input.zoneId]),
        preparationReason: lease.preparationReason,
        preparationResult: lease.preparationResult,
        partial: hasIncompleteVisibleZones(lease),
        terminal: !hasIncompleteVisibleZones(lease)
      };
      this.publishDelta(removalDelta);
      gameplayLatencyTrace.record(lease.playerId, {
        traceId: input.entityId,
        source: "game",
        category: "population",
        name: "harvested_tree_removal_delta_published",
        details: {
          entityId: input.entityId,
          zoneId: input.zoneId,
          generationId: input.generationId,
          incomingRevision: input.stateRevision,
          canonicalRevision: input.stateRevision,
          operationType: "harvested-tree-removal-publication",
          connectionGeneration: lease.connectionGeneration,
          preparationGeneration: lease.preparationGeneration,
          relocationRevision: lease.relocationRevision,
          resourceVisionRevision: lease.resourceVisionRevision,
          gameplayViewGeneration: lease.area.generation
        }
      });
    }
  }

  relocate(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    area: GameplayAreaContract;
    relocationRevision: number;
    resourceVisionRevision: number;
    challengeProfile?: EquipmentChallengeProfile;
    trigger: PopulationRelocationTrigger;
    ownershipToken?: object;
  }>): Promise<PopulationZonesV2ActivationDelta | null> {
    return this.startRelocation(input).completion.then((outcome) => outcome.delta);
  }

  startRelocation(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    area: GameplayAreaContract;
    relocationRevision: number;
    resourceVisionRevision: number;
    challengeProfile?: EquipmentChallengeProfile;
    trigger: PopulationRelocationTrigger;
    ownershipToken?: object;
  }>): PopulationRelocationHandle {
    const ownershipToken = input.ownershipToken ?? {};
    const visibleZoneIds = populationZonesV2IntersectingCircle(
      input.area.center,
      input.area.certifiedVisibleRadiusM
    );
    let resolveVisible!: (outcome: VisibleActivationOutcome) => void;
    const visibleReady = new Promise<VisibleActivationOutcome>((resolve) => {
      resolveVisible = resolve;
    });
    const visibleReadiness: VisibleReadiness = {
      settled: false,
      resolve: (outcome) => {
        if (visibleReadiness.settled) return;
        visibleReadiness.settled = true;
        resolveVisible(outcome);
      }
    };
    let resolvePresentation!: (outcome: VisibleActivationOutcome) => void;
    const presentationReady = new Promise<VisibleActivationOutcome>((resolve) => {
      resolvePresentation = resolve;
    });
    const presentationReadiness: VisibleReadiness = {
      settled: false,
      resolve: (outcome) => {
        if (presentationReadiness.settled) return;
        presentationReadiness.settled = true;
        resolvePresentation(outcome);
      }
    };
    const preparationGeneration = ++this.preparationGeneration;
    if (input.challengeProfile === undefined) {
      this.options.logger?.warn({
        playerId: input.playerId,
        connectionId: input.connectionId,
        connectionGeneration: input.connectionGeneration,
        relocationRevision: input.relocationRevision,
        preparationGeneration,
        trigger: input.trigger,
        zoneIds: visibleZoneIds
      }, "player-visible population activation is missing an authoritative challenge profile");
    }
    const normalizedInput = {
      ...input,
      ownershipToken,
      challengeProfile: input.challengeProfile,
      preparationGeneration
    };
    const relocation = this.runRelocation(
      normalizedInput,
      visibleReadiness,
      presentationReadiness
    );
    const completion = relocation.then(
      (delta): PopulationRelocationOutcome => {
        if (delta === null) {
          const outcome = {
            status: this.closed ? "closed" : "stale",
            delta: null,
            pendingVisibleZoneCount: pendingVisibleZoneCount(
              this.leaseOwnedBy(normalizedInput, ownershipToken),
              visibleZoneIds.length
            )
          } as const;
          visibleReadiness.resolve(outcome);
          presentationReadiness.resolve(outcome);
        }
        return {
          status: delta === null
            ? this.closed ? "closed" : "stale"
            : "completed",
          delta
        };
      },
      (error: unknown): never => {
        const lease = this.leaseOwnedBy(normalizedInput, ownershipToken);
        if (lease) {
          this.publishDelta({
            playerId: lease.playerId,
            connectionId: lease.connectionId,
            connectionGeneration: lease.connectionGeneration,
            preparationGeneration: lease.preparationGeneration,
            preparationTrigger: lease.preparationTrigger,
            relocationRevision: lease.relocationRevision,
            resourceVisionRevision: lease.resourceVisionRevision,
            gameplayViewGeneration: lease.area.generation,
            retainedZoneIds: [],
            activatedZoneIds: [],
            releasedZoneIds: [],
            withheldZoneIds: [],
            upserts: deduplicateEntities([...lease.visibleZoneIds].flatMap(
              (zoneId) => (this.cachedEntities.get(zoneId) ?? [])
                .filter(isClientPresentationalPopulationEntity)
            )),
            removedEntityIds: [],
            ...this.authorityForLease(lease),
            preparationReason: "backpressure-retry",
            preparationResult: "retryable-failure",
            partial: false,
            terminal: true
          });
        }
        const outcome = {
          status: "failed",
          delta: null,
          pendingVisibleZoneCount: pendingVisibleZoneCount(
            this.leaseOwnedBy(normalizedInput, ownershipToken),
            visibleZoneIds.length
          )
        } as const;
        visibleReadiness.resolve(outcome);
        presentationReadiness.resolve(outcome);
        throw error;
      }
    );
    return {
      visibleReady,
      presentationReady,
      completion,
      preparationGeneration,
      visibleZoneCount: visibleZoneIds.length,
      pendingVisibleZoneCount: () => pendingVisibleZoneCount(
        this.leaseOwnedBy(normalizedInput, ownershipToken),
        visibleReadiness.settled ? 0 : visibleZoneIds.length
      )
    };
  }

  private async runRelocation(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    area: GameplayAreaContract;
    relocationRevision: number;
    resourceVisionRevision: number;
    challengeProfile: EquipmentChallengeProfile | undefined;
    trigger: PopulationRelocationTrigger;
    ownershipToken: object;
    preparationGeneration: number;
  }>, visibleReadiness: VisibleReadiness,
  presentationReadiness: VisibleReadiness): Promise<PopulationZonesV2ActivationDelta | null> {
    if (this.closed) return null;
    assertRevision(input.connectionGeneration, "connection generation");
    assertRevision(input.relocationRevision, "relocation revision");
    assertRevision(input.resourceVisionRevision, "resource vision revision");
    assertGameplayAreaContract(input.area);
    const key = connectionLeaseKey(input.connectionId, input.connectionGeneration);
    this.removeSupersededConnectionGenerations(input.connectionId, input.connectionGeneration);
    const visibleZoneIds = populationZonesV2IntersectingCircle(
      input.area.center,
      input.area.certifiedVisibleRadiusM
    );
    const nextZoneIds = populationZonesV2IntersectingCircle(
      input.area.center,
      input.area.preparedRadiusM
    );
    const visibleSet = new Set(visibleZoneIds);
    const centerZoneId = populationZoneV2IdForPoint(input.area.center);
    if (this.closed) return null;
    const previous = this.leases.get(key);
    if (
      previous &&
      (
        input.relocationRevision < previous.relocationRevision ||
        input.resourceVisionRevision < previous.resourceVisionRevision
      )
    ) return null;

    if (previous) {
      this.publishPreparationTerminal(previous, "stale");
      this.resolveVisibleReadiness(previous, "stale");
      this.resolvePresentationReadiness(previous, "stale");
    }

    const oldZoneIds = previous ? sorted(previous.activeZoneIds) : [];
    const oldSet = new Set(oldZoneIds);
    const nextSet = new Set(nextZoneIds);
    const retainedZoneIds = nextZoneIds.filter((zoneId) => oldSet.has(zoneId));
    const activatedZoneIds = nextZoneIds.filter((zoneId) => !oldSet.has(zoneId));
    const releasedZoneIds = oldZoneIds.filter((zoneId) => !nextSet.has(zoneId));

    for (const zoneId of uniqueSorted([...oldZoneIds, ...nextZoneIds])) {
      const previousStage = previous?.activeZoneIds.has(zoneId)
        ? previous.visibleZoneIds.has(zoneId)
          ? "PUBLISHED" as const
          : "DURABLE_READY" as const
        : null;
      const nextStage = nextSet.has(zoneId)
        ? visibleSet.has(zoneId)
          ? "PUBLISHED" as const
          : "DURABLE_READY" as const
        : null;
      if (previousStage === nextStage) continue;
      if (previousStage !== null) {
        this.decrementStageReference(zoneId, previousStage);
        this.releaseZone(zoneId, previousStage);
      }
      if (nextStage !== null) {
        this.incrementStageReference(zoneId, nextStage);
        this.acquireZone(zoneId, nextStage);
      }
    }
    const lease: ConnectionLease = {
      ownershipToken: input.ownershipToken,
      playerId: input.playerId,
      connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration,
      preparationGeneration: input.preparationGeneration,
      preparationTrigger: input.trigger,
      preparationResult: "pending",
      preparationReason: initialPreparationReason(input.trigger),
      relocationRevision: input.relocationRevision,
      resourceVisionRevision: input.resourceVisionRevision,
      challengeProfile: input.challengeProfile,
      area: { ...input.area, center: { ...input.area.center } },
      centerZoneId,
      visibleZoneIds: visibleSet,
      activeZoneIds: nextSet,
      incompleteZoneIds: new Set([
        ...visibleZoneIds,
        ...activatedZoneIds,
        ...nextZoneIds.filter((zoneId) =>
          this.pendingActivationZones.has(zoneId)
        )
      ]),
      projectedEntityIds: new Set(previous?.projectedEntityIds ?? []),
      visibleReadiness,
      presentationReadiness,
      startedAtMs: Date.now(),
      lastProgressAtMs: Date.now(),
      recoveryAttempt: 0,
      staleTimer: null,
      terminalTimer: null,
      terminalDelta: null
    };
    this.leases.set(key, lease);
    this.armVisiblePreparationWatchdog(lease);
    this.synchronizeZoneReferences([
      ...activatedZoneIds,
      ...releasedZoneIds
    ]);

    const releasedEntityIds = uniqueSorted(releasedZoneIds.flatMap(
      (zoneId) => (this.cachedEntities.get(zoneId) ?? [])
        .filter(isClientPresentationalPopulationEntity)
        .map((entity) => entity.entityId)
    ));
    const stages = [
      {
        zoneIds: visibleZoneIds,
        priority: 0 as const,
        targetStage: "SIMULATION_READY" as const
      },
      {
        zoneIds: activatedZoneIds.filter((zoneId) => !visibleSet.has(zoneId)),
        priority: 2 as const,
        targetStage: "DURABLE_READY" as const
      }
    ].filter((stage) => stage.zoneIds.length > 0);
    const allResults: PopulationZoneV2BackendZoneActivation[] = [];
    const allRemovedEntityIds = [...releasedEntityIds];
    const publicationState: {
      lastDelta: PopulationZonesV2ActivationDelta | null;
    } = { lastDelta: null };

    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      const stage = stages[stageIndex]!;
      const orderedStageZoneIds = prioritizedActivationZoneIds(
        stage.zoneIds,
        input.area.center,
        centerZoneId
      );
      const activationPromises = orderedStageZoneIds.map((zoneId, activationOrder) => {
        const cached = this.cachedEntities.get(zoneId);
        if (
          cached
          && !this.pendingActivationZones.has(zoneId)
          && !this.sleepInFlightZones.has(zoneId)
          && (
            stage.targetStage !== "SIMULATION_READY"
            || input.challengeProfile !== undefined
          )
          && populationStageAtLeast(
            this.completedStageByZone.get(zoneId) ?? null,
            stage.targetStage
          )
        ) {
          return {
            zoneId,
            promise: Promise.resolve<PopulationZoneV2BackendZoneActivation>({
              zoneId,
              generationId: this.cachedGenerations.get(zoneId) ?? null,
              materializationStatus: "materialization-current",
              status: "ready",
              entities: cached,
              removedEntityIds: [],
              spawnedRuntimeActors: 0,
              completedStage: this.completedStageByZone.get(zoneId)!,
              reason: "ready",
              authority: null
            })
          };
        }
        return {
          zoneId,
          promise: this.requestActivation(zoneId, {
            trigger: input.trigger,
            relocationRevision: input.relocationRevision,
            resourceVisionRevision: input.resourceVisionRevision,
            priority: stage.priority,
            challengeProfile: input.challengeProfile,
            targetStage: stage.targetStage,
            activateRuntime: stage.targetStage === "SIMULATION_READY",
            activationOrder
          })
        };
      });

      if (stageIndex === 0) {
        let releasedPublished = false;
        const activationResults = await Promise.all(
          activationPromises.map(async ({ zoneId, promise }) => {
            let result: PopulationZoneV2BackendZoneActivation;
            try {
              result = await promise;
            } catch (error) {
              if (this.closed) throw error;
              if (this.isCurrentLease(key, lease)) {
                this.recordZoneActivationFailure(lease, zoneId, error);
              }
              return null;
            }
            if (!this.isCurrentLease(key, lease)) return result;
            allRemovedEntityIds.push(...(result.removedEntityIds ?? []));
            if (result.status === "ready") {
              this.markZoneReadyForLease(lease, result.zoneId);
            }
            const upserts = visibleEntitiesForLease(
              lease,
              [result]
            );
            const terminal = !hasIncompleteVisibleZones(lease);
            const authoritativeVisibleEntityIds = terminal
              ? new Set([...lease.visibleZoneIds].flatMap((zoneId) =>
                  (this.cachedEntities.get(zoneId) ?? [])
                    .filter((entity) =>
                      isClientPresentationalPopulationEntity(entity)
                      && greatCircleDistanceMeters(
                        lease.area.center,
                        entity.position
                      ) <= lease.area.certifiedVisibleRadiusM
                    )
                    .map((entity) => entity.entityId)
                ))
              : null;
            const staleProjectedEntityIds = terminal
              ? [...lease.projectedEntityIds].filter((entityId) =>
                  !authoritativeVisibleEntityIds!.has(entityId)
                )
              : [];
            const removedEntityIds = uniqueSorted([
              ...(releasedPublished ? [] : releasedEntityIds),
              ...staleProjectedEntityIds,
              ...(result.removedEntityIds ?? [])
            ]);
            const delta: PopulationZonesV2ActivationDelta = {
              playerId: input.playerId,
              connectionId: input.connectionId,
              connectionGeneration: input.connectionGeneration,
              preparationGeneration: input.preparationGeneration,
              preparationTrigger: input.trigger,
              relocationRevision: input.relocationRevision,
              resourceVisionRevision: input.resourceVisionRevision,
              gameplayViewGeneration: input.area.generation,
              retainedZoneIds: retainedZoneIds.filter((zoneId) =>
                zoneId === result.zoneId
              ),
              activatedZoneIds: activatedZoneIds.filter((zoneId) =>
                zoneId === result.zoneId
              ),
              releasedZoneIds: releasedPublished ? [] : releasedZoneIds,
              withheldZoneIds: [],
              upserts,
              removedEntityIds,
              ...this.authorityForLease(lease, [result.zoneId]),
              preparationReason: result.reason ?? lease.preparationReason,
              preparationResult: terminal ? "ready" : "pending",
              partial: !terminal,
              terminal
            };
            releasedPublished = true;
            for (const entityId of removedEntityIds) {
              lease.projectedEntityIds.delete(entityId);
            }
            for (const entity of upserts) {
              lease.projectedEntityIds.add(entity.entityId);
            }
            this.traceDelta(delta, input.trigger);
            lease.preparationReason = delta.preparationReason;
            this.publishDelta(delta);
            publicationState.lastDelta = delta;
            if (result.status === "ready") {
              this.resolveVisibleReadiness(lease, "ready", delta);
              if (delta.terminal) {
                this.resolvePresentationReadiness(lease, "ready", delta);
              }
            }
            return result;
          })
        );
        if (!this.isCurrentLease(key, lease)) return null;
        const successfulResults = activationResults.filter(
          (result): result is PopulationZoneV2BackendZoneActivation =>
            result !== null
        );
        allResults.push(...successfulResults);
        if (successfulResults.some((result) =>
          result.status === "pending"
          && result.reason === "plan-terminal-failure"
        )) {
          this.failStalledVisiblePreparation(
            lease,
            "plan-terminal-failure"
          );
          publicationState.lastDelta = lease.terminalDelta;
          break;
        }
        if (publicationState.lastDelta === null) {
          const incompleteZoneIds = sorted([...lease.visibleZoneIds].filter(
            (zoneId) => lease.incompleteZoneIds.has(zoneId)
          ));
          const readyVisibleZoneIds = [...lease.visibleZoneIds].filter(
            (zoneId) => !lease.incompleteZoneIds.has(zoneId)
          );
          const pendingDelta: PopulationZonesV2ActivationDelta = {
            playerId: lease.playerId,
            connectionId: lease.connectionId,
            connectionGeneration: lease.connectionGeneration,
            preparationGeneration: lease.preparationGeneration,
            preparationTrigger: lease.preparationTrigger,
            relocationRevision: lease.relocationRevision,
            resourceVisionRevision: lease.resourceVisionRevision,
            gameplayViewGeneration: lease.area.generation,
            retainedZoneIds: retainedZoneIds.filter((zoneId) =>
              !lease.incompleteZoneIds.has(zoneId)
            ),
            activatedZoneIds: activatedZoneIds.filter((zoneId) =>
              !lease.incompleteZoneIds.has(zoneId)
            ),
            releasedZoneIds,
            withheldZoneIds: incompleteZoneIds,
            upserts: deduplicateEntities(readyVisibleZoneIds.flatMap(
              (zoneId) => (this.cachedEntities.get(zoneId) ?? []).filter(
                (entity) =>
                  isClientPresentationalPopulationEntity(entity)
                  && greatCircleDistanceMeters(
                    lease.area.center,
                    entity.position
                  ) <= lease.area.certifiedVisibleRadiusM
              )
            )),
            removedEntityIds: uniqueSorted(allRemovedEntityIds),
            ...this.authorityForLease(lease),
            preparationReason: "backpressure-retry",
            preparationResult: "pending",
            partial: true,
            terminal: false
          };
          for (const entityId of pendingDelta.removedEntityIds) {
            lease.projectedEntityIds.delete(entityId);
          }
          for (const entity of pendingDelta.upserts) {
            lease.projectedEntityIds.add(entity.entityId);
          }
          this.traceDelta(pendingDelta, input.trigger);
          lease.preparationReason = pendingDelta.preparationReason;
          this.publishDelta(pendingDelta);
          publicationState.lastDelta = pendingDelta;
        }
        continue;
      }

      const settledActivations = await Promise.allSettled(
        activationPromises.map(({ promise }) => promise)
      );
      if (!this.isCurrentLease(key, lease)) return null;
      const activationResults: PopulationZoneV2BackendZoneActivation[] = [];
      settledActivations.forEach((result, index) => {
        if (result.status === "fulfilled") {
          activationResults.push(result.value);
          return;
        }
        const zoneId = activationPromises[index]?.zoneId;
        if (zoneId) this.recordZoneActivationFailure(lease, zoneId, result.reason);
      });
      allResults.push(...activationResults);
      for (const result of activationResults) {
        if (result.status === "ready") {
          this.markZoneReadyForLease(lease, result.zoneId);
        }
      }
    }

    if (!this.isCurrentLease(key, lease)) return null;
    const completedDelta = publicationState.lastDelta;
    if (completedDelta === null) return null;
    return {
      ...completedDelta,
      retainedZoneIds,
      activatedZoneIds,
      releasedZoneIds,
      upserts: visibleEntitiesForLease(lease, allResults),
      removedEntityIds: uniqueSorted(allRemovedEntityIds),
      ...this.authorityForLease(lease)
    };
  }

  async notifyZoneReady(zoneId: PopulationZoneV2Id): Promise<void> {
    await this.refreshWarmZone(zoneId, "plan-ready");
  }

  notifyZoneFailed(
    zoneId: PopulationZoneV2Id,
    outcome: "terminal-failure" | "cancelled"
  ): void {
    for (const lease of this.leases.values()) {
      if (
        !lease.visibleZoneIds.has(zoneId) ||
        !lease.incompleteZoneIds.has(zoneId) ||
        lease.terminalDelta
      ) continue;
      if (outcome === "terminal-failure") {
        this.failStalledVisiblePreparation(lease, "plan-terminal-failure");
      } else {
        this.publishPreparationTerminal(lease, "cancelled");
        this.resolveVisibleReadiness(lease, "closed");
        this.resolvePresentationReadiness(lease, "closed");
      }
    }
  }

  private async refreshWarmZone(
    zoneId: PopulationZoneV2Id,
    trigger: "plan-ready" | "explicit-relocation"
  ): Promise<void> {
    if (this.closed || (this.refCounts.get(zoneId) ?? 0) === 0) return;
    this.pendingActivationZones.delete(zoneId);
    const previousEntityIds = new Set(
      (this.cachedEntities.get(zoneId) ?? [])
        .filter(isClientPresentationalPopulationEntity)
        .map((entity) => entity.entityId)
    );
    const visible = [...this.leases.values()].some((lease) =>
      lease.visibleZoneIds.has(zoneId)
    );
    const context = {
      trigger,
      relocationRevision: 0,
      resourceVisionRevision: 0,
      challengeProfile: strongestChallengeProfileForZone(
        this.leases.values(),
        zoneId
      ),
      priority: visible ? 0 : 2,
      targetStage: visible ? "SIMULATION_READY" : "DURABLE_READY",
      activateRuntime: visible
    } as const;
    const activation =
      trigger === "plan-ready" &&
      context.priority === 0 &&
      !this.activationInFlight.has(zoneId) &&
      !this.activationRequests.has(zoneId)
        ? await this.requestPriorityActivation(zoneId, context)
        : await this.requestActivation(zoneId, context);
    if (this.closed || activation.status !== "ready") return;
    this.cachedGenerations.set(zoneId, activation.generationId);
    const currentEntityIds = new Set(
      activation.entities
        .filter(isClientPresentationalPopulationEntity)
        .map((entity) => entity.entityId)
    );
    const removedEntityIds = uniqueSorted([
      ...(activation.removedEntityIds ?? []),
      ...previousEntityIds
    ])
      .filter((entityId) => !currentEntityIds.has(entityId))
      .sort();
    for (const lease of this.leases.values()) {
      if (!lease.activeZoneIds.has(zoneId)) continue;
      this.markZoneReadyForLease(lease, zoneId);
      if (!lease.visibleZoneIds.has(zoneId)) continue;
      const upserts = visibleEntitiesForLease(lease, [activation]);
      const priorProjectedIds = [...previousEntityIds].filter((entityId) =>
        lease.projectedEntityIds.has(entityId)
      );
      const projectedIds = new Set(upserts.map((entity) => entity.entityId));
      const leaseRemovedEntityIds = uniqueSorted([
        ...removedEntityIds,
        ...priorProjectedIds.filter((entityId) => !projectedIds.has(entityId))
      ]);
      for (const entityId of priorProjectedIds) lease.projectedEntityIds.delete(entityId);
      for (const entity of upserts) lease.projectedEntityIds.add(entity.entityId);
      const delta: PopulationZonesV2ActivationDelta = {
        playerId: lease.playerId,
        connectionId: lease.connectionId,
        connectionGeneration: lease.connectionGeneration,
        preparationGeneration: lease.preparationGeneration,
        preparationTrigger: lease.preparationTrigger,
        relocationRevision: lease.relocationRevision,
        resourceVisionRevision: lease.resourceVisionRevision,
        gameplayViewGeneration: lease.area.generation,
        retainedZoneIds: [zoneId],
        activatedZoneIds: [],
        releasedZoneIds: [],
        withheldZoneIds: sorted(lease.incompleteZoneIds),
        upserts,
        removedEntityIds: leaseRemovedEntityIds,
        ...this.authorityForLease(lease),
        preparationReason: activation.reason ?? lease.preparationReason,
        preparationResult: hasIncompleteVisibleZones(lease) ? "pending" : "ready",
        partial: hasIncompleteVisibleZones(lease),
        terminal: !hasIncompleteVisibleZones(lease)
      };
      this.traceDelta(delta, trigger);
      lease.preparationReason = delta.preparationReason;
      this.publishDelta(delta);
      if (delta.terminal) {
        this.resolveVisibleReadiness(lease, "ready", delta);
        this.resolvePresentationReadiness(lease, "ready", delta);
      }
    }
  }

  republishConnection(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    preparationGeneration: number;
    relocationRevision: number;
    resourceVisionRevision: number;
  }>): PopulationConnectionRepublishResult {
    const lease = this.leases.get(connectionLeaseKey(
      input.connectionId,
      input.connectionGeneration
    ));
    if (!lease || lease.playerId !== input.playerId) {
      return { status: "missing", state: null };
    }
    const requestIsFromCurrentOrOlderOperation =
      input.relocationRevision <= lease.relocationRevision &&
      input.resourceVisionRevision <= lease.resourceVisionRevision &&
      input.preparationGeneration <= lease.preparationGeneration;
    if (!requestIsFromCurrentOrOlderOperation) {
      return { status: "missing", state: this.connectionPreparationState(lease) };
    }
    if (lease.terminalDelta) {
      this.publishDelta(lease.terminalDelta);
      return {
        status: lease.preparationResult === "retryable-failure"
          ? "retry-required"
          : "republished",
        state: this.connectionPreparationState(lease)
      };
    }
    const incomplete = hasIncompleteVisibleZones(lease);
    const preparationResult = incomplete ? "pending" : "ready";
    this.publishDelta({
      playerId: lease.playerId,
      connectionId: lease.connectionId,
      connectionGeneration: lease.connectionGeneration,
      preparationGeneration: lease.preparationGeneration,
      preparationTrigger: lease.preparationTrigger,
      relocationRevision: lease.relocationRevision,
      resourceVisionRevision: lease.resourceVisionRevision,
      gameplayViewGeneration: lease.area.generation,
      retainedZoneIds: sorted(lease.activeZoneIds),
      activatedZoneIds: [],
      releasedZoneIds: [],
      withheldZoneIds: sorted(lease.incompleteZoneIds),
      upserts: deduplicateEntities([...lease.visibleZoneIds].flatMap(
        (zoneId) => (this.cachedEntities.get(zoneId) ?? []).filter((entity) =>
          isClientPresentationalPopulationEntity(entity)
          && greatCircleDistanceMeters(lease.area.center, entity.position) <=
              lease.area.certifiedVisibleRadiusM
        )
      )),
      removedEntityIds: [],
      ...this.authorityForLease(lease),
      preparationReason: lease.preparationReason,
      preparationResult,
      partial: incomplete,
      terminal: !incomplete
    });
    return {
      status: "republished",
      state: this.connectionPreparationState(lease)
    };
  }

  releaseConnection(
    connectionId: string,
    connectionGeneration?: number,
    expectedLease?: Readonly<{
      relocationRevision: number;
      resourceVisionRevision: number;
      ownershipToken: object;
    }>
  ): void {
    const releasedZoneIds = new Set<PopulationZoneV2Id>();
    for (const [key, lease] of this.leases) {
      if (
        lease.connectionId !== connectionId ||
        (connectionGeneration !== undefined &&
          lease.connectionGeneration !== connectionGeneration) ||
        (expectedLease !== undefined &&
          (
            lease.relocationRevision !== expectedLease.relocationRevision ||
            lease.resourceVisionRevision !==
              expectedLease.resourceVisionRevision ||
            lease.ownershipToken !== expectedLease.ownershipToken
          ))
      ) continue;
      this.publishPreparationTerminal(lease, "cancelled");
      this.resolveVisibleReadiness(lease, "stale");
      this.resolvePresentationReadiness(lease, "stale");
      this.leases.delete(key);
      for (const zoneId of lease.activeZoneIds) {
        this.decrementStageReference(
          zoneId,
          lease.visibleZoneIds.has(zoneId)
            ? "PUBLISHED"
            : "DURABLE_READY"
        );
        this.releaseZone(
          zoneId,
          lease.visibleZoneIds.has(zoneId)
            ? "PUBLISHED"
            : "DURABLE_READY"
        );
        releasedZoneIds.add(zoneId);
      }
    }
    this.synchronizeZoneReferences([...releasedZoneIds]);
  }

  snapshot(): Readonly<{
    connectionLeases: number;
    streamingSourceLeases: number;
    referencedZones: number;
    warmZones: number;
    simulationResidentZones: number;
    descriptorCacheZones: number;
    descriptorCacheBytes: number;
    descriptorCacheMaxZones: number;
    descriptorCacheMaxBytes: number;
    descriptorCacheTtlMs: number;
    descriptorCacheHits: number;
    descriptorCacheMisses: number;
    descriptorCacheInvalidations: number;
    descriptorCacheEvictions: number;
    descriptorCacheZoneIds: readonly PopulationZoneV2Id[];
    indexedEntities: number;
    harvestedTreeFences: number;
    projectedEntities: number;
    pendingPlanZones: number;
    pendingActivationZones: number;
    activationRequests: number;
    activationWaiters: number;
    activationInFlight: number;
    priorityActivationFlights: number;
    pendingSleepZones: number;
    sleepInFlightZones: number;
    incompleteActivationZones: number;
    incompleteRequiredVisiblePreparations: number;
    optionalBackgroundPendingZones: number;
    retryingRequiredVisiblePreparations: number;
    terminalFailedRequiredVisiblePreparations: number;
    strandedRequiredVisiblePreparations: number;
    lateVisiblePopulation: number;
    sleepGraceMs: number;
    refCounts: Readonly<Record<string, number>>;
    simulationRefCounts: Readonly<Record<string, number>>;
    stageRefCountsByZone: Readonly<Record<
      string,
      Partial<Record<PopulationPreparationStage, number>>
    >>;
    lastDeltaEntityCountByZone: Readonly<Record<string, number>>;
    lastPublishedRevisionByZone: Readonly<Record<string, number>>;
    distanceFromPlayerMByZone: Readonly<Record<string, number>>;
    materializationStatusByZone: Readonly<Record<
      string,
      PopulationZoneV2BackendZoneActivation["materializationStatus"]
    >>;
    completedStageByZone: Readonly<
      Record<string, Exclude<PopulationPreparationStage, "PUBLISHED">>
    >;
    centerZoneIds: readonly PopulationZoneV2Id[];
  }> {
    this.pruneDurableDescriptorCache(Date.now());
    const distanceFromPlayerMByZone = new Map<PopulationZoneV2Id, number>();
    for (const lease of this.leases.values()) {
      for (const zoneId of lease.activeZoneIds) {
        const distance = greatCircleDistanceMeters(
          lease.area.center,
          populationZoneV2Geometry(zoneId).center
        );
        distanceFromPlayerMByZone.set(
          zoneId,
          Math.min(distance, distanceFromPlayerMByZone.get(zoneId) ?? Infinity)
        );
      }
    }
    const incompleteRequiredLeases = [...this.leases.values()].filter((lease) =>
      hasIncompleteVisibleZones(lease)
    );
    const optionalBackgroundPendingZones = new Set(
      [...this.leases.values()].flatMap((lease) =>
        [...lease.incompleteZoneIds].filter((zoneId) =>
          !lease.visibleZoneIds.has(zoneId)
        )
      )
    ).size;
    const hasRecoverableVisibleWork = (lease: ConnectionLease): boolean =>
      lease.staleTimer !== null ||
      lease.terminalTimer !== null ||
      [...lease.visibleZoneIds].some((zoneId) =>
        lease.incompleteZoneIds.has(zoneId) &&
        (
          this.pendingActivationZones.has(zoneId) ||
          this.activationInFlight.has(zoneId) ||
          (this.activationRequests.get(zoneId)?.length ?? 0) > 0
        )
      );
    return {
      connectionLeases: this.leases.size,
      streamingSourceLeases: this.streamingSourceLeases.size,
      referencedZones: [...this.refCounts.values()].filter((count) => count > 0).length,
      warmZones: new Set([
        ...this.cachedEntities.keys(),
        ...this.descriptorCache.keys()
      ]).size,
      simulationResidentZones: this.simulationResidentZones.size,
      descriptorCacheZones: this.descriptorCache.size,
      descriptorCacheBytes: this.descriptorCacheBytes,
      descriptorCacheMaxZones:
        this.options.descriptorCacheMaxZones
        ?? POPULATION_V2_DESCRIPTOR_CACHE_MAX_ZONES,
      descriptorCacheMaxBytes:
        this.options.descriptorCacheMaxBytes
        ?? POPULATION_V2_DESCRIPTOR_CACHE_MAX_BYTES,
      descriptorCacheTtlMs:
        this.options.descriptorCacheTtlMs
        ?? POPULATION_V2_DESCRIPTOR_CACHE_TTL_MS,
      descriptorCacheHits: this.descriptorCacheHits,
      descriptorCacheMisses: this.descriptorCacheMisses,
      descriptorCacheInvalidations: this.descriptorCacheInvalidations,
      descriptorCacheEvictions: this.descriptorCacheEvictions,
      descriptorCacheZoneIds: sorted(this.descriptorCache.keys()),
      indexedEntities: this.zoneIdByEntityId.size,
      harvestedTreeFences: this.harvestedTreeFences.size,
      projectedEntities: new Set(
        [...this.leases.values()].flatMap((lease) =>
          [...lease.projectedEntityIds]
        )
      ).size,
      pendingPlanZones: [...this.pendingActivationZones].filter((zoneId) =>
        this.materializationStatusByZone.get(zoneId) === "generation-missing"
      ).length,
      pendingActivationZones: this.pendingActivationZones.size,
      activationRequests: [...this.activationRequests.values()].reduce(
        (total, requests) => total + requests.length,
        0
      ),
      activationWaiters: this.activationWaiters.size,
      activationInFlight: this.activationInFlight.size,
      priorityActivationFlights: this.priorityActivationFlights.size,
      pendingSleepZones: this.pendingSleepZones.size,
      sleepInFlightZones: this.sleepInFlightZones.size,
      incompleteActivationZones: new Set(
        [...this.leases.values()].flatMap((lease) =>
          [...lease.incompleteZoneIds]
        )
      ).size,
      incompleteRequiredVisiblePreparations:
        incompleteRequiredLeases.length,
      optionalBackgroundPendingZones,
      retryingRequiredVisiblePreparations:
        incompleteRequiredLeases.filter((lease) =>
          lease.preparationResult === "pending" &&
          lease.recoveryAttempt > 0
        ).length,
      terminalFailedRequiredVisiblePreparations:
        incompleteRequiredLeases.filter((lease) =>
          lease.preparationResult === "retryable-failure"
        ).length,
      strandedRequiredVisiblePreparations:
        incompleteRequiredLeases.filter((lease) =>
          lease.preparationResult === "pending" &&
          !hasRecoverableVisibleWork(lease)
        ).length,
      lateVisiblePopulation: this.lateVisiblePopulation,
      sleepGraceMs:
        this.options.sleepGraceMs ?? POPULATION_V2_SLEEP_GRACE_MS,
      refCounts: Object.fromEntries([...this.refCounts].sort(([left], [right]) =>
        left.localeCompare(right)
      )),
      simulationRefCounts: Object.fromEntries(
        [...this.simulationRefCounts].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      stageRefCountsByZone: Object.fromEntries(
        [...this.stageRefCountsByZone]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([zoneId, counts]) => [
            zoneId,
            Object.fromEntries(counts)
          ])
      ),
      lastDeltaEntityCountByZone: Object.fromEntries(
        [...this.lastDeltaEntityCountByZone].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      lastPublishedRevisionByZone: Object.fromEntries(
        [...this.lastPublishedRevisionByZone].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      distanceFromPlayerMByZone: Object.fromEntries(
        [...distanceFromPlayerMByZone]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([zoneId, distance]) => [
            zoneId,
            Math.round(distance * 100) / 100
          ] as const)
      ),
      materializationStatusByZone: Object.fromEntries(
        [...this.materializationStatusByZone].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      completedStageByZone: Object.fromEntries(
        [...this.completedStageByZone].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      centerZoneIds: [...new Set([...this.leases.values()].map((lease) =>
        lease.centerZoneId
      ))].sort()
    };
  }

  telemetrySnapshot(): ReadonlyArray<Readonly<{
    zoneId: string;
    entityCategory: string;
    readyAliveCount: number;
    activeRuntimeCount: number;
    sleepingCount: number;
    visibleCount: number;
  }>> {
    const visibleEntityIds = new Set(
      [...this.leases.values()].flatMap((lease) => [...lease.projectedEntityIds])
    );
    const rows: Array<{
      zoneId: string;
      entityCategory: string;
      readyAliveCount: number;
      activeRuntimeCount: number;
      sleepingCount: number;
      visibleCount: number;
    }> = [];
    for (const [zoneId, entities] of this.cachedEntities) {
      const active = (this.refCounts.get(zoneId) ?? 0) > 0;
      const categories = new Map<string, Set<string>>();
      const visibleByCategory = new Map<string, Set<string>>();
      const wolfPackMembers = new Map<string, Set<string>>();
      const add = (
        category: string,
        identity: string,
        entityVisible: boolean
      ): void => {
        const identities = categories.get(category) ?? new Set<string>();
        identities.add(identity);
        categories.set(category, identities);
        if (entityVisible) {
          const visible = visibleByCategory.get(category) ?? new Set<string>();
          visible.add(identity);
          visibleByCategory.set(category, visible);
        }
      };
      for (const entity of entities) {
        const entityVisible = visibleEntityIds.has(entity.entityId);
        add(entity.kind, entity.entityId, entityVisible);
        add(`archetype:${entity.archetype}`, entity.entityId, entityVisible);
        if (isWolfFamilyArchetype(entity.kind) && entity.packId) {
          add("wolf_pack", entity.packId, entityVisible);
          const members = wolfPackMembers.get(entity.packId) ?? new Set<string>();
          members.add(entity.entityId);
          wolfPackMembers.set(entity.packId, members);
        }
        if (entity.kind === "tree" && isGivingTreeResinCapable(entity.entityId)) {
          add("resin_capable_tree", entity.entityId, entityVisible);
          if (entity.resinAvailable === false) {
            add("resin_harvested_tree", entity.entityId, entityVisible);
          } else {
            add("resin_available_tree", entity.entityId, entityVisible);
          }
        }
        if (["stone", "coal", "iron"].includes(entity.kind)) {
          add(`permanent_${entity.kind}_mine`, entity.entityId, entityVisible);
        }
      }
      for (const [packId, members] of wolfPackMembers) {
        if (members.size >= 2 && members.size <= 4) {
          add(`wolf_pack_${members.size}_member`, packId, [...members].some((id) =>
            visibleEntityIds.has(id)
          ));
        }
      }
      for (const [entityCategory, identities] of categories) {
        rows.push({
          zoneId,
          entityCategory,
          readyAliveCount: identities.size,
          activeRuntimeCount: active ? identities.size : 0,
          sleepingCount: active ? 0 : identities.size,
          visibleCount: visibleByCategory.get(entityCategory)?.size ?? 0
        });
      }
    }
    return rows.sort((left, right) =>
      left.zoneId.localeCompare(right.zoneId)
      || left.entityCategory.localeCompare(right.entityCategory)
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closePromise = this.closeOpenRuntime();
    this.closePromise = closePromise;
    return closePromise;
  }

  private async closeOpenRuntime(): Promise<void> {
    this.closed = true;
    for (const timer of this.sleepTimers.values()) clearTimeout(timer);
    this.sleepTimers.clear();
    if (this.sleepFlushTimer) clearTimeout(this.sleepFlushTimer);
    this.sleepFlushTimer = null;
    const closedError = new Error("population v2 runtime is closed");
    for (const request of [...this.activationWaiters]) {
      this.rejectActivationRequest(request, closedError);
    }
    this.activationRequests.clear();
    await Promise.allSettled([...this.priorityActivationFlights]);
    await Promise.all([
      this.activationWorkTail,
      this.sleepWorkTail
    ]);
    for (const lease of this.leases.values()) {
      this.publishPreparationTerminal(lease, "cancelled");
      this.resolveVisibleReadiness(lease, "closed");
      this.resolvePresentationReadiness(lease, "closed");
    }
    this.leases.clear();
    this.refCounts.clear();
    this.simulationRefCounts.clear();
    this.simulationResidentZones.clear();
    this.stageRefCountsByZone.clear();
    this.streamingSourceLeases.clear();
    this.unreferencedAtByZone.clear();
    const warmZoneIds = sorted(this.cachedEntities.keys());
    this.cachedEntities.clear();
    this.cachedGenerations.clear();
    this.completedStageByZone.clear();
    this.authorityByZone.clear();
    this.descriptorCache.clear();
    this.descriptorCacheBytes = 0;
    this.zoneIdByEntityId.clear();
    this.harvestedTreeFences.clear();
    this.pendingActivationZones.clear();
    this.materializationStatusByZone.clear();
    this.zoneOwnershipTokens.clear();
    this.pendingSleepZones.clear();
    this.sleepInFlightZones.clear();
    this.sleepFlightsByZone.clear();
    this.lastDeltaEntityCountByZone.clear();
    this.lastPublishedRevisionByZone.clear();
    if (warmZoneIds.length > 0) {
      await this.backend.sleepZones({ zoneIds: warmZoneIds });
    }
    this.deltaListeners.clear();
  }

  private removeSupersededConnectionGenerations(
    connectionId: string,
    currentGeneration: number
  ): void {
    for (const lease of [...this.leases.values()]) {
      if (
        lease.connectionId === connectionId &&
        lease.connectionGeneration !== currentGeneration
      ) this.releaseConnection(connectionId, lease.connectionGeneration);
    }
  }

  private zoneOwnershipToken(zoneId: PopulationZoneV2Id): object {
    const existing = this.zoneOwnershipTokens.get(zoneId);
    if (existing) return existing;
    const token = {};
    this.zoneOwnershipTokens.set(zoneId, token);
    return token;
  }

  private invalidateZoneOwnership(zoneId: PopulationZoneV2Id): void {
    this.zoneOwnershipTokens.set(zoneId, {});
    this.authorityByZone.delete(zoneId);
  }

  private acquireZone(
    zoneId: PopulationZoneV2Id,
    stage: Exclude<PopulationPreparationStage, "PLAN_READY">
  ): void {
    if (isSimulationStage(stage)) {
      const timer = this.sleepTimers.get(zoneId);
      if (timer) {
        clearTimeout(timer);
        this.sleepTimers.delete(zoneId);
      }
      this.sleepGenerations.set(
        zoneId,
        (this.sleepGenerations.get(zoneId) ?? 0) + 1
      );
      this.simulationRefCounts.set(
        zoneId,
        (this.simulationRefCounts.get(zoneId) ?? 0) + 1
      );
    }
    this.unreferencedAtByZone.delete(zoneId);
    this.refCounts.set(zoneId, (this.refCounts.get(zoneId) ?? 0) + 1);
  }

  private incrementStageReference(
    zoneId: PopulationZoneV2Id,
    stage: PopulationPreparationStage
  ): void {
    const counts = this.stageRefCountsByZone.get(zoneId) ?? new Map();
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
    this.stageRefCountsByZone.set(zoneId, counts);
  }

  private decrementStageReference(
    zoneId: PopulationZoneV2Id,
    stage: PopulationPreparationStage
  ): void {
    const counts = this.stageRefCountsByZone.get(zoneId);
    if (!counts) return;
    const next = Math.max(0, (counts.get(stage) ?? 0) - 1);
    if (next === 0) counts.delete(stage);
    else counts.set(stage, next);
    if (counts.size === 0) this.stageRefCountsByZone.delete(zoneId);
  }

  private releaseZone(
    zoneId: PopulationZoneV2Id,
    stage: Exclude<PopulationPreparationStage, "PLAN_READY">
  ): void {
    const next = Math.max(0, (this.refCounts.get(zoneId) ?? 0) - 1);
    if (next > 0) {
      this.refCounts.set(zoneId, next);
    } else {
      this.refCounts.delete(zoneId);
      this.unreferencedAtByZone.set(zoneId, Date.now());
    }
    if (!isSimulationStage(stage)) return;
    const nextSimulation = Math.max(
      0,
      (this.simulationRefCounts.get(zoneId) ?? 0) - 1
    );
    if (nextSimulation > 0) {
      this.simulationRefCounts.set(zoneId, nextSimulation);
      return;
    }
    this.simulationRefCounts.delete(zoneId);
    this.scheduleZoneSleep(zoneId);
  }

  private scheduleZoneSleep(zoneId: PopulationZoneV2Id): void {
    if (this.sleepTimers.has(zoneId)) return;
    const generation = (this.sleepGenerations.get(zoneId) ?? 0) + 1;
    this.sleepGenerations.set(zoneId, generation);
    const timer = setTimeout(() => {
      this.sleepTimers.delete(zoneId);
      this.requestSleep(zoneId, generation);
    }, this.options.sleepGraceMs ?? POPULATION_V2_SLEEP_GRACE_MS);
    timer.unref?.();
    this.sleepTimers.set(zoneId, timer);
  }

  private synchronizeZoneReferences(
    zoneIds: readonly PopulationZoneV2Id[]
  ): void {
    if (zoneIds.length === 0) return;
    const uniqueZoneIds = sorted(new Set(zoneIds));
    this.backend.updateZoneReferences?.({
      currentReferencesByZone: Object.fromEntries(uniqueZoneIds.map((zoneId) => [
        zoneId,
        this.refCounts.get(zoneId) ?? 0
      ])),
      unreferencedAtByZone: Object.fromEntries(uniqueZoneIds.flatMap((zoneId) => {
        const unreferencedAt = this.unreferencedAtByZone.get(zoneId);
        return unreferencedAt === undefined
          ? []
          : [[zoneId, unreferencedAt] as const];
      }))
    });
  }

  private requestSleep(
    zoneId: PopulationZoneV2Id,
    generation: number
  ): void {
    if (
      this.closed ||
      (this.simulationRefCounts.get(zoneId) ?? 0) > 0 ||
      this.sleepGenerations.get(zoneId) !== generation
    ) return;
    this.pendingSleepZones.set(zoneId, generation);
    this.scheduleSleepFlush();
  }

  private async flushSleepRequests(): Promise<void> {
    const requested = new Map(this.pendingSleepZones);
    this.pendingSleepZones.clear();
    const zoneIds = sorted([...requested].filter(([zoneId, generation]) =>
      (this.simulationRefCounts.get(zoneId) ?? 0) === 0 &&
      this.sleepGenerations.get(zoneId) === generation
    ).map(([zoneId]) => zoneId));
    if (zoneIds.length === 0) return;
    const flight = this.sleepZones(zoneIds, requested);
    for (const zoneId of zoneIds) {
      this.sleepFlightsByZone.set(zoneId, flight);
    }
    try {
      await flight;
    } finally {
      for (const zoneId of zoneIds) {
        if (this.sleepFlightsByZone.get(zoneId) === flight) {
          this.sleepFlightsByZone.delete(zoneId);
        }
      }
      if (!this.closed && this.hasFlushableActivationRequests()) {
        this.scheduleActivationFlush();
      }
    }
  }

  private async sleepZones(
    zoneIds: readonly PopulationZoneV2Id[],
    requested: ReadonlyMap<PopulationZoneV2Id, number>
  ): Promise<void> {
    const currentZoneIds = zoneIds.filter((zoneId) =>
      !this.closed
      && (this.simulationRefCounts.get(zoneId) ?? 0) === 0
      && this.sleepGenerations.get(zoneId) === requested.get(zoneId)
    );
    if (currentZoneIds.length === 0) return;
    const removedEntityCount = currentZoneIds.reduce(
      (total, zoneId) => total + (this.cachedEntities.get(zoneId)?.length ?? 0),
      0
    );
    for (const zoneId of currentZoneIds) this.sleepInFlightZones.add(zoneId);
    let result: Awaited<
      ReturnType<PopulationZonesV2RuntimeBackend["sleepZones"]>
    >;
    try {
      result = await this.backend.sleepZones({
        zoneIds: currentZoneIds,
        currentReferencesByZone: Object.fromEntries(
          currentZoneIds.map((zoneId) => [
            zoneId,
            this.refCounts.get(zoneId) ?? 0
          ])
        ),
        unreferencedAtByZone: Object.fromEntries(
          currentZoneIds.flatMap((zoneId) => {
            const unreferencedAt = this.unreferencedAtByZone.get(zoneId);
            return unreferencedAt === undefined
              ? []
              : [[zoneId, unreferencedAt]];
          })
        )
      });
    } finally {
      for (const zoneId of currentZoneIds) {
        this.sleepInFlightZones.delete(zoneId);
      }
    }
    let reclaimedZoneCount = 0;
    for (const zoneId of currentZoneIds) {
      const reclaimed =
        (this.simulationRefCounts.get(zoneId) ?? 0) > 0 ||
        this.sleepGenerations.get(zoneId) !== requested.get(zoneId);
      if (reclaimed) reclaimedZoneCount += 1;
      else this.retainDurableDescriptorCache(zoneId);
      this.simulationResidentZones.delete(zoneId);
      this.invalidateZoneOwnership(zoneId);
      if ((this.refCounts.get(zoneId) ?? 0) > 0) {
        this.unreferencedAtByZone.delete(zoneId);
      }
      this.deleteCachedEntities(zoneId);
      this.cachedGenerations.delete(zoneId);
      this.completedStageByZone.delete(zoneId);
      this.pendingActivationZones.delete(zoneId);
      this.materializationStatusByZone.delete(zoneId);
    }
    gameplayLatencyTrace.recordActive({
      traceId: currentZoneIds[0]!,
      source: "game",
      category: "population",
      name: "population_zone_runtime_slept",
      details: {
        zoneCount: currentZoneIds.length,
        removedEntityCount: Math.max(removedEntityCount, result.removedEntityIds.length),
        sleptRuntimeActors: result.sleptRuntimeActors,
        reclaimedZoneCount
      }
    });
  }

  private scheduleSleepFlush(): void {
    if (this.closed || this.sleepFlushTimer || this.sleepFlush) return;
    this.sleepFlushTimer = setTimeout(() => {
      this.sleepFlushTimer = null;
      if (this.closed) return;
      const flush = this.enqueueSleepWork(() => this.flushSleepRequests());
      this.sleepFlush = flush;
      void flush.then(
        () => this.finishSleepFlush(flush),
        () => this.finishSleepFlush(flush)
      );
    }, 1);
    this.sleepFlushTimer.unref?.();
  }

  private finishSleepFlush(flush: Promise<void>): void {
    if (this.sleepFlush === flush) this.sleepFlush = null;
    if (!this.closed && this.pendingSleepZones.size > 0) {
      this.scheduleSleepFlush();
    }
  }

  private enqueueSleepWork<T>(work: () => Promise<T>): Promise<T> {
    const result = this.sleepWorkTail.then(work);
    this.sleepWorkTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private setCachedEntities(
    zoneId: PopulationZoneV2Id,
    entities: readonly PopulationZoneV2RuntimeEntity[]
  ): void {
    this.deleteCachedEntities(zoneId);
    this.cachedEntities.set(zoneId, entities);
    for (const entity of entities) {
      this.zoneIdByEntityId.set(entity.entityId, zoneId);
    }
  }

  private recordSimulationResidency(zoneId: PopulationZoneV2Id): void {
    this.simulationResidentZones.add(zoneId);
    if ((this.simulationRefCounts.get(zoneId) ?? 0) === 0) {
      this.scheduleZoneSleep(zoneId);
    }
  }

  private retainDurableDescriptorCache(zoneId: PopulationZoneV2Id): void {
    const entities = this.cachedEntities.get(zoneId);
    const completedStage = this.completedStageByZone.get(zoneId);
    const authority = this.authorityByZone.get(zoneId);
    const materializationStatus =
      this.materializationStatusByZone.get(zoneId);
    if (
      !entities
      || !completedStage
      || !populationStageAtLeast(completedStage, "DURABLE_READY")
      || !authority
      || !materializationStatus
    ) {
      this.invalidateDurableDescriptorCache(zoneId);
      return;
    }
    const now = Date.now();
    const cachedEntities = entities.map((entity) => ({
      ...entity,
      position: { ...entity.position },
      homePosition: { ...entity.homePosition }
    }));
    const cacheIdentity = {
      zoneId,
      generationId: this.cachedGenerations.get(zoneId) ?? null,
      materializationStatus,
      completedStage: "DURABLE_READY" as const,
      authority,
      entities: cachedEntities
    };
    const estimatedBytes = Buffer.byteLength(
      JSON.stringify(cacheIdentity),
      "utf8"
    );
    const maxBytes = this.options.descriptorCacheMaxBytes
      ?? POPULATION_V2_DESCRIPTOR_CACHE_MAX_BYTES;
    if (estimatedBytes > maxBytes) {
      this.invalidateDurableDescriptorCache(zoneId);
      this.descriptorCacheEvictions += 1;
      return;
    }
    this.removeDurableDescriptorCacheEntry(zoneId);
    const entry: PopulationDurableDescriptorCacheEntry = {
      ...cacheIdentity,
      cachedAtMs: now,
      expiresAtMs: now + (
        this.options.descriptorCacheTtlMs
        ?? POPULATION_V2_DESCRIPTOR_CACHE_TTL_MS
      ),
      estimatedBytes
    };
    this.descriptorCache.set(zoneId, entry);
    this.descriptorCacheBytes += estimatedBytes;
    this.pruneDurableDescriptorCache(now);
  }

  private validateDurableDescriptorCache(
    zoneId: PopulationZoneV2Id,
    activation: PopulationZoneV2BackendZoneActivation
  ): PopulationZoneV2BackendZoneActivation {
    this.pruneDurableDescriptorCache(Date.now());
    const cached = this.descriptorCache.get(zoneId);
    if (!cached) {
      this.descriptorCacheMisses += 1;
      return activation;
    }
    this.descriptorCache.delete(zoneId);
    this.descriptorCacheBytes -= cached.estimatedBytes;
    if (
      activation.status !== "ready"
      || !activation.authority
      || !samePopulationAuthority(cached.authority, activation.authority)
      || cached.generationId !== activation.generationId
      || !samePopulationDescriptors(cached.entities, activation.entities)
    ) {
      this.descriptorCacheInvalidations += 1;
      return activation;
    }
    this.descriptorCacheHits += 1;
    return {
      ...activation,
      entities: cached.entities
    };
  }

  private invalidateDurableDescriptorCache(
    zoneId: PopulationZoneV2Id
  ): void {
    if (this.removeDurableDescriptorCacheEntry(zoneId)) {
      this.descriptorCacheInvalidations += 1;
    }
  }

  private removeDurableDescriptorCacheEntry(
    zoneId: PopulationZoneV2Id
  ): boolean {
    const cached = this.descriptorCache.get(zoneId);
    if (!cached) return false;
    this.descriptorCache.delete(zoneId);
    this.descriptorCacheBytes = Math.max(
      0,
      this.descriptorCacheBytes - cached.estimatedBytes
    );
    return true;
  }

  private pruneDurableDescriptorCache(now: number): void {
    for (const [zoneId, entry] of this.descriptorCache) {
      if (entry.expiresAtMs > now) continue;
      this.removeDurableDescriptorCacheEntry(zoneId);
      this.descriptorCacheEvictions += 1;
    }
    const maxZones = this.options.descriptorCacheMaxZones
      ?? POPULATION_V2_DESCRIPTOR_CACHE_MAX_ZONES;
    const maxBytes = this.options.descriptorCacheMaxBytes
      ?? POPULATION_V2_DESCRIPTOR_CACHE_MAX_BYTES;
    while (
      this.descriptorCache.size > maxZones
      || this.descriptorCacheBytes > maxBytes
    ) {
      const oldestZoneId = this.descriptorCache.keys().next()
        .value as PopulationZoneV2Id | undefined;
      if (!oldestZoneId) break;
      this.removeDurableDescriptorCacheEntry(oldestZoneId);
      this.descriptorCacheEvictions += 1;
    }
  }

  private recordCompletedStage(
    zoneId: PopulationZoneV2Id,
    stage: Exclude<PopulationPreparationStage, "PUBLISHED">
  ): void {
    const existing = this.completedStageByZone.get(zoneId);
    this.completedStageByZone.set(
      zoneId,
      existing === undefined
        ? stage
        : maximumPopulationStage(existing, stage) as Exclude<
            PopulationPreparationStage,
            "PUBLISHED"
          >
    );
  }

  private deleteCachedEntities(zoneId: PopulationZoneV2Id): void {
    for (const entity of this.cachedEntities.get(zoneId) ?? []) {
      if (this.zoneIdByEntityId.get(entity.entityId) === zoneId) {
        this.zoneIdByEntityId.delete(entity.entityId);
      }
    }
    this.cachedEntities.delete(zoneId);
  }

  private applyHarvestedTreeFences(
    activation: PopulationZoneV2BackendZoneActivation
  ): PopulationZoneV2BackendZoneActivation {
    if (activation.status !== "ready" || this.harvestedTreeFences.size === 0) {
      return activation;
    }
    const removedEntityIds = [...(activation.removedEntityIds ?? [])];
    const entities = activation.entities.filter((entity) => {
      const fence = this.harvestedTreeFences.get(entity.entityId);
      if (!fence) return true;
      if (entity.kind !== "tree") {
        this.options.logger?.warn({
          entityId: entity.entityId,
          zoneId: entity.zoneId,
          generationId: entity.generationId,
          incomingRevision: entity.stateRevision,
          canonicalRevision: fence.stateRevision,
          operationType: "harvested-tree-fence-kind-mismatch"
        }, "harvested tree fence ignored a non-tree population entity");
        return true;
      }
      if (entity.generationId !== fence.generationId) {
        this.harvestedTreeFences.delete(entity.entityId);
        return true;
      }
      removedEntityIds.push(entity.entityId);
      this.options.logger?.warn({
        entityId: entity.entityId,
        zoneId: entity.zoneId,
        generationId: entity.generationId,
        incomingRevision: entity.stateRevision,
        canonicalRevision: fence.stateRevision,
        operationType: "stale-ready-tree-activation-suppressed"
      }, "suppressed stale same-generation harvested tree activation");
      gameplayLatencyTrace.recordActive({
        traceId: entity.entityId,
        source: "game",
        category: "population",
        name: "harvested_tree_rehydration_rejected",
        details: {
          entityId: entity.entityId,
          zoneId: entity.zoneId,
          generationId: entity.generationId,
          incomingRevision: entity.stateRevision,
          canonicalRevision: fence.stateRevision,
          operationType: "stale-ready-tree-activation-suppressed"
        }
      });
      return false;
    });
    if (entities.length === activation.entities.length) return activation;
    return {
      ...activation,
      entities,
      removedEntityIds: uniqueSorted(removedEntityIds)
    };
  }

  private requestActivation(
    zoneId: PopulationZoneV2Id,
    context: Omit<ActivationRequest, "resolve" | "reject">
  ): Promise<PopulationZoneV2BackendZoneActivation> {
    if (this.closed) {
      return Promise.reject(new Error("population v2 runtime is closed"));
    }
    return new Promise((resolve, reject) => {
      const request = { ...context, resolve, reject };
      const requests = this.activationRequests.get(zoneId) ?? [];
      requests.push(request);
      this.activationWaiters.add(request);
      this.activationRequests.set(zoneId, requests);
      this.scheduleActivationFlush();
    });
  }

  private requestPriorityActivation(
    zoneId: PopulationZoneV2Id,
    context: Omit<ActivationRequest, "resolve" | "reject">
  ): Promise<PopulationZoneV2BackendZoneActivation> {
    const flight = this.activatePriorityZone(zoneId, context);
    this.priorityActivationFlights.add(flight);
    void flight.finally(() => this.priorityActivationFlights.delete(flight))
      .catch(() => undefined);
    return flight;
  }

  private async activatePriorityZone(
    zoneId: PopulationZoneV2Id,
    context: Omit<ActivationRequest, "resolve" | "reject">
  ): Promise<PopulationZoneV2BackendZoneActivation> {
    const sameZoneSleep = this.sleepFlightsByZone.get(zoneId);
    if (sameZoneSleep) await sameZoneSleep;
    const ownershipToken = this.zoneOwnershipToken(zoneId);
    this.activationInFlight.add(zoneId);
    try {
      let activation = (
        await this.backend.activateZones({
          zoneIds: [zoneId],
          trigger: context.trigger,
          relocationRevision: context.relocationRevision,
          resourceVisionRevision: context.resourceVisionRevision,
          priorityZoneIds: [zoneId],
          priorityByZone: { [zoneId]: context.priority },
          ...(context.challengeProfile === undefined
            ? {}
            : {
                challengeProfilesByZone: {
                  [zoneId]: context.challengeProfile
                }
              }),
          targetStageByZone: { [zoneId]: context.targetStage },
          preparedAuthoritiesByZone:
            this.preparedAuthoritiesByZone([zoneId]),
          currentReferencesByZone: {
            [zoneId]: this.refCounts.get(zoneId) ?? 0
          },
          activateRuntime: context.activateRuntime
        })
      ).find((candidate) => candidate.zoneId === zoneId) ?? {
        zoneId,
        generationId: null,
        materializationStatus: "generation-missing" as const,
        status: "pending" as const,
        entities: [],
        removedEntityIds: [],
        spawnedRuntimeActors: 0
      };
      if (
        this.closed ||
        this.zoneOwnershipTokens.get(zoneId) !== ownershipToken
      ) {
        if (activation.status === "ready") {
          await this.backend.sleepZones({ zoneIds: [zoneId] });
          this.simulationResidentZones.delete(zoneId);
          this.invalidateZoneOwnership(zoneId);
        }
        this.invalidateDurableDescriptorCache(zoneId);
        this.deleteCachedEntities(zoneId);
        this.cachedGenerations.delete(zoneId);
        this.completedStageByZone.delete(zoneId);
        this.pendingActivationZones.delete(zoneId);
        this.materializationStatusByZone.delete(zoneId);
        return {
          zoneId,
          generationId: null,
          materializationStatus: "generation-invalid-or-unservable",
          status: "pending",
          entities: [],
          removedEntityIds: [],
          spawnedRuntimeActors: 0
        };
      }
      activation = this.applyHarvestedTreeFences(activation);
      this.materializationStatusByZone.set(
        zoneId,
        activation.materializationStatus
      );
      if (activation.status === "ready") {
        activation = this.validateDurableDescriptorCache(
          zoneId,
          activation
        );
        this.pendingActivationZones.delete(zoneId);
        this.setCachedEntities(zoneId, activation.entities);
        this.cachedGenerations.set(zoneId, activation.generationId);
        if (activation.authority) {
          this.authorityByZone.set(zoneId, activation.authority);
        } else {
          this.authorityByZone.delete(zoneId);
        }
        this.recordCompletedStage(
          zoneId,
          activation.completedStage ?? context.targetStage
        );
        if (
          context.activateRuntime
          && populationStageAtLeast(
            activation.completedStage ?? context.targetStage,
            "SIMULATION_READY"
          )
        ) this.recordSimulationResidency(zoneId);
      } else {
        this.invalidateDurableDescriptorCache(zoneId);
        this.pendingActivationZones.add(zoneId);
        this.authorityByZone.delete(zoneId);
      }
      return activation;
    } finally {
      this.activationInFlight.delete(zoneId);
      if (!this.closed && this.hasFlushableActivationRequests()) {
        this.scheduleActivationFlush();
      }
    }
  }

  private async flushActivationRequests(): Promise<void> {
    if (this.activationRequests.size === 0) return;
    const requests = new Map<PopulationZoneV2Id, ActivationRequest[]>();
    for (const [zoneId, zoneRequests] of this.activationRequests) {
      if (
        this.activationInFlight.has(zoneId) ||
        this.sleepInFlightZones.has(zoneId)
      ) continue;
      requests.set(zoneId, zoneRequests);
      this.activationRequests.delete(zoneId);
      this.activationInFlight.add(zoneId);
    }
    if (requests.size === 0) return;
    const zoneIds = [...requests.keys()].sort((left, right) =>
      minimumRequestedPriority(requests.get(left) ?? [])
        - minimumRequestedPriority(requests.get(right) ?? [])
      || minimumActivationOrder(requests.get(left) ?? [])
        - minimumActivationOrder(requests.get(right) ?? [])
      || left.localeCompare(right)
    );
    const contexts = [...requests.values()].flat();
    const context = contexts.reduce((latest, candidate) =>
      candidate.relocationRevision > latest.relocationRevision
        ? candidate
        : latest
    );
    for (const zoneId of zoneIds) {
      gameplayLatencyTrace.recordActive({
        traceId: zoneId,
        source: "game",
        category: "population",
        name: "population_zone_activation_started",
        details: {
          zoneId,
          trigger: context.trigger,
          relocationRevision: context.relocationRevision,
          resourceVisionRevision: context.resourceVisionRevision
        }
      });
    }
    const processedZoneIds = new Set<PopulationZoneV2Id>();
    try {
      const processActivation = (
        zoneId: PopulationZoneV2Id,
        received: PopulationZoneV2BackendZoneActivation | undefined
      ): void => {
        if (processedZoneIds.has(zoneId)) return;
        const originalRequests = requests.get(zoneId) ?? [];
        let activation = this.applyHarvestedTreeFences(received ?? {
          zoneId,
          generationId: null,
          materializationStatus: "generation-missing" as const,
          status: "pending" as const,
          entities: [],
          removedEntityIds: [],
          spawnedRuntimeActors: 0
        });
        this.materializationStatusByZone.set(
          zoneId,
          activation.materializationStatus
        );
        const supersedingRequests = this.activationRequests.get(zoneId);
        if (supersedingRequests && supersedingRequests.length > 0) {
          if (
            !this.options.inflightResultReuseEnabled
            || activation.status !== "ready"
          ) {
            this.activationRequests.set(zoneId, [
              ...originalRequests,
              ...supersedingRequests
            ]);
            processedZoneIds.add(zoneId);
            this.activationInFlight.delete(zoneId);
            return;
          }
          this.activationRequests.delete(zoneId);
        }
        const requestsForResult = [
          ...originalRequests,
          ...(supersedingRequests ?? [])
        ];
        if (activation.status === "ready") {
          activation = this.validateDurableDescriptorCache(
            zoneId,
            activation
          );
          this.pendingActivationZones.delete(zoneId);
          this.setCachedEntities(zoneId, activation.entities);
          this.cachedGenerations.set(zoneId, activation.generationId);
          if (activation.authority) {
            this.authorityByZone.set(zoneId, activation.authority);
          } else {
            this.authorityByZone.delete(zoneId);
          }
          this.recordCompletedStage(
            zoneId,
            activation.completedStage ?? maximumRequestedStage(originalRequests)
          );
          if (
            requestsForResult.some((request) =>
              request.activateRuntime
              && populationStageAtLeast(
                activation.completedStage ?? request.targetStage,
                "SIMULATION_READY"
              )
            )
          ) this.recordSimulationResidency(zoneId);
          gameplayLatencyTrace.recordActive({
            traceId: zoneId,
            source: "game",
            category: "population",
            name: "population_zone_runtime_rehydrated",
            details: {
              zoneCount: 1,
              durableEntityCount: activation.entities.length,
              runtimeSpawnCount: activation.spawnedRuntimeActors,
              worldCalled: false
            }
          });
        } else {
          this.invalidateDurableDescriptorCache(zoneId);
          this.pendingActivationZones.add(zoneId);
          this.authorityByZone.delete(zoneId);
        }
        const completedStage = activation.completedStage
          ?? maximumRequestedStage(originalRequests);
        for (const request of requestsForResult) {
          if (
            this.options.inflightResultReuseEnabled
            && activation.status === "ready"
            && !populationStageAtLeast(
              completedStage,
              request.activateRuntime
                ? maximumPopulationStage(
                    request.targetStage,
                    "SIMULATION_READY"
                  )
                : request.targetStage
            )
          ) {
            const pending = this.activationRequests.get(zoneId) ?? [];
            pending.push(request);
            this.activationRequests.set(zoneId, pending);
          } else {
            this.resolveActivationRequest(request, activation);
          }
        }
        processedZoneIds.add(zoneId);
        this.activationInFlight.delete(zoneId);
      };
      const activations = await this.backend.activateZones({
        zoneIds,
        trigger: context.trigger,
        relocationRevision: context.relocationRevision,
        resourceVisionRevision: context.resourceVisionRevision,
        priorityZoneIds: zoneIds.filter((zoneId) =>
          (requests.get(zoneId) ?? []).some((request) => request.priority === 0)
        ),
        priorityByZone: Object.fromEntries(zoneIds.map((zoneId) => [
          zoneId,
          minimumRequestedPriority(requests.get(zoneId) ?? [])
        ])),
        challengeProfilesByZone: Object.fromEntries(zoneIds.flatMap((zoneId) => {
          const profile = strongestChallengeProfile(
            (requests.get(zoneId) ?? []).flatMap((request) =>
              request.challengeProfile === undefined
                ? []
                : [request.challengeProfile]
            )
          );
          return profile === undefined ? [] : [[zoneId, profile]];
        })),
        currentReferencesByZone: Object.fromEntries(zoneIds.map((zoneId) => [
          zoneId,
          this.refCounts.get(zoneId) ?? 0
        ])),
        targetStageByZone: Object.fromEntries(zoneIds.map((zoneId) => [
          zoneId,
          maximumRequestedStage(requests.get(zoneId) ?? [])
        ])),
        preparedAuthoritiesByZone:
          this.preparedAuthoritiesByZone(zoneIds),
        activationOrderByZone: Object.fromEntries(zoneIds.map((zoneId, index) => [
          zoneId,
          index
        ])),
        onZoneActivated: (activation) => {
          processActivation(activation.zoneId, activation);
        },
        activateRuntime: [...requests.values()].some((zoneRequests) =>
          zoneRequests.some((request) => request.activateRuntime)
        )
      });
      const byZone = new Map(activations.map((activation) => [
        activation.zoneId,
        activation
      ] as const));
      for (const zoneId of zoneIds) {
        processActivation(zoneId, byZone.get(zoneId));
      }
    } catch (error) {
      for (const [zoneId, zoneRequests] of requests) {
        if (processedZoneIds.has(zoneId)) continue;
        for (const waiter of zoneRequests) {
          this.rejectActivationRequest(waiter, error);
        }
      }
    } finally {
      for (const zoneId of zoneIds) this.activationInFlight.delete(zoneId);
    }
  }

  private scheduleActivationFlush(): void {
    if (this.activationFlush !== null) return;
    const flush = this.enqueueActivationWork(() =>
      this.flushActivationRequests()
    );
    this.activationFlush = flush;
    void flush.then(
      () => this.finishActivationFlush(flush),
      () => this.finishActivationFlush(flush)
    );
  }

  private finishActivationFlush(flush: Promise<void>): void {
    if (this.activationFlush === flush) this.activationFlush = null;
    if (!this.closed && this.hasFlushableActivationRequests()) {
      this.scheduleActivationFlush();
    }
  }

  private hasFlushableActivationRequests(): boolean {
    return [...this.activationRequests.keys()].some((zoneId) =>
      !this.activationInFlight.has(zoneId) &&
      !this.sleepInFlightZones.has(zoneId)
    );
  }

  private enqueueActivationWork<T>(work: () => Promise<T>): Promise<T> {
    const result = this.activationWorkTail.then(work);
    this.activationWorkTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private preparedAuthoritiesByZone(
    zoneIds: readonly PopulationZoneV2Id[]
  ): Readonly<Record<string, PopulationZoneAuthorityFingerprint>> {
    if (!this.options.inflightResultReuseEnabled) return {};
    return Object.fromEntries(zoneIds.flatMap((zoneId) => {
      const authority = this.authorityByZone.get(zoneId);
      return authority
        && populationStageAtLeast(
          this.completedStageByZone.get(zoneId) ?? null,
          "DURABLE_READY"
        )
        && this.cachedEntities.has(zoneId)
        ? [[zoneId, authority] as const]
        : [];
    }));
  }

  private resolveActivationRequest(
    request: ActivationRequest,
    activation: PopulationZoneV2BackendZoneActivation
  ): void {
    if (!this.activationWaiters.delete(request)) return;
    request.resolve(activation);
  }

  private rejectActivationRequest(
    request: ActivationRequest,
    error: unknown
  ): void {
    if (!this.activationWaiters.delete(request)) return;
    request.reject(error);
  }

  private isCurrentLease(key: string, expected: ConnectionLease): boolean {
    return !this.closed && this.leases.get(key) === expected;
  }

  private leaseOwnedBy(
    input: Readonly<{
      connectionId: string;
      connectionGeneration: number;
      relocationRevision: number;
      resourceVisionRevision: number;
    }>,
    ownershipToken: object
  ): ConnectionLease | null {
    const lease = this.leases.get(connectionLeaseKey(
      input.connectionId,
      input.connectionGeneration
    ));
    return lease &&
      lease.relocationRevision === input.relocationRevision &&
      lease.resourceVisionRevision === input.resourceVisionRevision &&
      lease.ownershipToken === ownershipToken
      ? lease
      : null;
  }

  private armVisiblePreparationWatchdog(lease: ConnectionLease): void {
    if (!hasIncompleteVisibleZones(lease) || lease.terminalDelta) return;
    this.scheduleVisiblePreparationStaleCheck(lease);
    const terminalMs = this.options.visiblePreparationTerminalMs
      ?? POPULATION_V2_VISIBLE_PREPARATION_TERMINAL_MS;
    lease.terminalTimer = setTimeout(() => {
      lease.terminalTimer = null;
      this.failStalledVisiblePreparation(lease);
    }, terminalMs);
    lease.terminalTimer.unref?.();
  }

  private scheduleVisiblePreparationStaleCheck(lease: ConnectionLease): void {
    if (lease.staleTimer) clearTimeout(lease.staleTimer);
    if (lease.terminalDelta || !hasIncompleteVisibleZones(lease)) {
      lease.staleTimer = null;
      return;
    }
    const staleMs = this.options.visiblePreparationStaleMs
      ?? POPULATION_V2_VISIBLE_PREPARATION_STALE_MS;
    const delayMs = Math.max(1, staleMs - (Date.now() - lease.lastProgressAtMs));
    lease.staleTimer = setTimeout(() => {
      lease.staleTimer = null;
      void this.recoverStalledVisiblePreparation(lease);
    }, delayMs);
    lease.staleTimer.unref?.();
  }

  private recordZoneActivationFailure(
    lease: ConnectionLease,
    zoneId: PopulationZoneV2Id,
    error: unknown
  ): void {
    this.pendingActivationZones.add(zoneId);
    this.options.logger?.warn({
      err: error,
      playerId: lease.playerId,
      connectionId: lease.connectionId,
      connectionGeneration: lease.connectionGeneration,
      preparationGeneration: lease.preparationGeneration,
      relocationRevision: lease.relocationRevision,
      resourceVisionRevision: lease.resourceVisionRevision,
      zoneId,
      recoveryAttempt: lease.recoveryAttempt
    }, "population zone activation failed; keeping world entry recoverable");
  }

  private async recoverStalledVisiblePreparation(
    lease: ConnectionLease
  ): Promise<void> {
    if (!this.isCurrentLease(
      connectionLeaseKey(lease.connectionId, lease.connectionGeneration),
      lease
    ) || lease.terminalDelta || !hasIncompleteVisibleZones(lease)) return;
    const retryLimit = this.options.visiblePreparationRetryLimit
      ?? POPULATION_V2_VISIBLE_PREPARATION_RETRY_LIMIT;
    if (lease.recoveryAttempt >= retryLimit) return;
    lease.recoveryAttempt += 1;
    const zoneIds = sorted([...lease.visibleZoneIds].filter((zoneId) =>
      lease.incompleteZoneIds.has(zoneId)
    ));
    this.logVisiblePreparationState(
      lease,
      "targeted-retry",
      zoneIds
    );
    const results = await Promise.allSettled(zoneIds.map((zoneId) =>
      this.refreshWarmZone(zoneId, "explicit-relocation")
    ));
    results.forEach((result, index) => {
      const zoneId = zoneIds[index];
      if (result.status === "rejected" && zoneId) {
        this.recordZoneActivationFailure(lease, zoneId, result.reason);
      }
    });
  }

  private failStalledVisiblePreparation(
    lease: ConnectionLease,
    preparationReason: PopulationPreparationReason = "backpressure-retry"
  ): void {
    if (!hasIncompleteVisibleZones(lease) || lease.terminalDelta) return;
    const zoneIds = sorted([...lease.visibleZoneIds].filter((zoneId) =>
      lease.incompleteZoneIds.has(zoneId)
    ));
    this.logVisiblePreparationState(
      lease,
      "retryable-failure",
      zoneIds
    );
    const withheldZoneIds = new Set(zoneIds);
    const readyVisibleZoneIds = [...lease.visibleZoneIds].filter((zoneId) =>
      !withheldZoneIds.has(zoneId)
    );
    const removedEntityIds = [...lease.projectedEntityIds].filter((entityId) =>
      withheldZoneIds.has(this.zoneIdByEntityId.get(entityId) as PopulationZoneV2Id)
    );
    for (const entityId of removedEntityIds) {
      lease.projectedEntityIds.delete(entityId);
    }
    const delta: PopulationZonesV2ActivationDelta = {
      playerId: lease.playerId,
      connectionId: lease.connectionId,
      connectionGeneration: lease.connectionGeneration,
      preparationGeneration: lease.preparationGeneration,
      preparationTrigger: lease.preparationTrigger,
      relocationRevision: lease.relocationRevision,
      resourceVisionRevision: lease.resourceVisionRevision,
      gameplayViewGeneration: lease.area.generation,
      retainedZoneIds: sorted([...lease.activeZoneIds].filter((zoneId) =>
        !withheldZoneIds.has(zoneId)
      )),
      activatedZoneIds: [],
      releasedZoneIds: zoneIds,
      withheldZoneIds: zoneIds,
      upserts: deduplicateEntities(readyVisibleZoneIds.flatMap(
        (zoneId) => (this.cachedEntities.get(zoneId) ?? []).filter((entity) =>
          isClientPresentationalPopulationEntity(entity)
          && greatCircleDistanceMeters(lease.area.center, entity.position) <=
              lease.area.certifiedVisibleRadiusM
        )
      )),
      removedEntityIds: uniqueSorted(removedEntityIds),
      ...this.authorityForLease(lease),
      preparationReason,
      preparationResult: "degraded",
      partial: false,
      terminal: true
    };
    this.publishDelta(delta);
    this.resolveVisibleReadiness(lease, "degraded", delta);
    this.resolvePresentationReadiness(lease, "degraded", delta);
  }

  private markZoneReadyForLease(
    lease: ConnectionLease,
    zoneId: PopulationZoneV2Id
  ): void {
    if (!lease.incompleteZoneIds.delete(zoneId)) return;
    if (!lease.visibleZoneIds.has(zoneId)) return;
    lease.lastProgressAtMs = Date.now();
    this.scheduleVisiblePreparationStaleCheck(lease);
  }

  private clearVisiblePreparationWatchdog(lease: ConnectionLease): void {
    if (lease.staleTimer) clearTimeout(lease.staleTimer);
    if (lease.terminalTimer) clearTimeout(lease.terminalTimer);
    lease.staleTimer = null;
    lease.terminalTimer = null;
  }

  private connectionPreparationState(
    lease: ConnectionLease
  ): PopulationConnectionPreparationState {
    const authority = this.authorityForLease(lease);
    return {
      preparationGeneration: lease.preparationGeneration,
      relocationRevision: lease.relocationRevision,
      resourceVisionRevision: lease.resourceVisionRevision,
      preparationResult: lease.preparationResult,
      preparationReason: lease.preparationReason,
      visibleZoneCount: authority.visibleZoneCount,
      readyVisibleZoneCount: authority.readyVisibleZoneCount,
      terminal: lease.terminalDelta !== null
    };
  }

  private logVisiblePreparationState(
    lease: ConnectionLease,
    outcome: "targeted-retry" | "retryable-failure",
    incompleteZoneIds: readonly PopulationZoneV2Id[]
  ): void {
    const now = Date.now();
    this.options.logger?.warn({
      playerId: lease.playerId,
      connectionId: lease.connectionId,
      connectionGeneration: lease.connectionGeneration,
      preparationGeneration: lease.preparationGeneration,
      relocationRevision: lease.relocationRevision,
      resourceVisionRevision: lease.resourceVisionRevision,
      readyVisibleZoneCount:
        lease.visibleZoneIds.size - incompleteZoneIds.length,
      incompleteVisibleZoneIds: incompleteZoneIds,
      pendingPlanZoneIds: incompleteZoneIds.filter((zoneId) =>
        this.materializationStatusByZone.get(zoneId) === "generation-missing"
      ),
      lifecyclePendingZoneIds: incompleteZoneIds.filter((zoneId) =>
        this.materializationStatusByZone.get(zoneId) ===
          "generation-lifecycle-pending"
      ),
      guardedMaterializationZoneIds: incompleteZoneIds.filter((zoneId) =>
        this.materializationStatusByZone.get(zoneId) ===
          "guarded-materialization"
      ),
      replacementRequiredZoneIds: incompleteZoneIds.filter((zoneId) =>
        this.materializationStatusByZone.get(zoneId) ===
          "replacement-required-materialization"
      ),
      materializationStatusByIncompleteZone: Object.fromEntries(
        incompleteZoneIds.map((zoneId) => [
          zoneId,
          this.materializationStatusByZone.get(zoneId) ?? "generation-missing"
        ])
      ),
      activationInFlightZoneIds: incompleteZoneIds.filter((zoneId) =>
        this.activationInFlight.has(zoneId)
      ),
      preparationAgeMs: now - lease.startedAtMs,
      lastProgressAgeMs: now - lease.lastProgressAtMs,
      recoveryAttempt: lease.recoveryAttempt,
      outcome,
      planner: this.options.plannerStateForZones?.(incompleteZoneIds)
    }, "population visible preparation watchdog");
  }

  private resolveVisibleReadiness(
    lease: ConnectionLease,
    status: "ready" | "degraded" | "stale" | "closed" | "failed",
    delta?: PopulationZonesV2ActivationDelta
  ): void {
    if (status === "ready" || status === "degraded") {
      if (!delta) throw new Error("visible-ready population outcome requires a delta");
      if (
        !lease.visibleReadiness.settled
        && Date.now() - lease.startedAtMs > 500
      ) {
        this.lateVisiblePopulation += 1;
      }
      lease.visibleReadiness.resolve({
        status,
        delta,
        pendingVisibleZoneCount: pendingVisibleZoneCount(lease, 0)
      });
      return;
    }
    lease.visibleReadiness.resolve({
      status,
      delta: null,
      pendingVisibleZoneCount: pendingVisibleZoneCount(lease, 0)
    });
  }

  private resolvePresentationReadiness(
    lease: ConnectionLease,
    status: "ready" | "degraded" | "stale" | "closed" | "failed",
    delta?: PopulationZonesV2ActivationDelta
  ): void {
    if (status === "ready") {
      if (
        !delta ||
        !delta.terminal ||
        delta.preparationResult !== "ready" ||
        delta.readyVisibleZoneCount !== delta.visibleZoneCount ||
        pendingVisibleZoneCount(lease, 0) !== 0
      ) return;
      lease.presentationReadiness.resolve({
        status,
        delta,
        pendingVisibleZoneCount: 0
      });
      return;
    }
    if (status === "degraded") {
      if (
        !delta ||
        !delta.terminal ||
        delta.preparationResult !== "degraded" ||
        delta.withheldZoneIds.length === 0
      ) return;
      lease.presentationReadiness.resolve({
        status,
        delta,
        pendingVisibleZoneCount: delta.withheldZoneIds.length
      });
      return;
    }
    lease.presentationReadiness.resolve({
      status,
      delta: null,
      pendingVisibleZoneCount: pendingVisibleZoneCount(lease, 0)
    });
  }

  private authorityForLease(
    lease: ConnectionLease,
    changedZoneIds?: readonly PopulationZoneV2Id[]
  ): Pick<
    PopulationZonesV2ActivationDelta,
    | "visibleZoneCount"
    | "readyVisibleZoneCount"
    | "backgroundZoneCount"
    | "readyBackgroundZoneCount"
    | "zoneSnapshots"
  > {
    const visibleZoneIds = sorted(lease.visibleZoneIds);
    const readyZoneIds = visibleZoneIds.filter((zoneId) =>
      !lease.incompleteZoneIds.has(zoneId)
    );
    const backgroundZoneIds = sorted(lease.activeZoneIds).filter((zoneId) =>
      !lease.visibleZoneIds.has(zoneId)
    );
    const snapshotZoneIds = changedZoneIds
      ? changedZoneIds.filter((zoneId) =>
          lease.visibleZoneIds.has(zoneId) &&
          !lease.incompleteZoneIds.has(zoneId)
        )
      : readyZoneIds;
    return {
      visibleZoneCount: visibleZoneIds.length,
      readyVisibleZoneCount: readyZoneIds.length,
      backgroundZoneCount: backgroundZoneIds.length,
      readyBackgroundZoneCount: backgroundZoneIds.filter((zoneId) =>
        !lease.incompleteZoneIds.has(zoneId)
      ).length,
      zoneSnapshots: snapshotZoneIds.map((zoneId) => ({
        zoneId,
        generationId: this.cachedGenerations.get(zoneId) ?? null,
        entityIds: (this.cachedEntities.get(zoneId) ?? [])
          .filter((entity) =>
            isClientPresentationalPopulationEntity(entity)
            && greatCircleDistanceMeters(lease.area.center, entity.position) <=
                lease.area.certifiedVisibleRadiusM
          )
          .map((entity) => entity.entityId)
          .sort()
      }))
    };
  }

  private publishPreparationTerminal(
    lease: ConnectionLease,
    preparationResult: "stale" | "cancelled"
  ): void {
    this.publishDelta({
      playerId: lease.playerId,
      connectionId: lease.connectionId,
      connectionGeneration: lease.connectionGeneration,
      preparationGeneration: lease.preparationGeneration,
      preparationTrigger: lease.preparationTrigger,
      relocationRevision: lease.relocationRevision,
      resourceVisionRevision: lease.resourceVisionRevision,
      gameplayViewGeneration: lease.area.generation,
      retainedZoneIds: [],
      activatedZoneIds: [],
      releasedZoneIds: [],
      withheldZoneIds: [],
      upserts: [],
      removedEntityIds: [],
      ...this.authorityForLease(lease),
      preparationReason: preparationResult === "stale"
        ? "stale-authority"
        : "cancelled",
      preparationResult,
      partial: false,
      terminal: true
    });
  }

  private traceDelta(
    delta: PopulationZonesV2ActivationDelta,
    trigger: PopulationZoneV2RuntimeTrigger
  ): void {
    for (const zoneId of [
      ...delta.retainedZoneIds,
      ...delta.activatedZoneIds
    ]) {
      this.lastDeltaEntityCountByZone.set(
        zoneId,
        delta.upserts.filter((entity) => entity.zoneId === zoneId).length
      );
      this.lastPublishedRevisionByZone.set(
        zoneId,
        delta.resourceVisionRevision
      );
    }
    for (const zoneId of delta.releasedZoneIds) {
      this.lastDeltaEntityCountByZone.set(zoneId, 0);
      this.lastPublishedRevisionByZone.set(
        zoneId,
        delta.resourceVisionRevision
      );
    }
    const traceId = `${delta.playerId}:${delta.relocationRevision}`;
    gameplayLatencyTrace.record(delta.playerId, {
      traceId,
      source: "game",
      category: "population",
      name: "population_zone_activation_delta",
      details: {
        trigger,
        retainedCount: delta.retainedZoneIds.length,
        activatedCount: delta.activatedZoneIds.length,
        releasedCount: delta.releasedZoneIds.length,
        upsertCount: delta.upserts.length,
        removalCount: delta.removedEntityIds.length,
        relocationRevision: delta.relocationRevision,
        resourceVisionRevision: delta.resourceVisionRevision,
        partial: delta.partial
      }
    });
    for (const [name, count] of [
      ["population_zone_retained", delta.retainedZoneIds.length],
      ["population_zone_activated", delta.activatedZoneIds.length],
      ["population_zone_released", delta.releasedZoneIds.length]
    ] as const) {
      gameplayLatencyTrace.record(delta.playerId, {
        traceId,
        source: "game",
        category: "population",
        name,
        details: { zoneCount: count, relocationRevision: delta.relocationRevision }
      });
    }
  }

  private publishDelta(delta: PopulationZonesV2ActivationDelta): void {
    const lease = this.leases.get(connectionLeaseKey(
      delta.connectionId,
      delta.connectionGeneration
    ));
    const recoveringFromDegraded =
      lease?.preparationGeneration === delta.preparationGeneration &&
      lease.terminalDelta?.preparationResult === "degraded";
    if (
      lease?.preparationGeneration === delta.preparationGeneration &&
      lease.terminalDelta &&
      !delta.terminal &&
      !recoveringFromDegraded
    ) return;
    if (
      lease?.preparationGeneration === delta.preparationGeneration &&
      lease.playerId === delta.playerId
    ) {
      if (!recoveringFromDegraded || delta.terminal) {
        lease.preparationResult = delta.preparationResult;
        lease.preparationReason = delta.preparationReason;
      }
      if (delta.terminal) {
        lease.terminalDelta = delta;
        this.clearVisiblePreparationWatchdog(lease);
      }
    }
    for (const listener of this.deltaListeners) {
      void Promise.resolve(listener(delta)).catch(() => undefined);
    }
  }
}

function connectionLeaseKey(connectionId: string, generation: number): string {
  return `${connectionId}:${generation}`;
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function isSimulationStage(
  stage: Exclude<PopulationPreparationStage, "PLAN_READY">
): boolean {
  return stage === "SIMULATION_READY" || stage === "PUBLISHED";
}

function initialPreparationReason(
  trigger: PopulationRelocationTrigger
): PopulationPreparationReason {
  switch (trigger) {
    case "world-entry":
      return "initial-world-generation";
    case "reconnect":
    case "flag-travel":
    case "party-travel":
    case "separate-space-exit":
      return "durable-rehydration";
    case "flag-placement":
      return "plan-pending";
    case "administrative-relocation":
    case "explicit-relocation":
      return "simulation-activation";
  }
}

function samePopulationAuthority(
  left: PopulationZoneAuthorityFingerprint,
  right: PopulationZoneAuthorityFingerprint
): boolean {
  return left.zoneId === right.zoneId
    && left.selectedPlanId === right.selectedPlanId
    && left.generationId === right.generationId
    && left.cutoverRevision === right.cutoverRevision
    && left.commonSchemaRevision === right.commonSchemaRevision
    && left.registryRevision === right.registryRevision
    && left.stateRevisionFingerprint === right.stateRevisionFingerprint
    && left.ownershipToken === right.ownershipToken;
}

function samePopulationDescriptors(
  left: readonly PopulationZoneV2RuntimeEntity[],
  right: readonly PopulationZoneV2RuntimeEntity[]
): boolean {
  if (left.length !== right.length) return false;
  const sort = (entities: readonly PopulationZoneV2RuntimeEntity[]) =>
    [...entities].sort((first, second) =>
      first.entityId.localeCompare(second.entityId)
    );
  const sortedLeft = sort(left);
  const sortedRight = sort(right);
  return sortedLeft.every((entity, index) => {
    const candidate = sortedRight[index];
    return candidate !== undefined
      && entity.entityId === candidate.entityId
      && entity.zoneId === candidate.zoneId
      && entity.generationId === candidate.generationId
      && entity.kind === candidate.kind
      && entity.archetype === candidate.archetype
      && entity.packId === candidate.packId
      && entity.stateRevision === candidate.stateRevision
      && entity.berryAvailable === candidate.berryAvailable
      && entity.resinAvailable === candidate.resinAvailable
      && entity.sapReadyAt === candidate.sapReadyAt
      && entity.position.lat === candidate.position.lat
      && entity.position.lon === candidate.position.lon
      && entity.homePosition.lat === candidate.homePosition.lat
      && entity.homePosition.lon === candidate.homePosition.lon;
  });
}

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function strongestChallengeProfile(
  profiles: readonly EquipmentChallengeProfile[]
): EquipmentChallengeProfile | undefined {
  return profiles.reduce<EquipmentChallengeProfile | undefined>(
    (strongest, candidate) =>
      strongest === undefined
      || candidate.unlockedGearLevel > strongest.unlockedGearLevel
        ? candidate
        : strongest,
    undefined
  );
}

function strongestChallengeProfileForZone(
  leases: Iterable<ConnectionLease>,
  zoneId: PopulationZoneV2Id
): EquipmentChallengeProfile | undefined {
  return strongestChallengeProfile(
    [...leases]
      .filter((lease) => lease.activeZoneIds.has(zoneId))
      .flatMap((lease) =>
        lease.challengeProfile === undefined ? [] : [lease.challengeProfile]
      )
  );
}

function pendingActivation(
  zoneId: PopulationZoneV2Id
): PopulationZoneV2BackendZoneActivation {
  return {
    zoneId,
    generationId: null,
    materializationStatus: "generation-missing",
    status: "pending",
    entities: [],
    removedEntityIds: [],
    spawnedRuntimeActors: 0,
    completedStage: null,
    reason: "plan-pending",
    authority: null
  };
}

function maximumRequestedStage(
  requests: readonly ActivationRequest[]
): Exclude<PopulationPreparationStage, "PUBLISHED"> {
  return requests.reduce<
    Exclude<PopulationPreparationStage, "PUBLISHED">
  >(
    (stage, request) => maximumPopulationStage(
      stage,
      request.targetStage
    ) as Exclude<PopulationPreparationStage, "PUBLISHED">,
    "PLAN_READY"
  );
}

function minimumRequestedPriority(
  requests: readonly ActivationRequest[]
): PopulationPreparationPriority {
  return requests.reduce<PopulationPreparationPriority>(
    (priority, request) => Math.min(priority, request.priority) as
      PopulationPreparationPriority,
    3
  );
}

function minimumActivationOrder(
  requests: readonly ActivationRequest[]
): number {
  return requests.reduce(
    (order, request) => Math.min(order, request.activationOrder ?? Infinity),
    Infinity
  );
}

function prioritizedActivationZoneIds(
  zoneIds: readonly PopulationZoneV2Id[],
  center: LatLon,
  centerZoneId: PopulationZoneV2Id
): PopulationZoneV2Id[] {
  return [...zoneIds].sort((left, right) => {
    if (left === centerZoneId) return right === centerZoneId ? 0 : -1;
    if (right === centerZoneId) return 1;
    return greatCircleDistanceMeters(
      center,
      populationZoneV2Geometry(left).center
    ) - greatCircleDistanceMeters(
      center,
      populationZoneV2Geometry(right).center
    ) || left.localeCompare(right);
  });
}

function legacyTargetStage(
  priority: PopulationPreparationPriority,
  activateRuntime: boolean
): Exclude<PopulationPreparationStage, "PUBLISHED"> {
  if (priority >= 2) return "PLAN_READY";
  return priority === 0 && activateRuntime
    ? "SIMULATION_READY"
    : "DURABLE_READY";
}

function deduplicateEntities(
  entities: readonly PopulationZoneV2RuntimeEntity[]
): PopulationZoneV2RuntimeEntity[] {
  return [...new Map(entities.map((entity) => [entity.entityId, entity])).values()]
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function hasIncompleteVisibleZones(lease: ConnectionLease): boolean {
  return [...lease.incompleteZoneIds].some((zoneId) =>
    lease.visibleZoneIds.has(zoneId)
  );
}

function pendingVisibleZoneCount(
  lease: ConnectionLease | null,
  fallback: number
): number {
  if (!lease) return fallback;
  return [...lease.incompleteZoneIds].filter((zoneId) =>
    lease.visibleZoneIds.has(zoneId)
  ).length;
}

function visibleEntitiesForLease(
  lease: ConnectionLease,
  activations: readonly PopulationZoneV2BackendZoneActivation[]
): PopulationZoneV2RuntimeEntity[] {
  return deduplicateEntities(activations.flatMap((activation) =>
    activation.status === "ready" && lease.visibleZoneIds.has(activation.zoneId)
      ? activation.entities.filter((entity) =>
          isClientPresentationalPopulationEntity(entity)
          && greatCircleDistanceMeters(lease.area.center, entity.position) <=
              lease.area.certifiedVisibleRadiusM
        )
      : []
  ));
}

function isClientPresentationalPopulationEntity(
  entity: PopulationZoneV2RuntimeEntity
): boolean {
  return !["stone", "coal", "iron"].includes(entity.kind);
}

function shouldPrefetchDestinationEnvironment(input: Readonly<{
  zoneCount: number;
  targetStage: Exclude<PopulationPreparationStage, "PUBLISHED">;
  priority: PopulationPreparationPriority;
  trigger: PopulationZoneV2RuntimeTrigger;
}>): boolean {
  return input.zoneCount > 1
    && input.targetStage === "DURABLE_READY"
    && input.priority <= 1
    && (
      input.trigger === "flag-travel"
      || input.trigger === "party-travel"
      || input.trigger === "separate-space-exit"
      || input.trigger === "administrative-relocation"
    );
}

function isTerminalEnvironmentPrefetchError(error: unknown): boolean {
  return error instanceof PopulationEnvironmentPrefetchTerminalError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

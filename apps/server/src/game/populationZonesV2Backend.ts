import { createHash, randomUUID } from "node:crypto";

import type {
  EquipmentChallengeProfile,
  MobArchetypeKey
} from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import type {
  CombatEngine,
  PopulationMobCombatRuntimeState
} from "./combat/combatEngine.js";
import {
  populationStageAtLeast,
  type PopulationPreparationPriority,
  type PopulationPreparationReason,
  type PopulationPreparationStage,
  type PopulationZoneAuthorityFingerprint
} from "./populationStreamingContract.js";
import { populationV2MobRegistry } from "./populationV2MobRegistry.js";
import {
  PopulationV2GenerationFactory,
  PopulationV2GenerationServer,
  PopulationV2PlanAuthority,
  PopulationV2ZoneActivationScheduler
} from "./populationV2GenerationServices.js";
import type { PopulationZoneV2Id } from "./populationZonesV2Geometry.js";
import type {
  PopulationV2KindDefinition,
  PopulationV2KindRegistry
} from "./populationV2KindRegistry.js";
import type { PopulationZonesV2Planner } from "./populationZonesV2Planner.js";
import type {
  PopulationZoneV2GenerationRecord,
  PopulationZoneV2PlanRecord,
  PopulationZoneV2PlanRequest,
  PopulationZoneV2ReadyEntity,
  PopulationZoneV2RuntimeLease,
  PopulationZoneV2RuntimeLeaseRequest,
  PopulationRuntimeLeaseRenewalOutcome
} from "./populationZonesV2Store.js";
import {
  commonSchemaRevisionForGeneration
} from "./populationZonesV2Store.js";
import type {
  PopulationZoneV2BackendZoneActivation,
  PopulationZoneV2RuntimeEntity,
  PopulationZonesV2RuntimeBackend
} from "./populationZonesV2Runtime.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";

const DEFAULT_RUNTIME_LEASE_MS = 30_000;
const DEFAULT_RUNTIME_HEARTBEAT_MS = 10_000;
const DEFAULT_RUNTIME_SPAWN_BATCH_SIZE = 8;
const DEFAULT_GENERATION_SWEEP_MS = 30_000;
const DEFAULT_GENERATION_SWEEP_BATCH_SIZE = 128;
export type PopulationZonesV2BackendStore = Readonly<{
  loadCurrentServingPlanGenerations?(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2GenerationRecord[]>;
  ensurePlansForZones?(
    requests: readonly PopulationZoneV2PlanRequest[]
  ): Promise<PopulationZoneV2PlanRecord[]>;
  ensurePlanForZone(
    request: PopulationZoneV2PlanRequest
  ): Promise<PopulationZoneV2PlanRecord>;
  createCurrentGeneration(input: Readonly<{
    zoneId: string;
    planId: string;
    now?: Date;
    currentReferences?: number;
    replaceExpiredReferencedGeneration?: boolean;
  }>): Promise<Readonly<{
    generation: PopulationZoneV2GenerationRecord;
    created: boolean;
    entityIds: readonly string[];
    retiredEntityIds?: readonly string[];
    shortfallByKind: Readonly<Record<string, number>>;
  }>>;
  loadCurrentGenerations(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2GenerationRecord[]>;
  loadDueCurrentGenerations(input?: Readonly<{
    now?: Date;
    limit?: number;
    after?: Readonly<{
      expiresAt: Date;
      zoneId: string;
    }>;
  }>): Promise<PopulationZoneV2GenerationRecord[]>;
  updateCurrentGenerationReferences(input: Readonly<{
    references: readonly Readonly<{
      zoneId: string;
      currentReferences: number;
      unreferencedAt?: Date;
    }>[];
    now?: Date;
  }>): Promise<number>;
  markGenerationExpired(input: Readonly<{
    zoneId: string;
    generationId: string;
    currentReferences: number;
    now?: Date;
    unreferencedAt?: Date;
  }>): Promise<PopulationZoneV2GenerationRecord | null>;
  cleanupExpiredGeneration(input: Readonly<{
    zoneId: string;
    generationId: string;
    unreferenced: boolean;
    now?: Date;
    graceMs?: number;
  }>): Promise<boolean>;
  loadReadyEntitiesForZones(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2ReadyEntity[]>;
  claimMobCombatProfilesForZones?(
    claims: readonly Readonly<{
      zoneId: string;
      level: number;
      source: "zone_player_profile";
      knownUnclaimed?: boolean;
    }>[]
  ): Promise<number>;
  acquireRuntimeEntityLeases(
    requests: readonly PopulationZoneV2RuntimeLeaseRequest[],
    leaseMs: number
  ): Promise<PopulationZoneV2RuntimeLease[]>;
  renewRuntimeEntityLeases(
    leases: readonly PopulationZoneV2RuntimeLease[],
    leaseMs: number
  ): Promise<PopulationRuntimeLeaseRenewalOutcome[]>;
  updateReadyRuntimeEntityState?(
    lease: PopulationZoneV2RuntimeLease,
    durableRuntimeState: Record<string, unknown>
  ): Promise<boolean>;
  rebindRuntimeEntityLease(
    existing: PopulationZoneV2RuntimeLease,
    request: PopulationZoneV2RuntimeLeaseRequest,
    leaseMs: number
  ): Promise<PopulationZoneV2RuntimeLease | null>;
  releaseRuntimeEntityLeases(
    leases: readonly PopulationZoneV2RuntimeLease[]
  ): Promise<number>;
}>;

type ActiveRuntimeEntity = Readonly<{
  descriptor: PopulationZoneV2RuntimeEntity;
  lease: PopulationZoneV2RuntimeLease;
}>;

type MaterializationStatus =
  PopulationZoneV2BackendZoneActivation["materializationStatus"];

type PopulationV2RuntimeMobRegistry = Readonly<{
  definitionForKind(kind: string): Readonly<{
    combatArchetype: MobArchetypeKey;
    compatiblePlacementRevisions?: readonly string[];
  }> | undefined;
  populationKinds?: Pick<
    PopulationV2KindRegistry,
    "revision" | "definitionForKind"
  >;
}>;

export class PopulationZonesV2Backend implements PopulationZonesV2RuntimeBackend {
  private readonly runtimeId: string;
  private readonly activeRuntimeEntities = new Map<string, ActiveRuntimeEntity>();
  private readonly activeRuntimeEntityIdsByZone =
    new Map<string, Set<string>>();
  private readonly activePriorityZeroZones = new Set<string>();
  private readonly currentGenerations = new Map<
    string,
    PopulationZoneV2GenerationRecord
  >();
  private readonly durableReadyByZone = new Map<string, Readonly<{
    authority: PopulationZoneAuthorityFingerprint;
    entities: readonly PopulationZoneV2ReadyEntity[];
  }>>();
  private readonly activeNonStoneCountByZone = new Map<string, number>();
  private readonly currentReferenceCountByZone = new Map<string, number>();
  private readonly unreferencedAtByZone = new Map<string, Date>();
  private readonly runtimeTrackedZones = new Set<string>();
  private readonly generationRefreshListeners = new Set<
    (zoneId: PopulationZoneV2Id) => void | Promise<void>
  >();
  private readonly planAuthority: PopulationV2PlanAuthority;
  private readonly generationFactory: PopulationV2GenerationFactory;
  private readonly generationServer: PopulationV2GenerationServer;
  private readonly mobRegistry: PopulationV2RuntimeMobRegistry;
  private readonly kindRegistry: Pick<
    PopulationV2KindRegistry,
    "revision" | "definitionForKind"
  >;
  private readonly activationScheduler: PopulationV2ZoneActivationScheduler<
    readonly PopulationZoneV2BackendZoneActivation[]
  >;
  private readonly lastPreparationMsByPriority =
    new Map<PopulationPreparationPriority, number>();
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private readonly generationSweepTimer: ReturnType<typeof setInterval>;
  private readonly activationWork = new Set<Promise<unknown>>();
  private readonly runtimeStateWriteTails = new Map<string, Promise<void>>();
  private heartbeat: Promise<void> | null = null;
  private generationSweep: Promise<void> | null = null;
  private generationSweepCursor: Readonly<{
    expiresAt: Date;
    zoneId: string;
  }> | null = null;
  private referenceSyncTail: Promise<void> = Promise.resolve();
  private lastActivationError: string | null = null;
  private deduplicatedRuntimeActivations = 0;
  private actorInPlaceRebinds = 0;
  private orphanedRuntimeActorReconciliations = 0;
  private readonly mobDespawnsByReason = new Map<string, number>();
  private generationsCreated = 0;
  private preventedDuplicateGenerationAttempts = 0;
  private materializationFastPathHits = 0;
  private staleMaterializationServed = 0;
  private materializationReconciliations = 0;
  private invariantGenerationCleanups = 0;
  private invariantViolations = 0;
  private invariantEntitiesSuppressed = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly store: PopulationZonesV2BackendStore,
    private readonly planner: Pick<
      PopulationZonesV2Planner,
      "scheduleZones" | "scheduleZonesAndWait"
    > & Partial<Pick<
      PopulationZonesV2Planner,
      "prefetchEnvironmentForZones"
    >>,
    private readonly combat: Pick<
      CombatEngine,
      | "spawnMob"
      | "despawnMob"
      | "despawnPopulationManagedMob"
      | "rebindPopulationAuthority"
    > & Partial<Pick<CombatEngine, "setPopulationMobRuntimeStateSink">>,
    private readonly configuration: Readonly<{
      regionCode: string;
      runtimeSha: string;
      worldEnvironmentIdentityKey: string;
      worldPipelineSha: string;
      runtimeLeaseMs?: number;
      runtimeHeartbeatMs?: number;
      runtimeSpawnBatchSize?: number;
      generationSweepMs?: number;
      generationSweepBatchSize?: number;
      activationConcurrency?: number;
      backgroundPressureElevated?(): boolean;
      mobRegistry?: PopulationV2RuntimeMobRegistry;
      /** Called after a registered mob body is spawned (or re-woken), for kinds owned by a settlement service. */
      onRuntimeMobSpawned?(entity: PopulationZoneV2ReadyEntity, position: { lat: number; lon: number }): void;
    }>,
    private readonly logger?: Pick<AppLogger, "warn">
      & Partial<Pick<AppLogger, "info">>
  ) {
    if (!configuration.regionCode) {
      throw new Error("population v2 runtime region code is required");
    }
    if (!/^[a-f0-9]{40}$/u.test(configuration.runtimeSha)) {
      throw new Error("population v2 game runtime SHA must be Git SHA hex");
    }
    if (!configuration.worldEnvironmentIdentityKey) {
      throw new Error("population v2 World environment identity is required");
    }
    if (!/^[a-f0-9]{40}$/u.test(configuration.worldPipelineSha)) {
      throw new Error("population v2 World pipeline SHA must be Git SHA hex");
    }
    this.combat.setPopulationMobRuntimeStateSink?.((entityId, state) => {
      this.queueRuntimeStateWrite(entityId, state);
    });
    const heartbeatMs = configuration.runtimeHeartbeatMs
      ?? DEFAULT_RUNTIME_HEARTBEAT_MS;
    const leaseMs = configuration.runtimeLeaseMs ?? DEFAULT_RUNTIME_LEASE_MS;
    if (
      !Number.isInteger(heartbeatMs)
      || heartbeatMs <= 0
      || heartbeatMs >= leaseMs
    ) {
      throw new Error(
        "population v2 heartbeat must be positive and shorter than its lease"
      );
    }
    const spawnBatchSize = configuration.runtimeSpawnBatchSize
      ?? DEFAULT_RUNTIME_SPAWN_BATCH_SIZE;
    if (!Number.isSafeInteger(spawnBatchSize) || spawnBatchSize <= 0) {
      throw new Error("population v2 runtime spawn batch size must be positive");
    }
    const generationSweepMs = configuration.generationSweepMs
      ?? DEFAULT_GENERATION_SWEEP_MS;
    if (!Number.isSafeInteger(generationSweepMs) || generationSweepMs <= 0) {
      throw new Error("population generation sweep interval must be positive");
    }
    const generationSweepBatchSize = configuration.generationSweepBatchSize
      ?? DEFAULT_GENERATION_SWEEP_BATCH_SIZE;
    if (
      !Number.isSafeInteger(generationSweepBatchSize)
      || generationSweepBatchSize <= 0
    ) {
      throw new Error("population generation sweep batch must be positive");
    }
    this.planAuthority = new PopulationV2PlanAuthority(
      store,
      planner,
      configuration
    );
    this.generationFactory = new PopulationV2GenerationFactory(store);
    this.generationServer = new PopulationV2GenerationServer(store, logger);
    this.mobRegistry = configuration.mobRegistry ?? populationV2MobRegistry;
    this.kindRegistry = this.mobRegistry.populationKinds
      ?? populationV2MobRegistry.populationKinds;
    this.activationScheduler = new PopulationV2ZoneActivationScheduler(
      configuration.activationConcurrency
    );
    this.runtimeId = `game:${configuration.runtimeSha}:${process.pid}`;
    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat();
    }, heartbeatMs);
    this.heartbeatTimer.unref?.();
    this.generationSweepTimer = setInterval(() => {
      void this.sweepExpiredGenerations().catch((error: unknown) => {
        this.logger?.warn(
          { err: error },
          "population v2 generation sweep failed"
        );
      });
    }, generationSweepMs);
    this.generationSweepTimer.unref?.();
  }

  prefetchPlanEnvironmentForZones(
    input: Parameters<
      NonNullable<
        PopulationZonesV2RuntimeBackend["prefetchPlanEnvironmentForZones"]
      >
    >[0]
  ) {
    if (this.closed) return Promise.reject(
      new Error("population v2 backend is closed")
    );
    if (!this.planner.prefetchEnvironmentForZones) return Promise.reject(
      new Error("population environment prefetch is unavailable")
    );
    return this.planner.prefetchEnvironmentForZones({
      zoneIds: input.zoneIds,
      regionCode: this.configuration.regionCode,
      reason: input.trigger,
      priority: input.priority,
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  updateZoneReferences(
    input: Parameters<
      NonNullable<PopulationZonesV2RuntimeBackend["updateZoneReferences"]>
    >[0]
  ): void {
    if (this.closed) return;
    const references: Array<{
      zoneId: string;
      currentReferences: number;
      unreferencedAt?: Date;
    }> = [];
    const now = new Date();
    for (const [zoneId, currentReferences] of Object.entries(
      input.currentReferencesByZone
    ).sort(([left], [right]) => left.localeCompare(right))) {
      if (
        !Number.isSafeInteger(currentReferences)
        || currentReferences < 0
      ) {
        throw new Error(
          "population runtime reference count must be a non-negative integer"
        );
      }
      this.runtimeTrackedZones.add(zoneId);
      this.currentReferenceCountByZone.set(zoneId, currentReferences);
      if (currentReferences > 0) {
        this.unreferencedAtByZone.delete(zoneId);
        references.push({ zoneId, currentReferences });
        continue;
      }
      const unreferencedAtMs = input.unreferencedAtByZone?.[zoneId];
      const unreferencedAt = unreferencedAtMs === undefined
        ? (this.unreferencedAtByZone.get(zoneId) ?? now)
        : new Date(unreferencedAtMs);
      if (
        !Number.isFinite(unreferencedAt.getTime())
        || unreferencedAt.getTime() > now.getTime()
      ) {
        throw new Error("population unreferenced timestamp is invalid");
      }
      this.unreferencedAtByZone.set(zoneId, unreferencedAt);
      references.push({ zoneId, currentReferences, unreferencedAt });
    }
    this.queueReferenceSync(references, now);
  }

  onGenerationRefreshReady(
    listener: (zoneId: PopulationZoneV2Id) => void | Promise<void>
  ): () => void {
    this.generationRefreshListeners.add(listener);
    return () => this.generationRefreshListeners.delete(listener);
  }

  activateZones(
    input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0]
  ): Promise<readonly PopulationZoneV2BackendZoneActivation[]> {
    if (this.closed) return Promise.resolve([]);
    const zoneIds = [...new Set(input.zoneIds)].sort((left, right) =>
      (input.activationOrderByZone?.[left] ?? Infinity)
        - (input.activationOrderByZone?.[right] ?? Infinity)
      || left.localeCompare(right)
    );
    for (const zoneId of zoneIds) {
      const referenceCount = input.currentReferencesByZone?.[zoneId];
      if (referenceCount === undefined) continue;
      if (!Number.isSafeInteger(referenceCount) || referenceCount < 0) {
        return Promise.reject(
          new Error(
            "population runtime reference count must be a non-negative integer"
          )
        );
      }
      this.currentReferenceCountByZone.set(zoneId, referenceCount);
    }
    const scheduleZone = (zoneId: (typeof zoneIds)[number]) => {
      const priority = priorityForZone(input, zoneId);
      return this.activationScheduler.schedule(
        zoneId,
        priority,
        () => this.activateZonesOpen({
          ...input,
          zoneIds: [zoneId],
          priorityZoneIds: priority === 0 ? [zoneId] : [],
          priorityByZone: { [zoneId]: priority }
        }),
        populationActivationEquivalenceKey(input, zoneId)
      ).then((activations) => {
        for (const activation of activations) {
          input.onZoneActivated?.(activation);
        }
        return activations;
      });
    };
    const destinationZoneId = zoneIds.find((zoneId) =>
      priorityForZone(input, zoneId) === 0
      && input.activationOrderByZone?.[zoneId] === 0
    );
    const scheduled = destinationZoneId === undefined
      ? zoneIds.map(scheduleZone)
      : (() => {
          const destination = scheduleZone(destinationZoneId);
          const destinationSettled = destination.then(
            () => undefined,
            () => undefined
          );
          return [
            destination,
            ...zoneIds
              .filter((zoneId) => zoneId !== destinationZoneId)
              .map((zoneId) => destinationSettled.then(
                () => scheduleZone(zoneId)
              ))
          ];
        })();
    const work = Promise.all(scheduled).then((results) => results.flat());
    return this.trackActivationWork(work);
  }

  private async activateZonesOpen(
    input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0]
  ): Promise<readonly PopulationZoneV2BackendZoneActivation[]> {
    if (this.closed) return [];
    const activationStarted = performance.now();
    let planPreparationMs = 0;
    let currentGenerationLoadMs = 0;
    let generationMaterializationMs = 0;
    let combatProfileClaimMs = 0;
    let durableEntityLoadMs = 0;
    let invariantProcessingMs = 0;
    let runtimeRemovalMs = 0;
    let runtimeSpawnMs = 0;
    const zoneIds = [...new Set(input.zoneIds)].sort();
    const preparationByZone = new Map<string, {
      priority: PopulationPreparationPriority;
      targetStage: Exclude<PopulationPreparationStage, "PUBLISHED">;
      ready: boolean;
      selectedPlanId: string | null;
      reason: PopulationPreparationReason;
    }>();
    for (const zoneId of zoneIds) {
      preparationByZone.set(zoneId, {
        priority: priorityForZone(input, zoneId),
        targetStage: targetStageForZone(input, zoneId),
        ready: false,
        selectedPlanId: null,
        reason: "plan-pending"
      });
    }

    const planOnlyZoneIds = zoneIds.filter((zoneId) =>
      targetStageForZone(input, zoneId) === "PLAN_READY"
    );
    const deferredPlanZoneIds = planOnlyZoneIds.filter((zoneId) =>
      priorityForZone(input, zoneId) >= 2
      && this.configuration.backgroundPressureElevated?.() === true
    );
    const planZoneIds = planOnlyZoneIds.filter((zoneId) =>
      !deferredPlanZoneIds.includes(zoneId)
    );
    for (const priority of [0, 1, 2, 3] as const) {
      const priorityZoneIds = planZoneIds.filter((zoneId) =>
        priorityForZone(input, zoneId) === priority
      );
      if (priorityZoneIds.length === 0) continue;
      let preparation;
      const preparationStarted = performance.now();
      if (priority === 0 || priority === 1) {
        preparation = await this.planAuthority.prepareMissingZones({
          zoneIds: priorityZoneIds,
          trigger: input.trigger,
          priority
        });
      } else {
        preparation = await this.planAuthority.prepareNonServingZones({
          zoneIds: priorityZoneIds,
          trigger: input.trigger,
          priority
        });
      }
      planPreparationMs += performance.now() - preparationStarted;
      this.lastPreparationMsByPriority.set(
        priority,
        preparation.preparationMs
      );
      for (const zoneId of priorityZoneIds) {
        const plan = preparation.readyPlansByZone.get(zoneId);
        const state = preparationByZone.get(zoneId)!;
        state.ready = plan !== undefined;
        state.selectedPlanId = plan?.planId ?? null;
        state.reason = plan !== undefined
          ? "ready"
          : preparation.terminalFailureZoneIds?.includes(zoneId)
            ? "plan-terminal-failure"
            : "plan-pending";
      }
    }
    for (const zoneId of deferredPlanZoneIds) {
      preparationByZone.get(zoneId)!.reason = "backpressure-retry";
    }

    const materialized = new Map<string, PopulationZoneV2GenerationRecord>();
    const newlyMaterializedZoneIds = new Set<string>();
    const materializationStatusByZone = new Map<
      string,
      MaterializationStatus
    >();
    const pendingLifecycle = new Set<string>();
    const retiredEntityIdsByZone = new Map<string, readonly string[]>();
    const rolloverReferenceCountByZone = new Map<string, number>();
    const servingZoneIds = zoneIds.filter((zoneId) => {
      if (targetStageForZone(input, zoneId) === "PLAN_READY") return false;
      if (
        priorityForZone(input, zoneId) >= 2
        && this.configuration.backgroundPressureElevated?.() === true
      ) {
        preparationByZone.get(zoneId)!.reason = "backpressure-retry";
        return false;
      }
      return true;
    });
    const currentGenerationLoadStarted = performance.now();
    const existingByZone = await this.generationServer.loadCurrentGenerations(
      servingZoneIds
    );
    currentGenerationLoadMs += performance.now() - currentGenerationLoadStarted;
    const now = new Date();
    const missingByPriority = new Map<0 | 1, PopulationZoneV2Id[]>([
      [0, []],
      [1, []]
    ]);
    for (const zoneId of servingZoneIds) {
      const priority = priorityForZone(input, zoneId);
      const planPriority = priority === 0 ? 0 : 1;
      let generation = existingByZone.get(zoneId) ?? null;
      materializationStatusByZone.set(
        zoneId,
        generation === null
          ? "generation-missing"
          : "generation-invalid-or-unservable"
      );
      if (generation === null) {
        missingByPriority.get(planPriority)!.push(
          zoneId as PopulationZoneV2Id
        );
        continue;
      }
      materialized.set(zoneId, generation);
      this.currentGenerations.set(zoneId, generation);
      const assessment = this.generationServer.assess(generation, now);
      if (assessment.status === "servable") {
        const state = preparationByZone.get(zoneId)!;
        state.ready = true;
        state.selectedPlanId = generation.planId;
        state.reason = servingReadyReason(assessment.materializationStatus);
        materializationStatusByZone.set(
          zoneId,
          assessment.materializationStatus
        );
        if (
          assessment.materializationStatus === "materialization-current"
        ) {
          this.materializationFastPathHits += 1;
        } else {
          this.staleMaterializationServed += 1;
        }
        continue;
      }
      materializationStatusByZone.set(
        zoneId,
        assessment.status === "guarded-materialization"
          ? "guarded-materialization"
          : "generation-lifecycle-pending"
      );
      pendingLifecycle.add(zoneId);
      if (
        generation.isCurrent
        && generation.expiresAt.getTime() <= now.getTime()
      ) {
        const currentReferences =
          this.currentReferenceCountByZone.get(zoneId)
          ?? (this.activePriorityZeroZones.has(zoneId)
            ? Math.max(1, this.activeReferenceCount(zoneId))
            : this.activeReferenceCount(zoneId));
        generation = await this.store.markGenerationExpired({
          zoneId,
          generationId: generation.generationId,
          currentReferences,
          now,
          ...(currentReferences === 0
            ? { unreferencedAt: generation.generatedAt }
            : {})
        });
        if (generation !== null) {
          materialized.set(zoneId, generation);
          this.currentGenerations.set(zoneId, generation);
        } else {
          materialized.delete(zoneId);
          this.currentGenerations.delete(zoneId);
        }
        if (generation !== null && currentReferences === 0) {
          const cleaned = await this.store.cleanupExpiredGeneration({
            zoneId,
            generationId: generation.generationId,
            unreferenced: true,
            now
          });
          if (cleaned) {
            this.invariantGenerationCleanups += 1;
            this.currentGenerations.delete(zoneId);
            this.activeNonStoneCountByZone.delete(zoneId);
            materialized.delete(zoneId);
            generation = null;
          }
        }
        if (generation === null) {
          pendingLifecycle.delete(zoneId);
          missingByPriority.get(planPriority)!.push(
            zoneId as PopulationZoneV2Id
          );
        } else if (
          currentReferences > 0
          && priority === 0
          && input.activateRuntime !== false
          && populationStageAtLeast(
            targetStageForZone(input, zoneId),
            "SIMULATION_READY"
          )
          && input.challengeProfilesByZone?.[zoneId] !== undefined
        ) {
          materialized.delete(zoneId);
          rolloverReferenceCountByZone.set(zoneId, currentReferences);
          missingByPriority.get(planPriority)!.push(
            zoneId as PopulationZoneV2Id
          );
        }
      }
    }

    for (const priority of [0, 1] as const) {
      const missingZoneIds = missingByPriority.get(priority)!;
      if (missingZoneIds.length === 0) continue;
      const preparationStarted = performance.now();
      const preparation = await this.planAuthority.prepareMissingZones({
        zoneIds: missingZoneIds,
        trigger: input.trigger,
        priority
      });
      planPreparationMs += performance.now() - preparationStarted;
      this.lastPreparationMsByPriority.set(
        priority,
        preparation.preparationMs
      );
      for (const zoneId of missingZoneIds) {
        const plan = preparation.readyPlansByZone.get(zoneId);
        if (!plan) {
          if (preparation.terminalFailureZoneIds?.includes(zoneId)) {
            preparationByZone.get(zoneId)!.reason =
              "plan-terminal-failure";
          }
          pendingLifecycle.add(zoneId);
          continue;
        }
        const materializationStarted = performance.now();
        const materialization =
          await this.generationFactory.createMissingGeneration({
            zoneId,
            planId: plan.planId,
            now,
            currentReferences:
              rolloverReferenceCountByZone.get(zoneId)
              ?? this.currentReferenceCountByZone.get(zoneId)
              ?? 0,
            ...(priority === 0
              && input.activateRuntime !== false
              && populationStageAtLeast(
                targetStageForZone(input, zoneId),
                "SIMULATION_READY"
              )
              && input.challengeProfilesByZone?.[zoneId] !== undefined
              ? { replaceExpiredReferencedGeneration: true }
              : {})
          });
        generationMaterializationMs += performance.now() - materializationStarted;
        const generation = materialization.generation;
        materialized.set(zoneId, generation);
        this.currentGenerations.set(zoneId, generation);
        const assessment = this.generationServer.assess(generation, now);
        if (assessment.status === "servable") {
          const state = preparationByZone.get(zoneId)!;
          state.ready = true;
          state.selectedPlanId = generation.planId;
          state.reason = materialization.created
            ? "initial-world-generation"
            : servingReadyReason(assessment.materializationStatus);
          pendingLifecycle.delete(zoneId);
          materializationStatusByZone.set(
            zoneId,
            assessment.materializationStatus
          );
          if (
            assessment.materializationStatus ===
              "materialization-stale-but-servable"
          ) {
            this.staleMaterializationServed += 1;
          }
        } else {
          materializationStatusByZone.set(
            zoneId,
            assessment.status === "guarded-materialization"
              ? "guarded-materialization"
              : "generation-lifecycle-pending"
          );
          pendingLifecycle.add(zoneId);
        }
        if (materialization.created) {
          this.generationsCreated += 1;
          newlyMaterializedZoneIds.add(zoneId);
        } else {
          this.preventedDuplicateGenerationAttempts += 1;
        }
        if ((materialization.retiredEntityIds?.length ?? 0) > 0) {
          retiredEntityIdsByZone.set(
            zoneId,
            materialization.retiredEntityIds!
          );
        }
        if (Object.values(materialization.shortfallByKind).some(
          (count) => count > 0
        )) {
          this.logger?.warn(
            {
              zoneId,
              generationId: generation.generationId,
              shortfallByKind: materialization.shortfallByKind
            },
            "population generation exhausted safe candidate positions"
          );
        }
      }
    }

    const candidateZoneIds = servingZoneIds.filter(
      (zoneId) =>
        preparationByZone.get(zoneId)?.ready === true
        && materialized.has(zoneId)
        && !pendingLifecycle.has(zoneId)
    );
    const profileClaimZoneIds = new Set<string>();
    const profileClaims: Array<Readonly<{
      zoneId: string;
      level: number;
      source: "zone_player_profile";
      knownUnclaimed?: boolean;
    }>> = [];
    for (const zoneId of candidateZoneIds) {
      const preparation = preparationByZone.get(zoneId)!;
      const requiresRuntimeProfile =
        input.activateRuntime !== false
        && populationStageAtLeast(
          preparation.targetStage,
          "SIMULATION_READY"
        );
      if (!requiresRuntimeProfile) continue;
      const profile = input.challengeProfilesByZone?.[zoneId];
      if (preparation.priority !== 0 || profile === undefined) {
        this.logger?.warn(
          {
            zoneId,
            trigger: input.trigger,
            priority: preparation.priority,
            targetStage: preparation.targetStage,
            activateRuntimeRequested: true,
            challengeProfilePresent: profile !== undefined
          },
          "population simulation activation lacks an authoritative challenge profile"
        );
        preparation.ready = false;
        preparation.reason = "backpressure-retry";
        continue;
      }
      profileClaimZoneIds.add(zoneId);
      profileClaims.push({
        zoneId,
        level: profile.unlockedGearLevel,
        source: "zone_player_profile",
        ...(newlyMaterializedZoneIds.has(zoneId)
          ? { knownUnclaimed: true }
          : {})
      });
    }
    if (profileClaims.length > 0) {
      if (!this.store.claimMobCombatProfilesForZones) {
        throw new Error(
          "population simulation combat-profile claim store is unavailable"
        );
      }
      const combatProfileClaimStarted = performance.now();
      await this.store.claimMobCombatProfilesForZones(profileClaims);
      combatProfileClaimMs += performance.now() - combatProfileClaimStarted;
    }
    const usableZoneIds = candidateZoneIds.filter(
      (zoneId) => preparationByZone.get(zoneId)?.ready === true
    );
    const reusableDurableByZone = new Map<
      string,
      readonly PopulationZoneV2ReadyEntity[]
    >();
    for (const zoneId of usableZoneIds) {
      const expected = input.preparedAuthoritiesByZone?.[zoneId];
      const cached = this.durableReadyByZone.get(zoneId);
      const generation = materialized.get(zoneId);
      if (
        expected
        && cached
        && generation?.generationId === expected.generationId
        && samePopulationAuthority(cached.authority, expected)
        && !profileClaimZoneIds.has(zoneId)
      ) {
        reusableDurableByZone.set(zoneId, cached.entities);
      }
    }
    const durableQueryZoneIds = usableZoneIds.filter(
      (zoneId) => !reusableDurableByZone.has(zoneId)
    );
    const durableEntityLoadStarted = performance.now();
    const loadedDurableEntities = durableQueryZoneIds.length === 0
      ? []
      : await this.generationServer.loadReadyEntitiesForZones(
          durableQueryZoneIds
        );
    durableEntityLoadMs += performance.now() - durableEntityLoadStarted;
    const invariantProcessingStarted = performance.now();
    const refreshedDurableEntities = this.enforceDurableEntityInvariants(
      durableQueryZoneIds,
      materialized,
      loadedDurableEntities
    );
    for (const entity of refreshedDurableEntities) {
      if (
        profileClaimZoneIds.has(entity.zoneId)
        && this.isRuntimeMob(entity)
        && (
          entity.combatLevel === undefined
          || entity.combatTier === undefined
          || entity.combatBalanceVersion === undefined
        )
      ) {
        throw new Error(
          `population mob ${entity.entityId} remained unclaimed after authoritative profile claim`
        );
      }
    }
    invariantProcessingMs += performance.now() - invariantProcessingStarted;
    const durableEntities = [
      ...refreshedDurableEntities,
      ...[...reusableDurableByZone.values()]
        .flatMap((entities) => [...entities])
    ];
    const durableByZone = groupByZone(durableEntities);
    for (const zoneId of usableZoneIds) {
      this.activeNonStoneCountByZone.set(
        zoneId,
        (durableByZone.get(zoneId) ?? []).filter((entity) =>
          entity.generationId !== null
        ).length
      );
    }

    const simulationZoneIds = usableZoneIds.filter(
      (zoneId) => populationStageAtLeast(
        preparationByZone.get(zoneId)?.targetStage ?? null,
        "SIMULATION_READY"
      )
    );
    const simulationSet = new Set<string>(simulationZoneIds);
    const simulationEntities = durableEntities.filter((entity) =>
      simulationSet.has(entity.zoneId)
    );
    const removedEntityIds = new Map<string, string[]>();
    for (const [zoneId, entityIds] of retiredEntityIdsByZone) {
      removedEntityIds.set(zoneId, [...entityIds]);
    }
    const spawnedByZone = new Map<string, number>();
    if (input.activateRuntime !== false) {
      const runtimeRemovalStarted = performance.now();
      const removed = await this.removeRuntimeMobsMissingFrom(
        simulationZoneIds,
        simulationEntities
      );
      runtimeRemovalMs += performance.now() - runtimeRemovalStarted;
      for (const [zoneId, entityIds] of removed) {
        removedEntityIds.set(zoneId, [...new Set([
          ...(removedEntityIds.get(zoneId) ?? []),
          ...entityIds
        ])].sort());
      }
      const runtimeSpawnStarted = performance.now();
      const spawned = await this.activateRuntimeMobs(simulationEntities);
      runtimeSpawnMs += performance.now() - runtimeSpawnStarted;
      for (const [zoneId, count] of spawned) {
        spawnedByZone.set(zoneId, count);
      }
      for (const zoneId of simulationZoneIds) {
        if (!pendingLifecycle.has(zoneId)) {
          this.activePriorityZeroZones.add(zoneId);
        }
      }
    }

    for (const zoneId of retiredEntityIdsByZone.keys()) {
      this.notifyGenerationRefreshReady(zoneId as PopulationZoneV2Id);
    }

    const activations = zoneIds.map((zoneId) => {
      const preparation = preparationByZone.get(zoneId);
      const generation = materialized.get(zoneId);
      const planOnly = preparation?.targetStage === "PLAN_READY";
      const ready = preparation?.ready === true
        && (
          planOnly
          || (
            generation !== undefined
            && !pendingLifecycle.has(zoneId)
          )
        );
      const entities = ready && !planOnly
        ? (durableByZone.get(zoneId) ?? [])
        : [];
      const completedStage = !ready
        ? null
        : preparation!.targetStage;
      const authority = ready
        ? activationAuthority({
            zoneId,
            selectedPlanId:
              generation?.planId
              ?? preparation?.selectedPlanId
              ?? "",
            generation: generation ?? null,
            entities,
            runtimeId: this.runtimeId,
            registryRevision: this.kindRegistry.revision
          })
        : null;
      if (ready && !planOnly && authority) {
        this.durableReadyByZone.set(zoneId, {
          authority,
          entities: durableByZone.get(zoneId) ?? []
        });
      }
      return {
        zoneId: zoneId as PopulationZoneV2Id,
        generationId: generation?.generationId ?? null,
        generationExpiresAtMs: generation?.expiresAt.getTime() ?? null,
        status: ready ? "ready" : "pending",
        materializationStatus:
          materializationStatusByZone.get(zoneId)
          ?? (planOnly && ready
            ? "generation-missing"
            : "generation-invalid-or-unservable"),
        entities: entities.map(runtimeDescriptor),
        removedEntityIds: removedEntityIds.get(zoneId) ?? [],
        spawnedRuntimeActors: spawnedByZone.get(zoneId) ?? 0,
        completedStage,
        reason: ready
          ? (
              preparation!.reason === "durable-rehydration"
              && populationStageAtLeast(
                preparation!.targetStage,
                "SIMULATION_READY"
              )
                ? "simulation-activation"
                : preparation!.reason
            )
          : pendingReason(
              preparation?.reason,
              materializationStatusByZone.get(zoneId)
            ),
        authority
      } as PopulationZoneV2BackendZoneActivation;
    });
    const totalMs = performance.now() - activationStarted;
    const accountedMs = planPreparationMs
      + currentGenerationLoadMs
      + generationMaterializationMs
      + combatProfileClaimMs
      + durableEntityLoadMs
      + invariantProcessingMs
      + runtimeRemovalMs
      + runtimeSpawnMs;
    for (const activation of activations) {
      const details = {
        zoneId: activation.zoneId,
        status: activation.status,
        planPreparationMs,
        currentGenerationLoadMs,
        generationMaterializationMs,
        combatProfileClaimMs,
        durableEntityLoadMs,
        invariantProcessingMs,
        runtimeRemovalMs,
        runtimeSpawnMs,
        otherActivationMs: Math.max(0, totalMs - accountedMs),
        totalActivationMs: totalMs
      };
      gameplayLatencyTrace.recordActive({
        traceId: activation.zoneId,
        source: "game",
        category: "population",
        name: "population_zone_activation_breakdown",
        details
      });
      this.logger?.info?.(details, "population zone activation breakdown");
    }
    return activations;
  }

  sweepExpiredGenerations(now = new Date()): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.generationSweep) return this.generationSweep;
    const sweep = this.sweepExpiredGenerationsOpen(now);
    this.generationSweep = sweep;
    void sweep.finally(() => {
      if (this.generationSweep === sweep) this.generationSweep = null;
    }).catch(() => undefined);
    return sweep;
  }

  private async sweepExpiredGenerationsOpen(now: Date): Promise<void> {
    if (!Number.isFinite(now.getTime())) {
      throw new Error("population generation sweep timestamp is invalid");
    }
    await this.referenceSyncTail;
    if (this.closed) return;
    const generations = await this.store.loadDueCurrentGenerations({
      now,
      limit: this.configuration.generationSweepBatchSize
        ?? DEFAULT_GENERATION_SWEEP_BATCH_SIZE,
      ...(this.generationSweepCursor === null
        ? {}
        : { after: this.generationSweepCursor })
    });
    const lastGeneration = generations.at(-1);
    this.generationSweepCursor = lastGeneration === undefined
      || generations.length < (
        this.configuration.generationSweepBatchSize
          ?? DEFAULT_GENERATION_SWEEP_BATCH_SIZE
      )
      ? null
      : {
          expiresAt: lastGeneration.expiresAt,
          zoneId: lastGeneration.zoneId
        };
    for (const generation of generations) {
      if (this.closed) return;
      let currentReferences =
        this.currentReferenceCountByZone.get(generation.zoneId) ?? 0;
      let runtimeTracked = this.runtimeTrackedZones.has(generation.zoneId);
      const unreferencedAt = this.unreferencedAtByZone.get(generation.zoneId)
        ?? generation.unreferencedAt
        ?? generation.generatedAt;
      const lifecycleNow = unreferencedAt.getTime() > now.getTime()
        ? unreferencedAt
        : now;
      let expired = await this.store.markGenerationExpired({
        zoneId: generation.zoneId,
        generationId: generation.generationId,
        currentReferences,
        now: lifecycleNow,
        ...(currentReferences === 0 ? { unreferencedAt } : {})
      });
      if (expired === null) continue;
      this.currentGenerations.set(generation.zoneId, expired);
      currentReferences =
        this.currentReferenceCountByZone.get(generation.zoneId) ?? 0;
      runtimeTracked = this.runtimeTrackedZones.has(generation.zoneId);
      if (currentReferences > 0) {
        if (
          expired.currentReferenceCount !== currentReferences
          || expired.status !== "refresh-pending"
        ) {
          expired = await this.store.markGenerationExpired({
            zoneId: generation.zoneId,
            generationId: generation.generationId,
            currentReferences,
            now: lifecycleNow
          });
          if (expired !== null) {
            this.currentGenerations.set(generation.zoneId, expired);
          }
        }
        continue;
      }
      if (runtimeTracked) continue;
      const cleaned = await this.store.cleanupExpiredGeneration({
        zoneId: generation.zoneId,
        generationId: generation.generationId,
        unreferenced: true,
        now: lifecycleNow
      });
      if (!cleaned) continue;
      this.invariantGenerationCleanups += 1;
      this.currentGenerations.delete(generation.zoneId);
      this.activeNonStoneCountByZone.delete(generation.zoneId);
      this.currentReferenceCountByZone.delete(generation.zoneId);
      this.unreferencedAtByZone.delete(generation.zoneId);
      this.notifyGenerationRefreshReady(
        generation.zoneId as PopulationZoneV2Id
      );
    }
  }

  async sleepZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    unreferencedAtByZone?: Readonly<Record<string, number>>;
    currentReferencesByZone?: Readonly<Record<string, number>>;
  }>): Promise<Readonly<{
    removedEntityIds: readonly string[];
    sleptRuntimeActors: number;
  }>> {
    const zones = new Set(input.zoneIds);
    for (const zoneId of zones) {
      this.activePriorityZeroZones.delete(zoneId);
      const currentReferences =
        input.currentReferencesByZone?.[zoneId] ?? 0;
      if (currentReferences === 0) {
        this.durableReadyByZone.delete(zoneId);
      }
      this.currentReferenceCountByZone.set(zoneId, currentReferences);
      this.runtimeTrackedZones.delete(zoneId);
      const unreferencedAtMs = input.unreferencedAtByZone?.[zoneId];
      if (currentReferences > 0) {
        this.unreferencedAtByZone.delete(zoneId);
      } else if (unreferencedAtMs !== undefined) {
        this.unreferencedAtByZone.set(zoneId, new Date(unreferencedAtMs));
      }
    }
    const active = this.activeRuntimeEntitiesForZones(zones);
    await this.flushRuntimeStateWrites(active.map((entry) => entry.descriptor.entityId));
    for (const entry of active) {
      this.deleteActiveRuntimeEntity(entry.descriptor.entityId);
    }
    let sleptRuntimeActors = 0;
    for (const entry of active) {
      if (this.despawnRuntimeMob(entry, "left-authoritative-visibility")) {
        sleptRuntimeActors += 1;
      }
    }
    if (active.length > 0) {
      await this.store.releaseRuntimeEntityLeases(
        active.map((entry) => entry.lease)
      );
    }

    const now = new Date();
    this.queueReferenceSync([...zones].map((zoneId) => {
      const currentReferences =
        this.currentReferenceCountByZone.get(zoneId) ?? 0;
      return {
        zoneId,
        currentReferences,
        ...(currentReferences > 0
          || this.unreferencedAtByZone.get(zoneId) === undefined
          ? {}
          : { unreferencedAt: this.unreferencedAtByZone.get(zoneId)! })
      };
    }), now);
    await this.referenceSyncTail;
    const generations = await this.store.loadCurrentGenerations(
      [...zones].sort()
    );
    for (const generation of generations) {
      this.currentGenerations.set(generation.zoneId, generation);
      if (generation.expiresAt.getTime() > now.getTime()) continue;
      const currentReferences =
        this.currentReferenceCountByZone.get(generation.zoneId) ?? 0;
      let expired = await this.store.markGenerationExpired({
        zoneId: generation.zoneId,
        generationId: generation.generationId,
        currentReferences,
        now,
        ...(currentReferences > 0
          || input.unreferencedAtByZone?.[generation.zoneId] === undefined
          ? {}
          : {
              unreferencedAt: new Date(
                input.unreferencedAtByZone[generation.zoneId]!
              )
            })
      });
      if (expired === null) continue;
      const refreshedReferences =
        this.currentReferenceCountByZone.get(generation.zoneId) ?? 0;
      if (currentReferences === 0 && refreshedReferences > 0) {
        expired = await this.store.markGenerationExpired({
          zoneId: generation.zoneId,
          generationId: generation.generationId,
          currentReferences: refreshedReferences,
          now
        });
        if (expired === null) continue;
      }
      if (currentReferences > 0 || refreshedReferences > 0) {
        this.currentGenerations.set(generation.zoneId, expired);
        continue;
      }
      const cleaned = await this.store.cleanupExpiredGeneration({
        zoneId: generation.zoneId,
        generationId: generation.generationId,
        unreferenced: true,
        now
      });
      if (cleaned) {
        this.invariantGenerationCleanups += 1;
        this.currentGenerations.delete(generation.zoneId);
        this.activeNonStoneCountByZone.delete(generation.zoneId);
        this.currentReferenceCountByZone.delete(generation.zoneId);
        this.unreferencedAtByZone.delete(generation.zoneId);
      } else {
        this.currentGenerations.set(generation.zoneId, expired);
      }
    }

    return {
      removedEntityIds: active
        .map((entry) => entry.descriptor.entityId)
        .sort(),
      sleptRuntimeActors
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOpenBackend();
    return this.closePromise;
  }

  private async closeOpenBackend(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.generationSweepTimer);
    await this.heartbeat?.catch(() => undefined);
    await this.generationSweep?.catch(() => undefined);
    await this.referenceSyncTail;
    await Promise.allSettled([...this.activationWork]);
    const active = [...this.activeRuntimeEntities.values()];
    await this.flushRuntimeStateWrites(active.map((entry) => entry.descriptor.entityId));
    this.combat.setPopulationMobRuntimeStateSink?.(null);
    this.activeRuntimeEntities.clear();
    this.activeRuntimeEntityIdsByZone.clear();
    this.activePriorityZeroZones.clear();
    this.durableReadyByZone.clear();
    this.currentReferenceCountByZone.clear();
    this.unreferencedAtByZone.clear();
    this.runtimeTrackedZones.clear();
    this.generationRefreshListeners.clear();
    if (active.length > 0) {
      for (const entry of active) {
        this.despawnRuntimeMob(entry, "connection-replaced");
      }
      await this.store.releaseRuntimeEntityLeases(
        active.map((entry) => entry.lease)
      );
    }
  }

  private queueReferenceSync(
    references: readonly Readonly<{
      zoneId: string;
      currentReferences: number;
      unreferencedAt?: Date;
    }>[],
    now: Date
  ): void {
    if (references.length === 0) return;
    this.referenceSyncTail = this.referenceSyncTail.then(async () => {
      try {
        await this.store.updateCurrentGenerationReferences({
          references,
          now
        });
      } catch (error) {
        this.logger?.warn(
          { err: error },
          "population v2 reference synchronization failed"
        );
      }
    });
  }

  private notifyGenerationRefreshReady(
    zoneId: PopulationZoneV2Id
  ): void {
    for (const listener of this.generationRefreshListeners) {
      try {
        void Promise.resolve(listener(zoneId)).catch((error: unknown) => {
          this.logger?.warn(
            { err: error, zoneId },
            "population v2 generation refresh notification failed"
          );
        });
      } catch (error) {
        this.logger?.warn(
          { err: error, zoneId },
          "population v2 generation refresh notification failed"
        );
      }
    }
  }

  private async trackActivationWork<T>(work: Promise<T>): Promise<T> {
    this.activationWork.add(work);
    try {
      const result = await work;
      this.lastActivationError = null;
      return result;
    } catch (error) {
      this.lastActivationError = error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500);
      throw error;
    } finally {
      this.activationWork.delete(work);
    }
  }

  snapshot(): Readonly<{
    activeRuntimeActors: number;
    activeRuntimeActorsByZone: Readonly<Record<string, number>>;
    activeRuntimeActorIndexEntries: number;
    activeRuntimeActorIndexZones: number;
    activeRuntimeActorIndexConsistent: boolean;
    activationInFlight: number;
    lastActivationError: string | null;
    deduplicatedRuntimeActivations: number;
    actorInPlaceRebinds: number;
    orphanedRuntimeActorReconciliations: number;
    mobDespawnsByReason: Readonly<Record<string, number>>;
    generationsCreated: number;
    preventedDuplicateGenerationAttempts: number;
    materializationFastPathHits: number;
    staleMaterializationServed: number;
    materializationReconciliations: number;
    materializationReconciliationQueueDepth: number;
    materializationReconciliationActive: boolean;
    invariantGenerationCleanups: number;
    invariantViolations: number;
    invariantEntitiesSuppressed: number;
    registryRevision: string;
    lastPreparationMsByPriority: Readonly<{
      priority0: number | null;
      priority1: number | null;
      priority2: number | null;
    }>;
    currentGenerations: readonly Readonly<{
      zoneId: string;
      generationId: string;
      generatedAtIso: string;
      expiresAtIso: string;
      status: PopulationZoneV2GenerationRecord["status"];
      plannedNonStoneCount: number;
      activeNonStoneCount: number;
      currentReferenceCount: number;
      materializationRevision: string;
      commonSchemaRevision: string;
      materializationStatus:
        | "materialization-current"
        | "materialization-stale-but-servable"
        | "generation-lifecycle-pending"
        | "guarded-materialization";
    }>[];
  }> {
    const byZone = new Map(
      [...this.activeRuntimeEntityIdsByZone].map(([zoneId, entityIds]) =>
        [zoneId, entityIds.size] as const
      )
    );
    const activeRuntimeActorIndexEntries = [...byZone.values()]
      .reduce((total, count) => total + count, 0);
    return {
      activeRuntimeActors: this.activeRuntimeEntities.size,
      activeRuntimeActorsByZone: Object.fromEntries(
        [...byZone].sort(([left], [right]) => left.localeCompare(right))
      ),
      activeRuntimeActorIndexEntries,
      activeRuntimeActorIndexZones: byZone.size,
      activeRuntimeActorIndexConsistent:
        activeRuntimeActorIndexEntries === this.activeRuntimeEntities.size
        && this.activeRuntimeActorIndexIsConsistent(),
      activationInFlight: this.activationWork.size,
      lastActivationError: this.lastActivationError,
      deduplicatedRuntimeActivations: this.deduplicatedRuntimeActivations,
      actorInPlaceRebinds: this.actorInPlaceRebinds,
      orphanedRuntimeActorReconciliations:
        this.orphanedRuntimeActorReconciliations,
      mobDespawnsByReason: Object.fromEntries(this.mobDespawnsByReason),
      generationsCreated: this.generationsCreated,
      preventedDuplicateGenerationAttempts:
        this.preventedDuplicateGenerationAttempts,
      materializationFastPathHits: this.materializationFastPathHits,
      staleMaterializationServed: this.staleMaterializationServed,
      materializationReconciliations: this.materializationReconciliations,
      materializationReconciliationQueueDepth: 0,
      materializationReconciliationActive: false,
      invariantGenerationCleanups: this.invariantGenerationCleanups,
      invariantViolations: this.invariantViolations,
      invariantEntitiesSuppressed: this.invariantEntitiesSuppressed,
      registryRevision: this.kindRegistry.revision,
      lastPreparationMsByPriority: {
        priority0: this.lastPreparationMsByPriority.get(0) ?? null,
        priority1: this.lastPreparationMsByPriority.get(1) ?? null,
        priority2: this.lastPreparationMsByPriority.get(2) ?? null
      },
      currentGenerations: [...this.currentGenerations.values()]
        .sort((left, right) => left.zoneId.localeCompare(right.zoneId))
        .map((generation) => {
          const assessment = this.generationServer.assess(
            generation,
            new Date()
          );
          return {
            zoneId: generation.zoneId,
            generationId: generation.generationId,
            generatedAtIso: generation.generatedAt.toISOString(),
            expiresAtIso: generation.expiresAt.toISOString(),
            status: generation.status,
            plannedNonStoneCount: generation.plannedNonStoneCount,
            activeNonStoneCount:
              this.activeNonStoneCountByZone.get(generation.zoneId) ?? 0,
            currentReferenceCount:
              this.currentReferenceCountByZone.get(generation.zoneId)
              ?? (this.activePriorityZeroZones.has(generation.zoneId)
                ? Math.max(1, generation.currentReferenceCount)
                : generation.currentReferenceCount),
            materializationRevision:
              generation.materializationRevision ?? "legacy-unverified",
            commonSchemaRevision:
              commonSchemaRevisionForGeneration(generation),
            materializationStatus: assessment.status === "servable"
              ? assessment.materializationStatus
              : assessment.status === "guarded-materialization"
                ? "guarded-materialization"
                : "generation-lifecycle-pending"
          };
        })
    };
  }

  private activeReferenceCount(zoneId: string): number {
    return this.activeRuntimeEntityIdsByZone.get(zoneId)?.size ?? 0;
  }

  private enforceDurableEntityInvariants(
    zoneIds: readonly string[],
    generations: ReadonlyMap<string, PopulationZoneV2GenerationRecord>,
    entities: readonly PopulationZoneV2ReadyEntity[]
  ): PopulationZoneV2ReadyEntity[] {
    const requestedZones = new Set(zoneIds);
    const accepted: PopulationZoneV2ReadyEntity[] = [];
    const acceptedEntityIds = new Set<string>();
    const acceptedNonStoneByZone = new Map<string, number>();
    const violationsByZone = new Map<string, number>();
    const sorted = [...entities].sort((left, right) =>
      left.zoneId.localeCompare(right.zoneId)
      || left.entityId.localeCompare(right.entityId)
    );
    const unsupportedEntityIds = new Set<string>();
    const unsupportedPackIds = new Set<string>();
    for (const entity of sorted) {
      const definition = this.kindRegistry.definitionForKind(
        entity.entityKind
      );
      if (definition && this.isCompatibleKindEntity(definition, entity)) {
        continue;
      }
      unsupportedEntityIds.add(entity.entityId);
      if (entity.packId !== null) unsupportedPackIds.add(entity.packId);
    }
    for (const entity of sorted) {
      const generation = generations.get(entity.zoneId);
      const permanentResource = this.isPermanentResourceEntity(
        entity,
        this.kindRegistry.definitionForKind(entity.entityKind)
      );
      const acceptedNonStone = acceptedNonStoneByZone.get(entity.zoneId) ?? 0;
      const invalid =
        !requestedZones.has(entity.zoneId)
        || generation === undefined
        || acceptedEntityIds.has(entity.entityId)
        || unsupportedEntityIds.has(entity.entityId)
        || (
          entity.packId !== null
          && unsupportedPackIds.has(entity.packId)
        )
        || (permanentResource
          ? entity.generationId !== null
          : entity.generationId !== generation.generationId
            || acceptedNonStone >= generation.plannedNonStoneCount);
      if (invalid) {
        this.invariantViolations += 1;
        this.invariantEntitiesSuppressed += 1;
        violationsByZone.set(
          entity.zoneId,
          (violationsByZone.get(entity.zoneId) ?? 0) + 1
        );
        continue;
      }
      acceptedEntityIds.add(entity.entityId);
      accepted.push(entity);
      if (!permanentResource) {
        acceptedNonStoneByZone.set(entity.zoneId, acceptedNonStone + 1);
      }
    }
    for (const [zoneId, suppressedEntities] of violationsByZone) {
      this.logger?.warn(
        { zoneId, suppressedEntities },
        "population v2 invariant violation suppressed durable entities"
      );
    }
    return accepted;
  }

  private async activateRuntimeMobs(
    entities: readonly PopulationZoneV2ReadyEntity[]
  ): Promise<Map<string, number>> {
    const spawnedByZone = new Map<string, number>();
    const requested: PopulationZoneV2RuntimeLeaseRequest[] = [];
    const entityById = new Map<string, PopulationZoneV2ReadyEntity>();
    const obsolete: ActiveRuntimeEntity[] = [];
    for (const entity of entities) {
      if (!this.isRuntimeMob(entity)) continue;
      const existing = this.activeRuntimeEntities.get(entity.entityId);
      if (
        existing
        && existing.lease.cutoverRevision === entity.cutoverRevision
        && existing.lease.stateRevision === entity.stateRevision
      ) {
        this.deduplicatedRuntimeActivations += 1;
        continue;
      }
      if (
        existing
        && existing.lease.stateRevision === entity.stateRevision
        && samePhysicalRuntimeActor(existing.descriptor, entity)
      ) {
        const rebound = await this.store.rebindRuntimeEntityLease(
          existing.lease,
          runtimeLeaseRequest(this.runtimeId, entity),
          this.configuration.runtimeLeaseMs ?? DEFAULT_RUNTIME_LEASE_MS
        );
        if (
          rebound
          && this.combat.rebindPopulationAuthority(entity.entityId, {
            ownerToken: rebound.ownerToken,
            fencingGeneration: rebound.fencingGeneration,
            cutoverRevision: rebound.cutoverRevision
          })
        ) {
          this.setActiveRuntimeEntity({
            descriptor: runtimeDescriptor(entity),
            lease: rebound
          });
          this.actorInPlaceRebinds += 1;
          continue;
        }
        if (rebound) {
          this.deleteActiveRuntimeEntity(entity.entityId);
          this.despawnRuntimeMob(existing, "lease-ownership-lost");
          await this.store.releaseRuntimeEntityLeases([rebound]);
          entityById.set(entity.entityId, entity);
          requested.push(runtimeLeaseRequest(this.runtimeId, entity));
          continue;
        }
      }
      if (existing) obsolete.push(existing);
      entityById.set(entity.entityId, entity);
      requested.push(runtimeLeaseRequest(this.runtimeId, entity));
    }
    if (obsolete.length > 0) {
      for (const entry of obsolete) {
        this.deleteActiveRuntimeEntity(entry.descriptor.entityId);
        this.despawnRuntimeMob(entry, "actual-plan-cutover");
      }
      await this.store.releaseRuntimeEntityLeases(
        obsolete.map((entry) => entry.lease)
      );
    }
    const leases = requested.length === 0
      ? []
      : await this.generationServer.acquireRuntimeEntityLeases(
          requested,
          this.configuration.runtimeLeaseMs ?? DEFAULT_RUNTIME_LEASE_MS
        );
    let spawnedInBatch = 0;
    for (let index = 0; index < leases.length; index += 1) {
      const lease = leases[index]!;
      const entity = entityById.get(lease.entityId);
      if (!entity) continue;
      const descriptor = runtimeDescriptor(entity);
      const existing = this.activeRuntimeEntities.get(entity.entityId);
      if (existing) {
        this.deleteActiveRuntimeEntity(entity.entityId);
        this.despawnRuntimeMob(existing, "actual-plan-cutover");
      }
      try {
        if (this.combat.despawnPopulationManagedMob(entity.entityId)) {
          this.orphanedRuntimeActorReconciliations += 1;
          this.logger?.warn({
            entityId: entity.entityId,
            zoneId: entity.zoneId,
            ownerToken: lease.ownerToken,
            fencingGeneration: lease.fencingGeneration,
            cutoverRevision: lease.cutoverRevision
          }, "population runtime reconciled an untracked managed actor");
        }
        this.spawnRuntimeMob(entity, descriptor, lease);
      } catch (error) {
        await this.store.releaseRuntimeEntityLeases([lease]);
        throw error;
      }
      this.setActiveRuntimeEntity({ descriptor, lease });
      spawnedByZone.set(
        entity.zoneId,
        (spawnedByZone.get(entity.zoneId) ?? 0) + 1
      );
      spawnedInBatch += 1;
      if (
        spawnedInBatch >= this.runtimeSpawnBatchSize()
        && index < leases.length - 1
      ) {
        spawnedInBatch = 0;
        await yieldToEventLoop();
      }
    }
    return spawnedByZone;
  }

  private spawnRuntimeMob(
    entity: PopulationZoneV2ReadyEntity,
    descriptor: PopulationZoneV2RuntimeEntity,
    lease: PopulationZoneV2RuntimeLease
  ): void {
    if (
      entity.combatLevel === undefined
      || entity.combatTier === undefined
      || entity.combatBalanceVersion === undefined
    ) {
      throw new Error(
        `population runtime mob ${entity.entityId} has no authoritative combat profile`
      );
    }
    this.combat.spawnMob({
      entityId: entity.entityId,
      archetype: this.mobArchetype(entity),
      position: descriptor.position,
      homePosition: descriptor.homePosition,
      populationCellId: entity.zoneId,
      packId: entity.packId,
      lifeGeneration: entity.stateRevision,
      combatProfile: {
        level: entity.combatLevel,
        tier: entity.combatTier,
        balanceVersion: entity.combatBalanceVersion
      },
      populationAuthority: {
        ownerToken: lease.ownerToken,
        fencingGeneration: lease.fencingGeneration,
        cutoverRevision: lease.cutoverRevision
      },
      worldAi: true,
      regionCode: packageIdForPosition(descriptor.position),
      zoneId: zoneIdForPosition(descriptor.position),
      originFlagId: null,
      populationRuntimeState: entity.durableRuntimeState ?? {}
    });
    this.configuration.onRuntimeMobSpawned?.(entity, descriptor.position);
  }

  private runtimeSpawnBatchSize(): number {
    return this.configuration.runtimeSpawnBatchSize
      ?? DEFAULT_RUNTIME_SPAWN_BATCH_SIZE;
  }

  private isRuntimeMob(entity: PopulationZoneV2ReadyEntity): boolean {
    const kind = this.kindRegistry.definitionForKind(entity.entityKind);
    return kind?.category === "mob"
      && kind.requiresRuntimeActor
      && kind.interactionAuthorityAdapter === "combat_engine"
      && this.mobRegistry.definitionForKind(entity.entityKind) !== undefined;
  }

  private isPermanentResourceEntity(
    entity: PopulationZoneV2ReadyEntity,
    definition: PopulationV2KindDefinition | undefined
  ): boolean {
    return definition?.lifecyclePolicy === "PERMANENT_REPEATABLE"
      && definition.projectionAdapter === "permanent_resource"
      && definition.interactionAuthorityAdapter === "permanent_resource"
      && entity.archetype === `${entity.entityKind}_mine`;
  }

  private isCompatibleKindEntity(
    definition: PopulationV2KindDefinition,
    entity: PopulationZoneV2ReadyEntity
  ): boolean {
    const placementRevision =
      entity.environmentSnapshot.placementRevision;
    const lifecycleRevision =
      entity.environmentSnapshot.lifecycleRevision;
    const compatiblePlacementRevisions = this.mobRegistry
      .definitionForKind(entity.entityKind)
      ?.compatiblePlacementRevisions ?? [];
    if (
      (
        typeof placementRevision === "string"
        && placementRevision !== definition.placementRevision
        && !compatiblePlacementRevisions.includes(placementRevision)
      )
      || (
        typeof lifecycleRevision === "string"
        && lifecycleRevision !== definition.lifecycleRevision
      )
    ) return false;
    switch (definition.projectionAdapter) {
      case "combat_mob":
        return this.mobRegistry.definitionForKind(entity.entityKind)
          ?.combatArchetype === entity.archetype;
      case "generated_tree":
        return (entity.entityKind === "tree" || entity.entityKind === "flax")
          && (
            entity.archetype === "tree"
            || entity.archetype === "giving_tree"
            || entity.archetype === "flax"
          );
      case "permanent_resource":
        return entity.archetype === `${entity.entityKind}_mine`;
      case "none":
        return false;
    }
  }

  private mobArchetype(
    entity: PopulationZoneV2ReadyEntity
  ): MobArchetypeKey {
    const definition = this.mobRegistry.definitionForKind(entity.entityKind);
    if (
      definition === undefined
      || entity.archetype !== definition.combatArchetype
    ) {
      throw new Error(
        `unsupported population v2 mob archetype ${entity.archetype}`
      );
    }
    return definition.combatArchetype;
  }

  private setActiveRuntimeEntity(entry: ActiveRuntimeEntity): void {
    const entityId = entry.descriptor.entityId;
    const previous = this.activeRuntimeEntities.get(entityId);
    if (previous) {
      const previousZoneIds = this.activeRuntimeEntityIdsByZone.get(
        previous.descriptor.zoneId
      );
      previousZoneIds?.delete(entityId);
      if (previousZoneIds?.size === 0) {
        this.activeRuntimeEntityIdsByZone.delete(previous.descriptor.zoneId);
      }
    }
    this.activeRuntimeEntities.set(entityId, entry);
    const zoneIds = this.activeRuntimeEntityIdsByZone.get(
      entry.descriptor.zoneId
    ) ?? new Set<string>();
    zoneIds.add(entityId);
    this.activeRuntimeEntityIdsByZone.set(entry.descriptor.zoneId, zoneIds);
  }

  private deleteActiveRuntimeEntity(
    entityId: string
  ): ActiveRuntimeEntity | undefined {
    const existing = this.activeRuntimeEntities.get(entityId);
    if (!existing) return undefined;
    this.activeRuntimeEntities.delete(entityId);
    const zoneIds = this.activeRuntimeEntityIdsByZone.get(
      existing.descriptor.zoneId
    );
    zoneIds?.delete(entityId);
    if (zoneIds?.size === 0) {
      this.activeRuntimeEntityIdsByZone.delete(existing.descriptor.zoneId);
    }
    return existing;
  }

  private activeRuntimeEntitiesForZones(
    zoneIds: Iterable<string>
  ): ActiveRuntimeEntity[] {
    const active: ActiveRuntimeEntity[] = [];
    for (const zoneId of new Set(zoneIds)) {
      for (const entityId of this.activeRuntimeEntityIdsByZone.get(zoneId)
        ?? []) {
        const entry = this.activeRuntimeEntities.get(entityId);
        if (entry) active.push(entry);
      }
    }
    return active;
  }

  private activeRuntimeActorIndexIsConsistent(): boolean {
    for (const [entityId, entry] of this.activeRuntimeEntities) {
      if (
        !this.activeRuntimeEntityIdsByZone
          .get(entry.descriptor.zoneId)
          ?.has(entityId)
      ) return false;
    }
    for (const [zoneId, entityIds] of this.activeRuntimeEntityIdsByZone) {
      for (const entityId of entityIds) {
        if (
          this.activeRuntimeEntities.get(entityId)?.descriptor.zoneId
          !== zoneId
        ) return false;
      }
    }
    return true;
  }

  private async removeRuntimeMobsMissingFrom(
    zoneIds: readonly string[],
    durableEntities: readonly PopulationZoneV2ReadyEntity[]
  ): Promise<Map<string, string[]>> {
    const durableIds = new Set(
      durableEntities
        .filter((entity) => this.isRuntimeMob(entity))
        .map((entity) => entity.entityId)
    );
    const missing = this.activeRuntimeEntitiesForZones(zoneIds)
      .filter((entry) => !durableIds.has(entry.descriptor.entityId));
    const removedByZone = new Map<string, string[]>();
    if (missing.length === 0) return removedByZone;
    await this.flushRuntimeStateWrites(missing.map((entry) => entry.descriptor.entityId));
    for (const entry of missing) {
      this.deleteActiveRuntimeEntity(entry.descriptor.entityId);
      this.despawnRuntimeMob(entry, "durable-state-no-longer-ready");
      const removed = removedByZone.get(entry.descriptor.zoneId) ?? [];
      removed.push(entry.descriptor.entityId);
      removedByZone.set(entry.descriptor.zoneId, removed);
    }
    await this.store.releaseRuntimeEntityLeases(
      missing.map((entry) => entry.lease)
    );
    for (const removed of removedByZone.values()) removed.sort();
    return removedByZone;
  }

  private runHeartbeat(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.heartbeat) return this.heartbeat;
    this.heartbeat = this.renewLeases().finally(() => {
      this.heartbeat = null;
    });
    return this.heartbeat;
  }

  private queueRuntimeStateWrite(
    entityId: string,
    state: PopulationMobCombatRuntimeState
  ): void {
    if (!this.store.updateReadyRuntimeEntityState) return;
    const previous = this.runtimeStateWriteTails.get(entityId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const entry = this.activeRuntimeEntities.get(entityId);
      if (!entry) return;
      const updated = await this.store.updateReadyRuntimeEntityState!(
        entry.lease,
        state as unknown as Record<string, unknown>
      );
      if (!updated) {
        this.logger?.warn(
          { entityId, revision: state.revision },
          "population runtime state write lost authority"
        );
      }
    }).catch((error: unknown) => {
      this.logger?.warn(
        { err: error, entityId, revision: state.revision },
        "population runtime state write failed"
      );
    });
    this.runtimeStateWriteTails.set(entityId, next);
    void next.finally(() => {
      if (this.runtimeStateWriteTails.get(entityId) === next) {
        this.runtimeStateWriteTails.delete(entityId);
      }
    });
  }

  private async flushRuntimeStateWrites(entityIds: readonly string[]): Promise<void> {
    await Promise.allSettled(
      [...new Set(entityIds)]
        .map((entityId) => this.runtimeStateWriteTails.get(entityId))
        .filter((write): write is Promise<void> => write !== undefined)
    );
  }

  private async renewLeases(): Promise<void> {
    const active = [...this.activeRuntimeEntities.values()];
    if (active.length === 0) return;
    try {
      const outcomes = await this.store.renewRuntimeEntityLeases(
        active.map((entry) => entry.lease),
        this.configuration.runtimeLeaseMs ?? DEFAULT_RUNTIME_LEASE_MS
      );
      const outcomeById = new Map(
        outcomes.map((outcome) => [outcome.entityId, outcome.status])
      );
      for (const entry of active) {
        const status = outcomeById.get(entry.descriptor.entityId);
        if (status === "renewed") continue;
        this.deleteActiveRuntimeEntity(entry.descriptor.entityId);
        this.despawnRuntimeMob(entry, runtimeDespawnReason(status));
      }
    } catch (error) {
      this.logger?.warn(
        { err: error },
        "population v2 runtime lease heartbeat failed"
      );
    }
  }

  private despawnRuntimeMob(
    entry: ActiveRuntimeEntity,
    reason: string
  ): boolean {
    const removed = this.combat.despawnMob(entry.descriptor.entityId);
    if (removed) {
      this.mobDespawnsByReason.set(
        reason,
        (this.mobDespawnsByReason.get(reason) ?? 0) + 1
      );
      const details = {
        entityId: entry.descriptor.entityId,
        zoneId: entry.descriptor.zoneId,
        entityKind: entry.descriptor.kind,
        generationId: entry.descriptor.generationId,
        stateRevision: entry.lease.stateRevision,
        cutoverRevision: entry.lease.cutoverRevision,
        reason
      };
      if (
        reason === "lease-ownership-lost"
        || reason === "unexplained-heartbeat-loss"
      ) {
        this.logger?.warn(
          details,
          "population runtime actor lost authority unexpectedly"
        );
      } else {
        this.logger?.info?.(
          details,
          "population runtime actor completed an authoritative lifecycle transition"
        );
      }
    }
    return removed;
  }
}

function priorityForZone(
  input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0],
  zoneId: PopulationZoneV2Id
): PopulationPreparationPriority {
  const explicit = input.priorityByZone?.[zoneId];
  if (
    explicit === 0
    || explicit === 1
    || explicit === 2
    || explicit === 3
  ) return explicit;
  return input.priorityZoneIds?.includes(zoneId) ? 0 : 1;
}

function populationActivationEquivalenceKey(
  input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0],
  zoneId: PopulationZoneV2Id
): string {
  const profile = input.challengeProfilesByZone?.[zoneId];
  return [
    targetStageForZone(input, zoneId),
    input.activateRuntime === false ? "durable" : "runtime",
    profile ? challengeProfileEquivalenceKey(profile) : "no-profile"
  ].join(":");
}

function challengeProfileEquivalenceKey(
  profile: EquipmentChallengeProfile
): string {
  return [
    profile.balanceVersion,
    profile.currentGearLevel,
    profile.unlockedGearLevel,
    profile.tier,
    profile.contributors.melee,
    profile.contributors.chest,
    profile.contributors.secondary
  ].join("-");
}

function targetStageForZone(
  input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0],
  zoneId: PopulationZoneV2Id
): Exclude<PopulationPreparationStage, "PUBLISHED"> {
  const explicit = input.targetStageByZone?.[zoneId];
  if (explicit !== undefined) return explicit;
  const priority = priorityForZone(input, zoneId);
  if (priority >= 2) return "PLAN_READY";
  return priority === 0 && input.activateRuntime !== false
    ? "SIMULATION_READY"
    : "DURABLE_READY";
}

function servingReadyReason(
  status:
    | "materialization-current"
    | "materialization-stale-but-servable"
): PopulationPreparationReason {
  switch (status) {
    case "materialization-current":
    case "materialization-stale-but-servable":
      return "durable-rehydration";
  }
}

function pendingReason(
  reason: PopulationPreparationReason | undefined,
  materializationStatus:
    | PopulationZoneV2BackendZoneActivation["materializationStatus"]
    | undefined
): PopulationPreparationReason {
  if (
    reason === "backpressure-retry"
    || reason === "plan-terminal-failure"
  ) return reason;
  switch (materializationStatus) {
    case "guarded-materialization":
      return "guarded-materialization";
    case "replacement-required-materialization":
      return "replacement-required";
    case "generation-lifecycle-pending":
      return "generation-expired";
    case "generation-missing":
      return "generation-missing";
    default:
      return reason ?? "plan-pending";
  }
}

function activationAuthority(input: Readonly<{
  zoneId: string;
  selectedPlanId: string;
  generation: PopulationZoneV2GenerationRecord | null;
  entities: readonly PopulationZoneV2ReadyEntity[];
  runtimeId: string;
  registryRevision: string;
}>): PopulationZoneAuthorityFingerprint {
  const revisions = [...input.entities]
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .map((entity) => `${entity.entityId}:${entity.stateRevision}`)
    .join("|");
  const cutoverRevision = input.entities.reduce(
    (revision, entity) => Math.max(revision, entity.cutoverRevision),
    input.generation?.cutoverRevision ?? 0
  );
  return {
    zoneId: input.zoneId,
    selectedPlanId: input.selectedPlanId,
    generationId: input.generation?.generationId ?? null,
    cutoverRevision,
    commonSchemaRevision:
      input.generation === null
        ? "plan-only"
        : commonSchemaRevisionForGeneration(input.generation),
    registryRevision: input.registryRevision,
    stateRevisionFingerprint: createHash("sha256")
      .update(revisions)
      .digest("hex"),
    ownershipToken: input.generation === null
      ? `plan:${input.selectedPlanId}`
      : `${input.runtimeId}:${input.generation.generationNumber}`
  };
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

function runtimeDescriptor(
  entity: PopulationZoneV2ReadyEntity
): PopulationZoneV2RuntimeEntity {
  return {
    entityId: entity.entityId,
    zoneId: entity.zoneId as PopulationZoneV2Id,
    generationId: entity.generationId,
    kind: entity.entityKind,
    archetype: entity.archetype,
    packId: entity.packId,
    position: { lat: entity.lat, lon: entity.lon },
    homePosition: { lat: entity.anchorLat, lon: entity.anchorLon },
    stateRevision: entity.stateRevision,
    ...(entity.combatLevel === undefined
      ? {}
      : {
          combatLevel: entity.combatLevel,
          combatTier: entity.combatTier,
          combatBalanceVersion: entity.combatBalanceVersion
        }),
    ...(entity.berryAvailable === undefined ? {} : { berryAvailable: entity.berryAvailable }),
    ...(entity.resinAvailable === undefined
      ? {}
      : { resinAvailable: entity.resinAvailable }),
    ...(entity.sapReadyAt === undefined ? {} : { sapReadyAt: entity.sapReadyAt })
  };
}

function runtimeLeaseRequest(
  runtimeId: string,
  entity: PopulationZoneV2ReadyEntity
): PopulationZoneV2RuntimeLeaseRequest {
  return {
    entityId: entity.entityId,
    runtimeId,
    ownerToken: randomUUID(),
    cutoverRevision: entity.cutoverRevision,
    stateRevision: entity.stateRevision
  };
}

function samePhysicalRuntimeActor(
  descriptor: PopulationZoneV2RuntimeEntity,
  entity: PopulationZoneV2ReadyEntity
): boolean {
  return descriptor.entityId === entity.entityId
    && descriptor.zoneId === entity.zoneId
    && descriptor.generationId === entity.generationId
    && descriptor.kind === entity.entityKind
    && descriptor.archetype === entity.archetype
    && descriptor.packId === entity.packId
    && descriptor.stateRevision === entity.stateRevision
    && descriptor.position.lat === Number(entity.lat)
    && descriptor.position.lon === Number(entity.lon)
    && descriptor.homePosition.lat === Number(entity.anchorLat)
    && descriptor.homePosition.lon === Number(entity.anchorLon);
}

function runtimeDespawnReason(
  status: PopulationRuntimeLeaseRenewalOutcome["status"] | undefined
): string {
  switch (status) {
    case "durable-state-no-longer-ready":
      return "killed";
    case "actual-cutover":
      return "actual-plan-cutover";
    case "lease-ownership-lost":
    case undefined:
      return "lease-ownership-lost";
    case "renewed":
      return "unexplained-heartbeat-loss";
  }
}

function groupByZone(
  entities: readonly PopulationZoneV2ReadyEntity[]
): Map<string, PopulationZoneV2ReadyEntity[]> {
  const grouped = new Map<string, PopulationZoneV2ReadyEntity[]>();
  for (const entity of entities) {
    const group = grouped.get(entity.zoneId) ?? [];
    group.push(entity);
    grouped.set(entity.zoneId, group);
  }
  for (const group of grouped.values()) {
    group.sort((left, right) => left.entityId.localeCompare(right.entityId));
  }
  return grouped;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

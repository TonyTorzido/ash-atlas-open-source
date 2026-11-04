import {
  POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION
} from "./populationZoneV3HabitatCompiler.js";
import type { PopulationZoneV2Id } from "./populationZonesV2Geometry.js";
import {
  populationZoneV2CanonicalRegionCode,
  type PopulationZonesV2Planner
} from "./populationZonesV2Planner.js";
import {
  POPULATION_GENERATION_MATERIALIZATION_REVISION,
  populationZoneV2PlanRequest,
  type PopulationZoneV2GenerationMaterialization,
  type PopulationZoneV2GenerationRecord,
  type PopulationZoneV2PlanRecord,
  type PopulationZoneV2ReadyEntity,
  type PopulationZoneV2RuntimeLease,
  type PopulationZoneV2RuntimeLeaseRequest
} from "./populationZonesV2Store.js";

const DEFAULT_ACTIVATION_CONCURRENCY = 8;
const MAX_UNKNOWN_MATERIALIZATION_WARNINGS = 128;

export const POPULATION_V2_COMPATIBLE_MATERIALIZATION_REVISIONS =
  new Set<string>([
    POPULATION_GENERATION_MATERIALIZATION_REVISION,
    "population-generation-materialization-v13-animal-biome-variants",
    "population-generation-materialization-v12-deer-biome-variants",
    "population-generation-materialization-v11-aquatic-balance",
    "population-generation-materialization-v10-flax-plant",
    "population-generation-materialization-v9-coastal-body-density",
    "population-generation-materialization-v8-coastal-crab",
    "population-generation-materialization-v7-jellyfish-water-balance",
    "population-generation-materialization-v6-mysterious-traveler",
    "population-generation-materialization-v5-land-balance-v2",
    "population-generation-materialization-v4-encounter-tables-v1",
    "population-generation-materialization-v1",
    "population-generation-materialization-v2",
    "population-generation-materialization-v3",
    "legacy-unverified"
  ]);

type PlanAuthorityStore = Readonly<{
  ensurePlansForZones?(
    requests: readonly ReturnType<typeof populationZoneV2PlanRequest>[]
  ): Promise<PopulationZoneV2PlanRecord[]>;
  ensurePlanForZone(
    request: ReturnType<typeof populationZoneV2PlanRequest>
  ): Promise<PopulationZoneV2PlanRecord>;
}>;

type GenerationFactoryStore = Readonly<{
  createCurrentGeneration(input: Readonly<{
    zoneId: string;
    planId: string;
    now?: Date;
    currentReferences?: number;
    replaceExpiredReferencedGeneration?: boolean;
  }>): Promise<PopulationZoneV2GenerationMaterialization>;
}>;

type GenerationServerStore = Readonly<{
  loadCurrentServingPlanGenerations?(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2GenerationRecord[]>;
  loadCurrentGenerations(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2GenerationRecord[]>;
  loadReadyEntitiesForZones(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2ReadyEntity[]>;
  acquireRuntimeEntityLeases(
    requests: readonly PopulationZoneV2RuntimeLeaseRequest[],
    leaseMs: number
  ): Promise<PopulationZoneV2RuntimeLease[]>;
}>;

type PlanPriority = 0 | 1 | 2 | 3;

export type PopulationV2PlanPreparation = Readonly<{
  readyPlansByZone: ReadonlyMap<string, PopulationZoneV2PlanRecord>;
  pendingZoneIds: readonly string[];
  terminalFailureZoneIds?: readonly string[];
  preparationMs: number;
}>;

/**
 * Owns immutable plan selection and preparation. It deliberately has no
 * generation materialization or live-maintenance dependency.
 */
export class PopulationV2PlanAuthority {
  constructor(
    private readonly store: PlanAuthorityStore,
    private readonly planner: Pick<
      PopulationZonesV2Planner,
      "scheduleZones" | "scheduleZonesAndWait"
    >,
    private readonly configuration: Readonly<{
      regionCode: string;
      worldEnvironmentIdentityKey: string;
      worldPipelineSha: string;
    }>
  ) {}

  async prepareMissingZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    trigger: string;
    priority: 0 | 1;
  }>): Promise<PopulationV2PlanPreparation> {
    const zoneIds = [...new Set(input.zoneIds)].sort();
    if (zoneIds.length === 0) return emptyPlanPreparation();
    const startedAt = performance.now();
    const preparation = await this.planner.scheduleZonesAndWait({
      zoneIds,
      regionCode: this.configuration.regionCode,
      reason: `population-v2:${input.trigger}`,
      priority: input.priority
    });
    const readyPlansByZone = await this.ensureReadyPlans(
      preparation.readyZoneIds
    );
    const terminalFailureZoneIds =
      preparation.terminalFailureZoneIds ?? [];
    return {
      readyPlansByZone,
      pendingZoneIds: zoneIds.filter((zoneId) =>
        !readyPlansByZone.has(zoneId)
        && !terminalFailureZoneIds.includes(zoneId)
      ),
      ...(terminalFailureZoneIds.length === 0
        ? {}
        : { terminalFailureZoneIds }),
      preparationMs: performance.now() - startedAt
    };
  }

  private async ensureReadyPlans(
    zoneIds: readonly PopulationZoneV2Id[]
  ): Promise<ReadonlyMap<string, PopulationZoneV2PlanRecord>> {
    const readyZoneIds = [...new Set(zoneIds)].sort();
    const planRequests = readyZoneIds.map((zoneId) =>
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
    const plans = this.store.ensurePlansForZones
      ? await this.store.ensurePlansForZones(planRequests)
      : await Promise.all(planRequests.map((request) =>
          this.store.ensurePlanForZone(request)
        ));
    const readyPlansByZone = new Map<string, PopulationZoneV2PlanRecord>();
    for (const plan of plans) {
      if (plan.status === "ready") {
        readyPlansByZone.set(plan.identity.zoneId, plan);
      }
    }
    return readyPlansByZone;
  }

  async prepareNonServingZones(input: Readonly<{
    zoneIds: readonly PopulationZoneV2Id[];
    trigger: string;
    priority?: 2 | 3;
  }>): Promise<PopulationV2PlanPreparation> {
    const zoneIds = [...new Set(input.zoneIds)].sort();
    if (zoneIds.length === 0) return emptyPlanPreparation();
    const startedAt = performance.now();
    const preparation = await this.planner.scheduleZones({
      zoneIds,
      regionCode: this.configuration.regionCode,
      reason: `population-v2:${input.trigger}`,
      priority: 2
    });
    const readyPlansByZone = await this.ensureReadyPlans(
      preparation.readyZoneIds
    );
    const terminalFailureZoneIds =
      preparation.terminalFailureZoneIds ?? [];
    return {
      readyPlansByZone,
      pendingZoneIds: zoneIds.filter((zoneId) =>
        !readyPlansByZone.has(zoneId)
        && !terminalFailureZoneIds.includes(zoneId)
      ),
      ...(terminalFailureZoneIds.length === 0
        ? {}
        : { terminalFailureZoneIds }),
      preparationMs: performance.now() - startedAt
    };
  }
}

/**
 * Creates a missing generation. Density repair is intentionally absent from
 * this service and remains an explicit store maintenance operation.
 */
export class PopulationV2GenerationFactory {
  constructor(private readonly store: GenerationFactoryStore) {}

  createMissingGeneration(input: Readonly<{
    zoneId: string;
    planId: string;
    now?: Date;
    currentReferences?: number;
    replaceExpiredReferencedGeneration?: boolean;
  }>): Promise<PopulationZoneV2GenerationMaterialization> {
    return this.store.createCurrentGeneration(input);
  }
}

export type PopulationV2GenerationServeAssessment =
  | Readonly<{
      status: "servable";
      materializationStatus:
        | "materialization-current"
        | "materialization-stale-but-servable";
      materializationRevision: string;
    }>
  | Readonly<{
      status: "lifecycle-pending";
      materializationRevision: string;
    }>
  | Readonly<{
      status: "guarded-materialization";
      materializationRevision: string;
    }>;

/**
 * Read-only serving boundary for current generations and their durable ready
 * entities. It cannot plan, create, reconcile, or roll out content.
 */
export class PopulationV2GenerationServer {
  private readonly unknownMaterializationWarnings = new Set<string>();

  constructor(
    private readonly store: GenerationServerStore,
    private readonly logger?: Readonly<{
      warn(context: unknown, message: string): void;
    }>
  ) {}

  async loadCurrentGenerations(
    zoneIds: readonly string[]
  ): Promise<ReadonlyMap<string, PopulationZoneV2GenerationRecord>> {
    const normalizedZoneIds = [...new Set(zoneIds)].sort();
    const generations = this.store.loadCurrentServingPlanGenerations
      ? await this.store.loadCurrentServingPlanGenerations(normalizedZoneIds)
      : await this.store.loadCurrentGenerations(normalizedZoneIds);
    return new Map(generations.map((generation) => [
      generation.zoneId,
      generation
    ]));
  }

  assess(
    generation: PopulationZoneV2GenerationRecord,
    now: Date
  ): PopulationV2GenerationServeAssessment {
    const materializationRevision =
      generation.materializationRevision ?? "legacy-unverified";
    if (
      !generation.isCurrent
      || generation.status !== "active"
      || generation.expiresAt.getTime() <= now.getTime()
    ) {
      return {
        status: "lifecycle-pending",
        materializationRevision
      };
    }
    if (
      !POPULATION_V2_COMPATIBLE_MATERIALIZATION_REVISIONS.has(
        materializationRevision
      )
    ) {
      this.warnUnknownMaterialization(generation, materializationRevision);
      return {
        status: "guarded-materialization",
        materializationRevision
      };
    }
    return {
      status: "servable",
      materializationStatus: materializationRevision ===
          POPULATION_GENERATION_MATERIALIZATION_REVISION
        ? "materialization-current"
        : "materialization-stale-but-servable",
      materializationRevision
    };
  }

  loadReadyEntitiesForZones(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2ReadyEntity[]> {
    return this.store.loadReadyEntitiesForZones(
      [...new Set(zoneIds)].sort()
    );
  }

  acquireRuntimeEntityLeases(
    requests: readonly PopulationZoneV2RuntimeLeaseRequest[],
    leaseMs: number
  ): Promise<PopulationZoneV2RuntimeLease[]> {
    return this.store.acquireRuntimeEntityLeases(requests, leaseMs);
  }

  private warnUnknownMaterialization(
    generation: PopulationZoneV2GenerationRecord,
    materializationRevision: string
  ): void {
    if (
      this.unknownMaterializationWarnings.size >=
        MAX_UNKNOWN_MATERIALIZATION_WARNINGS
    ) return;
    const warningKey = `${generation.zoneId}:${materializationRevision}`;
    if (this.unknownMaterializationWarnings.has(warningKey)) return;
    this.unknownMaterializationWarnings.add(warningKey);
    this.logger?.warn(
      {
        zoneId: generation.zoneId,
        generationId: generation.generationId,
        materializationRevision
      },
      "population generation has an unknown materialization revision"
    );
  }
}

type ActivationJob<T> = {
  key: string;
  equivalenceKey: string;
  priority: PlanPriority;
  sequence: number;
  work(): Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  promise: Promise<T>;
};

/**
 * Keyed activation scheduler with a reserved urgent lane. Equivalent requests
 * for one zone coalesce, different-priority requests serialize, and unrelated
 * P0/P1 work retains a reserved lane ahead of optional P2/P3 work.
 */
export class PopulationV2ZoneActivationScheduler<T> {
  private readonly maxConcurrency: number;
  private readonly maxNonurgentConcurrency: number;
  private readonly inFlightByKey = new Map<string, ActivationJob<T>>();
  private readonly queue: ActivationJob<T>[] = [];
  private readonly activeZones = new Set<string>();
  private activeCount = 0;
  private activeNonurgentCount = 0;
  private nextSequence = 0;

  constructor(maxConcurrency = DEFAULT_ACTIVATION_CONCURRENCY) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 2) {
      throw new Error(
        "population activation concurrency must be an integer of at least two"
      );
    }
    this.maxConcurrency = maxConcurrency;
    this.maxNonurgentConcurrency = maxConcurrency - 1;
  }

  schedule(
    key: string,
    priority: PlanPriority,
    work: () => Promise<T>,
    equivalenceKey = "default"
  ): Promise<T> {
    const inFlightKey = `${priority}:${key}:${equivalenceKey}`;
    const existing = this.inFlightByKey.get(inFlightKey);
    if (existing) {
      return existing.promise;
    }
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const job: ActivationJob<T> = {
      key,
      equivalenceKey,
      priority,
      sequence: this.nextSequence++,
      work,
      resolve,
      reject,
      promise
    };
    this.inFlightByKey.set(inFlightKey, job);
    this.queue.push(job);
    this.sortQueue();
    this.pump();
    return promise;
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrency) {
      const index = this.queue.findIndex((job) => this.canStart(job));
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      if (!job) return;
      this.start(job);
    }
  }

  private canStart(job: ActivationJob<T>): boolean {
    if (this.activeZones.has(job.key)) return false;
    if (job.priority <= 1) return true;
    return this.activeNonurgentCount < this.maxNonurgentConcurrency
      && !this.activeZones.has(job.key);
  }

  private start(job: ActivationJob<T>): void {
    this.activeCount += 1;
    this.activeZones.add(job.key);
    if (job.priority >= 2) {
      this.activeNonurgentCount += 1;
    }
    void Promise.resolve().then(job.work).then(
      (value) => job.resolve(value),
      (error: unknown) => job.reject(error)
    ).finally(() => {
      const inFlightKey =
        `${job.priority}:${job.key}:${job.equivalenceKey}`;
      if (this.inFlightByKey.get(inFlightKey) === job) {
        this.inFlightByKey.delete(inFlightKey);
      }
      this.activeCount -= 1;
      this.activeZones.delete(job.key);
      if (job.priority >= 2) {
        this.activeNonurgentCount -= 1;
      }
      this.pump();
    });
  }

  private sortQueue(): void {
    this.queue.sort((left, right) =>
      left.priority - right.priority
      || left.sequence - right.sequence
    );
  }
}

function emptyPlanPreparation(): PopulationV2PlanPreparation {
  return {
    readyPlansByZone: new Map(),
    pendingZoneIds: [],
    preparationMs: 0
  };
}

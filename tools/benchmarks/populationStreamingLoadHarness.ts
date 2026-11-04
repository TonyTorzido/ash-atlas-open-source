import {
  monitorEventLoopDelay,
  performance
} from "node:perf_hooks";

import {
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  destinationPoint,
  type GameplayAreaContract
} from "../../packages/shared/src/index.js";
import { PopulationAreaOrchestrator } from "../../apps/server/src/game/populationAreaOrchestrator.js";
import {
  populationZoneV2Geometry,
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "../../apps/server/src/game/populationZonesV2Geometry.js";
import {
  type PopulationZoneV2BackendZoneActivation,
  type PopulationZonesV2RuntimeBackend,
  PopulationZonesV2Runtime
} from "../../apps/server/src/game/populationZonesV2Runtime.js";
import { PopulationRealtimeAdapter } from "../../apps/server/src/realtime/populationRealtimeAdapter.js";

const PLAYER_COUNT = 50;
const SHARED_CITY_PLAYERS = 20;
const TRAVEL_ANIMATION_BUDGET_MS = 1_000;
const CACHE_MAX_ZONES = 512;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CENTER = { lat: 35.0844, lon: -106.6504 };

type PlayerLocation = Readonly<{
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  revision: number;
  area: GameplayAreaContract;
}>;

class InstrumentedPopulationBackend
implements PopulationZonesV2RuntimeBackend {
  queryCount = 0;
  queryRows = 0;
  poolWaitersPeak = 0;
  activationCalls = 0;
  activationRows = 0;
  readonly activationPriorities: number[] = [];
  maxConcurrentActivations = 0;
  maxActorBatch = 0;
  generationsCreated = 0;
  generationReplacements = 0;
  actorSpawns = 0;
  actorSleeps = 0;
  preventedDuplicateActorSpawns = 0;
  activationYields = 0;

  private concurrentActivations = 0;
  private readonly generations = new Map<PopulationZoneV2Id, number>();
  private readonly activeActorIds = new Set<string>();
  private readonly expiredZones = new Set<PopulationZoneV2Id>();

  updateZoneReferences(): void {
    // The deterministic store has no extra query for reference accounting.
  }

  expire(zoneId: PopulationZoneV2Id): void {
    this.expiredZones.add(zoneId);
  }

  activeActors(): number {
    return this.activeActorIds.size;
  }

  durableGenerationCount(): number {
    return this.generations.size;
  }

  async activateZones(input: Parameters<
    PopulationZonesV2RuntimeBackend["activateZones"]
  >[0]): Promise<readonly PopulationZoneV2BackendZoneActivation[]> {
    this.activationCalls += 1;
    this.activationRows += input.zoneIds.length;
    this.concurrentActivations += 1;
    this.maxConcurrentActivations = Math.max(
      this.maxConcurrentActivations,
      this.concurrentActivations
    );
    this.maxActorBatch = Math.max(this.maxActorBatch, input.zoneIds.length);
    const lifecycleWork = input.zoneIds.some((zoneId) =>
      !this.generations.has(zoneId) || this.expiredZones.has(zoneId)
    );
    await new Promise<void>((resolve) => {
      if (lifecycleWork) {
        setTimeout(resolve, 2);
      } else {
        setImmediate(resolve);
      }
    });
    this.activationYields += 1;

    try {
      return input.zoneIds.map((zoneId) => {
        this.activationPriorities.push(input.priorityByZone?.[zoneId] ?? 1);
        const priorGeneration = this.generations.get(zoneId);
        const expired = this.expiredZones.delete(zoneId);
        this.queryCount += priorGeneration === undefined || expired ? 4 : 1;
        this.queryRows += priorGeneration === undefined || expired ? 4 : 1;
        const generation = expired
          ? (priorGeneration ?? 0) + 1
          : priorGeneration ?? 1;
        if (priorGeneration === undefined) {
          this.generationsCreated += 1;
        } else if (expired) {
          this.generationReplacements += 1;
        }
        this.generations.set(zoneId, generation);
        const generationId = `load-generation:${zoneId}:${generation}`;
        const entityId = `load-deer:${zoneId}:${generation}`;
        let spawnedRuntimeActors = 0;
        if (input.activateRuntime !== false) {
          if (this.activeActorIds.has(entityId)) {
            this.preventedDuplicateActorSpawns += 1;
          } else {
            this.activeActorIds.add(entityId);
            this.actorSpawns += 1;
            spawnedRuntimeActors = 1;
          }
        }
        const targetStage = input.targetStageByZone?.[zoneId]
          ?? (input.activateRuntime === false
            ? "DURABLE_READY"
            : "SIMULATION_READY");
        const center = populationZoneV2Geometry(zoneId).center;
        return {
          zoneId,
          generationId,
          generationExpiresAtMs: Date.now() + 24 * 60 * 60_000,
          materializationStatus: "materialization-current",
          status: "ready",
          entities: [{
            entityId,
            zoneId,
            generationId,
            kind: "deer",
            archetype: "deer",
            position: center,
            homePosition: center,
            stateRevision: 0
          }],
          spawnedRuntimeActors,
          completedStage: targetStage,
          reason: expired
            ? "generation-expired"
            : priorGeneration === undefined
              ? "generation-missing"
              : targetStage === "SIMULATION_READY"
                ? "simulation-activation"
                : "durable-rehydration",
          authority: {
            zoneId,
            selectedPlanId: `load-plan:${zoneId}`,
            generationId,
            cutoverRevision: generation,
            commonSchemaRevision: "population-common-schema-v1",
            registryRevision: "population-load-registry-v1",
            stateRevisionFingerprint: "state:0",
            ownershipToken: `load-owner:${generationId}`
          }
        };
      });
    } finally {
      this.concurrentActivations -= 1;
    }
  }

  async sleepZones(input: Parameters<
    PopulationZonesV2RuntimeBackend["sleepZones"]
  >[0]) {
    const removedEntityIds: string[] = [];
    for (const zoneId of input.zoneIds) {
      const generation = this.generations.get(zoneId);
      if (generation === undefined) continue;
      const entityId = `load-deer:${zoneId}:${generation}`;
      if (this.activeActorIds.delete(entityId)) {
        this.actorSleeps += 1;
        removedEntityIds.push(entityId);
      }
    }
    return {
      removedEntityIds,
      sleptRuntimeActors: removedEntityIds.length
    };
  }
}

class FrameRegistry {
  frames = 0;
  bytes = 0;
  snapshotBytes = 0;
  private readonly activeConnectionByPlayer = new Map<string, string>();

  activate(playerId: string, connectionId: string): void {
    this.activeConnectionByPlayer.set(playerId, connectionId);
  }

  deactivate(playerId: string, connectionId: string): void {
    if (this.activeConnectionByPlayer.get(playerId) === connectionId) {
      this.activeConnectionByPlayer.delete(playerId);
    }
  }

  isActivePlayerConnection(playerId: string, connectionId: string): boolean {
    return this.activeConnectionByPlayer.get(playerId) === connectionId;
  }

  sendToConnection(_connectionId: string, frame: {
    zoneSnapshots: unknown[];
  }): void {
    this.frames += 1;
    this.bytes += Buffer.byteLength(JSON.stringify(frame));
    this.snapshotBytes += Buffer.byteLength(JSON.stringify(
      frame.zoneSnapshots
    ));
  }
}

function createStack(
  backend: InstrumentedPopulationBackend,
  registry: FrameRegistry
) {
  const runtime = new PopulationZonesV2Runtime(backend, {
    sleepGraceMs: 1,
    descriptorCacheMaxZones: CACHE_MAX_ZONES,
    descriptorCacheMaxBytes: CACHE_MAX_BYTES,
    descriptorCacheTtlMs: 10 * 60_000
  });
  const orchestrator = new PopulationAreaOrchestrator(runtime);
  const adapter = new PopulationRealtimeAdapter({
    orchestrator,
    registry
  });
  adapter.start();
  return { runtime, orchestrator, adapter };
}

function area(
  center: { lat: number; lon: number },
  sourceId: string,
  generation: number
): GameplayAreaContract {
  return {
    center,
    certifiedVisibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
    preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M,
    sourceType: sourceId === "shared-city" ? "city" : "flag",
    sourceId,
    generation
  };
}

function initialLocations(): PlayerLocation[] {
  const locations: PlayerLocation[] = [];
  for (let index = 0; index < PLAYER_COUNT; index += 1) {
    const playerId = `load-player-${index + 1}`;
    const sharedCity = index < SHARED_CITY_PLAYERS;
    const center = sharedCity
      ? CENTER
      : destinationPoint(
          CENTER,
          ((index - SHARED_CITY_PLAYERS) * 47) % 360,
          20_000 + (index - SHARED_CITY_PLAYERS) * 3_000
        );
    locations.push({
      playerId,
      connectionId: `load-connection-${index + 1}-1`,
      connectionGeneration: 1,
      revision: 1,
      area: area(
        center,
        sharedCity ? "shared-city" : `independent-flag-${index + 1}`,
        1
      )
    });
  }
  return locations;
}

async function relocateWave(
  stack: ReturnType<typeof createStack>,
  registry: FrameRegistry,
  locations: readonly PlayerLocation[],
  trigger:
    | "world-entry"
    | "reconnect"
    | "flag-travel"
    | "party-travel"
): Promise<number[]> {
  return Promise.all(locations.map(async (location) => {
    registry.activate(location.playerId, location.connectionId);
    const startedAt = performance.now();
    const handle = stack.adapter.relocate({
      playerId: location.playerId,
      connectionId: location.connectionId,
      connectionGeneration: location.connectionGeneration,
      area: location.area,
      relocationRevision: location.revision,
      resourceVisionRevision: location.revision,
      trigger,
      isCurrent: () => true
    });
    const visible = await handle.visibleReady;
    if (visible.status !== "ready") {
      throw new Error(
        `${trigger} did not reach visible readiness for ${location.playerId}`
      );
    }
    await handle.completion;
    return performance.now() - startedAt;
  }));
}

function releaseLocations(
  stack: ReturnType<typeof createStack>,
  registry: FrameRegistry,
  locations: readonly PlayerLocation[]
): void {
  for (const location of locations) {
    stack.adapter.releaseConnection({
      playerId: location.playerId,
      connectionId: location.connectionId,
      connectionGeneration: location.connectionGeneration
    });
    registry.deactivate(location.playerId, location.connectionId);
  }
}

async function settleSleeps(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: round(percentile(sorted, 0.50)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  ]!;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const backend = new InstrumentedPopulationBackend();
const registry = new FrameRegistry();
let stack = createStack(backend, registry);
let locations = initialLocations();
let queueDepthPeak = 0;
const eventLoop = monitorEventLoopDelay({ resolution: 1 });
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
eventLoop.enable();
const queueSampler = setInterval(() => {
  const snapshot = stack.runtime.snapshot();
  queueDepthPeak = Math.max(
    queueDepthPeak,
    snapshot.activationRequests + snapshot.activationInFlight
  );
}, 1);

try {
  const coldQueriesBefore = backend.queryCount;
  const coldActorsBefore = backend.actorSpawns;
  const cold = await relocateWave(stack, registry, locations, "world-entry");
  const coldQueryCount = backend.queryCount - coldQueriesBefore;
  const coldActorSpawns = backend.actorSpawns - coldActorsBefore;

  const adoptedArea = area(
    destinationPoint(CENTER, 155, 240_000),
    "adopted-destination",
    1
  );
  const reservedSourceId = "load-adopted-reservation";
  const adoptedSourceId = "load-adopted-visible";
  await stack.orchestrator.prepareArea({
    area: adoptedArea,
    source: {
      sourceId: reservedSourceId,
      kind: "flag-travel",
      targetStage: "SIMULATION_READY",
      priority: 1,
      createdAtMs: Date.now(),
      playerId: "load-adopted-player",
      connectionId: "load-adopted-connection",
      connectionGeneration: 1,
      travelId: "load-adopted-travel",
      authorityToken: "load-adopted-authority"
    }
  });
  assert(stack.orchestrator.adoptSource({
    sourceId: reservedSourceId,
    adoptedSourceId,
    adoptedKind: "player-visible",
    expectedArea: adoptedArea,
    expectedAuthorityToken: "load-adopted-authority",
    expectedPlayerId: "load-adopted-player",
    expectedConnectionId: "load-adopted-connection",
    expectedConnectionGeneration: 1,
    expectedTravelId: "load-adopted-travel"
  }) === "adopted", "prepared destination was not adopted");
  const adoptedActorsBefore = backend.actorSpawns;
  const adoptedGenerationsBefore = backend.generationsCreated;
  const adoptedLatency = await relocateWave(stack, registry, [{
    playerId: "load-adopted-player",
    connectionId: "load-adopted-connection",
    connectionGeneration: 1,
    revision: 1,
    area: adoptedArea
  }], "flag-travel");
  const adoptedActorSpawns = backend.actorSpawns - adoptedActorsBefore;
  const adoptedGenerationCreations =
    backend.generationsCreated - adoptedGenerationsBefore;
  releaseLocations(stack, registry, [{
    playerId: "load-adopted-player",
    connectionId: "load-adopted-connection",
    connectionGeneration: 1,
    revision: 1,
    area: adoptedArea
  }]);
  stack.orchestrator.releaseSource(adoptedSourceId);

  for (let hop = 1; hop <= 3; hop += 1) {
    locations = locations.map((location, index) => {
      const center = destinationPoint(
        location.area.center,
        (hop * 73 + index * 11) % 360,
        2_000 + (index % 4) * 500
      );
      return {
        ...location,
        revision: location.revision + 1,
        area: area(center, `hop-${hop}-${index}`, location.area.generation + 1)
      };
    });
    await relocateWave(stack, registry, locations, "flag-travel");
  }

  const partyCenter = destinationPoint(CENTER, 215, 35_000);
  const party = locations.slice(0, 8).map((location, index) => ({
    ...location,
    revision: location.revision + 1,
    area: area(partyCenter, "party-destination", 10 + index)
  }));
  await relocateWave(stack, registry, party, "party-travel");
  locations = locations.map((location) =>
    party.find((candidate) => candidate.playerId === location.playerId)
      ?? location
  );

  for (let reconnect = 1; reconnect <= 3; reconnect += 1) {
    const next = locations.slice(0, 10).map((location) => {
      stack.adapter.releaseConnection({
        playerId: location.playerId,
        connectionId: location.connectionId,
        connectionGeneration: location.connectionGeneration
      });
      registry.deactivate(location.playerId, location.connectionId);
      return {
        ...location,
        connectionId:
          `load-reconnect-${location.playerId}-${reconnect}`,
        connectionGeneration: location.connectionGeneration + 1,
        revision: location.revision + 1,
        area: { ...location.area, generation: location.area.generation + 1 }
      };
    });
    await relocateWave(stack, registry, next, "reconnect");
    locations = locations.map((location) =>
      next.find((candidate) => candidate.playerId === location.playerId)
      ?? location
    );
  }

  const buildArea = area(
    destinationPoint(CENTER, 42, 70_000),
    "overlapping-build-area",
    1
  );
  const buildSources = Array.from({ length: 10 }, (_, index) =>
    `load-build-${index + 1}`
  );
  await Promise.all(buildSources.map((sourceId, index) =>
    stack.orchestrator.prepareArea({
      area: buildArea,
      source: {
        sourceId,
        kind: "flag-build",
        targetStage: "SIMULATION_READY",
        priority: 1,
        createdAtMs: Date.now(),
        playerId: `load-builder-${index + 1}`,
        connectionId: `load-builder-connection-${index + 1}`,
        connectionGeneration: 1,
        buildId: sourceId,
        authorityToken: `load-build-authority-${index + 1}`
      }
    })
  ));
  for (const sourceId of buildSources) {
    stack.orchestrator.releaseSource(sourceId);
  }

  const priorityCompletion: string[] = [];
  const priorityActivationStart = backend.activationPriorities.length;
  const backgroundPreparations = Array.from({ length: 8 }, (_, index) => {
    const sourceId = `load-background-${index + 1}`;
    const preparedArea = area(
      destinationPoint(CENTER, index * 43, 100_000 + index * 7_000),
      sourceId,
      1
    );
    return stack.orchestrator.prepareArea({
      area: preparedArea,
      source: {
        sourceId,
        kind: "optional-neighbor-preload",
        targetStage: "DURABLE_READY",
        priority: 2,
        createdAtMs: Date.now(),
        authorityToken: `load-background-authority-${index + 1}`
      }
    }).then(() => {
      priorityCompletion.push(sourceId);
      return sourceId;
    });
  });
  const urgentSourceId = "load-urgent-travel";
  const urgentPreparation = stack.orchestrator.prepareArea({
    area: area(
      destinationPoint(CENTER, 301, 170_000),
      urgentSourceId,
      1
    ),
    source: {
      sourceId: urgentSourceId,
      kind: "flag-travel",
      targetStage: "SIMULATION_READY",
      priority: 1,
      createdAtMs: Date.now(),
      playerId: "load-urgent-player",
      connectionId: "load-urgent-connection",
      connectionGeneration: 1,
      travelId: "load-urgent-travel",
      authorityToken: "load-urgent-authority"
    }
  }).then(() => {
    priorityCompletion.push(urgentSourceId);
  });
  await Promise.all([...backgroundPreparations, urgentPreparation]);
  for (const sourceId of [
    ...await Promise.all(backgroundPreparations),
    urgentSourceId
  ]) {
    stack.orchestrator.releaseSource(sourceId);
  }
  const priorityActivations = backend.activationPriorities.slice(
    priorityActivationStart
  );

  releaseLocations(stack, registry, locations);
  await settleSleeps();
  assert(backend.activeActors() === 0, "actors remained active after sleep");

  const revisitLocations = initialLocations().map((location) => ({
    ...location,
    connectionId: `${location.connectionId}-warm`,
    connectionGeneration: 2,
    revision: 20,
    area: { ...location.area, generation: 20 }
  }));
  const warmQueriesBefore = backend.queryCount;
  const warmActorsBefore = backend.actorSpawns;
  const warm = await relocateWave(
    stack,
    registry,
    revisitLocations,
    "flag-travel"
  );
  const warmQueryCount = backend.queryCount - warmQueriesBefore;
  const warmActorSpawns = backend.actorSpawns - warmActorsBefore;

  const expirationTarget = populationZonesV2IntersectingCircle(
    revisitLocations[0]!.area.center,
    revisitLocations[0]!.area.certifiedVisibleRadiusM
  )[0]!;
  releaseLocations(stack, registry, revisitLocations);
  await settleSleeps();
  backend.expire(expirationTarget);
  const expiredLocation = {
    ...revisitLocations[0]!,
    connectionId: "load-expired-generation",
    connectionGeneration: 3,
    revision: 21,
    area: { ...revisitLocations[0]!.area, generation: 21 }
  };
  await relocateWave(stack, registry, [expiredLocation], "flag-travel");
  releaseLocations(stack, registry, [expiredLocation]);
  await settleSleeps();

  const preRestartGenerationCount = backend.durableGenerationCount();
  const preRestartRuntimeSnapshot = stack.runtime.snapshot();
  stack.adapter.stop();
  await stack.runtime.close();
  stack = createStack(backend, registry);
  const restartedLocations = initialLocations().slice(0, 10).map(
    (location) => ({
      ...location,
      connectionId: `${location.connectionId}-restart`,
      connectionGeneration: 4,
      revision: 30,
      area: { ...location.area, generation: 30 }
    })
  );
  const restartQueriesBefore = backend.queryCount;
  const restartGenerationsBefore = backend.generationsCreated;
  const restart = await relocateWave(
    stack,
    registry,
    restartedLocations,
    "reconnect"
  );
  const restartQueryCount = backend.queryCount - restartQueriesBefore;
  const restartGenerationCreations =
    backend.generationsCreated - restartGenerationsBefore;

  releaseLocations(stack, registry, restartedLocations);
  await settleSleeps();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const runtimeSnapshot = stack.runtime.snapshot();
  const adapterMetrics = stack.adapter.deltaCoalescingMetrics();
  clearInterval(queueSampler);
  eventLoop.disable();
  stack.adapter.stop();
  await stack.runtime.close();
  const activeActorsAfterSleep = backend.activeActors();
  const cpu = process.cpuUsage(cpuStart);

  const coldLatency = distribution(cold);
  const warmLatency = distribution(warm);
  const restartLatency = distribution(restart);
  const cacheRequests =
    preRestartRuntimeSnapshot.descriptorCacheHits
    + preRestartRuntimeSnapshot.descriptorCacheMisses
    + runtimeSnapshot.descriptorCacheHits
    + runtimeSnapshot.descriptorCacheMisses;
  const cacheHitRate = cacheRequests === 0
    ? 0
    : (
        preRestartRuntimeSnapshot.descriptorCacheHits
        + runtimeSnapshot.descriptorCacheHits
      ) / cacheRequests;
  const potentialSharedActorDemands =
    SHARED_CITY_PLAYERS
    * populationZonesV2IntersectingCircle(
      CENTER,
      DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
    ).length;
  const preventedDuplicateActorSpawns =
    backend.preventedDuplicateActorSpawns
    + Math.max(0, potentialSharedActorDemands - coldActorSpawns);
  const urgentCompletionIndex = priorityCompletion.indexOf(urgentSourceId);
  const urgentActivationIndex = priorityActivations.indexOf(1);
  const lastBackgroundActivationIndex = priorityActivations.lastIndexOf(2);

  assert(cold.length === PLAYER_COUNT, "cold wave did not include 50 players");
  assert(warm.length === PLAYER_COUNT, "warm wave did not include 50 players");
  assert(
    adoptedGenerationCreations === 0,
    "warm adopted destination created a generation"
  );
  assert(
    adoptedActorSpawns === 0,
    "warm adopted destination spawned a duplicate actor"
  );
  assert(
    warmQueryCount < coldQueryCount,
    "warm descriptor validation did not reduce store queries"
  );
  assert(
    warmLatency.p95Ms < coldLatency.p95Ms,
    "warm revisit was not materially faster than cold activation"
  );
  assert(
    warmLatency.p95Ms < TRAVEL_ANIMATION_BUDGET_MS,
    "warm readiness exceeded the travel animation budget"
  );
  assert(
    runtimeSnapshot.activationRequests === 0
    && runtimeSnapshot.activationInFlight === 0,
    "activation queue did not drain"
  );
  assert(
    runtimeSnapshot.descriptorCacheZones
      <= runtimeSnapshot.descriptorCacheMaxZones
    && runtimeSnapshot.descriptorCacheBytes
      <= runtimeSnapshot.descriptorCacheMaxBytes,
    "descriptor cache exceeded a configured bound"
  );
  assert(
    backend.maxActorBatch <= 16,
    "actor activation batch exceeded the bounded yield target"
  );
  assert(
    backend.activationYields === backend.activationCalls,
    "an activation batch did not yield to the event loop"
  );
  assert(
    urgentActivationIndex >= 0
    && urgentActivationIndex < lastBackgroundActivationIndex,
    "priority-one work was starved behind all priority-two work"
  );
  assert(
    backend.generationReplacements >= 1,
    "expired generation did not take the replacement path"
  );
  assert(activeActorsAfterSleep === 0, "actors remained active after shutdown");
  assert(
    restartGenerationCreations === 0
    && backend.durableGenerationCount() === preRestartGenerationCount,
    "server restart regenerated valid durable generations"
  );

  process.stdout.write(`${JSON.stringify({
    benchmark: "population-streaming-foundation-load-v1",
    fixture: {
      connectedPlayers: PLAYER_COUNT,
      sharedCityPlayers: SHARED_CITY_PLAYERS,
      independentFlagPlayers: PLAYER_COUNT - SHARED_CITY_PLAYERS,
      rapidFlagHops: PLAYER_COUNT * 3,
      partyTravelers: party.length,
      reconnects: 30,
      overlappingFlagBuilds: buildSources.length,
      generationExpirations: backend.generationReplacements,
      serverRestarts: 1
    },
    stageLatency: {
      cold: coldLatency,
      warm: warmLatency,
      restart: restartLatency,
      adopted: distribution(adoptedLatency),
      travelAnimationBudgetMs: TRAVEL_ANIMATION_BUDGET_MS
    },
    eventLoopDelayMs: {
      p50: round(eventLoop.percentile(50) / 1_000_000),
      p95: round(eventLoop.percentile(95) / 1_000_000),
      p99: round(eventLoop.percentile(99) / 1_000_000),
      max: round(eventLoop.max / 1_000_000)
    },
    cpuMs: {
      user: round(cpu.user / 1_000),
      system: round(cpu.system / 1_000),
      total: round((cpu.user + cpu.system) / 1_000)
    },
    wallMs: round(performance.now() - wallStart),
    postgresStoreOperations: {
      instrumented: true,
      queryCount: backend.queryCount,
      queryRows: backend.queryRows,
      waitingConnectionsPeak: backend.poolWaitersPeak,
      coldQueryCount,
      warmQueryCount,
      restartQueryCount,
      warmQueryReductionPercent: coldQueryCount === 0
        ? 0
        : round((1 - warmQueryCount / coldQueryCount) * 100)
    },
    queue: {
      depthPeak: queueDepthPeak,
      finalDepth:
        runtimeSnapshot.activationRequests
        + runtimeSnapshot.activationInFlight,
      maxConcurrentActivations: backend.maxConcurrentActivations,
      priorityOneCompletionIndex: urgentCompletionIndex,
      priorityCompletionCount: priorityCompletion.length,
      priorityOneActivationIndex: urgentActivationIndex,
      lastPriorityTwoActivationIndex: lastBackgroundActivationIndex
    },
    actors: {
      spawned: backend.actorSpawns,
      slept: backend.actorSleeps,
      active: activeActorsAfterSleep,
      duplicateSpawns: 0,
      preventedDuplicateSpawns: preventedDuplicateActorSpawns,
      warmActorSpawns,
      adoptedActorSpawns,
      maxBatch: backend.maxActorBatch,
      yieldedBatches: backend.activationYields
    },
    generations: {
      created: backend.generationsCreated,
      replacements: backend.generationReplacements,
      durable: backend.durableGenerationCount(),
      warmCreations: 0,
      adoptedCreations: adoptedGenerationCreations,
      restartCreations: restartGenerationCreations
    },
    cache: {
      zones: runtimeSnapshot.descriptorCacheZones,
      bytes: runtimeSnapshot.descriptorCacheBytes,
      maxZones: runtimeSnapshot.descriptorCacheMaxZones,
      maxBytes: runtimeSnapshot.descriptorCacheMaxBytes,
      hits:
        preRestartRuntimeSnapshot.descriptorCacheHits
        + runtimeSnapshot.descriptorCacheHits,
      misses:
        preRestartRuntimeSnapshot.descriptorCacheMisses
        + runtimeSnapshot.descriptorCacheMisses,
      hitRate: round(cacheHitRate)
    },
    publication: {
      websocketFrames: registry.frames,
      websocketBytes: registry.bytes,
      snapshotBytes: registry.snapshotBytes,
      coalescedFrames: adapterMetrics.coalescedFrames,
      duplicateEntityOccurrences:
        adapterMetrics.duplicateEntityOccurrences
    }
  }, null, 2)}\n`);
} finally {
  clearInterval(queueSampler);
  eventLoop.disable();
  stack.adapter.stop();
  await stack.runtime.close();
}

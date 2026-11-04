import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";

import {
  POPULATION_DENSITY_REVISION
} from "../../packages/shared/src/index.js";

import {
  POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION
} from "../../apps/server/src/game/populationZoneV3HabitatCompiler.js";
import {
  populationV2MobRegistry
} from "../../apps/server/src/game/populationV2MobRegistry.js";
import {
  PopulationV2MobRolloutService
} from "../../apps/server/src/game/populationV2MobRolloutService.js";
import { PopulationZonesV2Backend } from "../../apps/server/src/game/populationZonesV2Backend.js";
import {
  populationZoneV2Geometry,
  populationZoneV2Halo,
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "../../apps/server/src/game/populationZonesV2Geometry.js";
import {
  deterministicUuidV8,
  POPULATION_CANDIDATE_LAYOUT_VERSION,
  populationZoneV2PlanId,
  populationZoneV2PlanIdentity
} from "../../apps/server/src/game/populationZonesV2Identity.js";
import type { PopulationZonesV2Planner } from "../../apps/server/src/game/populationZonesV2Planner.js";
import { PopulationZonesV2Runtime } from "../../apps/server/src/game/populationZonesV2Runtime.js";
import {
  POPULATION_GENERATION_MATERIALIZATION_REVISION,
  type PopulationZoneV2GenerationRecord,
  type PopulationZoneV2PlanRequest,
  type PopulationZoneV2ReadyEntity,
  type PopulationZoneV2RuntimeLease,
  type PopulationZoneV2RuntimeLeaseRequest
} from "../../apps/server/src/game/populationZonesV2Store.js";

const BASELINE_SHA = "c9e43f462501ce4a0125dd33fb7d1f90526981e0";
// fdee is c9 plus only this harness and its characterization fixtures.  The
// baseline path must run there, never against the candidate source tree.
const BASELINE_HARNESS_SHA = "fdee38f4eadc16ccaad9003dec824d5103be6568";
const WORLD_IDENTITY = "9".repeat(64);
const WORLD_SHA = "a".repeat(40);
const V3_REVISION = "population-generation-materialization-v3";
const BENCHMARK_NOW = new Date("2099-01-01T00:00:00.000Z");
const candidateMode = process.argv.includes("--candidate");
if (!candidateMode) {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  const workingTreeDirty = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8"
  }).trim().length > 0;
  if (sourceSha !== BASELINE_HARNESS_SHA) {
    throw new Error(
      `baseline must run from ${BASELINE_HARNESS_SHA}; received ${sourceSha}. ` +
      "Use --candidate for the current source tree."
    );
  }
  if (workingTreeDirty) {
    throw new Error(
      "baseline must run from a clean fdee38f4 worktree; " +
      "use --candidate for modified source."
    );
  }
}
const rolloutDefinition = populationV2MobRegistry.requireDefinition(
  "sap_crawler"
);
if (
  rolloutDefinition.generationPlacement !== "registered_overlay"
  || !rolloutDefinition.existingGenerationRolloutEligible
) {
  throw new Error("benchmark rollout mob is not eligible for overlay rollout");
}
let hostPressureElevated = candidateMode;
let activationCompletedUnderPressure = false;
let rolloutStartedBeforePressureRelease = false;
const visibleReadyZones = new Set<PopulationZoneV2Id>();
const counters = {
  queries: 0,
  queryRows: 0,
  plannerCalls: 0,
  rolloutAttempts: 0,
  shortfalls: 0,
  refreshes: 0,
  deltas: 0,
  generatedActors: 0,
  leasedActors: 0,
  spawnedActors: 0,
  releasedActors: 0
};
const queryCalls = new Map<string, number>();

const origin = populationZoneV2IdForPoint({
  lat: 35.0844,
  lon: -106.6504
});
const halo8 = populationZoneV2Halo(origin, 8);
const ring9 = populationZoneV2Halo(origin, 9).filter((zoneId) =>
  !halo8.includes(zoneId)
);
const preparedZoneIds = [...halo8, ...ring9.slice(0, 2)].sort();
assertCount(preparedZoneIds.length, 219, "prepared zones");
const referencedZoneIds = preparedZoneIds.slice(0, 11);
const referencedZoneSet = new Set(referencedZoneIds);
const shortfallZoneId = referencedZoneIds[1]!;
const generations = new Map<PopulationZoneV2Id, PopulationZoneV2GenerationRecord>(
  preparedZoneIds.map((zoneId, index) => [
    zoneId,
    generationForZone(zoneId, index)
  ])
);
const entities = new Map<PopulationZoneV2Id, PopulationZoneV2ReadyEntity[]>(
  preparedZoneIds.map((zoneId) => [
    zoneId,
    entitiesForZone(zoneId, generations.get(zoneId)!)
  ])
);

const planner: Pick<
  PopulationZonesV2Planner,
  "scheduleZones" | "scheduleZonesAndWait"
> = {
  async scheduleZones(input) {
    counters.plannerCalls += 1;
    return {
      disabled: false,
      readyZoneIds: input.zoneIds,
      pendingZoneIds: []
    };
  },
  async scheduleZonesAndWait(input) {
    counters.plannerCalls += 1;
    return {
      disabled: false,
      readyZoneIds: input.zoneIds,
      pendingZoneIds: []
    };
  }
};

const backend = new PopulationZonesV2Backend(
  {
    async ensurePlansForZones(requests) {
      query("ensurePlansForZones", requests.length);
      return requests.map(readyPlan);
    },
    async ensurePlanForZone(request) {
      query("ensurePlanForZone", 1);
      return readyPlan(request);
    },
    async createCurrentGeneration(input) {
      query("createCurrentGeneration", 1);
      counters.rolloutAttempts += 1;
      await immediate();
      const current = generations.get(input.zoneId as PopulationZoneV2Id);
      if (current === undefined) throw new Error("missing benchmark generation");
      const reconciled = {
        ...current,
        materializationRevision:
          POPULATION_GENERATION_MATERIALIZATION_REVISION
      };
      generations.set(input.zoneId as PopulationZoneV2Id, reconciled);
      const shortfall = input.zoneId === shortfallZoneId;
      if (shortfall) counters.shortfalls += 1;
      return {
        generation: reconciled,
        created: false,
        entityIds: entities.get(input.zoneId as PopulationZoneV2Id)!
          .map((entity) => entity.entityId),
        shortfallByKind: {
          tree: 0,
          deer: 0,
          wolf_pack: 0,
          sap_crawler_group: shortfall ? 1 : 0
        }
      };
    },
    async loadCurrentGenerations(zoneIds) {
      query("loadCurrentGenerations", zoneIds.length);
      return zoneIds.flatMap((zoneId) => {
        const generation = generations.get(zoneId as PopulationZoneV2Id);
        return generation === undefined ? [] : [generation];
      });
    },
    async loadDueCurrentGenerations() {
      query("loadDueCurrentGenerations", 0);
      return [];
    },
    async updateCurrentGenerationReferences(input) {
      query("updateCurrentGenerationReferences", input.references.length);
      return input.references.length;
    },
    async markGenerationExpired() {
      throw new Error("benchmark generation unexpectedly expired");
    },
    async cleanupExpiredGeneration() {
      return false;
    },
    async loadReadyEntitiesForZones(zoneIds) {
      query("loadReadyEntitiesForZones", zoneIds.length);
      const rows = zoneIds.flatMap((zoneId) =>
        entities.get(zoneId as PopulationZoneV2Id) ?? []
      );
      counters.generatedActors += rows.filter((row) =>
        row.entityKind === "wolf"
      ).length;
      return rows;
    },
    async acquireRuntimeEntityLeases(requests, leaseMs) {
      query("acquireRuntimeEntityLeases", requests.length);
      counters.leasedActors += requests.length;
      return requests.map((request, index) => ({
        ...request,
        fencingGeneration: 1,
        leaseExpiresAt: new Date(BENCHMARK_NOW.getTime() + leaseMs + index)
      }));
    },
    async renewRuntimeEntityLeases(leases) {
      query("renewRuntimeEntityLeases", leases.length);
      return leases.map((lease) => ({
        entityId: lease.entityId,
        status: "renewed" as const
      }));
    },
    async rebindRuntimeEntityLease(
      _existing: PopulationZoneV2RuntimeLease,
      request: PopulationZoneV2RuntimeLeaseRequest,
      leaseMs: number
    ) {
      query("rebindRuntimeEntityLease", 1);
      counters.leasedActors += 1;
      return {
        ...request,
        fencingGeneration: 2,
        leaseExpiresAt: new Date(BENCHMARK_NOW.getTime() + leaseMs)
      };
    },
    async releaseRuntimeEntityLeases(leases) {
      query("releaseRuntimeEntityLeases", leases.length);
      counters.releasedActors += leases.length;
      return leases.length;
    }
  },
  planner,
  {
    spawnMob(input) {
      counters.spawnedActors += 1;
      return { entityId: input.entityId } as never;
    },
    despawnMob() {
      return true;
    },
    rebindPopulationAuthority() {
      return true;
    }
  },
  {
    regionCode: "population-v2-bootstrap-benchmark",
    runtimeSha: BASELINE_SHA,
    worldEnvironmentIdentityKey: WORLD_IDENTITY,
    worldPipelineSha: WORLD_SHA,
    runtimeLeaseMs: 30_000,
    runtimeHeartbeatMs: 10_000,
    runtimeSpawnBatchSize: 8,
    generationSweepMs: 60_000,
    backgroundPressureElevated: () => hostPressureElevated
  }
);
const runtime = new PopulationZonesV2Runtime(backend, { sleepGraceMs: 60_000 });
runtime.onDelta(() => {
  counters.deltas += 1;
});
const refreshWork = new Set<Promise<void>>();
const removeRefreshListener = backend.onGenerationRefreshReady((zoneId) => {
  counters.refreshes += 1;
  const work = runtime.notifyZoneReady(zoneId);
  refreshWork.add(work);
  void work.finally(() => refreshWork.delete(work));
  return work;
});
const mobRollout = new PopulationV2MobRolloutService(
  {
    async execute(request) {
      if (!visibleReadyZones.has(request.zoneId as PopulationZoneV2Id)) {
        throw new Error("rollout began before its zone was visibly ready");
      }
      if (hostPressureElevated) {
        rolloutStartedBeforePressureRelease = true;
      }
      counters.rolloutAttempts += 1;
      query("executeRegisteredMobRollout", 1);
      await immediate();
      const shortfall = request.zoneId === shortfallZoneId;
      if (shortfall) counters.shortfalls += 1;
      return {
        status: shortfall
          ? "completed_with_shortfall" as const
          : "completed" as const,
        insertedGroupCount: shortfall ? 0 : 1,
        insertedBodyCount: shortfall ? 0 : 6,
        shortfallGroupCount: shortfall ? 1 : 0,
        attemptCount: 1,
        changed: !shortfall
      };
    }
  },
  {
    enabled: candidateMode,
    queueMax: 64,
    minimumDelayMs: 1,
    eventLoopPressureElevated: () => hostPressureElevated,
    notifyRuntime: async (zoneId) => {
      counters.refreshes += 1;
      await runtime.notifyZoneReady(zoneId as PopulationZoneV2Id);
    }
  }
);

const eventLoop = monitorEventLoopDelay({ resolution: 1 });
const healthLatencies: number[] = [];
let healthSamplesWhilePressured = 0;
let healthSamplesAfterRollout = 0;
let healthRunning = true;
const healthWork = healthProbe();
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
eventLoop.enable();

try {
  const bootstraps = await Promise.all(referencedZoneIds.map(
    (zoneId, index) => relocate(zoneId, index, 1, 1, "world-entry")
  ));
  const reconnects = await Promise.all(referencedZoneIds.slice(0, 10).map(
    (zoneId, index) => relocate(zoneId, index, 2, 2, "reconnect")
  ));
  let rolloutSnapshotBeforePressureRelease = mobRollout.snapshot();
  if (candidateMode) {
    await delay(5);
    rolloutSnapshotBeforePressureRelease = mobRollout.snapshot();
    activationCompletedUnderPressure = hostPressureElevated;
    healthSamplesWhilePressured = healthLatencies.length;
    assertCount(
      rolloutSnapshotBeforePressureRelease.queueDepth,
      referencedZoneIds.length,
      "rollouts queued under pressure"
    );
    assertCount(
      rolloutSnapshotBeforePressureRelease.attempts,
      0,
      "rollout attempts before pressure release"
    );
    assertCount(
      rolloutSnapshotBeforePressureRelease.enqueued,
      referencedZoneIds.length,
      "unique rollout admissions"
    );
    assertCount(
      rolloutSnapshotBeforePressureRelease.deduplicated,
      0,
      "reconnect rollout admissions"
    );
    assertTrue(
      rolloutSnapshotBeforePressureRelease.pressurePauses > 0,
      "rollout worker did not observe host pressure"
    );
    assertTrue(
      activationCompletedUnderPressure,
      "activation did not complete while host pressure remained elevated"
    );
    assertTrue(
      healthSamplesWhilePressured > 0,
      "health probe made no progress while rollout was pressure-paused"
    );
    hostPressureElevated = false;
    await mobRollout.whenIdle();
    healthSamplesAfterRollout = healthLatencies.length;
    assertTrue(
      healthSamplesAfterRollout > healthSamplesWhilePressured,
      "health probe made no progress while rollout drained"
    );
  }
  await waitForBackgroundWork();
  await delay(5);
  const cpu = process.cpuUsage(cpuStart);
  const backendSnapshot = backend.snapshot();
  const runtimeSnapshot = runtime.snapshot();
  assertCount(runtimeSnapshot.referencedZones, 11, "current references");
  assertCount(backendSnapshot.activeRuntimeActors, 11, "active actors");
  const mobRolloutSnapshot = mobRollout.snapshot();
  if (candidateMode) {
    assertCount(counters.shortfalls, 1, "deterministic rollout shortfalls");
    assertCount(
      counters.rolloutAttempts,
      referencedZoneIds.length,
      "post-ready rollout attempts"
    );
    assertCount(
      counters.refreshes,
      referencedZoneIds.length - 1,
      "successful rollout runtime refreshes"
    );
    assertCount(counters.plannerCalls, 0, "activation planner calls");
    assertCount(
      mobRolloutSnapshot.completed,
      referencedZoneIds.length - 1,
      "completed registered-mob rollouts"
    );
    assertCount(
      mobRolloutSnapshot.completedWithShortfall,
      1,
      "registered-mob rollout shortfalls"
    );
    assertCount(
      mobRolloutSnapshot.attempts,
      referencedZoneIds.length,
      "registered-mob worker attempts"
    );
    assertCount(
      mobRolloutSnapshot.retryableFailures,
      0,
      "registered-mob rollout retries"
    );
    assertCount(
      mobRolloutSnapshot.runtimeRefreshes,
      referencedZoneIds.length - 1,
      "registered-mob worker refreshes"
    );
    assertCount(
      mobRolloutSnapshot.noOpCompletions,
      1,
      "registered-mob no-op completions"
    );
    assertCount(
      mobRolloutSnapshot.queueDepth,
      0,
      "registered-mob rollout queue after drain"
    );
    assertTrue(
      !mobRolloutSnapshot.active,
      "registered-mob rollout remained active after drain"
    );
    assertTrue(
      !rolloutStartedBeforePressureRelease,
      "registered-mob rollout started before pressure release"
    );
  } else {
    assertCount(counters.shortfalls, 1, "deterministic shortfalls");
  }

  eventLoop.disable();
  healthRunning = false;
  await healthWork;
  process.stdout.write(`${JSON.stringify({
    benchmark: candidateMode
      ? "population-v2-bootstrap-candidate-v1"
      : "population-v2-bootstrap-baseline-v1",
    mode: candidateMode ? "candidate" : "baseline",
    baselineSha: BASELINE_SHA,
    fixture: {
      preparedZones: preparedZoneIds.length,
      currentGenerations: generations.size,
      currentZoneReferences: runtimeSnapshot.referencedZones,
      independentPlayers: 11,
      reconnects: 10,
      materializationV2Rows: [...generations.values()].filter((generation) =>
        generation.materializationRevision ===
          POPULATION_GENERATION_MATERIALIZATION_REVISION
      ).length,
      materializationV3Rows: [...generations.values()].filter((generation) =>
        generation.materializationRevision === V3_REVISION
      ).length
    },
    playerBootstrapMs: distribution(bootstraps),
    playerReconnectMs: distribution(reconnects),
    eventLoopDelayMs: {
      p50: nsToMs(eventLoop.percentile(50)),
      p95: nsToMs(eventLoop.percentile(95)),
      p99: nsToMs(eventLoop.percentile(99)),
      max: nsToMs(eventLoop.max)
    },
    healthProbeLatencyMs: distribution(healthLatencies),
    cpuMs: {
      user: usToMs(cpu.user),
      system: usToMs(cpu.system),
      total: usToMs(cpu.user + cpu.system)
    },
    wallMs: ms(performance.now() - wallStart),
    database: {
      queryCount: counters.queries,
      queryRows: counters.queryRows,
      poolWaitersPeak: 0,
      callsByOperation: Object.fromEntries(
        [...queryCalls].sort(([left], [right]) => left.localeCompare(right))
      )
    },
    plannerCalls: counters.plannerCalls,
    rolloutAttempts: counters.rolloutAttempts,
    deterministicShortfalls: counters.shortfalls,
    registeredMobRollout: {
      ...mobRolloutSnapshot,
      queuedWhileHostPressured:
        rolloutSnapshotBeforePressureRelease.queueDepth,
      attemptsBeforePressureRelease:
        rolloutSnapshotBeforePressureRelease.attempts,
      completedBootstrapsBeforePressureRelease: bootstraps.length,
      completedReconnectsBeforePressureRelease: reconnects.length,
      healthSamplesWhilePressured,
      healthSamplesAfterRollout,
      activationCompletedUnderPressure,
      startedBeforePressureRelease: rolloutStartedBeforePressureRelease
    },
    runtimeRefreshes: counters.refreshes,
    populationDeltas: counters.deltas,
    actors: {
      generated: counters.generatedActors,
      leased: counters.leasedActors,
      spawned: counters.spawnedActors,
      released: counters.releasedActors,
      active: backendSnapshot.activeRuntimeActors,
      deduplicatedActivations:
        backendSnapshot.deduplicatedRuntimeActivations
    }
  }, null, 2)}\n`);
} finally {
  eventLoop.disable();
  healthRunning = false;
  await healthWork;
  removeRefreshListener();
  await mobRollout.close();
  await runtime.close();
  await backend.close();
}

async function relocate(
  zoneId: PopulationZoneV2Id,
  playerIndex: number,
  connectionGeneration: number,
  relocationRevision: number,
  trigger: "world-entry" | "reconnect"
): Promise<number> {
  const startedAt = performance.now();
  const handle = runtime.startRelocation({
    playerId: `benchmark-player-${playerIndex}`,
    connectionId: `benchmark-connection-${playerIndex}`,
    connectionGeneration,
    area: {
      center: populationZoneV2Geometry(zoneId).center,
      certifiedVisibleRadiusM: 50,
      preparedRadiusM: 100,
      sourceType: "area",
      sourceId: `benchmark-area-${zoneId}`,
      generation: 1
    },
    relocationRevision,
    resourceVisionRevision: relocationRevision,
    trigger
  });
  const visible = await handle.visibleReady;
  if (visible.status !== "ready") {
    throw new Error(`player ${playerIndex} readiness was ${visible.status}`);
  }
  visibleReadyZones.add(zoneId);
  if (candidateMode && trigger === "world-entry") {
    const generation = generations.get(zoneId);
    if (generation === undefined) {
      throw new Error(`missing benchmark generation for ${zoneId}`);
    }
    mobRollout.enqueue({
      generationId: generation.generationId,
      zoneId,
      mobKind: rolloutDefinition.mobKind,
      rolloutRevision: rolloutDefinition.placementRevision,
      referenced: true
    });
  }
  const elapsed = performance.now() - startedAt;
  const completion = await handle.completion;
  if (completion.status !== "completed") {
    throw new Error(`player ${playerIndex} completion was ${completion.status}`);
  }
  return elapsed;
}

async function healthProbe(): Promise<void> {
  while (healthRunning) {
    await delay(1);
    const startedAt = performance.now();
    await immediate();
    backend.snapshot();
    healthLatencies.push(performance.now() - startedAt);
  }
}

async function waitForBackgroundWork(): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const snapshot = backend.snapshot();
    if (
      !snapshot.materializationReconciliationActive
      && snapshot.materializationReconciliationQueueDepth === 0
      && refreshWork.size === 0
    ) return;
    await immediate();
  }
  throw new Error("bounded background work did not settle");
}

function readyPlan(request: PopulationZoneV2PlanRequest) {
  return {
    ...request,
    status: "ready" as const,
    claimGeneration: 1,
    attemptCount: 1,
    contentHash: `benchmark-plan-${request.identity.zoneId}`
  };
}

function generationForZone(
  zoneId: PopulationZoneV2Id,
  index: number
): PopulationZoneV2GenerationRecord {
  const identity = populationZoneV2PlanIdentity({
    zoneId,
    worldEnvironmentIdentityKey: WORLD_IDENTITY,
    environmentProfileVersion:
      POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION
  });
  return {
    generationId: deterministicUuidV8("benchmark-generation", { zoneId }),
    zoneId,
    planId: populationZoneV2PlanId(identity),
    generationNumber: 1,
    generatedAt: BENCHMARK_NOW,
    expiresAt: new Date(BENCHMARK_NOW.getTime() + 48 * 60 * 60_000),
    status: "active",
    plannedNonStoneCount: 2,
    currentReferenceCount: referencedZoneSet.has(zoneId) ? 1 : 0,
    unreferencedAt: referencedZoneSet.has(zoneId) ? null : BENCHMARK_NOW,
    isCurrent: true,
    cleanedAt: null,
    densityRevision: POPULATION_DENSITY_REVISION,
    planContentHash: `benchmark-plan-${zoneId}`,
    candidateLayoutVersion: POPULATION_CANDIDATE_LAYOUT_VERSION,
    materializationRevision: index % 2 === 0
      ? POPULATION_GENERATION_MATERIALIZATION_REVISION
      : V3_REVISION
  };
}

function entitiesForZone(
  zoneId: PopulationZoneV2Id,
  generation: PopulationZoneV2GenerationRecord
): PopulationZoneV2ReadyEntity[] {
  const center = populationZoneV2Geometry(zoneId).center;
  const row = {
    planId: generation.planId,
    zoneId,
    generationId: generation.generationId,
    cutoverRevision: 1,
    encounterId: null,
    packId: null,
    packMemberIndex: null,
    lat: center.lat,
    lon: center.lon,
    anchorLat: center.lat,
    anchorLon: center.lon,
    environmentSnapshot: { benchmark: true },
    stateRevision: 0
  } as const;
  return [
    {
      ...row,
      slotId: deterministicUuidV8("benchmark-wolf-slot", { zoneId }),
      entityId: deterministicUuidV8("benchmark-wolf-entity", { zoneId }),
      entityKind: "wolf",
      archetype: "wolf",
      encounterId: deterministicUuidV8("benchmark-wolf-encounter", { zoneId }),
      packId: deterministicUuidV8("benchmark-wolf-pack", { zoneId }),
      packMemberIndex: 0,
      suppressionClass: "hostile-pack"
    },
    {
      ...row,
      slotId: deterministicUuidV8("benchmark-tree-slot", { zoneId }),
      entityId: deterministicUuidV8("benchmark-tree-entity", { zoneId }),
      entityKind: "tree",
      archetype: "giving_tree",
      suppressionClass: "none",
      resinAvailable: true
    }
  ];
}

function query(operation: string, rows: number): void {
  counters.queries += 1;
  counters.queryRows += rows;
  queryCalls.set(operation, (queryCalls.get(operation) ?? 0) + 1);
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (percent: number) => ms(sorted[
    Math.max(0, Math.ceil(percent / 100 * sorted.length) - 1)
  ] ?? 0);
  return {
    samples: sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: ms(sorted.at(-1) ?? 0)
  };
}

function nsToMs(value: number): number {
  return ms(value / 1_000_000);
}

function usToMs(value: number): number {
  return ms(value / 1_000);
}

function ms(value: number): number {
  return Number(value.toFixed(3));
}

function assertCount(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

function assertTrue(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(value: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, value));
}

import type {
  CollectibleNode,
  FlagSnapshot,
  ResourceVision,
  ResourceVisionStatus,
  WaterSourceHighlight
} from "@ash-atlas/shared";
import {
  DEFAULT_FLAG_CLAIM_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  DEFAULT_MOVE_LEASH_RADIUS_M
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type {
  CollectibleService,
  PreparedCollectibleVision
} from "../game/collectibles.js";
import {
  ResourceVisionJobQueue,
  visionForJob,
  type PreparedResourceVisionPlan
} from "../game/resourceVisionJobs.js";
import type {
  ClaimedResourceVisionJob,
  DurableResourceVisionJobMetrics,
  ResourceVisionJobContract,
  ResourceVisionJobStatus,
  ResourceVisionJobStore
} from "../game/resourceVisionJobStore.js";

const FLAG = flagSnapshot("11111111-1111-4111-8111-111111111111");

describe("ResourceVisionJobQueue", () => {
  it("does not regenerate a ready resource vision", async () => {
    const service = fakeCollectibles({
      initialStatus: statusFor(FLAG.id, "ready", DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M)
    });
    const store = new MemoryResourceVisionJobStore([FLAG.id]);
    const queue = createQueue(service.collectibles, store);
    const onComplete = vi.fn();

    const result = await queue.ensureQueued(jobInput({ onComplete }));
    await nextMicrotask();

    expect(result.queued).toBe(false);
    expect(result.status?.status).toBe("ready");
    expect(service.prepareResourceVision).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("regenerates a ready resource vision whose stored radius is stale", async () => {
    const service = fakeCollectibles({
      initialStatus: statusFor(FLAG.id, "ready", DEFAULT_MOVE_LEASH_RADIUS_M)
    });
    const queue = createQueue(service.collectibles);

    const result = await queue.ensureQueued(jobInput());
    await waitFor(() => service.currentStatus()?.status === "ready");

    expect(result.queued).toBe(true);
    expect(service.markResourceVisionPending).toHaveBeenCalledOnce();
    expect(service.prepareResourceVision).toHaveBeenCalledOnce();
    expect(service.currentStatus()?.radiusM).toBe(DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M);
  });

  it("collapses duplicate queued jobs for the same flag", async () => {
    const deferred = createDeferred<void>();
    const service = fakeCollectibles({
      prepare: async () => {
        await deferred.promise;
      }
    });
    const queue = createQueue(service.collectibles);

    const first = await queue.ensureQueued(jobInput());
    const second = await queue.ensureQueued(jobInput());
    await nextMicrotask();

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect((await queue.refreshMetricsSnapshot()).durable.processing).toBe(1);
    expect(service.markResourceVisionPending).toHaveBeenCalledOnce();
    expect(service.prepareResourceVision).toHaveBeenCalledOnce();

    deferred.resolve();
    await waitFor(() => service.currentStatus()?.status === "ready");
    expect(service.commitResourceVision).toHaveBeenCalledOnce();
  });

  it("retries failed resource visions without the original caller remaining connected", async () => {
    let attempt = 0;
    const completion = vi.fn();
    const service = fakeCollectibles({
      initialStatus: statusFor(FLAG.id, "failed"),
      prepare: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("world API down");
        }
      }
    });
    const queue = createQueue(service.collectibles);

    await queue.ensureQueued(jobInput({ onComplete: completion }));
    await waitFor(() => completion.mock.calls.length === 1);

    expect(service.markResourceVisionFailed).toHaveBeenCalledOnce();
    expect(service.commitResourceVision).toHaveBeenCalledOnce();
    expect(completion).toHaveBeenCalledOnce();
  });

  it("contains errors while persisting a failed job status", async () => {
    const generationError = new Error("world API down");
    const statusError = new Error("database unavailable");
    const service = fakeCollectibles({
      prepare: async () => {
        throw generationError;
      }
    });
    service.markResourceVisionFailed.mockRejectedValueOnce(statusError);
    const logger = loggerStub();
    const queue = createQueue(service.collectibles, undefined, 2, logger);
    const onComplete = vi.fn();

    await queue.ensureQueued(jobInput({ onComplete }));
    await waitFor(() => service.prepareResourceVision.mock.calls.length === 8);
    await waitFor(() => queue.metricsSnapshot().active === 0);

    expect(onComplete).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        err: statusError,
        jobError: generationError,
        flagId: FLAG.id
      },
      "failed to persist resource vision failure status"
    );
  });

  it("keeps preparation concurrency bounded", async () => {
    const deferred = createDeferred<void>();
    let active = 0;
    let maximumActive = 0;
    const service = fakeCollectibles({
      prepare: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await deferred.promise;
        active -= 1;
      }
    });
    const queue = createQueue(service.collectibles, undefined, 2);

    await Promise.all([
      queue.ensureQueued(jobInput({ flag: flagSnapshot("11111111-1111-4111-8111-111111111101") })),
      queue.ensureQueued(jobInput({ flag: flagSnapshot("11111111-1111-4111-8111-111111111102") })),
      queue.ensureQueued(jobInput({ flag: flagSnapshot("11111111-1111-4111-8111-111111111103") }))
    ]);
    await waitFor(() => service.prepareResourceVision.mock.calls.length === 2);

    expect(maximumActive).toBe(2);
    const during = await queue.refreshMetricsSnapshot();
    expect(during.durable.pending + during.durable.processing).toBe(3);
    deferred.resolve();
    await waitFor(() => queue.pendingCount() === 0);
    expect(maximumActive).toBe(2);
  });

  it("runs an active flag build before an already queued dev prewarm", async () => {
    const first = createDeferred<void>();
    const started: string[] = [];
    const firstFlag = flagSnapshot("11111111-1111-4111-8111-111111111201");
    const devFlag = flagSnapshot("11111111-1111-4111-8111-111111111202");
    const buildFlag = flagSnapshot("11111111-1111-4111-8111-111111111203");
    const service = fakeCollectibles({
      prepare: async (resourceVision) => {
        started.push(resourceVision.flagId);
        if (resourceVision.flagId === firstFlag.id) await first.promise;
      }
    });
    const queue = createQueue(service.collectibles, undefined, 1);

    await queue.ensureQueued(jobInput({ flag: firstFlag, reason: "flag-created" }));
    await waitFor(() => started.length === 1);
    await queue.ensureQueued(jobInput({ flag: devFlag, reason: "dev-prewarm" }));
    await queue.ensureQueued(jobInput({ flag: buildFlag, reason: "flag-build" }));
    const visitFlag = flagSnapshot("11111111-1111-4111-8111-111111111105");
    await queue.ensureQueued(jobInput({ flag: visitFlag, reason: "flag-visit" }));
    first.resolve();
    await waitFor(() => queue.pendingCount() === 0);

    expect(started).toEqual([firstFlag.id, visitFlag.id, buildFlag.id, devFlag.id]);
  });

  it("collapses one hundred simultaneous callers into one durable job", async () => {
    const deferred = createDeferred<void>();
    const service = fakeCollectibles({
      prepare: async () => {
        await deferred.promise;
      }
    });
    const store = new MemoryResourceVisionJobStore();
    const queue = createQueue(service.collectibles, store);

    const results = await Promise.all(
      Array.from({ length: 100 }, () => queue.ensureQueued(jobInput()))
    );

    expect(results.filter((result) => result.queued)).toHaveLength(1);
    expect(store.submissionCount).toBe(1);
    deferred.resolve();
    await waitFor(() => service.commitResourceVision.mock.calls.length === 1);
  });

  it("fences a stale worker before commit after ownership generation changes", async () => {
    const deferred = createDeferred<void>();
    const service = fakeCollectibles({
      prepare: async () => {
        await deferred.promise;
      }
    });
    const store = new MemoryResourceVisionJobStore();
    const queue = createQueue(service.collectibles, store, 1);
    await queue.ensureQueued(jobInput());
    await waitFor(() => service.prepareResourceVision.mock.calls.length === 1);

    store.replaceActiveOwner();
    deferred.resolve();
    await waitFor(() => queue.metricsSnapshot().active === 0);

    expect(service.commitResourceVision).not.toHaveBeenCalled();
  });

  it("bounds completion subscribers while preserving the durable job", async () => {
    const deferred = createDeferred<void>();
    const service = fakeCollectibles({
      prepare: async () => {
        await deferred.promise;
      }
    });
    const queue = createQueue(service.collectibles);
    const listeners = Array.from({ length: 200 }, () => vi.fn());

    await Promise.all(listeners.map((onComplete) => queue.ensureQueued(jobInput({ onComplete }))));

    expect(queue.metricsSnapshot().completionSubscribers).toBe(128);
    deferred.resolve();
    await waitFor(
      () => listeners.filter((listener) => listener.mock.calls.length === 1).length === 128
    );
    expect(listeners.filter((listener) => listener.mock.calls.length === 1)).toHaveLength(128);
  });

  it("adopts a prepared build plan under the deterministic durable lease exactly once", async () => {
    const service = fakeCollectibles();
    const store = new MemoryResourceVisionJobStore();
    const queue = createQueue(service.collectibles, store, 1);
    const input = jobInput({ reason: "flag-build" });
    const resourceVision = visionForJob(input.flag, input.movementLeashRadiusM);
    const commitGate = createDeferred<void>();
    const commitPrepared = service.commitResourceVision.getMockImplementation();
    service.commitResourceVision.mockImplementationOnce(async (plan) => {
      await commitGate.promise;
      if (!commitPrepared) throw new Error("missing fake spawn-plan commit");
      return commitPrepared(plan);
    });

    const adoption = queue.completePreparedPlan({
      ...input,
      buildId: "build-1",
      sessionToken: 7,
      prepared: preparedBuildPlan(resourceVision, "build-1", 7)
    });
    await waitFor(() => service.commitResourceVision.mock.calls.length === 1);
    expect((await store.metrics()).processing).toBe(1);
    expect((await store.metrics()).completed).toBe(0);
    expect(service.prepareResourceVision).not.toHaveBeenCalled();

    commitGate.resolve();
    await expect(adoption).resolves.toMatchObject({ adopted: true });
    expect((await store.metrics()).completed).toBe(1);

    await expect(queue.completePreparedPlan({
      ...input,
      buildId: "build-1",
      sessionToken: 7,
      prepared: preparedBuildPlan(resourceVision, "build-1", 7)
    })).resolves.toMatchObject({ adopted: true, queued: false });
    expect(service.commitResourceVision).toHaveBeenCalledOnce();
    expect(store.submissionCount).toBe(1);
  });

  it("rejects stale prepared-build metadata without publishing gameplay state", async () => {
    const service = fakeCollectibles();
    const store = new MemoryResourceVisionJobStore();
    const queue = createQueue(service.collectibles, store, 1);
    const input = jobInput({ reason: "flag-build" });
    const resourceVision = visionForJob(input.flag, input.movementLeashRadiusM);

    const result = await queue.completePreparedPlan({
      ...input,
      buildId: "current-build",
      sessionToken: 2,
      prepared: preparedBuildPlan(resourceVision, "stale-build", 1)
    });

    expect(result.adopted).toBe(false);
    expect(store.submissionCount).toBe(0);
    expect(service.markResourceVisionPending).not.toHaveBeenCalled();
    expect(service.commitResourceVision).not.toHaveBeenCalled();
  });
});

function createQueue(
  collectibles: CollectibleService,
  store: MemoryResourceVisionJobStore = new MemoryResourceVisionJobStore(),
  concurrency = 2,
  logger = loggerStub()
) {
  return new ResourceVisionJobQueue(
    collectibles,
    logger,
    store,
    loadConfig({ NODE_ENV: "test" }),
    concurrency
  );
}

type MemoryJob = {
  contract: ResourceVisionJobContract;
  status: ResourceVisionJobStatus;
  ownerId: string | null;
  ownerGeneration: number;
  attemptCount: number;
};

class MemoryResourceVisionJobStore implements ResourceVisionJobStore {
  private readonly jobs = new Map<string, MemoryJob>();
  readonly completedFlagIds: Set<string>;
  submissionCount = 0;

  constructor(completedFlagIds: string[] = []) {
    this.completedFlagIds = new Set(completedFlagIds);
  }

  async status(jobKey: string): Promise<ResourceVisionJobStatus | null> {
    if ([...this.completedFlagIds].some((flagId) => jobKey.startsWith(`${flagId}:`))) {
      return "completed";
    }
    return this.jobs.get(jobKey)?.status ?? null;
  }

  async submit(contract: ResourceVisionJobContract) {
    const existing = this.jobs.get(contract.jobKey);
    if (existing) return { admitted: false, status: existing.status };
    this.jobs.set(contract.jobKey, {
      contract,
      status: "pending",
      ownerId: null,
      ownerGeneration: 0,
      attemptCount: 0
    });
    this.submissionCount += 1;
    return { admitted: true, status: "pending" as const };
  }

  async claim(ownerId: string): Promise<ClaimedResourceVisionJob | null> {
    const row = [...this.jobs.values()]
      .filter((job) => job.status === "pending" || (job.status === "failed" && job.attemptCount < 8))
      .sort((left, right) =>
        left.contract.priority - right.contract.priority ||
        left.contract.jobKey.localeCompare(right.contract.jobKey)
      )[0];
    if (!row) return null;
    row.status = "processing";
    row.ownerId = ownerId;
    row.ownerGeneration += 1;
    row.attemptCount += 1;
    return {
      ...row.contract,
      ownerId,
      ownerGeneration: row.ownerGeneration,
      attemptCount: row.attemptCount
    };
  }

  async claimByKey(
    jobKey: string,
    ownerId: string
  ): Promise<ClaimedResourceVisionJob | null> {
    const row = this.jobs.get(jobKey);
    if (
      !row ||
      (row.status !== "pending" &&
        !(row.status === "failed" && row.attemptCount < 8))
    ) return null;
    row.status = "processing";
    row.ownerId = ownerId;
    row.ownerGeneration += 1;
    row.attemptCount += 1;
    return {
      ...row.contract,
      ownerId,
      ownerGeneration: row.ownerGeneration,
      attemptCount: row.attemptCount
    };
  }

  async heartbeat(job: ClaimedResourceVisionJob): Promise<boolean> {
    return this.owns(job);
  }

  async isOwned(job: ClaimedResourceVisionJob): Promise<boolean> {
    return this.owns(job);
  }

  async complete(job: ClaimedResourceVisionJob): Promise<boolean> {
    const row = this.jobs.get(job.jobKey);
    if (!row || !this.owns(job)) return false;
    row.status = "completed";
    row.ownerId = null;
    return true;
  }

  async fail(job: ClaimedResourceVisionJob, _error: unknown, maxAttempts: number) {
    const row = this.jobs.get(job.jobKey);
    if (!row || !this.owns(job)) return { accepted: false, terminal: false };
    row.status = "failed";
    row.ownerId = null;
    return { accepted: true, terminal: row.attemptCount >= maxAttempts };
  }

  async recoverExpired(): Promise<number> {
    return 0;
  }

  async metrics(): Promise<DurableResourceVisionJobMetrics> {
    const rows = [...this.jobs.values()];
    return {
      pending: rows.filter((row) => row.status === "pending").length,
      processing: rows.filter((row) => row.status === "processing").length,
      retrying: rows.filter((row) => row.status === "failed" && row.attemptCount < 8).length,
      terminalFailed: rows.filter((row) => row.status === "failed" && row.attemptCount >= 8).length,
      completed: rows.filter((row) => row.status === "completed").length,
      oldestPendingAgeMs: 0,
      expiredLeases: 0
    };
  }

  replaceActiveOwner(): void {
    const row = [...this.jobs.values()].find((job) => job.status === "processing");
    if (!row) throw new Error("no active job to replace");
    row.ownerId = "replacement-worker";
    row.ownerGeneration += 1;
  }

  private owns(job: ClaimedResourceVisionJob): boolean {
    const row = this.jobs.get(job.jobKey);
    return row?.status === "processing" &&
      row.ownerId === job.ownerId &&
      row.ownerGeneration === job.ownerGeneration;
  }
}

function jobInput(overrides: Partial<Parameters<ResourceVisionJobQueue["ensureQueued"]>[0]> = {}) {
  return {
    flag: FLAG,
    regionCode: "NM",
    movementLeashRadiusM: DEFAULT_MOVE_LEASH_RADIUS_M,
    reason: "flag-created" as const,
    ...overrides
  };
}

function fakeCollectibles(options: {
  initialStatus?: ResourceVisionStatus | null;
  prepare?: (resourceVision: ResourceVision) => Promise<void>;
} = {}) {
  let currentStatus = options.initialStatus ?? null;
  const statuses = new Map<string, ResourceVisionStatus>();
  if (currentStatus) statuses.set(currentStatus.flagId, currentStatus);
  const nodes: CollectibleNode[] = [
    node("node-1"),
    node("node-2")
  ];
  const waterHighlights: WaterSourceHighlight[] = [waterHighlight("water-1")];
  const setStatus = (
    resourceVision: ResourceVision,
    status: ResourceVisionStatus["status"],
    nodeCount = 0,
    waterHighlightCount = 0,
    lastError: string | null = null
  ): ResourceVisionStatus => {
    currentStatus = {
      flagId: resourceVision.flagId,
      layoutVersion: "resource-layout-v2",
      status,
      radiusM: resourceVision.radiusM,
      nodeCount,
      waterHighlightCount,
      requestedAt: "2026-07-09T00:00:00.000Z",
      generatedAt: status === "ready" ? "2026-07-09T00:00:01.000Z" : null,
      lastError,
      updatedAt: "2026-07-09T00:00:01.000Z"
    };
    statuses.set(resourceVision.flagId, currentStatus);
    return currentStatus!;
  };

  const service = {
    resourceVisionStatus: vi.fn(async (flagId: string) => statuses.get(flagId) ?? null),
    markResourceVisionPending: vi.fn(async (resourceVision: ResourceVision) =>
      setStatus(resourceVision, "pending")
    ),
    markResourceVisionGenerating: vi.fn(async (resourceVision: ResourceVision) =>
      setStatus(resourceVision, "generating")
    ),
    markResourceVisionReady: vi.fn(
      async (
        resourceVision: ResourceVision,
        nodeCount: number,
        waterHighlightCount: number
      ) => setStatus(resourceVision, "ready", nodeCount, waterHighlightCount)
    ),
    markResourceVisionFailed: vi.fn(async (resourceVision: ResourceVision, error: unknown) =>
      setStatus(
        resourceVision,
        "failed",
        0,
        0,
        error instanceof Error ? error.message : String(error)
      )
    ),
    prepareResourceVision: vi.fn(async ({ resourceVision }: { resourceVision: ResourceVision }) => {
      await options.prepare?.(resourceVision);
      return emptyPlan(resourceVision);
    }),
    commitResourceVision: vi.fn(async (plan: PreparedCollectibleVision) =>
      setStatus(plan.resourceVision, "ready", nodes.length, waterHighlights.length)
    ),
    listAvailableInVision: vi.fn(async () => nodes),
    waterHighlightsForVision: vi.fn(async () => waterHighlights)
  };

  return {
    collectibles: service as unknown as CollectibleService,
    currentStatus: () => currentStatus,
    ...service
  };
}

function flagSnapshot(id: string): FlagSnapshot {
  return {
    id,
    controlType: "personal",
    ownerId: "player-1",
    name: "Test Flag",
    lat: 35.0844,
    lon: -106.6504,
    packageId: "nm-core",
    elevationM: 1500,
    terrainClass: "urban",
    biome: "desert",
    ecoregion: "Chihuahuan Desert",
    claimRadiusM: DEFAULT_FLAG_CLAIM_RADIUS_M,
    resourceVisionRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
    cityId: null,
    createdAt: "2026-07-09T00:00:00.000Z"
  };
}

function statusFor(
  flagId: string,
  status: ResourceVisionStatus["status"],
  radiusM = DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
): ResourceVisionStatus {
  return {
    flagId,
    layoutVersion: "resource-layout-v2",
    status,
    radiusM,
    nodeCount: status === "ready" ? 8 : 0,
    waterHighlightCount: status === "ready" ? 1 : 0,
    requestedAt: "2026-07-09T00:00:00.000Z",
    generatedAt: status === "ready" ? "2026-07-09T00:00:01.000Z" : null,
    lastError: status === "failed" ? "failed" : null,
    updatedAt: "2026-07-09T00:00:01.000Z"
  };
}

function emptyPlan(resourceVision: ResourceVision): PreparedCollectibleVision {
  return {
    resourceVision,
    layoutVersion: "resource-layout-v2",
    waterHighlights: [],
    preparedAt: Date.now(),
    commitTimings: null,
    timings: {
      waterHighlightMs: 0,
      totalMs: 0
    }
  };
}

function preparedBuildPlan(
  resourceVision: ResourceVision,
  buildId: string,
  sessionToken: number
): PreparedResourceVisionPlan {
  const config = loadConfig({ NODE_ENV: "test" });
  return {
    buildId,
    sessionToken,
    flagId: resourceVision.flagId,
    center: { ...resourceVision.center },
    movementLeashRadiusM: resourceVision.movementLeashRadiusM,
    radiusM: resourceVision.radiusM,
    layoutVersion: "resource-layout-v2",
    worldReleaseId: config.WORLD_REQUIRED_RELEASE_ID,
    profileSetFingerprint: config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
    buildContractFingerprint: config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
    boundaryReleaseId: config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID,
    plan: emptyPlan(resourceVision)
  };
}

function node(id: string): CollectibleNode {
  return {
    id,
    type: "wood",
    lat: 35.0844,
    lon: -106.6504,
    quantity: 1,
    state: "available",
    createdAt: "2026-07-09T00:00:00.000Z",
    harvestedAt: null,
    sourceCellId: "cell-1",
    waterKind: null
  };
}

function waterHighlight(id: string): WaterSourceHighlight {
  return {
    id,
    name: id,
    sourceDataset: "test",
    waterSourceType: "medium_river",
    waterKind: "freshwater",
    collectible: true,
    lat: 35.0844,
    lon: -106.6504
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await nextMicrotask();
  }
  throw new Error("condition was not met");
}

function loggerStub() {
  return {
    info: vi.fn(),
    warn: vi.fn()
  };
}

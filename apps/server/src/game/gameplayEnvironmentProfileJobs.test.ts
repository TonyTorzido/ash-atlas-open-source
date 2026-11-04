import type { LatLon } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import {
  GameplayEnvironmentProfileMaterializer,
  WorldEnvironmentProfileJobService
} from "./gameplayEnvironmentProfileJobs.js";
import {
  worldEnvironmentProfileRequestForPoint,
  type WorldEnvironmentCellProfile,
  type WorldEnvironmentProfileJobStatus,
  type WorldEnvironmentProfileRequest
} from "./gameplayEnvironmentProfiles.js";
import type {
  ClaimedWorldEnvironmentProfileJob,
  WorldEnvironmentProfileJobMetrics,
  WorldEnvironmentProfileJobStore
} from "./gameplayEnvironmentProfileStore.js";

const IDENTITY = {
  releaseId: "world-packages-v1",
  profileSetFingerprint: "a".repeat(64),
  buildContractFingerprint: "b".repeat(64),
  boundaryReleaseId: "global-boundaries-v1"
};

describe("gameplay environment profile materialization jobs", () => {
  it("builds one center profile and 112 reusable slots in one compact World batch", async () => {
    const job = claimedJob();
    const lookupGameplayEnvironments = vi.fn(async (points: readonly LatLon[]) =>
      points.map((point) => compactResult(point, job))
    );
    const materializer = new GameplayEnvironmentProfileMaterializer({
      lookupGameplayEnvironments
    });

    const profile = await materializer.materialize(job);

    expect(lookupGameplayEnvironments).toHaveBeenCalledOnce();
    expect(lookupGameplayEnvironments.mock.calls[0]?.[0]).toHaveLength(113);
    expect(profile).toMatchObject({
      cellId: job.cellId,
      worldIdentityKey: job.worldIdentityKey,
      sourceRuntimeSha: "c".repeat(40),
      spawnProfileKey: "temperate_forest",
      spawnRulesVersion: "environment-spawn-rules-v2-riverbank-lakeshore"
    });
    expect(profile.candidateSlots).toHaveLength(112);
    expect(profile.candidateSlots.every((slot) => slot.eligibleLand)).toBe(true);
  });

  it("rejects a compact batch carrying a different immutable World identity", async () => {
    const job = claimedJob();
    const materializer = new GameplayEnvironmentProfileMaterializer({
      lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[]) =>
        points.map((point) => ({
          ...compactResult(point, job),
          release: {
            ...compactResult(point, job).release!,
            releaseId: "world-packages-v2"
          }
        }))
      )
    });

    await expect(materializer.materialize(job))
      .rejects.toThrow("stale World identity");
  });

  it("completes a leased profile transaction once and publishes the ready hook", async () => {
    const store = new MemoryJobStore(request());
    const materialized = await new GameplayEnvironmentProfileMaterializer({
      lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[]) =>
        points.map((point) => compactResult(point, claimedJob()))
      )
    }).materialize(claimedJob());
    const lifecycle = {
      acceptMaterializedProfile: vi.fn(async () => undefined),
      recordMaterializationFailure: vi.fn()
    };
    const service = new WorldEnvironmentProfileJobService(
      store,
      { materialize: vi.fn(async () => materialized) },
      logger(),
      lifecycle,
      { concurrency: 2 }
    );

    service.wake();
    await waitFor(() => store.status === "ready" && service.metricsSnapshot().active === 0);

    expect(store.claimCount).toBe(1);
    expect(store.completeCount).toBe(1);
    expect(lifecycle.acceptMaterializedProfile).toHaveBeenCalledOnce();
    expect(service.metricsSnapshot()).toMatchObject({
      claimed: 1,
      completed: 1,
      failed: 0
    });
  });

  it("records retryable failures without publishing a partial profile", async () => {
    const store = new MemoryJobStore(request());
    const lifecycle = {
      acceptMaterializedProfile: vi.fn(async () => undefined),
      recordMaterializationFailure: vi.fn()
    };
    const service = new WorldEnvironmentProfileJobService(
      store,
      { materialize: vi.fn(async () => {
        throw new Error("compact World batch unavailable");
      }) },
      logger(),
      lifecycle,
      { concurrency: 1 }
    );

    service.wake();
    await waitFor(() => store.status === "retryable-failure" && service.metricsSnapshot().active === 0);

    expect(store.failCount).toBe(1);
    expect(store.completeCount).toBe(0);
    expect(lifecycle.acceptMaterializedProfile).not.toHaveBeenCalled();
    expect(lifecycle.recordMaterializationFailure).toHaveBeenCalledOnce();
  });

  it("aborts leased World work and releases it for retry when the worker stops", async () => {
    const store = new MemoryJobStore(request());
    let materializationSignal: AbortSignal | undefined;
    const materialize = vi.fn(async (
      _job: ClaimedWorldEnvironmentProfileJob,
      signal?: AbortSignal
    ): Promise<WorldEnvironmentCellProfile> => {
      materializationSignal = signal;
      return await new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const service = new WorldEnvironmentProfileJobService(
      store,
      { materialize },
      logger(),
      undefined,
      { concurrency: 1 }
    );

    service.wake();
    await waitFor(() => store.status === "leased" && materializationSignal !== undefined);
    await service.stop();

    expect(materializationSignal?.aborted).toBe(true);
    expect(store.status).toBe("retryable-failure");
    expect(store.failCount).toBe(1);
    expect(service.metricsSnapshot().active).toBe(0);
  });
});

class MemoryJobStore implements WorldEnvironmentProfileJobStore {
  status: WorldEnvironmentProfileJobStatus = "pending";
  claimCount = 0;
  completeCount = 0;
  failCount = 0;

  constructor(private readonly requestValue: WorldEnvironmentProfileRequest) {}

  async findProfile(): Promise<WorldEnvironmentCellProfile | null> {
    return null;
  }

  async submitJob() {
    return { created: false, status: this.status };
  }

  async claimJob(ownerId: string): Promise<ClaimedWorldEnvironmentProfileJob | null> {
    if (this.status !== "pending") return null;
    this.status = "leased";
    this.claimCount += 1;
    return {
      ...this.requestValue,
      jobKey: "d".repeat(64),
      ownerId,
      ownerGeneration: 1,
      attemptCount: 1
    };
  }

  async heartbeatJob(): Promise<boolean> {
    return this.status === "leased";
  }

  async completeMaterialization(): Promise<boolean> {
    if (this.status !== "leased") return false;
    this.status = "ready";
    this.completeCount += 1;
    return true;
  }

  async failJob() {
    if (this.status !== "leased") return { accepted: false, terminal: false };
    this.status = "retryable-failure";
    this.failCount += 1;
    return { accepted: true, terminal: false };
  }

  async recoverExpiredJobs(): Promise<number> {
    return 0;
  }

  async jobMetrics(): Promise<WorldEnvironmentProfileJobMetrics> {
    return {
      pending: this.status === "pending" ? 1 : 0,
      leased: this.status === "leased" ? 1 : 0,
      retrying: this.status === "retryable-failure" ? 1 : 0,
      terminalFailed: this.status === "terminal-failure" ? 1 : 0,
      expiredLeases: 0,
      oldestPendingAgeMs: 0
    };
  }
}

function request(): WorldEnvironmentProfileRequest {
  return worldEnvironmentProfileRequestForPoint({
    position: { lat: 35.0844, lon: -106.6504 },
    regionCode: "GLOBAL",
    worldIdentity: IDENTITY,
    sourceRuntimeSha: "1".repeat(40)
  });
}

function claimedJob(): ClaimedWorldEnvironmentProfileJob {
  return {
    ...request(),
    jobKey: "d".repeat(64),
    ownerId: "worker-1",
    ownerGeneration: 1,
    attemptCount: 1
  };
}

function compactResult(
  point: LatLon,
  job: ClaimedWorldEnvironmentProfileJob
): WorldGameplayEnvironmentResult {
  return {
    ok: true,
    contractVersion: "gameplay-environment-v1",
    runtime: { sha: "c".repeat(40), branch: "main" },
    packageId: "package-1",
    latitude: point.lat,
    longitude: point.lon,
    countryId: "country-1",
    countryName: "Test Country",
    countryCode: "TC",
    regionId: "region-1",
    regionName: "Test Region",
    regionCode: "TR",
    settlementId: null,
    settlementName: null,
    elevationM: 125,
    elevationBand: "lowland",
    terrainClass: "forest",
    landCoverClass: "forest",
    biome: "Temperate Forest",
    biomeName: "Temperate Forest",
    biomeId: "temperate-forest",
    ecoregion: "Test Ecoregion",
    ecoregionName: "Test Ecoregion",
    ecoregionId: "ecoregion-1",
    isLand: true,
    isSaltwater: false,
    isCoastalLand: false,
    isRiverbank: false,
    isLakeshore: false,
    isCoastal: false,
    insideMajorLake: false,
    majorLakeId: null,
    majorLakeName: null,
    majorLakeDistanceM: null,
    namedRiverId: null,
    namedRiverName: null,
    riverClass: null,
    riverDistanceM: null,
    supportingRiverId: null,
    supportingRiverFlowOrder: null,
    supportingRiverDischargeCms: null,
    supportingRiverDrainageAreaSqKm: null,
    supportingRiverDistanceM: null,
    flagPlacementWater: {
      blocked: false,
      kind: "land",
      sourceId: null,
      sourceName: null,
      distanceM: null,
      corridorRadiusM: null,
      reason: "authoritative land",
      resolution: "exact",
      releaseId: job.worldIdentity.releaseId
    },
    release: { ...job.worldIdentity, packageCount: 1 },
    raw: {}
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

import { RESOURCE_LAYOUT_VERSION, type FlagSnapshot } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { resourceVisionJobIdentity } from "./resourceVisionJobContracts.js";
import {
  ResourceVisionJobQueue,
  visionForJob,
  type ResourceVisionJobInput
} from "./resourceVisionJobs.js";

const flag: FlagSnapshot = {
  controlType: "personal",
  id: "00000000-0000-4000-8000-000000000101",
  ownerId: "00000000-0000-4000-8000-000000000102",
  name: "Race-safe",
  lat: 39,
  lon: -105,
  packageId: null,
  elevationM: null,
  terrainClass: null,
  biome: null,
  ecoregion: null,
  claimRadiusM: 500,
  resourceVisionRadiusM: 650,
  cityId: null,
  createdAt: new Date(0).toISOString()
};

const config = {
  WORLD_REQUIRED_RELEASE_ID: "release",
  WORLD_REQUIRED_PROFILE_SET_FINGERPRINT: "profiles",
  WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT: "contract",
  WORLD_REQUIRED_BOUNDARY_RELEASE_ID: "boundary",
  RESOURCE_JOB_COMPLETION_SUBSCRIBERS_MAX: 10,
  RESOURCE_JOB_SUBSCRIBERS_PER_JOB_MAX: 5,
  RESOURCE_JOB_LEASE_MS: 30_000,
  RESOURCE_JOB_RETRY_POLL_MS: 1_000,
  RESOURCE_JOB_MAX_ATTEMPTS: 3
};

const input: ResourceVisionJobInput = {
  flag,
  regionCode: "GLOBAL",
  movementLeashRadiusM: 600,
  reason: "flag-build"
};

describe("ResourceVisionJobQueue completion subscription", () => {
  it("replays an already completed durable job asynchronously exactly once", async () => {
    const harness = createHarness(["completed", "completed"]);
    const listener = vi.fn();

    await harness.queue.subscribeOrReplayCompletion(
      harness.jobKey,
      input,
      listener
    );
    await harness.queue.subscribeOrReplayCompletion(
      harness.jobKey,
      input,
      listener
    );
    expect(listener).toHaveBeenCalledOnce();
  });

  it("closes completion between the initial read and listener registration", async () => {
    const harness = createHarness(["pending", "completed"]);
    const listener = vi.fn();

    await harness.queue.subscribeOrReplayCompletion(
      harness.jobKey,
      input,
      listener
    );
    await Promise.resolve();

    expect(listener).toHaveBeenCalledOnce();
    expect(harness.queue.metricsSnapshot().completionSubscribers).toBe(0);
  });

  it("deduplicates the same listener identity while a job remains pending", async () => {
    const harness = createHarness(Array(8).fill("pending"));
    const listener = vi.fn();

    await harness.queue.subscribeOrReplayCompletion(
      harness.jobKey,
      input,
      listener
    );
    await harness.queue.subscribeOrReplayCompletion(
      harness.jobKey,
      input,
      listener
    );

    expect(harness.queue.metricsSnapshot().completionSubscribers).toBe(1);
    await harness.queue.stop();
    expect(harness.queue.metricsSnapshot().completionSubscribers).toBe(0);
  });
});

function createHarness(statuses: string[]) {
  const resourceVision = visionForJob(flag, input.movementLeashRadiusM);
  const readyStatus = {
    flagId: flag.id,
    status: "ready" as const,
    radiusM: resourceVision.radiusM,
    layoutVersion: RESOURCE_LAYOUT_VERSION,
    nodeCount: 1,
    waterHighlightCount: 0,
    attemptCount: 1,
    lastError: null,
    updatedAt: new Date(0).toISOString()
  };
  const store = {
    status: vi.fn(async () => statuses.shift() ?? "pending"),
    submit: vi.fn(),
    claim: vi.fn(async () => null),
    claimByKey: vi.fn(async () => null),
    heartbeat: vi.fn(),
    isOwned: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    recoverExpired: vi.fn(),
    metrics: vi.fn(async () => ({
      pending: 1,
      processing: 0,
      retrying: 0,
      terminalFailed: 0,
      completed: 0,
      oldestPendingAgeMs: 0,
      expiredLeases: 0
    }))
  };
  const collectibles = {
    resourceVisionStatus: vi.fn(async () => readyStatus)
  };
  const queue = new ResourceVisionJobQueue(
    collectibles as never,
    { info: vi.fn(), warn: vi.fn() },
    store as never,
    config,
    1
  );
  const contract = resourceVisionJobIdentity(
    input,
    resourceVision.radiusM,
    config,
    RESOURCE_LAYOUT_VERSION
  );
  return { queue, jobKey: contract.jobKey };
}

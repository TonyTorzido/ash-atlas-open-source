import { randomUUID } from "node:crypto";

import {
  RESOURCE_LAYOUT_VERSION,
  type FlagSnapshot,
  type ResourceVision,
  type ResourceVisionStatus
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import {
  collectiblePlayerFromSnapshot,
  resourceVisionForFlag,
  type CollectibleService,
  type PreparedCollectibleVision
} from "./collectibles.js";
import {
  resourceVisionJobIdentity,
  type ClaimedResourceVisionJob,
  type DurableResourceVisionJobMetrics,
  type ResourceVisionJobContract,
  type ResourceVisionJobReason,
  type ResourceVisionJobStore
} from "./resourceVisionJobContracts.js";

export type { ResourceVisionJobReason } from "./resourceVisionJobContracts.js";

export type ResourceVisionJobCompletion = {
  flag: FlagSnapshot;
  resourceVision: ResourceVision;
  status: ResourceVisionStatus;
};

export type PreparedResourceVisionPlan = Readonly<{
  buildId: string;
  sessionToken: number;
  flagId: string;
  center: { lat: number; lon: number };
  movementLeashRadiusM: number;
  radiusM: number;
  layoutVersion: typeof RESOURCE_LAYOUT_VERSION;
  worldReleaseId: string;
  profileSetFingerprint: string;
  buildContractFingerprint: string;
  boundaryReleaseId: string;
  plan: PreparedCollectibleVision;
}>;

export type ResourceVisionJobInput = {
  flag: FlagSnapshot;
  regionCode: string;
  movementLeashRadiusM: number;
  reason: ResourceVisionJobReason;
  signal?: AbortSignal;
  onComplete?(completion: ResourceVisionJobCompletion): void | Promise<void>;
};

type CompletionListener = Readonly<{
  listener: NonNullable<ResourceVisionJobInput["onComplete"]>;
  fired: { value: boolean };
}>;

type ResourceJobConfig = Pick<
  AppConfig,
  | "WORLD_REQUIRED_RELEASE_ID"
  | "WORLD_REQUIRED_PROFILE_SET_FINGERPRINT"
  | "WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT"
  | "WORLD_REQUIRED_BOUNDARY_RELEASE_ID"
  | "RESOURCE_JOB_COMPLETION_SUBSCRIBERS_MAX"
  | "RESOURCE_JOB_SUBSCRIBERS_PER_JOB_MAX"
  | "RESOURCE_JOB_LEASE_MS"
  | "RESOURCE_JOB_RETRY_POLL_MS"
  | "RESOURCE_JOB_MAX_ATTEMPTS"
>;

export class ResourceVisionJobQueue {
  private readonly completionListeners = new Map<
    string,
    CompletionListener[]
  >();
  private readonly activeJobKeys = new Set<string>();
  private readonly deliveredJobKeysByListener = new WeakMap<
    NonNullable<ResourceVisionJobInput["onComplete"]>,
    Set<string>
  >();
  private readonly ownerId = `resource-vision:${process.pid}:${randomUUID()}`;
  private supervisor: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private activeCount = 0;
  private completionSubscriberCount = 0;
  private lastError: string | null = null;
  private lastDurableMetrics: DurableResourceVisionJobMetrics = emptyDurableMetrics();

  constructor(
    private readonly collectibles: CollectibleService,
    private readonly logger: Pick<AppLogger, "info" | "warn">,
    private readonly store: ResourceVisionJobStore,
    private readonly config: ResourceJobConfig,
    private readonly concurrency = 2
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      throw new Error("resource preparation concurrency must be an integer from 1 through 8");
    }
  }

  async start(): Promise<void> {
    if (this.supervisor) throw new Error("resource vision job supervisor is already running");
    this.stopping = false;
    const recovered = await this.store.recoverExpired();
    await this.refreshDurableMetrics();
    if (recovered > 0) {
      this.logger.warn({ recovered }, "reclaimed expired resource vision job leases");
    }
    this.supervisor = setInterval(() => this.pump(), this.config.RESOURCE_JOB_RETRY_POLL_MS);
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.supervisor) {
      clearInterval(this.supervisor);
      this.supervisor = null;
    }
    while (this.activeCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const jobKey of this.completionListeners.keys()) {
      this.deleteCompletionListeners(jobKey);
    }
  }

  async ensureQueued(input: ResourceVisionJobInput): Promise<{
    queued: boolean;
    status: ResourceVisionStatus | null;
    resourceVision: ResourceVision;
  }> {
    const resourceVision = visionForJob(input.flag, input.movementLeashRadiusM);
    const contract = this.contractFor(input, resourceVision);
    const [status, durableStatus] = await Promise.all([
      this.collectibles.resourceVisionStatus(input.flag.id),
      this.store.status(contract.jobKey)
    ]);
    if (
      durableStatus === "completed" &&
      status?.status === "ready" &&
      status.radiusM === resourceVision.radiusM &&
      status.layoutVersion === RESOURCE_LAYOUT_VERSION
    ) {
      if (input.onComplete) {
        queueMicrotask(() => {
          void input.onComplete?.({ flag: input.flag, resourceVision, status });
        });
      }
      return { queued: false, status, resourceVision };
    }

    if (input.onComplete) this.addCompletionListener(contract.jobKey, input.onComplete);
    let admission;
    try {
      admission = await this.store.submit(contract);
    } catch (error) {
      if (input.onComplete) this.removeCompletionListener(contract.jobKey, input.onComplete);
      throw error;
    }
    const pendingStatus = admission.admitted
      ? await this.collectibles.markResourceVisionPending(resourceVision)
      : status;
    this.pump();
    void this.refreshDurableMetrics();
    return { queued: admission.admitted, status: pendingStatus, resourceVision };
  }

  async completePreparedPlan(input: ResourceVisionJobInput & Readonly<{
    buildId: string;
    sessionToken: number;
    prepared: PreparedResourceVisionPlan;
  }>): Promise<Readonly<{
    adopted: boolean;
    queued: boolean;
    status: ResourceVisionStatus | null;
    resourceVision: ResourceVision;
  }>> {
    const resourceVision = visionForJob(input.flag, input.movementLeashRadiusM);
    const contract = this.contractFor(input, resourceVision);
    if (!matchesPreparedResourcePlan(input, resourceVision, contract)) {
      return {
        adopted: false,
        queued: false,
        status: await this.collectibles.resourceVisionStatus(input.flag.id),
        resourceVision
      };
    }
    const [status, durableStatus] = await Promise.all([
      this.collectibles.resourceVisionStatus(input.flag.id),
      this.store.status(contract.jobKey)
    ]);
    if (
      durableStatus === "completed" &&
      status?.status === "ready" &&
      status.radiusM === resourceVision.radiusM &&
      status.layoutVersion === RESOURCE_LAYOUT_VERSION
    ) {
      if (input.onComplete) {
        queueMicrotask(() => {
          void input.onComplete?.({ flag: input.flag, resourceVision, status });
        });
      }
      return { adopted: true, queued: false, status, resourceVision };
    }

    if (input.onComplete) this.addCompletionListener(contract.jobKey, input.onComplete);
    let admission;
    try {
      admission = await this.store.submit(contract);
    } catch (error) {
      if (input.onComplete) this.removeCompletionListener(contract.jobKey, input.onComplete);
      throw error;
    }
    const pendingStatus = admission.admitted
      ? await this.collectibles.markResourceVisionPending(resourceVision)
      : status;
    const claimed = await this.store.claimByKey(
      contract.jobKey,
      this.ownerId,
      this.config.RESOURCE_JOB_LEASE_MS
    );
    if (!claimed) {
      this.pump();
      void this.refreshDurableMetrics();
      return {
        adopted: false,
        queued: admission.admitted,
        status: pendingStatus,
        resourceVision
      };
    }

    this.activeJobKeys.add(claimed.jobKey);
    this.activeCount += 1;
    try {
      const adopted = await this.commitPreparedClaim(claimed, input.prepared.plan);
      return {
        adopted,
        queued: admission.admitted,
        status: adopted
          ? await this.collectibles.resourceVisionStatus(input.flag.id)
          : pendingStatus,
        resourceVision
      };
    } finally {
      this.activeCount -= 1;
      this.activeJobKeys.delete(claimed.jobKey);
      this.pump();
      void this.refreshDurableMetrics();
    }
  }

  async subscribeOrReplayCompletion(
    jobKey: string,
    expected: ResourceVisionJobInput,
    onComplete: NonNullable<ResourceVisionJobInput["onComplete"]>
  ): Promise<void> {
    const resourceVision = visionForJob(
      expected.flag,
      expected.movementLeashRadiusM
    );
    const contract = this.contractFor(expected, resourceVision);
    if (contract.jobKey !== jobKey) {
      throw new Error("resource vision completion contract does not match job key");
    }
    const readyCompletion = async (): Promise<
      ResourceVisionJobCompletion | null
    > => {
      const [durableStatus, status] = await Promise.all([
        this.store.status(jobKey),
        this.collectibles.resourceVisionStatus(expected.flag.id)
      ]);
      return durableStatus === "completed"
        && status?.status === "ready"
        && status.radiusM === resourceVision.radiusM
        && status.layoutVersion === RESOURCE_LAYOUT_VERSION
        ? { flag: expected.flag, resourceVision, status }
        : null;
    };
    const existingCompletion = await readyCompletion();
    if (existingCompletion) {
      this.fireCompletionListener(
        jobKey,
        { listener: onComplete, fired: { value: false } },
        existingCompletion
      );
      return;
    }
    const subscription = this.addCompletionListener(jobKey, onComplete);
    const replay = await readyCompletion();
    if (replay) {
      this.removeCompletionSubscription(jobKey, subscription);
      this.fireCompletionListener(jobKey, subscription, replay);
      return;
    }
    if (await this.store.status(jobKey) === "failed") {
      this.removeCompletionSubscription(jobKey, subscription);
      return;
    }
    this.pump();
    void this.refreshDurableMetrics();
  }

  async adoptPreparedExisting(
    jobKey: string,
    input: ResourceVisionJobInput & Readonly<{
      buildId: string;
      sessionToken: number;
      prepared: PreparedResourceVisionPlan;
    }>
  ): Promise<boolean> {
    const resourceVision = visionForJob(input.flag, input.movementLeashRadiusM);
    const contract = this.contractFor(input, resourceVision);
    if (
      contract.jobKey !== jobKey ||
      !matchesPreparedResourcePlan(input, resourceVision, contract)
    ) {
      return false;
    }
    if (input.onComplete) {
      this.addCompletionListener(jobKey, input.onComplete);
    }
    const claimed = await this.store.claimByKey(
      jobKey,
      this.ownerId,
      this.config.RESOURCE_JOB_LEASE_MS
    );
    if (!claimed) {
      this.pump();
      void this.refreshDurableMetrics();
      return false;
    }
    this.activeJobKeys.add(jobKey);
    this.activeCount += 1;
    try {
      return await this.commitPreparedClaim(claimed, input.prepared.plan);
    } finally {
      this.activeCount -= 1;
      this.activeJobKeys.delete(jobKey);
      this.pump();
      void this.refreshDurableMetrics();
    }
  }

  pendingCount(): number {
    return this.lastDurableMetrics.pending + this.lastDurableMetrics.retrying + this.activeCount;
  }

  metricsSnapshot(): {
    pending: number;
    active: number;
    trackedJobs: number;
    completionSubscribers: number;
    supervisorRunning: boolean;
    lastError: string | null;
    durable: DurableResourceVisionJobMetrics;
  } {
    return {
      pending: this.lastDurableMetrics.pending + this.lastDurableMetrics.retrying,
      active: this.activeCount,
      trackedJobs: this.activeJobKeys.size,
      completionSubscribers: this.completionSubscriberCount,
      supervisorRunning: this.supervisor !== null,
      lastError: this.lastError,
      durable: { ...this.lastDurableMetrics }
    };
  }

  async refreshMetricsSnapshot(): Promise<ReturnType<ResourceVisionJobQueue["metricsSnapshot"]>> {
    await this.refreshDurableMetrics();
    return this.metricsSnapshot();
  }

  private pump(): void {
    if (this.stopping) return;
    while (this.activeCount < this.concurrency) {
      this.activeCount += 1;
      let claimed = false;
      void this.runNext()
        .then((didClaim) => {
          claimed = didClaim;
        })
        .catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn({ err: error }, "resource vision durable worker pass failed");
        })
        .finally(() => {
          this.activeCount -= 1;
          if (claimed && !this.stopping) queueMicrotask(() => this.pump());
        });
    }
  }

  private async runNext(): Promise<boolean> {
    const job = await this.store.claim(this.ownerId, this.config.RESOURCE_JOB_LEASE_MS);
    if (!job) return false;
    this.lastError = null;
    this.activeJobKeys.add(job.jobKey);
    try {
      await this.run(job);
    } finally {
      this.activeJobKeys.delete(job.jobKey);
      void this.refreshDurableMetrics();
    }
    return true;
  }

  private async run(job: ClaimedResourceVisionJob): Promise<void> {
    const resourceVision = visionForJob(job.payload.flag, job.payload.movementLeashRadiusM);
    this.logger.info(
      {
        jobKey: job.jobKey,
        flagId: job.flagId,
        reason: job.payload.reason,
        radiusM: resourceVision.radiusM,
        attemptCount: job.attemptCount,
        activeJobs: this.activeCount,
        ownerGeneration: job.ownerGeneration
      },
      "resource vision prewarm started"
    );
    const heartbeat = setInterval(() => {
      void this.store.heartbeat(job, this.config.RESOURCE_JOB_LEASE_MS)
        .then((owned) => {
          if (!owned) clearInterval(heartbeat);
        })
        .catch((error: unknown) => {
          this.logger.warn({ err: error, jobKey: job.jobKey }, "resource vision lease heartbeat failed");
        });
    }, Math.max(1_000, Math.floor(this.config.RESOURCE_JOB_LEASE_MS / 3)));
    try {
      await this.collectibles.markResourceVisionGenerating(resourceVision);
      const plan = await this.collectibles.prepareResourceVision({
        resourceVision
      });
      if (!(await this.store.isOwned(job))) throw new StaleResourceVisionJobError(job.jobKey);
      const status = await this.collectibles.commitResourceVision(plan);
      if (!(await this.store.complete(job))) throw new StaleResourceVisionJobError(job.jobKey);
      const nodes = await this.collectibles.listAvailableInVision(
        job.payload.regionCode,
        resourceVision
      );
      await this.notifyCompletion(job.jobKey, {
        flag: job.payload.flag,
        resourceVision,
        status
      });
      this.logger.info(
        {
          flagId: job.flagId,
          jobKey: job.jobKey,
          nodeCount: nodes.length,
          waterHighlightCount: plan.waterHighlights.length,
          stages: plan.timings,
          commitStages: plan.commitTimings
        },
        "resource vision prewarm ready"
      );
    } catch (error) {
      const failure = error instanceof StaleResourceVisionJobError
        ? { accepted: false, terminal: false }
        : await this.store.fail(job, error, this.config.RESOURCE_JOB_MAX_ATTEMPTS);
      if (failure.terminal) this.deleteCompletionListeners(job.jobKey);
      try {
        if (failure.accepted) await this.collectibles.markResourceVisionFailed(resourceVision, error);
      } catch (statusError) {
        this.logger.warn(
          { err: statusError, jobError: error, flagId: job.flagId },
          "failed to persist resource vision failure status"
        );
      }
      this.logger.warn(
        { err: error, flagId: job.flagId, jobKey: job.jobKey, terminal: failure.terminal },
        "resource vision prewarm failed"
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async commitPreparedClaim(
    job: ClaimedResourceVisionJob,
    plan: PreparedCollectibleVision
  ): Promise<boolean> {
    const resourceVision = visionForJob(job.payload.flag, job.payload.movementLeashRadiusM);
    const heartbeat = setInterval(() => {
      void this.store.heartbeat(job, this.config.RESOURCE_JOB_LEASE_MS)
        .then((owned) => {
          if (!owned) clearInterval(heartbeat);
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, jobKey: job.jobKey },
            "prepared Resource Vision lease heartbeat failed"
          );
        });
    }, Math.max(1_000, Math.floor(this.config.RESOURCE_JOB_LEASE_MS / 3)));
    try {
      await this.collectibles.markResourceVisionGenerating(resourceVision);
      if (!(await this.store.isOwned(job))) {
        throw new StaleResourceVisionJobError(job.jobKey);
      }
      const status = await this.collectibles.commitResourceVision(plan);
      if (!(await this.store.complete(job))) {
        throw new StaleResourceVisionJobError(job.jobKey);
      }
      await this.notifyCompletion(job.jobKey, {
        flag: job.payload.flag,
        resourceVision,
        status
      });
      this.logger.info(
        {
          flagId: job.flagId,
          jobKey: job.jobKey,
          buildPrepared: true,
          waterHighlightCount: plan.waterHighlights.length,
          stages: plan.timings,
          commitStages: plan.commitTimings
        },
        "prepared flag Resource Vision durably adopted"
      );
      return true;
    } catch (error) {
      const failure = error instanceof StaleResourceVisionJobError
        ? { accepted: false, terminal: false }
        : await this.store.fail(job, error, this.config.RESOURCE_JOB_MAX_ATTEMPTS);
      if (failure.terminal) this.deleteCompletionListeners(job.jobKey);
      if (failure.accepted) {
        try {
          await this.collectibles.markResourceVisionFailed(resourceVision, error);
        } catch (statusError) {
          this.logger.warn(
            { err: statusError, jobError: error, flagId: job.flagId },
            "failed to persist prepared Resource Vision failure status"
          );
        }
      }
      this.logger.warn(
        { err: error, flagId: job.flagId, jobKey: job.jobKey },
        "prepared flag Resource Vision adoption failed; durable fallback remains"
      );
      return false;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private addCompletionListener(
    jobKey: string,
    listener: (completion: ResourceVisionJobCompletion) => void | Promise<void>
  ): CompletionListener {
    const listeners = this.completionListeners.get(jobKey) ?? [];
    const duplicate = listeners.find((entry) => entry.listener === listener);
    if (duplicate) return duplicate;
    const subscription = { listener, fired: { value: false } };
    if (
      listeners.length >= this.config.RESOURCE_JOB_SUBSCRIBERS_PER_JOB_MAX ||
      this.completionSubscriberCount >= this.config.RESOURCE_JOB_COMPLETION_SUBSCRIBERS_MAX
    ) {
      this.logger.warn({ jobKey }, "resource vision completion subscriber capacity reached");
      return subscription;
    }
    listeners.push(subscription);
    this.completionSubscriberCount += 1;
    this.completionListeners.set(jobKey, listeners);
    return subscription;
  }

  private removeCompletionListener(
    jobKey: string,
    listener: (completion: ResourceVisionJobCompletion) => void | Promise<void>
  ): void {
    const listeners = this.completionListeners.get(jobKey) ?? [];
    const index = listeners.findIndex((entry) => entry.listener === listener);
    if (index < 0) return;
    listeners.splice(index, 1);
    this.completionSubscriberCount -= 1;
    if (listeners.length === 0) this.completionListeners.delete(jobKey);
  }

  private removeCompletionSubscription(
    jobKey: string,
    subscription: CompletionListener
  ): void {
    const listeners = this.completionListeners.get(jobKey) ?? [];
    const index = listeners.indexOf(subscription);
    if (index < 0) return;
    listeners.splice(index, 1);
    this.completionSubscriberCount -= 1;
    if (listeners.length === 0) this.completionListeners.delete(jobKey);
  }

  private async notifyCompletion(
    jobKey: string,
    completion: ResourceVisionJobCompletion
  ): Promise<void> {
    const listeners = this.completionListeners.get(jobKey) ?? [];
    this.deleteCompletionListeners(jobKey);
    for (const listener of listeners) {
      this.fireCompletionListener(jobKey, listener, completion);
    }
  }

  private fireCompletionListener(
    jobKey: string,
    subscription: CompletionListener,
    completion: ResourceVisionJobCompletion
  ): void {
    if (subscription.fired.value) return;
    const delivered =
      this.deliveredJobKeysByListener.get(subscription.listener) ?? new Set();
    if (delivered.has(jobKey)) return;
    if (delivered.size >= 64) {
      delivered.delete(delivered.values().next().value!);
    }
    delivered.add(jobKey);
    this.deliveredJobKeysByListener.set(subscription.listener, delivered);
    subscription.fired.value = true;
    queueMicrotask(() => {
      void Promise.resolve(subscription.listener(completion)).catch(
        (error: unknown) => {
          this.logger.warn(
            { err: error, flagId: completion.flag.id },
            "resource vision completion listener failed"
          );
        }
      );
    });
  }

  private deleteCompletionListeners(jobKey: string): void {
    const listeners = this.completionListeners.get(jobKey) ?? [];
    this.completionSubscriberCount -= listeners.length;
    this.completionListeners.delete(jobKey);
  }

  private contractFor(
    input: ResourceVisionJobInput,
    resourceVision: ResourceVision
  ): ResourceVisionJobContract {
    return resourceVisionJobIdentity(
      {
        flag: input.flag,
        regionCode: input.regionCode,
        movementLeashRadiusM: input.movementLeashRadiusM,
        reason: input.reason
      },
      resourceVision.radiusM,
      this.config,
      RESOURCE_LAYOUT_VERSION
    );
  }

  private async refreshDurableMetrics(): Promise<void> {
    try {
      this.lastDurableMetrics = await this.store.metrics();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}

class StaleResourceVisionJobError extends Error {
  constructor(jobKey: string) {
    super(`Resource vision job ${jobKey} lost its worker lease`);
    this.name = "StaleResourceVisionJobError";
  }
}

function matchesPreparedResourcePlan(
  input: ResourceVisionJobInput & Readonly<{
    buildId: string;
    sessionToken: number;
    prepared: PreparedResourceVisionPlan;
  }>,
  resourceVision: ResourceVision,
  contract: ResourceVisionJobContract
): boolean {
  const prepared = input.prepared;
  const planVision = prepared.plan.resourceVision;
  return prepared.buildId === input.buildId &&
    prepared.sessionToken === input.sessionToken &&
    prepared.flagId === input.flag.id &&
    prepared.flagId === resourceVision.flagId &&
    prepared.center.lat === input.flag.lat &&
    prepared.center.lon === input.flag.lon &&
    prepared.center.lat === resourceVision.center.lat &&
    prepared.center.lon === resourceVision.center.lon &&
    prepared.movementLeashRadiusM === input.movementLeashRadiusM &&
    prepared.movementLeashRadiusM === resourceVision.movementLeashRadiusM &&
    prepared.radiusM === resourceVision.radiusM &&
    prepared.layoutVersion === RESOURCE_LAYOUT_VERSION &&
    prepared.layoutVersion === prepared.plan.layoutVersion &&
    prepared.worldReleaseId === contract.worldReleaseId &&
    prepared.profileSetFingerprint === contract.profileSetFingerprint &&
    prepared.buildContractFingerprint === contract.buildContractFingerprint &&
    prepared.boundaryReleaseId === contract.boundaryReleaseId &&
    planVision.flagId === resourceVision.flagId &&
    planVision.center.lat === resourceVision.center.lat &&
    planVision.center.lon === resourceVision.center.lon &&
    planVision.movementLeashRadiusM === resourceVision.movementLeashRadiusM &&
    planVision.radiusM === resourceVision.radiusM;
}

function emptyDurableMetrics(): DurableResourceVisionJobMetrics {
  return {
    pending: 0,
    processing: 0,
    retrying: 0,
    terminalFailed: 0,
    completed: 0,
    oldestPendingAgeMs: 0,
    expiredLeases: 0
  };
}

export function visionForJob(
  flag: FlagSnapshot,
  movementLeashRadiusM: number
): ResourceVision {
  return resourceVisionForFlag({
    flagId: flag.id,
    flagName: flag.name,
    flagCenter: { lat: flag.lat, lon: flag.lon },
    movementLeashRadiusM,
    visionRadiusM: flag.resourceVisionRadiusM
  });
}

export function collectiblePlayerForFlag(flag: FlagSnapshot, regionCode: string) {
  return collectiblePlayerFromSnapshot({
    playerId: flag.ownerId,
    regionCode,
    lat: flag.lat,
    lon: flag.lon
  });
}

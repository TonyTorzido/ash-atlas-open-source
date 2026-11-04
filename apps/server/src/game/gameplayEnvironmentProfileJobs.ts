import { randomUUID } from "node:crypto";

import type { LatLon } from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import {
  ENVIRONMENT_SPAWN_RULES_VERSION,
  deriveEnvironmentSpawnProfileKey
} from "./environmentSpawnProfiles.js";
import {
  generateWorldEnvironmentCandidateSlots,
  persistableCandidateSlots,
  type CompactGameplayEnvironmentFacts,
  type GameplayEnvironmentBatchEntry,
  type GameplayEnvironmentProfileService,
  type WorldEnvironmentCellProfile
} from "./gameplayEnvironmentProfiles.js";
import type {
  ClaimedWorldEnvironmentProfileJob,
  WorldEnvironmentProfileJobMetrics,
  WorldEnvironmentProfileJobStore
} from "./gameplayEnvironmentProfileStore.js";

export type WorldEnvironmentProfileJobRuntimeMetrics = Readonly<{
  active: number;
  concurrency: number;
  supervisorRunning: boolean;
  claimed: number;
  completed: number;
  failed: number;
  staleCompletions: number;
  lastError: string | null;
  durable: WorldEnvironmentProfileJobMetrics;
}>;

export type WorldEnvironmentProfileJobOptions = Readonly<{
  leaseMs?: number;
  retryPollMs?: number;
  concurrency?: number;
}>;

type MaterializationLifecycle = Pick<
  GameplayEnvironmentProfileService,
  "acceptMaterializedProfile" | "recordMaterializationFailure"
>;

export class GameplayEnvironmentProfileMaterializer {
  constructor(
    private readonly worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironments">
  ) {}

  async materialize(
    job: ClaimedWorldEnvironmentProfileJob,
    signal?: AbortSignal
  ): Promise<WorldEnvironmentCellProfile> {
    const slotPoints = generateWorldEnvironmentCandidateSlots(job);
    const points: LatLon[] = [job.center, ...slotPoints.map((slot) => slot.position)];
    const rows = await this.worldLookup.lookupGameplayEnvironments(points, {
      signal,
      caller: "profile"
    });
    if (rows.length !== points.length) {
      throw new Error(
        `gameplay environment materialization returned ${rows.length} rows for ${points.length} points`
      );
    }
    const normalized = rows.map((row, index) => normalizeBatchEntry(row, points[index]!, job));
    const center = normalized[0]!;
    const candidateSlots = persistableCandidateSlots(slotPoints, normalized.slice(1));
    return {
      cellId: job.cellId,
      worldIdentityKey: job.worldIdentityKey,
      worldIdentity: { ...job.worldIdentity },
      profileVersion: job.profileVersion,
      candidateSlotVersion: job.candidateSlotVersion,
      sourceRuntimeSha: rows[0]?.runtime?.sha ?? job.sourceRuntimeSha,
      regionCode: job.regionCode,
      centerLat: center.latitude,
      centerLon: center.longitude,
      packageId: center.packageId,
      countryId: center.countryId,
      countryName: center.countryName,
      regionId: center.regionId,
      regionName: center.regionName,
      settlementId: center.settlementId,
      settlementName: center.settlementName,
      biomeId: center.biomeId,
      biomeName: center.biomeName,
      ecoregionId: center.ecoregionId,
      ecoregionName: center.ecoregionName,
      landCoverClass: center.landCoverClass,
      terrainClass: center.terrainClass,
      elevationM: center.elevationM,
      elevationBand: center.elevationBand,
      isLand: center.isLand,
      isSaltwater: center.isSaltwater,
      insideMajorLake: center.insideMajorLake,
      isRiverbank: center.isRiverbank,
      isLakeshore: center.isLakeshore,
      isCoastal: center.isCoastal,
      spawnProfileKey: deriveEnvironmentSpawnProfileKey(center),
      spawnRulesVersion: ENVIRONMENT_SPAWN_RULES_VERSION,
      environmentProfile: center,
      candidateSlots,
      createdAt: new Date().toISOString()
    };
  }
}

export class GameplayEnvironmentProfileJobService {
  private readonly ownerId = `world-environment-profile:${process.pid}:${randomUUID()}`;
  private readonly leaseMs: number;
  private readonly retryPollMs: number;
  private readonly concurrency: number;
  private supervisor: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private active = 0;
  private lastError: string | null = null;
  private claimed = 0;
  private completed = 0;
  private failed = 0;
  private staleCompletions = 0;
  private durable: WorldEnvironmentProfileJobMetrics = emptyDurableMetrics();
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    private readonly store: WorldEnvironmentProfileJobStore,
    private readonly materializer: Pick<GameplayEnvironmentProfileMaterializer, "materialize">,
    private readonly logger: Pick<AppLogger, "info" | "warn">,
    private readonly lifecycle?: MaterializationLifecycle,
    options: WorldEnvironmentProfileJobOptions = {}
  ) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.retryPollMs = options.retryPollMs ?? 500;
    this.concurrency = options.concurrency ?? 2;
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 15 * 60_000) {
      throw new Error("environment profile job lease must be 1 second through 15 minutes");
    }
    if (!Number.isInteger(this.retryPollMs) || this.retryPollMs < 25 || this.retryPollMs > 60_000) {
      throw new Error("environment profile retry poll must be 25ms through 60 seconds");
    }
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8) {
      throw new Error("environment profile concurrency must be an integer from 1 through 8");
    }
  }

  async start(): Promise<void> {
    if (this.supervisor) throw new Error("environment profile job supervisor is already running");
    this.stopping = false;
    const recovered = await this.store.recoverExpiredJobs();
    if (recovered > 0) {
      this.logger.warn({ recovered }, "recovered expired environment profile leases");
    }
    await this.refreshMetrics();
    this.supervisor = setInterval(() => {
      void this.store.recoverExpiredJobs()
        .then(() => this.refreshMetrics())
        .catch((error: unknown) => this.captureSupervisorError(error));
      this.wake();
    }, this.retryPollMs);
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.supervisor) {
      clearInterval(this.supervisor);
      this.supervisor = null;
    }
    for (const controller of this.activeControllers) {
      controller.abort(new Error("environment profile worker is stopping"));
    }
    while (this.active > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  wake(): void {
    if (this.stopping) return;
    while (this.active < this.concurrency) {
      this.active += 1;
      let claimed = false;
      void this.runNext()
        .then((didClaim) => {
          claimed = didClaim;
        })
        .catch((error: unknown) => this.captureSupervisorError(error))
        .finally(() => {
          this.active -= 1;
          if (claimed && !this.stopping) queueMicrotask(() => this.wake());
        });
    }
  }

  metricsSnapshot(): WorldEnvironmentProfileJobRuntimeMetrics {
    return {
      active: this.active,
      concurrency: this.concurrency,
      supervisorRunning: this.supervisor !== null,
      claimed: this.claimed,
      completed: this.completed,
      failed: this.failed,
      staleCompletions: this.staleCompletions,
      lastError: this.lastError,
      durable: { ...this.durable }
    };
  }

  async refreshMetricsSnapshot(): Promise<WorldEnvironmentProfileJobRuntimeMetrics> {
    await this.refreshMetrics();
    return this.metricsSnapshot();
  }

  private async runNext(): Promise<boolean> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      const job = await this.store.claimJob(this.ownerId, this.leaseMs);
      if (!job) return false;
      this.claimed += 1;
      this.lastError = null;
      if (this.stopping || controller.signal.aborted) {
        await this.store.failJob(
          job,
          controller.signal.reason ?? new Error("environment profile worker stopped after claim")
        );
        return true;
      }
      await this.run(job, controller);
      void this.refreshMetrics();
      return true;
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  private async run(
    job: ClaimedWorldEnvironmentProfileJob,
    controller: AbortController
  ): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.store.heartbeatJob(job, this.leaseMs)
        .then((owned) => {
          if (owned) return;
          clearInterval(heartbeat);
          controller.abort(new Error("environment profile lease ownership was lost"));
        })
        .catch((error: unknown) => {
          controller.abort(new Error("environment profile lease heartbeat failed", {
            cause: error
          }));
          this.logger.warn(
            { err: error, jobKey: job.jobKey },
            "environment profile lease heartbeat failed"
          );
        });
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    try {
      const profile = await this.materializer.materialize(job, controller.signal);
      controller.signal.throwIfAborted();
      const accepted = await this.store.completeMaterialization(job, profile);
      if (!accepted) {
        this.staleCompletions += 1;
        this.logger.warn(
          { jobKey: job.jobKey, cellId: job.cellId, ownerGeneration: job.ownerGeneration },
          "discarded stale environment profile materialization"
        );
        return;
      }
      this.completed += 1;
      await this.lifecycle?.acceptMaterializedProfile(profile);
      this.logger.info(
        {
          jobKey: job.jobKey,
          cellId: job.cellId,
          candidateSlotCount: profile.candidateSlots.length,
          spawnProfileKey: profile.spawnProfileKey,
          sourceRuntimeSha: profile.sourceRuntimeSha
        },
        "environment profile materialized"
      );
    } catch (error) {
      const failure = await this.store.failJob(job, error);
      if (failure.accepted) {
        this.failed += 1;
        this.lifecycle?.recordMaterializationFailure();
      }
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        {
          err: error,
          jobKey: job.jobKey,
          cellId: job.cellId,
          terminal: failure.terminal,
          failureAccepted: failure.accepted
        },
        "environment profile materialization failed"
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async refreshMetrics(): Promise<void> {
    try {
      this.durable = await this.store.jobMetrics();
    } catch (error) {
      this.captureSupervisorError(error);
    }
  }

  private captureSupervisorError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.logger.warn({ err: error }, "environment profile durable worker pass failed");
  }
}

export { GameplayEnvironmentProfileJobService as WorldEnvironmentProfileJobService };

function normalizeBatchEntry(
  row: WorldGameplayEnvironmentResult,
  requested: LatLon,
  job: ClaimedWorldEnvironmentProfileJob
): GameplayEnvironmentBatchEntry {
  if (!row.ok) {
    throw new Error(
      `gameplay environment lookup failed at ${requested.lat},${requested.lon}: ` +
      (row.failure?.message ?? row.warning ?? "unknown World failure")
    );
  }
  if (
    row.latitude !== requested.lat ||
    row.longitude !== requested.lon ||
    !row.packageId ||
    row.isLand === null ||
    row.isLand === undefined ||
    row.isSaltwater === null ||
    row.isSaltwater === undefined ||
    row.isCoastalLand === null ||
    row.isCoastalLand === undefined ||
    row.isRiverbank === null ||
    row.isRiverbank === undefined ||
    row.isLakeshore === null ||
    row.isLakeshore === undefined ||
    row.insideMajorLake === null ||
    row.insideMajorLake === undefined ||
    !row.release ||
    !row.runtime
  ) {
    throw new Error(`gameplay environment lookup returned incomplete authority at ${requested.lat},${requested.lon}`);
  }
  if (
    row.release.releaseId !== job.worldIdentity.releaseId ||
    row.release.profileSetFingerprint !== job.worldIdentity.profileSetFingerprint ||
    row.release.buildContractFingerprint !== job.worldIdentity.buildContractFingerprint ||
    row.release.boundaryReleaseId !== job.worldIdentity.boundaryReleaseId
  ) {
    throw new Error(`gameplay environment lookup returned stale World identity for ${job.cellId}`);
  }
  const facts: CompactGameplayEnvironmentFacts = {
    latitude: row.latitude,
    longitude: row.longitude,
    packageId: row.packageId,
    isLand: row.isLand,
    isSaltwater: row.isSaltwater,
    isCoastalLand: row.isCoastalLand,
    isRiverbank: row.isRiverbank,
    isLakeshore: row.isLakeshore,
    insideMajorLake: row.insideMajorLake,
    waterKind: row.waterKind ?? null,
    riverSurface: surfaceAuthority(row.riverSurface),
    lakeSurface: surfaceAuthority(row.lakeSurface),
    oceanSurface: surfaceAuthority(row.oceanCoastSurface),
    isCoastal: row.isCoastal ?? null,
    elevationM: row.elevationM,
    elevationBand: row.elevationBand,
    terrainClass: row.terrainClass,
    landCoverClass: row.landCoverClass ?? null,
    biomeId: row.biomeId ?? null,
    biomeName: row.biomeName,
    ecoregionId: row.ecoregionId ?? null,
    ecoregionName: row.ecoregionName,
    countryId: row.countryId ?? null,
    countryName: row.countryName ?? null,
    regionId: row.regionId ?? null,
    regionName: row.regionName ?? null,
    settlementId: row.settlementId,
    settlementName: row.settlementName,
    flagPlacementWater: row.flagPlacementWater ?? null
  };
  return { ...facts, ok: true, warning: row.warning ?? null };
}

function surfaceAuthority(surface: Readonly<{
  cellSizeM: number;
  rowId: number;
  columnId: number;
  sourceReleaseId: string;
  sourceManifestSha256: string;
}> | null | undefined) {
  return surface === null || surface === undefined
    ? null
    : {
        releaseId: surface.sourceReleaseId,
        manifestSha256: surface.sourceManifestSha256,
        cellSizeM: surface.cellSizeM,
        rowId: surface.rowId,
        columnId: surface.columnId
      };
}

function emptyDurableMetrics(): WorldEnvironmentProfileJobMetrics {
  return {
    pending: 0,
    leased: 0,
    retrying: 0,
    terminalFailed: 0,
    expiredLeases: 0,
    oldestPendingAgeMs: 0
  };
}

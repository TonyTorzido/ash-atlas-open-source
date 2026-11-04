import { randomUUID } from "node:crypto";

import {
  RESOURCE_LAYOUT_VERSION,
  type GameplayAreaContract,
  type PersonalAnchorKind,
  type ResourceVision
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import { BoundedReplayCache } from "./boundedReplayCache.js";
import {
  resourceVisionForFlag,
  type PreparedCollectibleVision
} from "./collectibles.js";
import {
  FlagPlacementError,
  type CreateFlagResult,
  type FlagService,
  type PreparedFlagPlacement
} from "./flags.js";
import type { PlayerRecord } from "./state.js";
import type { PreparedResourceVisionPlan } from "./resourceVisionJobs.js";

export type FlagBuildCancelReason =
  | "explicit"
  | "movement"
  | "teleport"
  | "combat"
  | "death"
  | "disconnect"
  | "incompatible-action"
  | "revalidation-failed";

export type FlagBuildSession = {
  buildId: string;
  requestId: string;
  playerId: string;
  preparedFlag: PreparedFlagPlacement;
  regionCode: string;
  movementLeashRadiusM: number;
  movementRevision: number;
  connectionId?: string;
  connectionGeneration?: number;
  startedAt: number;
  completesAt: number;
  token: number;
  status: "building" | "completing" | "completed" | "canceled";
};

export type QueuedFlagBuildSession = {
  buildId: string;
  requestId: string;
  playerId: string;
  anchorKind: PersonalAnchorKind;
  name?: string;
  queuedAt: number;
  status: "queued";
};

export type FlagBuildActivity = FlagBuildSession | QueuedFlagBuildSession;

export const FLAG_BUILD_REPLAY_MAX_ENTRIES = 2_048;
export const FLAG_BUILD_REPLAY_TTL_MS = 10 * 60_000;
export const FLAG_BUILD_POPULATION_RESERVATION_TTL_MS = 2 * 60_000;

export type CompletedFlagBuildRequest = {
  playerId: string;
  requestId: string;
  buildId: string;
  flagId: string;
};

type Hooks = {
  currentPlayer(playerId: string): PlayerRecord | null;
  isEligible(playerId: string): boolean;
  isMovementPending(playerId: string): boolean;
  isWorldTransitionPending(playerId: string): boolean;
  subscribeMovementSettled(playerId: string, listener: () => void): () => void;
  runAuthorityFence<T>(playerId: string, operation: () => Promise<T>): Promise<T>;
  currentConnectionAuthority?(playerId: string): Readonly<{
    connectionId: string;
    connectionGeneration: number;
  }> | null;
  replayCompleted(request: CompletedFlagBuildRequest): void | Promise<void>;
  sendQueued(session: QueuedFlagBuildSession): void;
  sendStarted(session: FlagBuildSession): void;
  sendCancelled(session: FlagBuildActivity, reason: FlagBuildCancelReason): void;
  queuedRejected(session: QueuedFlagBuildSession, message: string): void;
  reservePopulation?(input: Readonly<{
    sourceId: string;
    authorityToken: string;
    buildId: string;
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    area: GameplayAreaContract;
    signal: AbortSignal;
    expiresAtMs: number;
  }>): void | Promise<void>;
  releasePopulation?(sourceId: string): boolean;
  adoptPopulation?(input: Readonly<{
    sourceId: string;
    adoptedSourceId: string;
    authorityToken: string;
    buildId: string;
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    area: GameplayAreaContract;
    expiresAtMs: number;
  }>): "adopted" | "missing" | "rejected";
  prepareResourceVision?(input: Readonly<{
    buildId: string;
    playerId: string;
    token: number;
    regionCode: string;
    resourceVision: ResourceVision;
    signal: AbortSignal;
  }>): Promise<PreparedCollectibleVision>;
  committed(input: {
    session: FlagBuildSession;
    result: CreateFlagResult;
  }): void;
  completed(input: {
    session: FlagBuildSession;
    result: CreateFlagResult;
    preparedResourceVisionPlan?: PreparedResourceVisionPlan;
    pendingResourceVisionPlan?: Promise<PreparedResourceVisionPlan | null>;
  }): void | Promise<void>;
};

type SpeculativeResourcePreparation =
  | { status: "disabled" | "pending" | "failed" | "cancelled"; plan: null }
  | { status: "ready"; plan: PreparedResourceVisionPlan };

type RuntimeSession = FlagBuildSession & {
  completionTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController;
  populationPreparation: Promise<void> | null;
  populationReservationId: string | null;
  populationAuthorityToken: string | null;
  populationArea: GameplayAreaContract | null;
  resourcePreparationAbortController: AbortController;
  resourceVision: ResourceVision;
  resourcePreparation: SpeculativeResourcePreparation;
  resourcePreparationPromise: Promise<PreparedResourceVisionPlan | null> | null;
  timerFiredAt: number | null;
  timerFiredMonotonic: number | null;
};

type RuntimeQueuedSession = QueuedFlagBuildSession & {
  quoteId?: string;
  unsubscribeMovementSettled: (() => void) | null;
  activating: boolean;
};

export class FlagBuildCoordinator {
  private readonly active = new Map<string, RuntimeSession>();
  private readonly queued = new Map<string, RuntimeQueuedSession>();
  private readonly starting = new Set<string>();
  private readonly quoteWarmSubscriptions = new Map<string, () => void>();
  private readonly completedRequests: BoundedReplayCache<string, CompletedFlagBuildRequest>;
  constructor(
    private readonly config: AppConfig,
    private readonly flags: FlagService,
    private readonly logger: Pick<AppLogger, "info" | "warn">,
    private readonly hooks: Hooks,
    private readonly now: () => number = Date.now
  ) {
    this.completedRequests = new BoundedReplayCache(
      FLAG_BUILD_REPLAY_MAX_ENTRIES,
      FLAG_BUILD_REPLAY_TTL_MS,
      now
    );
  }

  activeForPlayer(playerId: string): FlagBuildActivity | null {
    return this.active.get(playerId) ?? this.queued.get(playerId) ?? null;
  }

  preparationMetrics(): { active: number; queued: number } {
    return {
      active: this.active.size + this.starting.size,
      queued: this.queued.size
    };
  }

  connectPlayer(playerId: string): void {
    this.quoteWarmSubscriptions.get(playerId)?.();
    this.quoteWarmSubscriptions.delete(playerId);
    const queued = this.queued.get(playerId);
    if (queued) this.hooks.sendQueued(queued);
    const active = this.active.get(playerId);
    if (active) {
      this.hooks.sendStarted(active);
      if (active.completesAt <= this.now() && active.status === "building") {
        queueMicrotask(() => void this.complete(active));
      }
    }
    this.scheduleQuoteWarm(playerId, "world-entry");
  }

  disconnectPlayer(playerId: string): void {
    this.quoteWarmSubscriptions.get(playerId)?.();
    this.quoteWarmSubscriptions.delete(playerId);
    this.cancelPlayer(playerId, "disconnect");
  }

  refreshQuoteForPlayer(playerId: string, reason: string): void {
    void this.prewarmQuote(playerId, reason);
  }

  async start(
    player: PlayerRecord,
    requestId: string,
    name?: string,
    quoteId?: string,
    anchorKind: PersonalAnchorKind = "flag"
  ): Promise<FlagBuildActivity | null> {
    const coordinatorStartedAt = this.now();
    const prior = this.active.get(player.playerId) ?? this.queued.get(player.playerId);
    if (prior?.requestId === requestId) {
      if (prior.status === "queued") this.hooks.sendQueued(prior);
      else this.hooks.sendStarted(prior);
      return prior;
    }
    if (prior || this.starting.has(player.playerId)) {
      throw new Error("A flag is already being constructed");
    }
    const completed = this.completedRequests.get(`${player.playerId}:${requestId}`);
    if (completed) {
      await this.hooks.replayCompleted(completed);
      return null;
    }
    if (this.hooks.isWorldTransitionPending(player.playerId)) {
      throw new Error("A player world transition is pending");
    }

    if (player.target || this.hooks.isMovementPending(player.playerId)) {
      const session: RuntimeQueuedSession = {
        buildId: randomUUID(),
        requestId,
        playerId: player.playerId,
        anchorKind,
        queuedAt: this.now(),
        status: "queued",
        ...(name === undefined ? {} : { name }),
        ...(quoteId === undefined ? {} : { quoteId }),
        unsubscribeMovementSettled: null,
        activating: false
      };
      this.queued.set(player.playerId, session);
      this.hooks.sendQueued(session);
      this.scheduleQueuedCheck(session);
      this.logger.info({
        playerId: player.playerId,
        buildId: session.buildId,
        requestId
      }, "flag build queued until movement stops");
      return session;
    }

    return this.prepareAndStart(
      player,
      requestId,
      name,
      quoteId,
      anchorKind,
      randomUUID(),
      coordinatorStartedAt
    );
  }

  cancelPlayer(playerId: string, reason: FlagBuildCancelReason, buildId?: string): boolean {
    const pending = this.queued.get(playerId);
    if (pending && (!buildId || pending.buildId === buildId)) {
      if (reason === "movement") return false;
      pending.unsubscribeMovementSettled?.();
      this.queued.delete(playerId);
      this.hooks.sendCancelled(pending, reason);
      this.logger.info({ playerId, buildId: pending.buildId, reason }, "queued flag build canceled");
      return true;
    }
    const session = this.active.get(playerId);
    if (!session || (buildId && session.buildId !== buildId) || session.status !== "building") {
      return false;
    }
    session.status = "canceled";
    session.token += 1;
    session.abortController.abort(new Error(`flag build canceled: ${reason}`));
    session.resourcePreparationAbortController.abort(
      new Error(`flag Resource Vision preparation canceled: ${reason}`)
    );
    session.resourcePreparation = { status: "cancelled", plan: null };
    if (session.populationReservationId) {
      this.hooks.releasePopulation?.(session.populationReservationId);
      session.populationReservationId = null;
    }
    if (session.completionTimer) clearTimeout(session.completionTimer);
    this.active.delete(playerId);
    this.hooks.sendCancelled(session, reason);
    this.logger.info({ playerId, buildId: session.buildId, reason }, "flag build canceled");
    return true;
  }

  private async prepareAndStart(
    player: PlayerRecord,
    requestId: string,
    name: string | undefined,
    quoteId: string | undefined,
    anchorKind: PersonalAnchorKind,
    buildId: string,
    coordinatorStartedAt: number
  ): Promise<FlagBuildSession> {
    this.starting.add(player.playerId);
    try {
      let preparedFlag: PreparedFlagPlacement;
      try {
        preparedFlag = await this.flags.prepareForPlayer(
          player,
          name,
          quoteId,
          anchorKind
        );
      } catch (error) {
        const diagnostic = error instanceof FlagPlacementError
          ? error.quoteDiagnostic
          : undefined;
        this.logger.info({
          playerId: player.playerId,
          requestId,
          ...(diagnostic ?? {
            quoteIdPresent: quoteId !== undefined,
            quoteState: "missing",
            quoteMismatchReason: "missing",
            quoteAgeMs: null,
            quoteExpiresInMs: null,
            movementRevision: player.movementRevision,
            relocationRevision: player.relocationRevision ?? 0,
            worldLookupAttempted: false
          }),
          worldLookupMs: 0,
          totalAdmissionMs: this.now() - coordinatorStartedAt
        }, "flag placement admission rejected");
        gameplayLatencyTrace.record(player.playerId, {
          traceId: requestId,
          source: "game",
          category: "build",
          name: "build_admission_rejected",
          details: {
            requestId,
            outcome: error instanceof FlagPlacementError
              ? error.code
              : "FLAG_BUILD_REJECTED",
            quoteState: diagnostic?.quoteState ?? "missing",
            totalAdmissionMs: this.now() - coordinatorStartedAt,
            worldLookupAttempted: diagnostic?.worldLookupAttempted ?? false,
            worldLookupMs: 0
          },
          failure: true
        });
        throw error;
      }
      this.logger.info({
        playerId: player.playerId,
        requestId,
        ...preparedFlag.quoteDiagnostic,
        worldLookupMs: preparedFlag.admissionTimings.worldLookupMs,
        totalAdmissionMs: this.now() - coordinatorStartedAt
      }, "flag placement admission accepted");
      gameplayLatencyTrace.record(player.playerId, {
        traceId: requestId,
        source: "game",
        category: "build",
        name: "build_admission_accepted",
        details: {
          requestId,
          quoteId: preparedFlag.quoteDiagnostic?.quoteIdPresent ? quoteId ?? null : null,
          quoteState: preparedFlag.quoteDiagnostic?.quoteState ?? "unknown",
          totalAdmissionMs: this.now() - coordinatorStartedAt,
          worldLookupAttempted: false,
          worldLookupMs: preparedFlag.admissionTimings.worldLookupMs,
          territoryMs: preparedFlag.admissionTimings.territoryAdmissionMs
        }
      });
      return await this.beginBuild(player, requestId, buildId, preparedFlag, coordinatorStartedAt);
    } finally {
      this.starting.delete(player.playerId);
    }
  }

  private async beginBuild(
    player: PlayerRecord,
    requestId: string,
    buildId: string,
    preparedFlag: PreparedFlagPlacement,
    coordinatorStartedAt: number
  ): Promise<FlagBuildSession> {
    const startedAt = this.now();
    const buildDurationMs = Math.max(
      1,
      Math.trunc(preparedFlag.buildDurationMs ?? this.config.FLAG_BUILD_DURATION_MS)
    );
    const connectionAuthority =
      this.hooks.currentConnectionAuthority?.(player.playerId) ?? null;
    const populationArea: GameplayAreaContract | null =
      connectionAuthority && this.hooks.reservePopulation
        ? {
            center: { lat: preparedFlag.lat, lon: preparedFlag.lon },
            certifiedVisibleRadiusM:
              this.config.FLAG_RESOURCE_VISION_RADIUS_M,
            preparedRadiusM:
              player.moveLeashRadiusM
              + this.config.FLAG_RESOURCE_VISION_RADIUS_M
              + this.config.FLAG_PREPARE_BUFFER_M,
            sourceType: "flag",
            sourceId: preparedFlag.flagId,
            generation: 1
          }
        : null;
    const populationReservationId = connectionAuthority && populationArea
      ? flagBuildPopulationSourceId(
          player.playerId,
          connectionAuthority.connectionGeneration,
          buildId
        )
      : null;
    const populationAuthorityToken = populationReservationId === null
      ? null
      : `${populationReservationId}:${requestId}:${player.movementRevision}`;
    const session: RuntimeSession = {
      buildId,
      requestId,
      playerId: player.playerId,
      preparedFlag,
      regionCode: preparedFlag.regionCode,
      movementLeashRadiusM: player.moveLeashRadiusM,
      movementRevision: player.movementRevision,
      ...(connectionAuthority ?? {}),
      startedAt,
      completesAt: startedAt + buildDurationMs,
      token: 1,
      status: "building",
      completionTimer: null,
      abortController: new AbortController(),
      populationPreparation: null,
      populationReservationId,
      populationAuthorityToken,
      populationArea,
      resourcePreparationAbortController: new AbortController(),
      resourceVision: resourceVisionForFlag({
        flagId: preparedFlag.flagId,
        flagName: preparedFlag.name,
        flagCenter: { lat: preparedFlag.lat, lon: preparedFlag.lon },
        movementLeashRadiusM: player.moveLeashRadiusM,
        visionRadiusM: this.config.FLAG_RESOURCE_VISION_RADIUS_M
      }),
      resourcePreparation: {
        status: this.hooks.prepareResourceVision ? "pending" : "disabled",
        plan: null
      },
      resourcePreparationPromise: null,
      timerFiredAt: null,
      timerFiredMonotonic: null
    };
    this.active.set(player.playerId, session);
    session.completionTimer = setTimeout(
      () => {
        session.timerFiredAt = this.now();
        session.timerFiredMonotonic = performance.now();
        void this.complete(session);
      },
      buildDurationMs
    );
    this.hooks.sendStarted(session);
    this.startResourceVisionPreparation(session);
    if (
      this.hooks.reservePopulation
      && session.populationReservationId
      && session.populationAuthorityToken
      && session.populationArea
      && session.connectionId
      && session.connectionGeneration !== undefined
    ) {
      const preparation = Promise.resolve().then(() =>
        this.hooks.reservePopulation!({
          sourceId: session.populationReservationId!,
          authorityToken: session.populationAuthorityToken!,
          buildId: session.buildId,
          playerId: session.playerId,
          connectionId: session.connectionId!,
          connectionGeneration: session.connectionGeneration!,
          area: session.populationArea!,
          signal: session.abortController.signal,
          expiresAtMs:
            session.completesAt + FLAG_BUILD_POPULATION_RESERVATION_TTL_MS
        })
      );
      session.populationPreparation = withPopulationPreparationCancellation(
        preparation,
        session.abortController
      );
      void session.populationPreparation.catch((error: unknown) => {
        if (
          session.abortController.signal.aborted
          || !this.isCurrent(session, session.token)
        ) return;
        this.logger.warn({
          err: error,
          buildId: session.buildId,
          playerId: session.playerId,
          flagId: session.preparedFlag.flagId,
          visibleRequired: true,
          flagTransactionAffected: false
        }, "flag population reservation failed; flag remains eligible");
      });
    }
    const startedMessageSentAt = this.now();
    this.logger.info({
      playerId: player.playerId,
      buildId: session.buildId,
      requestId,
      coordinatorStartedAt,
      placementValidationMs: startedAt - coordinatorStartedAt,
      admissionTimings: preparedFlag.admissionTimings,
      ...preparedFlag.quoteDiagnostic,
      worldLookupAttempted: false,
      worldLookupMs: preparedFlag.admissionTimings.worldLookupMs,
      totalAdmissionMs: startedAt - coordinatorStartedAt,
      startedMessageSentAt,
      startedAt,
      completesAt: session.completesAt
    }, "flag build started");
    gameplayLatencyTrace.record(player.playerId, {
      traceId: requestId,
      source: "game",
      category: "build",
      name: "construction_start_published",
      details: {
        requestId,
        buildId,
        totalAdmissionMs: startedAt - coordinatorStartedAt,
        buildDurationMs,
        worldLookupAttempted: false,
        worldLookupMs: preparedFlag.admissionTimings.worldLookupMs
      }
    });
    return session;
  }

  private scheduleQueuedCheck(session: RuntimeQueuedSession): void {
    if (
      this.queued.get(session.playerId) !== session ||
      session.unsubscribeMovementSettled ||
      session.activating
    ) return;
    session.unsubscribeMovementSettled = this.hooks.subscribeMovementSettled(
      session.playerId,
      () => {
        session.unsubscribeMovementSettled?.();
        session.unsubscribeMovementSettled = null;
        void this.activateQueuedWhenStopped(session);
      }
    );
    if (
      !this.hooks.isMovementPending(session.playerId) &&
      !this.hooks.currentPlayer(session.playerId)?.target
    ) {
      queueMicrotask(() => {
        session.unsubscribeMovementSettled?.();
        session.unsubscribeMovementSettled = null;
        void this.activateQueuedWhenStopped(session);
      });
    }
  }

  private async activateQueuedWhenStopped(session: RuntimeQueuedSession): Promise<void> {
    if (this.queued.get(session.playerId) !== session || session.activating) return;
    const player = this.hooks.currentPlayer(session.playerId);
    if (!player?.online) {
      this.cancelPlayer(session.playerId, "disconnect", session.buildId);
      return;
    }
    if (
      player.target ||
      this.hooks.isMovementPending(session.playerId) ||
      !this.hooks.isEligible(session.playerId) ||
      this.hooks.isWorldTransitionPending(session.playerId)
    ) {
      this.scheduleQueuedCheck(session);
      return;
    }

    session.activating = true;
    const movementRevision = player.movementRevision;
    try {
      const preparedFlag = await this.flags.prepareForPlayer(
        player,
        session.name,
        session.quoteId,
        session.anchorKind
      );
      const current = this.hooks.currentPlayer(session.playerId);
      if (
        this.queued.get(session.playerId) !== session ||
        !current?.online ||
        current.target ||
        this.hooks.isMovementPending(session.playerId) ||
        current.movementRevision !== movementRevision
      ) {
        return;
      }
      this.queued.delete(session.playerId);
      await this.beginBuild(
        current,
        session.requestId,
        session.buildId,
        preparedFlag,
        session.queuedAt
      );
    } catch (error) {
      if (this.queued.get(session.playerId) !== session) return;
      this.queued.delete(session.playerId);
      const diagnostic = error instanceof FlagPlacementError
        ? error.quoteDiagnostic
        : undefined;
      this.logger.info({
        playerId: session.playerId,
        requestId: session.requestId,
        ...(diagnostic ?? {
          quoteIdPresent: session.quoteId !== undefined,
          quoteState: "missing",
          quoteMismatchReason: "missing",
          quoteAgeMs: null,
          quoteExpiresInMs: null,
          movementRevision: player.movementRevision,
          relocationRevision: player.relocationRevision ?? 0,
          worldLookupAttempted: false
        }),
        worldLookupMs: 0,
        totalAdmissionMs: this.now() - session.queuedAt
      }, "queued flag placement admission rejected");
      this.hooks.queuedRejected(
        session,
        error instanceof Error ? error.message : "Flag build rejected"
      );
    } finally {
      session.activating = false;
      if (this.queued.get(session.playerId) === session) this.scheduleQueuedCheck(session);
    }
  }

  private async complete(session: RuntimeSession): Promise<void> {
    if (!this.isCurrent(session, session.token)) return;
    const fenceWaitStartedAt = this.now();
    const receipt = await this.hooks.runAuthorityFence(
      session.playerId,
      () => this.completeInsideFence(session, this.now() - fenceWaitStartedAt)
    );
    if (!receipt) return;
    void Promise.resolve(this.hooks.completed(receipt)).catch((error: unknown) => {
      this.logger.warn(
        { err: error, buildId: session.buildId, flagId: receipt.result.flag.id },
        "flag completed but post-commit background work failed"
      );
    });
  }

  private async completeInsideFence(
    session: RuntimeSession,
    authorityFenceWaitMs: number
  ): Promise<Parameters<Hooks["completed"]>[0] | null> {
    const token = session.token;
    if (!this.isCurrent(session, token)) return null;
    const completionAttemptAt = this.now();
    if (completionAttemptAt < session.completesAt) {
      session.status = "building";
      session.completionTimer = setTimeout(
        () => {
          session.timerFiredAt = this.now();
          session.timerFiredMonotonic = performance.now();
          void this.complete(session);
        },
        session.completesAt - completionAttemptAt
      );
      this.logger.warn({
        playerId: session.playerId,
        buildId: session.buildId,
        scheduledCompletesAt: session.completesAt,
        commitStartedAt: completionAttemptAt
      }, "flag build timer fired before scheduled completion; commit deferred");
      return null;
    }
    session.status = "completing";
    const player = this.hooks.currentPlayer(session.playerId);
    if (
      player &&
      !player.online &&
      player.movementRevision === session.movementRevision &&
      player.position.lat === session.preparedFlag.lat &&
      player.position.lon === session.preparedFlag.lon
    ) {
      session.status = "building";
      session.completionTimer = setTimeout(
        () => void this.complete(session),
        250
      );
      session.completionTimer.unref?.();
      return null;
    }
    const unchanged = player &&
      player.movementRevision === session.movementRevision &&
      player.position.lat === session.preparedFlag.lat &&
      player.position.lon === session.preparedFlag.lon;
    if (!unchanged || !this.hooks.isEligible(session.playerId) || this.hooks.isWorldTransitionPending(session.playerId)) {
      session.status = "building";
      this.cancelPlayer(session.playerId, "revalidation-failed", session.buildId);
      return null;
    }
    let flagCommitted = false;
    try {
      const commitStartedAt = this.now();
      const commitStartedMonotonic = performance.now();
      const result = await this.flags.commitPreparedPlacement(
        session.preparedFlag,
        true,
        session.requestId
      );
      const transactionCommittedAt = this.now();
      const transactionCommittedMonotonic = performance.now();
      flagCommitted = true;
      if (!this.isCurrent(session, token)) return null;
      const preparedResourceVisionPlan = session.resourcePreparation.status === "ready"
        ? session.resourcePreparation.plan
        : undefined;
      const pendingResourceVisionPlan =
        session.resourcePreparation.status === "pending"
          ? session.resourcePreparationPromise ?? undefined
          : undefined;
      if (
        session.populationReservationId
        && session.populationAuthorityToken
        && session.populationArea
        && session.connectionId
        && session.connectionGeneration !== undefined
        && this.hooks.adoptPopulation
      ) {
        const adoptedSourceId = flagPostBuildPopulationSourceId(
          result.flag.id,
          session.buildId
        );
        const adoption = this.hooks.adoptPopulation({
          sourceId: session.populationReservationId,
          adoptedSourceId,
          authorityToken: session.populationAuthorityToken,
          buildId: session.buildId,
          playerId: session.playerId,
          connectionId: session.connectionId,
          connectionGeneration: session.connectionGeneration,
          area: session.populationArea,
          expiresAtMs:
            this.now() + FLAG_BUILD_POPULATION_RESERVATION_TTL_MS
        });
        if (adoption === "adopted") {
          session.populationReservationId = adoptedSourceId;
        } else {
          this.logger.warn({
            buildId: session.buildId,
            playerId: session.playerId,
            flagId: result.flag.id,
            populationReservationId: session.populationReservationId,
            adoption
          }, "completed flag retained its original population reservation");
        }
      }
      session.status = "completed";
      this.active.delete(session.playerId);
      this.completedRequests.set(`${session.playerId}:${session.requestId}`, {
        playerId: session.playerId,
        requestId: session.requestId,
        buildId: session.buildId,
        flagId: result.flag.id
      });
      const publicationStartedAt = this.now();
      this.hooks.committed({ session, result });
      const flagCreatedSentAt = this.now();
      const flagCreatedSentMonotonic = performance.now();
      this.logger.info({
        playerId: session.playerId,
        buildId: session.buildId,
        flagId: result.flag.id,
        requestId: session.requestId,
        scheduledCompletesAt: session.completesAt,
        timerCallbackAt: session.timerFiredAt,
        timerCallbackMonotonic: session.timerFiredMonotonic,
        commitStartedAt,
        commitStartedMonotonic,
        transactionCommittedAt,
        transactionCommittedMonotonic,
        flagCreatedSentAt,
        flagCreatedSentMonotonic,
        authorityFenceWaitMs,
        timerFiredToCommitMs: session.timerFiredAt === null
          ? null
          : publicationStartedAt - session.timerFiredAt,
        commitToFlagCreatedSentMs: flagCreatedSentAt - publicationStartedAt,
        commitTimings: result.timings
      }, "flag build completed");
      gameplayLatencyTrace.record(session.playerId, {
        traceId: session.requestId,
        source: "game",
        category: "database",
        name: "flag_transaction_committed",
        details: {
          requestId: session.requestId,
          buildId: session.buildId,
          transactionMs: transactionCommittedAt - commitStartedAt,
          overlapCheckMs: result.timings?.finalTerritoryRevalidationMs ?? null,
          inventoryDebitMs: result.timings?.inventoryDebitMs ?? null,
          flagInsertMs: result.timings?.flagInsertMs ?? null
        }
      });
      gameplayLatencyTrace.record(session.playerId, {
        traceId: session.requestId,
        source: "game",
        category: "build",
        name: "construction_completed_published",
        details: {
          requestId: session.requestId,
          buildId: session.buildId,
          commitToPublicationMs: flagCreatedSentAt - publicationStartedAt
        }
      });
      return {
        session,
        result,
        ...(preparedResourceVisionPlan
          ? { preparedResourceVisionPlan }
          : {}),
        ...(pendingResourceVisionPlan
          ? { pendingResourceVisionPlan }
          : {})
      };
    } catch (error) {
      if (flagCommitted) {
        session.status = "completed";
        this.active.delete(session.playerId);
        this.logger.warn({ err: error, buildId: session.buildId }, "flag completed but post-commit publication failed");
        return null;
      }
      session.status = "building";
      this.logger.warn({ err: error, buildId: session.buildId }, "flag build completion failed");
      this.cancelPlayer(session.playerId, "revalidation-failed", session.buildId);
      return null;
    }
  }

  private isCurrent(session: RuntimeSession, token: number): boolean {
    return this.active.get(session.playerId) === session &&
      session.token === token &&
      (session.status === "building" || session.status === "completing");
  }

  private startResourceVisionPreparation(session: RuntimeSession): void {
    if (!this.hooks.prepareResourceVision) return;
    const token = session.token;
    session.resourcePreparationPromise = this.hooks.prepareResourceVision({
      buildId: session.buildId,
      playerId: session.playerId,
      token,
      regionCode: session.regionCode,
      resourceVision: session.resourceVision,
      signal: session.resourcePreparationAbortController.signal
    }).then((plan) => {
      if (
        session.token !== token ||
        session.status === "canceled" ||
        session.resourcePreparationAbortController.signal.aborted
      ) return null;
      if (!matchesResourceVisionPlan(plan, session.resourceVision)) {
        session.resourcePreparation = { status: "failed", plan: null };
        this.logger.warn(
          {
            buildId: session.buildId,
            playerId: session.playerId,
            flagId: session.preparedFlag.flagId
          },
          "speculative flag Resource Vision plan did not match the accepted build"
        );
        return null;
      }
      const preparedPlan: PreparedResourceVisionPlan = {
        buildId: session.buildId,
        sessionToken: token,
        flagId: session.preparedFlag.flagId,
        center: { ...session.resourceVision.center },
        movementLeashRadiusM: session.resourceVision.movementLeashRadiusM,
        radiusM: session.resourceVision.radiusM,
        layoutVersion: RESOURCE_LAYOUT_VERSION,
        worldReleaseId: this.config.WORLD_REQUIRED_RELEASE_ID,
        profileSetFingerprint:
          this.config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
        buildContractFingerprint:
          this.config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
        boundaryReleaseId:
          this.config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID,
        plan
      };
      session.resourcePreparation = {
        status: "ready",
        plan: preparedPlan
      };
      this.logger.info(
        {
          buildId: session.buildId,
          playerId: session.playerId,
          flagId: session.preparedFlag.flagId,
          radiusM: session.resourceVision.radiusM
        },
        "speculative flag Resource Vision plan prepared"
      );
      return preparedPlan;
    }).catch((error: unknown) => {
      if (
        session.resourcePreparationAbortController.signal.aborted ||
        session.token !== token ||
        session.status === "canceled"
      ) return null;
      session.resourcePreparation = { status: "failed", plan: null };
      this.logger.warn(
        {
          err: error,
          buildId: session.buildId,
          playerId: session.playerId,
          flagId: session.preparedFlag.flagId
        },
        "speculative flag Resource Vision preparation failed; durable fallback remains"
      );
      return null;
    });
  }

  private scheduleQuoteWarm(playerId: string, reason: string): void {
    const player = this.hooks.currentPlayer(playerId);
    if (player?.online && !player.target && !this.hooks.isMovementPending(playerId)) {
      void this.prewarmQuote(playerId, reason);
    }
    const unsubscribe = this.hooks.subscribeMovementSettled(playerId, () => {
      if (this.quoteWarmSubscriptions.get(playerId) !== unsubscribe) return;
      this.quoteWarmSubscriptions.delete(playerId);
      void this.prewarmQuote(playerId, "movement-settled").finally(() => {
        if (this.hooks.currentPlayer(playerId)?.online) {
          this.scheduleQuoteWarm(playerId, "movement-settled");
        }
      });
    });
    this.quoteWarmSubscriptions.set(playerId, unsubscribe);
  }

  private async prewarmQuote(playerId: string, reason: string): Promise<void> {
    const player = this.hooks.currentPlayer(playerId);
    if (
      this.active.has(playerId) ||
      this.queued.has(playerId) ||
      this.starting.has(playerId)
    ) {
      this.flags.notePostBuildQuoteSuppressed();
      gameplayLatencyTrace.record(playerId, {
        source: "game",
        category: "flag-preparation",
        name: "post_build_quote_suppressed",
        details: { reason }
      });
      return;
    }
    if (
      !player?.online ||
      player.target ||
      this.hooks.isMovementPending(playerId) ||
      this.hooks.isWorldTransitionPending(playerId)
    ) return;
    const startedAt = this.now();
    const traceId = randomUUID();
    gameplayLatencyTrace.record(playerId, {
      traceId,
      source: "game",
      category: "flag-preparation",
      name: "background_prewarm_started",
      details: {
        reason,
        movementRevision: player.movementRevision,
        relocationRevision: player.relocationRevision ?? 0
      }
    });
    try {
      const { quote } = await this.flags.createPlacementQuote(player);
      this.logger.info({
        playerId,
        reason,
        quoteAgeMs: 0,
        quoteExpiresInMs: quote.expiresAt - this.now(),
        totalMs: this.now() - startedAt
      }, "flag placement quote prewarmed");
      gameplayLatencyTrace.record(playerId, {
        traceId,
        source: "game",
        category: "flag-preparation",
        name: "background_prewarm_completed",
        details: {
          reason,
          outcome: "QUOTE_READY",
          totalMs: this.now() - startedAt,
          compactQuoteAttempts: 1,
          richWorldCalls: 0,
          quoteId: quote.quoteId
        }
      });
    } catch (error) {
      this.logger.warn({
        err: error,
        playerId,
        reason,
        totalMs: this.now() - startedAt
      }, "flag placement quote prewarm failed");
      gameplayLatencyTrace.record(playerId, {
        traceId,
        source: "game",
        category: "flag-preparation",
        name: "background_prewarm_failed_silently",
        details: {
          reason,
          outcome: error instanceof FlagPlacementError ? error.code : "INTERNAL_ERROR",
          totalMs: this.now() - startedAt,
          notificationDisplayed: false,
          richWorldCalls: 0
        },
        failure: true
      });
    }
  }
}

function withPopulationPreparationCancellation(
  preparation: Promise<void>,
  abortController: AbortController
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      abortController.signal.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      rejectOnce(
        abortController.signal.reason ??
          new Error("flag population preparation cancelled")
      );
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });
    void preparation.then(
      resolveOnce,
      rejectOnce
    );
  });
}

export function flagBuildPopulationSourceId(
  playerId: string,
  connectionGeneration: number,
  buildId: string
): string {
  return `flag-build:${playerId}:${connectionGeneration}:${buildId}`;
}

export function flagPostBuildPopulationSourceId(
  flagId: string,
  buildId: string
): string {
  return `flag-post-build:${flagId}:${buildId}`;
}

function matchesResourceVisionPlan(
  plan: PreparedCollectibleVision,
  expected: ResourceVision
): boolean {
  return plan.layoutVersion === RESOURCE_LAYOUT_VERSION &&
    plan.resourceVision.flagId === expected.flagId &&
    plan.resourceVision.center.lat === expected.center.lat &&
    plan.resourceVision.center.lon === expected.center.lon &&
    plan.resourceVision.movementLeashRadiusM === expected.movementLeashRadiusM &&
    plan.resourceVision.radiusM === expected.radiusM;
}

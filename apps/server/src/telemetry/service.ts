import { hostname } from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import {
  BUG_REPORT_CONTEXT_MAX_COMPRESSED_BYTES,
  BUG_REPORT_CONTEXT_MAX_UNCOMPRESSED_BYTES,
  BUG_REPORT_HISTORY_WINDOW_MS,
  BUG_REPORT_NEARBY_ENTITY_LIMIT,
  type BugReportSubmitMessage,
  type ClientTelemetrySample
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../config.js";
import { createPool, type DbPool } from "../db/pool.js";
import type { AppLogger } from "../logger.js";
import {
  BoundedTelemetryQueue,
  type TelemetryPriority,
  type TelemetryQueueItem,
  type TelemetryQueueSnapshot,
  type TelemetryTable
} from "./queue.js";
import {
  BugReportEmailDeliveryError,
  createBugReportEmailSender,
  type BugReportEmail
} from "./bugReportEmail.js";

const TELEMETRY_SCHEMA_VERSION = 1;
const ACTIVE_RUN_REFRESH_MS = 15_000;
const WARNING_RATE_LIMIT_MS = 60_000;
const MAX_FLUSH_ATTEMPTS = 2;
const gzipAsync = promisify(gzip);
const BUG_REPORT_CLOCK_FUTURE_TOLERANCE_MS = 2 * 60_000;
const BUG_REPORT_MARKER_MAX_AGE_MS = 24 * 60 * 60_000;
const BUG_REPORT_RATE_WINDOW_MS = 10 * 60_000;
const PUBLIC_REPORT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type ActiveTestRun = Readonly<{
  runId: string;
  segmentId: string | null;
  campaignId: string | null;
  segmentSequence: number | null;
  segmentStartAt: Date | null;
  segmentEndAt: Date | null;
  releaseSha: string;
  releaseGeneration: string | null;
  worldReleaseId: string;
  populationPlanVersion: string;
  populationSpawnRulesVersion: string;
  balanceVersion: string;
}>;

type BaseRecord = Readonly<{
  telemetry_schema_version: number;
  run_id: string;
  release_sha: string;
  release_generation: string | null;
  world_release_id: string;
  population_plan_version: string;
  population_spawn_rules_version: string;
  balance_version: string;
  server_instance_id: string;
}>;

export type TelemetryEventInput = Readonly<{
  eventFamily:
    | "connection"
    | "session"
    | "travel"
    | "harvest"
    | "combat"
    | "economy"
    | "progression"
    | "settlement"
    | "social"
    | "population"
    | "persistence";
  eventType: string;
  priority: TelemetryPriority;
  eventTime?: Date;
  eventSchemaVersion?: number;
  playerId?: string | null;
  otherActorId?: string | null;
  targetId?: string | null;
  sessionId?: string | null;
  operationId?: string | null;
  connectionGeneration?: number | null;
  gameplayZoneId?: string | null;
  sourceType?: string | null;
  sourceEntityId?: string | null;
  itemOrCurrencyId?: string | null;
  itemVariant?: string | null;
  quantityBefore?: number | null;
  quantityDelta?: number | null;
  quantityAfter?: number | null;
  appliedState?: "applied" | "replayed" | "rejected" | "failed" | null;
  rejectionCode?: string | null;
  durationMs?: number | null;
  distanceM?: number | null;
  metadata?: Readonly<Record<string, unknown>>;
  coalesceKey?: string;
}>;

export type WorldSampleInput = Readonly<{
  scopeType: "global" | "region" | "zone";
  scopeId: string;
  entityCategory: string;
  plannedCount?: number | null;
  persistedCount?: number | null;
  readyAliveCount?: number | null;
  deadHarvestedCount?: number | null;
  respawnPendingCount?: number | null;
  suppressedCount?: number | null;
  activeRuntimeCount?: number | null;
  sleepingCount?: number | null;
  visibleCount?: number | null;
  reconciliationSource?: "runtime" | "postgres_reconciliation";
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type PlayerSnapshotInput = Readonly<{
  playerId: string;
  sessionId?: string | null;
  snapshotReason:
    | "login"
    | "interval"
    | "logout"
    | "terminal_disconnect"
    | "run_freeze"
    | "progression_change"
    | "ownership_change";
  onlineDurationSeconds: number;
  level?: number | null;
  totalXp?: number | null;
  classId?: string | null;
  subclassId?: string | null;
  classLoadout?: unknown;
  professionProgression?: unknown;
  gold?: number | string | null;
  inventoryRevision?: number | null;
  inventorySnapshotId?: string | null;
  equipmentRevision?: number | null;
  equippedItems?: unknown;
  currentHp?: number | null;
  maximumHp?: number | null;
  lifeState?: "alive" | "downed" | "defeated" | "respawning" | null;
  combatState?: string | null;
  personalFlagCount?: number | null;
  cityId?: string | null;
  cityRole?: string | null;
  kingdomId?: string | null;
  kingdomRole?: string | null;
  manorId?: string | null;
  partyId?: string | null;
  coarseZoneId?: string | null;
  currentFlagId?: string | null;
  cumulativeCounters?: unknown;
  lastAuthoritativeActivityAt?: Date | null;
}>;

export type InventorySnapshotInput = Readonly<{
  inventorySnapshotId?: string;
  playerId: string;
  sessionId?: string | null;
  snapshotReason:
    | "login"
    | "interval_changed"
    | "consistency_checkpoint"
    | "logout"
    | "terminal_disconnect"
    | "run_freeze"
    | "progression_change"
    | "ownership_change";
  inventoryRevision: number;
  items: unknown;
  itemStackCount: number;
  totalQuantity: number;
}>;

export type ServerSampleInput = Readonly<Record<string, unknown>> & {
  eventLoopDelayP99Ms?: number | null;
};

type SessionAccumulator = {
  playerId: string;
  sessionId: string;
  startedAt: Date;
  deviceCategory: string | null;
  reconnectCount: number;
  disconnectCount: number;
  distanceTraveledM: number;
  pveEncounters: number;
  pvpEncounters: number;
  pvpEncounterIds: Set<string>;
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  transitionFailures: number;
  transitionForcedReleases: number;
  errorCount: number;
  rttMeanSamples: number[];
  rttP95Samples: number[];
  clientFrameMeanSamples: number[];
  clientFrameP95Samples: number[];
  locationsVisited: Set<string>;
  entitiesEncountered: Record<string, number>;
  itemsGathered: Record<string, number>;
  goldEarned: number;
  goldSpent: number;
  xpEarned: number;
  professionXpEarned: Record<string, number>;
  marketActivity: Record<string, number>;
  settlementActivity: Record<string, number>;
  socialActivity: Record<string, number>;
  harvestRejections: Record<string, number>;
  attackRejections: Record<string, number>;
  majorFeatures: Set<string>;
};

type ClientRateState = {
  windowStartedAt: number;
  acceptedInWindow: number;
  lastRoutineAt: number;
  lastSequence: number;
};

export type ClosedTestTelemetryMetrics = Readonly<{
  enabled: boolean;
  accepting: boolean;
  activeRunId: string | null;
  degraded: boolean;
  queue: TelemetryQueueSnapshot;
  lastSuccessfulFlushAt: string | null;
  rowsFlushed: number;
  writeFailures: number;
  lastDatabaseErrorAt: string | null;
  lastDatabaseError: string | null;
  lastFlushDurationMs: number | null;
  pool: ReturnType<DbPool["metricsSnapshot"]> | null;
}>;

export type BugReportAuthoritativeContext = Readonly<{
  playerState: Readonly<Record<string, unknown>>;
  nearbyEntities: readonly Readonly<Record<string, unknown>>[];
}>;

export type BugReportSubmissionResult =
  | Readonly<{ success: true; reportCode: string; duplicate: boolean }>
  | Readonly<{
      success: false;
      code: string;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
    }>;

export type DeveloperBugReportListItem = Readonly<{
  reportCode: string;
  submittedAt: string;
  title: string;
  category: string;
  description: string;
  expectedBehavior: string;
  reproducibility: string;
  status: string;
  releaseGeneration: string | null;
  exportStatus: string;
}>;

export class ClosedTestTelemetryService {
  private readonly queue: BoundedTelemetryQueue;
  private readonly pool: DbPool | null;
  private readonly serverInstanceId: string;
  private readonly logicalSessionIdByKey = new Map<string, string>();
  private readonly knownLogicalSessionIds = new Set<string>();
  private readonly sessions = new Map<string, SessionAccumulator>();
  private readonly clientRates = new Map<string, ClientRateState>();
  private readonly activeBugReportSubmissions = new Set<string>();
  private readonly bugReportRateByAccount = new Map<string, number[]>();
  private readonly sendBugReportEmail: (report: BugReportEmail) => Promise<void>;
  private readonly tickDurationsMs: number[] = [];
  private tickWriteIndex = 0;
  private readonly gcCountByType: Record<string, number> = {};
  private readonly gcPauseMsByType: Record<string, number> = {};
  private readonly gcObserver: PerformanceObserver | null;
  private activeRun: ActiveTestRun | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private runRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private segmentRotationTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private segmentRotationPromise: Promise<void> | null = null;
  private accepting = true;
  private degraded = false;
  private healthyIntervals = 0;
  private consecutiveWriteFailures = 0;
  private lastSuccessfulFlushAt: Date | null = null;
  private rowsFlushed = 0;
  private writeFailures = 0;
  private lastDatabaseErrorAt: Date | null = null;
  private lastDatabaseError: string | null = null;
  private lastFlushDurationMs: number | null = null;
  private nextFlushNotBefore = 0;
  private lastWarningAt = 0;
  private runFreezeHandler: ((
    runId: string,
    reason: "manual_freeze" | "segment_rotation"
  ) => void | Promise<void>) | null = null;
  private closingRunId: string | null = null;
  private preparedRotationRunId: string | null = null;
  private pendingSegmentSessions: Array<{
    sessionKey: string;
    playerId: string;
  }> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    pool?: DbPool,
    sendBugReportEmail?: (report: BugReportEmail) => Promise<void>
  ) {
    this.queue = new BoundedTelemetryQueue(config.TELEMETRY_QUEUE_MAX_ROWS);
    this.serverInstanceId =
      config.RUNTIME_LABEL ?? `${hostname()}:${process.pid}`;
    this.pool = config.TELEMETRY_ENABLED
      ? pool ?? createPool({
          databaseUrl: config.TELEMETRY_DATABASE_URL!,
          max: config.TELEMETRY_DB_POOL_MAX,
          connectionTimeoutMs: config.TELEMETRY_WRITE_TIMEOUT_MS,
          idleTimeoutMs: 10_000,
          queryTimeoutMs: config.TELEMETRY_WRITE_TIMEOUT_MS,
          statementTimeoutMs: config.TELEMETRY_WRITE_TIMEOUT_MS,
          applicationName: `ash-atlas-telemetry:${this.serverInstanceId}`,
          logger
        })
      : null;
    this.sendBugReportEmail = sendBugReportEmail
      ?? createBugReportEmailSender(config);
    this.gcObserver = this.createGcObserver();
  }

  start(): void {
    if (!this.pool || this.flushTimer) return;
    this.gcObserver?.observe({ entryTypes: ["gc"] });
    void this.refreshActiveRun();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.TELEMETRY_FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
    this.runRefreshTimer = setInterval(() => {
      void this.refreshActiveRun();
    }, ACTIVE_RUN_REFRESH_MS);
    this.runRefreshTimer.unref?.();
  }

  setRunFreezeHandler(handler: (
    runId: string,
    reason: "manual_freeze" | "segment_rotation"
  ) => void | Promise<void>): void {
    this.runFreezeHandler = handler;
  }

  freezeSessions(resumeAfterRotation = false): void {
    if (!this.activeRun || !this.pool) return;
    const continuations: Array<{ sessionKey: string; playerId: string }> = [];
    for (const sessionKey of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionKey);
      if (!session) continue;
      if (resumeAfterRotation) {
        continuations.push({ sessionKey, playerId: session.playerId });
      }
      this.recordEventInternal({
        eventFamily: "session",
        eventType: "run_freeze",
        priority: "critical",
        playerId: session.playerId,
        sessionId: sessionKey
      }, true);
      this.enqueueSessionSummary(sessionKey);
    }
    this.logicalSessionIdByKey.clear();
    this.knownLogicalSessionIds.clear();
    this.pendingSegmentSessions = continuations;
  }

  observeTick(durationMs: number): void {
    if (!this.pool || !Number.isFinite(durationMs) || durationMs < 0) return;
    const maximum =
      Math.ceil(this.config.SERVER_TICK_HZ * this.config.TELEMETRY_SERVER_SAMPLE_INTERVAL_MS / 1_000)
      * 2;
    if (this.tickDurationsMs.length < maximum) {
      this.tickDurationsMs.push(durationMs);
    } else {
      this.tickDurationsMs[this.tickWriteIndex] = durationMs;
      this.tickWriteIndex = (this.tickWriteIndex + 1) % maximum;
    }
  }

  recordServerSample(input: ServerSampleInput): boolean {
    if (!this.isActive()) return false;
    const eventLoopP99 = input.eventLoopDelayP99Ms;
    const gameplayPoolWaiting = input.gameplay_pool_waiting;
    this.updateDegradation(
      typeof eventLoopP99 === "number" ? eventLoopP99 : null,
      typeof gameplayPoolWaiting === "number" && gameplayPoolWaiting > 0
    );
    const ticks = this.consumeTickHistogram();
    const garbageCollection = this.consumeGarbageCollectionMetrics();
    return this.enqueue(
      "server_samples",
      "server_sample",
      "routine",
      {
        ...this.baseRecord(),
        recorded_at: new Date(),
        sample_source: "game_server",
        ...input,
        event_loop_delay_p99_ms: eventLoopP99 ?? null,
        tick_count: ticks.count,
        tick_mean_ms: ticks.mean,
        tick_p50_ms: ticks.p50,
        tick_p95_ms: ticks.p95,
        tick_p99_ms: ticks.p99,
        tick_max_ms: ticks.max,
        ticks_over_25_ms: ticks.over25,
        ticks_over_50_ms: ticks.over50,
        ticks_over_100_ms: ticks.over100,
        gc_counts_by_type: garbageCollection.countByType,
        gc_pause_ms_by_type: garbageCollection.pauseMsByType,
        telemetry_queue_depth: this.queue.depth,
        telemetry_rows_flushed: this.rowsFlushed,
        telemetry_rows_dropped_by_priority: this.queue.snapshot().droppedByPriority,
        telemetry_flush_duration_ms: this.lastFlushDurationMs,
        telemetry_write_failures: this.writeFailures
      },
      "server-sample"
    );
  }

  recordWorldSamples(samples: readonly WorldSampleInput[]): number {
    if (!this.isActive()) return 0;
    let accepted = 0;
    const recordedAt = new Date();
    for (const sample of samples) {
      if (this.enqueue(
        "world_samples",
        `world_sample:${sample.entityCategory}`,
        "routine",
        {
          ...this.baseRecord(),
          recorded_at: recordedAt,
          scope_type: sample.scopeType,
          scope_id: sample.scopeId,
          entity_category: sample.entityCategory,
          planned_count: sample.plannedCount ?? null,
          persisted_count: sample.persistedCount ?? null,
          ready_alive_count: sample.readyAliveCount ?? null,
          dead_harvested_count: sample.deadHarvestedCount ?? null,
          respawn_pending_count: sample.respawnPendingCount ?? null,
          suppressed_count: sample.suppressedCount ?? null,
          active_runtime_count: sample.activeRuntimeCount ?? null,
          sleeping_count: sample.sleepingCount ?? null,
          visible_count: sample.visibleCount ?? null,
          reconciliation_source: sample.reconciliationSource ?? "runtime",
          metadata: sanitizeMetadata(sample.metadata ?? {})
        },
        `world-sample:${sample.scopeType}:${sample.scopeId}:${sample.entityCategory}`
      )) accepted += 1;
    }
    return accepted;
  }

  recordEvent(input: TelemetryEventInput): boolean {
    return this.recordEventInternal(input, false);
  }

  private recordEventInternal(
    input: TelemetryEventInput,
    allowClosingRun: boolean
  ): boolean {
    if (
      !this.isActive()
      && !(
        allowClosingRun
        && this.activeRun
        && this.closingRunId === this.activeRun.runId
      )
    ) return false;
    const sessionId = this.resolveSessionId(input.sessionId ?? null);
    const accepted = this.enqueue(
      "gameplay_events",
      input.eventType,
      input.priority,
      {
        ...this.baseRecord(),
        event_id: crypto.randomUUID(),
        event_time: input.eventTime ?? new Date(),
        event_family: input.eventFamily,
        event_type: input.eventType,
        event_schema_version: input.eventSchemaVersion ?? 1,
        priority: input.priority,
        player_id: input.playerId ?? null,
        other_actor_id: input.otherActorId ?? null,
        target_id: input.targetId ?? null,
        session_id: sessionId,
        operation_id: input.operationId ?? null,
        connection_generation: input.connectionGeneration ?? null,
        gameplay_zone_id: input.gameplayZoneId ?? null,
        source_type: input.sourceType ?? null,
        source_entity_id: input.sourceEntityId ?? null,
        item_or_currency_id: input.itemOrCurrencyId ?? null,
        item_variant: input.itemVariant ?? null,
        quantity_before: input.quantityBefore ?? null,
        quantity_delta: input.quantityDelta ?? null,
        quantity_after: input.quantityAfter ?? null,
        applied_state: input.appliedState ?? null,
        rejection_code: input.rejectionCode ?? null,
        duration_ms: input.durationMs ?? null,
        distance_m: input.distanceM ?? null,
        metadata: sanitizeMetadata(input.metadata ?? {})
      },
      input.coalesceKey
    );
    if (accepted && input.sessionId) this.accumulateSessionEvent(input);
    return accepted;
  }

  openSession(input: {
    playerId: string;
    sessionId: string;
    connectionGeneration: number;
    gameplayZoneId?: string | null;
    reconnect?: boolean;
  }): string | null {
    if (!this.isActive()) return null;
    const existing = this.sessions.get(input.sessionId);
    const reconnect = input.reconnect ?? Boolean(existing);
    if (existing) {
      existing.reconnectCount += 1;
    } else {
      const logicalSessionId = crypto.randomUUID();
      this.logicalSessionIdByKey.set(input.sessionId, logicalSessionId);
      this.knownLogicalSessionIds.add(logicalSessionId);
      this.sessions.set(
        input.sessionId,
        emptySession(input.playerId, logicalSessionId)
      );
    }
    this.recordEvent({
      eventFamily: reconnect ? "connection" : "session",
      eventType: reconnect ? "reconnect_success" : "login",
      priority: "important",
      playerId: input.playerId,
      sessionId: input.sessionId,
      connectionGeneration: input.connectionGeneration,
      gameplayZoneId: input.gameplayZoneId ?? null
    });
    if (reconnect) {
      this.recordEvent({
        eventFamily: "connection",
        eventType: "link_dead_end",
        priority: "important",
        playerId: input.playerId,
        sessionId: input.sessionId,
        connectionGeneration: input.connectionGeneration
      });
      this.recordEvent({
        eventFamily: "connection",
        eventType: "connection_authority_rotated",
        priority: "important",
        playerId: input.playerId,
        sessionId: input.sessionId,
        connectionGeneration: input.connectionGeneration
      });
    }
    return this.sessions.get(input.sessionId)?.sessionId ?? null;
  }

  closeSession(input: {
    playerId: string;
    sessionId: string;
    connectionGeneration: number;
    clean: boolean;
    retryable: boolean;
    closeCode: number | null;
    closeReasonCategory: string;
  }): string | null {
    if (!this.isActive()) return null;
    const logicalSessionId = this.resolveSessionId(input.sessionId);
    const eventType = input.clean
      ? "clean_logout"
      : input.retryable
        ? "retryable_disconnect"
        : "terminal_disconnect";
    this.recordEvent({
      eventFamily: input.clean ? "session" : "connection",
      eventType,
      priority: input.clean ? "important" : "critical",
      playerId: input.playerId,
      sessionId: input.sessionId,
      connectionGeneration: input.connectionGeneration,
      metadata: {
        closeCode: input.closeCode,
        closeReasonCategory: input.closeReasonCategory
      }
    });
    if (input.retryable) {
      const session = this.sessions.get(input.sessionId);
      if (session) session.disconnectCount += 1;
      this.recordEvent({
        eventFamily: "connection",
        eventType: "link_dead_start",
        priority: "important",
        playerId: input.playerId,
        sessionId: input.sessionId,
        connectionGeneration: input.connectionGeneration
      });
      return logicalSessionId;
    }
    this.enqueueSessionSummary(input.sessionId);
    return logicalSessionId;
  }

  acceptClientBatch(input: {
    playerId: string;
    sessionId: string;
    connectionGeneration: number;
    samples: readonly ClientTelemetrySample[];
  }): number {
    if (
      !this.config.TELEMETRY_CLIENT_ENABLED
      || !this.isActive()
      || this.degraded
    ) return 0;
    const logicalSessionId = this.resolveSessionId(input.sessionId);
    const session = this.sessions.get(input.sessionId);
    if (!logicalSessionId || !session) return 0;
    const now = Date.now();
    const state = this.clientRates.get(logicalSessionId) ?? {
      windowStartedAt: now,
      acceptedInWindow: 0,
      lastRoutineAt: 0,
      lastSequence: -1
    };
    if (now - state.windowStartedAt >= this.config.TELEMETRY_CLIENT_SAMPLE_INTERVAL_MS) {
      state.windowStartedAt = now;
      state.acceptedInWindow = 0;
    }
    let accepted = 0;
    for (const sample of input.samples) {
      if (sample.sequence <= state.lastSequence || state.acceptedInWindow >= 4) continue;
      if (
        sample.reason === "interval" &&
        now - state.lastRoutineAt < this.config.TELEMETRY_CLIENT_SAMPLE_INTERVAL_MS
      ) continue;
      const queued = this.enqueue(
        "client_samples",
        `client_sample:${sample.reason}`,
        "routine",
        {
          ...this.baseRecord(),
          recorded_at: new Date(),
          player_id: input.playerId,
          session_id: logicalSessionId,
          connection_generation: input.connectionGeneration,
          client_sequence: sample.sequence,
          sample_reason: sample.reason,
          device_category: sample.deviceCategory,
          operating_system_family: sample.operatingSystemFamily,
          browser_family: sample.browserFamily,
          browser_major_version: sample.browserMajorVersion,
          installed_pwa: sample.installedPwa,
          foreground_state: sample.foregroundState,
          viewport_width: sample.viewportWidth,
          viewport_height: sample.viewportHeight,
          screen_size_class: sample.screenSizeClass,
          fps_mean: sample.fpsMean,
          frame_time_p50_ms: sample.frameTimeP50Ms,
          frame_time_p95_ms: sample.frameTimeP95Ms,
          frame_time_p99_ms: sample.frameTimeP99Ms,
          frame_time_max_ms: sample.frameTimeMaxMs,
          long_frames_over_50_ms: sample.longFramesOver50Ms,
          long_frames_over_100_ms: sample.longFramesOver100Ms,
          rtt_mean_ms: sample.rttMeanMs,
          rtt_p95_ms: sample.rttP95Ms,
          authoritative_snapshot_age_ms: sample.authoritativeSnapshotAgeMs,
          websocket_reconnect_count: sample.websocketReconnectCount,
          websocket_send_failures: sample.websocketSendFailures,
          stale_socket_events: sample.staleSocketEvents,
          visible_flag_count: sample.visibleFlagCount,
          visible_collectible_count: sample.visibleCollectibleCount,
          visible_combat_entity_count: sample.visibleCombatEntityCount,
          retained_display_object_count: sample.retainedDisplayObjectCount,
          collectible_redraw_count: sample.collectibleRedrawCount,
          collectible_redraw_duration_ms: sample.collectibleRedrawDurationMs,
          static_overlay_redraw_count: sample.staticOverlayRedrawCount,
          static_overlay_redraw_duration_ms: sample.staticOverlayRedrawDurationMs,
          client_release_identifier: sample.clientReleaseIdentifier
        },
        sample.reason === "interval" ? `client:${input.sessionId}` : undefined
      );
      if (!queued) continue;
      accepted += 1;
      state.acceptedInWindow += 1;
      state.lastSequence = sample.sequence;
      if (sample.reason === "interval") state.lastRoutineAt = now;
      session.deviceCategory = sample.deviceCategory;
      if (sample.rttMeanMs !== null) {
        pushBounded(session.rttMeanSamples, sample.rttMeanMs);
      }
      if (sample.rttP95Ms !== null) {
        pushBounded(session.rttP95Samples, sample.rttP95Ms);
      }
      if (sample.fpsMean > 0) {
        pushBounded(session.clientFrameMeanSamples, 1_000 / sample.fpsMean);
      }
      pushBounded(session.clientFrameP95Samples, sample.frameTimeP95Ms);
    }
    this.clientRates.set(logicalSessionId, state);
    return accepted;
  }

  async submitBugReport(input: {
    accountRateKey: string;
    connectionKey: string;
    playerId: string;
    sessionId: string;
    connectionGeneration: number;
    report: BugReportSubmitMessage;
    authoritative: BugReportAuthoritativeContext;
  }): Promise<BugReportSubmissionResult> {
    if (!this.config.BUG_REPORTS_ENABLED || !this.pool || !this.isActive()) {
      return {
        success: false,
        code: "BUG_REPORTS_DISABLED",
        message: "Bug reporting is temporarily unavailable.",
        retryable: true
      };
    }
    if (this.activeBugReportSubmissions.has(input.connectionKey)) {
      return {
        success: false,
        code: "BUG_REPORT_SUBMISSION_IN_PROGRESS",
        message: "A bug report is already being submitted.",
        retryable: true,
        retryAfterMs: 1_000
      };
    }
    const logicalSessionId = this.resolveSessionId(input.sessionId);
    if (!logicalSessionId) {
      return {
        success: false,
        code: "BUG_REPORT_SESSION_INVALID",
        message: "Reconnect before retrying this bug report.",
        retryable: true
      };
    }
    this.activeBugReportSubmissions.add(input.connectionKey);
    try {
      return await this.persistBugReport({
        ...input,
        logicalSessionId
      });
    } catch (error) {
      this.noteDatabaseFailure(error, "bug report persistence failed");
      return {
        success: false,
        code: "BUG_REPORT_SAVE_FAILED",
        message: "The report could not be saved. Your text is still here; please retry.",
        retryable: true
      };
    } finally {
      this.activeBugReportSubmissions.delete(input.connectionKey);
    }
  }

  async listBugReports(limit = 50): Promise<DeveloperBugReportListItem[]> {
    if (!this.pool) throw new Error("telemetry database is unavailable");
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.trunc(limit)))
      : 50;
    const result = await this.pool.query<{
      public_report_code: string;
      submitted_at: Date | string;
      title: string;
      category: string;
      description: string;
      expected_behavior: string;
      reproducibility: string;
      status: string;
      release_generation: string | null;
      export_status: string;
    }>(
      `SELECT public_report_code, submitted_at, title, category, description,
              expected_behavior, reproducibility, status, release_generation,
              export_status
         FROM telemetry.bug_reports
        ORDER BY submitted_at DESC
        LIMIT $1`,
      [boundedLimit]
    );
    return result.rows.map((row) => ({
      reportCode: row.public_report_code,
      submittedAt: formatBugReportTimestamp(row.submitted_at),
      title: row.title,
      category: row.category,
      description: row.description,
      expectedBehavior: row.expected_behavior,
      reproducibility: row.reproducibility,
      status: row.status,
      releaseGeneration: row.release_generation,
      exportStatus: row.export_status
    }));
  }

  resolveSessionId(sessionIdOrKey: string | null): string | null {
    if (!sessionIdOrKey) return null;
    if (this.knownLogicalSessionIds.has(sessionIdOrKey)) return sessionIdOrKey;
    return this.logicalSessionIdByKey.get(sessionIdOrKey) ?? null;
  }

  recordPlayerSnapshot(input: PlayerSnapshotInput): string | null {
    if (!this.acceptsFinalSnapshot(input.snapshotReason)) return null;
    const snapshotId = crypto.randomUUID();
    return this.enqueue(
      "player_snapshots",
      `player_snapshot:${input.snapshotReason}`,
      input.snapshotReason === "interval" ? "routine" : "important",
      {
        ...this.baseRecord(),
        player_snapshot_id: snapshotId,
        recorded_at: new Date(),
        player_id: input.playerId,
        session_id: this.resolveSessionId(input.sessionId ?? null),
        snapshot_reason: input.snapshotReason,
        online_duration_seconds: input.onlineDurationSeconds,
        level: input.level ?? null,
        total_xp: input.totalXp ?? null,
        class_id: input.classId ?? null,
        subclass_id: input.subclassId ?? null,
        class_loadout: sanitizeJsonValue(input.classLoadout ?? {}),
        profession_progression: sanitizeJsonValue(input.professionProgression ?? {}),
        gold: input.gold ?? null,
        inventory_revision: input.inventoryRevision ?? null,
        inventory_snapshot_id: input.inventorySnapshotId ?? null,
        equipment_revision: input.equipmentRevision ?? null,
        equipped_items: sanitizeJsonValue(input.equippedItems ?? []),
        current_hp: input.currentHp ?? null,
        maximum_hp: input.maximumHp ?? null,
        life_state: input.lifeState ?? null,
        combat_state: input.combatState ?? null,
        personal_flag_count: input.personalFlagCount ?? null,
        city_id: input.cityId ?? null,
        city_role: input.cityRole ?? null,
        kingdom_id: input.kingdomId ?? null,
        kingdom_role: input.kingdomRole ?? null,
        manor_id: input.manorId ?? null,
        party_id: input.partyId ?? null,
        coarse_zone_id: input.coarseZoneId ?? null,
        current_flag_id: input.currentFlagId ?? null,
        cumulative_counters: sanitizeJsonValue(input.cumulativeCounters ?? {}),
        last_authoritative_activity_at: input.lastAuthoritativeActivityAt ?? null
      },
      input.snapshotReason === "interval" ? `player:${input.playerId}` : undefined
    ) ? snapshotId : null;
  }

  recordInventorySnapshot(input: InventorySnapshotInput): string | null {
    if (!this.acceptsFinalSnapshot(input.snapshotReason)) return null;
    const snapshotId = input.inventorySnapshotId ?? crypto.randomUUID();
    return this.enqueue(
      "player_inventory_snapshots",
      `inventory_snapshot:${input.snapshotReason}`,
      input.snapshotReason === "interval_changed" ? "routine" : "important",
      {
        ...this.baseRecord(),
        inventory_snapshot_id: snapshotId,
        recorded_at: new Date(),
        player_id: input.playerId,
        session_id: this.resolveSessionId(input.sessionId ?? null),
        snapshot_reason: input.snapshotReason,
        inventory_revision: input.inventoryRevision,
        items: sanitizeJsonValue(input.items),
        item_stack_count: input.itemStackCount,
        total_quantity: input.totalQuantity
      },
      input.snapshotReason === "interval_changed"
        ? `inventory:${input.playerId}:${input.inventoryRevision}`
        : undefined
    ) ? snapshotId : null;
  }

  metricsSnapshot(): ClosedTestTelemetryMetrics {
    return {
      enabled: Boolean(this.pool),
      accepting: this.accepting,
      activeRunId: this.activeRun?.runId ?? null,
      degraded: this.degraded,
      queue: this.queue.snapshot(),
      lastSuccessfulFlushAt: this.lastSuccessfulFlushAt?.toISOString() ?? null,
      rowsFlushed: this.rowsFlushed,
      writeFailures: this.writeFailures,
      lastDatabaseErrorAt: this.lastDatabaseErrorAt?.toISOString() ?? null,
      lastDatabaseError: this.lastDatabaseError,
      lastFlushDurationMs: this.lastFlushDurationMs,
      pool: this.pool?.metricsSnapshot() ?? null
    };
  }

  async flush(): Promise<void> {
    if (!this.pool || this.flushPromise || Date.now() < this.nextFlushNotBefore) return;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = null;
    });
    await this.flushPromise;
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.runRefreshTimer) clearInterval(this.runRefreshTimer);
    if (this.segmentRotationTimer) clearTimeout(this.segmentRotationTimer);
    this.flushTimer = null;
    this.runRefreshTimer = null;
    this.segmentRotationTimer = null;
    this.gcObserver?.disconnect();
    if (!this.pool) return;
    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.config.TELEMETRY_SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([
      (async () => {
        while (this.queue.depth > 0) {
          await this.flush();
          if (this.flushPromise) await this.flushPromise;
          if (Date.now() < this.nextFlushNotBefore) break;
        }
      })(),
      deadline
    ]);
    await Promise.race([this.pool.end(), deadline]).catch(() => undefined);
  }

  /** Test-only active-run injection avoids making queue tests depend on PostgreSQL. */
  setActiveRunForTest(run: ActiveTestRun | null): void {
    if (this.config.NODE_ENV !== "test") {
      throw new Error("active telemetry run injection is test-only");
    }
    this.adoptActiveRun(run);
  }

  async refreshActiveRunForTest(): Promise<void> {
    if (this.config.NODE_ENV !== "test") {
      throw new Error("active telemetry run refresh is test-only");
    }
    await this.refreshActiveRun();
  }

  async rotateActiveSegmentForTest(): Promise<void> {
    if (this.config.NODE_ENV !== "test") {
      throw new Error("telemetry segment rotation is test-only");
    }
    await this.rotateActiveSegment(this.activeRun?.runId ?? "");
  }

  private enqueue(
    table: TelemetryTable,
    eventType: string,
    priority: TelemetryPriority,
    record: Readonly<Record<string, unknown>>,
    coalesceKey?: string
  ): boolean {
    if (!this.accepting || !this.activeRun || !this.pool) return false;
    if (priority === "routine" && this.degraded) return false;
    const result = this.queue.enqueue({
      table,
      eventType,
      priority,
      record,
      ...(coalesceKey ? { coalesceKey } : {})
    });
    this.updateDegradation(null);
    if (result.accepted && this.queue.depth >= this.config.TELEMETRY_MAX_BATCH_ROWS) {
      queueMicrotask(() => void this.flush());
    }
    return result.accepted;
  }

  private async persistBugReport(input: {
    accountRateKey: string;
    connectionKey: string;
    playerId: string;
    sessionId: string;
    logicalSessionId: string;
    connectionGeneration: number;
    report: BugReportSubmitMessage;
    authoritative: BugReportAuthoritativeContext;
  }): Promise<BugReportSubmissionResult> {
    const activeRun = this.activeRun;
    const pool = this.pool;
    if (!activeRun || !pool) {
      return {
        success: false,
        code: "BUG_REPORT_NO_ACTIVE_SEGMENT",
        message: "Bug reporting is temporarily unavailable.",
        retryable: true
      };
    }
    const now = Date.now();
    if (
      input.report.reportMarkerAt > now + BUG_REPORT_CLOCK_FUTURE_TOLERANCE_MS ||
      input.report.reportMarkerAt < now - BUG_REPORT_MARKER_MAX_AGE_MS
    ) {
      return {
        success: false,
        code: "BUG_REPORT_MARKER_INVALID",
        message: "This report draft is too old. Reopen Report a Bug and try again.",
        retryable: false
      };
    }
    const markerAt = new Date(input.report.reportMarkerAt);
    const windowStartAt = new Date(
      input.report.reportMarkerAt - BUG_REPORT_HISTORY_WINDOW_MS
    );
    const availableWindowStartAt = new Date(Math.max(
      windowStartAt.getTime(),
      Math.min(input.report.availableWindowStartAt, markerAt.getTime())
    ));
    const submittedAt = new Date();
    const recentAccountReports = (this.bugReportRateByAccount.get(input.accountRateKey) ?? [])
      .filter((timestamp) => now - timestamp < BUG_REPORT_RATE_WINDOW_MS);
    const clientContext = sanitizeBugReportClientContext(input.report);
    const authoritativePlayerState = sanitizeBugReportJson(
      input.authoritative.playerState
    ) as Record<string, unknown>;
    const nearbyEntities = input.authoritative.nearbyEntities
      .slice(0, BUG_REPORT_NEARBY_ENTITY_LIMIT)
      .map((entity) => sanitizeBugReportJson(entity));
    const relatedOperationIds = uniqueBounded([
      ...input.report.diagnostics.recentClientActions.map((entry) => entry.operationId),
      ...input.report.diagnostics.networkTimeline.map((entry) => entry.operationId),
      ...input.report.clientState.pendingOperationIds
    ], 256);
    const contextPayload = {
      clientState: clientContext.clientState,
      authoritativePlayerState,
      nearbyEntities,
      recentClientActions: clientContext.recentClientActions,
      recentClientErrors: clientContext.recentClientErrors,
      networkTimeline: clientContext.networkTimeline,
      performanceHistory: clientContext.performanceHistory,
      relatedOperationIds
    };
    const serializedContext = JSON.stringify(contextPayload);
    const uncompressedBytes = Buffer.byteLength(serializedContext, "utf8");
    if (uncompressedBytes > BUG_REPORT_CONTEXT_MAX_UNCOMPRESSED_BYTES) {
      return {
        success: false,
        code: "BUG_REPORT_CONTEXT_TOO_LARGE",
        message: "The diagnostic snapshot is too large. Reopen Report a Bug and retry.",
        retryable: false
      };
    }
    const compressed = await gzipAsync(Buffer.from(serializedContext, "utf8"), {
      level: 6
    });
    if (compressed.byteLength > BUG_REPORT_CONTEXT_MAX_COMPRESSED_BYTES) {
      return {
        success: false,
        code: "BUG_REPORT_CONTEXT_TOO_LARGE",
        message: "The diagnostic snapshot is too large. Reopen Report a Bug and retry.",
        retryable: false
      };
    }
    const contentChecksum = createHash("sha256")
      .update(serializedContext)
      .digest("hex");
    const reportTitle = sanitizeBugReportText(input.report.title, 80);
    const reportDescription = sanitizeBugReportText(input.report.description, 2_000);
    const reportExpectedBehavior = sanitizeBugReportText(
      input.report.expectedBehavior,
      1_000
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`bug-report:${input.playerId}:${input.report.requestId}`]
      );
      const existing = await client.query<{
        public_report_code: string;
        submitted_at: Date | string;
        title: string;
        category: string;
        description: string;
        expected_behavior: string;
        reproducibility: string;
        release_generation: string | null;
      }>(
        `SELECT public_report_code, submitted_at, title, category, description,
                expected_behavior, reproducibility, release_generation
           FROM telemetry.bug_reports
          WHERE player_id=$1 AND request_id=$2`,
        [input.playerId, input.report.requestId]
      );
      if (existing.rowCount) {
        await client.query("COMMIT");
        return this.deliverBugReportNotification({
          reportCode: existing.rows[0]!.public_report_code,
          submittedAt: existing.rows[0]!.submitted_at,
          title: existing.rows[0]!.title,
          category: existing.rows[0]!.category,
          description: existing.rows[0]!.description,
          expectedBehavior: existing.rows[0]!.expected_behavior,
          reproducibility: existing.rows[0]!.reproducibility,
          releaseGeneration: existing.rows[0]!.release_generation
        }, true);
      }
      const runState = await client.query<{
        status: string;
        ingestion_closed_at: Date | null;
      }>(
        `SELECT status, ingestion_closed_at
           FROM telemetry.test_runs
          WHERE run_id=$1
          FOR SHARE`,
        [activeRun.runId]
      );
      if (
        runState.rows[0]?.status !== "active" ||
        runState.rows[0].ingestion_closed_at !== null
      ) {
        await client.query("ROLLBACK");
        return {
          success: false,
          code: "BUG_REPORT_SEGMENT_ROTATING",
          message: "Telemetry is rotating to a new segment. Please retry in a moment.",
          retryable: true,
          retryAfterMs: 1_000
        };
      }
      const databaseRate = await client.query<{ count: string; latest: Date | null }>(
        `SELECT count(*)::text AS count, max(submitted_at) AS latest
           FROM telemetry.bug_reports
          WHERE player_id=$1
            AND submitted_at >= clock_timestamp() - interval '10 minutes'`,
        [input.playerId]
      );
      const count = Math.max(
        recentAccountReports.length,
        Number(databaseRate.rows[0]?.count ?? 0)
      );
      if (count >= this.config.BUG_REPORTS_MAX_PER_TEN_MINUTES) {
        const latest = databaseRate.rows[0]?.latest?.getTime() ?? recentAccountReports.at(-1) ?? now;
        const retryAfterMs = Math.max(
          1_000,
          BUG_REPORT_RATE_WINDOW_MS - (now - latest)
        );
        await client.query("ROLLBACK");
        return {
          success: false,
          code: "BUG_REPORT_RATE_LIMITED",
          message: "You have submitted several reports recently. Please wait before trying again.",
          retryable: true,
          retryAfterMs
        };
      }
      const segments = await client.query<{ segment_id: string }>(
        `SELECT segment_id::text
           FROM telemetry.test_runs
          WHERE segment_id IS NOT NULL
            AND segment_start_at <= $2
            AND segment_end_at >= $1
          ORDER BY segment_start_at`,
        [windowStartAt, markerAt]
      );
      const relatedSegmentIds = uniqueBounded([
        ...segments.rows.map((row) => row.segment_id),
        activeRun.segmentId
      ], 8);
      const reportId = crypto.randomUUID();
      let reportCode: string | null = null;
      for (let attempt = 0; attempt < 8 && reportCode === null; attempt += 1) {
        const candidate = publicReportCode();
        const inserted = await client.query(
          `INSERT INTO telemetry.bug_reports (
             report_id, public_report_code, request_id,
             telemetry_schema_version, bug_report_schema_version,
             run_id, campaign_id, segment_id, related_segment_ids,
             release_sha, release_generation, world_release_id,
             population_plan_version, population_spawn_rules_version,
             balance_version, server_instance_id, player_id, session_id,
             connection_generation, report_marker_at, available_window_start_at,
             window_start_at, window_end_at, submitted_at, title, category,
             description, expected_behavior, reproducibility
           ) VALUES (
             $1,$2,$3,1,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
           )
           ON CONFLICT (public_report_code) DO NOTHING
           RETURNING public_report_code`,
          [
            reportId,
            candidate,
            input.report.requestId,
            activeRun.runId,
            activeRun.campaignId,
            activeRun.segmentId,
            relatedSegmentIds,
            activeRun.releaseSha,
            activeRun.releaseGeneration,
            activeRun.worldReleaseId,
            activeRun.populationPlanVersion,
            activeRun.populationSpawnRulesVersion,
            activeRun.balanceVersion,
            this.serverInstanceId,
            input.playerId,
            input.logicalSessionId,
            input.connectionGeneration,
            markerAt,
            availableWindowStartAt,
            windowStartAt,
            markerAt,
            submittedAt,
            reportTitle,
            input.report.category,
            reportDescription,
            reportExpectedBehavior,
            input.report.reproducibility
          ]
        );
        if (inserted.rowCount) reportCode = candidate;
      }
      if (!reportCode) throw new Error("could not allocate a public bug report code");
      await client.query(
        `INSERT INTO telemetry.bug_report_context (
           report_id, context_schema_version, client_state,
           authoritative_player_state, nearby_entities, recent_client_actions,
           recent_client_errors, network_timeline, performance_history,
           related_operation_ids, related_event_ids, uncompressed_bytes,
           compressed_bytes, content_checksum
         ) VALUES (
           $1,1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,
           $8::jsonb,$9,'{}'::uuid[],$10,$11,$12
         )`,
        [
          reportId,
          JSON.stringify(clientContext.clientState),
          JSON.stringify(authoritativePlayerState),
          JSON.stringify(nearbyEntities),
          JSON.stringify(clientContext.recentClientActions),
          JSON.stringify(clientContext.recentClientErrors),
          JSON.stringify(clientContext.networkTimeline),
          JSON.stringify(clientContext.performanceHistory),
          relatedOperationIds,
          uncompressedBytes,
          compressed.byteLength,
          contentChecksum
        ]
      );
      await client.query("COMMIT");
      recentAccountReports.push(now);
      this.bugReportRateByAccount.set(input.accountRateKey, recentAccountReports);
      return this.deliverBugReportNotification({
        reportCode,
        submittedAt,
        title: reportTitle,
        category: input.report.category,
        description: reportDescription,
        expectedBehavior: reportExpectedBehavior,
        reproducibility: input.report.reproducibility,
        releaseGeneration: activeRun.releaseGeneration
      }, false);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private isActive(): boolean {
    const run = this.activeRun;
    if (!run) return false;
    return this.accepting
      && this.closingRunId === null
      && (
        run.segmentEndAt === null
        || Date.now() < run.segmentEndAt.getTime()
      )
      && Boolean(this.pool);
  }

  private async deliverBugReportNotification(
    report: BugReportEmail,
    duplicate: boolean
  ): Promise<BugReportSubmissionResult> {
    try {
      await this.sendBugReportEmail(report);
      return {
        success: true,
        reportCode: report.reportCode,
        duplicate
      };
    } catch (error) {
      const retryable = error instanceof BugReportEmailDeliveryError
        ? error.retryable
        : true;
      this.logger.warn(
        {
          err: error,
          reportCode: report.reportCode,
          notification: "bug_report_email"
        },
        "bug report email notification failed after durable save"
      );
      return {
        success: false,
        code: "BUG_REPORT_NOTIFICATION_FAILED",
        message: retryable
          ? `Report ${report.reportCode} was saved, but its email notification could not be delivered. Retry to send it.`
          : `Report ${report.reportCode} was saved, but its email notification is unavailable.`,
        retryable
      };
    }
  }

  private acceptsFinalSnapshot(reason: string): boolean {
    return this.isActive()
      || (
        reason === "run_freeze"
        && Boolean(this.activeRun)
        && this.closingRunId === this.activeRun?.runId
        && Boolean(this.pool)
      );
  }

  private adoptActiveRun(run: ActiveTestRun | null): void {
    if (this.segmentRotationTimer) clearTimeout(this.segmentRotationTimer);
    this.segmentRotationTimer = null;
    this.activeRun = run;
    if (
      !run?.segmentEndAt
      || !this.config.TELEMETRY_SEGMENT_ROTATION_ENABLED
      || !this.accepting
    ) return;
    const delayMs = Math.max(0, run.segmentEndAt.getTime() - Date.now());
    this.segmentRotationTimer = setTimeout(() => {
      void this.rotateActiveSegment(run.runId);
    }, delayMs);
    this.segmentRotationTimer.unref?.();
  }

  private async rotateActiveSegment(expectedRunId: string): Promise<void> {
    if (this.segmentRotationPromise) {
      await this.segmentRotationPromise;
      return;
    }
    const run = this.activeRun;
    const pool = this.pool;
    if (
      !pool
      || !this.accepting
      || !run?.segmentEndAt
      || run.runId !== expectedRunId
      || !this.config.TELEMETRY_SEGMENT_ROTATION_ENABLED
    ) return;
    this.segmentRotationPromise = (async () => {
      this.closingRunId = run.runId;
      try {
        if (this.preparedRotationRunId !== run.runId) {
          await this.runFreezeHandler?.(run.runId, "segment_rotation");
          this.preparedRotationRunId = run.runId;
        }
        await this.flush();
        if (this.queue.depth > 0) {
          throw new Error("telemetry queue did not drain before segment rotation");
        }
        const nextRunId = crypto.randomUUID();
        const nextSegmentId = crypto.randomUUID();
        const result = await pool.query<{
          run_id: string;
          segment_id: string;
          campaign_id: string;
          segment_sequence: string | number;
          segment_start_at: Date;
          segment_end_at: Date;
          release_sha: string;
          release_generation: string | null;
          world_release_id: string;
          population_plan_version: string;
          population_spawn_rules_version: string;
          balance_version: string;
        }>(
          `SELECT *
           FROM telemetry.rotate_hourly_segment($1, $2, $3, $4)`,
          [run.runId, run.segmentEndAt, nextRunId, nextSegmentId]
        );
        const row = result.rows[0];
        if (!row) throw new Error("segment rotation did not return a successor");
        const nextRun: ActiveTestRun = {
          runId: row.run_id,
          segmentId: row.segment_id,
          campaignId: row.campaign_id,
          segmentSequence: Number(row.segment_sequence),
          segmentStartAt: new Date(row.segment_start_at),
          segmentEndAt: new Date(row.segment_end_at),
          releaseSha: row.release_sha,
          releaseGeneration: row.release_generation,
          worldReleaseId: row.world_release_id,
          populationPlanVersion: row.population_plan_version,
          populationSpawnRulesVersion: row.population_spawn_rules_version,
          balanceVersion: row.balance_version
        };
        this.closingRunId = null;
        this.preparedRotationRunId = null;
        this.adoptActiveRun(nextRun);
        this.resumeSessionsAfterRotation();
      } catch (error) {
        this.noteDatabaseFailure(error, "failed to rotate hourly telemetry segment");
        if (this.segmentRotationTimer) clearTimeout(this.segmentRotationTimer);
        this.segmentRotationTimer = setTimeout(() => {
          void this.rotateActiveSegment(run.runId);
        }, ACTIVE_RUN_REFRESH_MS);
        this.segmentRotationTimer.unref?.();
      }
    })();
    try {
      await this.segmentRotationPromise;
    } finally {
      this.segmentRotationPromise = null;
    }
  }

  private resumeSessionsAfterRotation(): void {
    const pending = this.pendingSegmentSessions;
    this.pendingSegmentSessions = [];
    for (const continuation of pending) {
      const logicalSessionId = crypto.randomUUID();
      this.logicalSessionIdByKey.set(continuation.sessionKey, logicalSessionId);
      this.knownLogicalSessionIds.add(logicalSessionId);
      this.sessions.set(
        continuation.sessionKey,
        emptySession(continuation.playerId, logicalSessionId)
      );
      this.recordEvent({
        eventFamily: "session",
        eventType: "segment_continuation",
        priority: "important",
        playerId: continuation.playerId,
        sessionId: continuation.sessionKey
      });
    }
  }

  private baseRecord(): BaseRecord {
    const run = this.activeRun;
    if (!run) throw new Error("telemetry row requires an active test run");
    return {
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      run_id: run.runId,
      release_sha: run.releaseSha,
      release_generation: run.releaseGeneration,
      world_release_id: run.worldReleaseId,
      population_plan_version: run.populationPlanVersion,
      population_spawn_rules_version: run.populationSpawnRulesVersion,
      balance_version: run.balanceVersion,
      server_instance_id: this.serverInstanceId
    };
  }

  private async refreshActiveRun(): Promise<void> {
    if (!this.pool) return;
    try {
      if (
        this.activeRun === null
        && this.config.TELEMETRY_SEGMENT_ROTATION_ENABLED
      ) {
        const recovery = await this.pool.query<{ activation_action: string }>(
          `SELECT activation_action
           FROM telemetry.ensure_runtime_hourly_segment(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
           )`,
          [
            crypto.randomUUID(),
            crypto.randomUUID(),
            this.config.RUNTIME_SHA,
            this.config.TELEMETRY_RELEASE_GENERATION ?? null,
            this.config.WORLD_REQUIRED_RELEASE_ID,
            this.config.TELEMETRY_POPULATION_PLAN_VERSION,
            this.config.TELEMETRY_POPULATION_SPAWN_RULES_VERSION,
            this.config.TELEMETRY_BALANCE_VERSION,
            this.serverInstanceId,
            Math.round(this.config.TELEMETRY_SEGMENT_DURATION_MS / 1_000)
          ]
        );
        if (recovery.rows[0]?.activation_action === "created") {
          this.logger.info(
            { releaseSha: this.config.RUNTIME_SHA },
            "telemetry activated a runtime-matched hourly segment"
          );
        }
      }
      const result = await this.pool.query<{
        run_id: string;
        segment_id: string | null;
        campaign_id: string | null;
        segment_sequence: string | number | null;
        segment_start_at: Date | null;
        segment_end_at: Date | null;
        segment_duration_seconds: number | null;
        release_sha: string;
        release_generation: string | null;
        world_release_id: string;
        population_plan_version: string;
        population_spawn_rules_version: string;
        balance_version: string;
      }>(
        `SELECT run_id, segment_id, campaign_id, segment_sequence,
                segment_start_at, segment_end_at, segment_duration_seconds,
                release_sha, release_generation, world_release_id,
                population_plan_version, population_spawn_rules_version, balance_version
         FROM telemetry.test_runs
         WHERE status = 'active'
         ORDER BY started_at DESC
         LIMIT 1`
      );
      let row = result.rows[0];
      if (
        row?.segment_id
        && (
          !this.config.TELEMETRY_SEGMENT_ROTATION_ENABLED
          || row.segment_duration_seconds !==
            Math.round(this.config.TELEMETRY_SEGMENT_DURATION_MS / 1_000)
        )
      ) {
        this.warnRateLimited("telemetry ignored a segment with mismatched rotation configuration", {
          runId: row.run_id,
          observedDurationSeconds: row.segment_duration_seconds,
          expectedDurationSeconds:
            Math.round(this.config.TELEMETRY_SEGMENT_DURATION_MS / 1_000),
          rotationEnabled: this.config.TELEMETRY_SEGMENT_ROTATION_ENABLED
        });
        row = undefined;
      }
      if (
        row &&
        (
          row.release_sha !== this.config.RUNTIME_SHA ||
          row.release_generation !==
            (this.config.TELEMETRY_RELEASE_GENERATION ?? null) ||
          row.world_release_id !== this.config.WORLD_REQUIRED_RELEASE_ID ||
          row.population_plan_version !==
            this.config.TELEMETRY_POPULATION_PLAN_VERSION ||
          row.population_spawn_rules_version !==
            this.config.TELEMETRY_POPULATION_SPAWN_RULES_VERSION ||
          row.balance_version !== this.config.TELEMETRY_BALANCE_VERSION
        )
      ) {
        this.warnRateLimited("telemetry ignored an active run with mismatched release identity", {
          runId: row.run_id,
          expectedReleaseSha: this.config.RUNTIME_SHA,
          observedReleaseSha: row.release_sha,
          expectedReleaseGeneration:
            this.config.TELEMETRY_RELEASE_GENERATION ?? null,
          observedReleaseGeneration: row.release_generation,
          expectedWorldReleaseId: this.config.WORLD_REQUIRED_RELEASE_ID,
          observedWorldReleaseId: row.world_release_id
        });
        row = undefined;
      }
      const nextRun: ActiveTestRun | null = row
        ? {
            runId: row.run_id,
            segmentId: row.segment_id,
            campaignId: row.campaign_id,
            segmentSequence:
              row.segment_sequence === null ? null : Number(row.segment_sequence),
            segmentStartAt:
              row.segment_start_at === null ? null : new Date(row.segment_start_at),
            segmentEndAt:
              row.segment_end_at === null ? null : new Date(row.segment_end_at),
            releaseSha: row.release_sha,
            releaseGeneration: row.release_generation,
            worldReleaseId: row.world_release_id,
            populationPlanVersion: row.population_plan_version,
            populationSpawnRulesVersion: row.population_spawn_rules_version,
            balanceVersion: row.balance_version
          }
        : null;
      const currentRun = this.activeRun;
      if (currentRun && currentRun.runId !== nextRun?.runId) {
        try {
          if (this.closingRunId !== currentRun.runId) {
            this.closingRunId = currentRun.runId;
            await this.runFreezeHandler?.(currentRun.runId, "manual_freeze");
          }
          await this.flush();
          if (this.queue.depth > 0) return;
          await this.pool.query(
            `UPDATE telemetry.test_runs
             SET ingestion_closed_at=COALESCE(ingestion_closed_at,clock_timestamp()),
                 updated_at=clock_timestamp()
             WHERE run_id=$1 AND status IN ('frozen','failed')`,
            [currentRun.runId]
          );
        } catch (error) {
          this.warnRateLimited("telemetry run-freeze snapshot failed", { err: error });
          return;
        }
        this.closingRunId = null;
        this.preparedRotationRunId = null;
      }
      this.adoptActiveRun(nextRun);
      if (nextRun && this.pendingSegmentSessions.length > 0) {
        this.resumeSessionsAfterRotation();
      }
    } catch (error) {
      this.noteDatabaseFailure(error, "failed to refresh active telemetry run");
    }
  }

  private async flushOnce(): Promise<void> {
    if (!this.pool || (this.queue.depth === 0 && !this.degraded)) return;
    const batch = this.queue.take(this.config.TELEMETRY_MAX_BATCH_ROWS);
    if (batch.length === 0 && !this.degraded) return;
    const startedAt = performance.now();
    let client: pg.PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query(
        `SET LOCAL statement_timeout = '${this.config.TELEMETRY_WRITE_TIMEOUT_MS}ms'`
      );
      const grouped = new Map<TelemetryTable, TelemetryQueueItem[]>();
      for (const item of batch) {
        const group = grouped.get(item.table) ?? [];
        group.push(item);
        grouped.set(item.table, group);
      }
      for (const table of TABLE_INSERT_ORDER) {
        const items = grouped.get(table);
        if (items) await insertTelemetryRows(client, table, items);
      }
      await this.upsertHealth(client);
      await client.query("COMMIT");
      this.rowsFlushed += batch.length;
      this.lastSuccessfulFlushAt = new Date();
      this.consecutiveWriteFailures = 0;
      this.lastFlushDurationMs = performance.now() - startedAt;
      this.updateDegradation(null);
      if (batch.length > 0) {
        this.logger.info(
          {
            runId: this.activeRun?.runId ?? null,
            acceptedRows: batch.length,
            rowsFlushed: this.rowsFlushed
          },
          "telemetry samples accepted"
        );
      }
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      this.writeFailures += 1;
      this.consecutiveWriteFailures += 1;
      this.lastFlushDurationMs = performance.now() - startedAt;
      this.noteDatabaseFailure(error, "telemetry batch write failed");
      const retryable = batch.filter(
        (item) => item.attempt + 1 < MAX_FLUSH_ATTEMPTS && item.priority !== "routine"
      );
      const dropped = batch.filter((item) => !retryable.includes(item));
      this.queue.drop(dropped);
      this.queue.requeue(retryable);
      const jitter = Math.floor(Math.random() * this.config.TELEMETRY_FLUSH_INTERVAL_MS);
      this.nextFlushNotBefore =
        Date.now() + this.config.TELEMETRY_FLUSH_INTERVAL_MS + jitter;
      this.updateDegradation(null);
    } finally {
      client?.release();
    }
  }

  private async upsertHealth(client: pg.PoolClient): Promise<void> {
    const pool = this.pool?.metricsSnapshot();
    const queue = this.queue.snapshot();
    await client.query(
      `INSERT INTO telemetry.telemetry_health (
         server_instance_id, telemetry_schema_version, run_id, release_sha,
         release_generation, world_release_id, population_plan_version,
         population_spawn_rules_version, balance_version, recorded_at, enabled,
         degraded, queue_depth_critical, queue_depth_important, queue_depth_routine,
         last_successful_flush_at, rows_flushed, rows_dropped,
         rows_dropped_by_event_type, last_database_error_at, last_database_error,
         telemetry_pool_total,
         telemetry_pool_idle, telemetry_pool_waiting, consecutive_write_failures
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,now(),true,$10,$11,$12,$13,$14,$15,$16,
         $17,$18,$19,$20,$21,$22,$23
       )
       ON CONFLICT (server_instance_id) DO UPDATE SET
         run_id=EXCLUDED.run_id, release_sha=EXCLUDED.release_sha,
         release_generation=EXCLUDED.release_generation,
         world_release_id=EXCLUDED.world_release_id,
         population_plan_version=EXCLUDED.population_plan_version,
         population_spawn_rules_version=EXCLUDED.population_spawn_rules_version,
         balance_version=EXCLUDED.balance_version, recorded_at=EXCLUDED.recorded_at,
         enabled=EXCLUDED.enabled, degraded=EXCLUDED.degraded,
         queue_depth_critical=EXCLUDED.queue_depth_critical,
         queue_depth_important=EXCLUDED.queue_depth_important,
         queue_depth_routine=EXCLUDED.queue_depth_routine,
         last_successful_flush_at=EXCLUDED.last_successful_flush_at,
         rows_flushed=EXCLUDED.rows_flushed, rows_dropped=EXCLUDED.rows_dropped,
         rows_dropped_by_event_type=EXCLUDED.rows_dropped_by_event_type,
         last_database_error_at=EXCLUDED.last_database_error_at,
         last_database_error=EXCLUDED.last_database_error,
         telemetry_pool_total=EXCLUDED.telemetry_pool_total,
         telemetry_pool_idle=EXCLUDED.telemetry_pool_idle,
         telemetry_pool_waiting=EXCLUDED.telemetry_pool_waiting,
         consecutive_write_failures=EXCLUDED.consecutive_write_failures`,
      [
        this.serverInstanceId,
        TELEMETRY_SCHEMA_VERSION,
        this.activeRun?.runId ?? null,
        this.activeRun?.releaseSha ?? this.config.RUNTIME_SHA!,
        this.activeRun?.releaseGeneration ?? this.config.TELEMETRY_RELEASE_GENERATION ?? null,
        this.activeRun?.worldReleaseId ?? this.config.WORLD_REQUIRED_RELEASE_ID,
        this.activeRun?.populationPlanVersion ?? this.config.TELEMETRY_POPULATION_PLAN_VERSION,
        this.activeRun?.populationSpawnRulesVersion ??
          this.config.TELEMETRY_POPULATION_SPAWN_RULES_VERSION,
        this.activeRun?.balanceVersion ?? this.config.TELEMETRY_BALANCE_VERSION,
        this.degraded,
        queue.depthByPriority.critical,
        queue.depthByPriority.important,
        queue.depthByPriority.routine,
        this.lastSuccessfulFlushAt,
        this.rowsFlushed,
        queue.droppedByPriority,
        queue.droppedByEventType,
        this.lastDatabaseErrorAt,
        this.lastDatabaseError,
        pool?.connections.total ?? 0,
        pool?.connections.idle ?? 0,
        pool?.connections.waiting ?? 0,
        this.consecutiveWriteFailures
      ]
    );
  }

  private updateDegradation(
    eventLoopP99Ms: number | null,
    gameplayPostgresUnderPressure = false
  ): void {
    const queuePercent = this.queue.depth * 100 / this.queue.maximumRows;
    const telemetryPoolWaiting =
      this.pool?.metricsSnapshot().connections.waiting ?? 0;
    const unhealthy =
      this.consecutiveWriteFailures >= 3 ||
      queuePercent >= this.config.TELEMETRY_DEGRADE_QUEUE_PERCENT ||
      gameplayPostgresUnderPressure ||
      telemetryPoolWaiting > 0 ||
      (
        eventLoopP99Ms !== null &&
        eventLoopP99Ms >= this.config.TELEMETRY_DEGRADE_EVENT_LOOP_P99_MS
      );
    if (unhealthy) {
      this.healthyIntervals = 0;
      if (!this.degraded) {
        this.degraded = true;
        this.warnRateLimited("telemetry entered degraded mode", {
          queuePercent,
          consecutiveWriteFailures: this.consecutiveWriteFailures,
          gameplayPostgresUnderPressure,
          telemetryPoolWaiting,
          eventLoopP99Ms
        });
      }
      return;
    }
    if (!this.degraded) return;
    this.healthyIntervals += 1;
    if (this.healthyIntervals >= this.config.TELEMETRY_RECOVERY_HEALTHY_INTERVALS) {
      this.degraded = false;
      this.healthyIntervals = 0;
      this.logger.info({ telemetry: this.metricsSnapshot() }, "telemetry recovered from degraded mode");
    }
  }

  private noteDatabaseFailure(error: unknown, message: string): void {
    this.lastDatabaseErrorAt = new Date();
    this.lastDatabaseError =
      (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    this.warnRateLimited(message, { err: error, telemetry: this.metricsSnapshot() });
  }

  private warnRateLimited(message: string, fields: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.lastWarningAt < WARNING_RATE_LIMIT_MS) return;
    this.lastWarningAt = now;
    this.logger.warn(fields, message);
  }

  private consumeTickHistogram(): {
    count: number;
    mean: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
    over25: number;
    over50: number;
    over100: number;
  } {
    const values = this.tickDurationsMs.splice(0);
    this.tickWriteIndex = 0;
    if (values.length === 0) {
      return {
        count: 0, mean: null, p50: null, p95: null, p99: null, max: null,
        over25: 0, over50: 0, over100: 0
      };
    }
    const sorted = [...values].sort((left, right) => left - right);
    return {
      count: values.length,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.at(-1) ?? null,
      over25: values.filter((value) => value > 25).length,
      over50: values.filter((value) => value > 50).length,
      over100: values.filter((value) => value > 100).length
    };
  }

  private consumeGarbageCollectionMetrics(): {
    countByType: Record<string, number>;
    pauseMsByType: Record<string, number>;
  } {
    const countByType = { ...this.gcCountByType };
    const pauseMsByType = { ...this.gcPauseMsByType };
    for (const key of Object.keys(this.gcCountByType)) delete this.gcCountByType[key];
    for (const key of Object.keys(this.gcPauseMsByType)) delete this.gcPauseMsByType[key];
    return { countByType, pauseMsByType };
  }

  private createGcObserver(): PerformanceObserver | null {
    if (!this.config.TELEMETRY_ENABLED) return null;
    try {
      return new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const detail = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail;
          const kind = String(detail?.kind ?? "unknown");
          this.gcCountByType[kind] = (this.gcCountByType[kind] ?? 0) + 1;
          this.gcPauseMsByType[kind] = (this.gcPauseMsByType[kind] ?? 0) + entry.duration;
        }
      });
    } catch {
      return null;
    }
  }

  private accumulateSessionEvent(input: TelemetryEventInput): void {
    const session = this.sessions.get(input.sessionId!);
    if (!session) return;
    session.majorFeatures.add(input.eventFamily);
    session.distanceTraveledM += input.distanceM ?? 0;
    if (input.gameplayZoneId && session.locationsVisited.size < 256) {
      session.locationsVisited.add(input.gameplayZoneId);
    }
    if (input.sourceType) {
      incrementBoundedRecord(session.entitiesEncountered, input.sourceType);
    }
    if (input.eventType === "encounter_start") {
      if (input.metadata?.pvp === true) session.pvpEncounters += 1;
      else session.pveEncounters += 1;
    }
    if (input.eventFamily === "combat" && input.metadata?.pvp === true) {
      const counterpartId =
        input.targetId === session.playerId
          ? input.otherActorId
          : input.targetId;
      if (
        counterpartId &&
        counterpartId !== session.playerId &&
        session.pvpEncounterIds.size < 256 &&
        !session.pvpEncounterIds.has(counterpartId)
      ) {
        session.pvpEncounterIds.add(counterpartId);
        session.pvpEncounters += 1;
        session.entitiesEncountered.player =
          session.pvpEncounterIds.size;
      }
    }
    if (input.eventType === "kill") session.kills += 1;
    if (input.eventType === "death") session.deaths += 1;
    if (input.eventType === "damage_applied") {
      session.damageDealt += numericMetadata(input.metadata, "damage");
    }
    if (input.eventType === "damage_received") {
      session.damageTaken += numericMetadata(input.metadata, "damage");
    }
    if (input.eventType === "combat_summary") {
      session.kills += numericMetadata(input.metadata, "enemiesDefeated");
      session.deaths += input.metadata?.playerSurvived === false ? 1 : 0;
      session.damageDealt += numericMetadata(input.metadata, "damageDealt");
      session.damageTaken += numericMetadata(input.metadata, "damageReceived");
      session.pveEncounters += 1;
      const archetypes = input.metadata?.enemyArchetypeCounts;
      if (archetypes && !Array.isArray(archetypes) && typeof archetypes === "object") {
        for (const [archetype, count] of Object.entries(archetypes)) {
          if (typeof count === "number" && Number.isFinite(count) && count > 0) {
            incrementBoundedRecord(session.entitiesEncountered, archetype, count);
          }
        }
      }
    }
    if (
      input.eventFamily === "harvest"
      && input.eventType === "harvest_completed"
      && input.itemOrCurrencyId
      && (input.quantityDelta ?? 0) > 0
    ) {
      incrementBoundedRecord(
        session.itemsGathered,
        input.itemOrCurrencyId,
        input.quantityDelta!
      );
    }
    if (input.itemOrCurrencyId === "gold" && input.quantityDelta) {
      if (input.quantityDelta > 0) session.goldEarned += input.quantityDelta;
      else session.goldSpent += Math.abs(input.quantityDelta);
    }
    if (input.itemOrCurrencyId === "xp" && (input.quantityDelta ?? 0) > 0) {
      session.xpEarned += input.quantityDelta!;
    }
    if (input.eventFamily === "economy") {
      incrementBoundedRecord(session.marketActivity, input.eventType);
    }
    if (input.eventFamily === "settlement") {
      incrementBoundedRecord(session.settlementActivity, input.eventType);
    }
    if (input.eventFamily === "social") {
      incrementBoundedRecord(session.socialActivity, input.eventType);
    }
    if (input.eventType === "transition_failed") session.transitionFailures += 1;
    if (input.eventType === "transition_forced_release") {
      session.transitionForcedReleases += 1;
    }
    if (input.rejectionCode && input.eventFamily === "harvest") {
      incrementRecord(session.harvestRejections, input.rejectionCode);
    }
    if (input.rejectionCode && input.eventFamily === "combat") {
      incrementRecord(session.attackRejections, input.rejectionCode);
    }
    if (input.appliedState === "failed") session.errorCount += 1;
  }

  private enqueueSessionSummary(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.clientRates.delete(session.sessionId);
    const endedAt = new Date();
    this.enqueue(
      "session_summaries",
      "session_summary",
      "important",
      {
        ...this.baseRecord(),
        session_summary_id: crypto.randomUUID(),
        recorded_at: endedAt,
        player_id: session.playerId,
        session_id: session.sessionId,
        session_started_at: session.startedAt,
        session_ended_at: endedAt,
        duration_seconds: Math.max(
          0,
          Math.floor((endedAt.getTime() - session.startedAt.getTime()) / 1_000)
        ),
        device_category: session.deviceCategory,
        reconnect_count: session.reconnectCount,
        disconnect_count: session.disconnectCount,
        rtt_mean_ms: mean(session.rttMeanSamples),
        rtt_p95_ms: percentile([...session.rttP95Samples].sort((a, b) => a - b), 0.95),
        client_frame_time_mean_ms: mean(session.clientFrameMeanSamples),
        client_frame_time_p95_ms:
          percentile([...session.clientFrameP95Samples].sort((a, b) => a - b), 0.95),
        distance_traveled_m: session.distanceTraveledM,
        locations_visited: { coarseZoneIds: [...session.locationsVisited].sort() },
        entities_encountered: session.entitiesEncountered,
        pve_encounters: session.pveEncounters,
        pvp_encounters: session.pvpEncounters,
        kills: session.kills,
        deaths: session.deaths,
        damage_dealt: session.damageDealt,
        damage_taken: session.damageTaken,
        items_gathered: session.itemsGathered,
        gold_earned: session.goldEarned,
        gold_spent: session.goldSpent,
        xp_earned: session.xpEarned,
        profession_xp_earned: session.professionXpEarned,
        market_activity: session.marketActivity,
        settlement_activity: session.settlementActivity,
        social_activity: session.socialActivity,
        harvest_rejections: session.harvestRejections,
        attack_rejections: session.attackRejections,
        transition_failures: session.transitionFailures,
        transition_forced_releases: session.transitionForcedReleases,
        major_features_used: [...session.majorFeatures].sort(),
        error_count: session.errorCount
      }
    );
  }
}

const TABLE_COLUMNS: Readonly<Record<TelemetryTable, readonly string[]>> = {
  server_samples: [
    "telemetry_schema_version", "run_id", "release_sha", "release_generation",
    "world_release_id", "population_plan_version", "population_spawn_rules_version",
    "balance_version", "server_instance_id", "recorded_at", "sample_source",
    "active_players", "link_dead_players", "active_websocket_connections",
    "connections_by_state", "process_cpu_user_ms", "process_cpu_system_ms",
    "host_cpu_percent", "host_load_1m", "host_load_5m", "host_load_15m",
    "process_pid", "process_cpu_percent", "process_rss_bytes", "node_heap_used_bytes",
    "node_heap_total_bytes", "node_external_memory_bytes", "host_available_memory_bytes",
    "swap_used_bytes", "event_loop_delay_mean_ms", "event_loop_delay_p50_ms",
    "event_loop_delay_p95_ms", "event_loop_delay_p99_ms", "event_loop_delay_max_ms",
    "gc_counts_by_type", "gc_pause_ms_by_type", "current_server_tick", "tick_count",
    "tick_mean_ms", "tick_p50_ms", "tick_p95_ms", "tick_p99_ms", "tick_max_ms",
    "ticks_over_25_ms", "ticks_over_50_ms", "ticks_over_100_ms",
    "world_command_queue_depth", "world_command_queue_max_depth", "commands_accepted",
    "commands_processed", "commands_rejected", "commands_duplicate", "commands_stale",
    "commands_overflowed", "world_deltas_sent", "combat_deltas_sent",
    "websocket_messages_sent", "websocket_bytes_sent", "websocket_messages_received",
    "websocket_bytes_received", "websocket_messages_by_family",
    "replaceable_messages_skipped", "replaceable_messages_coalesced",
    "backpressure_closures", "gameplay_pool_total", "gameplay_pool_idle",
    "gameplay_pool_active", "gameplay_pool_waiting", "gameplay_query_timing",
    "gameplay_database_errors", "gameplay_database_lock_waits",
    "population_preparation_queue_depth", "population_preparation_timing",
    "resource_vision_queue_depth", "resource_vision_timing", "telemetry_queue_depth",
    "telemetry_rows_flushed", "telemetry_rows_dropped_by_priority",
    "telemetry_flush_duration_ms", "telemetry_write_failures", "disk_free_bytes",
    "disk_read_bytes", "disk_write_bytes", "host_network_receive_bytes",
    "host_network_transmit_bytes", "service_uptime_seconds", "restart_boot_identifier"
  ],
  world_samples: [
    "telemetry_schema_version", "run_id", "release_sha", "release_generation",
    "world_release_id", "population_plan_version", "population_spawn_rules_version",
    "balance_version", "server_instance_id", "recorded_at", "scope_type", "scope_id",
    "entity_category", "planned_count", "persisted_count", "ready_alive_count",
    "dead_harvested_count", "respawn_pending_count", "suppressed_count",
    "active_runtime_count", "sleeping_count", "visible_count",
    "reconciliation_source", "metadata"
  ],
  gameplay_events: [
    "event_id", "telemetry_schema_version", "run_id", "release_sha",
    "release_generation", "world_release_id", "population_plan_version",
    "population_spawn_rules_version", "balance_version", "server_instance_id",
    "event_time", "event_family", "event_type", "event_schema_version", "priority",
    "player_id", "other_actor_id", "target_id", "session_id", "operation_id",
    "connection_generation", "gameplay_zone_id", "source_type", "source_entity_id",
    "item_or_currency_id", "item_variant", "quantity_before", "quantity_delta",
    "quantity_after", "applied_state", "rejection_code", "duration_ms", "distance_m",
    "metadata"
  ],
  player_snapshots: [
    "player_snapshot_id", "telemetry_schema_version", "run_id", "release_sha",
    "release_generation", "world_release_id", "population_plan_version",
    "population_spawn_rules_version", "balance_version", "server_instance_id",
    "recorded_at", "player_id", "session_id", "snapshot_reason",
    "online_duration_seconds", "level", "total_xp", "class_id", "subclass_id",
    "class_loadout", "profession_progression", "gold", "inventory_revision",
    "inventory_snapshot_id", "equipment_revision", "equipped_items", "current_hp",
    "maximum_hp", "life_state", "combat_state", "personal_flag_count", "city_id",
    "city_role", "kingdom_id", "kingdom_role", "manor_id", "party_id",
    "coarse_zone_id", "current_flag_id", "cumulative_counters",
    "last_authoritative_activity_at"
  ],
  player_inventory_snapshots: [
    "inventory_snapshot_id", "telemetry_schema_version", "run_id", "release_sha",
    "release_generation", "world_release_id", "population_plan_version",
    "population_spawn_rules_version", "balance_version", "server_instance_id",
    "recorded_at", "player_id", "session_id", "snapshot_reason",
    "inventory_revision", "items", "item_stack_count", "total_quantity"
  ],
  client_samples: [
    "telemetry_schema_version", "run_id", "release_sha", "release_generation",
    "world_release_id", "population_plan_version", "population_spawn_rules_version",
    "balance_version", "server_instance_id", "recorded_at", "player_id", "session_id",
    "connection_generation", "client_sequence", "sample_reason", "device_category",
    "operating_system_family", "browser_family", "browser_major_version",
    "installed_pwa", "foreground_state", "viewport_width", "viewport_height",
    "screen_size_class", "fps_mean", "frame_time_p50_ms", "frame_time_p95_ms",
    "frame_time_p99_ms", "frame_time_max_ms", "long_frames_over_50_ms",
    "long_frames_over_100_ms", "rtt_mean_ms", "rtt_p95_ms",
    "authoritative_snapshot_age_ms", "websocket_reconnect_count",
    "websocket_send_failures", "stale_socket_events", "visible_flag_count",
    "visible_collectible_count", "visible_combat_entity_count",
    "retained_display_object_count", "collectible_redraw_count",
    "collectible_redraw_duration_ms", "static_overlay_redraw_count",
    "static_overlay_redraw_duration_ms", "client_release_identifier"
  ],
  session_summaries: [
    "session_summary_id", "telemetry_schema_version", "run_id", "release_sha",
    "release_generation", "world_release_id", "population_plan_version",
    "population_spawn_rules_version", "balance_version", "server_instance_id",
    "recorded_at", "player_id", "session_id", "session_started_at",
    "session_ended_at", "duration_seconds", "device_category", "reconnect_count",
    "disconnect_count", "rtt_mean_ms", "rtt_p95_ms", "client_frame_time_mean_ms",
    "client_frame_time_p95_ms", "distance_traveled_m", "locations_visited",
    "entities_encountered", "pve_encounters", "pvp_encounters", "kills", "deaths",
    "damage_dealt", "damage_taken", "items_gathered", "gold_earned", "gold_spent",
    "xp_earned", "profession_xp_earned", "market_activity", "settlement_activity",
    "social_activity", "harvest_rejections", "attack_rejections",
    "transition_failures", "transition_forced_releases", "major_features_used",
    "error_count"
  ]
};

const JSON_COLUMNS: Readonly<Record<TelemetryTable, ReadonlySet<string>>> = {
  server_samples: new Set([
    "connections_by_state",
    "gc_counts_by_type",
    "gc_pause_ms_by_type",
    "websocket_messages_by_family",
    "gameplay_query_timing",
    "population_preparation_timing",
    "resource_vision_timing",
    "telemetry_rows_dropped_by_priority"
  ]),
  world_samples: new Set(["metadata"]),
  gameplay_events: new Set(["metadata"]),
  player_snapshots: new Set([
    "class_loadout",
    "profession_progression",
    "equipped_items",
    "cumulative_counters"
  ]),
  player_inventory_snapshots: new Set(["items"]),
  client_samples: new Set(["websocket_send_failures"]),
  session_summaries: new Set([
    "locations_visited",
    "entities_encountered",
    "items_gathered",
    "profession_xp_earned",
    "market_activity",
    "settlement_activity",
    "social_activity",
    "harvest_rejections",
    "attack_rejections"
  ])
};

const TABLE_INSERT_ORDER: readonly TelemetryTable[] = [
  "server_samples",
  "world_samples",
  "gameplay_events",
  "player_inventory_snapshots",
  "player_snapshots",
  "client_samples",
  "session_summaries"
];

async function insertTelemetryRows(
  client: pg.PoolClient,
  table: TelemetryTable,
  items: readonly TelemetryQueueItem[]
): Promise<void> {
  const columns = TABLE_COLUMNS[table];
  const values: unknown[] = [];
  const rows = items.map((item) => {
    const offset = values.length;
    for (const column of columns) {
      const value = item.record[column] ?? null;
      values.push(
        value !== null && JSON_COLUMNS[table].has(column)
          ? JSON.stringify(value)
          : value
      );
    }
    return `(${columns.map((_column, index) => `$${offset + index + 1}`).join(",")})`;
  });
  await client.query(
    `INSERT INTO telemetry.${table} (${columns.join(",")}) VALUES ${rows.join(",")}`,
    values
  );
}

function percentile(sorted: readonly number[], rank: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * rank) - 1))
  ] ?? null;
}

function emptySession(playerId: string, sessionId: string): SessionAccumulator {
  return {
    playerId,
    sessionId,
    startedAt: new Date(),
    deviceCategory: null,
    reconnectCount: 0,
    disconnectCount: 0,
    distanceTraveledM: 0,
    pveEncounters: 0,
    pvpEncounters: 0,
    pvpEncounterIds: new Set(),
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
    transitionFailures: 0,
    transitionForcedReleases: 0,
    errorCount: 0,
    rttMeanSamples: [],
    rttP95Samples: [],
    clientFrameMeanSamples: [],
    clientFrameP95Samples: [],
    locationsVisited: new Set(),
    entitiesEncountered: {},
    itemsGathered: {},
    goldEarned: 0,
    goldSpent: 0,
    xpEarned: 0,
    professionXpEarned: {},
    marketActivity: {},
    settlementActivity: {},
    socialActivity: {},
    harvestRejections: {},
    attackRejections: {},
    majorFeatures: new Set()
  };
}

function numericMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string
): number {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function incrementRecord(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function incrementBoundedRecord(
  record: Record<string, number>,
  key: string,
  amount = 1
): void {
  if (!(key in record) && Object.keys(record).length >= 64) return;
  record[key] = (record[key] ?? 0) + amount;
}

function pushBounded(values: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  if (values.length >= 256) values.shift();
  values.push(value);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

const FORBIDDEN_METADATA_KEY =
  /(?:body|message_text|chat_text|direct_message|email|google|oauth|token|cookie|csrf|credential|authorization|header|raw_ip|search_text|account_?id|player_?id|session_?id|username|display_?name)/i;
const FORBIDDEN_BUG_REPORT_KEY =
  /(?:chat|direct_?message|dm_?content|google|oauth|access_?token|refresh_?token|cookie|password|credential|authorization|auth_?header|raw_?ip|user_?agent|local_?storage|session_?storage|device_?gps|geolocation)/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s]+/giu;
const SECRET_PATTERN =
  /\b(?:bearer\s+|token[=:]\s*|password[=:]\s*|secret[=:]\s*)[A-Za-z0-9._~+/=-]{8,}/giu;

function sanitizeJsonValue(value: unknown): unknown {
  return sanitizeValue(value, 0) ?? null;
}

function sanitizeMetadata(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sanitized = sanitizeValue(value, 0);
  if (!sanitized || Array.isArray(sanitized) || typeof sanitized !== "object") return {};
  const record = sanitized as Record<string, unknown>;
  try {
    if (Buffer.byteLength(JSON.stringify(record), "utf8") <= 16_000) return record;
  } catch {
    return {};
  }
  return { telemetryMetadataDropped: "oversize" };
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 5 || value === null) return value === null ? null : undefined;
  if (typeof value === "string") return value.slice(0, 1_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 64).flatMap((entry) => {
      const sanitized = sanitizeValue(entry, depth + 1);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
    if (FORBIDDEN_METADATA_KEY.test(key)) continue;
    const sanitized = sanitizeValue(entry, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function sanitizeBugReportClientContext(report: BugReportSubmitMessage): {
  clientState: Record<string, unknown>;
  recentClientActions: unknown[];
  recentClientErrors: unknown[];
  networkTimeline: unknown[];
  performanceHistory: unknown[];
} {
  return {
    clientState: sanitizeBugReportJson(report.clientState) as Record<string, unknown>,
    recentClientActions: report.diagnostics.recentClientActions.map((entry) => ({
      ...entry,
      targetId: entry.targetId ? sanitizeBugReportText(entry.targetId, 160) : null,
      rejectionCode: entry.rejectionCode
        ? sanitizeBugReportText(entry.rejectionCode, 120)
        : null
    })),
    recentClientErrors: report.diagnostics.recentClientErrors.map((entry) => ({
      ...entry,
      name: sanitizeBugReportText(entry.name, 120),
      message: sanitizeBugReportText(entry.message, 320),
      component: entry.component
        ? sanitizeBugReportText(entry.component, 120)
        : null
    })),
    networkTimeline: report.diagnostics.networkTimeline.map((entry) => ({ ...entry })),
    performanceHistory: report.diagnostics.performanceHistory.map((entry) => ({
      timestamp: entry.timestamp,
      sample: {
        ...entry.sample,
        clientReleaseIdentifier: sanitizeBugReportText(
          entry.sample.clientReleaseIdentifier,
          160
        )
      }
    }))
  };
}

function sanitizeBugReportText(value: string, maximumLength: number): string {
  return stripUnsafeControlCharacters(value
    .replace(EMAIL_PATTERN, "[redacted email]")
    .replace(URL_PATTERN, "[redacted URL]")
    .replace(SECRET_PATTERN, "[redacted secret]"))
    .slice(0, maximumLength);
}

function stripUnsafeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
      ? ""
      : character;
  }).join("");
}

function sanitizeBugReportJson(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null) return value === null ? null : undefined;
  if (typeof value === "string") return sanitizeBugReportText(value, 1_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 256).flatMap((entry) => {
      const sanitized = sanitizeBugReportJson(entry, depth + 1);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 128)) {
    if (FORBIDDEN_BUG_REPORT_KEY.test(key)) continue;
    const sanitized = sanitizeBugReportJson(entry, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function uniqueBounded(
  values: readonly (string | null | undefined)[],
  maximum: number
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value.slice(0, 160));
    if (result.length >= maximum) break;
  }
  return result;
}

function publicReportCode(): string {
  const bytes = randomBytes(6);
  let suffix = "";
  for (const byte of bytes) {
    suffix += PUBLIC_REPORT_ALPHABET[byte % PUBLIC_REPORT_ALPHABET.length]!;
  }
  return `AA-${suffix}`;
}

function formatBugReportTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

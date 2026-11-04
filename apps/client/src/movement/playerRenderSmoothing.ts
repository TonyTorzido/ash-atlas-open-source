import type { LatLon, MoveSpeedSegment, PlayerDeltaUpsert, PlayerSnapshot } from "@ash-atlas/shared";
import {
  distanceMeters,
  interpolateLatLon,
  isFiniteLatLon,
  moveToward,
  speedMultiplierAtDistance
} from "@ash-atlas/shared";

import { perfMetrics } from "../perf/perfMetrics.js";
import {
  noteMotionAuthority,
  noteMotionClockBehind,
  noteMotionCorrection,
  noteMotionLeadLimit,
  noteMotionPrediction,
  noteMotionSnap
} from "../perf/motionReport.js";
import {
  movementTraceEnabled,
  recordMovementTrace,
  type MovementTraceOutcome
} from "./movementDebugTrace.js";

export type RenderedPlayerPosition = LatLon & {
  anchorLat: number;
  anchorLon: number;
};

export const PLAYER_INTERPOLATION_DELAY_MS = 150;
export const PLAYER_PLAYBACK_CATCH_UP_RATE = 1.25;
const PLAYER_AUTHORITY_INTERVAL_MS = 50;
const MAX_REMOTE_PLAYBACK_FRAME_DELTA_MS = 150;
const LOCAL_PREDICTION_LEAD_TICKS = 4;
const LOCAL_PREDICTION_MIN_LEAD_MS = 250;
const LOCAL_PREDICTION_MAX_LEAD_MS = 600;
/**
 * Soft lead limit (docs/plans/move-smooth.md): past maxLead + one tick the prediction is eased back toward the
 * dead-reckoned authority as a decaying presentation error (time constant LOCAL_LEAD_RELAX_MS), never faster than this
 * fraction of the walking speed, so a per-frame step stays even and never goes backward. Only past
 * LOCAL_LEAD_HARD_FACTOR x maxLead (a real desync) is the position clamped.
 */
const LOCAL_LEAD_PULL_MAX_FRACTION = 0.15;
const LOCAL_LEAD_RELAX_MS = 400;
const LOCAL_LEAD_HARD_FACTOR = 2;
/** Round-trip smoothing: each PONG moves the estimate this fraction of the way. */
const LOCAL_LATENCY_SMOOTHING = 0.2;
/** Authority sample age by server time is trusted only inside this window (else receipt time is used). */
const LOCAL_AUTHORITY_AGE_MIN_MS = -50;
const LOCAL_AUTHORITY_AGE_MAX_MS = 1_000;
/** The server-to-client clock offset may creep up this much per client ms (clock drift); fast packets pull it back. */
const SERVER_OFFSET_DRIFT_PER_MS = 0.000_5;
/** A movement request after this long without a rendered frame restarts the prediction clock (nothing was moving). */
const LOCAL_IDLE_CLOCK_RESET_MS = 100;
const LOCAL_AUTHORITY_DEAD_RECKON_MAX_MS = 300;
/** Dead-reckoning limit while the authority walks to the same target as the local intent (bounded by that target). */
const LOCAL_AUTHORITY_SHARED_TARGET_DEAD_RECKON_MAX_MS = 1_000;
export const LOCAL_PENDING_REQUEST_TIMEOUT_MS = 1_500;
const LOCAL_CORRECTION_MIN_MS = 80;
const LOCAL_CORRECTION_MAX_MS = 150;
const LOCAL_RENDER_TRACE_INTERVAL_MS = 100;

type AuthoritativePlayerSample = RenderedPlayerPosition & {
  regionCode: string;
  zoneId: string;
  serverTimeMs: number;
  playbackTimeMs: number;
  movementRevision: number;
  relocationRevision: number;
  replicationSequence: number | null;
  moving: boolean;
  targetLat: number | null;
  targetLon: number | null;
};

type PlayerSampleTrack = {
  samples: AuthoritativePlayerSample[];
  playbackServerTimeMs: number | null;
  lastPlaybackClientTimeMs: number | null;
};

type LocalPlayerTuning = {
  speedMps: number;
  serverTickHz: number;
};

type LocalMovementIntent = {
  requestId: string | null;
  movementGeneration: number | null;
  target: LatLon;
  acceptedRevision: number | null;
  startedAtMs: number | null;
  /** Water travel: the server's speed breakpoints for this leg (MOVE_ACCEPTED). */
  speedProfile?: LocalSpeedProfile | null;
};

export type LocalSpeedProfile = Readonly<{
  origin: LatLon;
  segments: readonly MoveSpeedSegment[];
}>;

type LocalCorrection = {
  from: RenderedPlayerPosition;
  to: RenderedPlayerPosition;
  startedAtMs: number;
  durationMs: number;
};

type ReplicationContext = {
  sequence?: number | null;
  reason?: string | null;
  /** Real packet receipt time (performance.now() when the frame arrived); feeds the server clock offset estimate. */
  receivedAtMs?: number | null;
};

type SampleApplyResult = "ignored" | "appended" | "replaced" | "snapped";

type LocalTraceInput = {
  clientTimeMs: number;
  messageType: string;
  outcome: MovementTraceOutcome;
  requestId?: string | null;
  movementGeneration?: number | null;
  sample?: AuthoritativePlayerSample | null;
  renderedBefore?: RenderedPlayerPosition | null;
  renderedAfter?: RenderedPlayerPosition | null;
  renderDiagnostics?: LocalRenderDiagnostics | null;
  reason?: string | null;
};

type LocalRenderDiagnostics = {
  rawFrameMs: number;
  consumedFrameMs: number;
  discardedFrameMs: number;
  predictionLeadM: number;
  authorityAgeMs: number | null;
  leadCapHeld: boolean;
};

export class PlayerRenderTimeline {
  private readonly tracks = new Map<string, PlayerSampleTrack>();
  private serverToClientOffsetMs: number | null = null;
  private serverOffsetObservedAtMs: number | null = null;
  private latestAcceptedServerTimeMs = Number.NEGATIVE_INFINITY;
  private localPlayerId: string | null = null;
  private localPlayerTuning: LocalPlayerTuning | null = null;
  /**
   * Effective walking speed the server tick applies on land (MOVE_ACCEPTED / own movement upserts): base speed x the
   * server's movement multiplier (armour, shield, class, kingdom, slows). Null until the server sends it (older servers
   * never do), and prediction then walks at the base speed.
   */
  private localEffectiveSpeedMps: number | null = null;
  private localAuthority: AuthoritativePlayerSample | null = null;
  private localAuthorityReceivedAtMs: number | null = null;
  private latencyEstimateMs = 0;
  private latencyEstimateSamples = 0;
  private localRenderedPosition: RenderedPlayerPosition | null = null;
  private localLastRenderClientTimeMs: number | null = null;
  private localMovementIntent: LocalMovementIntent | null = null;
  /** Local dash prediction: the intent with this request id moves at dash speed until `untilMs`. */
  private localDash: { requestId: string; untilMs: number; speedMps: number } | null = null;
  private localCorrection: LocalCorrection | null = null;
  private suppressedAuthorityRevision: number | null = null;
  private latestReplicationSequence: number | null = null;
  private lastLocalRenderTraceAtMs = Number.NEGATIVE_INFINITY;
  private lastLocalRenderedForTrace: RenderedPlayerPosition | null = null;
  private pendingLocalStoppedHoldTrace = false;
  private lastLocalRenderDiagnostics: LocalRenderDiagnostics | null = null;
  private pendingLocalFirstMovementTrace: {
    requestId: string;
    movementGeneration: number;
  } | null = null;

  constructor(private readonly interpolationDelayMs = PLAYER_INTERPOLATION_DELAY_MS) {}

  configureLocalPlayer(playerId: string, tuning: LocalPlayerTuning): void {
    if (
      !Number.isFinite(tuning.speedMps) || tuning.speedMps <= 0 ||
      !Number.isFinite(tuning.serverTickHz) || tuning.serverTickHz <= 0
    ) {
      throw new Error("Local player movement tuning must be positive and finite");
    }
    this.configurePlayer(playerId, tuning);
  }

  /** Selects a trace subject without enabling owning-player presentation behavior. */
  configureTracedPlayer(playerId: string): void {
    this.configurePlayer(playerId, null);
  }

  private configurePlayer(playerId: string, tuning: LocalPlayerTuning | null): void {
    const retainLocalPresentation =
      tuning !== null &&
      this.localPlayerId === playerId &&
      this.localPlayerTuning !== null;
    this.localPlayerId = playerId;
    this.localPlayerTuning = tuning ? { ...tuning } : null;
    if (!retainLocalPresentation) {
      this.localAuthority = null;
      this.localRenderedPosition = null;
      this.localEffectiveSpeedMps = null;
    }
    this.localLastRenderClientTimeMs = null;
    this.localMovementIntent = null;
    this.localCorrection = null;
    this.suppressedAuthorityRevision = null;
    this.lastLocalRenderTraceAtMs = Number.NEGATIVE_INFINITY;
    this.lastLocalRenderedForTrace = null;
    this.pendingLocalStoppedHoldTrace = false;
    this.lastLocalRenderDiagnostics = null;
    this.pendingLocalFirstMovementTrace = null;
  }

  /**
   * Walking speed the local prediction uses on land: the server's effective speed when it has sent one, else the base
   * speed from the session welcome; null before the welcome. Joystick lookahead and resend thresholds use it.
   */
  localSpeedMps(): number | null {
    return this.localPlayerTuning ? this.localWalkSpeedMps(1) : null;
  }

  /** Base walking speed from the session welcome (telemetry compares it with the effective speed). */
  localBaseSpeedMps(): number | null {
    return this.localPlayerTuning?.speedMps ?? null;
  }

  /** The server's effective land walking speed (m/s); ignored unless positive and finite (absent on older servers). */
  setLocalEffectiveSpeedMps(speedMps: number | null | undefined): void {
    if (typeof speedMps === "number" && Number.isFinite(speedMps) && speedMps > 0) {
      this.localEffectiveSpeedMps = speedMps;
    }
  }

  /**
   * The server tick's step speed: PLAYER_SPEED_MPS x clamp(0.2..2, movement multiplier x water segment multiplier).
   * The effective speed already carries base x clamp(multiplier), so its ratio to the base is the multiplier.
   */
  private localWalkSpeedMps(segmentMultiplier: number): number {
    const baseMps = this.localPlayerTuning!.speedMps;
    const movementMultiplier = this.localEffectiveSpeedMps === null ? 1 : this.localEffectiveSpeedMps / baseMps;
    return baseMps * Math.max(0.2, Math.min(2, movementMultiplier * segmentMultiplier));
  }

  /** Round-trip estimate (ms) used to size the local prediction lead budget. */
  setLatencyEstimateMs(rttMs: number): void {
    if (Number.isFinite(rttMs) && rttMs >= 0) {
      // Smoothed: one slow PONG must not resize the lead budget (and so the soft limit) in one step.
      this.latencyEstimateMs = this.latencyEstimateSamples === 0
        ? rttMs
        : this.latencyEstimateMs + (rttMs - this.latencyEstimateMs) * LOCAL_LATENCY_SMOOTHING;
      this.latencyEstimateSamples += 1;
    }
  }

  beginLocalAnticipation(
    requestId: string,
    movementGeneration: number,
    target: LatLon,
    clientNowMs: number
  ): void {
    if (
      !this.localPlayerId || !this.localPlayerTuning ||
      !this.localAuthority || !this.localRenderedPosition ||
      !isFiniteLatLon(target.lat, target.lon) || !Number.isFinite(clientNowMs)
    ) {
      return;
    }
    this.localMovementIntent = {
      requestId,
      movementGeneration,
      target: { ...target },
      acceptedRevision: null,
      startedAtMs: clientNowMs,
      // A joystick resend keeps walking the same water leg until its own MOVE_ACCEPTED replaces the profile.
      speedProfile: this.localMovementIntent?.speedProfile ?? null
    };
    this.localCorrection = null;
    this.suppressedAuthorityRevision = null;
    // The prediction clock belongs to the display frames: a request between two frames must not rewrite (or rewind) it,
    // or the next frame's step comes up short. Only an idle prediction (no frame for a while) restarts it here.
    if (
      this.localLastRenderClientTimeMs === null ||
      clientNowMs - this.localLastRenderClientTimeMs > LOCAL_IDLE_CLOCK_RESET_MS
    ) {
      this.localLastRenderClientTimeMs = clientNowMs;
    }
    this.pendingLocalFirstMovementTrace = { requestId, movementGeneration };
  }

  /** Plays a dash locally the instant it is pressed; DASH_ACCEPTED/rejection reconcile it like a move. */
  beginLocalDash(
    requestId: string,
    movementGeneration: number,
    target: LatLon,
    durationMs: number,
    clientNowMs: number
  ): void {
    const from = this.localRenderedPosition;
    this.beginLocalAnticipation(requestId, movementGeneration, target, clientNowMs);
    if (!from || this.localMovementIntent?.requestId !== requestId || !(durationMs > 0)) {
      this.localDash = null;
      return;
    }
    this.localDash = {
      requestId,
      untilMs: clientNowMs + durationMs,
      speedMps: distanceMeters(from, target) / (durationMs / 1_000)
    };
  }

  /** True while the local player is mid-dash (prediction side). */
  isLocalDashActive(clientNowMs: number): boolean {
    return Boolean(
      this.localDash &&
      this.localMovementIntent?.requestId === this.localDash.requestId &&
      clientNowMs < this.localDash.untilMs
    );
  }

  acceptLocalAnticipation(
    requestId: string,
    target: LatLon,
    movementRevision: number,
    speedProfile: LocalSpeedProfile | null = null,
    speedMps: number | null = null
  ): boolean {
    if (
      this.localMovementIntent?.requestId !== requestId ||
      !isFiniteLatLon(target.lat, target.lon) ||
      !Number.isFinite(movementRevision)
    ) {
      return false;
    }
    this.setLocalEffectiveSpeedMps(speedMps);
    this.localMovementIntent = {
      ...this.localMovementIntent,
      target: { ...target },
      acceptedRevision: movementRevision,
      speedProfile: speedProfile && isFiniteLatLon(speedProfile.origin.lat, speedProfile.origin.lon)
        ? { origin: { ...speedProfile.origin }, segments: [...speedProfile.segments] }
        : null
    };
    return true;
  }

  /** Same per-segment speed multiplier the server tick uses (1 outside water legs). */
  private localSpeedMultiplierAt(position: LatLon): number {
    const profile = this.localMovementIntent?.speedProfile;
    return profile
      ? speedMultiplierAtDistance(profile.segments, distanceMeters(profile.origin, position))
      : 1;
  }

  /** Walking speed at a point of the current leg, exactly as the server tick computes it. */
  private localWalkSpeedAt(position: LatLon): number {
    return this.localWalkSpeedMps(this.localSpeedMultiplierAt(position));
  }

  rejectLocalAnticipation(requestId: string, clientNowMs: number): boolean {
    if (
      this.localMovementIntent?.requestId !== requestId ||
      !this.localAuthority || !this.localRenderedPosition ||
      !Number.isFinite(clientNowMs)
    ) {
      return false;
    }
    this.suppressedAuthorityRevision = this.localAuthority.movementRevision;
    this.startLocalCorrection(clientNowMs);
    return true;
  }

  applySnapshot(
    players: readonly PlayerSnapshot[],
    serverTimeMs: number,
    clientReceivedAtMs: number,
    context: ReplicationContext = {}
  ): void {
    this.latestReplicationSequence = context.sequence ?? this.latestReplicationSequence;
    const snapshotPlayerIds = new Set(players.map((player) => player.playerId));
    for (const playerId of this.tracks.keys()) {
      if (!snapshotPlayerIds.has(playerId)) {
        this.tracks.delete(playerId);
        if (playerId === this.localPlayerId) {
          this.resetLocalPresentation();
          this.lastLocalRenderedForTrace = null;
          this.pendingLocalStoppedHoldTrace = false;
        }
      }
    }

    for (const player of players) {
      const renderedBefore = this.currentRenderedPosition(player.playerId);
      const sample = sampleFromPlayer(player, serverTimeMs, context.sequence ?? null);
      const result = this.pushSample(player.playerId, sample, true);
      if (result !== "ignored") {
        this.observeAcceptedServerTime(serverTimeMs, context.receivedAtMs ?? clientReceivedAtMs);
        const acceptedSample = this.latestSample(player.playerId);
        if (player.playerId === this.localPlayerId && this.localPlayerTuning && acceptedSample) {
          this.applyLocalAuthority(acceptedSample, result, clientReceivedAtMs);
          this.compactLocalTrack(player.playerId);
        }
      }
      if (player.playerId === this.localPlayerId) {
        this.traceLocal({
          clientTimeMs: clientReceivedAtMs,
          messageType: "PLAYER_SNAPSHOT",
          outcome: traceOutcomeForSample(result),
          sample,
          renderedBefore,
          renderedAfter: this.currentRenderedPosition(player.playerId),
          reason: context.reason ?? null
        });
      }
    }
  }

  applyDelta(
    upserts: readonly PlayerDeltaUpsert[],
    removedPlayerIds: readonly string[],
    serverTimeMs: number,
    clientReceivedAtMs: number,
    context: ReplicationContext = {}
  ): void {
    this.latestReplicationSequence = context.sequence ?? this.latestReplicationSequence;
    for (const playerId of removedPlayerIds) {
      this.tracks.delete(playerId);
      if (playerId === this.localPlayerId) {
        this.resetLocalPresentation();
        this.lastLocalRenderedForTrace = null;
        this.pendingLocalStoppedHoldTrace = false;
      }
    }

    for (const upsert of upserts) {
      const playerId = upsert.kind === "full" ? upsert.player.playerId : upsert.playerId;
      const renderedBefore = this.currentRenderedPosition(playerId);
      const sample = upsert.kind === "full"
        ? sampleFromPlayer(upsert.player, serverTimeMs, context.sequence ?? null)
        : this.sampleFromMovementUpsert(upsert, serverTimeMs, context.sequence ?? null);
      if (!sample) {
        continue;
      }
      if (upsert.kind === "movement" && playerId === this.localPlayerId && this.localPlayerTuning) {
        this.setLocalEffectiveSpeedMps(upsert.speedMps);
      }
      const result = this.pushSample(playerId, sample);
      if (result !== "ignored") {
        this.observeAcceptedServerTime(serverTimeMs, context.receivedAtMs ?? clientReceivedAtMs);
        const acceptedSample = this.latestSample(playerId);
        if (playerId === this.localPlayerId && this.localPlayerTuning && acceptedSample) {
          this.applyLocalAuthority(acceptedSample, result, clientReceivedAtMs);
          this.compactLocalTrack(playerId);
        }
      }
      if (playerId === this.localPlayerId) {
        this.traceLocal({
          clientTimeMs: clientReceivedAtMs,
          messageType: upsert.kind === "full" ? "PLAYER_DELTA_FULL" : "PLAYER_DELTA",
          outcome: traceOutcomeForSample(result),
          sample,
          renderedBefore,
          renderedAfter: this.currentRenderedPosition(playerId)
        });
      }
    }
  }

  snapPlayer(
    player: PlayerSnapshot,
    serverTimeMs: number,
    clientReceivedAtMs: number,
    reason = "explicit-player-snap"
  ): boolean {
    const renderedBefore = this.currentRenderedPosition(player.playerId);
    const sample = sampleFromPlayer(player, serverTimeMs, this.latestReplicationSequence);
    if (!isValidSample(sample)) {
      return false;
    }
    const latest = this.latestSample(player.playerId);
    if (
      latest && (
        sample.relocationRevision < latest.relocationRevision ||
        (sample.relocationRevision === latest.relocationRevision &&
          sample.serverTimeMs < latest.serverTimeMs)
      )
    ) {
      return false;
    }
    if (
      latest &&
      sample.relocationRevision === latest.relocationRevision &&
      sample.serverTimeMs === latest.serverTimeMs &&
      sample.movementRevision === latest.movementRevision &&
      samePosition(renderedPositionFromSample(latest), renderedPositionFromSample(sample))
    ) {
      return false;
    }
    this.observeAcceptedServerTime(serverTimeMs, clientReceivedAtMs);
    this.setImmediateSample(player.playerId, sample);
    if (player.playerId === this.localPlayerId) {
      if (this.localPlayerTuning) {
        this.setLocalImmediate(sample, clientReceivedAtMs);
      }
      const renderedAfter = renderedPositionFromSample(sample);
      this.lastLocalRenderedForTrace = renderedAfter;
      this.pendingLocalStoppedHoldTrace = false;
      this.traceLocal({
        clientTimeMs: clientReceivedAtMs,
        messageType: "LOCAL_PLAYER_SNAP",
        outcome: "snapped",
        sample,
        renderedBefore,
        renderedAfter,
        reason
      });
    }
    return true;
  }

  snapPosition(
    playerId: string,
    position: LatLon,
    serverTimeMs: number,
    clientReceivedAtMs: number,
    reason = "explicit-position-snap"
  ): void {
    const renderedBefore = this.currentRenderedPosition(playerId);
    const latest = this.latestSample(playerId);
    const acceptedServerTimeMs = Math.max(
      serverTimeMs,
      latest?.serverTimeMs ?? serverTimeMs
    );
    const sample: AuthoritativePlayerSample = {
      lat: position.lat,
      lon: position.lon,
      anchorLat: latest?.anchorLat ?? position.lat,
      anchorLon: latest?.anchorLon ?? position.lon,
      regionCode: latest?.regionCode ?? "",
      zoneId: latest?.zoneId ?? "",
      serverTimeMs: acceptedServerTimeMs,
      playbackTimeMs: acceptedServerTimeMs,
      movementRevision: latest?.movementRevision ?? 0,
      relocationRevision: latest?.relocationRevision ?? 0,
      replicationSequence: this.latestReplicationSequence,
      moving: false,
      targetLat: null,
      targetLon: null
    };
    if (!isValidSample(sample)) {
      return;
    }
    this.observeAcceptedServerTime(sample.serverTimeMs, clientReceivedAtMs);
    this.setImmediateSample(playerId, sample);
    if (playerId === this.localPlayerId) {
      if (this.localPlayerTuning) {
        this.setLocalImmediate(sample, clientReceivedAtMs);
      }
      const renderedAfter = renderedPositionFromSample(sample);
      this.lastLocalRenderedForTrace = renderedAfter;
      this.pendingLocalStoppedHoldTrace = false;
      this.traceLocal({
        clientTimeMs: clientReceivedAtMs,
        messageType: "LOCAL_POSITION_SNAP",
        outcome: "snapped",
        sample,
        renderedBefore,
        renderedAfter,
        reason
      });
    }
  }

  renderPosition(playerId: string, clientNowMs: number): RenderedPlayerPosition | null {
    const track = this.tracks.get(playerId);
    if ((playerId !== this.localPlayerId || !this.localPlayerTuning) && track) {
      this.advancePlaybackClock(track, clientNowMs);
    }
    const renderedAfter = playerId === this.localPlayerId && this.localPlayerTuning
      ? this.renderLocalPosition(clientNowMs)
      : this.renderTrackPosition(playerId);
    if (!renderedAfter || playerId !== this.localPlayerId || !movementTraceEnabled()) {
      return renderedAfter;
    }

    const renderedBefore = this.lastLocalRenderedForTrace;
    this.lastLocalRenderedForTrace = renderedAfter;
    const latest = this.latestSample(playerId);
    const renderedChanged = renderedBefore !== null &&
      !samePosition(renderedBefore, renderedAfter);
    if (renderedChanged && this.pendingLocalFirstMovementTrace) {
      this.traceLocal({
        clientTimeMs: clientNowMs,
        messageType: "LOCAL_FIRST_MOVEMENT_FRAME",
        outcome: "interpolated",
        requestId: this.pendingLocalFirstMovementTrace.requestId,
        movementGeneration: this.pendingLocalFirstMovementTrace.movementGeneration,
        sample: latest,
        renderedBefore,
        renderedAfter,
        renderDiagnostics: this.lastLocalRenderDiagnostics,
        reason: "first-position-change"
      });
      this.pendingLocalFirstMovementTrace = null;
    }
    if (latest && !latest.moving && renderedChanged) {
      this.pendingLocalStoppedHoldTrace = true;
    }
    if (
      latest &&
      (latest.moving || renderedChanged || this.pendingLocalStoppedHoldTrace) &&
      clientNowMs - this.lastLocalRenderTraceAtMs >= LOCAL_RENDER_TRACE_INTERVAL_MS
    ) {
      const held = samePosition(renderedBefore, renderedAfter);
      this.traceLocal({
        clientTimeMs: clientNowMs,
        messageType: "LOCAL_RENDER_FRAME",
        outcome: held ? "held" : "interpolated",
        sample: latest,
        renderedBefore,
        renderedAfter,
        renderDiagnostics: this.lastLocalRenderDiagnostics
      });
      this.lastLocalRenderTraceAtMs = clientNowMs;
      if (!latest.moving && held) {
        this.pendingLocalStoppedHoldTrace = false;
      }
    }
    return renderedAfter;
  }

  clear(): void {
    this.tracks.clear();
    this.serverToClientOffsetMs = null;
    this.serverOffsetObservedAtMs = null;
    this.latestAcceptedServerTimeMs = Number.NEGATIVE_INFINITY;
    this.localPlayerId = null;
    this.localPlayerTuning = null;
    this.localEffectiveSpeedMps = null;
    this.localAuthority = null;
    this.localRenderedPosition = null;
    this.localLastRenderClientTimeMs = null;
    this.localMovementIntent = null;
    this.localCorrection = null;
    this.suppressedAuthorityRevision = null;
    this.latestReplicationSequence = null;
    this.lastLocalRenderTraceAtMs = Number.NEGATIVE_INFINITY;
    this.lastLocalRenderedForTrace = null;
    this.pendingLocalStoppedHoldTrace = false;
    this.lastLocalRenderDiagnostics = null;
    this.pendingLocalFirstMovementTrace = null;
  }

  retainOnly(playerId: string): void {
    for (const trackedPlayerId of this.tracks.keys()) {
      if (trackedPlayerId !== playerId) this.tracks.delete(trackedPlayerId);
    }
  }

  sampleCount(playerId: string): number {
    return this.tracks.get(playerId)?.samples.length ?? 0;
  }

  private sampleFromMovementUpsert(
    upsert: Extract<PlayerDeltaUpsert, { kind: "movement" }>,
    serverTimeMs: number,
    replicationSequence: number | null
  ): AuthoritativePlayerSample | null {
    const latest = this.latestSample(upsert.playerId);
    if (!latest) {
      return null;
    }
    return {
      lat: upsert.lat,
      lon: upsert.lon,
      anchorLat: latest.anchorLat,
      anchorLon: latest.anchorLon,
      regionCode: latest.regionCode,
      zoneId: latest.zoneId,
      serverTimeMs,
      playbackTimeMs: serverTimeMs,
      movementRevision: upsert.movementRevision,
      relocationRevision: normalizeRelocationRevision(
        upsert.relocationRevision,
        latest.relocationRevision
      ),
      replicationSequence,
      moving: upsert.moving,
      targetLat: upsert.targetLat,
      targetLon: upsert.targetLon
    };
  }

  private pushSample(
    playerId: string,
    sample: AuthoritativePlayerSample,
    establishesReplicationBaseline = false
  ): SampleApplyResult {
    if (!isValidSample(sample)) {
      return "ignored";
    }
    const track = this.tracks.get(playerId);
    const latest = track?.samples.at(-1);
    if (!track || !latest) {
      this.setImmediateSample(playerId, sample);
      return "snapped";
    }
    if (sample.relocationRevision < latest.relocationRevision) {
      return "ignored";
    }
    if (sample.relocationRevision > latest.relocationRevision) {
      this.setImmediateSample(playerId, sample);
      return "snapped";
    }
    if (
      sample.serverTimeMs < latest.serverTimeMs ||
      sample.movementRevision < latest.movementRevision
    ) {
      return "ignored";
    }
    if (sample.serverTimeMs === latest.serverTimeMs) {
      if (
        sample.movementRevision === latest.movementRevision &&
        !establishesReplicationBaseline &&
        !isLaterSequence(sample.replicationSequence, latest.replicationSequence)
      ) {
        return "ignored";
      }
      if (isStaticDiscontinuity(latest, sample)) {
        this.setImmediateSample(playerId, sample);
        return "snapped";
      }
      if (!sameCoordinates(latest, sample)) {
        // Preserve an equal-time authoritative correction without applying it in one frame.
        const presentationStartTimeMs = Math.max(
          latest.playbackTimeMs,
          latest.moving
            ? latest.playbackTimeMs
            : track.playbackServerTimeMs ?? latest.playbackTimeMs
        );
        if (presentationStartTimeMs > latest.playbackTimeMs) {
          track.samples.push({ ...latest, playbackTimeMs: presentationStartTimeMs });
        }
        track.samples.push({
          ...sample,
          playbackTimeMs: presentationStartTimeMs + PLAYER_AUTHORITY_INTERVAL_MS
        });
        this.pruneConsumedSamples(track);
        return "appended";
      }
      const presentationFloorMs = latest.moving
        ? latest.playbackTimeMs
        : track.playbackServerTimeMs ?? latest.playbackTimeMs;
      track.samples[track.samples.length - 1] = {
        ...sample,
        playbackTimeMs: Math.max(
          sample.playbackTimeMs,
          latest.playbackTimeMs,
          presentationFloorMs
        )
      };
      return "replaced";
    }

    if (isStaticDiscontinuity(latest, sample)) {
      this.setImmediateSample(playerId, sample);
      return "snapped";
    }

    const coordinatesChanged = !sameCoordinates(latest, sample);
    let presentationStartTimeMs = latest.playbackTimeMs;
    if (!latest.moving) {
      presentationStartTimeMs = Math.max(
        presentationStartTimeMs,
        track.playbackServerTimeMs ?? presentationStartTimeMs
      );
      if (sample.moving && coordinatesChanged) {
        // The first tick after an idle move command can already be one step ahead.
        presentationStartTimeMs = Math.max(
          presentationStartTimeMs,
          sample.playbackTimeMs - PLAYER_AUTHORITY_INTERVAL_MS
        );
      }
    }
    if (presentationStartTimeMs > latest.playbackTimeMs) {
      track.samples.push({
        ...latest,
        playbackTimeMs: presentationStartTimeMs,
        replicationSequence: sample.replicationSequence
      });
    }
    track.samples.push({
      ...sample,
      playbackTimeMs: Math.max(
        sample.playbackTimeMs,
        coordinatesChanged
          ? presentationStartTimeMs + PLAYER_AUTHORITY_INTERVAL_MS
          : presentationStartTimeMs
      )
    });
    this.pruneConsumedSamples(track);
    return "appended";
  }

  private setImmediateSample(playerId: string, sample: AuthoritativePlayerSample): void {
    this.tracks.set(playerId, {
      samples: [sample],
      playbackServerTimeMs: null,
      lastPlaybackClientTimeMs: null
    });
  }

  private compactLocalTrack(playerId: string): void {
    const track = this.tracks.get(playerId);
    const latest = track?.samples.at(-1);
    if (!track || !latest) {
      return;
    }
    track.samples = [latest];
    track.playbackServerTimeMs = null;
    track.lastPlaybackClientTimeMs = null;
  }

  private latestSample(playerId: string): AuthoritativePlayerSample | null {
    return this.tracks.get(playerId)?.samples.at(-1) ?? null;
  }

  private currentRenderedPosition(playerId: string): RenderedPlayerPosition | null {
    return playerId === this.localPlayerId && this.localPlayerTuning
      ? this.localRenderedPosition
      : this.renderTrackPosition(playerId);
  }

  private setLocalImmediate(sample: AuthoritativePlayerSample, clientNowMs: number): void {
    this.localAuthority = sample;
    this.localAuthorityReceivedAtMs = clientNowMs;
    this.localRenderedPosition = renderedPositionFromSample(sample);
    this.localLastRenderClientTimeMs = clientNowMs;
    this.localMovementIntent = null;
    this.localCorrection = null;
    this.suppressedAuthorityRevision = null;
    this.pendingLocalFirstMovementTrace = null;
    this.lastLocalRenderDiagnostics = null;
  }

  private resetLocalPresentation(): void {
    this.localAuthority = null;
    this.localAuthorityReceivedAtMs = null;
    this.localRenderedPosition = null;
    this.localLastRenderClientTimeMs = null;
    this.localMovementIntent = null;
    this.localCorrection = null;
    this.suppressedAuthorityRevision = null;
    this.pendingLocalFirstMovementTrace = null;
    this.lastLocalRenderDiagnostics = null;
  }

  private applyLocalAuthority(
    sample: AuthoritativePlayerSample,
    result: SampleApplyResult,
    clientReceivedAtMs: number
  ): void {
    const previousAuthority = this.localAuthority;
    const initialAuthority = this.localRenderedPosition === null;
    if (previousAuthority && result !== "snapped") this.noteAuthorityStep(previousAuthority, sample);
    this.localAuthority = sample;
    this.localAuthorityReceivedAtMs = clientReceivedAtMs;
    if (initialAuthority) {
      this.localRenderedPosition = renderedPositionFromSample(sample);
      this.localLastRenderClientTimeMs = clientReceivedAtMs;
      if (sample.moving) {
        this.adoptAuthorityIntent(sample);
      }
      return;
    }
    if (result === "snapped") {
      noteMotionSnap();
      this.setLocalImmediate(sample, clientReceivedAtMs);
      return;
    }

    const target = sampleTarget(sample);
    if (sample.moving && target) {
      if (
        this.suppressedAuthorityRevision !== null &&
        sample.movementRevision <= this.suppressedAuthorityRevision
      ) {
        return;
      }
      this.suppressedAuthorityRevision = null;
      if (!this.localMovementIntent) {
        this.adoptAuthorityIntent(sample);
        return;
      }
      if (sameCoordinates(this.localMovementIntent.target, target)) {
        if (
          this.localMovementIntent.acceptedRevision === null &&
          sample.movementRevision > (previousAuthority?.movementRevision ?? -1)
        ) {
          this.localMovementIntent = {
            ...this.localMovementIntent,
            acceptedRevision: sample.movementRevision
          };
        }
        return;
      }
      const latestLocalRequestPending =
        this.localMovementIntent.requestId !== null &&
        this.localMovementIntent.acceptedRevision === null;
      if (latestLocalRequestPending) {
        return;
      }
      if (sample.movementRevision > (previousAuthority?.movementRevision ?? -1)) {
        this.adoptAuthorityIntent(sample);
      }
      return;
    }

    // A local request the server has not answered yet outranks any "stopped" sample, even one with a newer
    // revision: that stop was decided before the request arrived (a dash landing, the end of the last walk leg).
    // MOVE_ACCEPTED / MOVE_REJECTED / DASH_REJECTED or the pending timeout resolve it; correcting here would
    // rubber-band the player back to the stop point and restart the walk a round trip later.
    const pendingRequestStillWaiting = this.localMovementIntent?.requestId !== null &&
      this.localMovementIntent?.acceptedRevision === null &&
      (
        sample.movementRevision <= (previousAuthority?.movementRevision ?? sample.movementRevision) ||
        !this.localMovementIntent || !sameCoordinates(this.localMovementIntent.target, sample)
      );
    const acceptedRequestStillWaiting = this.localMovementIntent?.acceptedRevision !== null &&
      this.localMovementIntent?.acceptedRevision !== undefined &&
      sample.movementRevision < this.localMovementIntent.acceptedRevision;
    if (pendingRequestStillWaiting || acceptedRequestStillWaiting) {
      return;
    }
    if (this.localCorrection && sameCoordinates(this.localCorrection.to, sample)) {
      return;
    }
    this.suppressedAuthorityRevision = null;
    this.startLocalCorrection(clientReceivedAtMs);
  }

  /**
   * Telemetry: how far a new authority sample lands from where the previous one dead-reckons to at the new server time
   * (the lead origin's jump), and the server's measured walking speed against the prediction's.
   */
  private noteAuthorityStep(previous: AuthoritativePlayerSample, next: AuthoritativePlayerSample): void {
    const dtMs = next.serverTimeMs - previous.serverTimeMs;
    const previousTarget = sampleTarget(previous);
    const nextTarget = sampleTarget(next);
    if (
      !this.localPlayerTuning || !(dtMs > 0) || dtMs > 250 ||
      !previous.moving || !next.moving || !previousTarget || !nextTarget ||
      !sameCoordinates(previousTarget, nextTarget) || previous.movementRevision !== next.movementRevision
    ) {
      return;
    }
    const speedMps = this.localWalkSpeedAt(previous);
    const expected = moveToward(previous, previousTarget, speedMps * dtMs / 1_000);
    noteMotionAuthority(distanceMeters(expected, next), distanceMeters(previous, next), dtMs, speedMps);
  }

  private adoptAuthorityIntent(sample: AuthoritativePlayerSample): void {
    const target = sampleTarget(sample);
    if (!target) {
      return;
    }
    this.localMovementIntent = {
      requestId: null,
      movementGeneration: null,
      target,
      acceptedRevision: sample.movementRevision,
      startedAtMs: null
    };
  }

  private startLocalCorrection(clientNowMs: number): void {
    if (!this.localAuthority || !this.localRenderedPosition || !this.localPlayerTuning) {
      return;
    }
    const authorityPosition = renderedPositionFromSample(this.localAuthority);
    const correctionDistanceM = distanceMeters(this.localRenderedPosition, authorityPosition);
    const maxLeadM = localPredictionLeadM(this.localWalkSpeedMps(1), this.localPlayerTuning.serverTickHz);
    this.localMovementIntent = null;
    this.pendingLocalFirstMovementTrace = null;
    this.localLastRenderClientTimeMs = Math.max(this.localLastRenderClientTimeMs ?? clientNowMs, clientNowMs);
    if (samePosition(this.localRenderedPosition, authorityPosition)) {
      this.localRenderedPosition = authorityPosition;
      this.localCorrection = null;
      return;
    }
    noteMotionCorrection(correctionDistanceM);
    this.localCorrection = {
      from: this.localRenderedPosition,
      to: authorityPosition,
      startedAtMs: clientNowMs,
      durationMs: LOCAL_CORRECTION_MIN_MS +
        (LOCAL_CORRECTION_MAX_MS - LOCAL_CORRECTION_MIN_MS) *
        Math.min(1, correctionDistanceM / maxLeadM)
    };
  }

  private renderLocalPosition(clientNowMs: number): RenderedPlayerPosition | null {
    if (!this.localRenderedPosition || !this.localAuthority || !this.localPlayerTuning) {
      return this.localRenderedPosition;
    }
    if (!Number.isFinite(clientNowMs)) {
      return this.localRenderedPosition;
    }
    if (this.localLastRenderClientTimeMs === null) {
      this.localLastRenderClientTimeMs = clientNowMs;
      return this.localRenderedPosition;
    }
    // The prediction advances once per display time: a read at (or before) the time already rendered changes nothing,
    // so the camera, the sprite and input handlers in one frame all see the same presentation position.
    if (clientNowMs <= this.localLastRenderClientTimeMs) {
      // A read before the furthest time already rendered (another caller ran ahead of this frame's clock).
      if (clientNowMs < this.localLastRenderClientTimeMs - 0.5) {
        noteMotionClockBehind(this.localLastRenderClientTimeMs - clientNowMs);
      }
      return this.localRenderedPosition;
    }

    if (
      !this.localCorrection &&
      this.localMovementIntent?.requestId != null &&
      this.localMovementIntent.acceptedRevision === null &&
      this.localMovementIntent.startedAtMs !== null &&
      clientNowMs - this.localMovementIntent.startedAtMs > LOCAL_PENDING_REQUEST_TIMEOUT_MS
    ) {
      this.startLocalCorrection(clientNowMs);
    }

    if (this.localCorrection) {
      const rawFrameMs = Math.max(0, clientNowMs - this.localLastRenderClientTimeMs);
      const progress = Math.min(
        1,
        Math.max(0, (clientNowMs - this.localCorrection.startedAtMs) / this.localCorrection.durationMs)
      );
      this.localRenderedPosition = interpolateRenderedPositions(
        this.localCorrection.from,
        this.localCorrection.to,
        progress
      );
      if (progress >= 1) {
        this.localCorrection = null;
      }
      this.localLastRenderClientTimeMs = Math.max(this.localLastRenderClientTimeMs, clientNowMs);
      this.noteLocalRenderDiagnostics(clientNowMs, rawFrameMs, rawFrameMs, false);
      return this.localRenderedPosition;
    }

    const elapsedClientMs = Math.max(0, clientNowMs - this.localLastRenderClientTimeMs);
    const authorityPosition = renderedPositionFromSample(this.localAuthority);
    const destination = this.localMovementIntent?.target ?? authorityPosition;
    if (this.localDash && this.localMovementIntent?.requestId !== this.localDash.requestId) {
      this.localDash = null;
    }
    // A dash keeps its speed a little past its nominal end so a late frame still lands it.
    const dashing = this.localDash !== null && clientNowMs < this.localDash.untilMs + 100;
    const moveDistanceM = dashing
      ? this.localDash!.speedMps * elapsedClientMs / 1_000
      : this.localWalkSpeedAt(this.localRenderedPosition) * elapsedClientMs / 1_000;
    let nextPosition = moveDistanceM > 0
      ? moveToward(this.localRenderedPosition, destination, moveDistanceM)
      : { lat: this.localRenderedPosition.lat, lon: this.localRenderedPosition.lon };
    let leadCapHeld = false;
    let leadHardClamp = false;
    let leadNudgeM = 0;
    if (this.localMovementIntent) {
      const intent = this.localMovementIntent;
      const pending = intent.requestId !== null && intent.acceptedRevision === null;
      const authorityTarget = this.localAuthority.moving ? sampleTarget(this.localAuthority) : null;
      // A pending request has not been echoed yet, so authority samples that
      // still walk another target say nothing about how far ahead we may be.
      // Nor does a fresh sample older than the accepted revision: it still walks the previous leg (MOVE_ACCEPTED outran
      // the next delta). Once it is older than the dead-reckoning window the limit applies again (a real stall).
      const staleAuthority = (pending &&
        (!authorityTarget || !sameCoordinates(authorityTarget, intent.target))) ||
        (intent.acceptedRevision !== null && this.localAuthority.movementRevision < intent.acceptedRevision &&
          this.localAuthorityAgeMs(clientNowMs) <= LOCAL_AUTHORITY_DEAD_RECKON_MAX_MS);
      // The walking lead limit would throttle a dash; it applies again once the dash has landed.
      if (!staleAuthority && !dashing) {
        const walkSpeedMps = this.localWalkSpeedMps(1);
        const maxLeadM = localPredictionLeadM(
          walkSpeedMps,
          this.localPlayerTuning.serverTickHz,
          this.latencyEstimateMs
        );
        // The server walks to a target we both know: dead reckoning toward it stays honest for longer
        // (it never passes the target), so a short pause in player deltas does not stall the walk.
        const sharedTarget = authorityTarget !== null && sameCoordinates(authorityTarget, intent.target);
        const leadOrigin = this.deadReckonedAuthority(
          authorityPosition,
          authorityTarget,
          clientNowMs,
          sharedTarget ? LOCAL_AUTHORITY_SHARED_TARGET_DEAD_RECKON_MAX_MS : LOCAL_AUTHORITY_DEAD_RECKON_MAX_MS
        );
        const softLimitM = maxLeadM + walkSpeedMps / this.localPlayerTuning.serverTickHz;
        const hardLimitM = LOCAL_LEAD_HARD_FACTOR * maxLeadM;
        const leadM = distanceMeters(leadOrigin, nextPosition);
        if (leadM > hardLimitM) {
          // A real desync: hold the prediction at the hard limit (the soft pull keeps easing it back from there).
          nextPosition = moveToward(leadOrigin, nextPosition, hardLimitM);
          leadCapHeld = true;
          leadHardClamp = true;
        } else if (leadM > softLimitM) {
          // A decaying presentation error, bounded so the per-frame step stays even and forward.
          const excessM = leadM - softLimitM;
          leadNudgeM = Math.min(
            excessM * (1 - Math.exp(-elapsedClientMs / LOCAL_LEAD_RELAX_MS)),
            walkSpeedMps * LOCAL_LEAD_PULL_MAX_FRACTION * elapsedClientMs / 1_000
          );
          if (leadNudgeM > 0) {
            nextPosition = moveToward(nextPosition, leadOrigin, leadNudgeM);
            leadCapHeld = true;
          }
        }
        noteMotionPrediction(
          this.latencyEstimateMs,
          localPredictionLeadMs(this.localPlayerTuning.serverTickHz, this.latencyEstimateMs),
          walkSpeedMps,
          this.localPlayerTuning.speedMps
        );
      }
    }
    this.localRenderedPosition = {
      ...nextPosition,
      anchorLat: this.localAuthority.anchorLat,
      anchorLon: this.localAuthority.anchorLon
    };
    this.localLastRenderClientTimeMs = Math.max(this.localLastRenderClientTimeMs, clientNowMs);
    if (leadCapHeld) noteMotionLeadLimit(clientNowMs, leadHardClamp, leadNudgeM);
    this.noteLocalRenderDiagnostics(clientNowMs, elapsedClientMs, elapsedClientMs, leadCapHeld);
    return this.localRenderedPosition;
  }

  private deadReckonedAuthority(
    authorityPosition: RenderedPlayerPosition,
    authorityTarget: LatLon | null,
    clientNowMs: number,
    maxAgeMs = LOCAL_AUTHORITY_DEAD_RECKON_MAX_MS
  ): LatLon {
    if (!authorityTarget || !this.localPlayerTuning || !this.localAuthority) {
      return authorityPosition;
    }
    const ageMs = Math.min(maxAgeMs, Math.max(0, this.localAuthorityAgeMs(clientNowMs)));
    return moveToward(
      authorityPosition,
      authorityTarget,
      this.localWalkSpeedAt(authorityPosition) * ageMs / 1_000
    );
  }

  /**
   * Age of the local authority sample at a client time, by server time: the sample's server timestamp against the
   * server clock estimate (clientNow - offset), free of packet arrival jitter and frame quantization. Falls back to the
   * receipt time when there is no offset estimate or the age is implausible (clock jump, stale estimate).
   */
  private localAuthorityAgeMs(clientNowMs: number): number {
    const authority = this.localAuthority;
    if (!authority) return 0;
    if (this.serverToClientOffsetMs !== null) {
      const ageMs = clientNowMs - this.serverToClientOffsetMs - authority.serverTimeMs;
      if (ageMs >= LOCAL_AUTHORITY_AGE_MIN_MS && ageMs <= LOCAL_AUTHORITY_AGE_MAX_MS) return ageMs;
    }
    return this.localAuthorityReceivedAtMs === null ? 0 : clientNowMs - this.localAuthorityReceivedAtMs;
  }

  private noteLocalRenderDiagnostics(
    clientNowMs: number,
    rawFrameMs: number,
    consumedFrameMs: number,
    leadCapHeld: boolean
  ): void {
    const predictionLeadM = this.localAuthority &&
      this.localRenderedPosition &&
      this.localMovementIntent
      ? Math.max(
          0,
          distanceMeters(this.localAuthority, this.localMovementIntent.target) -
            distanceMeters(this.localRenderedPosition, this.localMovementIntent.target)
        )
      : 0;
    const authorityAgeMs = this.localAuthority && this.serverToClientOffsetMs !== null
      ? Math.max(
          0,
          clientNowMs - (this.localAuthority.serverTimeMs + this.serverToClientOffsetMs)
        )
      : null;
    const discardedFrameMs = Math.max(0, rawFrameMs - consumedFrameMs);
    perfMetrics.noteLocalMovementFrame(
      rawFrameMs,
      discardedFrameMs,
      predictionLeadM,
      authorityAgeMs,
      leadCapHeld
    );
    this.lastLocalRenderDiagnostics = movementTraceEnabled()
      ? {
          rawFrameMs,
          consumedFrameMs,
          discardedFrameMs,
          predictionLeadM,
          authorityAgeMs,
          leadCapHeld
        }
      : null;
  }

  private renderTrackPosition(playerId: string): RenderedPlayerPosition | null {
    const track = this.tracks.get(playerId);
    if (!track?.samples.length) {
      return null;
    }
    const samples = track.samples;
    return interpolateSamples(
      samples,
      track.playbackServerTimeMs ?? samples[0]!.playbackTimeMs
    );
  }

  private advancePlaybackClock(track: PlayerSampleTrack, clientNowMs: number): void {
    const latest = track.samples.at(-1);
    if (
      !latest ||
      this.serverToClientOffsetMs === null ||
      !Number.isFinite(clientNowMs) ||
      !Number.isFinite(this.latestAcceptedServerTimeMs)
    ) {
      return;
    }
    const desiredServerTimeMs = Math.min(
      clientNowMs - this.serverToClientOffsetMs - this.interpolationDelayMs,
      latest.playbackTimeMs
    );
    if (track.playbackServerTimeMs === null || track.lastPlaybackClientTimeMs === null) {
      track.playbackServerTimeMs = desiredServerTimeMs;
      track.lastPlaybackClientTimeMs = clientNowMs;
      this.pruneConsumedSamples(track);
      return;
    }
    const elapsedClientMs = Math.min(
      Math.max(0, clientNowMs - track.lastPlaybackClientTimeMs),
      MAX_REMOTE_PLAYBACK_FRAME_DELTA_MS
    );
    track.playbackServerTimeMs = this.stationaryAdvanceLimit(track, desiredServerTimeMs);
    if (desiredServerTimeMs > track.playbackServerTimeMs && elapsedClientMs > 0) {
      track.playbackServerTimeMs += Math.min(
        desiredServerTimeMs - track.playbackServerTimeMs,
        elapsedClientMs * PLAYER_PLAYBACK_CATCH_UP_RATE
      );
    }
    track.lastPlaybackClientTimeMs = Math.max(track.lastPlaybackClientTimeMs, clientNowMs);
    this.pruneConsumedSamples(track);
  }

  private stationaryAdvanceLimit(
    track: PlayerSampleTrack,
    desiredServerTimeMs: number
  ): number {
    const playbackServerTimeMs = track.playbackServerTimeMs!;
    let limit = desiredServerTimeMs;
    for (let index = 1; index < track.samples.length; index += 1) {
      const previous = track.samples[index - 1]!;
      const next = track.samples[index]!;
      if (
        next.playbackTimeMs <= playbackServerTimeMs ||
        sameCoordinates(previous, next)
      ) {
        continue;
      }
      if (previous.playbackTimeMs <= playbackServerTimeMs) {
        return playbackServerTimeMs;
      }
      // Skipping coordinate-identical authority is safe; entering movement is not.
      limit = Math.min(limit, previous.playbackTimeMs);
      break;
    }
    return Math.max(playbackServerTimeMs, limit);
  }

  private pruneConsumedSamples(track: PlayerSampleTrack): void {
    if (track.playbackServerTimeMs === null) {
      return;
    }
    while (
      track.samples.length > 2 &&
      track.samples[1]!.playbackTimeMs <= track.playbackServerTimeMs
    ) {
      track.samples.shift();
    }
  }

  private observeAcceptedServerTime(
    serverTimeMs: number,
    clientReceivedAtMs: number
  ): void {
    if (
      !Number.isFinite(serverTimeMs) ||
      !Number.isFinite(clientReceivedAtMs)
    ) {
      return;
    }
    if (serverTimeMs < this.latestAcceptedServerTimeMs) {
      return;
    }
    this.latestAcceptedServerTimeMs = serverTimeMs;
    const observedOffsetMs = clientReceivedAtMs - serverTimeMs;
    // The minimum observed offset (fastest packet), allowed to creep up slowly so clock drift cannot strand it.
    const driftMs = this.serverOffsetObservedAtMs === null
      ? 0
      : Math.max(0, clientReceivedAtMs - this.serverOffsetObservedAtMs) * SERVER_OFFSET_DRIFT_PER_MS;
    this.serverToClientOffsetMs = this.serverToClientOffsetMs === null
      ? observedOffsetMs
      : Math.min(this.serverToClientOffsetMs + driftMs, observedOffsetMs);
    this.serverOffsetObservedAtMs = clientReceivedAtMs;
  }

  private traceLocal(input: LocalTraceInput): void {
    if (!movementTraceEnabled()) {
      return;
    }
    const sample = input.sample ?? (
      this.localPlayerId ? this.latestSample(this.localPlayerId) : null
    );
    const renderedAfter = input.renderedAfter ?? null;
    const renderDiagnostics = input.renderDiagnostics ?? null;
    recordMovementTrace({
      clientTimeMs: input.clientTimeMs,
      messageType: input.messageType,
      requestId: input.requestId ?? null,
      movementGeneration: input.movementGeneration ?? null,
      movementRevision: sample?.movementRevision ?? null,
      replicationSequence: sample?.replicationSequence ?? this.latestReplicationSequence,
      serverTimeMs: sample?.serverTimeMs ?? null,
      authoritativePosition: sample ? { lat: sample.lat, lon: sample.lon } : null,
      renderedBefore: input.renderedBefore
        ? { lat: input.renderedBefore.lat, lon: input.renderedBefore.lon }
        : null,
      renderedAfter: renderedAfter
        ? { lat: renderedAfter.lat, lon: renderedAfter.lon }
        : null,
      target: sampleTarget(sample),
      anchor: renderedAfter
        ? { lat: renderedAfter.anchorLat, lon: renderedAfter.anchorLon }
        : sample
          ? { lat: sample.anchorLat, lon: sample.anchorLon }
          : null,
      correctionDistanceM: sample && renderedAfter
        ? distanceMeters(renderedAfter, sample)
        : null,
      rawFrameMs: renderDiagnostics?.rawFrameMs ?? null,
      consumedFrameMs: renderDiagnostics?.consumedFrameMs ?? null,
      discardedFrameMs: renderDiagnostics?.discardedFrameMs ?? null,
      predictionLeadM: renderDiagnostics?.predictionLeadM ?? null,
      authorityAgeMs: renderDiagnostics?.authorityAgeMs ?? null,
      leadCapHeld: renderDiagnostics?.leadCapHeld ?? null,
      outcome: input.outcome,
      reason: input.reason ?? null
    });
  }
}

function localPredictionLeadMs(serverTickHz: number, latencyMs = 0): number {
  return Math.min(
    LOCAL_PREDICTION_MAX_LEAD_MS,
    Math.max(
      LOCAL_PREDICTION_MIN_LEAD_MS,
      latencyMs + LOCAL_PREDICTION_LEAD_TICKS * 1_000 / serverTickHz
    )
  );
}

function localPredictionLeadM(speedMps: number, serverTickHz: number, latencyMs = 0): number {
  return speedMps * localPredictionLeadMs(serverTickHz, latencyMs) / 1_000;
}

function sampleFromPlayer(
  player: PlayerSnapshot,
  serverTimeMs: number,
  replicationSequence: number | null
): AuthoritativePlayerSample {
  return {
    lat: player.lat,
    lon: player.lon,
    anchorLat: player.anchorLat,
    anchorLon: player.anchorLon,
    regionCode: player.regionCode,
    zoneId: player.zoneId,
    serverTimeMs,
    playbackTimeMs: serverTimeMs,
    movementRevision: player.movementRevision,
    relocationRevision: normalizeRelocationRevision(player.relocationRevision),
    replicationSequence,
    moving: player.moving,
    targetLat: player.targetLat,
    targetLon: player.targetLon
  };
}

function interpolateSamples(
  samples: readonly AuthoritativePlayerSample[],
  renderServerTimeMs: number
): RenderedPlayerPosition {
  const first = samples[0]!;
  if (renderServerTimeMs <= first.playbackTimeMs) {
    return renderedPositionFromSample(first);
  }
  for (let index = 1; index < samples.length; index += 1) {
    const next = samples[index]!;
    if (renderServerTimeMs > next.playbackTimeMs) {
      continue;
    }
    const previous = samples[index - 1]!;
    const durationMs = next.playbackTimeMs - previous.playbackTimeMs;
    const progress = durationMs <= 0
      ? 1
      : Math.min(1, Math.max(0, (renderServerTimeMs - previous.playbackTimeMs) / durationMs));
    return {
      ...interpolateLatLon(previous, next, progress),
      anchorLat: next.anchorLat,
      anchorLon: next.anchorLon
    };
  }
  return renderedPositionFromSample(samples.at(-1)!);
}

function interpolateRenderedPositions(
  from: RenderedPlayerPosition,
  to: RenderedPlayerPosition,
  progress: number
): RenderedPlayerPosition {
  return {
    ...interpolateLatLon(from, to, progress),
    anchorLat: to.anchorLat,
    anchorLon: to.anchorLon
  };
}

function renderedPositionFromSample(sample: AuthoritativePlayerSample): RenderedPlayerPosition {
  return {
    lat: sample.lat,
    lon: sample.lon,
    anchorLat: sample.anchorLat,
    anchorLon: sample.anchorLon
  };
}

function sampleTarget(sample: AuthoritativePlayerSample | null): LatLon | null {
  return !sample || sample.targetLat === null || sample.targetLon === null
    ? null
    : { lat: sample.targetLat, lon: sample.targetLon };
}

function isLaterSequence(current: number | null, previous: number | null): boolean {
  return current !== null && (previous === null || current > previous);
}

function samePosition(
  left: RenderedPlayerPosition | null,
  right: RenderedPlayerPosition
): boolean {
  return left !== null &&
    left.lat === right.lat &&
    left.lon === right.lon &&
    left.anchorLat === right.anchorLat &&
    left.anchorLon === right.anchorLon;
}

function sameCoordinates(left: LatLon, right: LatLon): boolean {
  return left.lat === right.lat && left.lon === right.lon;
}

function isStaticDiscontinuity(
  previous: AuthoritativePlayerSample,
  current: AuthoritativePlayerSample
): boolean {
  return previous.regionCode !== current.regionCode ||
    previous.zoneId !== current.zoneId ||
    previous.anchorLat !== current.anchorLat ||
    previous.anchorLon !== current.anchorLon;
}

function isValidSample(sample: AuthoritativePlayerSample): boolean {
  const targetIsNull = sample.targetLat === null && sample.targetLon === null;
  return Number.isFinite(sample.serverTimeMs) &&
    Number.isFinite(sample.playbackTimeMs) &&
    Number.isSafeInteger(sample.relocationRevision) &&
    sample.relocationRevision >= 0 &&
    isFiniteLatLon(sample.lat, sample.lon) &&
    isFiniteLatLon(sample.anchorLat, sample.anchorLon) &&
    (targetIsNull || isFiniteLatLon(sample.targetLat, sample.targetLon));
}

function normalizeRelocationRevision(value: number | undefined, fallback = 0): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}

function traceOutcomeForSample(result: SampleApplyResult): MovementTraceOutcome {
  if (result === "ignored") {
    return "ignored";
  }
  if (result === "snapped") {
    return "snapped";
  }
  return "accepted";
}

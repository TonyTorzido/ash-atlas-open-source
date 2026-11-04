export type LoadMilestoneName =
  | "app mounted"
  | "game entered"
  | "map creation started"
  | "map load"
  | "base map painted"
  | "pixi overlay initialized"
  | "websocket connected"
  | "welcome received"
  | "first player snapshot"
  | "first flags snapshot"
  | "flags snapshot committed"
  | "initial presentation ready";

export type ServerDeltaKind = "player" | "combat";

type OverlayWindowMark = {
  frames: number;
  dynamicCount: number;
  dynamicMs: number;
  renderCount: number;
  renderMs: number;
  staticRedraws: number;
  liveStaticRedraws: number;
  gameAppRenders: number;
  activeMs: number;
  atMs: number;
  drawMap: number;
  drawPixi: number;
  zoomMs: number;
  moveMs: number;
  travelMs: number;
  renderReasons: Map<string, number>;
};

/** Which WebGL context a draw call belongs to. */
export type GlContextKind = "map" | "pixi" | "other";

/** Accumulates the time a boolean condition was true, including a span still open. */
class ActivityTimer {
  private since: number | null = null;
  private total = 0;
  set(active: boolean, now: number): void {
    if (active && this.since === null) this.since = now;
    else if (!active && this.since !== null) {
      this.total += now - this.since;
      this.since = null;
    }
  }
  read(now: number): number {
    return this.total + (this.since === null ? 0 : now - this.since);
  }
}

export type OverlayWindow = {
  frames: number;
  dynamicOverlayUpdateMsPerFrame: number;
  pixiRenderCallMsPerFrame: number;
  pixiRenderCallsPerFrame: number;
  staticOverlayRedraws: number;
  /** Of `staticOverlayRedraws`, the ones drawn by the flag-travel live pass. */
  liveStaticOverlayRedraws: number;
  /** Largest static redraw within this window. */
  maxStaticOverlayDrawMs: number;
  gameAppRenders: number;
  windowMs: number;
  /** Sum of frame intervals up to 100 ms: time the app was actually rendering. */
  activeMs: number;
  drawMapPerFrame: number;
  drawPixiPerFrame: number;
  zoomMs: number;
  moveMs: number;
  travelMs: number;
  /** Top GameApp render reasons in this window, most frequent first. */
  renderReasons: Array<[string, number]>;
};

export type CameraFollowSkipReason = "dragging" | "zooming" | "close-enough" | "interval";

export type LoadMilestone = {
  name: LoadMilestoneName;
  atMs: number;
  elapsedMs: number;
};

export type PerfSnapshot = {
  frameCount: number;
  frameTimeTotalMs: number;
  fps: number;
  averageFrameMs: number;
  worstFrameMs: number;
  worstRecentFrameMs: number;
  frameBudgetMissesOver16Ms: number;
  frameBudgetMissesOver33Ms: number;
  longFrameCount: number;
  longFramesOver50Ms: number;
  longFramesOver100Ms: number;
  sampleWindowMs: number;
  lastLongFrameReason: string | null;
  mapRenderEventsReceived: number;
  mapRenderEventsPerSec: number;
  mapMoving: boolean;
  mapZooming: boolean;
  cameraEaseToPerSec: number;
  cameraEaseToCount: number;
  cameraRecenterCount: number;
  cameraSuppressedDraggingCount: number;
  cameraSuppressedZoomingCount: number;
  cameraSkippedCloseEnoughCount: number;
  cameraSkippedIntervalCount: number;
  playerSnapshotCount: number;
  flagSnapshotCount: number;
  totalWsMessageCount: number;
  playerSnapshotsPerSec: number;
  flagSnapshotsPerSec: number;
  websocketSnapshotsPerSec: number;
  totalWsMessagesPerSec: number;
  gameAppRenderCount: number;
  gameAppRendersPerSec: number;
  wsBytesTotal: number;
  wsBytesPerSec: number;
  drawCallsTotal: number;
  drawCallsPerFrame: number;
  textureCount: number;
  textureBytes: number;
  jsHeapBytes: number | null;
  eventLoopLagMs: number;
  devicePixelRatio: number;
  overlayResolution: number | null;
  collectibleCount: number;
  collectibleCountMax: number;
  collectibleRedrawCount: number;
  collectibleRedrawsPerSec: number;
  collectibleDrawMs: number;
  maxCollectibleDrawMs: number;
  collectibleSnapshotCount: number;
  collectibleSnapshotsPerSec: number;
  collectibleSnapshotNodeCount: number;
  collectibleSnapshotNodeCountMax: number;
  staticOverlayRedrawCount: number;
  staticOverlayRedrawsPerSec: number;
  staticOverlaySkippedDuringInteractionCount: number;
  territoryRedrawCount: number;
  maxStaticOverlayDrawMs: number;
  dynamicOverlayUpdateCount: number;
  dynamicOverlayUpdateMs: number;
  maxDynamicOverlayUpdateMs: number;
  pixiRenderCallCount: number;
  pixiRenderCallMs: number;
  maxPixiRenderCallMs: number;
  lastLocalMovementFrameMs: number;
  maxLocalMovementFrameMs: number;
  localMovementDiscardedMs: number;
  localPredictionLeadM: number;
  maxLocalPredictionLeadM: number;
  localAuthorityAgeMs: number | null;
  maxLocalAuthorityAgeMs: number;
  localLeadCapHoldCount: number;
  waterHighlightCount: number;
  waterHighlightCountMax: number;
  inventorySnapshotCount: number;
  inventorySnapshotsPerSec: number;
  surveyRequestCount: number;
  surveyRequestsPerSec: number;
  lastSurveyResponseMs: number | null;
  maxSurveyResponseMs: number;
  lastSnapshotAgeMs: number | null;
  websocketReadyState: number | null;
  websocketReconnectCount: number;
  websocketMalformedJsonCount: number;
  websocketMalformedFrameCount: number;
  websocketUnknownFrameCount: number;
  websocketIncompatibleProtocolCount: number;
  websocketSendClosedCount: number;
  websocketSendFailedCount: number;
  websocketStaleEventCount: number;
  visibleFlagCount: number;
  combatEntityCount: number;
  retainedDisplayObjectCount: number;
  selectedFlagId: string | null;
  loadMilestones: LoadMilestone[];
};

export type FrameTimeHistogram = Readonly<{
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  over50Ms: number;
  over100Ms: number;
}>;

export type TextureStats = Readonly<{ count: number; bytes: number }>;

type RateTotals = {
  frames: number;
  mapRenderEvents: number;
  cameraEaseTo: number;
  playerSnapshots: number;
  flagSnapshots: number;
  collectibleSnapshots: number;
  inventorySnapshots: number;
  totalWsMessages: number;
  gameAppRenders: number;
  wsBytes: number;
  drawCalls: number;
  collectibleRedraws: number;
  staticOverlayRedraws: number;
  surveyRequests: number;
};

type RateSample = {
  atMs: number;
  totals: RateTotals;
};

type FrameRecord = {
  frameNumber: number;
  frameMs: number;
};

const LONG_FRAME_50_MS = 50;
const ACTIVE_FRAME_MAX_MS = 100;
const LONG_FRAME_100_MS = 100;
const RECENT_FRAME_RECORD_LIMIT = 12_000;

export class PerfMetrics {
  private readonly startedAtMs: number;
  private frameCount = 0;
  private frameTimeTotalMs = 0;
  private worstFrameMs = 0;
  private frameBudgetMissesOver16Ms = 0;
  private frameBudgetMissesOver33Ms = 0;
  private readonly recentFrameRecords: FrameRecord[] = [];
  private longFramesOver50Ms = 0;
  private longFramesOver100Ms = 0;
  private lastLongFrameReason: string | null = null;
  private mapRenderEvents = 0;
  private mapMoving = false;
  private mapZooming = false;
  private cameraEaseToCount = 0;
  private cameraRecenterCount = 0;
  private cameraSuppressedDraggingCount = 0;
  private cameraSuppressedZoomingCount = 0;
  private cameraSkippedCloseEnoughCount = 0;
  private cameraSkippedIntervalCount = 0;
  private playerSnapshots = 0;
  private flagSnapshots = 0;
  private collectibleSnapshots = 0;
  private inventorySnapshots = 0;
  private totalWsMessages = 0;
  private gameAppRenders = 0;
  private wsBytes = 0;
  private drawCalls = 0;
  private eventLoopLagMs = 0;
  private lastRttMs: number | null = null;
  private swingsSent = 0;
  private keyIgnored = new Map<string, number>();
  private swingPressToResultMs: number[] = [];
  private swingPredictedHits = 0;
  private swingCancelledHits = 0;
  private swingDrawCalls = 0;
  private readonly lastServerDeltaAtMs: Record<ServerDeltaKind, number | null> = { player: null, combat: null };
  private readonly serverDeltaGapsMs: Record<ServerDeltaKind, number[]> = { player: [], combat: [] };
  private readonly overlayWindowMarks = new Map<string, OverlayWindowMark>();
  private overlayResolution: number | null = null;
  private textureStatsProvider: (() => TextureStats) | null = null;
  private collectibleCount = 0;
  private collectibleCountMax = 0;
  private collectibleRedrawCount = 0;
  private collectibleDrawMs = 0;
  private maxCollectibleDrawMs = 0;
  private staticOverlayRedrawCount = 0;
  private staticOverlaySkippedDuringInteractionCount = 0;
  private territoryRedrawCount = 0;
  private maxStaticOverlayDrawMs = 0;
  private liveStaticOverlayRedrawCount = 0;
  private readonly windowStaticMaxMs = new Map<string, number>();
  private activeFrameMs = 0;
  private drawCallsMap = 0;
  private drawCallsPixi = 0;
  private readonly glKinds = new WeakMap<object, GlContextKind>();
  private readonly zoomTimer = new ActivityTimer();
  private readonly moveTimer = new ActivityTimer();
  private readonly travelTimer = new ActivityTimer();
  private renderReasons = new Map<string, number>();
  private worldMapOpenTag = false;
  private locationModeTag = "world";
  private dynamicOverlayUpdateCount = 0;
  private dynamicOverlayUpdateMs = 0;
  private maxDynamicOverlayUpdateMs = 0;
  private pixiRenderCallCount = 0;
  private pixiRenderCallMs = 0;
  private maxPixiRenderCallMs = 0;
  private lastLocalMovementFrameMs = 0;
  private maxLocalMovementFrameMs = 0;
  private localMovementDiscardedMs = 0;
  private localPredictionLeadM = 0;
  private maxLocalPredictionLeadM = 0;
  private localAuthorityAgeMs: number | null = null;
  private maxLocalAuthorityAgeMs = 0;
  private localLeadCapHoldCount = 0;
  private collectibleSnapshotNodeCount = 0;
  private collectibleSnapshotNodeCountMax = 0;
  private waterHighlightCount = 0;
  private waterHighlightCountMax = 0;
  private surveyRequestCount = 0;
  private lastSurveyResponseMs: number | null = null;
  private maxSurveyResponseMs = 0;
  private lastSnapshotAtMs: number | null = null;
  private websocketReadyState: number | null = null;
  private websocketReconnectCount = 0;
  private websocketMalformedJsonCount = 0;
  private websocketMalformedFrameCount = 0;
  private websocketUnknownFrameCount = 0;
  private websocketIncompatibleProtocolCount = 0;
  private websocketSendClosedCount = 0;
  private websocketSendFailedCount = 0;
  private websocketStaleEventCount = 0;
  private visibleFlagCount = 0;
  private combatEntityCount = 0;
  private retainedDisplayObjectCount = 0;
  private selectedFlagId: string | null = null;
  private readonly loadMilestones = new Map<LoadMilestoneName, number>();
  private readonly rateSamples = new Map<string, RateSample>();
  private readonly frameHistogramCursors = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAtMs = now();
    this.rateSamples.set("default", {
      atMs: this.startedAtMs,
      totals: this.currentRateTotals()
    });
  }

  markLoadMilestone(name: LoadMilestoneName): void {
    if (!this.loadMilestones.has(name)) {
      this.loadMilestones.set(name, this.now());
    }
  }

  noteFrame(frameMs: number, reason: string): void {
    this.frameCount += 1;
    this.recentFrameRecords.push({
      frameNumber: this.frameCount,
      frameMs
    });
    if (this.recentFrameRecords.length > RECENT_FRAME_RECORD_LIMIT) {
      this.recentFrameRecords.splice(0, this.recentFrameRecords.length - RECENT_FRAME_RECORD_LIMIT);
    }
    this.frameTimeTotalMs += frameMs;
    if (frameMs <= ACTIVE_FRAME_MAX_MS) this.activeFrameMs += frameMs;
    this.worstFrameMs = Math.max(this.worstFrameMs, frameMs);
    if (frameMs > 16) {
      this.frameBudgetMissesOver16Ms += 1;
    }
    if (frameMs > 33) {
      this.frameBudgetMissesOver33Ms += 1;
    }
    if (frameMs > LONG_FRAME_50_MS) {
      this.longFramesOver50Ms += 1;
      this.lastLongFrameReason = reason;
    }
    if (frameMs > LONG_FRAME_100_MS) {
      this.longFramesOver100Ms += 1;
      this.lastLongFrameReason = reason;
    }
  }

  noteMapRenderEvent(): void {
    this.mapRenderEvents += 1;
  }

  setMapActivity(input: { moving?: boolean; zooming?: boolean }): void {
    if (input.moving !== undefined) {
      this.mapMoving = input.moving;
      this.moveTimer.set(input.moving, this.now());
    }
    if (input.zooming !== undefined) {
      this.mapZooming = input.zooming;
      this.zoomTimer.set(input.zooming, this.now());
    }
  }

  noteCameraEaseTo(): void {
    this.cameraEaseToCount += 1;
  }

  noteCameraRecenter(): void {
    this.cameraRecenterCount += 1;
  }

  noteCameraFollowSkip(reason: CameraFollowSkipReason): void {
    if (reason === "dragging") {
      this.cameraSuppressedDraggingCount += 1;
      return;
    }
    if (reason === "zooming") {
      this.cameraSuppressedZoomingCount += 1;
      return;
    }
    if (reason === "close-enough") {
      this.cameraSkippedCloseEnoughCount += 1;
      return;
    }
    this.cameraSkippedIntervalCount += 1;
  }

  notePlayerSnapshot(): void {
    this.playerSnapshots += 1;
    this.lastSnapshotAtMs = this.now();
  }

  noteFlagsSnapshot(): void {
    this.flagSnapshots += 1;
    this.lastSnapshotAtMs = this.now();
  }

  noteCollectibleSnapshot(nodeCount: number): void {
    this.collectibleSnapshots += 1;
    this.collectibleSnapshotNodeCount = nodeCount;
    this.collectibleSnapshotNodeCountMax = Math.max(this.collectibleSnapshotNodeCountMax, nodeCount);
    this.lastSnapshotAtMs = this.now();
  }

  noteInventorySnapshot(): void {
    this.inventorySnapshots += 1;
  }

  noteCollectibleRedraw(drawMs: number): void {
    this.collectibleRedrawCount += 1;
    this.collectibleDrawMs += drawMs;
    this.maxCollectibleDrawMs = Math.max(this.maxCollectibleDrawMs, drawMs);
  }

  noteStaticOverlayRedraw(drawMs: number, scope: "full" | "flag-travel-live" = "full"): void {
    this.staticOverlayRedrawCount += 1;
    if (scope === "flag-travel-live") this.liveStaticOverlayRedrawCount += 1;
    this.maxStaticOverlayDrawMs = Math.max(this.maxStaticOverlayDrawMs, drawMs);
    for (const [key, max] of this.windowStaticMaxMs) {
      if (drawMs > max) this.windowStaticMaxMs.set(key, drawMs);
    }
  }

  /** True while a flag-travel presentation runs; feeds the `travelMs` window tag. */
  setFlagTravelActive(active: boolean): void {
    this.travelTimer.set(active, this.now());
  }

  /** Where the player is looking: carried on the probe sample so windows can be filtered. */
  setContextTags(tags: { worldMapOpen: boolean; locationMode: string }): void {
    this.worldMapOpenTag = tags.worldMapOpen;
    this.locationModeTag = tags.locationMode;
  }

  getContextTags(): { worldMapOpen: boolean; locationMode: string } {
    return { worldMapOpen: this.worldMapOpenTag, locationMode: this.locationModeTag };
  }

  /** Tags a canvas' WebGL context so draw calls can be split between MapLibre and Pixi. */
  registerGlCanvas(canvas: object, kind: GlContextKind): void {
    this.glKinds.set(canvas, kind);
  }

  /** Why GameApp re-rendered: one bump per changed suspect value. */
  noteRenderReason(reason: string): void {
    this.renderReasons.set(reason, (this.renderReasons.get(reason) ?? 0) + 1);
  }

  noteStaticOverlaySkippedDuringInteraction(): void {
    this.staticOverlaySkippedDuringInteractionCount += 1;
  }

  noteDynamicOverlayUpdate(updateMs: number): void {
    this.dynamicOverlayUpdateCount += 1;
    this.dynamicOverlayUpdateMs += updateMs;
    this.maxDynamicOverlayUpdateMs = Math.max(this.maxDynamicOverlayUpdateMs, updateMs);
  }

  notePixiRenderCall(renderCallMs: number): void {
    this.pixiRenderCallCount += 1;
    this.pixiRenderCallMs += renderCallMs;
    this.maxPixiRenderCallMs = Math.max(this.maxPixiRenderCallMs, renderCallMs);
  }

  noteLocalMovementFrame(
    rawFrameMs: number,
    discardedFrameMs: number,
    predictionLeadM: number,
    authorityAgeMs: number | null,
    leadCapHeld: boolean
  ): void {
    this.lastLocalMovementFrameMs = rawFrameMs;
    this.maxLocalMovementFrameMs = Math.max(this.maxLocalMovementFrameMs, rawFrameMs);
    this.localMovementDiscardedMs += discardedFrameMs;
    this.localPredictionLeadM = predictionLeadM;
    this.maxLocalPredictionLeadM = Math.max(this.maxLocalPredictionLeadM, predictionLeadM);
    this.localAuthorityAgeMs = authorityAgeMs;
    if (authorityAgeMs !== null) {
      this.maxLocalAuthorityAgeMs = Math.max(
        this.maxLocalAuthorityAgeMs,
        authorityAgeMs
      );
    }
    if (leadCapHeld) {
      this.localLeadCapHoldCount = incrementBounded(this.localLeadCapHoldCount);
    }
  }

  noteTerritoryRedraw(): void {
    this.territoryRedrawCount += 1;
  }

  noteSurveyRequest(): void {
    this.surveyRequestCount += 1;
  }

  noteSurveyResponse(durationMs: number): void {
    this.lastSurveyResponseMs = durationMs;
    this.maxSurveyResponseMs = Math.max(this.maxSurveyResponseMs, durationMs);
  }

  noteWebSocketMessage(): void {
    this.totalWsMessages += 1;
  }

  /** Approximate payload size: string length for text frames, byteLength for binary. */
  noteWebSocketBytes(bytes: number): void {
    this.wsBytes += bytes;
  }

  /** Latest websocket ping round trip, from the PONG handler. */
  noteRtt(rttMs: number): void {
    this.lastRttMs = rttMs;
  }

  /** A SWING left the client (action combat). */
  noteSwingSent(): void {
    this.swingsSent += 1;
  }

  /** Mobs a swing showed predicted hit effects on. */
  noteSwingPredictedHits(count: number): void {
    this.swingPredictedHits += count;
  }

  /** Predicted hits the server missed (their effects were cancelled). */
  noteSwingCancelledHits(count: number): void {
    this.swingCancelledHits += count;
  }

  /** Draw-call cost of a frame that drew swing effects (the window keeps the maximum). */
  noteSwingDrawCalls(count: number): void {
    if (count > this.swingDrawCalls) this.swingDrawCalls = count;
  }

  /** A movement key was pressed but ignored; reasons are counted and uploaded with the next perf sample. */
  noteKeyIgnored(reason: string): void {
    const key = reason.slice(0, 80);
    if (!this.keyIgnored.has(key) && this.keyIgnored.size >= 8) return;
    this.keyIgnored.set(key, (this.keyIgnored.get(key) ?? 0) + 1);
  }

  /** "reason:count,..." for movement keys ignored since the previous call (empty when none), then clears the window. */
  takeKeyIgnored(): string {
    const text = [...this.keyIgnored].map(([reason, count]) => `${reason}:${count}`).join(",").slice(0, 200);
    this.keyIgnored.clear();
    return text;
  }

  /** Press to SWING_RESULT round trip of one confirmed swing. */
  noteSwingPressToResult(ms: number): void {
    this.swingPressToResultMs.push(ms);
    if (this.swingPressToResultMs.length > 512) this.swingPressToResultMs.splice(0, 256);
  }

  /** Swings sent and the p95 press-to-result since the previous call, then clears the window. */
  takeSwingStats(): { swings: number; swingPressToResultP95Ms: number | null; swingPredictedHits: number; swingCancelledHits: number; swingDrawCalls: number } {
    const sorted = [...this.swingPressToResultMs].sort((a, b) => a - b);
    const swings = this.swingsSent;
    this.swingsSent = 0;
    this.swingPressToResultMs = [];
    const swingPredictedHits = this.swingPredictedHits;
    const swingCancelledHits = this.swingCancelledHits;
    const swingDrawCalls = this.swingDrawCalls;
    this.swingPredictedHits = 0;
    this.swingCancelledHits = 0;
    this.swingDrawCalls = 0;
    return {
      swings,
      swingPredictedHits,
      swingCancelledHits,
      swingDrawCalls,
      swingPressToResultP95Ms: sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number
    };
  }

  /** Arrival of a server state delta; gaps between same-kind arrivals show server or network jitter. */
  noteServerDelta(kind: ServerDeltaKind): void {
    const now = this.now();
    const last = this.lastServerDeltaAtMs[kind];
    const gaps = this.serverDeltaGapsMs[kind];
    if (last !== null) {
      gaps.push(now - last);
      if (gaps.length > 2_000) gaps.splice(0, 1_000);
    }
    this.lastServerDeltaAtMs[kind] = now;
  }

  /** Returns the latest RTT and the p95 player/combat delta gaps since the previous call, then clears the windows. */
  takeNetworkStats(): {
    rttMs: number | null;
    playerDeltaGapP95Ms: number | null;
    combatDeltaGapP95Ms: number | null;
  } {
    return {
      rttMs: this.lastRttMs,
      playerDeltaGapP95Ms: this.takeGapP95("player"),
      combatDeltaGapP95Ms: this.takeGapP95("combat")
    };
  }

  private takeGapP95(kind: ServerDeltaKind): number | null {
    const gaps = [...this.serverDeltaGapsMs[kind]].sort((a, b) => a - b);
    this.serverDeltaGapsMs[kind].length = 0;
    return gaps.length === 0 ? null : gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] as number;
  }

  /**
   * Overlay cost since the previous call with the same key: the deciding numbers for where frame time goes.
   * `renderCallsPerFrame` near 0 means the idle skip is working; near 1 means the scene is dirty every frame.
   */
  takeOverlayWindow(key: string): OverlayWindow {
    const previous = this.overlayWindowMarks.get(key) ?? {
      frames: 0, dynamicCount: 0, dynamicMs: 0, renderCount: 0, renderMs: 0, staticRedraws: 0,
      liveStaticRedraws: 0, gameAppRenders: 0, activeMs: 0, atMs: this.startedAtMs, drawMap: 0, drawPixi: 0,
      zoomMs: 0, moveMs: 0, travelMs: 0, renderReasons: new Map<string, number>()
    };
    const at = this.now();
    const current: OverlayWindowMark = {
      frames: this.frameCount,
      dynamicCount: this.dynamicOverlayUpdateCount,
      dynamicMs: this.dynamicOverlayUpdateMs,
      renderCount: this.pixiRenderCallCount,
      renderMs: this.pixiRenderCallMs,
      staticRedraws: this.staticOverlayRedrawCount,
      liveStaticRedraws: this.liveStaticOverlayRedrawCount,
      gameAppRenders: this.gameAppRenders,
      activeMs: this.activeFrameMs,
      atMs: at,
      drawMap: this.drawCallsMap,
      drawPixi: this.drawCallsPixi,
      zoomMs: this.zoomTimer.read(at),
      moveMs: this.moveTimer.read(at),
      travelMs: this.travelTimer.read(at),
      renderReasons: new Map(this.renderReasons)
    };
    this.overlayWindowMarks.set(key, current);
    const windowStaticMax = this.windowStaticMaxMs.get(key) ?? 0;
    this.windowStaticMaxMs.set(key, 0);
    const reasons: Array<[string, number]> = [];
    for (const [reason, count] of current.renderReasons) {
      const delta = count - (previous.renderReasons.get(reason) ?? 0);
      if (delta > 0) reasons.push([reason, delta]);
    }
    reasons.sort((a, b) => b[1] - a[1]);
    const frames = current.frames - previous.frames;
    const perFrame = (value: number): number => (frames > 0 ? value / frames : 0);
    return {
      frames,
      dynamicOverlayUpdateMsPerFrame: perFrame(current.dynamicMs - previous.dynamicMs),
      pixiRenderCallMsPerFrame: perFrame(current.renderMs - previous.renderMs),
      pixiRenderCallsPerFrame: perFrame(current.renderCount - previous.renderCount),
      staticOverlayRedraws: current.staticRedraws - previous.staticRedraws,
      liveStaticOverlayRedraws: current.liveStaticRedraws - previous.liveStaticRedraws,
      maxStaticOverlayDrawMs: windowStaticMax,
      gameAppRenders: current.gameAppRenders - previous.gameAppRenders,
      windowMs: current.atMs - previous.atMs,
      activeMs: current.activeMs - previous.activeMs,
      drawMapPerFrame: perFrame(current.drawMap - previous.drawMap),
      drawPixiPerFrame: perFrame(current.drawPixi - previous.drawPixi),
      zoomMs: current.zoomMs - previous.zoomMs,
      moveMs: current.moveMs - previous.moveMs,
      travelMs: current.travelMs - previous.travelMs,
      renderReasons: reasons.slice(0, 5)
    };
  }

  noteGameAppRender(): void {
    this.gameAppRenders += 1;
  }

  /** Reasons noted since the page loaded (only filled while the perf probe is visible). */
  renderReasonCounts(): Array<[string, number]> {
    return [...this.renderReasons];
  }

  gameAppRenderCount(): number {
    return this.gameAppRenders;
  }

  noteDrawCall(canvas?: object | null): void {
    this.drawCalls += 1;
    const kind = canvas ? this.glKindOf(canvas) : "other";
    if (kind === "map") this.drawCallsMap += 1;
    else if (kind === "pixi") this.drawCallsPixi += 1;
  }

  private glKindOf(canvas: object): GlContextKind {
    let kind = this.glKinds.get(canvas);
    if (kind === undefined) {
      const classList = (canvas as { classList?: { contains(name: string): boolean } }).classList;
      kind = classList?.contains("maplibregl-canvas") ? "map" : "other";
      this.glKinds.set(canvas, kind);
    }
    return kind;
  }

  setEventLoopLagMs(lagMs: number): void {
    this.eventLoopLagMs = lagMs;
  }

  setOverlayResolution(resolution: number | null): void {
    this.overlayResolution = resolution;
  }

  setTextureStatsProvider(provider: (() => TextureStats) | null): void {
    this.textureStatsProvider = provider;
  }

  setWebSocketReadyState(readyState: number | null): void {
    this.websocketReadyState = readyState;
  }

  noteWebSocketReconnect(): void {
    this.websocketReconnectCount = incrementBounded(this.websocketReconnectCount);
  }

  noteWebSocketProtocolFailure(
    kind: "malformed-json" | "malformed-frame" | "unknown-frame" | "incompatible-protocol"
  ): void {
    if (kind === "malformed-json") {
      this.websocketMalformedJsonCount = incrementBounded(this.websocketMalformedJsonCount);
    } else if (kind === "malformed-frame") {
      this.websocketMalformedFrameCount = incrementBounded(this.websocketMalformedFrameCount);
    } else if (kind === "unknown-frame") {
      this.websocketUnknownFrameCount = incrementBounded(this.websocketUnknownFrameCount);
    } else {
      this.websocketIncompatibleProtocolCount = incrementBounded(
        this.websocketIncompatibleProtocolCount
      );
    }
  }

  noteWebSocketSendFailure(kind: "closed" | "failed"): void {
    if (kind === "closed") {
      this.websocketSendClosedCount = incrementBounded(this.websocketSendClosedCount);
    } else {
      this.websocketSendFailedCount = incrementBounded(this.websocketSendFailedCount);
    }
  }

  noteWebSocketStaleEvent(): void {
    this.websocketStaleEventCount = incrementBounded(this.websocketStaleEventCount);
  }

  setVisibleFlagCount(count: number): void {
    this.visibleFlagCount = count;
  }

  setCombatEntityCount(count: number): void {
    this.combatEntityCount = count;
  }

  setRetainedDisplayObjectCount(count: number): void {
    this.retainedDisplayObjectCount = count;
  }

  setCollectibleCount(count: number): void {
    this.collectibleCount = count;
    this.collectibleCountMax = Math.max(this.collectibleCountMax, count);
  }

  setWaterHighlightCount(count: number): void {
    this.waterHighlightCount = count;
    this.waterHighlightCountMax = Math.max(this.waterHighlightCountMax, count);
  }

  setSelectedFlagId(flagId: string | null): void {
    this.selectedFlagId = flagId;
  }

  resetCounters(): void {
    this.frameCount = 0;
    this.frameTimeTotalMs = 0;
    this.worstFrameMs = 0;
    this.frameBudgetMissesOver16Ms = 0;
    this.frameBudgetMissesOver33Ms = 0;
    this.recentFrameRecords.length = 0;
    this.longFramesOver50Ms = 0;
    this.longFramesOver100Ms = 0;
    this.lastLongFrameReason = null;
    this.mapRenderEvents = 0;
    this.cameraEaseToCount = 0;
    this.cameraRecenterCount = 0;
    this.cameraSuppressedDraggingCount = 0;
    this.cameraSuppressedZoomingCount = 0;
    this.cameraSkippedCloseEnoughCount = 0;
    this.cameraSkippedIntervalCount = 0;
    this.playerSnapshots = 0;
    this.flagSnapshots = 0;
    this.collectibleSnapshots = 0;
    this.inventorySnapshots = 0;
    this.totalWsMessages = 0;
    this.gameAppRenders = 0;
    this.wsBytes = 0;
    this.drawCalls = 0;
    this.collectibleCountMax = this.collectibleCount;
    this.collectibleRedrawCount = 0;
    this.collectibleDrawMs = 0;
    this.maxCollectibleDrawMs = 0;
    this.staticOverlayRedrawCount = 0;
    this.staticOverlaySkippedDuringInteractionCount = 0;
    this.territoryRedrawCount = 0;
    this.maxStaticOverlayDrawMs = 0;
    this.dynamicOverlayUpdateCount = 0;
    this.dynamicOverlayUpdateMs = 0;
    this.maxDynamicOverlayUpdateMs = 0;
    this.pixiRenderCallCount = 0;
    this.pixiRenderCallMs = 0;
    this.maxPixiRenderCallMs = 0;
    this.lastLocalMovementFrameMs = 0;
    this.maxLocalMovementFrameMs = 0;
    this.localMovementDiscardedMs = 0;
    this.localPredictionLeadM = 0;
    this.maxLocalPredictionLeadM = 0;
    this.localAuthorityAgeMs = null;
    this.maxLocalAuthorityAgeMs = 0;
    this.localLeadCapHoldCount = 0;
    this.collectibleSnapshotNodeCount = 0;
    this.collectibleSnapshotNodeCountMax = 0;
    this.waterHighlightCountMax = this.waterHighlightCount;
    this.surveyRequestCount = 0;
    this.lastSurveyResponseMs = null;
    this.maxSurveyResponseMs = 0;
    this.lastSnapshotAtMs = null;
    this.websocketReconnectCount = 0;
    this.websocketMalformedJsonCount = 0;
    this.websocketMalformedFrameCount = 0;
    this.websocketUnknownFrameCount = 0;
    this.websocketIncompatibleProtocolCount = 0;
    this.websocketSendClosedCount = 0;
    this.websocketSendFailedCount = 0;
    this.websocketStaleEventCount = 0;
    this.frameHistogramCursors.clear();
    this.resetRateSamples();
  }

  resetRateSample(sampleKey = "default"): void {
    this.rateSamples.set(sampleKey, {
      atMs: this.now(),
      totals: this.currentRateTotals()
    });
  }

  getSnapshot(sampleKey = "default"): PerfSnapshot {
    const now = this.now();
    const previousSample = this.rateSamples.get(sampleKey) ?? {
      atMs: this.startedAtMs,
      totals: this.emptyRateTotals()
    };
    const sampleWindowMs = Math.max(now - previousSample.atMs, 1);
    const elapsedSeconds = sampleWindowMs / 1_000;
    const currentTotals = this.currentRateTotals();
    const fps = (currentTotals.frames - previousSample.totals.frames) / elapsedSeconds;
    const mapRenderEventsPerSec =
      (currentTotals.mapRenderEvents - previousSample.totals.mapRenderEvents) / elapsedSeconds;
    const cameraEaseToPerSec =
      (currentTotals.cameraEaseTo - previousSample.totals.cameraEaseTo) / elapsedSeconds;
    const playerSnapshotsPerSec =
      (currentTotals.playerSnapshots - previousSample.totals.playerSnapshots) / elapsedSeconds;
    const flagSnapshotsPerSec =
      (currentTotals.flagSnapshots - previousSample.totals.flagSnapshots) / elapsedSeconds;
    const collectibleSnapshotsPerSec =
      (currentTotals.collectibleSnapshots - previousSample.totals.collectibleSnapshots) /
      elapsedSeconds;
    const inventorySnapshotsPerSec =
      (currentTotals.inventorySnapshots - previousSample.totals.inventorySnapshots) /
      elapsedSeconds;
    const totalWsMessagesPerSec =
      (currentTotals.totalWsMessages - previousSample.totals.totalWsMessages) / elapsedSeconds;
    const gameAppRendersPerSec =
      (currentTotals.gameAppRenders - previousSample.totals.gameAppRenders) / elapsedSeconds;
    const wsBytesPerSec = (currentTotals.wsBytes - previousSample.totals.wsBytes) / elapsedSeconds;
    const framesInWindow = currentTotals.frames - previousSample.totals.frames;
    const drawCallsPerFrame = framesInWindow > 0
      ? (currentTotals.drawCalls - previousSample.totals.drawCalls) / framesInWindow
      : 0;
    const textureStats = this.textureStatsProvider?.() ?? { count: 0, bytes: 0 };
    const collectibleRedrawsPerSec =
      (currentTotals.collectibleRedraws - previousSample.totals.collectibleRedraws) /
      elapsedSeconds;
    const staticOverlayRedrawsPerSec =
      (currentTotals.staticOverlayRedraws - previousSample.totals.staticOverlayRedraws) /
      elapsedSeconds;
    const surveyRequestsPerSec =
      (currentTotals.surveyRequests - previousSample.totals.surveyRequests) / elapsedSeconds;
    const worstRecentFrameMs = this.worstRecentFrameMs(previousSample.totals.frames);

    this.rateSamples.set(sampleKey, {
      atMs: now,
      totals: currentTotals
    });

    return {
      frameCount: this.frameCount,
      frameTimeTotalMs: this.frameTimeTotalMs,
      fps,
      averageFrameMs: this.frameCount === 0 ? 0 : this.frameTimeTotalMs / this.frameCount,
      worstFrameMs: this.worstFrameMs,
      worstRecentFrameMs,
      frameBudgetMissesOver16Ms: this.frameBudgetMissesOver16Ms,
      frameBudgetMissesOver33Ms: this.frameBudgetMissesOver33Ms,
      longFrameCount: this.longFramesOver50Ms,
      longFramesOver50Ms: this.longFramesOver50Ms,
      longFramesOver100Ms: this.longFramesOver100Ms,
      sampleWindowMs,
      lastLongFrameReason: this.lastLongFrameReason,
      mapRenderEventsReceived: this.mapRenderEvents,
      mapRenderEventsPerSec,
      mapMoving: this.mapMoving,
      mapZooming: this.mapZooming,
      cameraEaseToPerSec,
      cameraEaseToCount: this.cameraEaseToCount,
      cameraRecenterCount: this.cameraRecenterCount,
      cameraSuppressedDraggingCount: this.cameraSuppressedDraggingCount,
      cameraSuppressedZoomingCount: this.cameraSuppressedZoomingCount,
      cameraSkippedCloseEnoughCount: this.cameraSkippedCloseEnoughCount,
      cameraSkippedIntervalCount: this.cameraSkippedIntervalCount,
      playerSnapshotCount: this.playerSnapshots,
      flagSnapshotCount: this.flagSnapshots,
      totalWsMessageCount: this.totalWsMessages,
      playerSnapshotsPerSec,
      flagSnapshotsPerSec,
      websocketSnapshotsPerSec:
        playerSnapshotsPerSec + flagSnapshotsPerSec + collectibleSnapshotsPerSec,
      totalWsMessagesPerSec,
      gameAppRenderCount: this.gameAppRenders,
      gameAppRendersPerSec,
      wsBytesTotal: this.wsBytes,
      wsBytesPerSec,
      drawCallsTotal: this.drawCalls,
      drawCallsPerFrame,
      textureCount: textureStats.count,
      textureBytes: textureStats.bytes,
      jsHeapBytes: readJsHeapBytes(),
      eventLoopLagMs: this.eventLoopLagMs,
      devicePixelRatio: globalThis.devicePixelRatio || 1,
      overlayResolution: this.overlayResolution,
      collectibleCount: this.collectibleCount,
      collectibleCountMax: this.collectibleCountMax,
      collectibleRedrawCount: this.collectibleRedrawCount,
      collectibleRedrawsPerSec,
      collectibleDrawMs: this.collectibleDrawMs,
      maxCollectibleDrawMs: this.maxCollectibleDrawMs,
      collectibleSnapshotCount: this.collectibleSnapshots,
      collectibleSnapshotsPerSec,
      collectibleSnapshotNodeCount: this.collectibleSnapshotNodeCount,
      collectibleSnapshotNodeCountMax: this.collectibleSnapshotNodeCountMax,
      staticOverlayRedrawCount: this.staticOverlayRedrawCount,
      staticOverlayRedrawsPerSec,
      staticOverlaySkippedDuringInteractionCount:
        this.staticOverlaySkippedDuringInteractionCount,
      territoryRedrawCount: this.territoryRedrawCount,
      maxStaticOverlayDrawMs: this.maxStaticOverlayDrawMs,
      dynamicOverlayUpdateCount: this.dynamicOverlayUpdateCount,
      dynamicOverlayUpdateMs: this.dynamicOverlayUpdateMs,
      maxDynamicOverlayUpdateMs: this.maxDynamicOverlayUpdateMs,
      pixiRenderCallCount: this.pixiRenderCallCount,
      pixiRenderCallMs: this.pixiRenderCallMs,
      maxPixiRenderCallMs: this.maxPixiRenderCallMs,
      lastLocalMovementFrameMs: this.lastLocalMovementFrameMs,
      maxLocalMovementFrameMs: this.maxLocalMovementFrameMs,
      localMovementDiscardedMs: this.localMovementDiscardedMs,
      localPredictionLeadM: this.localPredictionLeadM,
      maxLocalPredictionLeadM: this.maxLocalPredictionLeadM,
      localAuthorityAgeMs: this.localAuthorityAgeMs,
      maxLocalAuthorityAgeMs: this.maxLocalAuthorityAgeMs,
      localLeadCapHoldCount: this.localLeadCapHoldCount,
      waterHighlightCount: this.waterHighlightCount,
      waterHighlightCountMax: this.waterHighlightCountMax,
      inventorySnapshotCount: this.inventorySnapshots,
      inventorySnapshotsPerSec,
      surveyRequestCount: this.surveyRequestCount,
      surveyRequestsPerSec,
      lastSurveyResponseMs: this.lastSurveyResponseMs,
      maxSurveyResponseMs: this.maxSurveyResponseMs,
      lastSnapshotAgeMs: this.lastSnapshotAtMs === null ? null : now - this.lastSnapshotAtMs,
      websocketReadyState: this.websocketReadyState,
      websocketReconnectCount: this.websocketReconnectCount,
      websocketMalformedJsonCount: this.websocketMalformedJsonCount,
      websocketMalformedFrameCount: this.websocketMalformedFrameCount,
      websocketUnknownFrameCount: this.websocketUnknownFrameCount,
      websocketIncompatibleProtocolCount: this.websocketIncompatibleProtocolCount,
      websocketSendClosedCount: this.websocketSendClosedCount,
      websocketSendFailedCount: this.websocketSendFailedCount,
      websocketStaleEventCount: this.websocketStaleEventCount,
      visibleFlagCount: this.visibleFlagCount,
      combatEntityCount: this.combatEntityCount,
      retainedDisplayObjectCount: this.retainedDisplayObjectCount,
      selectedFlagId: this.selectedFlagId,
      loadMilestones: this.loadMilestonesSnapshot()
    };
  }

  getFrameTimeHistogram(sampleKey = "default"): FrameTimeHistogram {
    const previousFrame = this.frameHistogramCursors.get(sampleKey) ?? 0;
    const values = this.recentFrameRecords
      .filter((record) => record.frameNumber > previousFrame)
      .map((record) => record.frameMs)
      .sort((left, right) => left - right);
    this.frameHistogramCursors.set(sampleKey, this.frameCount);
    if (values.length === 0) {
      return {
        count: 0,
        meanMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        over50Ms: 0,
        over100Ms: 0
      };
    }
    return {
      count: values.length,
      meanMs: values.reduce((total, value) => total + value, 0) / values.length,
      p50Ms: framePercentile(values, 0.5),
      p95Ms: framePercentile(values, 0.95),
      p99Ms: framePercentile(values, 0.99),
      maxMs: values.at(-1) ?? 0,
      over50Ms: values.filter((value) => value > LONG_FRAME_50_MS).length,
      over100Ms: values.filter((value) => value > LONG_FRAME_100_MS).length
    };
  }

  private currentRateTotals(): RateTotals {
    return {
      frames: this.frameCount,
      mapRenderEvents: this.mapRenderEvents,
      cameraEaseTo: this.cameraEaseToCount,
      playerSnapshots: this.playerSnapshots,
      flagSnapshots: this.flagSnapshots,
      collectibleSnapshots: this.collectibleSnapshots,
      inventorySnapshots: this.inventorySnapshots,
      totalWsMessages: this.totalWsMessages,
      gameAppRenders: this.gameAppRenders,
      wsBytes: this.wsBytes,
      drawCalls: this.drawCalls,
      collectibleRedraws: this.collectibleRedrawCount,
      staticOverlayRedraws: this.staticOverlayRedrawCount,
      surveyRequests: this.surveyRequestCount
    };
  }

  private emptyRateTotals(): RateTotals {
    return {
      frames: 0,
      mapRenderEvents: 0,
      cameraEaseTo: 0,
      playerSnapshots: 0,
      flagSnapshots: 0,
      collectibleSnapshots: 0,
      inventorySnapshots: 0,
      totalWsMessages: 0,
      gameAppRenders: 0,
      wsBytes: 0,
      drawCalls: 0,
      collectibleRedraws: 0,
      staticOverlayRedraws: 0,
      surveyRequests: 0
    };
  }

  private worstRecentFrameMs(previousFrameCount: number): number {
    return this.recentFrameRecords.reduce(
      (max, frame) => (frame.frameNumber > previousFrameCount ? Math.max(max, frame.frameMs) : max),
      0
    );
  }

  private resetRateSamples(): void {
    const now = this.now();
    const totals = this.currentRateTotals();
    const keys = this.rateSamples.size === 0 ? ["default"] : [...this.rateSamples.keys()];
    this.rateSamples.clear();
    for (const key of keys) {
      this.rateSamples.set(key, {
        atMs: now,
        totals
      });
    }
  }

  private loadMilestonesSnapshot(): LoadMilestone[] {
    const appMountedAt = this.loadMilestones.get("app mounted") ?? null;
    return [...this.loadMilestones.entries()].map(([name, atMs]) => ({
      name,
      atMs,
      elapsedMs: appMountedAt === null ? 0 : atMs - appMountedAt
    }));
  }
}

function readJsHeapBytes(): number | null {
  const memory = (globalThis.performance as (Performance & {
    memory?: { usedJSHeapSize?: number };
  }) | undefined)?.memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
}

function incrementBounded(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function framePercentile(values: readonly number[], rank: number): number {
  return values[
    Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1))
  ] ?? 0;
}

export const perfMetrics = new PerfMetrics();

export function formatPerfSummary(snapshot: PerfSnapshot): string {
  const snapshotAge =
    snapshot.lastSnapshotAgeMs === null ? "unknown" : `${snapshot.lastSnapshotAgeMs.toFixed(0)}ms`;
  return [
    `fps=${snapshot.fps.toFixed(1)}`,
    `avg=${snapshot.averageFrameMs.toFixed(1)}ms`,
    `worst=${snapshot.worstFrameMs.toFixed(1)}ms`,
    `recentWorst=${snapshot.worstRecentFrameMs.toFixed(1)}ms`,
    `miss16=${snapshot.frameBudgetMissesOver16Ms}`,
    `miss33=${snapshot.frameBudgetMissesOver33Ms}`,
    `long>50=${snapshot.longFramesOver50Ms}`,
    `long>100=${snapshot.longFramesOver100Ms}`,
    `mapRender/s=${snapshot.mapRenderEventsPerSec.toFixed(1)}`,
    `ease/s=${snapshot.cameraEaseToPerSec.toFixed(1)}`,
    `playerWs/s=${snapshot.playerSnapshotsPerSec.toFixed(1)}`,
    `flagWs/s=${snapshot.flagSnapshotsPerSec.toFixed(1)}`,
    `collectibleWs/s=${snapshot.collectibleSnapshotsPerSec.toFixed(1)}`,
    `totalWs/s=${snapshot.totalWsMessagesPerSec.toFixed(1)}`,
    `wsReconnects=${snapshot.websocketReconnectCount}`,
    `wsProtocolFailures=${snapshot.websocketMalformedJsonCount + snapshot.websocketMalformedFrameCount + snapshot.websocketUnknownFrameCount + snapshot.websocketIncompatibleProtocolCount}`,
    `wsSendFailures=${snapshot.websocketSendClosedCount + snapshot.websocketSendFailedCount}`,
    `wsStaleEvents=${snapshot.websocketStaleEventCount}`,
    `nodes=${snapshot.collectibleCount}`,
    `waterHighlights=${snapshot.waterHighlightCount}`,
    `nodeRedraw/s=${snapshot.collectibleRedrawsPerSec.toFixed(1)}`,
    `nodeDrawMax=${snapshot.maxCollectibleDrawMs.toFixed(1)}ms`,
    `staticRedraw/s=${snapshot.staticOverlayRedrawsPerSec.toFixed(1)}`,
    `staticSkips=${snapshot.staticOverlaySkippedDuringInteractionCount}`,
    `staticDrawMax=${snapshot.maxStaticOverlayDrawMs.toFixed(1)}ms`,
    `dynamicDrawMax=${snapshot.maxDynamicOverlayUpdateMs.toFixed(1)}ms`,
    `pixiRenderMax=${snapshot.maxPixiRenderCallMs.toFixed(1)}ms`,
    `moveFrameMax=${snapshot.maxLocalMovementFrameMs.toFixed(1)}ms`,
    `moveDiscarded=${snapshot.localMovementDiscardedMs.toFixed(1)}ms`,
    `moveLeadMax=${snapshot.maxLocalPredictionLeadM.toFixed(1)}m`,
    `moveCapHolds=${snapshot.localLeadCapHoldCount}`,
    `snapshotAge=${snapshotAge}`,
    `flags=${snapshot.visibleFlagCount}`,
    `combatEntities=${snapshot.combatEntityCount}`,
    `retainedObjects=${snapshot.retainedDisplayObjectCount}`,
    `selected=${snapshot.selectedFlagId ?? "none"}`,
    `moving=${snapshot.mapMoving}`,
    `zooming=${snapshot.mapZooming}`
  ].join(" ");
}

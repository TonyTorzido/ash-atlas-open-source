import type { LoadMilestone, PerfSnapshot } from "./perfMetrics.js";

export type PerformanceEventDetails = Record<string, string | number | boolean | null>;

export type PerformanceRecordingSample = {
  tMs: number;
  frameCount: number;
  fps: number;
  avgFrameMs: number;
  worstFrameMs: number;
  worstRecentFrameMs: number;
  frameBudgetMissesOver16Ms: number;
  frameBudgetMissesOver33Ms: number;
  sampleWindowMs: number;
  longFramesOver50Ms: number;
  longFramesOver100Ms: number;
  mapRenderEventsReceived: number;
  mapRenderEventsPerSec: number;
  cameraEaseToCount: number;
  cameraEaseToPerSec: number;
  playerSnapshotCount: number;
  flagsSnapshotCount: number;
  totalWsMessageCount: number;
  playerSnapshotsPerSec: number;
  flagsSnapshotsPerSec: number;
  wsSnapshotsPerSec: number;
  totalWsMessagesPerSec: number;
  gameAppRendersPerSec: number;
  wsBytesPerSec: number;
  drawCallsPerFrame: number;
  textureCount: number;
  textureBytes: number;
  jsHeapBytes: number | null;
  eventLoopLagMs: number;
  collectibleCount: number;
  collectibleCountMax: number;
  collectibleRedrawCount: number;
  collectibleRedrawsPerSec: number;
  collectibleDrawMs: number;
  maxCollectibleDrawMs: number;
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
  collectibleSnapshotCount: number;
  collectibleSnapshotsPerSec: number;
  collectibleSnapshotNodeCount: number;
  collectibleSnapshotNodeCountMax: number;
  waterHighlightCount: number;
  waterHighlightCountMax: number;
  inventorySnapshotCount: number;
  inventorySnapshotsPerSec: number;
  surveyRequestCount: number;
  surveyRequestsPerSec: number;
  lastSurveyResponseMs: number | null;
  maxSurveyResponseMs: number;
  lastSnapshotAgeMs: number | null;
  flagCount: number;
  selectedFlagId: string | null;
  mapMoving: boolean;
  mapZooming: boolean;
};

export type PerformanceRecordingEvent = {
  tMs: number;
  name: string;
  details?: PerformanceEventDetails;
};

export type PerformanceRecordingSummary = {
  sampleCount: number;
  eventCount: number;
  avgFps: number;
  worstFrameMs: number;
  longFramesOver50Ms: number;
  longFramesOver100Ms: number;
  frameBudgetMissesOver16Ms: number;
  frameBudgetMissesOver33Ms: number;
  maxMapRenderEventsPerSec: number;
  cameraEaseToCount: number;
  maxWsSnapshotsPerSec: number;
  playerSnapshotCount: number;
  flagsSnapshotCount: number;
  totalWsMessageCount: number;
  maxPlayerSnapshotsPerSec: number;
  maxFlagsSnapshotsPerSec: number;
  maxTotalWsMessagesPerSec: number;
  maxGameAppRendersPerSec: number;
  maxWsBytesPerSec: number;
  maxDrawCallsPerFrame: number;
  maxTextureCount: number;
  maxTextureBytes: number;
  maxJsHeapBytes: number;
  maxEventLoopLagMs: number;
  flagCountMax: number;
  collectibleCountMax: number;
  collectibleRedrawCount: number;
  staticOverlayRedrawCount: number;
  staticOverlaySkippedDuringInteractionCount: number;
  territoryRedrawCount: number;
  maxCollectibleRedrawsPerSec: number;
  maxCollectibleDrawMs: number;
  maxStaticOverlayRedrawsPerSec: number;
  maxStaticOverlayDrawMs: number;
  collectibleSnapshotCount: number;
  maxCollectibleSnapshotsPerSec: number;
  collectibleSnapshotNodeCountMax: number;
  waterHighlightCountMax: number;
  inventorySnapshotCount: number;
  maxInventorySnapshotsPerSec: number;
  surveyRequestCount: number;
  maxSurveyRequestsPerSec: number;
  maxSurveyResponseMs: number;
};

export type PerformanceRecording = {
  schemaVersion: 1;
  app: "ash-atlas";
  startedAtIso: string;
  stoppedAtIso: string;
  durationMs: number;
  userAgent: string;
  samplesPerSecond: number;
  stoppedReason: string;
  summary: PerformanceRecordingSummary;
  loadMilestones: LoadMilestone[];
  samples: PerformanceRecordingSample[];
  events: PerformanceRecordingEvent[];
};

export type PerformanceRecorderStatus = {
  isRecording: boolean;
  durationMs: number;
  sampleCount: number;
  eventCount: number;
  maxDurationMs: number;
  maxSamples: number;
  maxEvents: number;
  lastStoppedReason: string | null;
  startedAtIso: string | null;
};

export type RecordSampleResult =
  | { stopped: false }
  | { stopped: true; reason: string; recording: PerformanceRecording };

type ActiveRecording = {
  startedAtMs: number;
  startedAtIso: string;
  baseline: PerformanceRecordingBaseline | null;
  maxFrameMs: number;
  samples: PerformanceRecordingSample[];
  events: PerformanceRecordingEvent[];
  loadMilestones: LoadMilestone[];
};

type PerformanceRecordingBaseline = {
  frameCount: number;
  frameTimeTotalMs: number;
  frameBudgetMissesOver16Ms: number;
  frameBudgetMissesOver33Ms: number;
  longFramesOver50Ms: number;
  longFramesOver100Ms: number;
  mapRenderEventsReceived: number;
  cameraEaseToCount: number;
  playerSnapshotCount: number;
  flagSnapshotCount: number;
  collectibleSnapshotCount: number;
  inventorySnapshotCount: number;
  totalWsMessageCount: number;
  collectibleRedrawCount: number;
  collectibleDrawMs: number;
  staticOverlayRedrawCount: number;
  staticOverlaySkippedDuringInteractionCount: number;
  territoryRedrawCount: number;
  dynamicOverlayUpdateCount: number;
  dynamicOverlayUpdateMs: number;
  pixiRenderCallCount: number;
  pixiRenderCallMs: number;
  localMovementDiscardedMs: number;
  localLeadCapHoldCount: number;
  surveyRequestCount: number;
};

export const PERFORMANCE_RECORDING_SAMPLE_INTERVAL_MS = 100;
export const PERFORMANCE_RECORDING_SAMPLES_PER_SECOND =
  1_000 / PERFORMANCE_RECORDING_SAMPLE_INTERVAL_MS;
export const PERFORMANCE_RECORDING_MAX_DURATION_MS = 5 * 60 * 1_000;
export const PERFORMANCE_RECORDING_MAX_SAMPLES = 3_000;
export const PERFORMANCE_RECORDING_MAX_EVENTS = 5_000;

export class PerfRecorder {
  private active: ActiveRecording | null = null;
  private lastRecording: PerformanceRecording | null = null;
  private lastStoppedReason: string | null = null;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly isoNow: () => string = () => new Date().toISOString(),
    private readonly userAgent: () => string = defaultUserAgent
  ) {}

  startRecording(): PerformanceRecorderStatus {
    if (this.active) {
      return this.getStatus();
    }
    this.lastRecording = null;
    this.lastStoppedReason = null;
    this.active = {
      startedAtMs: this.now(),
      startedAtIso: this.isoNow(),
      baseline: null,
      maxFrameMs: 0,
      samples: [],
      events: [],
      loadMilestones: []
    };
    this.recordEvent("recording_start");
    return this.getStatus();
  }

  stopRecording(reason = "manual"): PerformanceRecording | null {
    if (!this.active) {
      return null;
    }
    this.recordEvent("recording_stop", { reason });
    const stoppedAtMs = this.now();
    const stoppedAtIso = this.isoNow();
    const recording = this.buildRecording(this.active, stoppedAtMs, stoppedAtIso, reason);
    this.active = null;
    this.lastRecording = recording;
    this.lastStoppedReason = reason;
    return recording;
  }

  isRecording(): boolean {
    return this.active !== null;
  }

  recordSample(snapshot: PerfSnapshot): RecordSampleResult {
    if (!this.active) {
      return { stopped: false };
    }
    const tMs = this.elapsedMs(this.active);
    if (!this.active.baseline) {
      this.active.baseline = snapshotToBaseline(snapshot);
    }
    this.active.loadMilestones = snapshot.loadMilestones;
    this.active.samples.push(snapshotToRecordingSample(snapshot, this.active, tMs));

    if (tMs >= PERFORMANCE_RECORDING_MAX_DURATION_MS) {
      const recording = this.stopRecording("max duration reached");
      return recording
        ? { stopped: true, reason: "max duration reached", recording }
        : { stopped: false };
    }
    if (this.active?.samples.length >= PERFORMANCE_RECORDING_MAX_SAMPLES) {
      const recording = this.stopRecording("max samples reached");
      return recording
        ? { stopped: true, reason: "max samples reached", recording }
        : { stopped: false };
    }
    return { stopped: false };
  }

  recordEvent(name: string, details?: PerformanceEventDetails): boolean {
    if (!this.active) {
      return false;
    }
    if (this.active.events.length >= PERFORMANCE_RECORDING_MAX_EVENTS) {
      return false;
    }
    if (
      this.active.events.length === PERFORMANCE_RECORDING_MAX_EVENTS - 1 &&
      name !== "event_limit_reached"
    ) {
      this.active.events.push({
        tMs: this.elapsedMs(this.active),
        name: "event_limit_reached"
      });
      return false;
    }
    this.active.events.push({
      tMs: this.elapsedMs(this.active),
      name,
      ...(details ? { details: sanitizeDetails(details) } : {})
    });
    return true;
  }

  resetRecording(): PerformanceRecorderStatus {
    this.active = null;
    this.lastRecording = null;
    this.lastStoppedReason = null;
    return this.getStatus();
  }

  exportRecording(): PerformanceRecording | null {
    if (this.active) {
      return this.buildRecording(this.active, this.now(), this.isoNow(), "export while recording");
    }
    return this.lastRecording;
  }

  getStatus(): PerformanceRecorderStatus {
    const recording = this.active ?? null;
    const previous = this.lastRecording;
    return {
      isRecording: recording !== null,
      durationMs: recording ? this.elapsedMs(recording) : previous?.durationMs ?? 0,
      sampleCount: recording?.samples.length ?? previous?.samples.length ?? 0,
      eventCount: recording?.events.length ?? previous?.events.length ?? 0,
      maxDurationMs: PERFORMANCE_RECORDING_MAX_DURATION_MS,
      maxSamples: PERFORMANCE_RECORDING_MAX_SAMPLES,
      maxEvents: PERFORMANCE_RECORDING_MAX_EVENTS,
      lastStoppedReason: this.lastStoppedReason,
      startedAtIso: recording?.startedAtIso ?? previous?.startedAtIso ?? null
    };
  }

  private elapsedMs(recording: ActiveRecording): number {
    return Math.max(0, this.now() - recording.startedAtMs);
  }

  private buildRecording(
    active: ActiveRecording,
    stoppedAtMs: number,
    stoppedAtIso: string,
    stoppedReason: string
  ): PerformanceRecording {
    const samples = [...active.samples];
    const events = [...active.events];
    return {
      schemaVersion: 1,
      app: "ash-atlas",
      startedAtIso: active.startedAtIso,
      stoppedAtIso,
      durationMs: Math.max(0, stoppedAtMs - active.startedAtMs),
      userAgent: this.userAgent(),
      samplesPerSecond: PERFORMANCE_RECORDING_SAMPLES_PER_SECOND,
      stoppedReason,
      summary: summarizeRecording(samples, events),
      loadMilestones: [...active.loadMilestones],
      samples,
      events
    };
  }
}

export const perfRecorder = new PerfRecorder();

export function performanceRecordingFilename(recording: PerformanceRecording): string {
  const date = new Date(recording.startedAtIso);
  const stamp = [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    "-",
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds())
  ].join("");
  return `ash-atlas-perf-${stamp}.json`;
}

export function summarizeRecording(
  samples: PerformanceRecordingSample[],
  events: PerformanceRecordingEvent[]
): PerformanceRecordingSummary {
  const fpsTotal = samples.reduce((total, sample) => total + sample.fps, 0);
  return {
    sampleCount: samples.length,
    eventCount: events.length,
    avgFps: samples.length === 0 ? 0 : fpsTotal / samples.length,
    worstFrameMs: maxSampleValue(samples, (sample) => sample.worstFrameMs),
    longFramesOver50Ms: maxSampleValue(samples, (sample) => sample.longFramesOver50Ms),
    longFramesOver100Ms: maxSampleValue(samples, (sample) => sample.longFramesOver100Ms),
    frameBudgetMissesOver16Ms: maxSampleValue(
      samples,
      (sample) => sample.frameBudgetMissesOver16Ms
    ),
    frameBudgetMissesOver33Ms: maxSampleValue(
      samples,
      (sample) => sample.frameBudgetMissesOver33Ms
    ),
    maxMapRenderEventsPerSec: maxSampleValue(samples, (sample) => sample.mapRenderEventsPerSec),
    cameraEaseToCount: maxSampleValue(samples, (sample) => sample.cameraEaseToCount),
    maxWsSnapshotsPerSec: maxSampleValue(samples, (sample) => sample.wsSnapshotsPerSec),
    playerSnapshotCount: maxSampleValue(samples, (sample) => sample.playerSnapshotCount),
    flagsSnapshotCount: maxSampleValue(samples, (sample) => sample.flagsSnapshotCount),
    totalWsMessageCount: maxSampleValue(samples, (sample) => sample.totalWsMessageCount),
    maxPlayerSnapshotsPerSec: maxSampleValue(samples, (sample) => sample.playerSnapshotsPerSec),
    maxFlagsSnapshotsPerSec: maxSampleValue(samples, (sample) => sample.flagsSnapshotsPerSec),
    maxTotalWsMessagesPerSec: maxSampleValue(samples, (sample) => sample.totalWsMessagesPerSec),
    maxGameAppRendersPerSec: maxSampleValue(samples, (sample) => sample.gameAppRendersPerSec),
    maxWsBytesPerSec: maxSampleValue(samples, (sample) => sample.wsBytesPerSec),
    maxDrawCallsPerFrame: maxSampleValue(samples, (sample) => sample.drawCallsPerFrame),
    maxTextureCount: maxSampleValue(samples, (sample) => sample.textureCount),
    maxTextureBytes: maxSampleValue(samples, (sample) => sample.textureBytes),
    maxJsHeapBytes: maxSampleValue(samples, (sample) => sample.jsHeapBytes ?? 0),
    maxEventLoopLagMs: maxSampleValue(samples, (sample) => sample.eventLoopLagMs),
    flagCountMax: maxSampleValue(samples, (sample) => sample.flagCount),
    collectibleCountMax: maxSampleValue(samples, (sample) => sample.collectibleCountMax),
    collectibleRedrawCount: maxSampleValue(samples, (sample) => sample.collectibleRedrawCount),
    staticOverlayRedrawCount: maxSampleValue(
      samples,
      (sample) => sample.staticOverlayRedrawCount
    ),
    staticOverlaySkippedDuringInteractionCount: maxSampleValue(
      samples,
      (sample) => sample.staticOverlaySkippedDuringInteractionCount
    ),
    territoryRedrawCount: maxSampleValue(samples, (sample) => sample.territoryRedrawCount),
    maxCollectibleRedrawsPerSec: maxSampleValue(
      samples,
      (sample) => sample.collectibleRedrawsPerSec
    ),
    maxCollectibleDrawMs: maxSampleValue(samples, (sample) => sample.maxCollectibleDrawMs),
    maxStaticOverlayRedrawsPerSec: maxSampleValue(
      samples,
      (sample) => sample.staticOverlayRedrawsPerSec
    ),
    maxStaticOverlayDrawMs: maxSampleValue(samples, (sample) => sample.maxStaticOverlayDrawMs),
    collectibleSnapshotCount: maxSampleValue(
      samples,
      (sample) => sample.collectibleSnapshotCount
    ),
    maxCollectibleSnapshotsPerSec: maxSampleValue(
      samples,
      (sample) => sample.collectibleSnapshotsPerSec
    ),
    collectibleSnapshotNodeCountMax: maxSampleValue(
      samples,
      (sample) => sample.collectibleSnapshotNodeCountMax
    ),
    waterHighlightCountMax: maxSampleValue(samples, (sample) => sample.waterHighlightCountMax),
    inventorySnapshotCount: maxSampleValue(samples, (sample) => sample.inventorySnapshotCount),
    maxInventorySnapshotsPerSec: maxSampleValue(
      samples,
      (sample) => sample.inventorySnapshotsPerSec
    ),
    surveyRequestCount: maxSampleValue(samples, (sample) => sample.surveyRequestCount),
    maxSurveyRequestsPerSec: maxSampleValue(samples, (sample) => sample.surveyRequestsPerSec),
    maxSurveyResponseMs: maxSampleValue(samples, (sample) => sample.maxSurveyResponseMs)
  };
}

function snapshotToRecordingSample(
  snapshot: PerfSnapshot,
  recording: ActiveRecording,
  tMs: number
): PerformanceRecordingSample {
  const baseline = recording.baseline ?? snapshotToBaseline(snapshot);
  const frameCount = diffCounter(snapshot.frameCount, baseline.frameCount);
  const frameTimeTotalMs = diffCounter(snapshot.frameTimeTotalMs, baseline.frameTimeTotalMs);
  const recentWorstFrameMs =
    recording.samples.length === 0 ? 0 : Math.max(0, snapshot.worstRecentFrameMs);
  recording.maxFrameMs = Math.max(recording.maxFrameMs, recentWorstFrameMs);
  return {
    tMs,
    frameCount,
    fps: snapshot.fps,
    avgFrameMs: frameCount === 0 ? 0 : frameTimeTotalMs / frameCount,
    worstFrameMs: recording.maxFrameMs,
    worstRecentFrameMs: recentWorstFrameMs,
    frameBudgetMissesOver16Ms: diffCounter(
      snapshot.frameBudgetMissesOver16Ms,
      baseline.frameBudgetMissesOver16Ms
    ),
    frameBudgetMissesOver33Ms: diffCounter(
      snapshot.frameBudgetMissesOver33Ms,
      baseline.frameBudgetMissesOver33Ms
    ),
    sampleWindowMs: snapshot.sampleWindowMs,
    longFramesOver50Ms: diffCounter(snapshot.longFramesOver50Ms, baseline.longFramesOver50Ms),
    longFramesOver100Ms: diffCounter(snapshot.longFramesOver100Ms, baseline.longFramesOver100Ms),
    mapRenderEventsReceived: diffCounter(
      snapshot.mapRenderEventsReceived,
      baseline.mapRenderEventsReceived
    ),
    mapRenderEventsPerSec: snapshot.mapRenderEventsPerSec,
    cameraEaseToCount: diffCounter(snapshot.cameraEaseToCount, baseline.cameraEaseToCount),
    cameraEaseToPerSec: snapshot.cameraEaseToPerSec,
    playerSnapshotCount: diffCounter(snapshot.playerSnapshotCount, baseline.playerSnapshotCount),
    flagsSnapshotCount: diffCounter(snapshot.flagSnapshotCount, baseline.flagSnapshotCount),
    collectibleSnapshotCount: diffCounter(
      snapshot.collectibleSnapshotCount,
      baseline.collectibleSnapshotCount
    ),
    inventorySnapshotCount: diffCounter(
      snapshot.inventorySnapshotCount,
      baseline.inventorySnapshotCount
    ),
    totalWsMessageCount: diffCounter(snapshot.totalWsMessageCount, baseline.totalWsMessageCount),
    collectibleRedrawCount: diffCounter(
      snapshot.collectibleRedrawCount,
      baseline.collectibleRedrawCount
    ),
    collectibleRedrawsPerSec: snapshot.collectibleRedrawsPerSec,
    collectibleDrawMs: diffCounter(snapshot.collectibleDrawMs, baseline.collectibleDrawMs),
    maxCollectibleDrawMs: snapshot.maxCollectibleDrawMs,
    staticOverlayRedrawCount: diffCounter(
      snapshot.staticOverlayRedrawCount,
      baseline.staticOverlayRedrawCount
    ),
    staticOverlayRedrawsPerSec: snapshot.staticOverlayRedrawsPerSec,
    staticOverlaySkippedDuringInteractionCount: diffCounter(
      snapshot.staticOverlaySkippedDuringInteractionCount,
      baseline.staticOverlaySkippedDuringInteractionCount
    ),
    territoryRedrawCount: diffCounter(
      snapshot.territoryRedrawCount,
      baseline.territoryRedrawCount
    ),
    maxStaticOverlayDrawMs: snapshot.maxStaticOverlayDrawMs,
    dynamicOverlayUpdateCount: diffCounter(
      snapshot.dynamicOverlayUpdateCount,
      baseline.dynamicOverlayUpdateCount
    ),
    dynamicOverlayUpdateMs: diffCounter(
      snapshot.dynamicOverlayUpdateMs,
      baseline.dynamicOverlayUpdateMs
    ),
    maxDynamicOverlayUpdateMs: snapshot.maxDynamicOverlayUpdateMs,
    pixiRenderCallCount: diffCounter(snapshot.pixiRenderCallCount, baseline.pixiRenderCallCount),
    pixiRenderCallMs: diffCounter(snapshot.pixiRenderCallMs, baseline.pixiRenderCallMs),
    maxPixiRenderCallMs: snapshot.maxPixiRenderCallMs,
    lastLocalMovementFrameMs: snapshot.lastLocalMovementFrameMs,
    maxLocalMovementFrameMs: snapshot.maxLocalMovementFrameMs,
    localMovementDiscardedMs: diffCounter(
      snapshot.localMovementDiscardedMs,
      baseline.localMovementDiscardedMs
    ),
    localPredictionLeadM: snapshot.localPredictionLeadM,
    maxLocalPredictionLeadM: snapshot.maxLocalPredictionLeadM,
    localAuthorityAgeMs: snapshot.localAuthorityAgeMs,
    maxLocalAuthorityAgeMs: snapshot.maxLocalAuthorityAgeMs,
    localLeadCapHoldCount: diffCounter(
      snapshot.localLeadCapHoldCount,
      baseline.localLeadCapHoldCount
    ),
    collectibleCount: snapshot.collectibleCount,
    collectibleCountMax: snapshot.collectibleCountMax,
    collectibleSnapshotsPerSec: snapshot.collectibleSnapshotsPerSec,
    collectibleSnapshotNodeCount: snapshot.collectibleSnapshotNodeCount,
    collectibleSnapshotNodeCountMax: snapshot.collectibleSnapshotNodeCountMax,
    waterHighlightCount: snapshot.waterHighlightCount,
    waterHighlightCountMax: snapshot.waterHighlightCountMax,
    inventorySnapshotsPerSec: snapshot.inventorySnapshotsPerSec,
    surveyRequestCount: diffCounter(snapshot.surveyRequestCount, baseline.surveyRequestCount),
    surveyRequestsPerSec: snapshot.surveyRequestsPerSec,
    lastSurveyResponseMs: snapshot.lastSurveyResponseMs,
    maxSurveyResponseMs: snapshot.maxSurveyResponseMs,
    playerSnapshotsPerSec: snapshot.playerSnapshotsPerSec,
    flagsSnapshotsPerSec: snapshot.flagSnapshotsPerSec,
    wsSnapshotsPerSec: snapshot.websocketSnapshotsPerSec,
    totalWsMessagesPerSec: snapshot.totalWsMessagesPerSec,
    gameAppRendersPerSec: snapshot.gameAppRendersPerSec,
    wsBytesPerSec: snapshot.wsBytesPerSec,
    drawCallsPerFrame: snapshot.drawCallsPerFrame,
    textureCount: snapshot.textureCount,
    textureBytes: snapshot.textureBytes,
    jsHeapBytes: snapshot.jsHeapBytes,
    eventLoopLagMs: snapshot.eventLoopLagMs,
    lastSnapshotAgeMs: snapshot.lastSnapshotAgeMs,
    flagCount: snapshot.visibleFlagCount,
    selectedFlagId: snapshot.selectedFlagId,
    mapMoving: snapshot.mapMoving,
    mapZooming: snapshot.mapZooming
  };
}

function snapshotToBaseline(snapshot: PerfSnapshot): PerformanceRecordingBaseline {
  return {
    frameCount: snapshot.frameCount,
    frameTimeTotalMs: snapshot.frameTimeTotalMs,
    frameBudgetMissesOver16Ms: snapshot.frameBudgetMissesOver16Ms,
    frameBudgetMissesOver33Ms: snapshot.frameBudgetMissesOver33Ms,
    longFramesOver50Ms: snapshot.longFramesOver50Ms,
    longFramesOver100Ms: snapshot.longFramesOver100Ms,
    mapRenderEventsReceived: snapshot.mapRenderEventsReceived,
    cameraEaseToCount: snapshot.cameraEaseToCount,
    playerSnapshotCount: snapshot.playerSnapshotCount,
    flagSnapshotCount: snapshot.flagSnapshotCount,
    collectibleSnapshotCount: snapshot.collectibleSnapshotCount,
    inventorySnapshotCount: snapshot.inventorySnapshotCount,
    totalWsMessageCount: snapshot.totalWsMessageCount,
    collectibleRedrawCount: snapshot.collectibleRedrawCount,
    collectibleDrawMs: snapshot.collectibleDrawMs,
    staticOverlayRedrawCount: snapshot.staticOverlayRedrawCount,
    staticOverlaySkippedDuringInteractionCount: snapshot.staticOverlaySkippedDuringInteractionCount,
    territoryRedrawCount: snapshot.territoryRedrawCount,
    dynamicOverlayUpdateCount: snapshot.dynamicOverlayUpdateCount,
    dynamicOverlayUpdateMs: snapshot.dynamicOverlayUpdateMs,
    pixiRenderCallCount: snapshot.pixiRenderCallCount,
    pixiRenderCallMs: snapshot.pixiRenderCallMs,
    localMovementDiscardedMs: snapshot.localMovementDiscardedMs,
    localLeadCapHoldCount: snapshot.localLeadCapHoldCount,
    surveyRequestCount: snapshot.surveyRequestCount
  };
}

function diffCounter(current: number, baseline: number): number {
  return Math.max(0, current - baseline);
}

function maxSampleValue(
  samples: PerformanceRecordingSample[],
  getValue: (sample: PerformanceRecordingSample) => number
): number {
  return samples.reduce((max, sample) => Math.max(max, getValue(sample)), 0);
}

function sanitizeDetails(details: PerformanceEventDetails): PerformanceEventDetails {
  return Object.fromEntries(
    Object.entries(details).filter((entry): entry is [string, string | number | boolean | null] => {
      const value = entry[1];
      return (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      );
    })
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function defaultUserAgent(): string {
  return typeof navigator === "undefined" ? "unknown" : navigator.userAgent;
}

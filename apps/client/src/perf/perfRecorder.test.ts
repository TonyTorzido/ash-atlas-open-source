import { describe, expect, it } from "vitest";

import type { PerfSnapshot } from "./perfMetrics.js";
import {
  PERFORMANCE_RECORDING_MAX_EVENTS,
  PERFORMANCE_RECORDING_MAX_SAMPLES,
  PerfRecorder,
  performanceRecordingFilename
} from "./perfRecorder.js";

describe("PerfRecorder", () => {
  it("starts, records samples and events, then exports JSON-shaped data", () => {
    let now = 0;
    const recorder = new PerfRecorder(
      () => now,
      () => "2026-07-08T15:17:33.000Z",
      () => "vitest"
    );

    recorder.startRecording();
    recorder.recordEvent("map_drag_start", { flagCount: 3 });
    now = 100;
    recorder.recordSample(
      snapshot({
        fps: 58,
        frameCount: 7,
        frameTimeTotalMs: 120,
        worstFrameMs: 112,
        worstRecentFrameMs: 112,
        frameBudgetMissesOver16Ms: 8,
        frameBudgetMissesOver33Ms: 2,
        longFramesOver50Ms: 4,
        longFramesOver100Ms: 1,
        mapRenderEventsPerSec: 80,
        cameraEaseToCount: 3,
        websocketSnapshotsPerSec: 20,
        playerSnapshotCount: 5,
        flagSnapshotCount: 6,
        totalWsMessageCount: 14,
        playerSnapshotsPerSec: 10,
        flagSnapshotsPerSec: 10,
        totalWsMessagesPerSec: 24,
        visibleFlagCount: 12,
        staticOverlayRedrawCount: 4,
        staticOverlayRedrawsPerSec: 20,
        staticOverlaySkippedDuringInteractionCount: 2,
        territoryRedrawCount: 3,
        maxStaticOverlayDrawMs: 8,
        dynamicOverlayUpdateCount: 7,
        dynamicOverlayUpdateMs: 14,
        pixiRenderCallCount: 7,
        pixiRenderCallMs: 5,
        localMovementDiscardedMs: 0,
        localLeadCapHoldCount: 1
      })
    );

    now = 200;
    recorder.recordSample(
      snapshot({
        fps: 62,
        frameCount: 12,
        frameTimeTotalMs: 216,
        worstFrameMs: 112,
        worstRecentFrameMs: 96,
        frameBudgetMissesOver16Ms: 10,
        frameBudgetMissesOver33Ms: 4,
        longFramesOver50Ms: 5,
        longFramesOver100Ms: 1,
        mapRenderEventsPerSec: 90,
        cameraEaseToCount: 5,
        websocketSnapshotsPerSec: 22,
        playerSnapshotCount: 8,
        flagSnapshotCount: 9,
        totalWsMessageCount: 20,
        playerSnapshotsPerSec: 11,
        flagSnapshotsPerSec: 11,
        totalWsMessagesPerSec: 26,
        visibleFlagCount: 12,
        staticOverlayRedrawCount: 7,
        staticOverlayRedrawsPerSec: 22,
        staticOverlaySkippedDuringInteractionCount: 5,
        territoryRedrawCount: 5,
        maxStaticOverlayDrawMs: 11,
        dynamicOverlayUpdateCount: 12,
        dynamicOverlayUpdateMs: 26,
        maxDynamicOverlayUpdateMs: 4,
        pixiRenderCallCount: 12,
        pixiRenderCallMs: 9,
        maxPixiRenderCallMs: 1.5,
        lastLocalMovementFrameMs: 120,
        maxLocalMovementFrameMs: 120,
        localPredictionLeadM: 60,
        maxLocalPredictionLeadM: 60,
        localAuthorityAgeMs: 135,
        maxLocalAuthorityAgeMs: 135,
        localMovementDiscardedMs: 0,
        localLeadCapHoldCount: 3
      })
    );

    now = 250;
    const recording = recorder.stopRecording("manual");

    expect(recording?.schemaVersion).toBe(1);
    expect(recording?.app).toBe("ash-atlas");
    expect(recording?.durationMs).toBe(250);
    expect(recording?.userAgent).toBe("vitest");
    expect(recording?.samples).toHaveLength(2);
    expect(recording?.samples[1]).toMatchObject({
      dynamicOverlayUpdateCount: 5,
      dynamicOverlayUpdateMs: 12,
      pixiRenderCallCount: 5,
      pixiRenderCallMs: 4,
      lastLocalMovementFrameMs: 120,
      localMovementDiscardedMs: 0,
      localPredictionLeadM: 60,
      localAuthorityAgeMs: 135,
      localLeadCapHoldCount: 2
    });
    expect(recording?.events.map((event) => event.name)).toEqual([
      "recording_start",
      "map_drag_start",
      "recording_stop"
    ]);
    expect(recording?.summary).toMatchObject({
      sampleCount: 2,
      avgFps: 60,
      worstFrameMs: 96,
      longFramesOver50Ms: 1,
      longFramesOver100Ms: 0,
      frameBudgetMissesOver16Ms: 2,
      frameBudgetMissesOver33Ms: 2,
      maxMapRenderEventsPerSec: 90,
      cameraEaseToCount: 2,
      maxWsSnapshotsPerSec: 22,
      playerSnapshotCount: 3,
      flagsSnapshotCount: 3,
      totalWsMessageCount: 6,
      maxPlayerSnapshotsPerSec: 11,
      maxFlagsSnapshotsPerSec: 11,
      maxTotalWsMessagesPerSec: 26,
      flagCountMax: 12,
      staticOverlayRedrawCount: 3,
      staticOverlaySkippedDuringInteractionCount: 3,
      territoryRedrawCount: 2,
      maxStaticOverlayRedrawsPerSec: 22,
      maxStaticOverlayDrawMs: 11
    });
  });

  it("uses the required filename format", () => {
    let now = 0;
    const recorder = new PerfRecorder(
      () => now,
      () => "2026-07-08T15:17:33.000Z",
      () => "vitest"
    );

    recorder.startRecording();
    now = 10;
    const recording = recorder.stopRecording("manual");

    expect(recording ? performanceRecordingFilename(recording) : "").toBe(
      "ash-atlas-perf-20260708-151733.json"
    );
  });

  it("auto-stops when max sample count is reached", () => {
    let now = 0;
    const recorder = new PerfRecorder(
      () => now,
      () => "2026-07-08T15:17:33.000Z",
      () => "vitest"
    );

    recorder.startRecording();
    let result = recorder.recordSample(snapshot());
    for (let index = 1; index < PERFORMANCE_RECORDING_MAX_SAMPLES; index += 1) {
      now += 100;
      result = recorder.recordSample(snapshot());
    }

    expect(result.stopped).toBe(true);
    expect(result.stopped ? result.reason : "").toBe("max samples reached");
    expect(recorder.isRecording()).toBe(false);
    expect(recorder.exportRecording()?.samples).toHaveLength(PERFORMANCE_RECORDING_MAX_SAMPLES);
  });

  it("enforces max event count", () => {
    const recorder = new PerfRecorder(
      () => 0,
      () => "2026-07-08T15:17:33.000Z",
      () => "vitest"
    );

    recorder.startRecording();
    for (let index = 0; index < PERFORMANCE_RECORDING_MAX_EVENTS + 10; index += 1) {
      recorder.recordEvent("camera_ease_to", { index });
    }

    const recording = recorder.exportRecording();
    expect(recording?.events).toHaveLength(PERFORMANCE_RECORDING_MAX_EVENTS);
    expect(recording?.events.at(-1)?.name).toBe("event_limit_reached");
  });

  it("exports cumulative counters relative to the recording start baseline", () => {
    let now = 0;
    const recorder = new PerfRecorder(
      () => now,
      () => "2026-07-08T15:17:33.000Z",
      () => "vitest"
    );

    recorder.startRecording();
    recorder.recordSample(
      snapshot({
        frameCount: 100,
        frameTimeTotalMs: 1_600,
        worstFrameMs: 300,
        worstRecentFrameMs: 300,
        frameBudgetMissesOver16Ms: 40,
        frameBudgetMissesOver33Ms: 12,
        longFramesOver50Ms: 8,
        longFramesOver100Ms: 3,
        mapRenderEventsReceived: 500,
        cameraEaseToCount: 9,
        playerSnapshotCount: 80,
        flagSnapshotCount: 5,
        totalWsMessageCount: 100,
        staticOverlayRedrawCount: 40,
        staticOverlaySkippedDuringInteractionCount: 6,
        territoryRedrawCount: 12
      })
    );

    now = 100;
    recorder.recordSample(
      snapshot({
        frameCount: 106,
        frameTimeTotalMs: 1_702,
        worstFrameMs: 300,
        worstRecentFrameMs: 28,
        frameBudgetMissesOver16Ms: 43,
        frameBudgetMissesOver33Ms: 13,
        longFramesOver50Ms: 9,
        longFramesOver100Ms: 3,
        mapRenderEventsReceived: 530,
        cameraEaseToCount: 11,
        playerSnapshotCount: 84,
        flagSnapshotCount: 7,
        totalWsMessageCount: 106,
        staticOverlayRedrawCount: 42,
        staticOverlaySkippedDuringInteractionCount: 9,
        territoryRedrawCount: 13
      })
    );

    const recording = recorder.stopRecording("manual");

    expect(recording?.samples[0]).toMatchObject({
      frameCount: 0,
      avgFrameMs: 0,
      worstFrameMs: 0,
      worstRecentFrameMs: 0,
      frameBudgetMissesOver16Ms: 0,
      frameBudgetMissesOver33Ms: 0,
      longFramesOver50Ms: 0,
      longFramesOver100Ms: 0,
      mapRenderEventsReceived: 0,
      cameraEaseToCount: 0,
      playerSnapshotCount: 0,
      flagsSnapshotCount: 0,
      totalWsMessageCount: 0,
      staticOverlayRedrawCount: 0,
      staticOverlaySkippedDuringInteractionCount: 0,
      territoryRedrawCount: 0
    });
    expect(recording?.samples[1]).toMatchObject({
      frameCount: 6,
      avgFrameMs: 17,
      worstFrameMs: 28,
      worstRecentFrameMs: 28,
      frameBudgetMissesOver16Ms: 3,
      frameBudgetMissesOver33Ms: 1,
      longFramesOver50Ms: 1,
      longFramesOver100Ms: 0,
      mapRenderEventsReceived: 30,
      cameraEaseToCount: 2,
      playerSnapshotCount: 4,
      flagsSnapshotCount: 2,
      totalWsMessageCount: 6,
      staticOverlayRedrawCount: 2,
      staticOverlaySkippedDuringInteractionCount: 3,
      territoryRedrawCount: 1
    });
    expect(recording?.summary).toMatchObject({
      worstFrameMs: 28,
      frameBudgetMissesOver16Ms: 3,
      frameBudgetMissesOver33Ms: 1,
      longFramesOver50Ms: 1,
      longFramesOver100Ms: 0,
      cameraEaseToCount: 2,
      playerSnapshotCount: 4,
      flagsSnapshotCount: 2,
      totalWsMessageCount: 6,
      staticOverlayRedrawCount: 2,
      staticOverlaySkippedDuringInteractionCount: 3,
      territoryRedrawCount: 1
    });
  });
});

function snapshot(overrides: Partial<PerfSnapshot> = {}): PerfSnapshot {
  return {
    fps: 60,
    frameCount: 0,
    frameTimeTotalMs: 0,
    averageFrameMs: 16.7,
    worstFrameMs: 16.7,
    worstRecentFrameMs: 16.7,
    frameBudgetMissesOver16Ms: 0,
    frameBudgetMissesOver33Ms: 0,
    longFrameCount: 0,
    longFramesOver50Ms: 0,
    longFramesOver100Ms: 0,
    sampleWindowMs: 100,
    lastLongFrameReason: null,
    mapRenderEventsReceived: 0,
    mapRenderEventsPerSec: 0,
    mapMoving: false,
    mapZooming: false,
    cameraEaseToPerSec: 0,
    cameraEaseToCount: 0,
    cameraRecenterCount: 0,
    cameraSuppressedDraggingCount: 0,
    cameraSuppressedZoomingCount: 0,
    cameraSkippedCloseEnoughCount: 0,
    cameraSkippedIntervalCount: 0,
    playerSnapshotCount: 0,
    flagSnapshotCount: 0,
    totalWsMessageCount: 0,
    collectibleCount: 0,
    collectibleCountMax: 0,
    collectibleRedrawCount: 0,
    collectibleRedrawsPerSec: 0,
    collectibleDrawMs: 0,
    maxCollectibleDrawMs: 0,
    collectibleSnapshotCount: 0,
    collectibleSnapshotsPerSec: 0,
    collectibleSnapshotNodeCount: 0,
    collectibleSnapshotNodeCountMax: 0,
    staticOverlayRedrawCount: 0,
    staticOverlayRedrawsPerSec: 0,
    staticOverlaySkippedDuringInteractionCount: 0,
    territoryRedrawCount: 0,
    maxStaticOverlayDrawMs: 0,
    dynamicOverlayUpdateCount: 0,
    dynamicOverlayUpdateMs: 0,
    maxDynamicOverlayUpdateMs: 0,
    pixiRenderCallCount: 0,
    pixiRenderCallMs: 0,
    maxPixiRenderCallMs: 0,
    lastLocalMovementFrameMs: 0,
    maxLocalMovementFrameMs: 0,
    localMovementDiscardedMs: 0,
    localPredictionLeadM: 0,
    maxLocalPredictionLeadM: 0,
    localAuthorityAgeMs: null,
    maxLocalAuthorityAgeMs: 0,
    localLeadCapHoldCount: 0,
    waterHighlightCount: 0,
    waterHighlightCountMax: 0,
    inventorySnapshotCount: 0,
    inventorySnapshotsPerSec: 0,
    surveyRequestCount: 0,
    surveyRequestsPerSec: 0,
    lastSurveyResponseMs: null,
    maxSurveyResponseMs: 0,
    playerSnapshotsPerSec: 0,
    flagSnapshotsPerSec: 0,
    websocketSnapshotsPerSec: 0,
    totalWsMessagesPerSec: 0,
    gameAppRenderCount: 0,
    gameAppRendersPerSec: 0,
    wsBytesTotal: 0,
    wsBytesPerSec: 0,
    drawCallsTotal: 0,
    drawCallsPerFrame: 0,
    textureCount: 0,
    textureBytes: 0,
    jsHeapBytes: null,
    eventLoopLagMs: 0,
    devicePixelRatio: 1,
    overlayResolution: null,
    lastSnapshotAgeMs: null,
    websocketReadyState: null,
    websocketReconnectCount: 0,
    websocketMalformedJsonCount: 0,
    websocketMalformedFrameCount: 0,
    websocketUnknownFrameCount: 0,
    websocketIncompatibleProtocolCount: 0,
    websocketSendClosedCount: 0,
    websocketSendFailedCount: 0,
    websocketStaleEventCount: 0,
    visibleFlagCount: 0,
    combatEntityCount: 0,
    retainedDisplayObjectCount: 0,
    selectedFlagId: null,
    loadMilestones: [],
    ...overrides
  };
}

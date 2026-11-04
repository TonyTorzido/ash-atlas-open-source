import { describe, expect, it } from "vitest";

import { PerfMetrics } from "./perfMetrics.js";

describe("PerfMetrics", () => {
  it("computes frame stats and long frame counters", () => {
    let now = 0;
    const metrics = new PerfMetrics(() => now);

    metrics.noteFrame(16, "raf");
    metrics.noteFrame(60, "raf");
    metrics.noteFrame(120, "raf");
    now = 1_000;

    const snapshot = metrics.getSnapshot();
    expect(snapshot.fps).toBe(3);
    expect(snapshot.averageFrameMs).toBeCloseTo(65.333, 3);
    expect(snapshot.worstFrameMs).toBe(120);
    expect(snapshot.worstRecentFrameMs).toBe(120);
    expect(snapshot.frameBudgetMissesOver16Ms).toBe(2);
    expect(snapshot.frameBudgetMissesOver33Ms).toBe(2);
    expect(snapshot.longFramesOver50Ms).toBe(2);
    expect(snapshot.longFramesOver100Ms).toBe(1);
    expect(snapshot.lastLongFrameReason).toBe("raf");
  });

  it("computes per-second counters from snapshot intervals", () => {
    let now = 0;
    const metrics = new PerfMetrics(() => now);

    metrics.noteMapRenderEvent();
    metrics.noteMapRenderEvent();
    metrics.noteFrame(16, "raf");
    metrics.noteFrame(16, "raf");
    metrics.noteCameraEaseTo();
    metrics.noteWebSocketMessage();
    metrics.notePlayerSnapshot();
    metrics.noteWebSocketMessage();
    metrics.noteFlagsSnapshot();
    now = 500;

    const snapshot = metrics.getSnapshot();
    expect(snapshot.fps).toBe(4);
    expect(snapshot.mapRenderEventsPerSec).toBe(4);
    expect(snapshot.cameraEaseToPerSec).toBe(2);
    expect(snapshot.websocketSnapshotsPerSec).toBe(4);
    expect(snapshot.playerSnapshotsPerSec).toBe(2);
    expect(snapshot.flagSnapshotsPerSec).toBe(2);
    expect(snapshot.totalWsMessagesPerSec).toBe(4);
  });

  it("tracks map activity and selected flag metadata", () => {
    const metrics = new PerfMetrics(() => 0);

    metrics.setMapActivity({ moving: true, zooming: false });
    metrics.setVisibleFlagCount(12);
    metrics.setSelectedFlagId("flag-1");

    const snapshot = metrics.getSnapshot();
    expect(snapshot.mapMoving).toBe(true);
    expect(snapshot.mapZooming).toBe(false);
    expect(snapshot.visibleFlagCount).toBe(12);
    expect(snapshot.selectedFlagId).toBe("flag-1");
  });

  it("tracks collectible counts, redraws, snapshots, and survey timing", () => {
    let now = 0;
    const metrics = new PerfMetrics(() => now);

    metrics.setCollectibleCount(120);
    metrics.setWaterHighlightCount(3);
    metrics.noteCollectibleSnapshot(120);
    metrics.noteInventorySnapshot();
    metrics.noteCollectibleRedraw(4.5);
    metrics.noteSurveyRequest();
    metrics.noteSurveyResponse(220);
    now = 1_000;

    const snapshot = metrics.getSnapshot();
    expect(snapshot.collectibleCount).toBe(120);
    expect(snapshot.collectibleCountMax).toBe(120);
    expect(snapshot.waterHighlightCount).toBe(3);
    expect(snapshot.waterHighlightCountMax).toBe(3);
    expect(snapshot.collectibleSnapshotCount).toBe(1);
    expect(snapshot.collectibleSnapshotsPerSec).toBe(1);
    expect(snapshot.collectibleSnapshotNodeCount).toBe(120);
    expect(snapshot.inventorySnapshotCount).toBe(1);
    expect(snapshot.collectibleRedrawCount).toBe(1);
    expect(snapshot.collectibleRedrawsPerSec).toBe(1);
    expect(snapshot.maxCollectibleDrawMs).toBe(4.5);
    expect(snapshot.surveyRequestCount).toBe(1);
    expect(snapshot.lastSurveyResponseMs).toBe(220);
  });

  it("tracks static overlay redraw and interaction skip counters", () => {
    let now = 0;
    const metrics = new PerfMetrics(() => now);

    metrics.noteStaticOverlayRedraw(12.5);
    metrics.noteStaticOverlayRedraw(3);
    metrics.noteTerritoryRedraw();
    metrics.noteStaticOverlaySkippedDuringInteraction();
    metrics.noteStaticOverlaySkippedDuringInteraction();
    now = 1_000;

    const snapshot = metrics.getSnapshot();
    expect(snapshot.staticOverlayRedrawCount).toBe(2);
    expect(snapshot.staticOverlayRedrawsPerSec).toBe(2);
    expect(snapshot.staticOverlaySkippedDuringInteractionCount).toBe(2);
    expect(snapshot.territoryRedrawCount).toBe(1);
    expect(snapshot.maxStaticOverlayDrawMs).toBe(12.5);
  });

  it("tracks local movement and Pixi frame correlation metrics", () => {
    const metrics = new PerfMetrics(() => 0);

    metrics.noteDynamicOverlayUpdate(2.5);
    metrics.noteDynamicOverlayUpdate(4);
    metrics.notePixiRenderCall(1.5);
    metrics.noteLocalMovementFrame(120, 0, 60, 135, true);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.dynamicOverlayUpdateCount).toBe(2);
    expect(snapshot.dynamicOverlayUpdateMs).toBe(6.5);
    expect(snapshot.maxDynamicOverlayUpdateMs).toBe(4);
    expect(snapshot.pixiRenderCallCount).toBe(1);
    expect(snapshot.maxPixiRenderCallMs).toBe(1.5);
    expect(snapshot.lastLocalMovementFrameMs).toBe(120);
    expect(snapshot.maxLocalMovementFrameMs).toBe(120);
    expect(snapshot.localMovementDiscardedMs).toBe(0);
    expect(snapshot.localPredictionLeadM).toBe(60);
    expect(snapshot.localAuthorityAgeMs).toBe(135);
    expect(snapshot.localLeadCapHoldCount).toBe(1);
  });

  it("resets counters without clearing load milestones", () => {
    let now = 0;
    const metrics = new PerfMetrics(() => now);
    metrics.markLoadMilestone("app mounted");
    metrics.noteFrame(80, "raf");
    metrics.noteMapRenderEvent();
    metrics.noteStaticOverlayRedraw(10);
    metrics.noteStaticOverlaySkippedDuringInteraction();

    now = 100;
    metrics.resetCounters();
    const snapshot = metrics.getSnapshot();

    expect(snapshot.longFramesOver50Ms).toBe(0);
    expect(snapshot.mapRenderEventsReceived).toBe(0);
    expect(snapshot.staticOverlayRedrawCount).toBe(0);
    expect(snapshot.staticOverlaySkippedDuringInteractionCount).toBe(0);
    expect(snapshot.loadMilestones).toEqual([
      {
        name: "app mounted",
        atMs: 0,
        elapsedMs: 0
      }
    ]);
  });

  it("reports window length, active time, tags and per-window static max", () => {
    let now = 0;
    const metrics = new PerfMetrics(() => now);
    metrics.takeOverlayWindow("w");
    metrics.setMapActivity({ zooming: true });
    metrics.noteFrame(16, "raf");
    metrics.noteFrame(500, "raf");
    metrics.noteStaticOverlayRedraw(30, "full");
    now = 400;
    metrics.setMapActivity({ zooming: false });
    metrics.noteStaticOverlayRedraw(5, "flag-travel-live");
    metrics.noteRenderReason("players");
    now = 1_000;
    const first = metrics.takeOverlayWindow("w");
    expect(first.windowMs).toBe(1_000);
    expect(first.activeMs).toBe(16);
    expect(first.zoomMs).toBe(400);
    expect(first.maxStaticOverlayDrawMs).toBe(30);
    expect(first.liveStaticOverlayRedraws).toBe(1);
    expect(first.renderReasons).toEqual([["players", 1]]);
    now = 2_000;
    const second = metrics.takeOverlayWindow("w");
    expect(second.windowMs).toBe(1_000);
    expect(second.maxStaticOverlayDrawMs).toBe(0);
    expect(second.zoomMs).toBe(0);
    expect(second.renderReasons).toEqual([]);
  });
});

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import { FlagTravelPresentationInstrumentation } from "./flagTravelPresentationInstrumentation.js";

describe("flag travel frame instrumentation", () => {
  it("correlates destination commit and first Pixi paint to the travel request", () => {
    const record = vi.spyOn(gameplayLatencyTrace, "record")
      .mockReturnValue(true);
    const instrumentation = new FlagTravelPresentationInstrumentation();
    instrumentation.beginTrace("travel-1", 12);

    instrumentation.event("destination-state-committed");
    instrumentation.event("first-destination-pixi-paint");
    instrumentation.event("camera-moveend");

    expect(record).toHaveBeenNthCalledWith(
      1,
      "ui",
      "destination_state_committed",
      expect.objectContaining({ relocationRevision: 12 }),
      { traceId: "travel-1" }
    );
    expect(record).toHaveBeenNthCalledWith(
      2,
      "ui",
      "first_destination_pixi_paint",
      expect.objectContaining({ relocationRevision: 12 }),
      { traceId: "travel-1" }
    );
    expect(record).toHaveBeenCalledTimes(2);
    record.mockRestore();
  });

  it("counts no blank or mobs-without-static frames for an atomic retained-world swap", () => {
    const instrumentation = new FlagTravelPresentationInstrumentation();
    instrumentation.reset();

    for (let frame = 0; frame < 12; frame += 1) {
      instrumentation.frame({
        flagsVisible: true,
        leashVisible: true,
        mobsVisible: true,
        retainedObjectCount: 7,
        plannedLocalPlayerPosition: { x: 640, y: 360 },
        localPlayerPosition: { x: 640, y: 360 },
        localPlayerParent: "localPlayerLayer",
        localPlayerRetainedCount: 1,
        localPlayerInsideViewport: true,
        destination: frame === 11
      });
    }
    instrumentation.event("destination-state-committed");
    instrumentation.event("first-destination-pixi-paint");

    expect(instrumentation.snapshot()).toEqual({
      blankOverlayFrameCount: 0,
      flagsVisibleFrameCount: 12,
      leashVisibleFrameCount: 12,
      mobsWithoutStaticWorldFrameCount: 0,
      retainedObjectCount: 7,
      committedDestinationCount: 1,
      originLocalPlayerPosition: { x: 640, y: 360 },
      currentLocalPlayerPosition: { x: 640, y: 360 },
      destinationLocalPlayerPosition: { x: 640, y: 360 },
      maxLocalPlayerDriftPx: 0,
      plannedLocalPlayerPosition: { x: 640, y: 360 },
      actualLocalPlayerPosition: { x: 640, y: 360 },
      maxLocalPlayerPathErrorPx: 0,
      finalPreCommitPlayerPosition: null,
      destinationCommittedPlayerPosition: { x: 640, y: 360 },
      destinationCommitSnapDistancePx: 0,
      maximumPerFramePlayerDisplacementPx: 0,
      localPlayerParent: "localPlayerLayer",
      localPlayerRetainedCount: 1,
      localPlayerOutsideViewportFrameCount: 0,
      cameraGeneration: null,
      cameraPlan: null,
      cameraDurationMs: null,
      projectedDistancePx: null,
      viewportDistance: null
    });
  });

  it("keeps the retained object count bounded across 100 A/B commits", () => {
    const instrumentation = new FlagTravelPresentationInstrumentation();
    instrumentation.reset();
    for (let hop = 0; hop < 100; hop += 1) {
      instrumentation.frame({
        flagsVisible: true,
        leashVisible: true,
        mobsVisible: true,
        retainedObjectCount: 7,
        plannedLocalPlayerPosition: { x: 640, y: 360 },
        localPlayerPosition: { x: 640, y: 360 },
        localPlayerParent: "localPlayerLayer",
        localPlayerRetainedCount: 1,
        localPlayerInsideViewport: true
      });
      instrumentation.event("destination-state-committed");
    }

    expect(instrumentation.snapshot()).toMatchObject({
      blankOverlayFrameCount: 0,
      mobsWithoutStaticWorldFrameCount: 0,
      retainedObjectCount: 7,
      committedDestinationCount: 100,
      localPlayerRetainedCount: 1
    });
  });

  it("treats path error and commit snap, rather than origin drift, as correctness", () => {
    const instrumentation = new FlagTravelPresentationInstrumentation();
    instrumentation.reset();
    instrumentation.setCameraGeneration(42);

    const checkpoints = [110, 300, 420, 470, 471.5];
    for (const checkpoint of checkpoints) {
      instrumentation.frame({
        flagsVisible: true,
        leashVisible: true,
        mobsVisible: true,
        retainedObjectCount: 7,
        plannedLocalPlayerPosition: { x: checkpoint, y: 399 },
        localPlayerPosition: { x: checkpoint, y: 399 },
        localPlayerParent: "localPlayerLayer",
        localPlayerRetainedCount: 1,
        localPlayerInsideViewport: true,
        finalPreCommit: checkpoint === 471.5
      });
    }
    instrumentation.frame({
      flagsVisible: true,
      leashVisible: true,
      mobsVisible: true,
      retainedObjectCount: 7,
      plannedLocalPlayerPosition: null,
      localPlayerPosition: { x: 471.5, y: 399 },
      localPlayerParent: "localPlayerLayer",
      localPlayerRetainedCount: 1,
      localPlayerInsideViewport: true,
      destination: true
    });

    const metrics = instrumentation.snapshot();
    expect(metrics.maxLocalPlayerDriftPx).toBeGreaterThan(300);
    expect(metrics.maxLocalPlayerPathErrorPx).toBeLessThanOrEqual(1);
    expect(metrics.destinationCommitSnapDistancePx).toBeLessThanOrEqual(1);
    expect(metrics).toMatchObject({
      originLocalPlayerPosition: { x: 110, y: 399 },
      destinationLocalPlayerPosition: { x: 471.5, y: 399 },
      plannedLocalPlayerPosition: null,
      actualLocalPlayerPosition: { x: 471.5, y: 399 },
      maxLocalPlayerPathErrorPx: 0,
      finalPreCommitPlayerPosition: { x: 471.5, y: 399 },
      destinationCommittedPlayerPosition: { x: 471.5, y: 399 },
      destinationCommitSnapDistancePx: 0,
      localPlayerParent: "localPlayerLayer",
      localPlayerRetainedCount: 1,
      localPlayerOutsideViewportFrameCount: 0,
      cameraGeneration: 42,
      cameraPlan: null,
      cameraDurationMs: null,
      projectedDistancePx: null,
      viewportDistance: null
    });
  });

  it("records the viewport-relative camera plan", () => {
    const instrumentation = new FlagTravelPresentationInstrumentation();
    instrumentation.reset();
    instrumentation.setCameraPlan({
      plan: "continuous",
      durationMs: 324,
      projectedDistancePx: 720,
      viewportDistance: 0.78
    });

    expect(instrumentation.snapshot()).toMatchObject({
      cameraPlan: "continuous",
      cameraDurationMs: 324,
      projectedDistancePx: 720,
      viewportDistance: 0.78
    });
  });
});

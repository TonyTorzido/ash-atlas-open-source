import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createAnimationFrameLoop,
  paintMapSynchronizedOverlayFrame
} from "./pixiOverlay.js";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n"
);
const overlaySource = readFileSync(
  new URL("./pixiOverlay.ts", import.meta.url),
  "utf8"
).replaceAll("\r\n", "\n");

describe("manual map-drag render ownership", () => {
  it("shows why an unpaused animation loop would add a second paint", () => {
    const scheduler = new FakeAnimationFrameScheduler();
    const paint = vi.fn<(owner: "map" | "animation") => void>();
    const loop = createAnimationFrameLoop(() => paint("animation"), scheduler);

    paintMapSynchronizedOverlayFrame(
      vi.fn(),
      vi.fn(),
      () => paint("map")
    );

    expect(paint.mock.calls).toEqual([["map"]]);
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.runOnlyFrame(16.7);

    expect(paint.mock.calls).toEqual([["map"], ["animation"]]);
    loop.stop();
  });

  it("can pause the independent paint while map-synchronized frames continue", () => {
    const scheduler = new FakeAnimationFrameScheduler();
    const paint = vi.fn<(owner: "map" | "animation") => void>();
    const loop = createAnimationFrameLoop(() => paint("animation"), scheduler);

    loop.setActive(false);
    expect(scheduler.pendingCount()).toBe(0);

    paintMapSynchronizedOverlayFrame(
      vi.fn(),
      vi.fn(),
      () => paint("map")
    );

    expect(paint.mock.calls).toEqual([["map"]]);
    expect(scheduler.pendingCount()).toBe(0);

    loop.setActive(true);
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.runOnlyFrame(33.4);

    expect(paint.mock.calls).toEqual([["map"], ["animation"]]);
    loop.stop();
  });

  it("uses the shared real frame clock and complete timed presentation during manual interaction", () => {
    const mapTransformFrame = sourceBetween(
      overlaySource,
      "  const markMapTransformDirty = (): void => {",
      "  const getCachedTerritoryGroups ="
    );
    const manualInteractionFrame = sourceBetween(
      mapTransformFrame,
      "      if (manualViewportInteractionActive) {",
      "        perfMetrics.noteStaticOverlaySkippedDuringInteraction();"
    );
    const frameClock = sourceBetween(
      overlaySource,
      "  const takeFrameTiming = (frameTimeMs?: number): { now: number; deltaSeconds: number } => {",
      "  const markAllStaticLayersDirty ="
    );
    const timedPresentation = sourceBetween(
      overlaySource,
      "  const drawTimedDynamicPresentation = (",
      "  const drawFrame ="
    );
    const animationFrame = sourceBetween(
      overlaySource,
      "  const drawFrame = (frameTimeMs?: number): void => {",
      "  const dynamicAnimation ="
    );

    expect(frameClock).toContain("Math.max((now - lastFrameAt) / 1_000, 0)");
    expect(frameClock).toContain("0.1");
    expect(manualInteractionFrame).toContain("takeFrameTiming()");
    expect(manualInteractionFrame).toContain(
      "drawTimedDynamicPresentation(now, deltaSeconds)"
    );
    expect(timedPresentation).toContain(
      "drawDynamicEntities(displayStateForDynamicEntities(), deltaSeconds, now)"
    );
    expect(timedPresentation).toContain("drawTauntPulse(now)");
    expect(timedPresentation).not.toContain("drawGatheringProgress()");
    expect(timedPresentation).toContain("drawDamageFloaters(now)");
    expect(animationFrame).toContain("takeFrameTiming(frameTimeMs)");
    expect(animationFrame).toContain("drawTimedDynamicPresentation(now, deltaSeconds)");
  });

  it("suspends the custom loop for manual viewport interaction and visibility transitions", () => {
    const viewportInteraction = sourceBetween(
      overlaySource,
      "    setViewportInteractionActive(active: boolean): void {",
      "    setProgrammaticCameraMoveActive(active: boolean): void {"
    );
    const programmaticInteraction = sourceBetween(
      overlaySource,
      "    setProgrammaticCameraMoveActive(active: boolean): void {",
      "    beginFlagTravelPresentation("
    );
    const animationState = sourceBetween(
      overlaySource,
      "  const syncDynamicAnimationState = (): void => {",
      "  return {"
    );

    expect(viewportInteraction).toContain("staticLayersFrozen = true");
    expect(viewportInteraction.indexOf("manualViewportInteractionActive = true"))
      .toBeLessThan(viewportInteraction.indexOf("syncDynamicAnimationState()"));
    expect(animationState).toMatch(
      /dynamicAnimation\.setActive\(\s*renderingActive\s*&&\s*!manualViewportInteractionActive\s*&&\s*!flagTravelVisibilityTransition\s*\)/
    );
    expect(programmaticInteraction).not.toContain("manualViewportInteractionActive");
    expect(programmaticInteraction).not.toContain("syncDynamicAnimationState");
  });

  it("rebuilds every static layer from the latest state when programmatic movement ends", () => {
    const programmaticInteraction = sourceBetween(
      overlaySource,
      "    setProgrammaticCameraMoveActive(active: boolean): void {",
      "    beginFlagTravelPresentation("
    );

    expect(programmaticInteraction).toContain("markAllStaticLayersDirty()");
    expect(programmaticInteraction).not.toContain(
      "if (pendingTransformRedraw || hasDirtyStaticLayers())"
    );
    expect(programmaticInteraction.indexOf("markAllStaticLayersDirty()"))
      .toBeLessThan(programmaticInteraction.indexOf("drawDirtyStaticLayers(latestState)"));
  });

  it("keeps rendering activation from restarting the loop during manual interaction", () => {
    const renderingLifecycle = sourceBetween(
      overlaySource,
      "    setRenderingActive(active: boolean): void {",
      "    isRenderingActive(): boolean"
    );

    expect(renderingLifecycle).toContain("syncDynamicAnimationState()");
    expect(renderingLifecycle).not.toContain("dynamicAnimation.setActive(active)");
  });

  it("defers one exact static rebuild until the resumed frame", () => {
    const viewportInteraction = sourceBetween(
      overlaySource,
      "    setViewportInteractionActive(active: boolean): void {",
      "    setProgrammaticCameraMoveActive(active: boolean): void {"
    );
    const idleRelease = sourceBetween(
      appSource,
      "    const finishViewportInteractionIfIdle = (): void => {",
      "    const scheduleViewportInteractionEnd = (): void => {"
    );

    expect(viewportInteraction).toContain("markAllStaticLayersDirty()");
    expect(viewportInteraction).not.toContain("drawDirtyStaticLayers(latestState)");
    expect(viewportInteraction.indexOf("lastFrameAt = performance.now()"))
      .toBeLessThan(viewportInteraction.indexOf("manualViewportInteractionActive = false"));
    expect(viewportInteraction.indexOf("manualViewportInteractionActive = false"))
      .toBeLessThan(viewportInteraction.lastIndexOf("syncDynamicAnimationState()"));
    expect(idleRelease.indexOf("setViewportInteractionActive(false)"))
      .toBeLessThan(idleRelease.indexOf("refreshOverlay()"));
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

class FakeAnimationFrameScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  };

  cancelAnimationFrame = (id: number): void => {
    this.callbacks.delete(id);
  };

  pendingCount(): number {
    return this.callbacks.size;
  }

  runOnlyFrame(timestamp: number): void {
    expect(this.callbacks.size).toBe(1);
    const [id, callback] = [...this.callbacks.entries()][0]!;
    this.callbacks.delete(id);
    callback(timestamp);
  }
}

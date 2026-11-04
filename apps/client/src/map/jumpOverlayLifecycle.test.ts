import { describe, expect, it } from "vitest";

import { CameraActionGeneration } from "./cameraActionGeneration.js";
import { OverlayInteractionGate } from "./overlayInteractionGate.js";
import { restoreSuppressedStaticOverlay } from "./staticOverlayRestoration.js";

type Anchor = { id: string; lat: number; lon: number };

describe("jump overlay lifecycle", () => {
  it.each(["normal", "auto"])("restores %s jump flags from the current projection after a hidden drag", () => {
    const anchors: Anchor[] = [
      { id: "flag-a", lat: 35.1, lon: -106.6 },
      { id: "flag-b", lat: 35.2, lon: -106.7 }
    ];
    let offset = { x: 10, y: 20 };
    const project = (anchor: Anchor) => ({ x: anchor.lon * 10 + offset.x, y: anchor.lat * 10 + offset.y });
    const before = anchors.map(project);
    offset = { x: 140, y: -75 };

    const restored: Array<{ x: number; y: number }> = [];
    restoreSuppressedStaticOverlay({
      resetTransform: () => undefined,
      redraw: () => restored.push(...anchors.map(project)),
      reveal: () => undefined
    });

    expect(restored).toEqual(anchors.map(project));
    expect(restored).not.toEqual(before);
  });

  it("redraws before the first visible frame", () => {
    const order: string[] = [];
    restoreSuppressedStaticOverlay({
      resetTransform: () => order.push("reset"),
      redraw: () => order.push("redraw"),
      reveal: () => order.push("reveal")
    });
    expect(order).toEqual(["reset", "redraw", "reveal"]);
  });

  it("rejects a late jump completion after user drag supersedes it", () => {
    const actions = new CameraActionGeneration();
    const jump = actions.begin();
    actions.supersede();
    expect(actions.complete(jump)).toBe(false);
  });

  it("rejects jump A after jump B begins and only completes B", () => {
    const actions = new CameraActionGeneration();
    const jumpA = actions.begin();
    const jumpB = actions.begin();
    expect(actions.complete(jumpA)).toBe(false);
    expect(actions.complete(jumpB)).toBe(true);
  });

  it.each([
    ["zoom", 2],
    ["resize", 4]
  ])("uses the current %s projection when restoring", (_kind, scale) => {
    const flag = { id: "flag", lat: 35, lon: -106 };
    let restored = { x: 0, y: 0 };
    restoreSuppressedStaticOverlay({
      resetTransform: () => undefined,
      redraw: () => { restored = { x: flag.lon * scale, y: flag.lat * scale }; },
      reveal: () => undefined
    });
    expect(restored).toEqual({ x: flag.lon * scale, y: flag.lat * scale });
  });

  it.each([
    [390, 844],
    [768, 1024],
    [1024, 768],
    [1440, 900]
  ])("restores authoritative anchors at %i x %i", (width, height) => {
    const flag = { id: "flag", lat: 35, lon: -106 };
    const project = (anchor: Anchor) => ({
      x: width / 2 + anchor.lon,
      y: height / 2 - anchor.lat
    });
    let restored = { x: 0, y: 0 };
    restoreSuppressedStaticOverlay({
      resetTransform: () => undefined,
      redraw: () => { restored = project(flag); },
      reveal: () => undefined
    });
    expect(restored).toEqual(project(flag));
  });

  it("turns a user drag during a programmatic move into the shared frozen interaction", () => {
    const gate = new OverlayInteractionGate();
    gate.beginProgrammaticCameraMove();
    expect(gate.begin("drag")).toBe("superseded-programmatic");
    expect(gate.isProgrammaticCameraMoveActive()).toBe(false);
    expect(gate.isFrozen()).toBe(true);
  });

  it("keeps ordinary visible dragging on the shared frozen interaction path", () => {
    const gate = new OverlayInteractionGate();
    expect(gate.begin("drag")).toBe("started");
    expect(gate.isFrozen()).toBe(true);
  });

  it("restores flags and non-flag static anchors in one bounded redraw", () => {
    const anchors: Anchor[] = [
      { id: "flag", lat: 35, lon: -106 },
      { id: "city", lat: 36, lon: -105 },
      { id: "collectible", lat: 37, lon: -104 }
    ];
    let redraws = 0;
    const restored: string[] = [];
    restoreSuppressedStaticOverlay({
      resetTransform: () => undefined,
      redraw: () => {
        redraws += 1;
        restored.push(...anchors.map((anchor) => anchor.id));
      },
      reveal: () => undefined
    });
    expect(redraws).toBe(1);
    expect(restored).toEqual(["flag", "city", "collectible"]);
  });
});

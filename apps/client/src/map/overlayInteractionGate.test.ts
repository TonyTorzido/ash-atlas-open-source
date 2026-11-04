import { describe, expect, it } from "vitest";

import { OverlayInteractionGate } from "./overlayInteractionGate.js";

describe("OverlayInteractionGate", () => {
  it("freezes on dragstart and waits for idle after dragend", () => {
    const gate = new OverlayInteractionGate();

    expect(gate.begin("drag")).toBe("started");
    expect(gate.isFrozen()).toBe(true);
    expect(gate.end("drag")).toBe("wait-for-idle");
    expect(gate.isFrozen()).toBe(true);
    expect(gate.finishIdle()).toBe("ended");
    expect(gate.isFrozen()).toBe(false);
  });

  it("coalesces overlapping move and zoom events into one idle thaw", () => {
    const gate = new OverlayInteractionGate();

    expect(gate.begin("move")).toBe("started");
    expect(gate.begin("zoom")).toBe("already-active");
    expect(gate.end("move")).toBe("still-active");
    expect(gate.finishIdle()).toBe("none");
    expect(gate.end("zoom")).toBe("wait-for-idle");
    expect(gate.finishIdle()).toBe("ended");
    expect(gate.finishIdle()).toBe("none");
  });

  it("keeps the overlay frozen when a new interaction starts before idle", () => {
    const gate = new OverlayInteractionGate();

    expect(gate.begin("drag")).toBe("started");
    expect(gate.end("drag")).toBe("wait-for-idle");
    expect(gate.begin("zoom")).toBe("already-active");
    expect(gate.finishIdle()).toBe("none");
    expect(gate.end("zoom")).toBe("wait-for-idle");
    expect(gate.finishIdle()).toBe("ended");
  });

  it("lets explicit user movement supersede a programmatic camera move", () => {
    const gate = new OverlayInteractionGate();

    expect(gate.beginProgrammaticCameraMove()).toBe("started");
    expect(gate.isProgrammaticCameraMoveActive()).toBe(true);
    expect(gate.begin("move")).toBe("superseded-programmatic");
    expect(gate.begin("zoom")).toBe("already-active");
    expect(gate.isFrozen()).toBe(true);
    expect(gate.endProgrammaticCameraMove()).toBe("inactive");
    expect(gate.isProgrammaticCameraMoveActive()).toBe(false);
  });

  it("moves recenter into user freeze mode when user movement begins", () => {
    const gate = new OverlayInteractionGate();

    expect(gate.beginProgrammaticCameraMove()).toBe("started");
    expect(gate.begin("move")).toBe("superseded-programmatic");
    expect(gate.isFrozen()).toBe(true);
    expect(gate.finishIdle()).toBe("none");
    expect(gate.endProgrammaticCameraMove()).toBe("inactive");
  });

  it("moves visit flag jumps into user freeze mode when zoom supersedes them", () => {
    const gate = new OverlayInteractionGate();

    expect(gate.beginProgrammaticCameraMove()).toBe("started");
    expect(gate.begin("zoom")).toBe("superseded-programmatic");
    expect(gate.begin("move")).toBe("already-active");
    expect(gate.isFrozen()).toBe(true);
    expect(gate.endProgrammaticCameraMove()).toBe("inactive");
    expect(gate.finishIdle()).toBe("none");
  });

  it("programmatic camera movement cancels any pending user freeze", () => {
    const gate = new OverlayInteractionGate();

    expect(gate.begin("drag")).toBe("started");
    expect(gate.end("drag")).toBe("wait-for-idle");
    expect(gate.isFrozen()).toBe(true);

    expect(gate.beginProgrammaticCameraMove()).toBe("started");
    expect(gate.isFrozen()).toBe(false);
    expect(gate.finishIdle()).toBe("none");
    expect(gate.endProgrammaticCameraMove()).toBe("ended");
  });

  it("dedupes duplicate user end and idle events into one thaw", () => {
    const gate = new OverlayInteractionGate();

    expect(gate.begin("drag")).toBe("started");
    expect(gate.end("drag")).toBe("wait-for-idle");
    expect(gate.end("drag")).toBe("still-active");
    expect(gate.finishIdle()).toBe("ended");
    expect(gate.finishIdle()).toBe("none");
    expect(gate.isFrozen()).toBe(false);
  });

  it("coalesces duplicate programmatic camera moves into one final end", () => {
    const gate = new OverlayInteractionGate();

    expect(gate.beginProgrammaticCameraMove()).toBe("started");
    expect(gate.beginProgrammaticCameraMove()).toBe("already-active");
    expect(gate.endProgrammaticCameraMove()).toBe("ended");
    expect(gate.isProgrammaticCameraMoveActive()).toBe(false);
    expect(gate.endProgrammaticCameraMove()).toBe("inactive");
  });
});

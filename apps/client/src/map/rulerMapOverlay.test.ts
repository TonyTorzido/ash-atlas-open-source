// @vitest-environment jsdom

import type maplibregl from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { mountRulerMapOverlay } from "./rulerMapOverlay.js";

describe("ruler map overlay", () => {
  it("keeps one root while updating and renders both completed endpoints", () => {
    const map = new FakeRulerMap();
    const overlay = mountRulerMapOverlay(map as unknown as maplibregl.Map);
    const root = map.container.querySelector(".ruler-map-overlay");
    expect(root?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 320 180");

    overlay.update({ pending: { lat: 1, lon: 2 }, lines: [] }, null);
    expect(map.container.querySelector(".ruler-map-overlay")).toBe(root);
    expect(root?.querySelectorAll(".ruler-map-point")).toHaveLength(1);

    overlay.update({
      pending: null,
      lines: [{
        start: { lat: 1, lon: 2 },
        end: { lat: 3, lon: 4 },
        distanceM: 125
      }]
    }, null);
    map.emitRender();

    expect(map.container.querySelector(".ruler-map-overlay")).toBe(root);
    expect(root?.querySelectorAll(".ruler-map-line")).toHaveLength(1);
    expect(root?.querySelectorAll(".ruler-map-point")).toHaveLength(2);
    expect(root?.querySelector(".ruler-map-label")?.textContent).toBe("125 m");

    const planningLine = {
      start: { lat: 5, lon: 6 },
      end: { lat: 7, lon: 8 },
      distanceM: 575
    };
    overlay.update({ pending: null, lines: [] }, null, [planningLine], planningLine);
    map.emitRender();
    expect(root?.querySelectorAll(".planning-anchor-line")).toHaveLength(1);
    expect(root?.querySelectorAll(".planning-anchor-preview")).toHaveLength(1);

    overlay.update(
      { pending: null, lines: [] },
      null,
      [],
      null,
      { kind: "flag", id: "flag-1", label: "Test Tower", position: { lat: 5, lon: 6 } },
      575,
      [{
        id: "anchor-1",
        layerId: "main",
        number: 1,
        source: { kind: "flag", id: "flag-1", label: "Test Tower", position: { lat: 5, lon: 6 } },
        distanceM: 575,
        position: { lat: 7, lon: 8 },
        createdAt: 1
      }]
    );
    expect(root?.querySelectorAll(".planning-anchor-source-circle")).toHaveLength(1);
    expect(root?.querySelectorAll(".planning-anchor-source-dot")).toHaveLength(1);
    expect(root?.querySelector(".planning-anchor-marker-label")?.textContent).toBe("Anchor 1");

    overlay.update(
      { pending: null, lines: [] },
      null,
      [planningLine],
      null,
      null,
      null,
      [{
        id: "anchor-1",
        layerId: "main",
        number: 1,
        source: { kind: "flag", id: "flag-1", label: "Test Tower", position: { lat: 5, lon: 6 } },
        distanceM: 575,
        position: { lat: 7, lon: 8 },
        createdAt: 1
      }]
    );
    expect(root?.querySelectorAll(".planning-anchor-line")).toHaveLength(1);
    expect(root?.querySelectorAll(".planning-anchor-source-circle")).toHaveLength(1);
    expect(root?.querySelectorAll(".planning-anchor-marker")).toHaveLength(1);

    overlay.destroy();
    expect(map.container.querySelector(".ruler-map-overlay")).toBeNull();
  });
});

class FakeRulerMap {
  readonly mapContainer = document.createElement("div");
  readonly container = document.createElement("div");
  private renderListener: (() => void) | null = null;

  constructor() {
    this.mapContainer.append(this.container);
    Object.defineProperties(this.mapContainer, {
      clientWidth: { value: 320 },
      clientHeight: { value: 180 }
    });
    this.mapContainer.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 320,
      bottom: 0,
      width: 320,
      height: 180,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
    Object.defineProperties(this.container, {
      clientWidth: { value: 320 },
      clientHeight: { value: 0 }
    });
    this.container.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 320,
      bottom: 180,
      width: 320,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
  }

  getContainer(): HTMLElement { return this.mapContainer; }
  getCanvasContainer(): HTMLElement { return this.container; }
  project(point: [number, number]): { x: number; y: number } {
    return { x: point[0] * 10, y: point[1] * 10 };
  }
  on(type: string, listener: () => void): this {
    if (type === "render") this.renderListener = listener;
    return this;
  }
  off(type: string, listener: () => void): this {
    if (type === "render" && this.renderListener === listener) this.renderListener = null;
    return this;
  }
  emitRender(): void { this.renderListener?.(); }
}

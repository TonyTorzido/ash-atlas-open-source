import { describe, expect, it } from "vitest";

import {
  pngInteractionHitBox,
  worldPngDimensionsForZoom,
  worldPngInteractionHitBox,
  WORLD_PNG_PRESENTATION
} from "./worldPngPresentation.js";

describe("runtime PNG interaction geometry", () => {
  it("positions a screen-pixel circle from normalized frame coordinates", () => {
    expect(pngInteractionHitBox({
      x: 100,
      y: 200,
      width: 80,
      height: 120,
      anchorX: 0.5,
      anchorY: 1,
      geometry: { shape: "circle", centerX: 0.25, centerY: 0.5, radiusPx: 23 }
    })).toEqual({ shape: "circle", x: 80, y: 140, radius: 23 });
  });

  it("scales a normalized rectangle with the rendered frame and tier scale", () => {
    const geometry = { shape: "rectangle" as const, centerX: 0.5, centerY: 0.5, width: 0.75, height: 0.5 };
    const base = pngInteractionHitBox({
      x: 300, y: 400, width: 100, height: 80, anchorX: 0.5, anchorY: 0.9, geometry
    });
    const tier = pngInteractionHitBox({
      x: 300, y: 400, width: 132, height: 105.6, anchorX: 0.5, anchorY: 0.9, geometry
    });
    expect(base).toMatchObject({ shape: "rectangle", left: 262.5, right: 337.5 });
    expect(tier).toMatchObject({ shape: "rectangle", left: 250.5, right: 349.5 });
  });

  it("centers the market target over the dedicated City Market artwork", () => {
    const market = WORLD_PNG_PRESENTATION.cityStructures.market;
    const hit = pngInteractionHitBox({
      x: 500,
      y: 600,
      width: market.width,
      height: market.height,
      anchorX: market.anchorX,
      anchorY: market.anchorY,
      geometry: market.hitGeometry
    });
    expect(market.hitGeometry).toMatchObject({
      shape: "rectangle",
      centerX: 0.5,
      centerY: 0.489,
      width: 1.039,
      height: 1
    });
    expect(hit).toMatchObject({ shape: "rectangle" });
    if (hit.shape === "rectangle") {
      expect((hit.left + hit.right) / 2).toBeCloseTo(500 + (0.5 - market.anchorX) * 88.2);
      expect((hit.top + hit.bottom) / 2).toBeCloseTo(600 + (0.489 - 0.6199870042398438) * 58.8);
    }
  });

  it("preserves the tannery procedural marker hit placement", () => {
    const key = "tannery" as const;
    const expectedX = 506.39142;
    const expectedY = 588.13003;
    const radius = 25;
    const presentation = WORLD_PNG_PRESENTATION[key];
    expect(presentation.hitGeometry).toMatchObject({ shape: "circle", radiusPx: radius });
    const hit = pngInteractionHitBox({
      x: 500,
      y: 600,
      width: presentation.width,
      height: presentation.height,
      anchorX: presentation.anchorX,
      anchorY: presentation.anchorY,
      geometry: presentation.hitGeometry
    });
    expect(hit).toMatchObject({ shape: "circle", radius });
    if (hit.shape === "circle") {
      expect(hit.x).toBeCloseTo(expectedX, 5);
      expect(hit.y).toBeCloseTo(expectedY, 5);
    }
  });

  it("scales the tannery circle with its rendered world PNG", () => {
      const key = "tannery" as const;
      const presentation = WORLD_PNG_PRESENTATION[key];
      const base = worldPngInteractionHitBox({ x: 500, y: 600, zoom: 15, presentation });
      const zoomed = worldPngInteractionHitBox({ x: 500, y: 600, zoom: 16, presentation });
      expect(base.shape).toBe("circle");
      expect(zoomed.shape).toBe("circle");
      if (base.shape === "circle" && zoomed.shape === "circle") {
        const zoomScale = worldPngDimensionsForZoom(presentation, 16).height /
          worldPngDimensionsForZoom(presentation, 15).height;
        expect(zoomed.radius).toBeGreaterThan(base.radius);
        expect(zoomed.x).toBeCloseTo(500 + (base.x - 500) * zoomScale, 8);
        expect(zoomed.y).toBeCloseTo(600 + (base.y - 600) * zoomScale, 8);
      }
  });

  it("honors the Studio-authored rectangular Loom hit geometry", () => {
    const presentation = WORLD_PNG_PRESENTATION.loom;
    expect(presentation.hitGeometry).toMatchObject({
      shape: "rectangle",
      centerX: 0.5109224139036008,
      centerY: 0.5086474223071392,
      width: 1,
      height: 1
    });
    const hit = worldPngInteractionHitBox({ x: 500, y: 600, zoom: 15, presentation });
    const dimensions = worldPngDimensionsForZoom(presentation, 15);
    expect(hit.shape).toBe("rectangle");
    if (hit.shape === "rectangle") {
      expect(hit.right - hit.left).toBeCloseTo(dimensions.width);
      expect(hit.bottom - hit.top).toBeCloseTo(dimensions.height);
    }
  });
});

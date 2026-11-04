import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SPRITE_BASE_ZOOM, SPRITE_PRESENTATION } from "./spritePresentation.js";
import {
  MOB_SPRITE_PRESENTATION,
  spriteInteractionHitBox,
  treeSpriteRectangle
} from "./pixiOverlay.js";
import { setWorldPngMasterScalePreview } from "./worldPngMasterScale.js";

beforeEach(() => { setWorldPngMasterScalePreview(1); });
afterEach(() => { setWorldPngMasterScalePreview(null); });

describe("tree sprite rectangle hitbox", () => {
  it("stretches sprite interaction width without changing its height", () => {
    const regular = spriteInteractionHitBox({
      x: 100,
      y: 100,
      textureWidth: 80,
      textureHeight: 100,
      zoom: SPRITE_BASE_ZOOM,
      presentation: SPRITE_PRESENTATION.dog
    });
    const stretched = spriteInteractionHitBox({
      x: 100,
      y: 100,
      textureWidth: 80,
      textureHeight: 100,
      zoom: SPRITE_BASE_ZOOM,
      presentation: { ...SPRITE_PRESENTATION.dog, horizontalScale: 1.5 }
    });

    expect(regular.shape).toBe("rectangle");
    expect(stretched.shape).toBe("rectangle");
    if (regular.shape === "rectangle" && stretched.shape === "rectangle") {
      const regularArtWidth = regular.right - regular.left - 12;
      const stretchedArtWidth = stretched.right - stretched.left - 12;
      expect(stretchedArtWidth).toBeCloseTo(regularArtWidth * 1.5);
      expect(stretched.bottom - stretched.top).toBeCloseTo(regular.bottom - regular.top);
    }
  });
  it.each([
    SPRITE_BASE_ZOOM - 4,
    SPRITE_BASE_ZOOM,
    SPRITE_BASE_ZOOM + 4
  ])("tracks texture aspect ratio and anchor at zoom %s", (zoom) => {
    const hit = treeSpriteRectangle({
      x: 200,
      y: 300,
      textureWidth: 180,
      textureHeight: 240,
      zoom
    });
    expect(hit.shape).toBe("rectangle");
    expect(hit.left).toBeLessThan(200);
    expect(hit.right).toBeGreaterThan(200);
    expect(hit.top).toBeLessThan(300);
    expect(hit.bottom).toBeGreaterThan(300);
    // The authored rectangle shrinks to the quarter-size floor with six-pixel padding.
    const zoomScale = Math.max(0.25, 1.05 ** ((zoom - 15) * 10));
    expect(hit.right - hit.left).toBeCloseTo(86.4 * zoomScale * (180 / 240) * 0.7 + 12);
  });

  it("uses bounded padding and excludes points beyond every edge", () => {
    const hit = treeSpriteRectangle({
      x: 100,
      y: 100,
      textureWidth: 100,
      textureHeight: 100,
      zoom: SPRITE_BASE_ZOOM,
      paddingPx: 6
    });
    expect([
      { x: hit.left, y: 100 },
      { x: hit.right, y: 100 },
      { x: 100, y: hit.top },
      { x: 100, y: hit.bottom }
    ].every((point) =>
      point.x >= hit.left && point.x <= hit.right
      && point.y >= hit.top && point.y <= hit.bottom
    )).toBe(true);
    expect([
      { x: hit.left - 0.01, y: 100 },
      { x: hit.right + 0.01, y: 100 },
      { x: 100, y: hit.top - 0.01 },
      { x: 100, y: hit.bottom + 0.01 }
    ].every((point) =>
      point.x < hit.left || point.x > hit.right
      || point.y < hit.top || point.y > hit.bottom
    )).toBe(true);
  });

  it("uses authored mob rectangles at the current zoom with legacy tolerance", () => {
    const hit = spriteInteractionHitBox({
      x: 200,
      y: 300,
      textureWidth: 100,
      textureHeight: 200,
      zoom: SPRITE_BASE_ZOOM,
      presentation: MOB_SPRITE_PRESENTATION.deer
    });
    expect(hit.shape).toBe("rectangle");
    if (hit.shape === "rectangle") {
      expect(hit.right - hit.left).toBeCloseTo(69.5 / 2 * 0.469 + 12);
      expect(hit.bottom - hit.top).toBeCloseTo(69.5 * 0.741 + 12);
    }
  });
});

import { describe, expect, it } from "vitest";
import { clampWindowBounds, resizeWindowBounds, type WindowResizeCorner } from "./desktopWindowBounds.js";
describe("desktop window bounds", () => {
  it("clamps movement and growth to the visible area", () => {
    expect(clampWindowBounds({ x: -50, y: 999, width: 2000, height: 800 }, { width: 1280, height: 608 }))
      .toEqual({ x: 8, y: 8, width: 1264, height: 592 });
  });
  it("keeps readable minimums, with a safe small forced-desktop fallback", () => {
    expect(clampWindowBounds({ x: 20, y: 20, width: 1, height: 1 }, { width: 1440, height: 788 }))
      .toEqual({ x: 20, y: 20, width: 420, height: 360 });
    expect(clampWindowBounds({ x: 20, y: 20, width: 420, height: 300 }, { width: 320, height: 240 }))
      .toEqual({ x: 8, y: 8, width: 304, height: 224 });
  });
  describe.each<WindowResizeCorner>(["top-left", "top-right", "bottom-left", "bottom-right"])("%s resize", (corner) => {
    const initial = { x: 160, y: 80, width: 640, height: 480 };
    const area = { width: 1200, height: 800 };
    const left = corner.endsWith("left"), top = corner.startsWith("top");
    const checkAnchor = (next: typeof initial) => {
      expect(left ? next.x + next.width : next.x).toBe(left ? 800 : 160);
      expect(top ? next.y + next.height : next.y).toBe(top ? 560 : 80);
    };
    it("moves only the selected edges", () => {
      const next = resizeWindowBounds(initial, area, corner, left ? -40 : 40, top ? -30 : 30);
      expect(next.width).toBe(680);
      expect(next.height).toBe(510);
      checkAnchor(next);
    });
    it("keeps the opposite corner fixed at minimum size without crossing it", () => {
      const next = resizeWindowBounds(initial, area, corner, left ? 2000 : -2000, top ? 2000 : -2000);
      expect(next.width).toBe(420);
      expect(next.height).toBe(360);
      checkAnchor(next);
    });
    it("stops the selected corner at the viewport and HUD bounds without shifting the other corner", () => {
      const next = resizeWindowBounds(initial, area, corner, left ? -2000 : 2000, top ? -2000 : 2000);
      expect(left ? next.x : next.x + next.width).toBe(left ? 8 : 1192);
      expect(top ? next.y : next.y + next.height).toBe(top ? 8 : 792);
      checkAnchor(next);
    });
  });
  it("uses compact minimums and remains safe when the host is smaller than them", () => {
    expect(resizeWindowBounds({ x: 40, y: 40, width: 352, height: 220 }, { width: 1280, height: 800 }, "top-left", 200, 200, { width: 260, height: 140 }))
      .toEqual({ x: 132, y: 120, width: 260, height: 140 });
    expect(resizeWindowBounds({ x: 40, y: 40, width: 352, height: 220 }, { width: 240, height: 120 }, "top-left", 200, 200, { width: 260, height: 140 }))
      .toEqual({ x: 8, y: 8, width: 224, height: 104 });
  });
});

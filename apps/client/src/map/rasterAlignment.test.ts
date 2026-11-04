import { describe, expect, it } from "vitest";

import { RASTER_SETTLE_MS, parseRasterAlignmentMode, rasterPainterMoving } from "./rasterAlignment.js";

const rest = { moving: false, zoom: 16, sinceCameraChangeMs: 5_000 };

describe("rasterPainterMoving (true = drawn unaligned)", () => {
  it("parses the stored switch, defaulting to auto", () => {
    expect(parseRasterAlignmentMode(null)).toBe("auto");
    expect(parseRasterAlignmentMode("garbage")).toBe("auto");
    expect(parseRasterAlignmentMode("on")).toBe("on");
    expect(parseRasterAlignmentMode("off")).toBe("off");
  });

  it("on is stock MapLibre: it follows isMoving()", () => {
    expect(rasterPainterMoving("on", { ...rest, moving: false, sinceCameraChangeMs: 0, zoom: 16.4 })).toBe(false);
    expect(rasterPainterMoving("on", { ...rest, moving: true })).toBe(true);
  });

  it("off is never aligned", () => {
    expect(rasterPainterMoving("off", rest)).toBe(true);
  });

  it("auto is unaligned during a zero-duration follow (isMoving false, camera changing)", () => {
    expect(rasterPainterMoving("auto", { moving: false, zoom: 16, sinceCameraChangeMs: 16 })).toBe(true);
  });

  it("auto keeps the raster unaligned through the settle window, so no snap right after a stop", () => {
    expect(rasterPainterMoving("auto", { ...rest, sinceCameraChangeMs: RASTER_SETTLE_MS - 1 })).toBe(true);
    expect(rasterPainterMoving("auto", { ...rest, sinceCameraChangeMs: RASTER_SETTLE_MS })).toBe(false);
  });

  it("auto is unaligned at a fractional zoom even at rest, and aligned only at an integer zoom", () => {
    expect(rasterPainterMoving("auto", { ...rest, zoom: 16.37 })).toBe(true);
    expect(rasterPainterMoving("auto", { ...rest, zoom: 16 })).toBe(false);
    expect(rasterPainterMoving("auto", { ...rest, moving: true })).toBe(true);
  });
});

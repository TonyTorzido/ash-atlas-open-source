import { describe, expect, it, vi } from "vitest";

import {
  MOBILE_ZOOM_RESET_DURATION_MS,
  smoothlyResetMapZoom
} from "./smoothZoomReset.js";

describe("smoothlyResetMapZoom", () => {
  it("stops the native gesture and eases to the saved zoom and live player", () => {
    const stop = vi.fn();
    const easeTo = vi.fn();
    const onNativeGestureStopped = vi.fn();

    smoothlyResetMapZoom(
      { stop, easeTo } as never,
      15.25,
      { lat: 35.0844, lon: -106.6504 },
      onNativeGestureStopped
    );

    expect(stop).toHaveBeenCalledOnce();
    expect(onNativeGestureStopped).toHaveBeenCalledOnce();
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      onNativeGestureStopped.mock.invocationCallOrder[0]!
    );
    expect(onNativeGestureStopped.mock.invocationCallOrder[0]).toBeLessThan(
      easeTo.mock.invocationCallOrder[0]!
    );
    expect(easeTo).toHaveBeenCalledOnce();
    const options = easeTo.mock.calls[0]![0];
    expect(options.zoom).toBe(15.25);
    expect(options.center).toEqual([-106.6504, 35.0844]);
    expect(options.duration).toBe(MOBILE_ZOOM_RESET_DURATION_MS);
    expect(options.easing(0)).toBe(0);
    expect(options.easing(0.5)).toBe(0.5);
    expect(options.easing(1)).toBe(1);
  });

  it("still resets zoom before the player snapshot is available", () => {
    const easeTo = vi.fn();

    smoothlyResetMapZoom(
      { stop: vi.fn(), easeTo } as never,
      15.25,
      null,
      vi.fn()
    );

    expect(easeTo.mock.calls[0]![0]).not.toHaveProperty("center");
  });
});

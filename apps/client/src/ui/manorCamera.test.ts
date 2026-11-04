import { describe, expect, it } from "vitest";

import { clampManorCameraPan } from "./manorCamera.js";

describe("clampManorCameraPan", () => {
  it("keeps the zoomed authored room covering the viewport", () => {
    expect(clampManorCameraPan(
      { x: 1_000, y: -1_000 },
      {
        roomWidth: 1_000,
        roomHeight: 1_000,
        viewportWidth: 500,
        viewportHeight: 400,
        zoom: 1.8
      }
    )).toEqual({ x: 110, y: -160 });
  });

  it("centers an axis when the viewport is wider than the fitted room", () => {
    expect(clampManorCameraPan(
      { x: 100, y: 1_000 },
      {
        roomWidth: 1_000,
        roomHeight: 1_000,
        viewportWidth: 800,
        viewportHeight: 400,
        zoom: 1.8
      }
    )).toEqual({ x: 0, y: 160 });
  });

  it("returns the centered origin for invalid or unavailable bounds", () => {
    expect(clampManorCameraPan(
      { x: 20, y: 30 },
      {
        roomWidth: 1_000,
        roomHeight: 1_000,
        viewportWidth: 0,
        viewportHeight: 400,
        zoom: 1.8
      }
    )).toEqual({ x: 0, y: 0 });
  });
});

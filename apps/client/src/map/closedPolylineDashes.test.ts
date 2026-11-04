import { describe, expect, it } from "vitest";

import { closedPolylineDashSegments } from "./closedPolylineDashes.js";

describe("closed polyline dashes", () => {
  it("keeps an approximately 8px/7px pattern and closes with a gap", () => {
    const segments = closedPolylineDashSegments([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 30 },
      { x: 0, y: 30 }
    ]);
    expect(segments).toHaveLength(8);
    expect(Math.hypot(
      segments[0]!.at(-1)!.x - segments[0]![0]!.x,
      segments[0]!.at(-1)!.y - segments[0]![0]!.y
    )).toBeCloseTo(8);
    expect(segments.at(-1)!.at(-1)).not.toEqual(segments[0]![0]);
  });

  it("retains vertices crossed by a dash", () => {
    const segments = closedPolylineDashSegments([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
      { x: 0, y: 5 }
    ], 8, 7);
    expect(segments[0]).toContainEqual({ x: 5, y: 0 });
  });
});

import { describe, expect, it } from "vitest";

import { formatWaypointDistance, waypointArrowTriangle, waypointBearingDegrees } from "./waypointModel.js";

describe("waypoint arrow model", () => {
  it("formats distances compactly", () => {
    expect(formatWaypointDistance(412)).toBe("410 m");
    expect(formatWaypointDistance(1_240)).toBe("1.2 km");
    expect(formatWaypointDistance(48_000)).toBe("48 km");
    expect(formatWaypointDistance(Number.NaN)).toBe("");
  });

  it("points the arrow outward with its tip on the circle edge", () => {
    const triangle = waypointArrowTriangle({ x: 0, y: 0 }, { x: 100, y: 0 }, 14)!;
    expect(triangle.tip).toEqual({ x: 100, y: 0 });
    expect(triangle.left.x).toBeCloseTo(86);
    expect(triangle.right.x).toBeCloseTo(86);
    expect(triangle.left.y).toBeCloseTo(-triangle.right.y);
    expect(triangle.angle).toBeCloseTo(0);
    expect(waypointArrowTriangle({ x: 0, y: 0 }, { x: 3, y: 0 })).toBeNull();
  });

  it("bears north for a waypoint straight north", () => {
    expect(waypointBearingDegrees({ lat: 35, lon: -106 }, { lat: 36, lon: -106 })).toBeCloseTo(0, 3);
  });
});

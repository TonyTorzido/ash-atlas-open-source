import { describe, expect, it } from "vitest";
import { EMPTY_RULER_STATE, addRulerPoint, formatRulerDistance } from "./rulerState.js";

describe("ruler state", () => {
  it("pairs points into persistent measured lines", () => {
    const started = addRulerPoint(EMPTY_RULER_STATE, { lat: 35, lon: -106 });
    expect(started.pending).toEqual({ lat: 35, lon: -106 });
    const completed = addRulerPoint(started, { lat: 35.0001, lon: -106 });
    expect(completed.pending).toBeNull();
    expect(completed.lines).toHaveLength(1);
    expect(completed.lines[0]!.distanceM).toBeGreaterThan(11);
    expect(addRulerPoint(completed, { lat: 36, lon: -105 }).lines).toHaveLength(1);
  });

  it("formats distances in meters", () => {
    expect(formatRulerDistance(12.34)).toBe("12.3 m");
    expect(formatRulerDistance(123.4)).toBe("123 m");
  });
});

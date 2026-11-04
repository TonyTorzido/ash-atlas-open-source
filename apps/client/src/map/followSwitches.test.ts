import { describe, expect, it } from "vitest";

import { quantizePanToDevicePixels } from "./followSwitches.js";

describe("quantizePanToDevicePixels", () => {
  it("rounds to whole device pixels and carries the remainder so the sum is preserved", () => {
    let carry = { x: 0, y: 0 };
    let sx = 0; let sy = 0;
    for (let i = 0; i < 100; i += 1) {
      const q = quantizePanToDevicePixels({ x: 0.96, y: -0.31 }, carry, 3);
      carry = q.carry;
      sx += q.pan.x; sy += q.pan.y;
      expect(Math.abs(q.pan.x * 3 - Math.round(q.pan.x * 3))).toBeLessThan(1e-9);
    }
    expect(sx + carry.x).toBeCloseTo(96, 6);
    expect(sy + carry.y).toBeCloseTo(-31, 6);
    expect(Math.abs(carry.x)).toBeLessThanOrEqual(0.5 / 3 + 1e-9);
  });
  it("treats a bad dpr as 1", () => {
    expect(quantizePanToDevicePixels({ x: 0.6, y: 0 }, { x: 0, y: 0 }, 0).pan.x).toBe(1);
  });
});

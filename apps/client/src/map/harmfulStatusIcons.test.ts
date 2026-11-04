import { describe, expect, it } from "vitest";
import { HARMFUL_STATUS_IDS } from "@ash-atlas/shared";

import {
  HARMFUL_STATUS_ICON_SIZE_PX,
  HARMFUL_STATUS_TILES_PER_ROW,
  HARMFUL_STATUS_TILE_SIZE_PX,
  harmfulStatusIconLayout
} from "./pixiOverlay.js";

describe("world harmful status tile layout", () => {
  it("centers a single row of square tiles in stable order", () => {
    expect(HARMFUL_STATUS_TILE_SIZE_PX).toBe(20);
    expect(HARMFUL_STATUS_ICON_SIZE_PX).toBeLessThan(HARMFUL_STATUS_TILE_SIZE_PX);
    expect(harmfulStatusIconLayout(["ice_slow", "gloom", "poison", "burning"])).toEqual([
      { statusId: "poison", x: -34.5, y: 0 },
      { statusId: "gloom", x: -11.5, y: 0 },
      { statusId: "burning", x: 11.5, y: 0 },
      { statusId: "ice_slow", x: 34.5, y: 0 }
    ]);
    expect(harmfulStatusIconLayout(["poison"])).toEqual([{ statusId: "poison", x: 0, y: 0 }]);
    expect(harmfulStatusIconLayout([])).toEqual([]);
  });

  it("wraps into centered rows with even spacing when many effects stack", () => {
    const layout = harmfulStatusIconLayout([...HARMFUL_STATUS_IDS]);
    expect(layout).toHaveLength(HARMFUL_STATUS_IDS.length);
    const rows = new Set(layout.map((entry) => entry.y));
    expect(rows.size).toBe(Math.ceil(HARMFUL_STATUS_IDS.length / HARMFUL_STATUS_TILES_PER_ROW));
    for (const y of rows) {
      const xs = layout.filter((entry) => entry.y === y).map((entry) => entry.x);
      expect(xs.reduce((sum, x) => sum + x, 0)).toBeCloseTo(0);
      for (let i = 1; i < xs.length; i += 1) expect(xs[i]! - xs[i - 1]!).toBe(23);
    }
    expect(Math.min(...[...rows].filter((y) => y > 0).map((y) => y))).toBe(23);
  });
});

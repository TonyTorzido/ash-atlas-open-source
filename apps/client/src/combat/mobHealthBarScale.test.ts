import { describe, expect, it } from "vitest";

import { MOB_HEALTH_BAR_MIN_WIDTH_PX, WORLD_HEALTH_BAR_METRICS, mobHealthBarScaleX } from "./healthBarPresentation.js";

describe("slim mob health bars", () => {
  it("never draws a mob bar wider than its sprite", () => {
    const width = WORLD_HEALTH_BAR_METRICS.mob.width;
    for (const spritePx of [30, 41, 60]) {
      expect(mobHealthBarScaleX(spritePx) * width).toBeLessThanOrEqual(spritePx);
    }
  });
  it("caps at the authored width for big sprites and floors tiny ones", () => {
    expect(mobHealthBarScaleX(400)).toBe(1);
    expect(mobHealthBarScaleX(8) * WORLD_HEALTH_BAR_METRICS.mob.width).toBeCloseTo(MOB_HEALTH_BAR_MIN_WIDTH_PX);
    expect(mobHealthBarScaleX(0)).toBe(1);
  });
});

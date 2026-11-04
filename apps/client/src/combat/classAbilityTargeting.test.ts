import { describe, expect, it, vi } from "vitest";

import { resolveAbilityDragTargetPoint, restoreAbilityTargetingDragPan } from "./classAbilityTargeting.js";

describe("class ability map targeting", () => {
  it("uses the map release endpoint for both position and direction drags", () => {
    expect(resolveAbilityDragTargetPoint({ x: 10, y: 10 }, { x: 30, y: 45 }))
      .toEqual({ x: 30, y: 45 });
  });

  it("falls back to precision targeting for a short tap", () => {
    expect(resolveAbilityDragTargetPoint({ x: 10, y: 10 }, { x: 14, y: 15 })).toBeNull();
  });

  it("restores map dragging only when targeting owned an enabled dragPan", () => {
    const enable = vi.fn();
    restoreAbilityTargetingDragPan({ map: { dragPan: { enable } }, enabled: false });
    expect(enable).not.toHaveBeenCalled();
    restoreAbilityTargetingDragPan({ map: { dragPan: { enable } }, enabled: true });
    expect(enable).toHaveBeenCalledOnce();
  });
});

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { subscribeNativeEdgeSwipeBack } from "./nativeEdgeSwipeBack.js";

function touch(type: string, x: number, y: number, count = 1): void {
  const point = { clientX: x, clientY: y };
  const event = new Event(type, { bubbles: true }) as Event & { touches: unknown[]; changedTouches: unknown[] };
  event.touches = type === "touchend" ? [] : Array.from({ length: count }, () => point);
  event.changedTouches = [point];
  document.body.dispatchEvent(event);
}

describe("subscribeNativeEdgeSwipeBack", () => {
  it("steps back on a rightward swipe from the left edge only while active", () => {
    const onBack = vi.fn();
    let active = true;
    const stop = subscribeNativeEdgeSwipeBack({ isActive: () => active, onBack });
    touch("touchstart", 6, 300); touch("touchend", 120, 310);
    expect(onBack).toHaveBeenCalledTimes(1);
    touch("touchstart", 80, 300); touch("touchend", 200, 300);
    touch("touchstart", 6, 300); touch("touchend", 40, 300);
    touch("touchstart", 6, 300); touch("touchend", 120, 200);
    touch("touchstart", 6, 300, 2); touch("touchend", 120, 300);
    expect(onBack).toHaveBeenCalledTimes(1);
    active = false;
    touch("touchstart", 6, 300); touch("touchend", 120, 300);
    expect(onBack).toHaveBeenCalledTimes(1);
    stop();
    active = true;
    touch("touchstart", 6, 300); touch("touchend", 120, 300);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

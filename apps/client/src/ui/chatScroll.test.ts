// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBottomPinScheduler, installTouchScrollBoundaryGuard } from "./chatScroll.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("bottom pin scheduler", () => {
  it("pins immediately so a newly rendered message is visible before the next frame", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const history = document.createElement("div");
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 200 });
    history.scrollTop = 300;
    const scheduler = createBottomPinScheduler(
      () => history,
      () => true,
      { current: 0 }
    );

    scheduler.schedule();

    expect(history.scrollTop).toBe(400);
    scheduler.cancel();
  });
});

describe("touch scroll boundary guard", () => {
  it("contains only vertical boundary pulls while the keyboard guard is active", () => {
    const history = document.createElement("div");
    document.body.append(history);
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 200 });
    let active = true;
    const guard = installTouchScrollBoundaryGuard(history, () => active);

    history.scrollTop = 0;
    touch(history, "touchstart", 100, 100);
    expect(touch(history, "touchmove", 100, 140).defaultPrevented).toBe(true);
    expect(history.scrollTop).toBe(0);

    history.scrollTop = 200;
    touch(history, "touchstart", 100, 100);
    expect(touch(history, "touchmove", 100, 60).defaultPrevented).toBe(false);
    expect(history.scrollTop).toBe(200);

    history.scrollTop = 400;
    touch(history, "touchstart", 100, 100);
    expect(touch(history, "touchmove", 100, 60).defaultPrevented).toBe(true);
    expect(history.scrollTop).toBe(400);

    active = false;
    touch(history, "touchstart", 100, 100);
    expect(touch(history, "touchmove", 100, 140).defaultPrevented).toBe(false);
    guard.dispose();
  });

  it("leaves horizontal and left-edge back gestures untouched", () => {
    const history = document.createElement("div");
    document.body.append(history);
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 200 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 200 });
    const guard = installTouchScrollBoundaryGuard(history, () => true);

    touch(history, "touchstart", 100, 100);
    expect(touch(history, "touchmove", 150, 120).defaultPrevented).toBe(false);
    touch(history, "touchstart", 12, 100);
    expect(touch(history, "touchmove", 42, 140).defaultPrevented).toBe(false);
    touch(history, "touchstart", 100, 100);
    expect(touch(history, "touchmove", 100, 140).defaultPrevented).toBe(true);
    guard.dispose();
  });
});

function touch(
  element: HTMLElement,
  type: "touchstart" | "touchmove",
  clientX: number,
  clientY: number
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: [{ clientX, clientY }]
  });
  element.dispatchEvent(event);
  return event;
}

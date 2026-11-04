// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { bindTwoFingerDoubleTap } from "./twoFingerDoubleTap.js";

describe("two-finger double tap", () => {
  it("fires once for two stationary two-finger taps and prevents the second native gesture", () => {
    const target = document.createElement("div");
    const reset = vi.fn();
    let clock = 0;
    const unbind = bindTwoFingerDoubleTap(target, reset, () => clock);

    tap(target, () => clock += 50);
    clock += 100;
    const secondEnd = tap(target, () => clock += 50);

    expect(reset).toHaveBeenCalledOnce();
    expect(secondEnd.defaultPrevented).toBe(true);
    unbind();
  });

  it("ignores one-finger taps and pinch movement", () => {
    const target = document.createElement("div");
    const reset = vi.fn();
    let clock = 0;
    bindTwoFingerDoubleTap(target, reset, () => clock);

    dispatchTouch(target, "touchstart", [touch(1, 10, 10)]);
    clock += 30;
    dispatchTouch(target, "touchend", []);
    dispatchTouch(target, "touchstart", [touch(1, 10, 10), touch(2, 30, 10)]);
    clock += 20;
    dispatchTouch(target, "touchmove", [touch(1, 50, 10), touch(2, 70, 10)]);
    dispatchTouch(target, "touchend", []);
    clock += 50;
    tap(target, () => clock += 40);

    expect(reset).not.toHaveBeenCalled();
  });

  it("removes every listener on cleanup", () => {
    const target = document.createElement("div");
    const reset = vi.fn();
    let clock = 0;
    const unbind = bindTwoFingerDoubleTap(target, reset, () => clock);
    unbind();
    tap(target, () => clock += 40);
    clock += 40;
    tap(target, () => clock += 40);
    expect(reset).not.toHaveBeenCalled();
  });
});

function tap(target: HTMLElement, advance: () => void): Event {
  dispatchTouch(target, "touchstart", [touch(1, 10, 10), touch(2, 30, 10)]);
  advance();
  return dispatchTouch(target, "touchend", []);
}

function touch(identifier: number, clientX: number, clientY: number): Touch {
  return { identifier, clientX, clientY } as Touch;
}

function dispatchTouch(target: HTMLElement, type: string, touches: Touch[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  target.dispatchEvent(event);
  return event;
}

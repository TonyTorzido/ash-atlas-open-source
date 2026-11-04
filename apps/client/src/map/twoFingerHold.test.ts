// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bindTwoFingerDoubleTap } from "./twoFingerDoubleTap.js";
import {
  bindTwoFingerHold,
  TWO_FINGER_HOLD_DISTANCE_CHANGE_TOLERANCE_PX,
  TWO_FINGER_HOLD_DURATION_MS,
  TWO_FINGER_HOLD_MIDPOINT_MOVEMENT_TOLERANCE_PX,
  TWO_FINGER_HOLD_TOUCH_MOVEMENT_TOLERANCE_PX
} from "./twoFingerHold.js";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("two-finger hold", () => {
  it("binds App's hold to the outer map root with current gameplay eligibility refs", () => {
    const appSource = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");

    expect(appSource).toContain("bindTwoFingerHold(mapContainerRef.current");
    expect(appSource).not.toContain("bindTwoFingerHold(mapCanvasContainer");
    expect(appSource).toContain('mobileViewRef.current !== "gameplay"');
    expect(appSource).toContain("useBalsamResinRef.current()");
    expect(appSource).not.toMatch(/uiEnvironment\.profile,\s*useBalsamResin\s*\]/);
  });

  it.each(["mapCanvas", "pixiCanvas"] as const)(
    "activates from a nested %s target captured by the outer map root",
    (childName) => {
      vi.useFakeTimers();
      const fixture = layeredGameplayMap();
      const useResin = vi.fn();
      bindTwoFingerHold(fixture.root, useResin);

      start(fixture[childName]);
      vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);

      expect(useResin).toHaveBeenCalledOnce();
    }
  );

  it("does not activate for a child outside the map root", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    bindTwoFingerHold(fixture.root, useResin);

    start(fixture.outsideButton);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);

    expect(useResin).not.toHaveBeenCalled();
  });

  it("does not activate at 599 ms and fires once at 600 ms while held", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    bindTwoFingerHold(fixture.root, useResin);

    start(fixture.pixiCanvas);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS - 1);
    expect(useResin).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(useResin).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS * 2);
    expect(useResin).toHaveBeenCalledOnce();
  });

  it("allows realistic small hardware jitter", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    bindTwoFingerHold(fixture.root, useResin);

    start(fixture.mapCanvas);
    dispatchTouch(fixture.mapCanvas, "touchmove", [
      touch(1, 18, 7),
      touch(2, 37, 13)
    ]);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);

    expect(useResin).toHaveBeenCalledOnce();
  });

  it("cancels movement beyond the per-touch limit", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    bindTwoFingerHold(fixture.root, useResin);

    start(fixture.pixiCanvas);
    dispatchTouch(fixture.pixiCanvas, "touchmove", [
      touch(1, 10, 10 + TWO_FINGER_HOLD_TOUCH_MOVEMENT_TOLERANCE_PX + 1),
      touch(2, 30, 10)
    ]);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);

    expect(useResin).not.toHaveBeenCalled();
  });

  it("cancels a real pinch-distance change", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    bindTwoFingerHold(fixture.root, useResin);

    start(fixture.mapCanvas);
    const spread = TWO_FINGER_HOLD_DISTANCE_CHANGE_TOLERANCE_PX / 2 + 1;
    const pinchMove = dispatchTouch(fixture.mapCanvas, "touchmove", [
      touch(1, 10 - spread, 10),
      touch(2, 30 + spread, 10)
    ]);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);

    expect(pinchMove.defaultPrevented).toBe(false);
    expect(useResin).not.toHaveBeenCalled();
  });

  it("cancels two-finger midpoint movement", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    bindTwoFingerHold(fixture.root, useResin);

    start(fixture.pixiCanvas);
    const shift = TWO_FINGER_HOLD_MIDPOINT_MOVEMENT_TOLERANCE_PX + 1;
    dispatchTouch(fixture.pixiCanvas, "touchmove", [
      touch(1, 10 + shift, 10),
      touch(2, 30 + shift, 10)
    ]);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);

    expect(useResin).not.toHaveBeenCalled();
  });

  it("keeps quick two-finger double-tap zoom reset without using resin", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    const resetZoom = vi.fn();
    let clock = 0;
    bindTwoFingerHold(fixture.root, useResin);
    bindTwoFingerDoubleTap(fixture.mapCanvas, resetZoom, () => clock);

    tap(fixture.mapCanvas, () => clock += 50);
    clock += 100;
    tap(fixture.mapCanvas, () => clock += 50);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);

    expect(resetZoom).toHaveBeenCalledOnce();
    expect(useResin).not.toHaveBeenCalled();
  });

  it("suppresses movement, release, and the release-generated map click after completion", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const mapClick = vi.fn();
    bindTwoFingerHold(fixture.root, vi.fn());
    fixture.mapCanvas.addEventListener("click", mapClick);

    start(fixture.mapCanvas);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);
    const move = dispatchTouch(fixture.mapCanvas, "touchmove", [
      touch(1, 11, 10),
      touch(2, 31, 10)
    ]);
    const release = dispatchTouch(fixture.mapCanvas, "touchend", []);
    fixture.mapCanvas.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true
    }));

    expect(move.defaultPrevented).toBe(true);
    expect(release.defaultPrevented).toBe(true);
    expect(mapClick).not.toHaveBeenCalled();
  });

  it("requires every touch to lift before another activation", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    bindTwoFingerHold(fixture.root, useResin);

    start(fixture.pixiCanvas);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);
    dispatchTouch(fixture.pixiCanvas, "touchend", [touch(2, 30, 10)]);
    dispatchTouch(fixture.pixiCanvas, "touchstart", [
      touch(2, 30, 10),
      touch(3, 50, 10)
    ]);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);
    expect(useResin).toHaveBeenCalledOnce();

    dispatchTouch(fixture.pixiCanvas, "touchend", []);
    start(fixture.pixiCanvas);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);
    expect(useResin).toHaveBeenCalledTimes(2);
  });

  it("evaluates menu eligibility when the hold completes", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    const current = {
      profile: "phone",
      locationMode: "world",
      hasLocalPlayer: true,
      mobileView: "gameplay"
    };
    bindTwoFingerHold(fixture.root, () => {
      if (
        current.profile !== "phone" ||
        current.locationMode !== "world" ||
        !current.hasLocalPlayer ||
        current.mobileView !== "gameplay"
      ) return;
      useResin();
    });

    start(fixture.mapCanvas);
    current.mobileView = "menu";
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);
    dispatchTouch(fixture.mapCanvas, "touchend", []);
    expect(useResin).not.toHaveBeenCalled();

    current.mobileView = "gameplay";
    start(fixture.mapCanvas);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);
    expect(useResin).toHaveBeenCalledOnce();
  });

  it("cancels on early release, touch cancellation, or a third finger", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    bindTwoFingerHold(fixture.root, useResin);

    start(fixture.mapCanvas);
    dispatchTouch(fixture.mapCanvas, "touchend", [touch(2, 30, 10)]);
    dispatchTouch(fixture.mapCanvas, "touchend", []);
    start(fixture.mapCanvas);
    dispatchTouch(fixture.mapCanvas, "touchcancel", []);
    start(fixture.mapCanvas);
    dispatchTouch(fixture.mapCanvas, "touchstart", [
      touch(1, 10, 10),
      touch(2, 30, 10),
      touch(3, 50, 10)
    ]);
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);

    expect(useResin).not.toHaveBeenCalled();
  });

  it("cleanup cancels the timer and removes every listener", () => {
    vi.useFakeTimers();
    const fixture = layeredGameplayMap();
    const useResin = vi.fn();
    const removeEventListener = vi.spyOn(fixture.root, "removeEventListener");
    const unbind = bindTwoFingerHold(fixture.root, useResin);
    start(fixture.mapCanvas);

    unbind();
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS);

    expect(useResin).not.toHaveBeenCalled();
    expect(removeEventListener.mock.calls.map(([type]) => type)).toEqual([
      "touchstart",
      "touchmove",
      "touchend",
      "touchcancel",
      "click",
      "dblclick",
      "contextmenu"
    ]);
  });
});

function layeredGameplayMap(): {
  root: HTMLDivElement;
  mapCanvas: HTMLCanvasElement;
  pixiCanvas: HTMLCanvasElement;
  outsideButton: HTMLButtonElement;
} {
  const root = document.createElement("div");
  root.className = "map-root";
  const mapCanvas = document.createElement("canvas");
  mapCanvas.className = "maplibregl-canvas";
  const pixiCanvas = document.createElement("canvas");
  pixiCanvas.className = "game-pixi-overlay";
  const outsideButton = document.createElement("button");
  root.append(mapCanvas, pixiCanvas);
  document.body.append(root, outsideButton);
  return { root, mapCanvas, pixiCanvas, outsideButton };
}

function start(target: HTMLElement): void {
  dispatchTouch(target, "touchstart", [touch(1, 10, 10), touch(2, 30, 10)]);
}

function tap(target: HTMLElement, advance: () => void): Event {
  start(target);
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

describe("fingers that are not on the map", () => {
  const fakeTouches = (target: HTMLElement, others: HTMLElement[]): Event => {
    const event = new Event("touchstart", { bubbles: true, cancelable: true });
    const touches = [target, ...others].map((element, index) => ({ identifier: index, clientX: 10 * index, clientY: 10, target: element }));
    Object.defineProperty(event, "touches", { value: touches });
    return event;
  };

  it("a finger held on the on-screen stick plus one map finger is not a two-finger hold or double tap", () => {
    vi.useFakeTimers();
    const map = document.createElement("div");
    const canvas = document.createElement("canvas");
    const stick = document.createElement("div");
    map.append(canvas);
    document.body.append(map, stick);
    const onHold = vi.fn();
    const onDoubleTap = vi.fn();
    bindTwoFingerHold(map, onHold);
    bindTwoFingerDoubleTap(map, onDoubleTap);
    map.dispatchEvent(fakeTouches(canvas, [stick]));
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS + 100);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("two fingers that both started on the map still count", () => {
    vi.useFakeTimers();
    const map = document.createElement("div");
    const a = document.createElement("canvas");
    const b = document.createElement("canvas");
    map.append(a, b);
    document.body.append(map);
    const onHold = vi.fn();
    bindTwoFingerHold(map, onHold);
    map.dispatchEvent(fakeTouches(a, [b]));
    vi.advanceTimersByTime(TWO_FINGER_HOLD_DURATION_MS + 100);
    expect(onHold).toHaveBeenCalledTimes(1);
  });
});

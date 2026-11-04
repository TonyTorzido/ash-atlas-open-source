// @vitest-environment jsdom

import { destinationPoint, distanceMeters } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindMapMovementInput,
  MAP_LONG_PRESS_DURATION_MS,
  MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX,
  MAP_OUTSIDE_LONG_PRESS_DURATION_MS,
  MAP_PRECISION_CURSOR_OFFSET_X_PX,
  MAP_PRECISION_CURSOR_OFFSET_Y_PX
} from "./mapMovementInput.js";
import {
  WORLD_MAP_CLICK_CONFIRMATION_MS,
  WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS,
  WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX
} from "./worldMapClickArbitrator.js";

afterEach(() => vi.useRealTimers());

describe("map movement gestures", () => {
  it("uses the reduced flag hold durations", () => {
    expect(MAP_LONG_PRESS_DURATION_MS).toBe(420);
    expect(MAP_OUTSIDE_LONG_PRESS_DURATION_MS).toBe(525);
  });

  it("confirms a single object click immediately", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onPendingClick = vi.fn();
    const onClick = vi.fn();
    bind(map, { onPendingClick, onClick });

    map.emitClick(30, 40);
    expect(onPendingClick).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("dispatches a targeting tap immediately instead of waiting for movement arbitration", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onPendingClick = vi.fn();
    const onPendingClickEnd = vi.fn();
    const onClick = vi.fn();
    bind(map, {
      handleClickImmediately: () => true,
      onPendingClick,
      onPendingClickEnd,
      onClick
    });

    map.emitClick(30, 40);

    expect(onClick).toHaveBeenCalledOnce();
    expect(onPendingClick).not.toHaveBeenCalled();
    expect(onPendingClickEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps the first interaction and resolves a displaced second click as one movement", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    bind(map, { onClick, onMove });

    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.emitClick(30, 40);
    vi.advanceTimersByTime(200);
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointermove", 46, 40);
    map.pointer("pointerup", 46, 40);
    map.emitClick(46, 40);
    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("gives an Anchor hit ownership over a nearby completed click and its native double click", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    const binding = bind(map, {
      handleClickImmediately: (event) => event.point.x === 40,
      onClick,
      onMove
    });
    map.emitClick(30, 40); // Selecting a nearby Siege leaves a completed-click candidate.
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS + 100);
    map.emitClick(40, 40); // Anchor lies inside the 48px double-click tolerance.
    map.emitDoubleClickAt(40, 40);
    vi.runAllTimers();
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onMove).not.toHaveBeenCalled();
    binding.destroy();
  });

  it("retains ownership when an immediate mode exits before the trailing double click", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    let ownsClick = true;
    bind(map, {
      handleClickImmediately: () => ownsClick,
      onClick,
      onMove
    });

    map.emitClick(30, 40);
    ownsClick = false;
    map.emitClick(35, 44);
    map.emitDoubleClickAt(35, 44);
    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledOnce();
    expect(onMove).not.toHaveBeenCalled();

    map.emitDoubleClickAt(70, 40);
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("suppresses a late native double click after its owned native second click", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onMove = vi.fn();
    let ownsClick = true;
    bind(map, {
      handleClickImmediately: () => ownsClick,
      onMove
    });

    map.emitClick(30, 40);
    ownsClick = false;
    vi.advanceTimersByTime(WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS + 1);
    map.emitClick(30, 40, 0, 2);
    map.emitDoubleClickAt(30, 40);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("clears immediate ownership for a later ordinary click after the recognition window", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onMove = vi.fn();
    let ownsClick = true;
    bind(map, {
      handleClickImmediately: () => ownsClick,
      onMove
    });

    map.emitClick(30, 40);
    ownsClick = false;
    vi.advanceTimersByTime(WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS + 1);
    map.emitClick(30, 40, 0, 1);
    map.emitClick(30, 40, 0, 2);
    map.emitDoubleClickAt(30, 40);

    expect(onMove).toHaveBeenCalledOnce();
  });

  it("keeps near-boundary double clicks after pointer jitter cancels long-press arming", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    bind(map, { onClick, onMove });

    map.emitClick(30, 40);
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS);
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointermove", 30 + WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX - 1, 40);
    map.pointer("pointerup", 30 + WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX - 1, 40);
    map.emitClick(30 + WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX - 1, 40);
    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("moves on a stationary second click after the first click has confirmed", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    bind(map, { onClick, onMove });

    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.emitClick(30, 40);
    vi.advanceTimersByTime(200);
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.emitClick(30, 40);
    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("keeps a completed tap for the double tap when capture is released after pointerup", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    bind(map, { onClick, onMove });

    // Phone stream: implicit touch capture ends after every pointerup, before the click.
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.pointer("lostpointercapture", 30, 40);
    map.emitClick(30, 40);
    vi.advanceTimersByTime(200);
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.pointer("lostpointercapture", 30, 40);
    map.emitClick(30, 40);
    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("drops the pending click when capture is lost while the pointer is still down", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    bind(map, { onClick, onMove });

    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.emitClick(30, 40);
    vi.advanceTimersByTime(200);
    map.pointer("pointerdown", 30, 40);
    map.pointer("lostpointercapture", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.emitClick(30, 40);
    vi.runAllTimers();

    expect(onMove).not.toHaveBeenCalled();
  });

  it("moves on a displaced second click after the first click has confirmed", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    bind(map, { onClick, onMove });

    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.emitClick(30, 40);
    vi.advanceTimersByTime(200);
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointermove", 46, 40);
    map.pointer("pointerup", 46, 40);
    map.emitClick(46, 40);
    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("keeps clicks outside the completed-click window as separate singles", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    bind(map, { onClick, onMove });

    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.emitClick(30, 40);
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS + WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS + 1);
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerup", 30, 40);
    map.emitClick(46, 40);
    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("deduplicates native confirmation after completed-click movement", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onMove = vi.fn();
    bind(map, { onMove });

    map.emitClick(30, 40);
    vi.advanceTimersByTime(1);
    map.emitClick(35, 44);
    map.emitDoubleClickAt(35, 44);
    vi.runAllTimers();

    expect(onMove).toHaveBeenCalledOnce();
  });

  it("cancels a pending object click at dragstart without waiting for recognition", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onPendingClickEnd = vi.fn();
    const firstBinding = bind(map, { onClick, onPendingClickEnd });
    map.emitClick(30, 40);
    map.emit("dragstart", {});
    expect(onPendingClickEnd).toHaveBeenCalledOnce();
    expect(onPendingClickEnd.mock.calls[0]![1]).toBe("cancelled");
    vi.runAllTimers();
    expect(onClick).not.toHaveBeenCalled();

    onPendingClickEnd.mockClear();
    map.emitClick(30, 40);
    document.body.dispatchEvent(pointerEvent("pointerdown", 7, 5, 5));
    vi.runAllTimers();
    expect(onClick).not.toHaveBeenCalled();

    onPendingClickEnd.mockClear();
    map.emitClick(30, 40);
    firstBinding.destroy();
    vi.runAllTimers();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not resolve right click or UI input as map movement", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onClick = vi.fn();
    const onMove = vi.fn();
    bind(map, { onClick, onMove });

    map.emitClick(30, 40, 2);
    const hud = document.createElement("button");
    map.canvas.parentElement!.append(hud);
    hud.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    vi.runAllTimers();

    expect(onClick).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("preserves inside double-click movement and clamps outside movement", () => {
    const map = new FakeMovementMap();
    const onMove = vi.fn();
    bind(map, { onMove });
    map.emitDoubleClick(destinationPoint(map.center, 200, 90));
    map.emitDoubleClick(destinationPoint(map.center, 900, 90));
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove.mock.calls[0]![0].outside).toBe(false);
    expect(onMove.mock.calls[1]![0].outside).toBe(true);
    expect(distanceMeters(map.center, onMove.mock.calls[1]![0].target)).toBeLessThan(600);
    expect(distanceMeters(map.center, onMove.mock.calls[1]![0].target)).toBeGreaterThan(599);
  });

  it("does not build on a short press and permits small pointer jitter", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onLongPressStart = vi.fn();
    bind(map, { onLongPressStart });
    map.pointer("pointerdown", 30, 40);
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS - 1);
    map.pointer("pointerup", 30, 40);
    expect(onLongPressStart).not.toHaveBeenCalled();
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointermove", 30 + MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX - 1, 40);
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS);
    expect(onLongPressStart).toHaveBeenCalledOnce();
  });

  it("cancels long press for deliberate movement, map drag, and multitouch", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onLongPressStart = vi.fn();
    bind(map, { onLongPressStart });
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointermove", 30 + MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX + 1, 40);
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS);
    map.pointer("pointerup", 30, 40);
    map.pointer("pointerdown", 30, 40);
    map.emit("dragstart", {});
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS);
    map.pointer("pointerup", 30, 40);
    map.pointer("pointerdown", 30, 40);
    map.pointer("pointerdown", 32, 42, 2, false);
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS);
    expect(onLongPressStart).not.toHaveBeenCalled();
  });

  it("starts above the held finger, freezes the map, and suppresses clicks after a long release", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onLongPressStart = vi.fn();
    const onLongPressRelease = vi.fn();
    const onMove = vi.fn();
    const unbind = bind(map, { onLongPressStart, onLongPressRelease, onMove });
    const leakedClick = vi.fn();
    map.canvas.addEventListener("click", leakedClick);
    map.pointer("pointerdown", 30, 40);
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS + 900);
    expect(onLongPressStart).toHaveBeenCalledOnce();
    expect(map.unprojectedPoints).toContainEqual([
      30 - MAP_PRECISION_CURSOR_OFFSET_X_PX,
      40 - MAP_PRECISION_CURSOR_OFFSET_Y_PX
    ]);
    expect(map.dragPan.isEnabled()).toBe(false);
    expect(map.touchZoomRotate.isEnabled()).toBe(false);
    map.pointer("pointerup", 30, 40);
    map.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    map.emitDoubleClick(destinationPoint(map.center, 200, 90));
    expect(onLongPressRelease).toHaveBeenCalledOnce();
    expect(map.dragPan.isEnabled()).toBe(true);
    expect(map.touchZoomRotate.isEnabled()).toBe(true);
    expect(map.touchZoomRotate.disableRotation).toHaveBeenCalledOnce();
    expect(onMove).not.toHaveBeenCalled();
    expect(leakedClick).not.toHaveBeenCalled();
    unbind.destroy();
    expect(map.listenerCount("dblclick")).toBe(0);
  });

  it("moves the cursor with the held finger and commits the final clamped target", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onLongPressMove = vi.fn();
    const onLongPressRelease = vi.fn();
    const onMove = vi.fn();
    bind(map, { onLongPressMove, onLongPressRelease, onMove });
    map.pointer("pointerdown", 30, 40);
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS);
    map.pointer("pointermove", 80, 40);
    map.pointer("pointerup", 80, 40);
    vi.advanceTimersByTime(801);
    map.emitDoubleClick(destinationPoint(map.center, 900, 90));
    expect(onLongPressMove).toHaveBeenCalledOnce();
    expect(onLongPressRelease).toHaveBeenCalledOnce();
    expect(onLongPressRelease.mock.calls[0]![0].outside).toBe(true);
    expect(onMove).toHaveBeenCalledOnce();
    expect(distanceMeters(onLongPressRelease.mock.calls[0]![0].target, onMove.mock.calls[0]![0].target)).toBeLessThan(.01);
  });

  it("moves the finger-offset cursor by the held finger delta", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onLongPressRelease = vi.fn();
    bind(map, { onLongPressRelease });
    map.pointer("pointerdown", 30, 40);
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS);
    map.pointer("pointermove", 20, 40);
    map.pointer("pointerup", 20, 40);
    expect(onLongPressRelease).toHaveBeenCalledWith(expect.objectContaining({
      outside: false
    }));
  });

  it("commits an outside hold after the reduced timer without waiting for release", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onLongPressStart = vi.fn();
    const onLongPressMove = vi.fn();
    const onLongPressRelease = vi.fn();
    bind(map, { onLongPressStart, onLongPressMove, onLongPressRelease });
    map.pointer("pointerdown", 80, 40);
    vi.advanceTimersByTime(MAP_OUTSIDE_LONG_PRESS_DURATION_MS - 1);
    expect(onLongPressRelease).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPressStart).not.toHaveBeenCalled();
    expect(onLongPressMove).not.toHaveBeenCalled();
    expect(onLongPressRelease).toHaveBeenCalledWith(expect.objectContaining({
      outside: true
    }));
    map.pointer("pointerup", 80, 40);
    expect(onLongPressRelease).toHaveBeenCalledOnce();
    expect(distanceMeters(map.center, onLongPressRelease.mock.calls[0]![0].target)).toBeLessThan(600);
    expect(distanceMeters(map.center, onLongPressRelease.mock.calls[0]![0].target)).toBeGreaterThan(599);
  });

  it("opts an outside hold into precision while preserving its raw requested coordinate", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onLongPressStart = vi.fn();
    const onLongPressMove = vi.fn();
    const onLongPressRelease = vi.fn();
    bind(map, {
      usePrecisionLongPressOutside: () => true,
      onLongPressStart,
      onLongPressMove,
      onLongPressRelease
    });

    map.pointer("pointerdown", 80, 40);
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS);
    expect(onLongPressStart).toHaveBeenCalledOnce();
    expect(onLongPressRelease).not.toHaveBeenCalled();
    map.pointer("pointermove", 90, 40);
    map.pointer("pointerup", 90, 40);

    expect(onLongPressMove).toHaveBeenCalledOnce();
    expect(onLongPressRelease).toHaveBeenCalledOnce();
    const releasedIntent = onLongPressRelease.mock.calls[0]![0];
    expect(releasedIntent.outside).toBe(true);
    expect(distanceMeters(map.center, releasedIntent.requested)).toBeGreaterThan(600);
    expect(distanceMeters(map.center, releasedIntent.target)).toBeLessThan(600);
    expect(distanceMeters(releasedIntent.requested, releasedIntent.target)).toBeGreaterThan(200);
  });

  it("bases opted-in precision movement on the raw cursor when an inside press offsets outside", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    map.treatNegativeXAsOutside = true;
    const onLongPressStart = vi.fn();
    bind(map, {
      usePrecisionLongPressOutside: () => true,
      onLongPressStart
    });

    map.pointer("pointerdown", 30, 40);
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS);

    expect(onLongPressStart).toHaveBeenCalledOnce();
    const startedIntent = onLongPressStart.mock.calls[0]![0];
    expect(startedIntent.outside).toBe(true);
    expect(map.projectedPoints.at(-1)).toEqual([
      startedIntent.requested.lon,
      startedIntent.requested.lat
    ]);
  });

  it("does not own presses that start away from the playable canvas", () => {
    vi.useFakeTimers();
    const map = new FakeMovementMap();
    const onLongPressStart = vi.fn();
    bind(map, { onLongPressStart });
    const hud = document.createElement("button");
    map.canvas.parentElement!.append(hud);
    hud.dispatchEvent(pointerEvent("pointerdown", 1, 30, 40));
    vi.advanceTimersByTime(MAP_LONG_PRESS_DURATION_MS);
    expect(onLongPressStart).not.toHaveBeenCalled();
  });
});

function bind(
  map: FakeMovementMap,
  overrides: Partial<Parameters<typeof bindMapMovementInput>[1]>
): ReturnType<typeof bindMapMovementInput> {
  return bindMapMovementInput(map as unknown as maplibregl.Map, {
    getGameplayArea: () => ({ anchorLat: map.center.lat, anchorLon: map.center.lon, moveLeashRadiusM: 600 }),
    onMove: vi.fn(),
    onLongPressStart: vi.fn(),
    onLongPressMove: vi.fn(),
    onLongPressRelease: vi.fn(),
    onLongPressCancel: vi.fn(),
    onPendingClick: vi.fn(),
    onPendingClickEnd: vi.fn(),
    onClick: vi.fn(),
    ...overrides
  });
}

class FakeMovementMap {
  readonly center = { lat: 35.0844, lon: -106.6504 };
  readonly canvas = document.createElement("canvas");
  readonly unprojectedPoints: [number, number][] = [];
  readonly projectedPoints: [number, number][] = [];
  treatNegativeXAsOutside = false;
  readonly dragPan = toggleHandler();
  readonly touchZoomRotate = {
    ...toggleHandler(),
    disableRotation: vi.fn()
  };
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  constructor() {
    const parent = document.createElement("div");
    parent.append(this.canvas);
    document.body.append(parent);
    this.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  }
  getCanvas(): HTMLCanvasElement { return this.canvas; }
  project(point: [number, number]): { x: number; y: number } {
    this.projectedPoints.push(point);
    return { x: 50, y: 50 };
  }
  unproject(point: [number, number]): { lat: number; lng: number } {
    this.unprojectedPoints.push(point);
    if (point[0] === 50 && point[1] === 50) {
      return { lat: this.center.lat, lng: this.center.lon };
    }
    const outside = point[0] > 50 || (this.treatNegativeXAsOutside && point[0] < 0);
    const target = destinationPoint(this.center, outside ? 900 : 200, 90);
    return { lat: target.lat, lng: target.lon };
  }
  on(type: string, listener: (event: never) => void): this {
    const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); return this;
  }
  off(type: string, listener: (event: never) => void): this { this.listeners.get(type)?.delete(listener); return this; }
  emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event as never); }
  emitDoubleClick(point: { lat: number; lon: number }): void {
    const preventDefault = vi.fn();
    this.emit("dblclick", {
      preventDefault,
      lngLat: { lat: point.lat, lng: point.lon },
      point: { x: 50, y: 50 },
      originalEvent: new MouseEvent("dblclick", { button: 0 })
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  }
  emitClick(x: number, y: number, button = 0, detail = 1): void {
    const point = this.unproject([x, y]);
    this.emit("click", {
      lngLat: point,
      point: { x, y },
      originalEvent: new MouseEvent("click", { button, detail })
    });
  }
  emitDoubleClickAt(x: number, y: number): void {
    const point = this.unproject([x, y]);
    const preventDefault = vi.fn();
    this.emit("dblclick", {
      preventDefault,
      lngLat: point,
      point: { x, y },
      originalEvent: new MouseEvent("dblclick", { button: 0 })
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  }
  pointer(type: string, x: number, y: number, id = 1, primary = true): void {
    this.canvas.dispatchEvent(pointerEvent(type, id, x, y, primary));
  }
  listenerCount(type: string): number { return this.listeners.get(type)?.size ?? 0; }
}

function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number, isPrimary = true): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, clientX: { value: clientX }, clientY: { value: clientY },
    isPrimary: { value: isPrimary }, button: { value: 0 }
  });
  return event;
}

function toggleHandler(): {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
} {
  let enabled = true;
  return {
    enable: () => { enabled = true; },
    disable: () => { enabled = false; },
    isEnabled: () => enabled
  };
}

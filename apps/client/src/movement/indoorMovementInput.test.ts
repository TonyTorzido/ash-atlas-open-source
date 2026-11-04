import { afterEach, describe, expect, it, vi } from "vitest";

import { mapClickPointerType } from "./mapMovementInput.js";
import {
  WorldMapClickArbitrator,
  WORLD_MAP_CLICK_CONFIRMATION_MS,
  WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS,
  WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX,
  type WorldMapClick
} from "./worldMapClickArbitrator.js";

afterEach(() => vi.useRealTimers());

describe("indoor double-click movement arbitration", () => {
  it("confirms the first interaction immediately and dedupes native dblclick movement", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const first = sample("floor", 100, 100);
    const second = sample("floor", 108, 106);

    arbitrator.click(first);
    vi.advanceTimersByTime(WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS - 1);
    arbitrator.click(second);
    arbitrator.nativeDoubleClick(second);
    vi.runAllTimers();

    expect(handlers.onSingle).toHaveBeenCalledOnce();
    expect(handlers.onSingle).toHaveBeenCalledWith(first);
    expect(handlers.onDouble).toHaveBeenCalledOnce();
    expect(handlers.onDouble).toHaveBeenCalledWith(second);
  });

  it("uses a 100ms confirmation, a shared 300ms recognition window, and 48px screen tolerance", () => {
    expect(WORLD_MAP_CLICK_CONFIRMATION_MS).toBe(100);
    expect(WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS).toBe(300);
    vi.useFakeTimers();
    const timed = handlersFor<string>();
    const timedArbitrator = new WorldMapClickArbitrator(timed);
    timedArbitrator.click(sample("floor", 20, 20));
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS + WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS + 1);
    timedArbitrator.click(sample("floor", 20, 20));
    vi.runAllTimers();
    expect(timed.onSingle).toHaveBeenCalledTimes(2);
    expect(timed.onDouble).not.toHaveBeenCalled();

    const distant = handlersFor<string>();
    const distantArbitrator = new WorldMapClickArbitrator(distant);
    distantArbitrator.click(sample("floor", 20, 20));
    distantArbitrator.click(sample(
      "floor",
      20 + WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX + 1,
      20
    ));
    vi.runAllTimers();
    expect(distant.onSingle).toHaveBeenCalledTimes(2);
    expect(distant.onDouble).not.toHaveBeenCalled();
  });

  it("rejects non-primary and mismatched pointer clicks", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const first = sample("floor");

    arbitrator.click(first);
    arbitrator.click({ ...first, pointerType: "touch" });
    arbitrator.click({ ...first, button: 2 });
    vi.runAllTimers();

    expect(handlers.onDouble).not.toHaveBeenCalled();
    expect(handlers.onSingle).toHaveBeenCalledTimes(2);
  });

  it("cancels pending movement when the indoor lifecycle is interrupted", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const click = sample("floor");

    arbitrator.click(click);
    arbitrator.cancel();
    vi.runAllTimers();

    expect(handlers.onPendingEnd).toHaveBeenCalledWith(click, "cancelled");
    expect(handlers.onSingle).not.toHaveBeenCalled();
  });
});

describe("indoor pointer type normalization", () => {
  it("preserves touch/pen and recognizes compatibility touch clicks", () => {
    expect(mapClickPointerType({ pointerType: "touch" } as unknown as MouseEvent)).toBe("touch");
    expect(mapClickPointerType({ pointerType: "pen" } as unknown as MouseEvent)).toBe("pen");
    expect(mapClickPointerType({
      sourceCapabilities: { firesTouchEvents: true }
    } as unknown as MouseEvent)).toBe("touch");
    expect(mapClickPointerType({} as unknown as MouseEvent)).toBe("mouse");
  });
});

function handlersFor<T>() {
  return {
    onPending: vi.fn<(click: WorldMapClick<T>) => void>(),
    onPendingEnd: vi.fn<
      (click: WorldMapClick<T>, outcome: "confirmed" | "cancelled") => void
    >(),
    onSingle: vi.fn<(click: WorldMapClick<T>) => void>(),
    onDouble: vi.fn<(click: WorldMapClick<T>) => void>()
  };
}

function sample<T>(
  value: T,
  screenX = 0,
  screenY = 0,
  pointerType: WorldMapClick<T>["pointerType"] = "mouse",
  button = 0
): WorldMapClick<T> {
  return { value, screenX, screenY, button, pointerType };
}

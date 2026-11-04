import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WorldMapClickArbitrator,
  WORLD_MAP_CLICK_CONFIRMATION_MS,
  WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS,
  WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX,
  type WorldMapClick
} from "./worldMapClickArbitrator.js";

afterEach(() => vi.useRealTimers());

describe("world map click arbitrator", () => {
  it.each(["flag", "tree", "mob", "dropped_item"] as const)(
    "confirms one %s interaction immediately",
    (kind) => {
      vi.useFakeTimers();
      const handlers = handlersFor<string>();
      const arbitrator = new WorldMapClickArbitrator(handlers);
      const click = sample(kind);

      arbitrator.click(click);
      expect(handlers.onPending).toHaveBeenCalledWith(click);

      vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS);
      expect(handlers.onSingle).toHaveBeenCalledOnce();
      expect(handlers.onSingle).toHaveBeenCalledWith(click);
      expect(handlers.onPendingEnd).toHaveBeenCalledWith(click, "confirmed");
      expect(handlers.onDouble).not.toHaveBeenCalled();
    }
  );

  it.each(["flag", "tree", "mob", "dropped_item"] as const)(
    "turns a double click on a %s into one movement after immediate interaction",
    (kind) => {
      vi.useFakeTimers();
      const handlers = handlersFor<string>();
      const arbitrator = new WorldMapClickArbitrator(handlers);
      const first = sample(kind);
      const second = sample(kind, 5, 4);

      arbitrator.click(first);
      vi.advanceTimersByTime(WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS - 1);
      arbitrator.click(second);
      arbitrator.nativeDoubleClick(second);
      vi.runAllTimers();

      expect(handlers.onSingle).toHaveBeenCalledOnce();
      expect(handlers.onSingle).toHaveBeenCalledWith(first);
      expect(handlers.onDouble).toHaveBeenCalledOnce();
      expect(handlers.onDouble).toHaveBeenCalledWith(second);
      expect(handlers.onPendingEnd).toHaveBeenCalledWith(first, "confirmed");
    }
  );

  it("moves on a touch double-tap over a tree without ever opening its popup", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const first = { ...sample("tree"), pointerType: "touch" as const };
    const second = { ...sample("tree", 6, 5), pointerType: "touch" as const };

    arbitrator.click(first);
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS - 1);
    expect(handlers.onSingle).not.toHaveBeenCalled();
    arbitrator.click(second);
    vi.runAllTimers();

    expect(handlers.onSingle).not.toHaveBeenCalled();
    expect(handlers.onDouble).toHaveBeenCalledOnce();
    expect(handlers.onPendingEnd).toHaveBeenCalledWith(first, "cancelled");
  });

  it("opens a single touch tap once the double-tap window passes", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const tap = { ...sample("tree"), pointerType: "touch" as const };

    arbitrator.click(tap);
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS - 1);
    expect(handlers.onSingle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(handlers.onSingle).toHaveBeenCalledWith(tap);
  });

  it("keeps spatially separate clicks as separate interactions", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const first = sample("flag");
    const second = sample("tree", WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX + 1, 0);

    arbitrator.click(first);
    arbitrator.click(second);
    vi.runAllTimers();

    expect(handlers.onSingle.mock.calls.map(([click]) => click.value)).toEqual([
      "flag",
      "tree"
    ]);
    expect(handlers.onDouble).not.toHaveBeenCalled();
  });

  it("accepts a near-boundary displacement within the shared tolerance", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const first = sample("flag");
    const second = sample("flag", WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX - 1, 0);

    arbitrator.click(first);
    vi.advanceTimersByTime(WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS - 1);
    arbitrator.click(second);

    expect(Math.hypot(second.screenX - first.screenX, second.screenY - first.screenY))
      .toBeLessThan(WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX);
    expect(handlers.onSingle).toHaveBeenCalledOnce();
    expect(handlers.onSingle).toHaveBeenCalledWith(first);
    expect(handlers.onDouble).toHaveBeenCalledOnce();
    expect(handlers.onDouble).toHaveBeenCalledWith(second);
  });

  it("keeps clicks outside the timing window separate", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);

    arbitrator.click(sample("flag"));
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS + WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS + 1);
    const second = sample("flag");
    arbitrator.click(second);
    vi.runAllTimers();

    expect(handlers.onSingle).toHaveBeenCalledTimes(2);
    expect(handlers.onDouble).not.toHaveBeenCalled();
  });

  it("turns a stationary click after confirmation into one movement without native dblclick", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const first = sample("ground", 100, 100);
    const second = sample("ground", 100, 100);

    arbitrator.click(first);
    vi.advanceTimersByTime(200);
    arbitrator.click(second);
    vi.runAllTimers();

    expect(handlers.onSingle).toHaveBeenCalledOnce();
    expect(handlers.onSingle).toHaveBeenCalledWith(first);
    expect(handlers.onDouble).toHaveBeenCalledOnce();
    expect(handlers.onDouble).toHaveBeenCalledWith(second);
  });

  it("clears a completed-click candidate when cancelled", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);

    arbitrator.click(sample("ground"));
    vi.advanceTimersByTime(200);
    arbitrator.cancel();
    arbitrator.click(sample("ground"));
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS);

    expect(handlers.onDouble).not.toHaveBeenCalled();
    expect(handlers.onSingle).toHaveBeenCalledTimes(2);
  });

  it("honors a native double click after the custom confirmation window", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const first = sample("ground");
    const second = sample("ground", 4, 3);

    arbitrator.click(first);
    vi.advanceTimersByTime(WORLD_MAP_CLICK_CONFIRMATION_MS + WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS + 1);
    arbitrator.click(second);
    arbitrator.nativeDoubleClick(second);
    vi.runAllTimers();

    expect(handlers.onDouble).toHaveBeenCalledOnce();
    expect(handlers.onDouble).toHaveBeenCalledWith(second);
    expect(handlers.onPendingEnd).toHaveBeenCalledWith(second, "cancelled");
  });

  it("deduplicates a native dblclick after a completed-click custom movement", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const first = sample("ground", 100, 100);
    const second = sample("ground", 108, 106);

    arbitrator.click(first);
    vi.advanceTimersByTime(200);
    arbitrator.click(second);
    arbitrator.nativeDoubleClick(second);

    expect(handlers.onSingle).toHaveBeenCalledOnce();
    expect(handlers.onDouble).toHaveBeenCalledOnce();
    expect(handlers.onDouble).toHaveBeenCalledWith(second);
  });

  it("requires the same primary pointer type and ignores right click", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const mouse = sample("flag");

    arbitrator.click(mouse);
    arbitrator.click({ ...mouse, pointerType: "touch" });
    arbitrator.click({ ...mouse, button: 2 });
    vi.runAllTimers();

    expect(handlers.onSingle).toHaveBeenCalledTimes(2);
    expect(handlers.onDouble).not.toHaveBeenCalled();
  });

  it("cancels pending feedback and prevents stale confirmation", () => {
    vi.useFakeTimers();
    const handlers = handlersFor<string>();
    const arbitrator = new WorldMapClickArbitrator(handlers);
    const click = sample("flag");

    arbitrator.click(click);
    arbitrator.cancel();
    vi.runAllTimers();

    expect(handlers.onPendingEnd).toHaveBeenCalledWith(click, "cancelled");
    expect(handlers.onSingle).not.toHaveBeenCalled();
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
  screenY = 0
): WorldMapClick<T> {
  return { value, screenX, screenY, button: 0, pointerType: "mouse" };
}

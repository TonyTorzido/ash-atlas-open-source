// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useJewelStationFeature } from "./useJewelStationFeature.js";
import { isManorServerMessage } from "./manorFeatureContracts.js";

describe("useJewelStationFeature", () => {
  it.each([
    { type: "JEWEL_STATION_STATE" },
    { type: "JEWEL_STATION_RESULT" },
    { type: "JEWEL_STATION_ERROR" }
  ])("routes $type through the manor frame family", (message) => {
    expect(isManorServerMessage(message as never)).toBe(true);
  });

  it("clears a lost pending request and retries when the connection returns", () => {
    const openJewelStation = vi.fn()
      .mockReturnValueOnce("open-1")
      .mockReturnValueOnce("open-2");
    const options = {
      open: true,
      online: true,
      manorSessionId: "00000000-0000-4000-8000-000000000001",
      getMovementSequence: () => 1,
      getCommands: () => ({ openJewelStation }),
      receiveInventory: vi.fn(),
      receiveEquipment: vi.fn(),
      showActionError: vi.fn(),
      inscribeRequest: vi.fn(),
      onClose: vi.fn()
    };
    const view = renderHook(
      ({ online }) => useJewelStationFeature({ ...options, online } as never),
      { initialProps: { online: true } }
    );

    expect(view.result.current.busy).toBe(true);
    expect(openJewelStation).toHaveBeenCalledTimes(1);

    act(() => view.rerender({ online: false }));
    expect(view.result.current.busy).toBe(false);

    act(() => view.rerender({ online: true }));
    expect(view.result.current.busy).toBe(true);
    expect(openJewelStation).toHaveBeenCalledTimes(2);
  });

  it("supersedes a stuck opening request when the player retries", () => {
    const openJewelStation = vi.fn()
      .mockReturnValueOnce("open-1")
      .mockReturnValueOnce("open-2");
    const options = {
      open: true,
      online: true,
      manorSessionId: "00000000-0000-4000-8000-000000000001",
      getMovementSequence: () => 1,
      getCommands: () => ({ openJewelStation }) as never,
      receiveInventory: vi.fn(),
      receiveEquipment: vi.fn(),
      showActionError: vi.fn(),
      inscribeRequest: vi.fn(),
      onClose: vi.fn()
    };
    const view = renderHook(() => useJewelStationFeature(options));

    act(() => view.result.current.retry());

    expect(openJewelStation).toHaveBeenCalledTimes(2);
    act(() => view.result.current.handleServerMessage({
      type: "JEWEL_STATION_ERROR",
      requestId: "open-1",
      code: "STALE",
      message: "Stale response"
    }));
    expect(view.result.current.busy).toBe(true);
    act(() => view.result.current.handleServerMessage({
      type: "JEWEL_STATION_ERROR",
      requestId: "open-2",
      code: "CURRENT",
      message: "Current response"
    }));
    expect(view.result.current.busy).toBe(false);
    expect(view.result.current.feedback).toBe("Current response");
  });

  it("releases a lost opening request after a bounded timeout", () => {
    vi.useFakeTimers();
    const openJewelStation = vi.fn(() => "open-1");
    const showActionError = vi.fn();
    const options = {
      open: true,
      online: true,
      manorSessionId: "00000000-0000-4000-8000-000000000001",
      getMovementSequence: () => 1,
      getCommands: () => ({ openJewelStation }) as never,
      receiveInventory: vi.fn(),
      receiveEquipment: vi.fn(),
      showActionError,
      inscribeRequest: vi.fn(),
      onClose: vi.fn()
    };
    const view = renderHook(() => useJewelStationFeature(options));

    act(() => { vi.advanceTimersByTime(8_000); });

    expect(view.result.current.busy).toBe(false);
    expect(view.result.current.feedback).toBe("The Jewel Station did not respond. Try again.");
    expect(showActionError).toHaveBeenCalledWith("The Jewel Station did not respond. Try again.");
    view.unmount();
    vi.useRealTimers();
  });
});

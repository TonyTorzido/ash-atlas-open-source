// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWorldMapTravel } from "./useWorldMapTravel.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("useWorldMapTravel", () => {
  it("sends one request and rejects duplicate taps", () => {
    const send = vi.fn(() => "request-a");
    const commit = vi.fn(() => "request-a");
    const { result } = renderHook(() => useWorldMapTravel());
    const destination = {
      kind: "city" as const,
      id: "city-a",
      name: "Albuquerque",
      lat: 36,
      lon: -105
    };

    act(() => {
      expect(result.current.begin(
        { lat: 35, lon: -106 },
        destination,
        send,
        commit
      )).toBe("request-a");
      expect(result.current.begin(
        { lat: 35, lon: -106 },
        destination,
        send,
        commit
      )).toBeNull();
    });

    expect(send).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      phase: "travelling",
      requestId: "request-a"
    });
  });

  it("releases the request gate after a matching authoritative failure", () => {
    const send = vi.fn()
      .mockReturnValueOnce("request-a")
      .mockReturnValueOnce("request-b");
    const commit = vi.fn((requestId: string) => requestId);
    const { result } = renderHook(() => useWorldMapTravel());
    const destination = {
      kind: "manor" as const,
      id: "manor-a",
      name: "Your Manor",
      lat: 36,
      lon: -105
    };

    act(() => {
      result.current.begin(
        { lat: 35, lon: -106 },
        destination,
        send,
        commit
      );
    });
    act(() => result.current.observeFrame({
      type: "TRAVEL_RESULT",
      requestId: "request-a",
      kind: "manor_jump",
      success: false,
      message: "The manor is unavailable."
    }));
    expect(result.current.state.phase).toBe("failed");

    act(() => {
      expect(result.current.begin(
        { lat: 35, lon: -106 },
        destination,
        send,
        commit
      )).toBe("request-b");
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("warms immediately, cancels without arriving, and commits once only after the route timer", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const prepare = vi.fn(() => "request-a");
    const commit = vi.fn((requestId: string) => requestId);
    const { result } = renderHook(() => useWorldMapTravel());
    const destination = {
      kind: "city" as const,
      id: "city-a",
      name: "Albuquerque",
      lat: 36,
      lon: -105
    };

    act(() => {
      result.current.begin(
        { lat: 35, lon: -106 },
        destination,
        prepare,
        commit
      );
    });
    expect(commit).not.toHaveBeenCalled();

    act(() => {
      expect(result.current.cancel()).toBe(true);
    });
    expect(result.current.state.phase).toBe("idle");
    expect(commit).not.toHaveBeenCalled();

    act(() => {
      result.current.begin(
        { lat: 35, lon: -106 },
        destination,
        prepare,
        commit
      );
      result.current.markPresentationComplete("request-a");
    });
    expect(commit).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("travelling");
    clock.mockReturnValue(15_000);
    act(() => {
      result.current.markPresentationComplete("request-a");
      result.current.markPresentationComplete("request-a");
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenLastCalledWith("request-a");
    expect(result.current.state.phase).toBe("preparing");
    expect(result.current.cancel()).toBe(false);
  });
});

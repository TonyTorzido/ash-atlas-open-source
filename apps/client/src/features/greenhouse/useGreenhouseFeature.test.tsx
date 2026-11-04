// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GameClient } from "../../gameClient.js";
import { useGreenhouseFeature } from "./useGreenhouseFeature.js";

describe("useGreenhouseFeature build request correlation", () => {
  afterEach(() => vi.useRealTimers());

  const greenhousePosition = (greenhouseSessionId: string) => ({
    type: "GREENHOUSE_POSITION",
    greenhouseSessionId,
    position: {
      x: 1,
      y: 2,
      targetX: null,
      targetY: null,
      moving: false,
      revision: 1
    },
    movementSequence: 1,
    serverTime: 1
  } as const);

  it("clears the build latch on matching errors and ignores stale replies", () => {
    const buildGreenhouse = vi.fn()
      .mockReturnValueOnce("build-1")
      .mockReturnValueOnce("build-2");
    const client = { buildGreenhouse } as unknown as GameClient;
    const clientRef = { current: client } as React.RefObject<GameClient | null>;
    const onError = vi.fn();
    const { result } = renderHook(() => useGreenhouseFeature(clientRef, onError, undefined, "player-1"));

    act(() => { result.current.buildGreenhouse(); });
    expect(result.current.buildRequestId).toBe("build-1");
    act(() => {
      result.current.handleServerMessage({ type: "GREENHOUSE_ERROR", requestId: "build-1", code: "GREENHOUSE_MATERIALS_REQUIRED", message: "Need bars." } as never);
    });
    expect(result.current.buildRequestId).toBeNull();
    expect(result.current.buildError).toBe("Need bars.");

    act(() => { result.current.buildGreenhouse(); });
    expect(result.current.buildRequestId).toBe("build-2");
    act(() => {
      result.current.handleServerMessage({ type: "GREENHOUSE_ERROR", requestId: "build-1", code: "GREENHOUSE_MATERIALS_REQUIRED", message: "stale" } as never);
    });
    expect(result.current.buildRequestId).toBe("build-2");
    expect(result.current.buildError).toBeNull();
  });

  it("recovers a lost preview reply and ignores the late response", () => {
    vi.useFakeTimers();
    const previewGreenhouseBuild = vi.fn()
      .mockReturnValueOnce("preview-1")
      .mockReturnValueOnce("preview-2");
    const client = { previewGreenhouseBuild } as unknown as GameClient;
    const clientRef = { current: client } as React.RefObject<GameClient | null>;
    const { result } = renderHook(() => useGreenhouseFeature(clientRef, vi.fn()));

    act(() => { result.current.previewBuild(); });
    expect(result.current.buildPreviewRequestId).toBe("preview-1");
    act(() => { vi.advanceTimersByTime(8_000); });
    expect(result.current.buildPreviewRequestId).toBeNull();
    expect(result.current.buildPreviewError).toMatch(/timed out/i);

    act(() => { result.current.previewBuild(); });
    expect(result.current.buildPreviewRequestId).toBe("preview-2");
    act(() => {
      result.current.handleServerMessage({
        type: "GREENHOUSE_BUILD_PREVIEW",
        requestId: "preview-1",
        preview: {}
      } as never);
    });
    expect(result.current.buildPreviewRequestId).toBe("preview-2");
    expect(result.current.buildPreview).toBeNull();
  });

  it("can exit the canonical greenhouse before its projection session arrives", () => {
    const exitGreenhouse = vi.fn().mockReturnValue("exit-1");
    const client = { exitGreenhouse } as unknown as GameClient;
    const clientRef = { current: client } as React.RefObject<GameClient | null>;
    const { result } = renderHook(() => useGreenhouseFeature(clientRef, vi.fn()));

    let requestId: string | null = null;
    act(() => { requestId = result.current.exit(); });

    expect(requestId).toBe("exit-1");
    expect(exitGreenhouse).toHaveBeenCalledWith("");
  });

  it("retires the exited session before accepting a fresh re-entry projection", () => {
    const client = {} as GameClient;
    const clientRef = { current: client } as React.RefObject<GameClient | null>;
    const { result } = renderHook(() => useGreenhouseFeature(clientRef, vi.fn()));

    act(() => { result.current.handleServerMessage(greenhousePosition("session-a")); });
    expect(result.current.sessionId).toBe("session-a");

    act(() => { result.current.resetSession(); });
    expect(result.current.sessionId).toBeNull();
    expect(result.current.position).toBeNull();

    act(() => { result.current.handleServerMessage(greenhousePosition("session-a")); });
    expect(result.current.sessionId).toBeNull();
    act(() => { result.current.handleServerMessage(greenhousePosition("session-b")); });
    expect(result.current.sessionId).toBe("session-b");
  });

  it("clears reconnect-sensitive state before restored projection frames arrive", () => {
    const client = {} as GameClient;
    const clientRef = { current: client } as React.RefObject<GameClient | null>;
    const { result } = renderHook(() => useGreenhouseFeature(clientRef, vi.fn()));

    act(() => {
      result.current.handleServerMessage(greenhousePosition("session-a"));
      result.current.handleServerMessage({
        type: "GREENHOUSE_WATER_FILL_STARTED",
        requestId: "fill-1",
        gallons: 1,
        completesAt: 3_000,
        rangeM: 200,
        message: "Filling"
      });
    });
    expect(result.current.sessionId).toBe("session-a");
    expect(result.current.fill?.gallons).toBe(1);

    act(() => { result.current.resetSession(); });
    expect(result.current.sessionId).toBeNull();
    expect(result.current.position).toBeNull();
    expect(result.current.state).toBeNull();
    expect(result.current.fill).toBeNull();

    act(() => { result.current.handleServerMessage(greenhousePosition("session-a")); });
    expect(result.current.sessionId).toBeNull();
    act(() => { result.current.handleServerMessage(greenhousePosition("session-b")); });
    expect(result.current.sessionId).toBe("session-b");
  });
});

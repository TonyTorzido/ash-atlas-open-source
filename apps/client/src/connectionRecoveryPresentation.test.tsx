// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useConnectionRecoveryPresentation } from "./connectionRecoveryPresentation.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("useConnectionRecoveryPresentation", () => {
  it("shows planned update status immediately and blocks only after ten seconds", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ online }) => useConnectionRecoveryPresentation({
        authoritativeOnline: online,
        hasCompletedBootstrap: true
      }),
      { initialProps: { online: true } }
    );

    act(() => result.current.noteDisconnect(1012));
    rerender({ online: false });

    expect(result.current.plannedNotice).toBe(true);
    expect(result.current.blocking).toBe(false);
    act(() => { vi.advanceTimersByTime(9_999); });
    expect(result.current.blocking).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.blocking).toBe(true);
    expect(result.current.plannedNotice).toBe(false);
  });

  it("keeps an unexpected disconnect quiet for 2.5 seconds before blocking", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ online }) => useConnectionRecoveryPresentation({
        authoritativeOnline: online,
        hasCompletedBootstrap: true
      }),
      { initialProps: { online: true } }
    );

    act(() => result.current.noteDisconnect(1006));
    rerender({ online: false });

    expect(result.current.plannedNotice).toBe(false);
    expect(result.current.blocking).toBe(false);
    act(() => { vi.advanceTimersByTime(2_499); });
    expect(result.current.blocking).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.blocking).toBe(true);
  });

  it("clears planned and blocking presentation when authority is online", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ online }) => useConnectionRecoveryPresentation({
        authoritativeOnline: online,
        hasCompletedBootstrap: true
      }),
      { initialProps: { online: true } }
    );

    act(() => result.current.noteDisconnect(1012));
    rerender({ online: false });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.blocking).toBe(true);

    rerender({ online: true });
    act(() => result.current.resetForAuthoritativeOnline());
    expect(result.current).toMatchObject({
      blocking: false,
      ended: false,
      plannedNotice: false
    });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.blocking).toBe(false);
  });

  it("makes an ended recovery immediately blocking", () => {
    const { result } = renderHook(() => useConnectionRecoveryPresentation({
      authoritativeOnline: false,
      hasCompletedBootstrap: true
    }));

    act(() => result.current.noteRecoveryEnded());

    expect(result.current).toMatchObject({ blocking: true, ended: true });
  });
});

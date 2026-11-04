import { describe, expect, it, vi } from "vitest";

import {
  MatchedPendingTravelWatchdog,
  settledTravelRequestId
} from "./pendingTravelWatchdog.js";

describe("MatchedPendingTravelWatchdog", () => {
  it("cancels request A when success arrives before timeout", () => {
    vi.useFakeTimers();
    try {
      let pending: string | null = "A";
      const timeout = vi.fn();
      const watchdog = new MatchedPendingTravelWatchdog({
        pendingRequestId: () => pending,
        onTimeout: timeout,
        timeoutMs: 20_000
      });
      watchdog.arm("A");
      pending = null;
      expect(watchdog.settle("A")).toBe(true);
      vi.advanceTimersByTime(20_000);
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a matching correlated error", () => {
    let pending: string | null = "A";
    const watchdog = new MatchedPendingTravelWatchdog({
      pendingRequestId: () => pending,
      onTimeout: vi.fn()
    });
    watchdog.arm("A");
    const requestId = settledTravelRequestId({
      type: "ERROR",
      requestId: "A"
    });
    pending = null;
    expect(requestId && watchdog.settle(requestId)).toBe(true);
  });

  it("clears only timed-out A and allows a next request", () => {
    vi.useFakeTimers();
    try {
      let pending: string | null = "A";
      const timeout = vi.fn((requestId: string) => {
        if (pending === requestId) pending = null;
      });
      const watchdog = new MatchedPendingTravelWatchdog({
        pendingRequestId: () => pending,
        onTimeout: timeout,
        timeoutMs: 20_000
      });
      watchdog.arm("A");
      vi.advanceTimersByTime(20_000);
      expect(timeout).toHaveBeenCalledWith("A");
      expect(pending).toBeNull();
      pending = "B";
      watchdog.arm("B");
      expect(pending).toBe("B");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets A's timer or late frames clear newer B", () => {
    vi.useFakeTimers();
    try {
      let pending: string | null = "A";
      const timeout = vi.fn((requestId: string) => {
        if (pending === requestId) pending = null;
      });
      const watchdog = new MatchedPendingTravelWatchdog({
        pendingRequestId: () => pending,
        onTimeout: timeout,
        timeoutMs: 20_000
      });
      watchdog.arm("A");
      pending = "B";
      watchdog.arm("B");
      expect(watchdog.settle("A")).toBe(false);
      vi.advanceTimersByTime(19_999);
      expect(pending).toBe("B");
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a late authoritative A frame after A timed out", () => {
    vi.useFakeTimers();
    try {
      let pending: string | null = "A";
      const watchdog = new MatchedPendingTravelWatchdog({
        pendingRequestId: () => pending,
        onTimeout: (requestId) => {
          if (pending === requestId) pending = null;
        },
        timeoutMs: 20_000
      });
      watchdog.arm("A");
      vi.advanceTimersByTime(20_000);
      expect(pending).toBeNull();

      const lateRequestId = settledTravelRequestId({
        type: "FLAG_VISITED",
        requestId: "A"
      });
      expect(lateRequestId).toBe("A");
      expect(lateRequestId && watchdog.settle(lateRequestId)).toBe(false);
      expect(pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears on disconnect or teardown", () => {
    vi.useFakeTimers();
    try {
      const timeout = vi.fn();
      const watchdog = new MatchedPendingTravelWatchdog({
        pendingRequestId: () => "A",
        onTimeout: timeout,
        timeoutMs: 20_000
      });
      watchdog.arm("A");
      watchdog.clear();
      vi.advanceTimersByTime(20_000);
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognizes only authoritative settlement frames", () => {
    expect(settledTravelRequestId({
      type: "FLAG_VISITED",
      requestId: "A"
    })).toBe("A");
    expect(settledTravelRequestId({
      type: "CITY_VISITED",
      requestId: "A"
    })).toBe("A");
    expect(settledTravelRequestId({
      type: "TRAVEL_RESULT",
      requestId: "A",
      success: true
    })).toBe("A");
    expect(settledTravelRequestId({
      type: "TRAVEL_RESULT",
      requestId: "A",
      success: false
    })).toBeNull();
  });
});

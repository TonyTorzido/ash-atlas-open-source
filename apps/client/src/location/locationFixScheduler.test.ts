import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceLocation } from "./deviceGeolocation.js";
import {
  ACTION_FIX_MIN_INTERVAL_MS,
  INITIAL_PASSIVE_FIX_DELAY_MS,
  LocationFixScheduler
} from "./locationFixScheduler.js";

const FIX: DeviceLocation = { lat: 40, lon: -105, accuracy: 20 };

function harness(options: { granted?: boolean; foreground?: boolean; randoms?: number[]; native?: boolean } = {}) {
  const randoms = [...(options.randoms ?? [])];
  let foregroundHandler: ((foreground: boolean) => void) | null = null;
  const deps = {
    readLocation: vi.fn<(options: { maximumAgeMs?: number; timeoutMs?: number }) => Promise<DeviceLocation | null>>(async () => FIX),
    hasPermission: vi.fn(async () => options.granted ?? true),
    isForeground: vi.fn(() => options.foreground ?? true),
    subscribeForeground: vi.fn((handler: (foreground: boolean) => void) => {
      foregroundHandler = handler;
      return () => {
        foregroundHandler = null;
      };
    }),
    now: () => Date.now(),
    random: vi.fn(() => randoms.shift() ?? 0),
    setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    isNative: () => options.native ?? false
  };
  const scheduler = new LocationFixScheduler(deps);
  const sent: Array<{ reason: string; location: DeviceLocation }> = [];
  const sink = vi.fn((location: DeviceLocation, reason: string) => {
    sent.push({ reason, location });
    return true;
  });
  return {
    deps,
    scheduler,
    sink,
    sent,
    setForeground: (foreground: boolean) => foregroundHandler?.(foreground)
  };
}

describe("LocationFixScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the first fix after the initial delay, then at a random delay within [min, max]", async () => {
    // Rolls: initial schedule (ignored, no prior fix), then 0 -> min, 0.5 -> midpoint.
    const { scheduler, sink, deps, sent } = harness({ randoms: [0.9, 0, 0.5] });
    scheduler.start(sink, 180, 420);

    await vi.advanceTimersByTimeAsync(INITIAL_PASSIVE_FIX_DELAY_MS - 1);
    expect(deps.readLocation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ reason: "periodic", location: FIX }]);
    const [options] = deps.readLocation.mock.calls[0]!;
    expect(options.maximumAgeMs).toBeLessThanOrEqual(30_000);
    expect(options.timeoutMs).toBeGreaterThan(0);

    // Second delay rolled 0 -> exactly the minimum (180 s).
    await vi.advanceTimersByTimeAsync(179_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);

    // Third delay rolled 0.5 -> 300 s: re-rolled after every fix.
    await vi.advanceTimersByTimeAsync(299_999);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(3);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(sent).toHaveLength(3);
  });

  it("never schedules past max, even for a roll just under 1", async () => {
    const { scheduler, sink, sent } = harness({ randoms: [0, 0.999999] });
    scheduler.start(sink, 180, 420);
    await vi.advanceTimersByTimeAsync(INITIAL_PASSIVE_FIX_DELAY_MS);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(420_000);
    expect(sent).toHaveLength(2);
  });

  it("clamps min to 60 s and max to at least min", async () => {
    const { scheduler, sink, sent } = harness({ randoms: [0, 0.99] });
    scheduler.start(sink, 5, 1);
    await vi.advanceTimersByTimeAsync(INITIAL_PASSIVE_FIX_DELAY_MS);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });

  it("pauses while hidden and fixes on return only when the last fix is older than the min", async () => {
    const { scheduler, sink, sent, setForeground } = harness({ randoms: [0, 0, 0.5, 0.5] });
    scheduler.start(sink, 180, 420);
    await vi.advanceTimersByTimeAsync(INITIAL_PASSIVE_FIX_DELAY_MS);
    expect(sent).toHaveLength(1);

    setForeground(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toHaveLength(1);

    // Back after 10 minutes: stale, so one goes out at once, then random scheduling continues.
    setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);

    // A short trip to the background does not trigger an early fix.
    setForeground(false);
    await vi.advanceTimersByTimeAsync(30_000);
    setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    // Resume re-rolls (0.5 -> 300 s after the last fix, 30 s already elapsed).
    await vi.advanceTimersByTimeAsync(269_999);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(3);
  });

  it("starts hidden without reading until the game is in the foreground", async () => {
    const { scheduler, sink, deps, setForeground } = harness({ foreground: false });
    scheduler.start(sink, 180, 420);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(deps.readLocation).not.toHaveBeenCalled();
    setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sink).toHaveBeenCalledWith(FIX, "periodic");
  });

  it("sends nothing when permission is not already granted", async () => {
    const { scheduler, sink, deps } = harness({ granted: false });
    deps.readLocation.mockResolvedValue(null);
    scheduler.start(sink, 180, 420);
    await vi.advanceTimersByTimeAsync(INITIAL_PASSIVE_FIX_DELAY_MS);
    expect(sink).not.toHaveBeenCalled();
  });

  it("sends action fixes only when enabled, native, foreground and started, at most one per minute", async () => {
    const web = harness({ native: false });
    web.scheduler.start(web.sink, 180, 420);
    web.scheduler.setActionFixesEnabled(true);
    web.scheduler.requestActionFix("action_flag_place");
    await vi.advanceTimersByTimeAsync(0);
    expect(web.sink).not.toHaveBeenCalled();
    web.scheduler.stop();

    const phone = harness({ native: true });
    phone.scheduler.requestActionFix("action_flag_place");
    phone.scheduler.start(phone.sink, 180, 420);
    phone.scheduler.requestActionFix("action_flag_place");
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.sink).not.toHaveBeenCalled();
    phone.scheduler.setActionFixesEnabled(true);
    phone.scheduler.requestActionFix("action_flag_attack");
    phone.scheduler.requestActionFix("action_city_found");
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.sent.map((entry) => entry.reason)).toEqual(["action_flag_attack"]);
    await vi.advanceTimersByTimeAsync(ACTION_FIX_MIN_INTERVAL_MS);
    phone.scheduler.requestActionFix("action_city_found");
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.sent.map((entry) => entry.reason)).toContain("action_city_found");
    phone.setForeground(false);
    await vi.advanceTimersByTimeAsync(ACTION_FIX_MIN_INTERVAL_MS);
    const before = phone.sent.length;
    phone.scheduler.requestActionFix("action_flag_place");
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.sent).toHaveLength(before);
    phone.scheduler.stop();
  });
});

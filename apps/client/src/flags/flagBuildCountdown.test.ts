import { FISHING_HUT_BUILD_DURATION_MS } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  buildRemainingTimeLabel,
  completeFlagBuildCountdown,
  createFlagBuildCountdown,
  flagBuildProgress,
  flagBuildRemainingMs,
  flagBuildRemainingTimeLabel
} from "./flagBuildCountdown.js";

describe("flag build countdown", () => {
  it("keeps the 30-second Fishing Hut timer and progress aligned", () => {
    const startedAt = 100_000;
    const countdown = createFlagBuildCountdown({
      startedAt,
      completesAt: startedAt + FISHING_HUT_BUILD_DURATION_MS,
      durationMs: FISHING_HUT_BUILD_DURATION_MS,
      serverTime: startedAt
    }, 2_000);

    expect(countdown.durationMs).toBe(30_000);
    expect(flagBuildRemainingTimeLabel(countdown, 2_000)).toBe("30.0s");
    expect(flagBuildProgress(countdown, 17_000)).toBeCloseTo(0.5, 5);
    expect(flagBuildRemainingTimeLabel(countdown, 17_000)).toBe("15.0s");
    expect(flagBuildProgress(countdown, 32_000)).toBe(1);
    expect(flagBuildRemainingTimeLabel(countdown, 32_000)).toBe("Finalizing…");
  });

  it.each([-5_000, 5_000])(
    "ignores a browser wall-clock offset of %d ms",
    (wallClockOffset) => {
      const serverTime = 100_000;
      const browserDateNow = serverTime + wallClockOffset;
      const countdown = createFlagBuildCountdown({
        startedAt: 90_000,
        completesAt: 110_000,
        durationMs: 20_000,
        serverTime
      }, 2_000);

      expect(browserDateNow).not.toBe(serverTime);
      expect(flagBuildRemainingMs(countdown, 2_000)).toBe(10_000);
    }
  );

  it("shows zero and full progress as soon as FLAG_CREATED is authoritative", () => {
    const countdown = createFlagBuildCountdown({
      startedAt: 1_000,
      completesAt: 11_000,
      durationMs: 10_000,
      serverTime: 6_000
    }, 100);

    const completed = completeFlagBuildCountdown(countdown, 4_600);

    expect(flagBuildRemainingMs(completed, 4_600)).toBe(0);
    expect(flagBuildProgress(completed, 4_600)).toBe(1);
  });

  it("does not compensate away network delay and display completion early", () => {
    const countdown = createFlagBuildCountdown({
      startedAt: 1_000,
      completesAt: 11_000,
      durationMs: 10_000,
      serverTime: 6_000
    }, 3_000);

    expect(flagBuildRemainingMs(countdown, 7_999)).toBe(1);
    expect(flagBuildRemainingMs(countdown, 8_000)).toBe(0);
  });

  it("recalculates from monotonic time after browser sleep", () => {
    const countdown = createFlagBuildCountdown({
      startedAt: 1_000,
      completesAt: 11_000,
      durationMs: 10_000,
      serverTime: 1_000
    }, 500);

    expect(flagBuildRemainingMs(countdown, 500)).toBe(10_000);
    expect(flagBuildRemainingMs(countdown, 12_500)).toBe(0);
  });

  it("shows tenths without displaying completion early", () => {
    const countdown = createFlagBuildCountdown({
      startedAt: 50_000,
      completesAt: 60_000,
      durationMs: 10_000,
      serverTime: 50_000
    }, 1_000);

    expect(flagBuildRemainingTimeLabel(countdown, 1_000)).toBe("10.0s");
    expect(flagBuildRemainingTimeLabel(countdown, 1_001)).toBe("10.0s");
    expect(flagBuildRemainingTimeLabel(countdown, 1_100)).toBe("9.9s");
    expect(flagBuildRemainingTimeLabel(countdown, 10_999)).toBe("0.1s");
    expect(flagBuildRemainingTimeLabel(countdown, 11_000)).toBe("Finalizing\u2026");
  });

  it("formats non-flag construction countdowns with the same precision", () => {
    expect(buildRemainingTimeLabel(8_400)).toBe("8.4s");
    expect(buildRemainingTimeLabel(8_301)).toBe("8.4s");
    expect(buildRemainingTimeLabel(8_300)).toBe("8.3s");
    expect(buildRemainingTimeLabel(0)).toBe("Finalizing\u2026");
  });

  it("does not mark a locally elapsed countdown authoritative", () => {
    const countdown = createFlagBuildCountdown({
      startedAt: 50_000,
      completesAt: 60_000,
      durationMs: 10_000,
      serverTime: 50_000
    }, 1_000);

    expect(flagBuildRemainingTimeLabel(countdown, 11_000)).toBe("Finalizing\u2026");
    expect(countdown.authoritativeComplete).toBe(false);
  });
});

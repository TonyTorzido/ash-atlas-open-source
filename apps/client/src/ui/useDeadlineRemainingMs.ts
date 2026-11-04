import { useEffect, useState } from "react";

import { aggressiveRemainingMs } from "../combat/aggressive.js";

const COUNTDOWN_TICK_MS = 100;

/**
 * Remaining time to an absolute deadline, re-rendered only the calling component every 100 ms
 * until the deadline passes. Without a deadline the caller's precomputed value is returned and
 * nothing ticks, so the parent never has to re-render for a countdown.
 */
export function useDeadlineRemainingMs(
  deadlineMs: number | undefined,
  fallbackRemainingMs: number
): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (deadlineMs === undefined || deadlineMs <= Date.now()) return;
    const interval = window.setInterval(() => {
      setTick((tick) => tick + 1);
      if (Date.now() >= deadlineMs) window.clearInterval(interval);
    }, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(interval);
  }, [deadlineMs]);
  return deadlineMs === undefined
    ? fallbackRemainingMs
    : aggressiveRemainingMs(deadlineMs, Date.now());
}

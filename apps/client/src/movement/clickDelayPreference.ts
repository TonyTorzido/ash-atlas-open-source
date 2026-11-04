import { useCallback, useState } from "react";

import {
  MAX_WORLD_MAP_CLICK_CONFIRMATION_MS,
  MIN_WORLD_MAP_CLICK_CONFIRMATION_MS,
  setWorldMapClickConfirmationMs,
  WORLD_MAP_CLICK_CONFIRMATION_MS
} from "./worldMapClickArbitrator.js";

/** How long a world click waits for a double-click before opening its menu. It
 * depends on the player's hands and device, so it is stored per device. */
const preferenceKey = "ashAtlas.clickDelayMs.v1";
export const CLICK_DELAY_STEP_MS = 10;

export function readClickDelayMs(): number {
  try {
    const raw = window.localStorage.getItem(preferenceKey);
    const stored = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(stored) &&
      stored >= MIN_WORLD_MAP_CLICK_CONFIRMATION_MS &&
      stored <= MAX_WORLD_MAP_CLICK_CONFIRMATION_MS
      ? stored
      : WORLD_MAP_CLICK_CONFIRMATION_MS;
  } catch { return WORLD_MAP_CLICK_CONFIRMATION_MS; }
}

export function useClickDelayMs(): readonly [number, (ms: number) => void] {
  const [delayMs, setDelayMs] = useState(readClickDelayMs);
  const change = useCallback((next: number): void => {
    try { window.localStorage.setItem(preferenceKey, String(next)); } catch { /* Still applies for this session. */ }
    setWorldMapClickConfirmationMs(next);
    setDelayMs(next);
  }, []);
  return [delayMs, change] as const;
}

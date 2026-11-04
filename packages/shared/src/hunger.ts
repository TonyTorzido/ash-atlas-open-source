/** The ordinary Hunger capacity shared by server persistence and client presentation. */
export const HUNGER_BASE_CAPACITY = 2_000;

export type HungerSnapshot = Readonly<{
  current: number;
  baseCapacity: number;
}>;

/**
 * Normalize a persisted/projection value while preserving future over-cap states.
 * Ordinary player writes should use clampHungerForOrdinaryWrite instead.
 */
export function normalizeHungerCurrent(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : HUNGER_BASE_CAPACITY;
}

export function normalizeHungerBaseCapacity(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(HUNGER_BASE_CAPACITY, Math.trunc(parsed))
    : HUNGER_BASE_CAPACITY;
}

export function hungerSnapshot(
  current?: number | string | null,
  baseCapacity?: number | string | null
): HungerSnapshot {
  return {
    current: normalizeHungerCurrent(current),
    baseCapacity: normalizeHungerBaseCapacity(baseCapacity)
  };
}

/** Keep current ordinary writes inside the current base capacity. */
export function clampHungerForOrdinaryWrite(value: number | string | null | undefined): number {
  return Math.min(HUNGER_BASE_CAPACITY, normalizeHungerCurrent(value));
}

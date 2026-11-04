import { useSyncExternalStore } from "react";

/**
 * Joystick movement, stored per device. An explicit saved choice ("1" or "0") always wins. With nothing
 * stored it defaults ON for touch-primary devices while action combat is effective (the stick, dash and
 * attack buttons are the only way to swing on a phone) and OFF everywhere else.
 */
const preferenceKey = "ashAtlas.joystickMovement.v1";
const listeners = new Set<() => void>();

export type StoredJoystickPreference = boolean | null;

export function readStoredJoystickMovement(): StoredJoystickPreference {
  try {
    const value = window.localStorage.getItem(preferenceKey);
    return value === "1" ? true : value === "0" ? false : null;
  } catch { return null; }
}

/** Touch-primary device: the main pointer is coarse (phones and tablets, not a desktop with a touchscreen). */
export function isTouchPrimaryDevice(): boolean {
  try { return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
}

/** Pure default rule: a stored choice wins, else touch-primary AND action combat effective. */
export function joystickMovementEffective(stored: StoredJoystickPreference, touchPrimary: boolean, actionCombat: boolean): boolean {
  return stored ?? (touchPrimary && actionCombat);
}

let stored: StoredJoystickPreference = typeof window === "undefined" ? null : readStoredJoystickMovement();

export function setJoystickMovementEnabled(enabled: boolean): void {
  try { window.localStorage.setItem(preferenceKey, enabled ? "1" : "0"); } catch { /* Still applies for this session. */ }
  stored = enabled;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Effective joystick visibility; `actionCombat` is the effective action-combat state (WELCOME flag AND preference). */
export function useJoystickMovementEnabled(actionCombat: boolean): readonly [boolean, (enabled: boolean) => void] {
  const storedValue = useSyncExternalStore(subscribe, () => stored, () => null);
  return [joystickMovementEffective(storedValue, isTouchPrimaryDevice(), actionCombat), setJoystickMovementEnabled] as const;
}

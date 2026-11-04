import { useSyncExternalStore } from "react";

/**
 * Action combat play style, per device. Defaults to on, so when the server turns the flag on the
 * owner can still switch back to queued combat in the same runtime. The effective mode is the
 * WELCOME flag AND this preference (see `actionCombatActive`).
 */
const preferenceKey = "ashAtlas.actionCombat.v1";
const listeners = new Set<() => void>();

export function readActionCombatPreference(): boolean {
  try { return window.localStorage.getItem(preferenceKey) !== "0"; } catch { return true; }
}

let current = typeof window === "undefined" ? true : readActionCombatPreference();

export function setActionCombatPreference(enabled: boolean): void {
  try { window.localStorage.setItem(preferenceKey, enabled ? "1" : "0"); } catch { /* Still applies for this session. */ }
  current = enabled;
  for (const listener of listeners) listener();
}

export function getActionCombatPreference(): boolean {
  return current;
}

/** The server flag (WELCOME.actionCombat) AND the device preference. */
export function actionCombatActive(serverFlag: boolean, preference: boolean): boolean {
  return serverFlag && preference;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useActionCombatPreference(): readonly [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, () => current, () => true);
  return [enabled, setActionCombatPreference] as const;
}

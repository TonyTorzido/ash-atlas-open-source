import { useSyncExternalStore } from "react";

/** Shared controller state: whether a pad has been used. The camera never follows the player on its own. */
const aggressiveKey = "ashAtlas.gamepadAggressive.v1";
function readAggressive(): boolean {
  try { return window.localStorage.getItem(aggressiveKey) === "1"; } catch { return false; }
}
/** `rightStickAttacks`: action combat is on, so the right stick aims and attacks instead of panning (the D-pad pans). */
export const gamepadState = { used: false, aggressive: readAggressive(), rightStickAttacks: false };
const listeners = new Set<() => void>();
const emit = (): void => { for (const listener of listeners) listener(); };

export function markGamepadUsed(): void {
  if (gamepadState.used) return;
  gamepadState.used = true;
  emit();
}

/** Aggressive lets the X button attack mobs. Persisted per device. */
export function setGamepadAggressive(aggressive: boolean): void {
  gamepadState.aggressive = aggressive;
  try { window.localStorage.setItem(aggressiveKey, aggressive ? "1" : "0"); } catch { /* Still applies for this session. */ }
  emit();
}

export function useGamepadAggressive(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => gamepadState.aggressive,
    () => false
  );
}

export function useGamepadUsed(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => gamepadState.used,
    () => false
  );
}

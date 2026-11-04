import { useSyncExternalStore } from "react";

/** Floating twin sticks, stored per device. Default ON; an explicit "0" restores the fixed corner sticks. */
const preferenceKey = "ashAtlas.floatingSticks.v1";
const listeners = new Set<() => void>();

export function readStoredFloatingSticks(): boolean {
  try { return window.localStorage.getItem(preferenceKey) !== "0"; } catch { return true; }
}

let current: boolean = typeof window === "undefined" ? true : readStoredFloatingSticks();

export function setFloatingSticksEnabled(enabled: boolean): void {
  try { window.localStorage.setItem(preferenceKey, enabled ? "1" : "0"); } catch { /* Still applies for this session. */ }
  current = enabled;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFloatingSticksEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => current, () => true);
  return [value, setFloatingSticksEnabled] as const;
}

/** "Show stick areas": dotted guides at the edge of each floating region, stored per device. Default ON; an explicit "0" hides them. */
const guidesKey = "ashAtlas.floatingStickGuides.v1";
const guideListeners = new Set<() => void>();

export function readStoredStickGuides(): boolean {
  try { return window.localStorage.getItem(guidesKey) !== "0"; } catch { return true; }
}

let currentGuides: boolean = typeof window === "undefined" ? true : readStoredStickGuides();

export function setStickGuidesEnabled(enabled: boolean): void {
  try { window.localStorage.setItem(guidesKey, enabled ? "1" : "0"); } catch { /* Still applies for this session. */ }
  currentGuides = enabled;
  for (const listener of guideListeners) listener();
}

function subscribeGuides(listener: () => void): () => void {
  guideListeners.add(listener);
  return () => { guideListeners.delete(listener); };
}

export function useStickGuidesEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const value = useSyncExternalStore(subscribeGuides, () => currentGuides, () => true);
  return [value, setStickGuidesEnabled] as const;
}

/**
 * "Flick stick to dash": a quick flick of the movement stick dashes. Per device. Default ON on touch screens
 * (coarse pointer) and OFF elsewhere; an explicit "1" / "0" always wins.
 */
const flickKey = "ashAtlas.flickDash.v1";
const flickListeners = new Set<() => void>();

function flickDefault(): boolean {
  try { return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
}

export function readStoredFlickDash(): boolean {
  try {
    const stored = window.localStorage.getItem(flickKey);
    return stored === null ? flickDefault() : stored === "1";
  } catch { return flickDefault(); }
}

let currentFlick: boolean = typeof window === "undefined" ? false : readStoredFlickDash();

export function setFlickDashEnabled(enabled: boolean): void {
  try { window.localStorage.setItem(flickKey, enabled ? "1" : "0"); } catch { /* Still applies for this session. */ }
  currentFlick = enabled;
  for (const listener of flickListeners) listener();
}

function subscribeFlick(listener: () => void): () => void {
  flickListeners.add(listener);
  return () => { flickListeners.delete(listener); };
}

export function useFlickDashEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const value = useSyncExternalStore(subscribeFlick, () => currentFlick, () => false);
  return [value, setFlickDashEnabled] as const;
}

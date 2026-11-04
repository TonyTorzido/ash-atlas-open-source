import { useCallback, useState } from "react";

/** Desktop interface size. Scales the HUD, chat, quick slots, and windows but never
 * the map; it belongs to the monitor, so it is stored per device, not per player. */
export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.05;
export type UiScale = number;
export const DEFAULT_UI_SCALE: UiScale = 1;

/** Clamps to 50–150% and snaps to the 5% slider step. */
export function normalizeUiScale(value: number): UiScale {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_UI_SCALE;
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value));
  return Number((Math.round(clamped / UI_SCALE_STEP) * UI_SCALE_STEP).toFixed(2));
}
const preferenceKey = "ashAtlas.desktopUiScale.v1";
// The scaled layout never gets smaller than the desktop minimum viewport.
const MIN_LOGICAL_WIDTH = 1100;
const MIN_LOGICAL_HEIGHT = 600;

let chosenScale: UiScale = DEFAULT_UI_SCALE;
let listening = false;

export function readUiScale(): UiScale {
  try {
    const stored = window.localStorage.getItem(preferenceKey);
    return stored === null ? DEFAULT_UI_SCALE : normalizeUiScale(Number(stored));
  } catch { return DEFAULT_UI_SCALE; }
}

/** Scale actually used: the chosen size, reduced only as far as the window requires. */
export function effectiveUiScale(chosen: number, width: number, height: number): number {
  const fit = Math.min(width / MIN_LOGICAL_WIDTH, height / MIN_LOGICAL_HEIGHT);
  return Math.max(Math.min(chosen, 1), Math.min(chosen, fit));
}

/** Width tier of the scaled layout; replaces viewport media queries for the HUD. */
export function desktopWidthTier(logicalWidth: number): "wide" | "medium" | "narrow" {
  return logicalWidth > 1360 ? "wide" : logicalWidth > 1180 ? "medium" : "narrow";
}

function sync(): void {
  const root = document.documentElement;
  const scale = effectiveUiScale(chosenScale, window.innerWidth, window.innerHeight);
  const next = String(Math.round(scale * 1000) / 1000);
  if (root.dataset.uiScale !== next) {
    root.dataset.uiScale = next;
    root.style.setProperty("--ui-scale", next);
  }
  const tier = desktopWidthTier(window.innerWidth / scale);
  if (root.dataset.desktopWidth !== tier) root.dataset.desktopWidth = tier;
}

/** CSS applies the scale only in desktop presentation (desktopPresentation.css). */
export function applyUiScale(scale: UiScale): void {
  chosenScale = normalizeUiScale(scale);
  sync();
  if (!listening) {
    listening = true;
    window.addEventListener("resize", sync);
  }
}

/** The factor desktop geometry must divide pointer and viewport pixels by. */
export function activeUiScale(): number {
  const root = document.documentElement;
  if (root.dataset.presentation !== "desktop") return 1;
  const scale = Number(root.dataset.uiScale);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function useUiScale(): readonly [UiScale, (scale: UiScale) => void] {
  const [scale, setScale] = useState<UiScale>(readUiScale);
  const change = useCallback((requested: UiScale): void => {
    const next = normalizeUiScale(requested);
    try { window.localStorage.setItem(preferenceKey, String(next)); } catch { /* Still applies for this session. */ }
    applyUiScale(next);
    setScale(next);
  }, []);
  return [scale, change] as const;
}

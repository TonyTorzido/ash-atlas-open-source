import { clampWindowBounds, type WindowArea, type WindowBounds } from "./desktopWindowBounds.js";

/** Matches --desktop-edge / the unit frame's bottom in desktopPresentation.css. */
export const DESKTOP_WINDOW_EDGE = 16;
const RIGHT_TOP = 72;   // just below the top-centre chat plaque
const LEFT_TOP = 170;   // just below the top-left unit frame
const STORAGE_PREFIX = "ash-atlas:desktop-window:v1";
export const DESKTOP_WINDOW_RESET_EVENT = "ash-atlas:desktop-window-reset";

export type DesktopWindowSide = "left" | "right" | "prompt";

/** Chat and Messages dock right; every other app opens on the left. */
export function desktopWindowSide(windowKey: string, compact: boolean): DesktopWindowSide {
  if (compact) return "prompt";
  return windowKey.startsWith("chat:") ? "right" : "left";
}

/** Default rect in window CSS pixels, aligned to the HUD edge margins. */
export function defaultDesktopWindowBounds(windowKey: string, area: WindowArea, compact: boolean, promptHeight: number): WindowBounds {
  const side = desktopWindowSide(windowKey, compact);
  if (side === "prompt") {
    return { x: (area.width - 352) / 2, y: Math.max(16, area.height - promptHeight - 24), width: 352, height: promptHeight };
  }
  const edge = DESKTOP_WINDOW_EDGE;
  const bottom = area.height - edge;
  if (side === "right") {
    const width = Math.min(windowKey === "chat:direct" ? 640 : 540, area.width - 2 * edge);
    return { x: area.width - edge - width, y: RIGHT_TOP, width, height: Math.min(720, Math.max(360, bottom - RIGHT_TOP)) };
  }
  if (windowKey === "app:market-app") {
    // The Market is a two-pane trading desk (items beside the trade form): open it wide and centred.
    const width = Math.min(1180, area.width - 2 * edge);
    return { x: (area.width - width) / 2, y: RIGHT_TOP, width, height: Math.min(860, Math.max(360, bottom - RIGHT_TOP)) };
  }
  if (windowKey === "app:phone-build-layer") {
    // Construction opens docked top-right, right under the chat plaque, so the long plan list gets full height.
    const width = Math.min(620, area.width - 2 * edge);
    return { x: area.width - edge - width, y: RIGHT_TOP, width, height: Math.min(860, Math.max(360, bottom - RIGHT_TOP)) };
  }
  const width = Math.min(760, Math.max(420, area.width - 3 * edge - 540));
  return { x: edge, y: LEFT_TOP, width, height: Math.min(720, Math.max(360, bottom - LEFT_TOP)) };
}

let storagePlayer: string | null = null;
/** The character whose window layout is saved; set by the desktop HUD. */
export function setDesktopWindowPlayer(playerId: string | null | undefined): void { storagePlayer = playerId || null; }

const storageKey = (windowKey: string): string | null => storagePlayer ? `${STORAGE_PREFIX}:${storagePlayer}:desktop:${windowKey}` : null;

export function readSavedWindowBounds(windowKey: string): WindowBounds | null {
  const key = storageKey(windowKey);
  if (!key) return null;
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null") as Partial<WindowBounds> | null;
    if (!value || ![value.x, value.y, value.width, value.height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return value as WindowBounds;
  } catch { return null; }
}

export function saveWindowBounds(windowKey: string, bounds: WindowBounds): void {
  const key = storageKey(windowKey);
  if (!key) return;
  try { globalThis.localStorage?.setItem(key, JSON.stringify(bounds)); } catch { /* Placement still lasts this session. */ }
}

/** Clamp a saved rect to the current viewport (the screen may have shrunk). */
export function restoreWindowBounds(saved: WindowBounds, area: WindowArea, minimum: { width: number; height: number }): WindowBounds {
  return clampWindowBounds(saved, area, minimum);
}

/** Clears this character's saved rects and tells open windows to snap back. */
export function resetDesktopWindowLayout(): number {
  let cleared = 0;
  try {
    const prefix = storagePlayer ? `${STORAGE_PREFIX}:${storagePlayer}:desktop:` : null;
    const storage = globalThis.localStorage;
    if (prefix && storage) {
      for (const key of Object.keys(storage)) if (key.startsWith(prefix)) { storage.removeItem(key); cleared += 1; }
    }
  } catch { /* Nothing saved is readable anyway. */ }
  globalThis.dispatchEvent?.(new Event(DESKTOP_WINDOW_RESET_EVENT));
  return cleared;
}

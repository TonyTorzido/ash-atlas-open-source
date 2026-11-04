/**
 * Runtime A/B switches for the follow camera (docs/plans/map-shake.md). There is no server-pushed client config, so these
 * live in localStorage and are set from Developer tools; they apply at once (no restart, no deploy).
 *
 * - driver "overlay" (default): the follow runs inside the Pixi overlay frame and that frame owns the MapLibre render.
 *   "standalone": the pre-t1535 loop, the follow on its own requestAnimationFrame and MapLibre rendering on its own frame.
 * - filter "on" (default): the camera follows a low-pass, prediction-stable player target (cameraTargetFilter.ts).
 *   "off": the camera follows the raw rendered player point, as t1535 did.
 */
export type CameraDriverMode = "overlay" | "standalone";
export type CameraFilterMode = "on" | "off";

const DRIVER_KEY = "ash-atlas:camera-driver";
const FILTER_KEY = "ash-atlas:camera-filter";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the switch holds for this session only.
  }
}

let driver: CameraDriverMode = read(DRIVER_KEY) === "standalone" ? "standalone" : "overlay";
let filter: CameraFilterMode = read(FILTER_KEY) === "off" ? "off" : "on";
const listeners = new Set<() => void>();

export function cameraDriverMode(): CameraDriverMode { return driver; }
export function cameraFilterMode(): CameraFilterMode { return filter; }

export function setCameraDriverMode(mode: CameraDriverMode): void {
  driver = mode;
  write(DRIVER_KEY, mode === "overlay" ? null : mode);
  for (const listener of listeners) listener();
}

export function setCameraFilterMode(mode: CameraFilterMode): void {
  filter = mode;
  write(FILTER_KEY, mode === "on" ? null : mode);
  for (const listener of listeners) listener();
}

export function subscribeCameraDriverMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") {
  // Test and support hook: the full-app specs and a support session can flip the modes without the panel.
  (window as unknown as { __ASH_ATLAS_CAMERA_MODES__?: unknown }).__ASH_ATLAS_CAMERA_MODES__ = {
    get driver() { return driver; },
    set driver(mode: CameraDriverMode) { setCameraDriverMode(mode === "standalone" ? "standalone" : "overlay"); },
    get filter() { return filter; },
    set filter(mode: CameraFilterMode) { setCameraFilterMode(mode === "off" ? "off" : "on"); }
  };
}

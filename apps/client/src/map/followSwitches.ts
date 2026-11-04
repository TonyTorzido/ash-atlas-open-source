/**
 * Runtime A/B switches for the follow camera's overlay work (docs/plans/raster-smooth.md). Like cameraDriverMode.ts they live in
 * localStorage, are set from Developer tools, and apply at once (no restart, no deploy).
 *
 * - static-follow "freeze" (default): while the camera follows, the drawn static overlay geometry is translated, not rebuilt every
 *   frame (refreshed about every 250 ms or after 64 px of drift). "off": the old per-frame rebuild.
 * - camera-snap "device": the follow pan is quantized to whole device pixels with a carried residual. "off" (default).
 * - overlay-walk "hidden": diagnostic only. While the camera follows, the Pixi overlay draws and renders nothing and its canvas is hidden.
 */
export type StaticFollowMode = "freeze" | "off";
export type CameraSnapMode = "device" | "off";
export type OverlayWalkMode = "hidden" | "off";

const STATIC_KEY = "ash-atlas:static-follow";
const SNAP_KEY = "ash-atlas:camera-snap";
const WALK_KEY = "ash-atlas:overlay-walk";

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* storage unavailable: the switch holds for this session only */ }
}

const has = typeof window !== "undefined";
let staticFollow: StaticFollowMode = has && read(STATIC_KEY) === "off" ? "off" : "freeze";
let cameraSnap: CameraSnapMode = has && read(SNAP_KEY) === "device" ? "device" : "off";
let overlayWalk: OverlayWalkMode = has && read(WALK_KEY) === "hidden" ? "hidden" : "off";

export function staticFollowMode(): StaticFollowMode { return staticFollow; }
export function cameraSnapMode(): CameraSnapMode { return cameraSnap; }
export function overlayWalkMode(): OverlayWalkMode { return overlayWalk; }
export function setStaticFollowMode(mode: StaticFollowMode): void { staticFollow = mode; write(STATIC_KEY, mode === "freeze" ? null : mode); }
export function setCameraSnapMode(mode: CameraSnapMode): void { cameraSnap = mode; write(SNAP_KEY, mode === "off" ? null : mode); }
export function setOverlayWalkMode(mode: OverlayWalkMode): void { overlayWalk = mode; write(WALK_KEY, mode === "off" ? null : mode); }

/** Quantizes a pan to whole device pixels, carrying the remainder to the next frame. Pure: returns the pan to apply and the new carry. */
export function quantizePanToDevicePixels(
  pan: { x: number; y: number },
  carry: { x: number; y: number },
  dpr: number
): { pan: { x: number; y: number }; carry: { x: number; y: number } } {
  const scale = dpr > 0 ? dpr : 1;
  const axis = (value: number, c: number): { v: number; c: number } => {
    const total = value + c;
    const v = Math.round(total * scale) / scale;
    return { v, c: total - v };
  };
  const x = axis(pan.x, carry.x);
  const y = axis(pan.y, carry.y);
  return { pan: { x: x.v, y: y.v }, carry: { x: x.c, y: y.c } };
}

/** Telemetry: the value of every switch, for the motion report. */
export function followSwitchReport(): Record<string, string> {
  return { staticFollow, cameraSnap, overlayWalk };
}

if (has) {
  (window as unknown as { __ASH_ATLAS_FOLLOW_SWITCHES__?: unknown }).__ASH_ATLAS_FOLLOW_SWITCHES__ = {
    get staticFollow() { return staticFollow; },
    set staticFollow(mode: StaticFollowMode) { setStaticFollowMode(mode === "off" ? "off" : "freeze"); },
    get cameraSnap() { return cameraSnap; },
    set cameraSnap(mode: CameraSnapMode) { setCameraSnapMode(mode === "device" ? "device" : "off"); },
    get overlayWalk() { return overlayWalk; },
    set overlayWalk(mode: OverlayWalkMode) { setOverlayWalkMode(mode === "hidden" ? "hidden" : "off"); }
  };
}

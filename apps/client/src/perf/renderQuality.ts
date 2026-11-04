import { isReducedRenderQualityEnabled } from "./renderQualityFlag.js";

// Render-quality knobs. Graphics quality is High by default: every canvas renders at the full device pixel ratio, so a
// 3x iPhone gets a 3x backbuffer for the map and the overlay. "Low" (Developer Tools, or the low-FPS governor on devices
// that cannot hold the frame rate) caps the backbuffers at 2x and drops overlay MSAA on phone-class devices.
// The setting is read when a renderer is created, so changing it needs an app restart.

const dpr = (): number => globalThis.devicePixelRatio || 1;

/** Raster density for Pixi Text and Graphics-to-texture work: never below 2x, up to 3x. */
export function overlayTextResolution(): number {
  return Math.min(3, Math.max(2, dpr()));
}

/** Backbuffer density of the Pixi overlay renderer. */
export function overlayRendererResolution(): number {
  return isReducedRenderQualityEnabled() ? Math.min(2, dpr()) : Math.min(3, Math.max(2, dpr()));
}

/** Density for the small standalone Pixi canvases (indoor/salon player layers, map player marker). */
export function playerLayerResolution(): number {
  return isReducedRenderQualityEnabled() ? Math.min(2, dpr()) : Math.max(2, dpr());
}

/** Phone/tablet class devices: the primary pointer is coarse (touch). Desktop browsers keep full quality. */
export function isPhoneRenderProfile(): boolean {
  try {
    if (typeof window.matchMedia === "function") return window.matchMedia("(pointer: coarse)").matches;
    return (navigator.maxTouchPoints ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Overlay MSAA stays on unless Low quality is chosen on a phone-class device. */
export function overlayAntialias(): boolean {
  return !isReducedRenderQualityEnabled() || !isPhoneRenderProfile();
}

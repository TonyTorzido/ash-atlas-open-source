const LEGACY_RENDER_QUALITY_KEY = "ash-atlas:legacy-render-quality";

/**
 * Developer A/B switch: when on, the overlay renders every frame (no idle-frame skipping). Default off. Pixel density is the separate Graphics quality setting below.
 * Read once at startup by renderer code, so changing it needs an app restart to fully apply.
 */
export function isLegacyRenderQualityEnabled(): boolean {
  try {
    return window.localStorage.getItem(LEGACY_RENDER_QUALITY_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLegacyRenderQualityEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(LEGACY_RENDER_QUALITY_KEY, "1");
    else window.localStorage.removeItem(LEGACY_RENDER_QUALITY_KEY);
  } catch {
    // Storage unavailable; the flag stays off.
  }
}

const REDUCED_RENDER_QUALITY_KEY = "ash-atlas:render-quality";

/**
 * Graphics quality: high (default) renders every canvas at the full device pixel ratio. "low" caps the backbuffers at 2x
 * and drops overlay MSAA on phone-class devices. Read once when a renderer is created, so a change needs an app restart.
 * Set from Developer Tools, or by the low-FPS governor on devices that cannot hold the frame rate (never on Apple devices).
 */
export function isReducedRenderQualityEnabled(): boolean {
  try {
    return window.localStorage.getItem(REDUCED_RENDER_QUALITY_KEY) === "low";
  } catch {
    return false;
  }
}

export function setReducedRenderQualityEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(REDUCED_RENDER_QUALITY_KEY, "low");
    else window.localStorage.removeItem(REDUCED_RENDER_QUALITY_KEY);
  } catch {
    // Storage unavailable; quality stays high.
  }
}

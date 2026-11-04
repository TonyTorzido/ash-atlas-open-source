import { isReducedRenderQualityEnabled, setReducedRenderQualityEnabled } from "./renderQualityFlag.js";

/**
 * Adaptive fallback for Graphics quality (docs/plans/crisp-smooth.md). Quality is High by default. On a device that
 * cannot hold the frame rate for a sustained stretch, the governor stores the Low setting; it applies at the next app start
 * (renderers read it when they are created, so there is no mid-session resolution change to flicker). Apple devices are
 * never lowered: a modern iPhone keeps full density.
 */
export const GOVERNOR_WINDOW_MS = 10_000;
export const GOVERNOR_WINDOWS_TO_LOWER = 2;
export const GOVERNOR_SLOW_FRAME_MS = 36;
/** Frames longer than this are a tab switch, a load or a pause, not rendering cost. */
export const GOVERNOR_IGNORE_FRAME_MS = 250;

export function isAppleDevice(nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

/** True when this many consecutive windows all averaged slower than the slow-frame threshold. */
export function sustainedSlow(windowMeansMs: readonly number[]): boolean {
  if (windowMeansMs.length < GOVERNOR_WINDOWS_TO_LOWER) return false;
  return windowMeansMs.slice(-GOVERNOR_WINDOWS_TO_LOWER).every((mean) => mean >= GOVERNOR_SLOW_FRAME_MS);
}

export function startRenderQualityGovernor(
  nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> = navigator,
  raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id)
): () => void {
  if (isAppleDevice(nav) || isReducedRenderQualityEnabled()) return () => undefined;
  const means: number[] = [];
  let id = 0;
  let last = 0;
  let windowStart = 0;
  let sum = 0;
  let count = 0;
  let stopped = false;
  const tick = (timestamp: number): void => {
    if (stopped) return;
    if (windowStart === 0) windowStart = timestamp;
    if (last > 0) {
      const dt = timestamp - last;
      if (dt < GOVERNOR_IGNORE_FRAME_MS) {
        sum += dt;
        count += 1;
      }
    }
    last = timestamp;
    if (timestamp - windowStart >= GOVERNOR_WINDOW_MS) {
      if (count > 0) means.push(sum / count);
      windowStart = timestamp;
      sum = 0;
      count = 0;
      if (sustainedSlow(means)) {
        setReducedRenderQualityEnabled(true);
        stopped = true;
        return;
      }
    }
    id = raf(tick);
  };
  id = raf(tick);
  return () => {
    stopped = true;
    cancel(id);
  };
}

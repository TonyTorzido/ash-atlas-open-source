import { perfMetrics } from "./perfMetrics.js";
import { isLegacyRenderQualityEnabled } from "./renderQualityFlag.js";
import { startPerfUpload, stopPerfUpload } from "./perfUpload.js";

const PROBE_STORAGE_KEY = "ash-atlas:perf-probe";
const PROBE_INTERVAL_MS = 500;

type Drawable = Record<string, unknown>;

/**
 * `?perf=1` enables and persists the probe, `?perf=0` disables it. The Developer Tools switch writes the
 * same key. Storage may be unavailable, in which case the URL parameter still works for this page load.
 */
export function isPerfProbeEnabled(): boolean {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(window.location.search).get("perf");
  } catch {
    // Ignore malformed or unavailable location.
  }
  try {
    if (fromUrl === "1") window.localStorage.setItem(PROBE_STORAGE_KEY, "1");
    else if (fromUrl === "0") window.localStorage.removeItem(PROBE_STORAGE_KEY);
    else return window.localStorage.getItem(PROBE_STORAGE_KEY) === "1";
  } catch {
    return fromUrl === "1";
  }
  return fromUrl === "1";
}

let drawCallCounterInstalled = false;

/** Counts every WebGL draw call (maplibre and Pixi share the page). Installed once, only when the probe is on. */
function installDrawCallCounter(): void {
  if (drawCallCounterInstalled) return;
  drawCallCounterInstalled = true;
  const names = ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"];
  const prototypes: Drawable[] = [];
  if (typeof WebGLRenderingContext !== "undefined") prototypes.push(WebGLRenderingContext.prototype as unknown as Drawable);
  if (typeof WebGL2RenderingContext !== "undefined") prototypes.push(WebGL2RenderingContext.prototype as unknown as Drawable);
  for (const prototype of prototypes) {
    for (const name of names) {
      const original = prototype[name];
      if (typeof original !== "function") continue;
      // Fixed-arity wrappers: a rest-args wrapper allocates an arguments array on every draw call.
      const draw = original as (this: unknown, a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown) => unknown;
      prototype[name] = function (this: unknown, a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown) {
        perfMetrics.noteDrawCall((this as { canvas?: object } | null)?.canvas);
        return draw.call(this, a, b, c, d, e);
      };
    }
  }
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

/** Persists the probe switch (Developer Tools) and starts or stops the overlay immediately. */
export function setPerfProbeEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(PROBE_STORAGE_KEY, "1");
    else window.localStorage.removeItem(PROBE_STORAGE_KEY);
  } catch {
    // Storage unavailable: the switch still works until the app restarts.
  }
  if (enabled) showProbe();
  else hideProbe();
}

export function isPerfProbeVisible(): boolean {
  return probe !== null;
}

type ProbeHandle = { element: HTMLDivElement; timer: number | null };
let probe: ProbeHandle | null = null;

export function startPerfProbe(): void {
  if (typeof document === "undefined" || !isPerfProbeEnabled()) return;
  showProbe();
}

function hideProbe(): void {
  stopPerfUpload();
  if (!probe) return;
  if (probe.timer !== null) window.clearTimeout(probe.timer);
  probe.element.remove();
  probe = null;
}

function showProbe(): void {
  if (typeof document === "undefined" || probe) return;
  installDrawCallCounter();
  startPerfUpload();
  const element = document.createElement("div");
  element.setAttribute("aria-hidden", "true");
  element.className = "perf-probe";
  Object.assign(element.style, {
    position: "fixed",
    left: "calc(env(safe-area-inset-left, 0px) + 4px)",
    bottom: "calc(env(safe-area-inset-bottom, 0px) + 4px)",
    zIndex: "2147483647",
    pointerEvents: "none",
    overflow: "hidden",
    maxWidth: "calc(100vw - 8px)",
    padding: "2px 5px",
    borderRadius: "4px",
    background: "rgba(0, 0, 0, 0.72)",
    color: "#9ff0a8",
    font: "9px/1.25 ui-monospace, Menlo, Consolas, monospace",
    whiteSpace: "pre"
  });
  document.body.appendChild(element);
  const handle: ProbeHandle = { element, timer: null };
  probe = handle;

  let expectedAt = performance.now() + PROBE_INTERVAL_MS;
  const tick = (): void => {
    if (probe !== handle) return;
    const now = performance.now();
    perfMetrics.setEventLoopLagMs(Math.max(0, now - expectedAt));
    const frames = perfMetrics.getFrameTimeHistogram("probe");
    const snapshot = perfMetrics.getSnapshot("probe");
    const overlay = perfMetrics.takeOverlayWindow("probe");
    const heap = snapshot.jsHeapBytes === null ? "n/a" : `${formatMegabytes(snapshot.jsHeapBytes)}M`;
    const overlayRes = snapshot.overlayResolution === null ? "-" : snapshot.overlayResolution.toFixed(2);
    element.textContent =
      `fps ${snapshot.fps.toFixed(0)} p50 ${frames.p50Ms.toFixed(0)} p95 ${frames.p95Ms.toFixed(0)} ` +
      `p99 ${frames.p99Ms.toFixed(0)} long ${frames.over50Ms}
` +
      `draw ${snapshot.drawCallsPerFrame.toFixed(0)}/f tex ${snapshot.textureCount} ` +
      `${formatMegabytes(snapshot.textureBytes)}M heap ${heap}
` +
      `dyn ${overlay.dynamicOverlayUpdateMsPerFrame.toFixed(1)}/f ` +
      `pixi ${overlay.pixiRenderCallMsPerFrame.toFixed(1)}/f rend/f ${overlay.pixiRenderCallsPerFrame.toFixed(2)} ` +
      `static ${overlay.staticOverlayRedraws} max ${overlay.maxStaticOverlayDrawMs.toFixed(0)}ms ` +
      `map ${overlay.drawMapPerFrame.toFixed(0)}/f pixi ${overlay.drawPixiPerFrame.toFixed(0)}/f
` +
      `obj ${snapshot.retainedDisplayObjectCount} mobs ${snapshot.combatEntityCount} ` +
      `app ${snapshot.gameAppRendersPerSec.toFixed(1)}/s lag ${snapshot.eventLoopLagMs.toFixed(0)}ms
` +
      `ws ${snapshot.totalWsMessagesPerSec.toFixed(0)}/s ${(snapshot.wsBytesPerSec / 1024).toFixed(1)}K/s ` +
      `dpr ${snapshot.devicePixelRatio.toFixed(2)} ovl ${overlayRes} ` +
      `legacy ${isLegacyRenderQualityEnabled() ? "on" : "off"}`;
    expectedAt = performance.now() + PROBE_INTERVAL_MS;
    handle.timer = window.setTimeout(tick, PROBE_INTERVAL_MS);
  };
  handle.timer = window.setTimeout(tick, PROBE_INTERVAL_MS);
}

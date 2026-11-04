import { perfMetrics } from "./perfMetrics.js";
import { isLegacyRenderQualityEnabled } from "./renderQualityFlag.js";

const UPLOAD_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 120_000;
const SAMPLE_KEY = "upload";
const SAMPLE_PATH = "/api/diagnostics/perf-sample";

let serverHttpBase = "";
let csrfToken = "";
let timer: number | null = null;
let consecutiveFailures = 0;
let longTaskObserver: PerformanceObserver | null = null;
let longTaskCount = 0;
let longTaskMaxMs = 0;
let hiddenAtMs: number | null = null;
let pendingHiddenMs = 0;
let lifecycleListening = false;

/** Drops the partly-paused window so the first sample after a resume covers real, awake time only. */
function resetSampleWindow(): void {
  perfMetrics.resetRateSample(SAMPLE_KEY);
  perfMetrics.takeOverlayWindow(SAMPLE_KEY);
  perfMetrics.getFrameTimeHistogram(SAMPLE_KEY);
  longTaskCount = 0;
  longTaskMaxMs = 0;
}

function handleVisibilityChange(): void {
  if (document.hidden) {
    hiddenAtMs ??= Date.now();
    return;
  }
  if (hiddenAtMs !== null) pendingHiddenMs += Date.now() - hiddenAtMs;
  hiddenAtMs = null;
  resetSampleWindow();
}

function handlePageShow(): void {
  resetSampleWindow();
}

export function configurePerfUpload(base: string, csrf: string): void {
  serverHttpBase = base;
  csrfToken = csrf;
  // New session credentials: forget earlier failures and try again on the normal cadence.
  if (consecutiveFailures > 0) {
    consecutiveFailures = 0;
    if (timer !== null) scheduleNext();
  }
}

function nextDelayMs(): number {
  if (consecutiveFailures === 0) return UPLOAD_INTERVAL_MS;
  return Math.min(MAX_BACKOFF_MS, UPLOAD_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 6));
}

function scheduleNext(): void {
  if (typeof window === "undefined") return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    void upload().finally(() => {
      if (timer !== null) scheduleNext();
    });
  }, nextDelayMs());
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** One compact sample covering the window since the previous upload. Exported for tests. */
export function buildPerfSample(): Record<string, unknown> {
  const snapshot = perfMetrics.getSnapshot(SAMPLE_KEY);
  const frames = perfMetrics.getFrameTimeHistogram(SAMPLE_KEY);
  const network = perfMetrics.takeNetworkStats();
  const swingStats = perfMetrics.takeSwingStats();
  const overlay = perfMetrics.takeOverlayWindow(SAMPLE_KEY);
  const tags = perfMetrics.getContextTags();
  const activeSeconds = overlay.activeMs / 1_000;
  const hiddenMs = pendingHiddenMs;
  pendingHiddenMs = 0;
  const reasons = overlay.renderReasons.map(([reason, count]) => `${reason}:${count}`).join(",").slice(0, 200);
  const sample = {
    clientAtMs: Date.now(),
    fps: round(snapshot.fps),
    windowMs: Math.round(snapshot.sampleWindowMs),
    activeMs: Math.round(overlay.activeMs),
    hiddenMs: Math.round(hiddenMs),
    frames: overlay.frames,
    fpsActive: activeSeconds > 0 ? round(overlay.frames / activeSeconds) : 0,
    drawMapPerFrame: round(overlay.drawMapPerFrame),
    drawPixiPerFrame: round(overlay.drawPixiPerFrame),
    zoomMs: Math.round(overlay.zoomMs),
    moveMs: Math.round(overlay.moveMs),
    travelMs: Math.round(overlay.travelMs),
    worldMapOpen: tags.worldMapOpen,
    locationMode: tags.locationMode.slice(0, 32),
    renderReasons: reasons,
    frameP50Ms: round(frames.p50Ms),
    frameP95Ms: round(frames.p95Ms),
    frameP99Ms: round(frames.p99Ms),
    framesOver50Ms: frames.over50Ms,
    drawCallsPerFrame: round(snapshot.drawCallsPerFrame),
    textureCount: snapshot.textureCount,
    textureMb: round(snapshot.textureBytes / (1024 * 1024)),
    jsHeapMb: snapshot.jsHeapBytes === null ? null : round(snapshot.jsHeapBytes / (1024 * 1024)),
    retainedDisplayObjects: snapshot.retainedDisplayObjectCount,
    combatEntities: snapshot.combatEntityCount,
    gameAppRendersPerSec: round(snapshot.gameAppRendersPerSec),
    eventLoopLagMs: round(snapshot.eventLoopLagMs),
    wsMsgsPerSec: round(snapshot.totalWsMessagesPerSec),
    wsKbPerSec: round(snapshot.wsBytesPerSec / 1024),
    dpr: round(snapshot.devicePixelRatio, 2),
    overlayResolution: snapshot.overlayResolution === null ? null : round(snapshot.overlayResolution, 2),
    legacyRenderQuality: isLegacyRenderQualityEnabled(),
    rttMs: network.rttMs === null ? null : round(network.rttMs),
    playerDeltaGapP95Ms: network.playerDeltaGapP95Ms === null ? null : round(network.playerDeltaGapP95Ms),
    combatDeltaGapP95Ms: network.combatDeltaGapP95Ms === null ? null : round(network.combatDeltaGapP95Ms),
    swings: swingStats.swings,
    swingPredictedHits: swingStats.swingPredictedHits,
    swingCancelledHits: swingStats.swingCancelledHits,
    swingDrawCalls: swingStats.swingDrawCalls,
    swingPressToResultP95Ms: swingStats.swingPressToResultP95Ms === null ? null : round(swingStats.swingPressToResultP95Ms),
    keyIgnored: perfMetrics.takeKeyIgnored(),
    frameMaxMs: round(frames.maxMs),
    dynOverlayMsPerFrame: round(overlay.dynamicOverlayUpdateMsPerFrame, 2),
    pixiRenderMsPerFrame: round(overlay.pixiRenderCallMsPerFrame, 2),
    rendersPerFrame: round(overlay.pixiRenderCallsPerFrame, 2),
    staticRedraws: overlay.staticOverlayRedraws,
    staticLiveRedraws: overlay.liveStaticOverlayRedraws,
    staticDrawMaxMs: round(overlay.maxStaticOverlayDrawMs),
    gameAppRenders: overlay.gameAppRenders,
    longTasks: longTaskObserver ? longTaskCount : null,
    longTaskMaxMs: longTaskObserver ? round(longTaskMaxMs) : null,
    userAgent: (typeof navigator === "undefined" ? "" : navigator.userAgent).slice(0, 240),
    build: String(import.meta.env.VITE_GAME_BUILD_SHA ?? "development").slice(0, 64)
  };
  longTaskCount = 0;
  longTaskMaxMs = 0;
  return sample;
}

async function upload(): Promise<void> {
  if (typeof document !== "undefined" && document.hidden) return;
  const sample = buildPerfSample();
  if (!serverHttpBase) return;
  try {
    const response = await fetch(new URL(SAMPLE_PATH, serverHttpBase), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify(sample)
    });
    // Not a developer account, signed out, rate limited or rejected: back off rather than stopping for good.
    consecutiveFailures = response.status >= 200 && response.status < 300 ? 0 : consecutiveFailures + 1;
  } catch {
    // Offline or server restarting: drop this sample and back off.
    consecutiveFailures += 1;
  }
}

/** Starts the ~10 s upload loop. Call only while the probe is enabled. */
export function startPerfUpload(): void {
  if (timer !== null || typeof window === "undefined") return;
  try {
    if (typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          longTaskMaxMs = Math.max(longTaskMaxMs, entry.duration);
        }
      });
      longTaskObserver.observe({ entryTypes: ["longtask"] });
    }
  } catch {
    longTaskObserver = null;
  }
  perfMetrics.resetRateSample(SAMPLE_KEY);
  consecutiveFailures = 0;
  perfMetrics.takeOverlayWindow(SAMPLE_KEY);
  if (!lifecycleListening && typeof document !== "undefined") {
    lifecycleListening = true;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
  }
  scheduleNext();
}

export function stopPerfUpload(): void {
  if (timer !== null && typeof window !== "undefined") window.clearTimeout(timer);
  timer = null;
  consecutiveFailures = 0;
  if (lifecycleListening) {
    lifecycleListening = false;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pageshow", handlePageShow);
  }
  hiddenAtMs = null;
  pendingHiddenMs = 0;
  longTaskObserver?.disconnect();
  longTaskObserver = null;
  longTaskCount = 0;
  longTaskMaxMs = 0;
}

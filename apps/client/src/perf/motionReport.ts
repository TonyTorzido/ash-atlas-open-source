/**
 * On-device motion telemetry (docs/plans/map-shake.md). The owner never sends numbers: after the player has walked for 3 s the
 * client samples about 5 s of display frames once per session, and again (at most 3 reports per session in all) when the follow
 * camera shows jitter, then posts one flat summary that the server logs as "client motion report".
 *
 * Per frame (own requestAnimationFrame while sampling) it reads the MapLibre and Pixi renders noted through the frame probe
 * tap, the camera (screen point of a fixed world anchor), the local player's sprite point, and the prediction counters the
 * render timeline reports (corrections, lead-cap frames, reads behind the prediction clock). Nothing runs per frame outside a
 * sample window except a few comparisons in noteFollowFrame.
 */
import { sendMotionReport } from "../audio/audioReport.js";
import { clientConfig } from "../config.js";
import { setFrameProbeTap } from "./frameProbe.js";

import { followSwitchReport } from "../map/followSwitches.js";
import { perfMetrics } from "./perfMetrics.js";
import { rasterAlignmentReport, resetRasterAlignmentStats } from "../map/rasterAlignment.js";

type ReportValue = string | number | boolean | null;
type Pt = { x: number; y: number };

export type MotionReportMap = {
  project(lngLat: [number, number]): { x: number; y: number };
  getCenter(): { lng: number; lat: number };
  getCanvas(): HTMLCanvasElement;
  getMinZoom?(): number;
  getMaxZoom?(): number;
};

type MotionContext = { getMap(): MotionReportMap | null; context(): Record<string, ReportValue> };

const WALK_BEFORE_SAMPLE_MS = 3_000;
const SAMPLE_MS = 5_000;
const MAX_REPORTS = 3;
const JITTER_REPORT_GAP_MS = 30_000;
/** Steps smaller than this (CSS px) carry no direction. */
const DIRECTION_EPS_PX = 0.05;

let ctx: MotionContext | null = null;
let reportsSent = 0;
let lastReportEndMs = -Infinity;
let walkingSinceMs: number | null = null;
let lastWalkingMs = 0;
let walkingNow = false;
// Jitter detector (outside a sample): follow pan direction flips and long frames in a rolling window.
let detAxis: Pt | null = null;
let detLastSign = 0;
const detFlipTimes: number[] = [];
const detLongFrameTimes: number[] = [];
let detLastFrameMs = 0;
let jitterRequested = false;

// Prediction counters (reset when a sample starts).
const counters = {
  corrections: 0, correctionMaxM: 0, correctionSumM: 0, snaps: 0, clockBehind: 0, clockBehindMaxMs: 0,
  // Lead limit (docs/plans/move-smooth.md): unique display frames with a soft pull or a hard clamp, and the pull total.
  leadCapFrames: 0, leadHardClampFrames: 0, leadNudgeSumM: 0,
  // Authority: the largest jump of a sample from where the previous one dead-reckons, and the server's measured speed.
  authorityJumpMaxM: 0, authorityDistanceM: 0, authorityServerMs: 0, authorityPredictedM: 0
};
let lastLeadFrameMs = Number.NaN;
let lastHardClampFrameMs = Number.NaN;
// Latest prediction state (not reset): smoothed RTT, lead budget, effective and base walking speed.
const prediction = { rttMs: null as number | null, maxLeadMs: null as number | null, speedMps: null as number | null, baseSpeedMps: null as number | null };

type Frame = {
  t: number;
  m: number;
  o: number;
  anchor: Pt | null;
  sprite: Pt | null;
  mismatch: number | null;
  walking: boolean;
};

type Sample = {
  kind: "session" | "jitter";
  startMs: number;
  anchorLngLat: [number, number];
  frames: Frame[];
  pendingM: number;
  pendingO: number;
  lastO: { anchor: Pt; sprite: Pt | null } | null;
  lastMAnchor: Pt | null;
  lastMismatch: number | null;
  raf: number;
  longTasks: number;
  observer: PerformanceObserver | null;
  counters: typeof counters;
};
let sample: Sample | null = null;

export function configureMotionReport(next: MotionContext | null): void {
  ctx = next;
  if (!next) stopSample(false);
}

/** Render timeline hooks (movement/playerRenderSmoothing.ts). */
export function noteMotionCorrection(distanceM: number): void {
  counters.corrections += 1;
  counters.correctionSumM += distanceM;
  if (distanceM > counters.correctionMaxM) counters.correctionMaxM = distanceM;
}
export function noteMotionSnap(): void { counters.snaps += 1; }
/** The lead limit acted this display frame: a soft pull of `nudgeM` metres, or a hard clamp (counted once per frame). */
export function noteMotionLeadLimit(frameMs: number, hardClamp: boolean, nudgeM: number): void {
  if (frameMs !== lastLeadFrameMs) {
    counters.leadCapFrames += 1;
    lastLeadFrameMs = frameMs;
  }
  if (hardClamp && frameMs !== lastHardClampFrameMs) {
    counters.leadHardClampFrames += 1;
    lastHardClampFrameMs = frameMs;
  }
  if (nudgeM > 0) counters.leadNudgeSumM += nudgeM;
}
/** One authority step on a straight leg: jump from the dead-reckoned point, distance walked, server ms, predicted speed. */
export function noteMotionAuthority(jumpM: number, distanceM: number, serverMs: number, predictedSpeedMps: number): void {
  if (jumpM > counters.authorityJumpMaxM) counters.authorityJumpMaxM = jumpM;
  counters.authorityDistanceM += distanceM;
  counters.authorityServerMs += serverMs;
  counters.authorityPredictedM += predictedSpeedMps * serverMs / 1_000;
}
export function noteMotionPrediction(rttMs: number, maxLeadMs: number, speedMps: number, baseSpeedMps: number): void {
  prediction.rttMs = rttMs;
  prediction.maxLeadMs = maxLeadMs;
  prediction.speedMps = speedMps;
  prediction.baseSpeedMps = baseSpeedMps;
}
export function noteMotionClockBehind(ms: number): void {
  counters.clockBehind += 1;
  if (ms > counters.clockBehindMaxMs) counters.clockBehindMaxMs = ms;
}

/**
 * The follow camera's frame (playerFollowController step): whether the player is walking with movement input, and the pan
 * it applied (screen px). Starts the session sample after 3 s of walking and a jitter sample when the pan keeps flipping.
 */
export function noteFollowFrame(walking: boolean, frameMs: number, panX: number, panY: number): void {
  if (!ctx) return;
  walkingNow = walking;
  if (walking) {
    lastWalkingMs = frameMs;
    walkingSinceMs ??= frameMs;
  } else if (walkingSinceMs !== null && frameMs - lastWalkingMs > 300) {
    walkingSinceMs = null;
  }
  if (sample || reportsSent >= MAX_REPORTS) return;
  if (walking) detect(frameMs, panX, panY);
  const walkedMs = walkingSinceMs === null ? 0 : frameMs - walkingSinceMs;
  if (!walking || walkedMs < WALK_BEFORE_SAMPLE_MS) return;
  if (reportsSent === 0) startSample("session");
  else if (jitterRequested && frameMs - lastReportEndMs >= JITTER_REPORT_GAP_MS) startSample("jitter");
}

function detect(frameMs: number, panX: number, panY: number): void {
  if (detLastFrameMs > 0 && frameMs - detLastFrameMs > 34) detLongFrameTimes.push(frameMs);
  detLastFrameMs = frameMs;
  const mag = Math.hypot(panX, panY);
  if (mag > DIRECTION_EPS_PX) {
    const dir = { x: panX / mag, y: panY / mag };
    detAxis = detAxis ? normalize({ x: detAxis.x * 0.9 + dir.x * 0.1, y: detAxis.y * 0.9 + dir.y * 0.1 }) ?? dir : dir;
    const sign = Math.sign(panX * detAxis.x + panY * detAxis.y);
    if (sign !== 0 && detLastSign !== 0 && sign !== detLastSign) detFlipTimes.push(frameMs);
    if (sign !== 0) detLastSign = sign;
  }
  while (detFlipTimes.length && frameMs - detFlipTimes[0]! > 1_000) detFlipTimes.shift();
  while (detLongFrameTimes.length && frameMs - detLongFrameTimes[0]! > 2_000) detLongFrameTimes.shift();
  if (detFlipTimes.length >= 3 || detLongFrameTimes.length >= 6) jitterRequested = true;
}

function normalize(p: Pt): Pt | null {
  const m = Math.hypot(p.x, p.y);
  return m > 1e-9 ? { x: p.x / m, y: p.y / m } : null;
}

/** Frame probe tap: every MapLibre render ("m") and Pixi overlay render ("o") while a sample runs. */
function tap(kind: "m" | "o", map: { project(lngLat: [number, number]): { x: number; y: number } }, sprite: Pt | null): void {
  const s = sample;
  if (!s) return;
  const a = map.project(s.anchorLngLat);
  if (kind === "m") {
    s.pendingM += 1;
    s.lastMAnchor = { x: a.x, y: a.y };
  } else {
    s.pendingO += 1;
    s.lastO = { anchor: { x: a.x, y: a.y }, sprite: sprite ? { x: sprite.x, y: sprite.y } : null };
    s.lastMismatch = s.lastMAnchor ? Math.hypot(a.x - s.lastMAnchor.x, a.y - s.lastMAnchor.y) : null;
  }
}

function startSample(kind: "session" | "jitter"): void {
  const map = ctx?.getMap();
  if (!map || typeof requestAnimationFrame !== "function") return;
  const c = map.getCenter();
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
  resetRasterAlignmentStats();
  try { perfMetrics.takeOverlayWindow("motionReport"); } catch { /* telemetry only */ }
  const s: Sample = {
    kind,
    startMs: performance.now(),
    anchorLngLat: [c.lng, c.lat],
    frames: [],
    pendingM: 0,
    pendingO: 0,
    lastO: null,
    lastMAnchor: null,
    lastMismatch: null,
    raf: 0,
    longTasks: 0,
    observer: null,
    counters
  };
  try {
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      s.observer = new PerformanceObserver((list) => { s.longTasks += list.getEntries().length; });
      s.observer.observe({ type: "longtask" });
    }
  } catch { s.observer = null; }
  sample = s;
  setFrameProbeTap(tap);
  const tick = (t: number): void => {
    if (sample !== s) return;
    const o = s.lastO;
    s.frames.push({
      t,
      m: s.pendingM,
      o: s.pendingO,
      anchor: o ? o.anchor : s.lastMAnchor,
      sprite: o ? o.sprite : null,
      mismatch: s.pendingO > 0 ? s.lastMismatch : null,
      walking: walkingNow
    });
    s.pendingM = 0;
    s.pendingO = 0;
    if (performance.now() - s.startMs >= SAMPLE_MS) { stopSample(true); return; }
    s.raf = requestAnimationFrame(tick);
  };
  s.raf = requestAnimationFrame(tick);
}

function stopSample(send: boolean): void {
  const s = sample;
  if (!s) return;
  sample = null;
  setFrameProbeTap(null);
  if (s.raf) cancelAnimationFrame(s.raf);
  try { s.observer?.disconnect(); } catch { /* ignore */ }
  if (!send) return;
  const walkingFrames = s.frames.filter((f) => f.walking).length;
  // The player stopped for most of the window: not a walking sample, try again on the next walk.
  if (s.frames.length < 30 || walkingFrames < s.frames.length * 0.6) {
    walkingSinceMs = null;
    return;
  }
  reportsSent += 1;
  lastReportEndMs = performance.now();
  jitterRequested = false;
  detFlipTimes.length = 0;
  detLongFrameTimes.length = 0;
  const map = ctx?.getMap() ?? null;
  const report = { ...summarizeMotionFrames(s.frames, map ? canvasCentre(map) : null), ...environment(map, s), ...(ctx?.context() ?? {}) };
  report.kind = s.kind;
  report.reportNo = reportsSent;
  sendMotionReport(s.kind, report);
}

function canvasCentre(map: MotionReportMap): Pt {
  const canvas = map.getCanvas();
  return { x: (canvas.clientWidth || canvas.width) / 2, y: (canvas.clientHeight || canvas.height) / 2 };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))]!;
}

const r2 = (value: number | null): number | null => (value === null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100);

/** Sign flips of a per-frame step series along an axis (steps under DIRECTION_EPS_PX carry no direction). */
export function countReversals(steps: Pt[], axis: Pt | null): number {
  if (!axis) return 0;
  let last = 0;
  let flips = 0;
  for (const step of steps) {
    const along = step.x * axis.x + step.y * axis.y;
    if (Math.abs(along) < DIRECTION_EPS_PX) continue;
    const sign = Math.sign(along);
    if (last !== 0 && sign !== last) flips += 1;
    last = sign;
  }
  return flips;
}

/** Weight of the newest step in the local heading (an EMA of step direction), so a turn is not counted as going back. */
const HEADING_EMA = 0.15;

/**
 * The local heading before each step: an EMA of the directions of `headingSteps` (the camera's walk), so back steps and
 * reversals are measured against where the player is heading now, not the whole sample's net direction.
 */
export function localHeadings(headingSteps: Pt[]): Array<Pt | null> {
  const headings: Array<Pt | null> = [];
  let heading: Pt | null = null;
  for (const step of headingSteps) {
    headings.push(heading);
    const mag = Math.hypot(step.x, step.y);
    if (mag < DIRECTION_EPS_PX) continue;
    const dir = { x: step.x / mag, y: step.y / mag };
    heading = heading
      ? normalize({ x: heading.x * (1 - HEADING_EMA) + dir.x * HEADING_EMA, y: heading.y * (1 - HEADING_EMA) + dir.y * HEADING_EMA }) ?? dir
      : dir;
  }
  return headings;
}

/** Steps that move against the local heading by more than DIRECTION_EPS_PX. */
export function countBackSteps(steps: Pt[], headings: Array<Pt | null>): number {
  let back = 0;
  steps.forEach((step, index) => {
    const heading = headings[index];
    if (heading && step.x * heading.x + step.y * heading.y < -DIRECTION_EPS_PX) back += 1;
  });
  return back;
}

/** Sign flips of each step along the local heading at that step. */
export function countHeadingReversals(steps: Pt[], headings: Array<Pt | null>): number {
  let last = 0;
  let flips = 0;
  steps.forEach((step, index) => {
    const heading = headings[index];
    if (!heading) return;
    const along = step.x * heading.x + step.y * heading.y;
    if (Math.abs(along) < DIRECTION_EPS_PX) return;
    const sign = Math.sign(along);
    if (last !== 0 && sign !== last) flips += 1;
    last = sign;
  });
  return flips;
}

/** Pure summary of the sampled frames (exported for unit tests). */
export function summarizeMotionFrames(frames: Frame[], centre: Pt | null): Record<string, ReportValue> {
  const intervals: number[] = [];
  for (let i = 1; i < frames.length; i += 1) intervals.push(frames[i]!.t - frames[i - 1]!.t);
  const sortedIv = [...intervals].sort((a, b) => a - b);
  const p50 = percentile(sortedIv, 0.5);
  // Camera: per-frame change of the fixed anchor's screen point, walking frames only.
  const camSteps: Pt[] = [];
  const offsets: Pt[] = [];
  let mapRendersWhileMoving0 = 0;
  let mapRendersWhileMoving1 = 0;
  let mapRendersWhileMoving2 = 0;
  let mismatchFrames = 0;
  let mismatchMax = 0;
  let overlayFrames = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const f = frames[i]!;
    const prev = frames[i - 1]!;
    if (f.o > 0) overlayFrames += 1;
    if (f.mismatch !== null) {
      if (f.mismatch > 0.25) mismatchFrames += 1;
      if (f.mismatch > mismatchMax) mismatchMax = f.mismatch;
    }
    if (!f.walking || !f.anchor || !prev.anchor) continue;
    const step = { x: f.anchor.x - prev.anchor.x, y: f.anchor.y - prev.anchor.y };
    camSteps.push(step);
    if (Math.hypot(step.x, step.y) > 0.01) {
      if (f.m === 0) mapRendersWhileMoving0 += 1;
      else if (f.m === 1) mapRendersWhileMoving1 += 1;
      else mapRendersWhileMoving2 += 1;
    }
    if (centre && f.sprite) offsets.push({ x: f.sprite.x - centre.x, y: f.sprite.y - centre.y });
  }
  // Local heading of the camera's walk (anchor screen motion), so turns do not count as back steps or reversals.
  const camHeadings = localHeadings(camSteps);
  const camSpeeds = camSteps.map((s) => Math.hypot(s.x, s.y));
  const camMean = camSpeeds.length ? camSpeeds.reduce((a, b) => a + b, 0) / camSpeeds.length : null;
  const camStd = camMean !== null && camSpeeds.length > 1
    ? Math.sqrt(camSpeeds.reduce((a, b) => a + (b - camMean) ** 2, 0) / camSpeeds.length)
    : null;
  const camBack = countBackSteps(camSteps, camHeadings);
  const offsetMags = offsets.map((o) => Math.hypot(o.x, o.y)).sort((a, b) => a - b);
  const offsetSteps: Pt[] = [];
  const offsetHeadings: Array<Pt | null> = [];
  for (let i = 1; i < offsets.length; i += 1) {
    offsetSteps.push({ x: offsets[i]!.x - offsets[i - 1]!.x, y: offsets[i]!.y - offsets[i - 1]!.y });
    offsetHeadings.push(camHeadings[Math.min(camHeadings.length - 1, i)] ?? null);
  }
  return {
    frames: frames.length,
    frameP50Ms: r2(p50),
    frameP95Ms: r2(percentile(sortedIv, 0.95)),
    frameMaxMs: r2(sortedIv.length ? sortedIv[sortedIv.length - 1]! : null),
    framesOver20: intervals.filter((v) => v > 20).length,
    framesOver34: intervals.filter((v) => v > 34).length,
    refreshHz: p50 ? Math.round(1_000 / p50) : null,
    camStepMeanPx: r2(camMean),
    camStepCv: r2(camMean && camStd !== null ? camStd / camMean : null),
    camReversals: countHeadingReversals(camSteps, camHeadings),
    camBackSteps: camBack,
    playerOffsetP95Px: r2(percentile(offsetMags, 0.95)),
    playerOffsetMaxPx: r2(offsetMags.length ? offsetMags[offsetMags.length - 1]! : null),
    playerOffsetReversals: countHeadingReversals(offsetSteps, offsetHeadings),
    overlayFrames,
    movingFramesMap0: mapRendersWhileMoving0,
    movingFramesMap1: mapRendersWhileMoving1,
    movingFramesMap2Plus: mapRendersWhileMoving2,
    layerMismatchFrames: mismatchFrames,
    layerMismatchMaxPx: r2(mismatchMax)
  };
}

function cssPxPerMetre(map: MotionReportMap, at: [number, number]): number | null {
  const a = map.project(at);
  // 1e-4 degrees of latitude is 11.1 m.
  const b = map.project([at[0], at[1] + 1e-4]);
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  return Number.isFinite(px) && px > 0 ? px / 11.119_5 : null;
}

function gpuRenderer(canvas: HTMLCanvasElement): string | null {
  try {
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)).slice(0, 120);
  } catch {
    return null;
  }
}

function environment(map: MotionReportMap | null, s: Sample): Record<string, ReportValue> {
  const out: Record<string, ReportValue> = {
    dpr: r2(globalThis.devicePixelRatio || 1),
    corrections: s.counters.corrections,
    correctionMaxM: r2(s.counters.correctionMaxM),
    correctionMeanM: r2(s.counters.corrections ? s.counters.correctionSumM / s.counters.corrections : null),
    snaps: s.counters.snaps,
    leadCapFrames: s.counters.leadCapFrames,
    leadHardClampFrames: s.counters.leadHardClampFrames,
    authorityServerSpeedMps: r2(s.counters.authorityServerMs > 0 ? s.counters.authorityDistanceM / (s.counters.authorityServerMs / 1_000) : null),
    serverSpeedRatio: r2(s.counters.authorityPredictedM > 0 ? s.counters.authorityDistanceM / s.counters.authorityPredictedM : null),
    rttMs: r2(prediction.rttMs),
    maxLeadMs: r2(prediction.maxLeadMs),
    speedMps: r2(prediction.speedMps),
    baseSpeedMps: r2(prediction.baseSpeedMps),
    speedVsBase: r2(prediction.speedMps !== null && prediction.baseSpeedMps ? prediction.speedMps / prediction.baseSpeedMps : null),
    clockBehindReads: s.counters.clockBehind,
    clockBehindMaxMs: r2(s.counters.clockBehindMaxMs),
    longTasks: s.observer ? s.longTasks : null,
    build: clientConfig.buildSha ?? null,
    platform: clientConfig.nativePlatformName ?? "web",
    ua: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 200) : null
  };
  Object.assign(out, rasterAlignmentReport(map), followSwitchReport());
  try {
    const w = perfMetrics.takeOverlayWindow("motionReport");
    const perSec = (n: number): number | null => (w.windowMs > 0 ? r2(n / (w.windowMs / 1_000)) : null);
    out.staticOverlayRedraws = w.staticOverlayRedraws;
    out.staticOverlayRedrawsPerSec = perSec(w.staticOverlayRedraws);
    out.maxStaticOverlayDrawMs = r2(w.maxStaticOverlayDrawMs);
    out.dynamicOverlayUpdateMsPerFrame = r2(w.dynamicOverlayUpdateMsPerFrame);
    out.pixiRenderCallMsPerFrame = r2(w.pixiRenderCallMsPerFrame);
    out.gameAppRendersPerSec = perSec(w.gameAppRenders);
    out.eventLoopLagMs = r2(perfMetrics.getSnapshot().eventLoopLagMs);
  } catch { /* telemetry only */ }
  // Metres to CSS px at the sample's anchor, for the lead pull and the authority jump.
  const pxPerM = map ? cssPxPerMetre(map, s.anchorLngLat) : null;
  out.leadNudgePxSum = r2(pxPerM === null ? null : s.counters.leadNudgeSumM * pxPerM);
  out.authorityJumpMaxPx = r2(pxPerM === null ? null : s.counters.authorityJumpMaxM * pxPerM);
  out.authorityJumpMaxM = r2(s.counters.authorityJumpMaxM);
  if (map) {
    const canvas = map.getCanvas();
    out.mapCanvasW = canvas.width;
    out.mapCanvasH = canvas.height;
    out.mapCssW = canvas.clientWidth;
    out.mapCssH = canvas.clientHeight;
    out.mapPixelRatio = r2(canvas.clientWidth ? canvas.width / canvas.clientWidth : null);
    out.gpu = gpuRenderer(canvas);
    // The Pixi overlay: the largest other canvas on the page.
    const overlay = Array.from(document.querySelectorAll("canvas"))
      .filter((c) => c !== canvas)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    out.overlayCanvasW = overlay?.width ?? null;
    out.overlayCanvasH = overlay?.height ?? null;
    out.overlayPixelRatio = r2(overlay && overlay.clientWidth ? overlay.width / overlay.clientWidth : null);
  }
  return out;
}

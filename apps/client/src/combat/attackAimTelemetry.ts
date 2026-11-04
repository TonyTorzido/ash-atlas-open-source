import { sendAttackAimReport } from "../audio/audioReport.js";
import { clientConfig } from "../config.js";
import { ATTACK_AIM_DECISION_PX, ATTACK_TOUCH_GRACE_MS } from "./swingAim.js";

/**
 * Touch attack button timing telemetry (t1559): real phone timings for the first swing's aim decision, so the touch-down
 * grace and the decision dead zone can be tuned from data instead of guesses. The first MAX_PRESSES presses of a session
 * are recorded; every BATCH presses (and on pagehide) one flat report goes to /api/diagnostics/attack-aim, which the server
 * logs as "client attack aim report". Each row is a short string, no positions, ids or map data:
 *
 *   source,firstMoveMs,decideMs,distPx,peakPx,swingSide,moveSide,swung
 *
 * source: drag (pulled past the decision distance inside the grace), flick (lifted past it inside the grace), tap (lifted
 * inside the grace, auto-aimed), hold (still at the grace end, auto-aimed). firstMoveMs: touch-down to the first pointer
 * move of 1 px or more ("-" when none came before the decision). decideMs: touch-down to the decision. distPx: the finger
 * offset at the decision; peakPx: the largest offset before it. swingSide / moveSide: L, R or "-" for the swing's screen
 * side and the held movement's screen side at the decision. swung: 1 when the swing went out at once.
 */
const MAX_PRESSES = 50;
const BATCH = 10;
/** Screen x under this counts as neither side (straight up or down). */
const SIDE_EPSILON = 0.04;

export type AttackAimSource = "drag" | "flick" | "tap" | "hold";

export type AttackAimPress = {
  readonly downAtMs: number;
  firstMoveMs: number | null;
  peakPx: number;
  lastPx: number;
  decided: boolean;
};

let presses = 0;
let batches = 0;
const rows: string[] = [];
let autoAimScreenX: number | null = null;
let flushHooked = false;

function side(x: number | null): string {
  if (x === null || !Number.isFinite(x) || Math.abs(x) < SIDE_EPSILON) return "-";
  return x > 0 ? "R" : "L";
}

/** App's auto-aim notes the screen x of the direction it chose, read back by the tap / hold decision. */
export function noteAutoAimScreenX(x: number | null): void {
  autoAimScreenX = x;
}

/** Clears and returns the last auto-aim screen x (null when no auto-aim ran since the last read). */
export function takeAutoAimScreenX(): number | null {
  const x = autoAimScreenX;
  autoAimScreenX = null;
  return x;
}

/** A touch-down on the attack button; null once the session's quota is used. */
export function beginAttackAimPress(nowMs: number): AttackAimPress | null {
  if (presses >= MAX_PRESSES) return null;
  presses += 1;
  hookFlush();
  autoAimScreenX = null;
  return { downAtMs: nowMs, firstMoveMs: null, peakPx: 0, lastPx: 0, decided: false };
}

/** A finger move (offset from the stick centre, px) before the decision. */
export function noteAttackAimMove(press: AttackAimPress | null, nowMs: number, dxPx: number, dyPx: number): void {
  if (!press || press.decided) return;
  const distance = Math.hypot(dxPx, dyPx);
  if (press.firstMoveMs === null && distance >= 1) press.firstMoveMs = nowMs - press.downAtMs;
  press.lastPx = distance;
  if (distance > press.peakPx) press.peakPx = distance;
}

/**
 * The first swing's aim decision. `swingScreenX` is the chosen direction's screen x (drag / flick: the finger's unit
 * offset; tap / hold: takeAutoAimScreenX()); `moveScreenX` the held movement's screen x, or null when not moving.
 */
export function decideAttackAim(
  press: AttackAimPress | null,
  source: AttackAimSource,
  nowMs: number,
  swingScreenX: number | null,
  moveScreenX: number | null,
  swung: boolean,
  distPx = press?.lastPx ?? 0
): void {
  if (!press || press.decided) return;
  press.decided = true;
  const peak = Math.max(press.peakPx, distPx);
  rows.push([
    source,
    press.firstMoveMs === null ? "-" : Math.round(press.firstMoveMs),
    Math.round(nowMs - press.downAtMs),
    Math.round(distPx),
    Math.round(peak),
    side(swingScreenX),
    side(moveScreenX),
    swung ? 1 : 0
  ].join(","));
  if (rows.length >= BATCH) flush();
}

function flush(): void {
  if (rows.length === 0) return;
  const report: Record<string, string | number | boolean | null> = {
    batch: batches,
    graceMs: ATTACK_TOUCH_GRACE_MS,
    decisionPx: ATTACK_AIM_DECISION_PX,
    build: clientConfig.buildSha ?? null,
    platform: clientConfig.nativePlatformName ?? "web",
    rows: rows.length
  };
  rows.splice(0).forEach((row, index) => { report[`p${index}`] = row; });
  batches += 1;
  sendAttackAimReport(report);
}

function hookFlush(): void {
  if (flushHooked || typeof window === "undefined") return;
  flushHooked = true;
  try {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  } catch { /* Telemetry only. */ }
}

/** Test hook: the rows not yet sent, and a reset of the session quota. */
export const attackAimTelemetryForTest = {
  pending: (): readonly string[] => rows.slice(),
  reset: (): void => { presses = 0; batches = 0; rows.length = 0; autoAimScreenX = null; }
};

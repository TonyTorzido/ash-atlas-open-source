import {
  DASH_COOLDOWN_MS,
  DASH_DISTANCE_M,
  DASH_DURATION_MS,
  DASH_MIN_DISTANCE_M,
  dashDirectionForBearing,
  dashEndPoint,
  distanceMeters,
  type LatLon
} from "@ash-atlas/shared";

import { JOYSTICK_LEASH_MARGIN, joystickBearingDeg, normalizeDegrees, type JoystickLeash } from "./joystickMovementMath.js";

/**
 * Client side of the overworld dash: direction choice, local prediction bookkeeping, the
 * cooldown store the HUD reads, and the measurement reported on the next DASH.
 */

export type DashDirection = Readonly<{ dirX: number; dirY: number; bearingDeg: number }>;

export type DashDirectionInput = Readonly<{
  /** Current movement input in screen pixels (x right, y down), or null when nothing is held. */
  stick: Readonly<{ dx: number; dy: number; radiusPx: number }> | null;
  /** Compass bearing of the last movement input, if any. */
  lastBearingDeg: number | null;
  /** Map bearing in degrees (the compass heading at the top of the screen). */
  mapBearingDeg: number;
}>;

/**
 * Held input wins; otherwise the last movement direction; otherwise screen-up.
 * The result is a WORLD-space unit vector (dirX east, dirY north), as DASH expects.
 */
export function chooseDashDirection(input: DashDirectionInput): DashDirection {
  const held = input.stick
    ? joystickBearingDeg(input.stick.dx, input.stick.dy, input.stick.radiusPx, input.mapBearingDeg)
    : null;
  const bearingDeg = held ?? input.lastBearingDeg ?? normalizeDegrees(input.mapBearingDeg);
  const { dirX, dirY } = dashDirectionForBearing(bearingDeg);
  return { dirX, dirY, bearingDeg: normalizeDegrees(bearingDeg) };
}

export type PadAAction = "select" | "dash" | "none";

/** A: selects inside an open menu or popup; dashes otherwise (bumper chords own A while held). */
export function padAAction(scopeOpen: boolean, chordHeld: boolean): PadAAction {
  if (chordHeld) return "none";
  return scopeOpen ? "select" : "dash";
}

/** Predicted end, clamped inside the leash like the server does (so the prediction rarely corrects). */
export function predictDashEnd(position: LatLon, direction: DashDirection, leash: JoystickLeash | null): LatLon | null {
  const allowed = (meters: number): boolean => !leash || distanceMeters(
    { lat: leash.anchorLat, lon: leash.anchorLon },
    dashEndPoint(position, direction.dirX, direction.dirY, meters)
  ) <= leash.moveLeashRadiusM * JOYSTICK_LEASH_MARGIN + 1;
  let distanceM = DASH_DISTANCE_M;
  if (!allowed(distanceM)) {
    let low = 0;
    let high = distanceM;
    for (let i = 0; i < 16; i += 1) {
      const mid = (low + high) / 2;
      if (allowed(mid)) low = mid; else high = mid;
    }
    distanceM = low;
  }
  if (distanceM < DASH_MIN_DISTANCE_M) return null;
  return dashEndPoint(position, direction.dirX, direction.dirY, distanceM);
}

export type PendingDash = {
  requestId: string;
  pressedAtMs: number;
  from: LatLon;
  predictedEnd: LatLon;
};

export type DashMeasurement = Readonly<{
  requestId: string;
  pressToAcceptMs: number;
  /** Predicted end vs the server's end. */
  correctionM: number;
  /** Predicted start vs the server's start (0 means the player was standing still). */
  startOffsetM: number;
}>;

type Listener = () => void;

/** Module-level dash state shared by the input components, the frame handler and the HUD. */
/** A dash pressed this close to the end of the cooldown is held and fires when the cooldown ends. */
export const DASH_INPUT_QUEUE_MS = 150;
/** Extra wait on a queued dash so it reaches the server just after the server's own cooldown ended. */
export const DASH_QUEUE_SLACK_MS = 25;

class DashClientState {
  private listeners = new Set<Listener>();
  private trigger: (() => boolean) | null = null;
  pending: PendingDash | null = null;
  /** performance.now() times. */
  activeUntilMs = 0;
  cooldownUntilMs = 0;
  lastMeasurement: DashMeasurement | null = null;
  /** Bumped on every local dash start, for the HUD and FX. */
  revision = 0;
  /** Bumped when a gesture (a flick) asks for a dash that is still recharging: the HUD pulses the recharge ring. */
  deniedRevision = 0;
  lastStart: { from: LatLon; to: LatLon; atMs: number } | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getRevision = (): number => this.revision;

  getDeniedRevision = (): number => this.deniedRevision;

  /** A gesture asked for a dash that is still recharging. */
  denied(): void {
    this.deniedRevision += 1;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** JoystickMovement registers the function that reads its input and sends the dash. */
  registerTrigger(trigger: (() => boolean) | null): void {
    this.trigger = trigger;
  }

  /** Gamepad A and the touch button call this. */
  requestDash(): boolean {
    return this.trigger?.() ?? false;
  }

  isActive(nowMs: number): boolean {
    return nowMs < this.activeUntilMs;
  }

  ready(nowMs: number): boolean {
    return nowMs >= this.cooldownUntilMs;
  }

  /**
   * Milliseconds until a dash pressed at `nowMs` can fire: 0 when ready, the wait (cooldown end plus slack) when the cooldown
   * ends within DASH_INPUT_QUEUE_MS, null when it is too far off to hold the press.
   */
  queueDelayMs(nowMs: number): number | null {
    const remainingMs = this.cooldownUntilMs - nowMs;
    if (remainingMs <= 0) return 0;
    if (remainingMs <= DASH_INPUT_QUEUE_MS) return remainingMs + DASH_QUEUE_SLACK_MS;
    return null;
  }

  /** A gesture may ask for a dash now: it is ready or will be inside the queue window. */
  acceptsInput(nowMs: number): boolean {
    return this.queueDelayMs(nowMs) !== null;
  }

  /** Cooldown progress 0..1 (1 = ready). */
  cooldownProgress(nowMs: number): number {
    if (nowMs >= this.cooldownUntilMs) return 1;
    return Math.max(0, 1 - (this.cooldownUntilMs - nowMs) / DASH_COOLDOWN_MS);
  }

  started(pending: PendingDash): void {
    this.pending = pending;
    this.activeUntilMs = pending.pressedAtMs + DASH_DURATION_MS;
    this.cooldownUntilMs = pending.pressedAtMs + DASH_COOLDOWN_MS;
    this.lastStart = { from: { ...pending.from }, to: { ...pending.predictedEnd }, atMs: pending.pressedAtMs };
    this.revision += 1;
    this.emit();
  }

  /** DASH_ACCEPTED: returns the measurement for this dash (also kept for the next DASH). */
  accepted(requestId: string, serverEnd: LatLon, nowMs: number, serverFrom: LatLon = serverEnd): DashMeasurement | null {
    const pending = this.pending;
    if (!pending || pending.requestId !== requestId) return null;
    this.pending = null;
    const measurement = {
      requestId,
      pressToAcceptMs: Math.max(0, nowMs - pending.pressedAtMs),
      correctionM: distanceMeters(pending.predictedEnd, serverEnd),
      startOffsetM: serverFrom === serverEnd ? 0 : distanceMeters(pending.from, serverFrom)
    };
    this.lastMeasurement = measurement;
    return measurement;
  }

  /** ERROR DASH_REJECTED: the dash did not happen, so neither does its cooldown. */
  rejected(requestId: string | undefined): boolean {
    if (!this.pending || this.pending.requestId !== requestId) return false;
    this.pending = null;
    this.activeUntilMs = 0;
    this.cooldownUntilMs = 0;
    this.revision += 1;
    this.emit();
    return true;
  }

  takeMeasurement(): DashMeasurement | null {
    const measurement = this.lastMeasurement;
    this.lastMeasurement = null;
    return measurement;
  }

  reset(): void {
    this.pending = null;
    this.activeUntilMs = 0;
    this.cooldownUntilMs = 0;
    this.lastMeasurement = null;
  }
}

export const dashClientState = new DashClientState();

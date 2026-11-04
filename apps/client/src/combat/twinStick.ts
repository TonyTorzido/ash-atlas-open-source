import { swingDirectionFromScreenOffset } from "./swingAim.js";
import type { SwingDirection } from "./swing.js";

/**
 * Twin-stick aim-to-attack: pure helpers shared by the controller right stick, the mobile attack
 * button and the PC right mouse button. Aiming and attacking are one input: while it is held and
 * aimed, a swing (or shot) goes out every time the recovery ends. `SwingClientState` still gates
 * the actual cadence; these helpers only decide where to aim and when to try again.
 */

/** Right-stick deflection (0..1) past which the stick aims and attacks. */
export const AIM_STICK_THRESHOLD = 0.35;
/** Minimum gap between two attempts that did not result in a swing (disconnected, no player yet). */
export const AIM_RETRY_MS = 50;
/** Cursor closer than this to the player (screen px) has no usable aim direction. */
export const CURSOR_AIM_DEAD_ZONE_PX = 14;

/** World aim for a right-stick deflection (screen x right, y down). Null at or inside the threshold. */
export function stickAimDirection(
  x: number,
  y: number,
  mapBearingDeg: number,
  threshold = AIM_STICK_THRESHOLD
): SwingDirection | null {
  const magnitude = Math.hypot(x, y);
  if (!Number.isFinite(magnitude) || magnitude < threshold) return null;
  // Normalise so the downstream (smaller) joystick dead zone never rejects a deflection past the threshold.
  return swingDirectionFromScreenOffset(x / magnitude, y / magnitude, mapBearingDeg, 1);
}

/** World aim for a cursor offset (px) from the player's screen point. Null on top of the player. */
export function cursorAimDirection(dxPx: number, dyPx: number, mapBearingDeg: number): SwingDirection | null {
  const length = Math.hypot(dxPx, dyPx);
  if (!Number.isFinite(length) || length < CURSOR_AIM_DEAD_ZONE_PX) return null;
  return swingDirectionFromScreenOffset(dxPx / length, dyPx / length, mapBearingDeg, 1);
}

/**
 * Hold-to-attack timing. Call `due` once per frame while the aim input is held: it is true when the
 * recovery is over (`nowMs >= nextSwingAtMs`) and the last attempt was at least AIM_RETRY_MS ago.
 * `release` forgets the last attempt so a fresh press attacks at once.
 */
export class AimAttackRepeater {
  private lastAttemptMs = Number.NEGATIVE_INFINITY;

  due(nowMs: number, nextSwingAtMs: number): boolean {
    if (nowMs < nextSwingAtMs) return false;
    if (nowMs - this.lastAttemptMs < AIM_RETRY_MS) return false;
    this.lastAttemptMs = nowMs;
    return true;
  }

  release(): void {
    this.lastAttemptMs = Number.NEGATIVE_INFINITY;
  }
}

export type AttackButtonMode =
  /** Finger down on the button, nothing decided yet (a tap if released now). */
  | "pending"
  /** Held still past the hold time: auto-aim swings repeat. */
  | "auto"
  /** Dragged out: aim and attack toward the drag direction. */
  | "aim"
  /** Dragged out, then back into the centre dead zone: attacking is paused. */
  | "paused";

/**
 * Next mode of the attack button. `drag` is the classified finger offset (`classifyAttackDrag`),
 * `heldMs` how long the finger has been down. Drag always wins over auto repeat, and a finger
 * that has aimed never falls back to auto-aim.
 */
export function nextAttackButtonMode(
  mode: AttackButtonMode,
  drag: "idle" | "aim" | "cancel",
  heldMs: number,
  holdRepeatMs: number
): AttackButtonMode {
  if (drag === "aim") return "aim";
  if (drag === "cancel") return "paused";
  if ((mode === "aim" || mode === "paused")) return mode;
  if (mode === "pending" && heldMs >= holdRepeatMs) return "auto";
  return mode;
}

/** Whether the mode attacks continuously (aim and auto), as opposed to waiting for a release. */
export function attackButtonRepeats(mode: AttackButtonMode): boolean {
  return mode === "aim" || mode === "auto";
}

/** Knob offset inside the attack button (px), clamped to `maxPx`, for the stick-like visual. */
export function attackKnobOffset(dxPx: number, dyPx: number, maxPx: number): { x: number; y: number } {
  const length = Math.hypot(dxPx, dyPx);
  if (!(length > maxPx) || length === 0) return { x: dxPx, y: dyPx };
  return { x: (dxPx / length) * maxPx, y: (dyPx / length) * maxPx };
}

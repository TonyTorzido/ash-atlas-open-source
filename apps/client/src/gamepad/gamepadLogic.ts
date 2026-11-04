/** Pure controller logic: button edges, bumper chords, menu focus choice. Standard Gamepad mapping. */

export const PAD_A = 0;
export const PAD_B = 1;
export const PAD_X = 2;
export const PAD_Y = 3;
export const PAD_LB = 4;
export const PAD_RB = 5;
/** Right trigger: tap at the screen-centre cursor (edge-triggered). */
export const PAD_RT = 7;
export const PAD_R3 = 10;
export const PAD_DPAD_UP = 12;
export const PAD_DPAD_DOWN = 13;
export const PAD_DPAD_LEFT = 14;
export const PAD_DPAD_RIGHT = 15;

/** Stick menu navigation repeats this often while held. */
export const NAV_REPEAT_MS = 180;
export const NAV_DEAD_ZONE = 0.5;

export type NavDirection = "up" | "down" | "left" | "right";
export type Chord = "left" | "right" | null;

/** Reports buttons that went down since the previous poll, ignoring held repeats. */
export class ButtonEdgeTracker {
  private previous: boolean[] = [];

  update(pressed: readonly boolean[]): number[] {
    const edges: number[] = [];
    for (let i = 0; i < pressed.length; i += 1) {
      if (pressed[i] && !this.previous[i]) edges.push(i);
    }
    this.previous = pressed.slice();
    return edges;
  }

  reset(): void {
    this.previous = [];
  }
}

/** LB selects the first four hotbar slots, RB the next four. LB wins if both are held. */
export function resolveChord(lbHeld: boolean, rbHeld: boolean): Chord {
  if (lbHeld) return "left";
  if (rbHeld) return "right";
  return null;
}

const FACE_ORDER = [PAD_A, PAD_X, PAD_B, PAD_Y] as const;

/** Slot index 0..7 for a face button under a chord, or null when it is not a slot press. */
export function chordSlotIndex(chord: Chord, button: number): number | null {
  if (!chord) return null;
  const position = FACE_ORDER.indexOf(button as typeof FACE_ORDER[number]);
  if (position < 0) return null;
  return (chord === "left" ? 0 : 4) + position;
}

export function stickToDirection(x: number, y: number, deadZone = NAV_DEAD_ZONE): NavDirection | null {
  if (Math.hypot(x, y) < deadZone) return null;
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? "right" : "left";
  return y > 0 ? "down" : "up";
}

/** Allows a navigation step on a fresh direction immediately, then every NAV_REPEAT_MS while held. */
export class NavRepeater {
  private lastDirection: NavDirection | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;

  step(direction: NavDirection | null, nowMs: number): NavDirection | null {
    if (!direction) {
      this.lastDirection = null;
      return null;
    }
    if (direction !== this.lastDirection || nowMs - this.lastAt >= NAV_REPEAT_MS) {
      this.lastDirection = direction;
      this.lastAt = nowMs;
      return direction;
    }
    return null;
  }
}

export type FocusRect = Readonly<{ left: number; top: number; width: number; height: number }>;

/**
 * Picks the next focus index when moving in a direction: the nearest item whose centre lies
 * in that half-plane, weighting off-axis distance double. Falls back to the first item when
 * nothing is focused, and keeps the current one when nothing lies that way.
 */
export function chooseFocus(
  rects: readonly FocusRect[],
  current: number | null,
  direction: NavDirection
): number | null {
  if (rects.length === 0) return null;
  if (current === null || current < 0 || current >= rects.length) return 0;
  const from = rects[current]!;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  rects.forEach((rect, index) => {
    if (index === current) return;
    const dx = rect.left + rect.width / 2 - cx;
    const dy = rect.top + rect.height / 2 - cy;
    const along = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
    const across = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) return;
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = index; }
  });
  return best ?? current;
}

/**
 * Camera pan direction from the D-pad (screen x right, y down), unit length on diagonals.
 * Used in action combat, where the right stick aims and attacks instead of panning.
 */
export function dpadPanVector(up: boolean, down: boolean, left: boolean, right: boolean): { x: number; y: number } {
  const x = (right ? 1 : 0) - (left ? 1 : 0);
  const y = (down ? 1 : 0) - (up ? 1 : 0);
  const length = Math.hypot(x, y);
  return length > 0 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
}

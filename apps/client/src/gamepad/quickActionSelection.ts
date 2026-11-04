/** Pure target selection and hold-versus-tap timing for the controller's X button. */

export const QUICK_ACTION_RANGE_M = 150;
export const X_HOLD_MS = 500;

export type QuickCandidate = Readonly<{
  kind: "harvest" | "pickup" | "attack";
  id: string;
  distanceM: number;
}>;

/** Closest candidate within range. Attackable targets count only in Aggressive mode. */
export function selectQuickAction<T extends QuickCandidate>(
  candidates: readonly T[],
  options: Readonly<{ aggressive: boolean; rangeM?: number }>
): T | null {
  const rangeM = options.rangeM ?? QUICK_ACTION_RANGE_M;
  let best: T | null = null;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.distanceM) || candidate.distanceM > rangeM) continue;
    if (candidate.kind === "attack" && !options.aggressive) continue;
    if (!best || candidate.distanceM < best.distanceM) best = candidate;
  }
  return best;
}

/** X: released under the hold time is a tap; held to the hold time toggles once and its release is silent. */
export class HoldTapTracker {
  private downAt: number | null = null;
  private toggled = false;

  down(nowMs: number): void {
    if (this.downAt === null) { this.downAt = nowMs; this.toggled = false; }
  }

  /** Call every frame while the button may be held. Returns "toggle" once when the hold time passes. */
  poll(nowMs: number): "toggle" | null {
    if (this.downAt === null || this.toggled || nowMs - this.downAt < X_HOLD_MS) return null;
    this.toggled = true;
    return "toggle";
  }

  /** Returns "tap" only for a release before the hold time that did not toggle. */
  up(nowMs: number): "tap" | null {
    if (this.downAt === null) return null;
    const wasTap = !this.toggled && nowMs - this.downAt < X_HOLD_MS;
    this.downAt = null;
    this.toggled = false;
    return wasTap ? "tap" : null;
  }

  reset(): void {
    this.downAt = null;
    this.toggled = false;
  }
}

import type { LocationFixReason } from "@ash-atlas/shared";

// Seam between land-action senders and the location fix scheduler, so the
// command clients stay free of Capacitor imports (NATIVE_ANTISPOOF_BUILD_PLAN.md §2.8).

export type ActionFixReason = Extract<LocationFixReason, `action_${string}`>;

let handler: ((reason: ActionFixReason) => void) | null = null;

export function setActionFixHandler(next: ((reason: ActionFixReason) => void) | null): void {
  handler = next;
}

/** Fire-and-forget; a no-op unless the scheduler is installed and enabled. Never throws. */
export function requestActionFix(reason: ActionFixReason): void {
  try {
    handler?.(reason);
  } catch {
    // Location trust must never break a land action.
  }
}

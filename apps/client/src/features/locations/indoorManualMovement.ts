import type { ClientPortalPhase } from "./usePortalLocationController.js";

export function runIndoorManualMovement<TResult>(
  cancelPortalTransition: () => unknown,
  move: () => TResult
): TResult {
  cancelPortalTransition();
  return move();
}

export function isIndoorManualMovementDisabled(
  online: boolean,
  phase: ClientPortalPhase
): boolean {
  return !online || phase === "covered" || phase === "committed" || phase === "revealing";
}

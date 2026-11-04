import type { ServerMessage } from "@ash-atlas/shared";

type ErrorFrame = Extract<ServerMessage, { type: "ERROR" }>;

export type FlagTravelErrorEffect = Readonly<{
  matchesPendingTravel: boolean;
  requestIdToClear: string | null;
  feedbackMessage: string | null;
  refreshAccess: boolean;
  aggressiveRetryAfterMs: number;
}>;

export function flagTravelErrorEffect(
  message: ErrorFrame,
  pendingTravelRequestId: string | null
): FlagTravelErrorEffect {
  const matchesPendingTravel = Boolean(
    pendingTravelRequestId &&
    message.requestId === pendingTravelRequestId
  );
  return {
    matchesPendingTravel,
    requestIdToClear: matchesPendingTravel ? pendingTravelRequestId : null,
    feedbackMessage: matchesPendingTravel ? message.message : null,
    refreshAccess: matchesPendingTravel && isStaleFlagAccessCode(message.code),
    aggressiveRetryAfterMs:
      matchesPendingTravel &&
      (message.code === "FLAG_VISIT_AGGRESSIVE" || message.code === "TRAVEL_AGGRESSIVE")
        ? Math.max(0, message.details?.retryAfterMs ?? 0)
        : 0
  };
}

function isStaleFlagAccessCode(code: string): boolean {
  return code === "TOLL_CHANGED" ||
    code === "FLAG_CHANGED" ||
    code === "ACCESS_CHANGED" ||
    code === "FLAG_NOT_FOUND" ||
    code.startsWith("FLAG_ACCESS_");
}

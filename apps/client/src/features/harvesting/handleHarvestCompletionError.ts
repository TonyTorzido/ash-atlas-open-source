import {
  HARVEST_COMPLETION_RETRY_MS,
  type HarvestTask
} from "../../collectibles/harvest.js";
import type {
  ErrorMessage,
  SessionFrameHandlerOptions
} from "../session/sessionFrameHandlerContracts.js";

type HarvestCompletionErrorOptions = Pick<
  SessionFrameHandlerOptions,
  | "harvestTaskRef"
  | "pendingHarvestCompletionRef"
  | "harvestRequestSentRef"
  | "setHarvestTask"
  | "queuedHarvestReplacementRef"
  | "pendingHarvestCancelNodeRef"
  | "restoreOptimisticResinPresentation"
  | "requestNearbyCollectibles"
  | "setWarning"
  | "showActionError"
  | "setHarvestStatusAnnouncement"
>;

/** Returns true only when completion settlement consumes the error frame. */
export function handleHarvestCompletionError(
  message: ErrorMessage,
  formatted: string,
  options: HarvestCompletionErrorOptions
): boolean {
  const {
    harvestTaskRef,
    pendingHarvestCompletionRef,
    harvestRequestSentRef,
    setHarvestTask,
    queuedHarvestReplacementRef,
    pendingHarvestCancelNodeRef,
    restoreOptimisticResinPresentation,
    requestNearbyCollectibles,
    setWarning,
    showActionError,
    setHarvestStatusAnnouncement
  } = options;
  if (
    message.code.startsWith("HARVEST_") &&
    message.details?.terminalCleanupOutcome !== undefined
  ) {
    const sessionId = message.details.sessionId;
    const activeTask = harvestTaskRef.current;
    const pendingCompletion = pendingHarvestCompletionRef.current;
    const matchesActiveTask =
      typeof sessionId === "string" &&
      activeTask?.sessionId === sessionId &&
      (
        !message.requestId ||
        harvestRequestSentRef.current === message.requestId
      );
    const matchesPendingCompletion =
      typeof sessionId === "string" &&
      pendingCompletion?.sessionId === sessionId &&
      (
        !message.requestId ||
        pendingCompletion.requestId === message.requestId
      );
    if (!matchesActiveTask && !matchesPendingCompletion) return true;
    if (matchesActiveTask) {
      harvestTaskRef.current = null;
      setHarvestTask((current) =>
        current?.sessionId === sessionId ? null : current
      );
    }
    if (matchesPendingCompletion) {
      pendingHarvestCompletionRef.current = null;
    }
    if (queuedHarvestReplacementRef) {
      queuedHarvestReplacementRef.current = null;
    }
    if (
      !message.requestId ||
      harvestRequestSentRef.current === message.requestId
    ) {
      harvestRequestSentRef.current = null;
    }
    if (
      pendingHarvestCancelNodeRef.current ===
      (message.details.nodeId ?? activeTask?.nodeId)
    ) {
      pendingHarvestCancelNodeRef.current = null;
    }
    restoreOptimisticResinPresentation();
    requestNearbyCollectibles();
    setWarning(formatted);
    showActionError(formatted);
    return true;
  }
  if (message.code === "HARVEST_INTERNAL_FAILURE") {
    const sessionId = message.details?.sessionId;
    const activeTask = harvestTaskRef.current;
    const pendingCompletion = pendingHarvestCompletionRef.current;
    const matchesActiveTask =
      typeof sessionId === "string" &&
      activeTask?.sessionId === sessionId &&
      (
        !message.requestId ||
        harvestRequestSentRef.current === message.requestId
      );
    const matchesPendingCompletion =
      typeof sessionId === "string" &&
      pendingCompletion?.sessionId === sessionId &&
      (
        !message.requestId ||
        pendingCompletion.requestId === message.requestId
      );
    if (matchesActiveTask) {
      const pausedTask: HarvestTask = {
        ...activeTask,
        phase: "harvesting",
        completesAtMs: Date.now() + HARVEST_COMPLETION_RETRY_MS
      };
      harvestTaskRef.current = pausedTask;
      setHarvestTask(pausedTask);
    }
    if (matchesActiveTask || matchesPendingCompletion) {
      if (pendingCompletion) {
        pendingHarvestCompletionRef.current = {
          ...pendingCompletion,
          requestId: null,
          lastAttemptAtMs: Date.now()
        };
      }
      if (
        !message.requestId ||
        harvestRequestSentRef.current === message.requestId
      ) {
        harvestRequestSentRef.current = null;
      }
      restoreOptimisticResinPresentation();
      requestNearbyCollectibles();
      setWarning(formatted);
      showActionError(formatted);
      return true;
    }
  }
  if (message.code === "HARVEST_TOO_EARLY") {
    const sessionId = message.details?.sessionId;
    const activeTask = harvestTaskRef.current;
    const pendingCompletion = pendingHarvestCompletionRef.current;
    if (
      typeof sessionId === "string" &&
      activeTask?.sessionId === sessionId &&
      pendingCompletion?.sessionId === sessionId &&
      (
        !message.requestId ||
        harvestRequestSentRef.current === message.requestId
      )
    ) {
      const retryAt = Date.now() + Math.max(
        HARVEST_COMPLETION_RETRY_MS,
        message.details?.retryAfterMs ?? 0
      );
      const retryingTask: HarvestTask = {
        ...activeTask,
        phase: "harvesting",
        completesAtMs: retryAt
      };
      harvestTaskRef.current = retryingTask;
      setHarvestTask(retryingTask);
      pendingHarvestCompletionRef.current = {
        ...pendingCompletion,
        requestId: null,
        lastAttemptAtMs: Date.now()
      };
      harvestRequestSentRef.current = null;
      setHarvestStatusAnnouncement("Finishing gatheringâ€¦");
      return true;
    }
  }
  return false;
}

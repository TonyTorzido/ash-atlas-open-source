import type {
  FlagReinforcementTarget,
  FlagServerMessage,
  FlagSnapshot,
  PlayerInventorySnapshot
} from "@ash-atlas/shared";
import type { Dispatch, SetStateAction } from "react";

import type { FlagBuildIntent } from "../../flags/flagBuildIntent.js";
import {
  createFlagBuildCountdown,
  type FlagBuildCountdown
} from "../../flags/flagBuildCountdown.js";
import { upsertFlagSnapshot } from "../../flags/flagDisplay.js";
import {
  formatServerWarning,
  removeFlagById
} from "../../flags/flagFrameUtilities.js";
import { flagDeductionFeedback } from "../../flags/flagMaterials.js";
import type {
  FlagPlacementValidationGate
} from "../../flags/flagPlacementValidation.js";
import type { PixiGameOverlay } from "../../map/pixiOverlay.js";
import { perfRecorder } from "../../perf/perfRecorder.js";
import { progressionRecorder } from "../../perf/progressionRecorder.js";
import {
  rememberCompletedFlagFeedback,
  type RefCell
} from "./flagSnapshotReconciliation.js";

export interface ActiveFlagBuild {
  buildId: string;
  requestId: string;
  countdown: FlagBuildCountdown;
  position: { lat: number; lon: number };
  flagName?: string;
  anchorKind?: "flag" | "buoy";
}

export interface ActiveFlagHardening {
  requestId: string;
  flagId: string;
  flagName: string;
  countdown: FlagBuildCountdown;
  position: { lat: number; lon: number };
  targetTier: FlagReinforcementTarget;
  targetTowerLevel?: number;
}

export interface QueuedFlagBuild {
  buildId: string;
  requestId: string;
  queuedAt: number;
  flagName?: string;
  anchorKind?: "flag" | "buoy";
}

type FlagBuildServerMessage = Extract<
  FlagServerMessage,
  {
    type:
      | "FLAG_BUILD_QUEUED"
      | "FLAG_BUILD_STARTED"
      | "FLAG_BUILD_CANCELLED"
      | "FLAG_REINFORCEMENT_STARTED"
      | "FLAG_REINFORCEMENT_CANCELLED"
      | "FLAG_CREATED";
  }
>;

export interface FlagBuildFrameHandlerOptions {
  ownPlayerId: string;
  overlayRef: RefCell<PixiGameOverlay | null>;
  flagPlacementValidationGateRef: RefCell<FlagPlacementValidationGate | null>;
  flagBuildIntentRef: RefCell<FlagBuildIntent | null>;
  setFlags: Dispatch<SetStateAction<FlagSnapshot[]>>;
  setFlagBuildQueued: Dispatch<SetStateAction<QueuedFlagBuild | null>>;
  setFlagPlacementPreviewActive: Dispatch<SetStateAction<boolean>>;
  setFlagBuild: Dispatch<SetStateAction<ActiveFlagBuild | null>>;
  setFlagHardening?: Dispatch<SetStateAction<ActiveFlagHardening | null>>;
  setFlagBuildClock: Dispatch<SetStateAction<number>>;
  setWarning: Dispatch<SetStateAction<string | null>>;
  receiveInventorySnapshot(inventory: PlayerInventorySnapshot): void;
  isFlagVisible?(flag: FlagSnapshot): boolean;
}

/** Owns construction attempts and their once-only completion presentation. */
export function handleFlagBuildFrame(
  message: FlagBuildServerMessage,
  options: FlagBuildFrameHandlerOptions & {
    activeFlagAttemptRef: RefCell<{ buildId: string; requestId: string } | null>;
    completedFlagFeedbackIdsRef: RefCell<Set<string>>;
  }
): void {
  const { activeFlagAttemptRef, completedFlagFeedbackIdsRef } = options;
  const {
    ownPlayerId,
    overlayRef,
    flagPlacementValidationGateRef,
    flagBuildIntentRef,
    setFlags,
    setFlagBuildQueued,
    setFlagPlacementPreviewActive,
    setFlagBuild,
    setFlagHardening,
    setFlagBuildClock,
    setWarning,
    receiveInventorySnapshot,
    isFlagVisible
  } = options;
  switch (message.type) {
    case "FLAG_BUILD_QUEUED": {
      const validation = flagPlacementValidationGateRef.current?.pending();
      if (validation && validation.requestId !== message.requestId) return;
      if (validation?.requestId === message.requestId) {
        flagPlacementValidationGateRef.current?.complete(message.requestId);
      }
      flagBuildIntentRef.current?.complete();
      activeFlagAttemptRef.current = {
        buildId: message.buildId,
        requestId: message.requestId
      };
      setFlagBuildQueued({
        buildId: message.buildId,
        requestId: message.requestId,
        queuedAt: message.queuedAt,
        anchorKind: message.anchorKind ?? "flag",
        ...(message.flagName ? { flagName: message.flagName } : {})
      });
      setFlagPlacementPreviewActive(false);
      setWarning(null);
      return;
    }
    case "FLAG_BUILD_STARTED": {
      const validation = flagPlacementValidationGateRef.current?.pending();
      const activeAttempt = activeFlagAttemptRef.current;
      if (
        validation &&
        validation.requestId !== message.requestId &&
        activeAttempt?.requestId !== message.requestId
      ) return;
      if (validation?.requestId === message.requestId) {
        perfRecorder.recordEvent("flag_build_started_received", {
          requestId: message.requestId,
          validationMs: Date.now() - validation.sentAt
        });
      }
      flagPlacementValidationGateRef.current?.complete(message.requestId);
      flagBuildIntentRef.current?.complete();
      activeFlagAttemptRef.current = {
        buildId: message.buildId,
        requestId: message.requestId
      };
      const buildStartedReceivedAt = performance.now();
      setFlagBuild({
        buildId: message.buildId,
        requestId: message.requestId,
        countdown: createFlagBuildCountdown(
          message,
          buildStartedReceivedAt
        ),
        position: message.position,
        anchorKind: message.anchorKind ?? "flag",
        ...(message.flagName ? { flagName: message.flagName } : {})
      });
      setFlagBuildQueued((current) =>
        current?.requestId === message.requestId ? null : current
      );
      setFlagBuildClock(buildStartedReceivedAt);
      return;
    }
    case "FLAG_BUILD_CANCELLED": {
      const validation = flagPlacementValidationGateRef.current?.pending();
      const matchesValidation = validation?.requestId === message.requestId;
      const matchesActive =
        activeFlagAttemptRef.current?.buildId === message.buildId &&
        activeFlagAttemptRef.current.requestId === message.requestId;
      if (!matchesValidation && !matchesActive) return;
      if (matchesValidation) {
        flagPlacementValidationGateRef.current?.complete(message.requestId);
      }
      flagBuildIntentRef.current?.complete();
      activeFlagAttemptRef.current = null;
      setFlagBuild((current) =>
        current?.buildId === message.buildId ? null : current
      );
      setFlagBuildQueued((current) =>
        current?.buildId === message.buildId ? null : current
      );
      return;
    }
    case "FLAG_REINFORCEMENT_STARTED": {
      const receivedAt = performance.now();
      setFlagHardening?.({
        requestId: message.requestId,
        flagId: message.flagId,
        flagName: message.flagName,
        countdown: createFlagBuildCountdown(message, receivedAt),
        position: message.position,
        targetTier: message.targetTier,
        ...(message.targetTowerLevel === undefined ? {} : { targetTowerLevel: message.targetTowerLevel })
      });
      setFlagBuildClock(receivedAt);
      return;
    }
    case "FLAG_REINFORCEMENT_CANCELLED":
      setFlagHardening?.((current) =>
        current?.requestId === message.requestId && current.flagId === message.flagId
          ? null
          : current
      );
      return;
    case "FLAG_CREATED": {
      const feedbackId =
        message.buildId ?? message.requestId ?? `flag:${message.flag.id}`;
      if (completedFlagFeedbackIdsRef.current.has(feedbackId)) return;
      rememberCompletedFlagFeedback(
        completedFlagFeedbackIdsRef.current,
        feedbackId
      );
      if (message.inventory) {
        receiveInventorySnapshot(message.inventory);
      }
      if (
        message.buildId &&
        message.inventory &&
        message.consumedMaterials?.length
      ) {
        for (const feedback of flagDeductionFeedback(
          message.consumedMaterials,
          message.inventory,
          ownPlayerId,
          `flag-build:${message.buildId}`
        )) {
          overlayRef.current?.enqueueFloatingFeedback(feedback);
        }
      }
      if (message.recoveredMaterials?.length) {
        overlayRef.current?.enqueueFloatingFeedback({ eventId: `${feedbackId}:materials-saved`, targetEntityId: ownPlayerId, kind: "profession_proc", amount: 1, label: "MATERIALS SAVED" });
        message.recoveredMaterials.forEach((material, index) => {
          overlayRef.current?.enqueueFloatingFeedback({
            eventId: `${feedbackId}:recovered:${material.itemId}:${index}`,
            targetEntityId: ownPlayerId,
            kind: "profession_proc",
            amount: material.quantity,
            ...(material.itemId === "wood" || material.itemId === "stone" ? { icon: material.itemId } : {}),
            label: `+${material.quantity} ${material.itemId.replaceAll("_", " ")}`
          });
        });
      }
      if (
        activeFlagAttemptRef.current?.buildId === message.buildId ||
        activeFlagAttemptRef.current?.requestId === message.requestId
      ) {
        activeFlagAttemptRef.current = null;
      }
      const receivedAt = Date.now();
      perfRecorder.recordEvent("flag_created_received", {
        requestId: message.requestId ?? null,
        buildId: message.buildId ?? null,
        serverToClientMs: message.serverTime === undefined
          ? null
          : receivedAt - message.serverTime
      });
      perfRecorder.recordEvent("flag_created", {
        flagId: message.flag.id,
        lat: message.flag.lat,
        lon: message.flag.lon
      });
      progressionRecorder.recordEvent({
        type: "flag_created",
        sourceId: message.flag.id
      });
      setFlags((current) => isFlagVisible?.(message.flag) === false
        ? removeFlagById(current, message.flag.id)
        : upsertFlagSnapshot(current, message.flag));
      setFlagBuild((current) =>
        !message.buildId || current?.buildId === message.buildId
          ? null
          : current
      );
      setWarning(
        message.warning ? formatServerWarning(message.warning) : null
      );
      window.requestAnimationFrame(() => {
        perfRecorder.recordEvent("flag_first_rendered", {
          requestId: message.requestId ?? null,
          buildId: message.buildId ?? null,
          receivedToRenderedMs: Date.now() - receivedAt,
          countdownRemainingMs: 0
        });
      });
      return;
    }
  }
  message satisfies never;
}

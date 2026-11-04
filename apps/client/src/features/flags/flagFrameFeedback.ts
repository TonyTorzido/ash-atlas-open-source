import type { FlagServerMessage, FlagSnapshot } from "@ash-atlas/shared";

import type { PixiGameOverlay } from "../../map/pixiOverlay.js";
import type { RefCell } from "./flagSnapshotReconciliation.js";

export function recordFlagFrameFeedback(input: Readonly<{
  feedbackFlagsRef: RefCell<Map<string, FlagSnapshot>>;
  message: FlagServerMessage;
  currentAuthorityKey: string;
  overlayRef?: RefCell<PixiGameOverlay | null>;
  isFlagVisible?: ((flag: FlagSnapshot) => boolean) | undefined;
}>): void {
  const {
    feedbackFlagsRef,
    message,
    currentAuthorityKey,
    overlayRef,
    isFlagVisible
  } = input;
  if ("flag" in message) {
    const previous = feedbackFlagsRef.current.get(message.flag.id);
    const flag = message.flag;
    if (isFlagVisible?.(flag) === false) {
      feedbackFlagsRef.current.delete(flag.id);
      return;
    }
    feedbackFlagsRef.current.set(flag.id, flag);
    if (
      previous?.health !== undefined
      && flag.health !== undefined
      && previous.health > flag.health
    ) {
      overlayRef?.current?.enqueueFloatingFeedback({
        eventId: `flag-health:${currentAuthorityKey}:${flag.id}:${"flagSetRevision" in message ? message.flagSetRevision : 0}:${previous.health}:${flag.health}`,
        targetEntityId: `flag:${flag.id}`,
        kind: "damage_other",
        amount: previous.health - flag.health,
        worldPosition: { lat: flag.lat, lon: flag.lon }
      });
    }
  } else if (message.type === "FLAG_DELETED") {
    const previous = feedbackFlagsRef.current.get(message.flagId);
    if (message.reason === "destroyed" && previous?.health && previous.health > 0) {
      overlayRef?.current?.enqueueFloatingFeedback({
        eventId: `flag-health:${currentAuthorityKey}:${message.flagId}:${message.flagSetRevision ?? 0}:${previous.health}:0`,
        targetEntityId: `flag:${message.flagId}`,
        kind: "damage_other",
        amount: previous.health,
        worldPosition: { lat: previous.lat, lon: previous.lon }
      });
    }
    feedbackFlagsRef.current.delete(message.flagId);
  } else if (message.type === "FLAGS_COLLAPSED") {
    for (const flagId of message.flagIds) feedbackFlagsRef.current.delete(flagId);
  }
}

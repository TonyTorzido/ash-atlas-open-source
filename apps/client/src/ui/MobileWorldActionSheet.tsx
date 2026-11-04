import type { ReactNode } from "react";

import {
  GameActionPrompt,
  type GamePromptAction,
  type GamePromptPresentationState
} from "./GameActionPrompt.js";

export type MobileWorldActionSheetProps = Readonly<{
  displayName: string;
  category?: string | null;
  artwork?: ReactNode;
  detail?: string | null;
  primaryActionLabel?: string | null;
  primaryActionEnabled?: boolean;
  middleActionLabel?: string | null;
  middleActionEnabled?: boolean;
  middleActionBusy?: boolean;
  middleDisabledReason?: string | null;
  secondaryActionLabel?: string | null;
  secondaryActionEnabled?: boolean;
  secondaryDisabledReason?: string | null;
  splitActionLayout?: boolean;
  disabledReason?: string | null;
  actionBusy?: boolean;
  /** Only this action is running: it alone shows busy, the others stay usable. */
  busyAction?: "primary" | "secondary" | null;
  errorMessage?: string | null;
  presentationState?: GamePromptPresentationState | undefined;
  actionsReady?: boolean;
  onPrimaryAction?(): void;
  onMiddleAction?(): void;
  onSecondaryAction?(): void;
  /** Extra actions after the standard ones (the active pet's targeted abilities). */
  extraActions?: readonly GamePromptAction[];
  /** Skills and abilities usable on this target, in split rows below the main bar. */
  skillActions?: readonly GamePromptAction[];
  /** Present while this target's action is running: Cancel stops it, then closes. */
  onCancelAction?(): void;
  onClose(): void;
}>;

export function MobileWorldActionSheet({
  displayName,
  category = null,
  artwork = null,
  detail = null,
  primaryActionLabel,
  primaryActionEnabled,
  middleActionLabel = null,
  middleActionEnabled = true,
  middleActionBusy = false,
  middleDisabledReason = null,
  secondaryActionLabel = null,
  secondaryActionEnabled = true,
  secondaryDisabledReason = null,
  splitActionLayout = false,
  disabledReason = null,
  actionBusy = false,
  busyAction = null,
  errorMessage = null,
  presentationState,
  actionsReady = true,
  onPrimaryAction,
  onMiddleAction,
  onSecondaryAction,
  onCancelAction,
  extraActions = [],
  skillActions = [],
  onClose
}: MobileWorldActionSheetProps): React.JSX.Element {
  const sharedActionBusy = actionBusy || middleActionBusy;
  return <GameActionPrompt
    compact
    dismissOnOutsideClick
    title={displayName}
    category={category}
    artwork={artwork}
    detail={detail}
    presentationState={presentationState}
    actionsReady={actionsReady}
    actionLayout={splitActionLayout ? "primary-quick" : "stacked"}
    message={errorMessage ? { text: errorMessage, tone: "error" } : null}
    actions={[
      ...(primaryActionLabel && onPrimaryAction ? [{
        key: "primary",
        label: primaryActionLabel,
        enabled: primaryActionEnabled ?? false,
        busy: sharedActionBusy || busyAction === "primary",
        disabledReason,
        onSelect: onPrimaryAction
      }] : []),
      ...(middleActionLabel && onMiddleAction ? [{
        key: "middle",
        label: middleActionLabel,
        enabled: middleActionEnabled,
        busy: sharedActionBusy,
        disabledReason: middleDisabledReason,
        onSelect: onMiddleAction
      }] : []),
      ...(secondaryActionLabel && onSecondaryAction ? [{
        key: "secondary",
        label: secondaryActionLabel,
        enabled: secondaryActionEnabled,
        busy: sharedActionBusy || busyAction === "secondary",
        disabledReason: secondaryDisabledReason ?? disabledReason,
        onSelect: onSecondaryAction
      }] : []),
      ...extraActions
    ]}
    skills={skillActions}
    cancelWhileBusy={Boolean(onCancelAction)}
    onCancel={() => {
      onCancelAction?.();
      onClose();
    }}
  />;
}

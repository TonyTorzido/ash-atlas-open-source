import { GameConfirmationPrompt } from "./GameActionPrompt.js";

export function ManorBuildPrompt({ open, busy, disabled, error, onBuild, onClose }: {
  open: boolean;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onBuild(): void;
  onClose(): void;
}): React.JSX.Element | null {
  if (!open) return null;
  return <GameConfirmationPrompt
    title="Build Manor Here?"
    category=""
    detail={error}
    content={error ? null : <>
      <p>Are you sure you want to build here?</p>
      <p>Your Manor can only stand in one place. Moving it later means taking it down and building again somewhere else.</p>
    </>}
    confirmLabel="Build Manor"
    confirmEnabled={!disabled}
    busy={busy}
    disabledReason={disabled ? "Reconnect to build a Manor." : null}
    onConfirm={onBuild}
    onCancel={onClose}
  />;
}

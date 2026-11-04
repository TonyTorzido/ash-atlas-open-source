import { GREENHOUSE_DESTROY_INTERACTION_RADIUS_M, type GreenhouseSnapshot } from "@ash-atlas/shared";

import { GameConfirmationPrompt } from "./GameActionPrompt.js";

export function GreenhouseDestroyPrompt({
  open,
  greenhouse,
  busy,
  disabled,
  error,
  onConfirm,
  onCancel
}: Readonly<{
  open: boolean;
  greenhouse: GreenhouseSnapshot | null;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onConfirm(): void;
  onCancel(): void;
}>): React.JSX.Element | null {
  if (!open || !greenhouse) return null;
  return <GameConfirmationPrompt
    title="Destroy Greenhouse?"
    detail={error ?? `Move within ${GREENHOUSE_DESTROY_INTERACTION_RADIUS_M}m of your Greenhouse.`}
    content={<p>Crops and tank water are lost. No material refund.</p>}
    confirmLabel="Destroy Greenhouse"
    confirmEnabled={!disabled}
    busy={busy}
    disabledReason={disabled ? "Move within range and reconnect before destroying." : null}
    destructive
    onConfirm={onConfirm}
    onCancel={onCancel}
  />;
}

import { GameConfirmationPrompt } from "./GameActionPrompt.js";

type ConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  tone?: "danger" | "primary";
  onCancel(): void;
  onConfirm(): void;
};

/** Compatibility adapter: every confirmation is the standard compact confirmation prompt. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy,
  tone = "danger",
  onCancel,
  onConfirm
}: ConfirmDialogProps): React.JSX.Element {
  return <GameConfirmationPrompt
    title={title}
    ariaLabel={title}
    category="CONFIRM"
    detail={message}
    confirmLabel={busy ? "Working" : confirmLabel}
    busy={busy}
    destructive={tone === "danger"}
    onConfirm={onConfirm}
    onCancel={onCancel}
  />;
}

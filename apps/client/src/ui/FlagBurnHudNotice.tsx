import type { ServerMessage } from "@ash-atlas/shared";

export function FlagBurnHudNotice({ notice }: Readonly<{
  notice: Extract<ServerMessage, { type: "FLAG_BURN_NOTICE" }>;
}>): React.JSX.Element {
  return <aside className="flag-burn-hud-notice" aria-label="Flag burn notice" role="status" aria-live="polite">
    <strong>Flag burn queued</strong>
    <span>{notice.message}</span>
  </aside>;
}

import type { ClientPortalPhase } from "./usePortalLocationController.js";

export function PortalTransitionOverlay({ phase, presentation }: {
  phase: ClientPortalPhase;
  presentation: string;
}) {
  const covered = phase === "covered" || phase === "committed" || phase === "revealing";
  if (!covered) return null;
  return <div
    className={`portal-transition-overlay portal-transition-${presentation} portal-transition-${phase}`}
    role="status"
    aria-label="Moving through portal"
  />;
}

import type { ManorOccupantAccessSource } from "@ash-atlas/shared";

import { DestinationShell } from "./DestinationShell.js";

export function ManorPanel({
  open,
  accessSource,
  online,
  pendingExit,
  layout,
  onOpenStorage,
  onManageGuests,
  onExit,
  onClose
}: {
  open: boolean;
  accessSource: ManorOccupantAccessSource;
  online: boolean;
  pendingExit: boolean;
  layout: "desktop" | "phone";
  onOpenStorage(): void;
  onManageGuests(): void;
  onExit(): void;
  onClose(): void;
}): React.JSX.Element | null {
  const owner = accessSource === "OWNER";
  return (
    <DestinationShell
      open={open}
      title="Manor"
      closeLabel="Close Manor"
      className="manor-destination"
      layout={layout}
      phoneBackLabel="Back to Game Menu"
      onClose={onClose}
    >
      <div className="manor-destination-grid">
        <button type="button" disabled={!online || !owner} onClick={onOpenStorage}>
          <strong>Manor Storage</strong>
          <small>{owner ? "Open when standing near the chest" : "Owner access only"}</small>
        </button>
        <button type="button" disabled={!online || !owner} onClick={onManageGuests}>
          <strong>Guest Management</strong>
          <small>{owner ? "Review, kick, ban, or unban visitors" : "Owner access only"}</small>
        </button>
        <button
          type="button"
          className="manor-destination-exit"
          disabled={!online || pendingExit}
          onClick={onExit}
        >
          <strong>{pendingExit ? "Leaving…" : "Exit Manor"}</strong>
          <small>Return to your authoritative world position</small>
        </button>
      </div>
    </DestinationShell>
  );
}

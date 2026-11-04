import type { ManorGuestManagementSnapshot } from "@ash-atlas/shared";

export function ManorGuestPanel({
  open,
  snapshot,
  disabled,
  onKick,
  onBan,
  onUnban,
  onClose
}: {
  open: boolean;
  snapshot: ManorGuestManagementSnapshot | null;
  disabled: boolean;
  onKick(playerId: string): void;
  onBan(playerId: string): void;
  onUnban(playerId: string): void;
  onClose(): void;
}): React.JSX.Element | null {
  if (!open || !snapshot) return null;
  return <aside className="interaction-prompt manor-guest-panel" aria-label="Manor Guests">
    <div className="interaction-prompt-title">Manor Guests</div>
    <div className="interaction-prompt-meta">{snapshot.guests.length} current guest{snapshot.guests.length === 1 ? "" : "s"}</div>
    <div className="manor-guest-list">
      {snapshot.guests.length === 0 ? <p className="muted">No guests are currently inside.</p> : snapshot.guests.map((guest) =>
        <div className="manor-guest-row" key={guest.playerId}>
          <span className="manor-guest-avatar" style={{ backgroundColor: guest.displayColor ?? "#8b7355" }} aria-hidden="true"/>
          <span><strong>{guest.displayName}</strong><small>{guest.accessSource === "PARTY" ? "Party" : "Travel Invite"}</small></span>
          <button type="button" disabled={disabled} onClick={() => onKick(guest.playerId)}>Kick</button>
          <button type="button" className="danger" disabled={disabled} onClick={() => onBan(guest.playerId)}>Ban</button>
        </div>)}
    </div>
    <div className="interaction-prompt-title manor-banned-title">Banned Players</div>
    <div className="manor-guest-list">
      {snapshot.bannedPlayers.length === 0 ? <p className="muted">No banned players.</p> : snapshot.bannedPlayers.map((player) =>
        <div className="manor-guest-row" key={player.playerId}>
          <span className="manor-guest-avatar" style={{ backgroundColor: player.displayColor ?? "#8b7355" }} aria-hidden="true"/>
          <span><strong>{player.displayName}</strong></span>
          <button type="button" disabled={disabled} onClick={() => onUnban(player.playerId)}>Unban</button>
        </div>)}
    </div>
    <div className="interaction-prompt-actions">
      <button type="button" className="secondary" onClick={onClose}>Close</button>
    </div>
  </aside>;
}

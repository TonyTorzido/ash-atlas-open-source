import {
  PERSONAL_FLAG_COLORS,
  PERSONAL_FLAG_COLOR_HEX
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

type TopBarProps = {
  connectionStatus: string;
  username: string;
  playerId: string;
  flagColor: string;
  colorBusy: boolean;
  travelInboxPendingCount?: number;
  unreadDirectMessageCount?: number;
  onFlagColorChange(color: string): void;
  onOpenProfile(): void;
  onOpenTravelInbox?(): void;
  onOpenMessages?(): void;
  onOpenPet?(): void;
  onOpenWorldMap?(): void;
  onOpenParty?(): void;
  onOpenTestAccess?(): void;
  onLogout(): void;
};

/** Compact account utility used by the communication bar. */
export function TopBar({
  connectionStatus,
  username,
  playerId,
  flagColor,
  colorBusy,
  travelInboxPendingCount = 0,
  unreadDirectMessageCount = 0,
  onFlagColorChange,
  onOpenProfile,
  onOpenTravelInbox,
  onOpenMessages,
  onOpenPet,
  onOpenWorldMap,
  onOpenParty,
  onOpenTestAccess,
  onLogout
}: TopBarProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div
      className="account-utility"
      ref={rootRef}
    >
      <span className={`status-dot status-${connectionStatus}`} aria-label={`Connection ${connectionStatus}`} />
      <button
          ref={triggerRef}
          type="button"
          className="account-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{username}</span><span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="account-popover" role="menu" aria-label="Player account">
          <div className="account-popover-identity">
            <strong>{username}</strong>
            <span className="mono">{playerId.slice(0, 8)}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenProfile(); }}>
            Profile
          </button>
          {onOpenTravelInbox ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenTravelInbox(); }}>
              Travel Inbox{travelInboxPendingCount > 0 ? ` (${travelInboxPendingCount})` : ""}
            </button>
          ) : null}
          {onOpenMessages ? (
            <button
              type="button"
              role="menuitem"
              aria-label={unreadDirectMessageCount > 0
                ? `Messages, ${unreadDirectMessageCount} unread`
                : "Messages"}
              onClick={() => { setOpen(false); onOpenMessages(); }}
            >
              Messages{unreadDirectMessageCount > 0 ? ` (${Math.min(99, unreadDirectMessageCount)}${unreadDirectMessageCount > 99 ? "+" : ""})` : ""}
            </button>
          ) : null}
          {onOpenPet ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenPet(); }}>
              Pet
            </button>
          ) : null}
          {onOpenWorldMap ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenWorldMap(); }}>
              World Map
            </button>
          ) : null}
          {onOpenParty ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenParty(); }}>
              Party
            </button>
          ) : null}
          {onOpenTestAccess ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenTestAccess();
              }}
            >
              Test Access
            </button>
          ) : null}
          <div className="flag-color-control">
            <span>Flag color</span>
            <div className="account-flag-colors" role="group" aria-label="Flag color">
              {PERSONAL_FLAG_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="account-flag-color"
                  aria-label={color}
                  aria-pressed={flagColor.toLowerCase() === PERSONAL_FLAG_COLOR_HEX[color]}
                  disabled={colorBusy || connectionStatus !== "online"}
                  style={{ "--account-flag-color": PERSONAL_FLAG_COLOR_HEX[color] } as React.CSSProperties}
                  onClick={() => onFlagColorChange(PERSONAL_FLAG_COLOR_HEX[color])}
                />
              ))}
            </div>
          </div>
          <button type="button" role="menuitem" className="top-logout" onClick={onLogout}>Sign out</button>
        </div>
      ) : null}
    </div>
  );
}

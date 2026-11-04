import { useEffect, useRef, useState } from "react";

type BottomActionBarProps = {
  onRecenter(): void;
  onToggleFlags(): void; onToggleTolls?(): void; onToggleProfile?(): void; onToggleCharacter?(): void; onToggleInventory(): void; onToggleKingdom(): void; onToggleMarket(): void;
  onToggleClasses(): void; onBuildManor(): void; onBuildGreenhouse?(): void; onDestroyGreenhouse?(): void; onBuildFurnace(): void; onBuildTannery?(): void; onBuildLoom?(): void;
  onTogglePet?(): void;
  onToggleLeaderboards?(): void;
  onToggleShop?(): void;
  worldActionsAvailable?: boolean; kingdomOpen: boolean; disabled: boolean; showBuildManor: boolean; showBuildGreenhouse?: boolean; greenhouseActionLabel?: string; showDestroyGreenhouse?: boolean; greenhouseDestroyDisabled?: boolean; showBuildFurnace: boolean; showBuildTannery?: boolean; showBuildLoom?: boolean;
};

export function BottomActionBar(props: BottomActionBarProps): React.JSX.Element {
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
  const worldActions = props.worldActionsAvailable !== false;
  const destination = (action: () => void) => (): void => { setOpen(false); action(); };
  return (
    <div className={`action-drawer${open ? " open" : ""}`} ref={rootRef}>
      {open ? (
        <section className="action-drawer-panel" aria-label="Gameplay actions">
          <div className="action-drawer-heading"><strong>Actions</strong><button type="button" onClick={() => setOpen(false)} className="menu-text-close" aria-label="Close actions">Close</button></div>
          <div className="action-drawer-groups">
            {worldActions ? <ActionGroup label="World">
              <button type="button" onClick={destination(props.onRecenter)}>Recenter</button>
            </ActionGroup> : null}
            <ActionGroup label="Character">
              {worldActions && props.showBuildManor ? <button type="button" disabled={props.disabled} onClick={destination(props.onBuildManor)}>Build Manor</button> : null}
              {worldActions && props.showBuildGreenhouse && props.onBuildGreenhouse ? <button type="button" disabled={props.disabled} onClick={destination(props.onBuildGreenhouse)}>{props.greenhouseActionLabel ?? "Build Greenhouse"}</button> : null}
              {worldActions && props.showDestroyGreenhouse && props.onDestroyGreenhouse ? <button type="button" disabled={props.disabled || props.greenhouseDestroyDisabled} onClick={destination(props.onDestroyGreenhouse)}>Destroy Greenhouse</button> : null}
              {worldActions && props.showBuildFurnace ? <button type="button" disabled={props.disabled} onClick={destination(props.onBuildFurnace)}>Build Furnace</button> : null}
              {worldActions && props.showBuildTannery && props.onBuildTannery ? <button type="button" disabled={props.disabled} onClick={destination(props.onBuildTannery)}>Build Tannery</button> : null}
              {worldActions && props.showBuildLoom && props.onBuildLoom ? <button type="button" disabled={props.disabled} onClick={destination(props.onBuildLoom)}>Build Loom</button> : null}
              {props.onToggleProfile ? <button type="button" onClick={destination(props.onToggleProfile)}>Profile</button> : null}
              {props.onToggleCharacter ? <button type="button" onClick={destination(props.onToggleCharacter)}>Character</button> : null}
              <button type="button" onClick={destination(props.onToggleInventory)}>Inventory <span className="key-hint">I</span></button>
              <button type="button" onClick={destination(props.onToggleClasses)}>Skills &amp; Professions</button>
              {props.onTogglePet ? <button type="button" onClick={destination(props.onTogglePet)}>Pets</button> : null}
              {props.onToggleLeaderboards ? <button type="button" onClick={destination(props.onToggleLeaderboards)}>Leaderboards</button> : null}
            </ActionGroup>
            <ActionGroup label="Realm">
              {worldActions ? <button type="button" onClick={destination(props.onToggleFlags)}>Flags</button> : null}
              <button type="button" className={props.kingdomOpen ? "active-action" : undefined} onClick={destination(props.onToggleKingdom)}>Kingdom</button>
            </ActionGroup>
            <ActionGroup label="Economy">
              <button type="button" onClick={destination(props.onToggleMarket)}>Market <span className="key-hint">M</span></button>
              {props.onToggleShop ? <button type="button" onClick={destination(props.onToggleShop)}>Shop</button> : null}
              {worldActions && props.onToggleTolls ? <button type="button" onClick={destination(props.onToggleTolls)}>Tolls</button> : null}
            </ActionGroup>
          </div>
        </section>
      ) : null}
      <button ref={triggerRef} type="button" className="action-drawer-trigger" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Actions <span aria-hidden="true">{open ? "▼" : "▲"}</span></button>
    </div>
  );
}

function ActionGroup({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="action-drawer-group"><span>{label}</span><div>{children}</div></div>;
}

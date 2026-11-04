import type { ManorWorldSnapshot } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import type { GamePromptAction } from "./GameActionPrompt.js";

export function ManorPrompt({
  open,
  manor,
  ownPlayerId,
  jumping,
  entering,
  destroying,
  disabled,
  canEnter,
  entryDisabledReason,
  error,
  onJump,
  onEnter,
  onManage,
  onManageUpgrades,
  onDestroy,
  onClose,
  warfareDetail = null,
  warfareActions = []
}: {
  /** Manor warfare HP / burn line ("2,400 / 4,400 HP · Burning"); null at full health. */
  warfareDetail?: string | null;
  /** Attack (visitors) or Repair / Stop Repair (owner). */
  warfareActions?: readonly GamePromptAction[];
  manor: ManorWorldSnapshot | null;
  ownPlayerId: string;
  open: boolean;
  jumping: boolean;
  entering: boolean;
  destroying: boolean;
  disabled: boolean;
  canEnter: boolean;
  entryDisabledReason: string | null;
  error: string | null;
  onJump(): void;
  onEnter(): void;
  onManage(): void;
  onManageUpgrades?(): void;
  onDestroy(): void;
  onClose(): void;
}): React.JSX.Element | null {
  const [confirmingDestroy, setConfirmingDestroy] = useState(false);
  useEffect(() => { setConfirmingDestroy(false); }, [manor?.manorId, open]);
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !jumping && !entering && !destroying) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [destroying, entering, jumping, onClose, open]);
  if (!open || !manor) return null;
  const owner = manor.ownerPlayerId === ownPlayerId;
  return <aside className="interaction-prompt manor-prompt" aria-live="polite"
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <div className="interaction-prompt-title">{manor.ownerUsername}'s Manor</div>
    <div className="interaction-prompt-meta">Owner: {manor.ownerUsername}</div>
    {warfareDetail ? <div className="interaction-prompt-meta">{warfareDetail}</div> : null}
    {confirmingDestroy ? <>
      <p className="interaction-prompt-warning">Destroying removes the physical manor from the world. You can rebuild it elsewhere inside territory you own. Stored items are preserved, but storage cannot be entered again until rebuilding.</p>
      {error ? <p className="manor-error" role="alert">{error}</p> : null}
      <div className="interaction-prompt-actions">
        <button type="button" className="danger" disabled={disabled || destroying} onClick={onDestroy}>
          {destroying ? "Destroying…" : "Confirm Destroy"}
        </button>
        <button type="button" className="secondary" disabled={destroying} onClick={() => setConfirmingDestroy(false)}>Keep Manor</button>
      </div>
    </> : <>
      <div className="interaction-prompt-meta">{owner
        ? "Travel outside, enter on foot, or manage current guests."
        : canEnter ? "You have permission to enter this manor." : "You do not currently have manor access."}</div>
      {!canEnter && entryDisabledReason ? <div className="interaction-prompt-meta">{entryDisabledReason}</div> : null}
      {error ? <p className="manor-error" role="alert">{error}</p> : null}
      <div className="interaction-prompt-actions">
        {owner ? <button type="button" disabled={disabled || jumping || entering || destroying} onClick={onJump}>
          {jumping ? "Traveling to manor…" : "Travel to Manor"}
        </button> : null}
        {canEnter ? <button type="button" disabled={disabled || jumping || entering || destroying} onClick={onEnter}>
          {entering ? "Entering…" : "Enter Manor"}
        </button> : <button type="button" disabled title={entryDisabledReason ?? undefined}>Enter Manor</button>}
        {warfareActions.map((action) => <button
          key={action.key}
          type="button"
          className={action.tone === "danger" ? "danger" : action.tone === "secondary" ? "secondary" : undefined}
          disabled={action.enabled === false || jumping || entering || destroying}
          title={action.disabledReason ?? undefined}
          onClick={action.onSelect}
        >{action.label}</button>)}
        {owner ? <button type="button" disabled={disabled || jumping || entering || destroying} onClick={onManage}>Manage Manor</button> : null}
        {owner && onManageUpgrades ? <button type="button" disabled={disabled || jumping || entering || destroying} onClick={onManageUpgrades}>Manor Upgrades</button> : null}
        {owner ? <button type="button" className="danger" disabled={disabled || jumping || entering || destroying}
          onClick={() => setConfirmingDestroy(true)}>Destroy Manor</button> : null}
        <button type="button" className="secondary" disabled={jumping || destroying} onClick={onClose}>Cancel</button>
      </div>
    </>}
  </aside>;
}

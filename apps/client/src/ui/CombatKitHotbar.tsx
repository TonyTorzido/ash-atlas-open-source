import {
  COMBAT_KIT_INDICES,
  type CombatKitIndex,
  type CombatKitInvalidReason,
  type CombatKitSnapshot
} from "@ash-atlas/shared";
import { useEffect, useMemo } from "react";

type Props = {
  kits: readonly CombatKitSnapshot[];
  activeKitIndex: CombatKitIndex | null;
  pendingKitIndex: CombatKitIndex | null;
  disabled: boolean;
  disabledReason?: string;
  onActivate(kitIndex: CombatKitIndex): void;
};

export function CombatKitHotbar({
  kits,
  activeKitIndex,
  pendingKitIndex,
  disabled,
  disabledReason = "Equipment is unavailable.",
  onActivate
}: Props): React.JSX.Element {
  const kitsByIndex = useMemo(
    () => new Map(kits.map((kit) => [kit.kitIndex, kit])),
    [kits]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const kitIndex = combatKitShortcutIndex(event);
      if (kitIndex === null) return;
      const kit = kitsByIndex.get(kitIndex);
      if (disabled || pendingKitIndex !== null || !kit?.valid) return;
      event.preventDefault();
      onActivate(kitIndex);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, kitsByIndex, onActivate, pendingKitIndex]);

  return (
    <section className="combat-kit-hotbar" aria-label="Combat kits">
      {COMBAT_KIT_INDICES.map((kitIndex) => {
        const kit = kitsByIndex.get(kitIndex);
        const active = activeKitIndex === kitIndex;
        const pending = pendingKitIndex === kitIndex;
        const reason = !kit
          ? "Waiting for equipment snapshot."
          : !kit.valid
            ? combatKitInvalidReasonLabel(kit.invalidReason)
            : disabled
              ? disabledReason
              : pendingKitIndex !== null && !pending
                ? "Another kit activation is pending."
                : null;
        const unavailable = reason !== null || pending;
        const status = pending
          ? "Switching…"
          : active
            ? "Active"
            : kit?.valid
              ? `Shift+${kitIndex}`
              : "Invalid";
        const name = kit?.name ?? `Kit ${kitIndex}`;

        return (
          <button
            key={kitIndex}
            type="button"
            className={`combat-kit-button${active ? " active" : ""}${pending ? " pending" : ""}`}
            aria-label={`${name}: ${reason ?? status}`}
            aria-pressed={active}
            disabled={unavailable}
            title={reason ?? `Activate ${name} (Shift+${kitIndex})`}
            onClick={() => onActivate(kitIndex)}
          >
            <span aria-hidden="true">{kitIndex}</span>
            <strong>{name}</strong>
            <small>{status}</small>
          </button>
        );
      })}
    </section>
  );
}

export function combatKitShortcutIndex(event: KeyboardEvent): CombatKitIndex | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    !event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    isEditableTarget(event.target)
  ) {
    return null;
  }
  const match = /^Digit([1-6])$/.exec(event.code);
  return match ? Number(match[1]) as CombatKitIndex : null;
}

export function combatKitInvalidReasonLabel(
  reason: CombatKitInvalidReason | null
): string {
  switch (reason) {
    case "incomplete": return "Save equipped items to this kit first.";
    case "missing_item": return "A saved item is missing.";
    case "not_owned": return "A saved item is no longer owned.";
    case "not_carried": return "A saved item is not in your Inventory or equipped.";
    case "destroyed": return "A saved item was destroyed.";
    case "duplicate_item": return "The same item cannot fill two slots.";
    case "slot_incompatible": return "A saved item is incompatible with its slot.";
    case "secondary_not_ranged_or_shield": return "Secondary must be a ranged weapon or shield.";
    case "readied_secondary_not_ranged": return "Only a ranged secondary can be readied.";
    case "character_level_required": return "A saved item requires a higher character level.";
    case "achievement_required": return "Bitter Blood is required to use a Venom item.";
    case null: return "This kit is unavailable.";
  }
}

export { reconcileEquipmentSnapshot } from "../features/combatEquipment/equipmentSnapshotAcceptance.js";

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

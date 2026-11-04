import { findKeyboardMovementBlock } from "../gamepad/gamepadScope.js";
import {
  isLaunchClassId,
  type ClassCombatState,
  type ClassSnapshot,
  type EquipmentSnapshot,
  type PartyInviteSnapshot,
  type PartySnapshot,
  type PveCombatSessionSnapshot,
  type TechniqueDefinition
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import {
  buildClassCombatControlModel,
  dynamicAbilityName,
  type ClassAbilityTargetOption,
  type ClassAbilityTargetSelection,
  type ClassCombatSlotModel
} from "./classCombatControlModel.js";
import { ClassAbilityIcon } from "./ClassAbilityIcon.js";
import { GameActionPrompt } from "./GameActionPrompt.js";

export {
  dynamicAbilityName,
  resolveClassAbilityTarget,
  type ClassAbilityTargetOption,
  type ClassAbilityTargetSelection
} from "./classCombatControlModel.js";

export type WarriorShortcutAction =
  | { kind: "reset" | "normal"; abilityId: string }
  | { kind: "taunt" };

export function warriorShortcutAction(
  key: string,
  snapshot: ClassSnapshot | null
): WarriorShortcutAction | null {
  if (!snapshot || snapshot.activeClassId !== "warrior") return null;
  if (key !== "1" && key !== "2") return null;
  const abilityId = snapshot.loadout.normalActives[Number(key) - 1];
  return abilityId ? { kind: "normal", abilityId } : null;
}

export function ownedLegacyClassShortcutAction(
  key: string,
  snapshot: ClassSnapshot | null,
  launchQuickSlotsMounted: boolean
): WarriorShortcutAction | null {
  if (launchQuickSlotsMounted && snapshot && isLaunchClassId(snapshot.activeClassId)) return null;
  return warriorShortcutAction(key, snapshot);
}

type Props = {
  snapshot: ClassSnapshot | null;
  combat: ClassCombatState | null;
  equipment: EquipmentSnapshot | null;
  pveCombat: PveCombatSessionSnapshot | null;
  disabled: boolean;
  disabledReason?: string | null;
  synchronizedNow(): number;
  party?: PartySnapshot | null;
  partyInvites?: readonly PartyInviteSnapshot[];
  partyPlayers?: readonly ClassAbilityTargetOption[];
  partyPlayerNames?: Readonly<Record<string, string>>;
  targetSelection?: ClassAbilityTargetSelection | null;
  friendlyTargets?: readonly ClassAbilityTargetOption[];
  activationLockoutEndsAt?: number;
  onCreateParty?(): void;
  onInvitePartyMember?(targetPlayerId: string): void;
  onAcceptPartyInvite?(partyId: string): void;
  onDeclinePartyInvite?(partyId: string): void;
  onRemovePartyMember?(targetPlayerId: string): void;
  onLeaveParty?(): void;
  onChangePartyLeader?(targetPlayerId: string): void;
  onSetPartyTravelAllowed?(allowed: boolean): void;
  onSetPartyAutoFollow?(enabled: boolean): void;
  onTravelToPartyLeader?(): void;
  onMessagePlayer?(targetPlayerId: string, displayName: string): void;
  onTargetSelectionChange?(target: ClassAbilityTargetSelection): void;
  onUseNormal(abilityId: string, target?: ClassAbilityTargetSelection, targetPosition?: { lat: number; lon: number }): void;
  onBeginDragTarget?(kind: "normal", definition: TechniqueDefinition, point: { x: number; y: number } | null): void;
  onUseReset(abilityId: string, target?: ClassAbilityTargetSelection): void;
  onTaunt(): void;
};

type Details = TechniqueDefinition;
const SKILL_HOTKEYS = ["Q", "W", "E", "R", "T", "U"] as const;

export function ClassQuickSlots({ snapshot, combat, equipment, pveCombat, disabled, disabledReason = null, synchronizedNow, targetSelection, friendlyTargets = [], activationLockoutEndsAt = 0, onUseNormal, onUseReset, onBeginDragTarget }: Props): React.JSX.Element | null {
  const [serverNow, setServerNow] = useState(() => synchronizedNow());
  const [details, setDetails] = useState<Details | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const hotkeyButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const timer = window.setInterval(() => setServerNow(synchronizedNow()), 100);
    return () => window.clearInterval(timer);
  }, [synchronizedNow]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const slotIndex = skillHotkeySlot(event);
      if (slotIndex === null || shouldIgnoreSkillHotkey(event)) return;
      const button = hotkeyButtonRefs.current[slotIndex];
      if (!button) return;
      event.preventDefault();
      longPressed.current = false;
      button.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!snapshot) return null;
  const isLaunchClass = isLaunchClassId(snapshot.activeClassId);
  const controlModel = buildClassCombatControlModel({
    snapshot,
    combat,
    equipmentAvailable: equipment !== null,
    weaponCategory: equipment?.weapon?.weaponCategory ?? null,
    pveCombat,
    disabled,
    disabledReason,
    targetSelection,
    friendlyTargets,
    serverNow,
    activationLockoutEndsAt
  });
  const clearLongPress = (): void => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  const longPress = (
    value: Details,
    slot: ClassCombatSlotModel,
    onUse: (abilityId: string, target?: ClassAbilityTargetSelection) => void
  ): void => {
    longPressed.current = false;
    longPressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      if (slot.singleTargetSupport && slot.selfTargetAvailable) {
        onUse(value.id, { mode: "self", targetEntityId: snapshot.playerId });
      } else {
        setDetails(value);
      }
    }, 500);
  };
  const detailTitle = details ? dynamicAbilityName(details.id, controlModel.weaponMode, details.name) : "";
  const detailText = details
    ? `${details.description} ${isLaunchClass ? "" : `${controlModel.resourceName}: ${details.resourceCost} · `}Cooldown: ${details.cooldownMs / 1_000}s · Target: ${abilityTargetLabel(details)}.`
    : "";

  return <>
    <aside className="warrior-combat-controls class-combat-controls" aria-label={`${controlModel.className} combat actions`}>
      {!isLaunchClass ? <div className="rage-meter class-resource-meter" aria-label={`${controlModel.resourceAmount} of ${controlModel.resourceMaximum} ${controlModel.resourceName}`}><span style={{ width: `${controlModel.resourceAmount / controlModel.resourceMaximum * 100}%` }} /><strong>{controlModel.resourceAmount} {controlModel.resourceName}</strong></div> : null}
      {!isLaunchClass ? <div className="warrior-reset-slots" aria-label="Next-attack empowers">
        {controlModel.resetSlots.map((slot, index) => (
          <AbilityButton
            key={`reset-${index}`}
            slot={slot}
            shortcut={String(index + 1)}
            category="attack empower"
            pendingLabel="Armed"
            resourceName={controlModel.resourceName}
            hotkey={SKILL_HOTKEYS[index]!}
            buttonRef={(button) => { hotkeyButtonRefs.current[index] = button; }}
            onPointerDown={(definition) => longPress(definition, slot, onUseReset)}
            onPointerEnd={clearLongPress}
            onClick={(definition, target) => {
              if (!longPressed.current) onUseReset(definition.id, target ?? undefined);
            }}
          />
        ))}
      </div> : null}
      <div className="warrior-normal-slots" aria-label={isLaunchClass ? `${controlModel.className} class skills` : "Normal actives"}>
        {controlModel.normalSlots.map((slot, index) => (
          <AbilityButton
            key={`normal-${index}`}
            slot={slot}
            shortcut={isLaunchClass ? String(index + 1) : String(index + 3)}
            category={isLaunchClass ? "class skill" : "active technique"}
            pendingLabel="Buffered"
            resourceName={controlModel.resourceName}
            hotkey={SKILL_HOTKEYS[isLaunchClass ? index : index + 2]!}
            buttonRef={(button) => { hotkeyButtonRefs.current[isLaunchClass ? index : index + 2] = button; }}
            onPointerDown={(definition) => longPress(definition, slot, onUseNormal)}
            onBeginDrag={(definition, point) => onBeginDragTarget?.("normal", definition, point)}
            onPointerEnd={clearLongPress}
            onClick={(definition, target) => {
              if (!longPressed.current) onUseNormal(definition.id, target ?? undefined);
            }}
          />
        ))}
      </div>
      {controlModel.statusIndicators.length > 0 ? <div className="class-status-indicators" aria-label="Class combat effects">
        {controlModel.statusIndicators.map((status) => <span key={status.id}>{status.text}{status.remainingMs === null ? "" : ` · ${Math.ceil(status.remainingMs / 1_000)}s`}</span>)}
      </div> : null}
    </aside>
    {details ? <GameActionPrompt
      title={detailTitle}
      category="ABILITY"
      detail={detailText}
      actions={[]}
      cancelLabel="Close"
      dismissOnOutsideClick
      onCancel={() => setDetails(null)}
    /> : null}
  </>;
}

function AbilityButton({ slot, shortcut, category, pendingLabel, resourceName, hotkey, buttonRef, onPointerDown, onBeginDrag, onPointerEnd, onClick }: {
  slot: ClassCombatSlotModel;
  shortcut: string;
  category: "attack empower" | "active technique" | "class skill";
  pendingLabel: string;
  resourceName: string;
  hotkey: string;
  buttonRef(button: HTMLButtonElement | null): void;
  onPointerDown(value: Details): void;
  onBeginDrag?(value: Details, point: { x: number; y: number } | null): void;
  onPointerEnd(): void;
  onClick(definition: TechniqueDefinition, target: ClassAbilityTargetSelection | null): void;
}): React.JSX.Element {
  const dragStarted = useRef(false);
  const definition = slot.definition;
  const targetsSelectedAlly = slot.singleTargetSupport
    && slot.target?.mode === "friendly"
    && !slot.disabled;
  const readyDetail = category === "class skill"
    ? definition?.id === "warrior_empowered_hit" || definition?.id === "warrior_anger_explosion" ? "Up to 10 HP" : "Ready"
    : definition ? definition.resourceCost > 0 ? `${definition.resourceCost} ${resourceName}` : "Ready" : "Empty";
  return <button ref={buttonRef} type="button" className={`warrior-quick-slot${slot.pending ? " queued" : ""}${targetsSelectedAlly ? " is-friendly-targeted" : ""}`} data-locked={slot.locked || undefined} data-empty={!definition && !slot.locked || undefined} data-friendly-targeted={targetsSelectedAlly || undefined} aria-disabled={slot.disabled} aria-keyshortcuts={`${shortcut} ${hotkey}`} aria-label={abilityControlLabel(slot, category, resourceName)} onPointerDown={(event) => { dragStarted.current = false; if (!definition || slot.disabled) return; if (definition.activation === "drag") { dragStarted.current = true; onBeginDrag?.(definition, { x: event.clientX, y: event.clientY }); } else onPointerDown(definition); }} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onClick={() => { if (!definition || slot.disabled) return; if (definition.activation === "drag") { if (!dragStarted.current) onBeginDrag?.(definition, null); dragStarted.current = false; } else onClick(definition, slot.target); }}><span className="ability-icon" aria-hidden="true"><ClassAbilityIcon abilityId={slot.id} /></span><span className="ability-slot-copy"><strong>{slot.locked ? `Rank ${slot.lockLevel}` : slot.name}</strong><small>{slot.locked ? "Locked" : slot.pending ? pendingLabel : definition ? slot.unavailableText ?? (definition.activation === "armed" ? "Arms next scheduled attack" : targetsSelectedAlly ? "Ally · Hold for self" : readyDetail) : "Empty"}</small></span><kbd className="ability-hotkey" aria-hidden="true">{hotkey}</kbd>{slot.cooldownMs > 0 ? <span className="cooldown-overlay">{Math.ceil(slot.cooldownMs / 1_000)}</span> : null}</button>;
}

export function skillHotkeySlot(event: Pick<KeyboardEvent, "code" | "key">): number | null {
  const value = /^Key[QWERTU]$/.test(event.code) ? event.code.slice(3) : event.key.toUpperCase();
  const index = SKILL_HOTKEYS.indexOf(value as typeof SKILL_HOTKEYS[number]);
  return index < 0 ? null : index;
}

function abilityControlLabel(
  slot: ClassCombatSlotModel,
  category: "attack empower" | "active technique" | "class skill",
  resourceName: string
): string {
  const categoryName = category === "attack empower" ? "Attack Empower" : category === "class skill" ? "Class Skill" : "Active Technique";
  if (!slot.definition) return slot.locked
    ? `${categoryName}, unlocks at Warrior Rank ${slot.lockLevel}`
    : `Empty ${categoryName}`;
  const named = `${slot.name}, ${category}`;
  if (slot.locked) return `${named}, unlocks at Warrior Rank ${slot.lockLevel}`;
  if (slot.pending) return `${named}, waiting for next scheduled attack`;
  if (slot.cooldownMs > 0) return `${named}, cooldown ${Math.ceil(slot.cooldownMs / 1_000)} seconds`;
  if (slot.unavailableText) return `${named}, ${slot.unavailableText.toLowerCase()}`;
  if (slot.insufficientResource) return `${named}, insufficient ${resourceName.toLowerCase()}`;
  if (slot.singleTargetSupport && slot.target?.mode === "friendly") {
    return `${named}, targeting selected party member, hold for self`;
  }
  return slot.singleTargetSupport
    ? `${named}, targeting self`
    : `${named}, ready`;
}

export function shouldIgnoreSkillHotkey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return true;
  if (isEditableElement(event.target)) return true;
  // Yield only to a real modal or the open Game Menu; chat and other non-modal windows keep the keys live.
  return findKeyboardMovementBlock("") !== null;
}

function isEditableElement(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
  );
}

export const WarriorQuickSlots = ClassQuickSlots;

function techniqueTargetType(definition: TechniqueDefinition): "hostile" | "friendly" | "self" | "friendly_or_hostile" {
  if (!("targetType" in definition)) return "hostile";
  const value = definition.targetType;
  return value === "friendly" || value === "self" || value === "friendly_or_hostile" ? value : "hostile";
}

function abilityTargetLabel(definition: TechniqueDefinition): string {
  const targetType = techniqueTargetType(definition);
  if (targetType === "self") return "Self";
  if (targetType === "friendly") return "Self or eligible participating ally";
  if (targetType === "friendly_or_hostile") return "Selected friendly target or focused enemy";
  return "Focused enemy";
}

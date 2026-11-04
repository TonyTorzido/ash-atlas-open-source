import type { TechniqueDefinition } from "@ash-atlas/shared";
import type {
  ClassCombatState,
  ClassSnapshot,
  EquipmentSnapshot,
  EquipmentSnapshotV2,
  PveCombatSessionSnapshot
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import {
  buildClassCombatControlModel,
  type ClassAbilityTargetOption,
  type ClassAbilityTargetSelection,
  type ClassCombatSlotModel
} from "./classCombatControlModel.js";
import { ClassAbilityIcon } from "./ClassAbilityIcon.js";
import { shouldIgnoreSkillHotkey, skillHotkeySlot } from "./WarriorQuickSlots.js";

export type PhoneCombatControlsProps = {
  snapshot: ClassSnapshot | null;
  combat: ClassCombatState | null;
  equipment: EquipmentSnapshot | EquipmentSnapshotV2 | null;
  pveCombat: PveCombatSessionSnapshot | null;
  disabled: boolean;
  synchronizedNow(): number;
  disabledReason?: string | null;
  targetSelection?: ClassAbilityTargetSelection | null | undefined;
  friendlyTargets?: readonly ClassAbilityTargetOption[];
  activationLockoutEndsAt?: number;
  onUseNormal(abilityId: string, target?: ClassAbilityTargetSelection, targetPosition?: { lat: number; lon: number }): void;
  onBeginDragTarget?(kind: "normal", definition: TechniqueDefinition, point: { x: number; y: number } | null): void;
  onUseReset(abilityId: string, target?: ClassAbilityTargetSelection): void;
  onTaunt(): void;
};

type WarriorSkillCategory = "attack empower" | "active technique" | "class skill";

export function PhoneCombatControls({
  snapshot,
  combat,
  equipment,
  pveCombat,
  disabled,
  synchronizedNow,
  disabledReason = null,
  targetSelection,
  friendlyTargets = [],
  activationLockoutEndsAt = 0,
  onUseNormal,
  onBeginDragTarget
}: PhoneCombatControlsProps): React.JSX.Element {
  const [serverNow, setServerNow] = useState(() => synchronizedNow());
  const hotkeyButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const timer = window.setInterval(() => setServerNow(synchronizedNow()), 100);
    return () => window.clearInterval(timer);
  }, [synchronizedNow]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const slotIndex = skillHotkeySlot(event);
      const buttonIndex = slotIndex === 0 ? 0 : slotIndex === 1 ? 1 : null;
      if (buttonIndex === null || shouldIgnoreSkillHotkey(event)) return;
      const button = hotkeyButtonRefs.current[buttonIndex];
      if (!button) return;
      event.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const model = snapshot
    ? buildClassCombatControlModel({
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
      })
    : null;
  const normalCategory = snapshot?.activeClassId === "warrior" ? "class skill" as const : "active technique" as const;
  const slots = model
      ? [
          { slot: model.normalSlots[0] ?? null, category: normalCategory, onUse: onUseNormal },
          { slot: model.normalSlots[1] ?? null, category: normalCategory, onUse: onUseNormal }
        ]
    : [
        { slot: null, category: "active technique" as const, onUse: onUseNormal },
        { slot: null, category: "active technique" as const, onUse: onUseNormal }
      ];

  return (
    <>
      {slots.map(({ slot, category, onUse }, index) => (
        <CompactSkillButton
          key={`${category}-${index}`}
          index={index}
          slot={slot}
          category={category}
          className={model?.className ?? null}
          resourceName={model?.resourceName ?? null}
          selfPlayerId={snapshot?.playerId ?? null}
          showResourcePerimeter={false}
          buttonRef={(button) => { hotkeyButtonRefs.current[index] = button; }}
          onUse={onUse}
          onBeginDrag={(definition, point) => onBeginDragTarget?.("normal", definition, point)}
        />
      ))}
      {model?.statusIndicators.length ? <div className="phone-class-status-indicators" aria-label="Class combat effects">
        {model.statusIndicators.map((status) => <span key={status.id}>{status.text}{status.remainingMs === null ? "" : ` · ${Math.ceil(status.remainingMs / 1_000)}s`}</span>)}
      </div> : null}
    </>
  );
}
function CompactSkillButton({
  index,
  slot,
  category,
  className,
  resourceName,
  selfPlayerId,
  showResourcePerimeter,
  onUse,
  onBeginDrag,
  buttonRef
}: {
  index: number;
  slot: ClassCombatSlotModel | null;
  category: WarriorSkillCategory;
  className: string | null;
  resourceName: string | null;
  selfPlayerId: string | null;
  showResourcePerimeter: boolean;
  onUse(abilityId: string, target?: ClassAbilityTargetSelection): void;
  onBeginDrag?(definition: TechniqueDefinition, point: { x: number; y: number } | null): void;
  buttonRef(button: HTMLButtonElement | null): void;
}): React.JSX.Element {
  const longPressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const dragStarted = useRef(false);
  const label = skillLabel(slot, category, className, resourceName, showResourcePerimeter);
  const resourceProgress = showResourcePerimeter ? slot?.resourceProgress ?? null : null;
  const targetsSelectedAlly = Boolean(
    slot?.singleTargetSupport && slot.target?.mode === "friendly" && !slot.disabled
  );
  const clearLongPress = (): void => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  useEffect(() => () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
  }, []);
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`legacy-control-button legacy-skill-button legacy-skill-${index === 0 ? "one" : "two"}-button${slot?.pending ? " queued" : ""}${targetsSelectedAlly ? " is-friendly-targeted" : ""}`}
      aria-label={label}
      title={label}
      aria-keyshortcuts={index === 0 ? "Q" : "W"}
      aria-disabled={!slot || slot.disabled}
      data-empty={!slot?.definition || undefined}
      data-locked={slot?.locked || undefined}
      data-resource-progress={resourceProgress ?? undefined}
      data-actually-ready={(resourceProgress !== null && slot?.isActuallyReady) || undefined}
      data-friendly-targeted={targetsSelectedAlly || undefined}
      onPointerDown={(event) => {
        longPressed.current = false;
        dragStarted.current = false;
        if (!slot || slot.disabled) return;
        if (slot?.definition?.activation === "drag") {
          dragStarted.current = true;
          onBeginDrag?.(slot.definition, { x: event.clientX, y: event.clientY });
          return;
        }
        if (!slot?.id || !selfPlayerId || !slot.singleTargetSupport || !slot.selfTargetAvailable) return;
        longPressTimer.current = window.setTimeout(() => {
          longPressed.current = true;
          onUse(slot.id!, { mode: "self", targetEntityId: selfPlayerId });
        }, 500);
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onClick={() => {
        if (!slot?.id || slot.disabled) return;
        if (slot.definition?.activation === "drag") {
          if (!dragStarted.current) onBeginDrag?.(slot.definition, null);
          dragStarted.current = false;
          return;
        }
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        if (!slot.disabled) {
          onUse(slot.id, slot.target ?? undefined);
        }
      }}
    >
      <span className="legacy-skill-glyph" aria-hidden="true">
        <ClassAbilityIcon abilityId={slot?.id ?? null} />
      </span>
      {slot && slot.cooldownMs > 0 ? (
        <span className="legacy-cooldown-overlay" aria-hidden="true">
          {Math.ceil(slot.cooldownMs / 1_000)}
        </span>
      ) : null}
      {resourceProgress !== null ? (
        <ResourcePerimeter progress={resourceProgress} ready={slot?.isActuallyReady ?? false} />
      ) : null}
    </button>
  );
}

const RESOURCE_PERIMETER_PATH = "M22 1.5 H35.5 A7 7 0 0 1 42.5 8.5 V35.5 A7 7 0 0 1 35.5 42.5 H8.5 A7 7 0 0 1 1.5 35.5 V8.5 A7 7 0 0 1 8.5 1.5 Z";

function ResourcePerimeter({ progress, ready }: {
  progress: number;
  ready: boolean;
}): React.JSX.Element {
  return <svg
    className={`legacy-resource-perimeter${ready ? " ready" : ""}`}
    viewBox="0 0 44 44"
    aria-hidden="true"
    focusable="false"
  >
    <path className="legacy-resource-track" d={RESOURCE_PERIMETER_PATH} pathLength="100" />
    <path
      className="legacy-resource-fill"
      d={RESOURCE_PERIMETER_PATH}
      pathLength="100"
      style={{ strokeDasharray: 100, strokeDashoffset: 100 - progress * 100 }}
    />
  </svg>;
}

function skillLabel(
  slot: ClassCombatSlotModel | null,
  category: WarriorSkillCategory,
  className: string | null,
  resourceName: string | null,
  includeResourceState: boolean
): string {
  const categoryName = category === "attack empower" ? "Attack Empower" : category === "class skill" ? "Class Skill" : "Active Technique";
  if (!slot?.definition) return slot?.locked
    ? `${categoryName}, unlocks at ${className ?? "Class"} Rank ${slot.lockLevel}`
    : `Empty ${categoryName}`;
  const resourceState = includeResourceState && slot.resourceCost > 0
    ? `${slot.resourceAmount} of ${slot.resourceCost} ${resourceName ?? "resource"}`
    : null;
  const named = `${slot.name}, ${category}${resourceState ? `, ${resourceState}` : ""}`;
  if (slot.locked) {
    return `${named}, unlocks at ${className ?? "Class"} Rank ${slot.lockLevel}`;
  }
  if (slot.pending) return `${named}, waiting for next scheduled attack`;
  if (slot.cooldownMs > 0) {
    return `${named}, cooldown ${Math.ceil(slot.cooldownMs / 1_000)} seconds`;
  }
  if (slot.unavailableText) return `${named}, ${slot.unavailableText.toLowerCase()}`;
  if (slot.insufficientResource) {
    return `${named}, insufficient ${resourceName ?? "resource"}`;
  }
  if (slot.singleTargetSupport && slot.target?.mode === "friendly") {
    return `${named}, targeting selected party member, hold for self`;
  }
  return slot.singleTargetSupport
    ? `${named}, targeting self`
    : `${named}, ready`;
}

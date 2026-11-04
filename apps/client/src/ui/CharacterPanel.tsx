import {
  EQUIPMENT_SLOTS,
  isCarriedEquipmentLocation,
  isEquipmentCategoryAllowedInSlot,
  type ClassEquipmentAffinitySnapshot,
  type CombatKitIndex,
  type EquipmentCategory,
  type EquipmentInstanceV2,
  type EquipmentSlot,
  type EquipmentSnapshotV2
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { combatKitInvalidReasonLabel } from "./CombatKitHotbar.js";
import { DestinationShell } from "./DestinationShell.js";
import { GameActionPrompt } from "./GameActionPrompt.js";
import { GameAppButton, GameAppSectionHeader, GameAppState, GameAppTabs, GameAppText } from "./GameAppShell.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { equipmentUtilityLabel } from "./InventoryPanel.js";
import { RingBonusLines, ringBonusSummary } from "./RingBonusLines.js";
import { ringBonusPresentation, ringTierName } from "../inventory/ringPresentation.js";
import { RigPortrait } from "./RigPortrait.js";
import type { PlayerAppearanceSnapshot } from "@ash-atlas/shared";

export type CharacterPanelSection = "all" | "items" | "loadout" | "kits";

type Props = {
  open: boolean;
  equipment: EquipmentSnapshotV2 | null;
  equipmentAffinity?: ClassEquipmentAffinitySnapshot | null;
  equipmentBusy?: boolean;
  appearance?: PlayerAppearanceSnapshot;
  displayColor?: string | null;
  playerName?: string;
  onSaveKit?(kitIndex: CombatKitIndex): void;
  closeLabel?: string;
  layout?: "desktop" | "phone";
  onEquip?(item: EquipmentInstanceV2): void;
  onUnequip?(item: EquipmentInstanceV2): void;
  onActivateKit?(kitIndex: CombatKitIndex): void;
  onToggleReadiedWeapon?(slot: "melee" | "secondary"): void;
  phoneSelectedSlot?: EquipmentSlot | null;
  onOpenPhoneSlot?(slot: EquipmentSlot): void;
  onBackPhoneChild?(): void;
  inventoryMode?: boolean;
  section?: CharacterPanelSection;
  onChangeInventorySection?(section: Exclude<CharacterPanelSection, "all">): void;
  onClose(): void;
};

export const SLOT_LABELS: Readonly<Record<EquipmentSlot, string>> = {
  head: "Head",
  chest: "Chest",
  gloves: "Gloves",
  boots: "Boots",
  ring: "Ring",
  ring_2: "Second Ring",
  melee: "Melee",
  secondary: "Secondary",
  tool_axe: "Axe",
  tool_pickaxe: "Pickaxe",
  tool_fishing_pole: "Fishing Pole"
};

/** Empty gathering tool slots show their starter tool's art. */
const EMPTY_SLOT_CATEGORY: Partial<Record<EquipmentSlot, EquipmentCategory>> = {
  tool_axe: "gathering_axe",
  tool_pickaxe: "gathering_pickaxe",
  tool_fishing_pole: "gathering_fishing_pole"
};

export function compatibleItemsForSlot(
  equipment: EquipmentSnapshotV2 | null,
  slot: EquipmentSlot
): EquipmentInstanceV2[] {
  if (!equipment) return [];
  const current = equipment.active[slot] ?? null;
  const byInstanceId = new Map<string, EquipmentInstanceV2>();
  if (current && isCarriedEquipmentLocation(current.location)) {
    byInstanceId.set(current.instanceId, current);
  }
  for (const item of equipment.instances) {
    if (
      isCarriedEquipmentLocation(item.location) &&
      isEquipmentCategoryAllowedInSlot(item.category, slot) &&
      item.ring?.rough !== true
    ) {
      byInstanceId.set(item.instanceId, item);
    }
  }
  return [...byInstanceId.values()]
    .sort((left, right) => {
      if (left.instanceId === current?.instanceId) return -1;
      if (right.instanceId === current?.instanceId) return 1;
      return right.itemLevel - left.itemLevel || left.displayName.localeCompare(right.displayName);
    });
}

export function CharacterPanel({
  open,
  equipment,
  equipmentBusy = false,
  appearance,
  displayColor = null,
  playerName = "Adventurer",
  onSaveKit,
  closeLabel = "Close Character",
  layout = "desktop",
  onUnequip,
  onActivateKit,
  inventoryMode = false,
  section = "all",
  onChangeInventorySection,
  onClose
}: Props): React.JSX.Element | null {
  const [selectedEquippedItem, setSelectedEquippedItem] = useState<EquipmentInstanceV2 | null>(null);
  const derived = equipment?.derivedStats ?? null;

  useEffect(() => {
    if (!open) setSelectedEquippedItem(null);
  }, [open]);
  const shellBack = onClose;
  const sectionTabs = (
    <GameAppTabs
      variant="housed"
      ariaLabel="Adventurer sections"
      activeTab={section === "all" || section === "items" ? "loadout" : section}
      onChange={(tab) => onChangeInventorySection?.(tab as Exclude<CharacterPanelSection, "all">)}
      tabs={[
        { id: "loadout", label: "Loadout" },
        { id: "kits", label: "Kits" }
      ]}
    />
  );

  return (
    <DestinationShell
      open={open}
      title={playerName}
      menuId="character"
      closeLabel={closeLabel}
      layout={layout}
      className={`character-destination${inventoryMode ? " inventory-app-with-tabs" : ""}`}
      phoneBackLabel="Back to Game Menu"
      onClose={shellBack}
    >
      {sectionTabs}
      <div className="character-workspace">
        {section === "all" || section === "items" || section === "loadout" ? <section className="character-loadout" aria-labelledby="character-loadout-title">
          <GameAppSectionHeader
            className="destination-section-heading"
            title="Loadout"
            titleId="character-loadout-title"
            meta={equipment ? `${EQUIPMENT_SLOTS.filter((slot) => equipment.active[slot]).length}/${EQUIPMENT_SLOTS.length} equipped` : "—"}
          />
          <div className="character-paper-doll">
            <div className="character-emblem">
              {appearance ? <RigPortrait appearance={appearance} animate className="character-appearance-preview" ariaLabel={`${playerName} appearance`} /> : <GameAppState>Appearance loading…</GameAppState>}
            </div>
            <div className="character-slot-grid">
              {EQUIPMENT_SLOTS.map((slot) => {
                const item = equipment?.active[slot] ?? null;
                const slotContent = (
                  <>
                    <ItemArtwork itemId={item?.definitionId ?? "generic"} category={item?.category ?? EMPTY_SLOT_CATEGORY[slot]} label={item?.displayName ?? SLOT_LABELS[slot]} />
                    <span><strong>{SLOT_LABELS[slot]}</strong><small>{item?.displayName ?? "Empty slot"}</small>
                      {item?.ring ? <small className="ring-slot-summary">{ringBonusSummary(ringBonusPresentation(item, equipment))}</small> : null}</span>
                    {item ? <i>+{item.itemLevel}</i> : null}
                  </>
                );
                if (!item) {
                  return (
                    <div
                      key={slot}
                      className="character-slot empty"
                      aria-label={`${SLOT_LABELS[slot]} equipment slot: Empty`}
                      aria-disabled="true"
                      data-equipment-slot={slot}
                    >
                      {slotContent}
                    </div>
                  );
                }
                return (
                  <GameAppButton
                    type="button"
                    key={slot}
                    className="character-slot occupied"
                    aria-label={`${SLOT_LABELS[slot]} equipment slot: ${item?.displayName ?? "Empty"}`}
                    aria-expanded={selectedEquippedItem?.instanceId === item.instanceId}
                    disabled={!equipment}
                    data-equipment-slot={slot}
                    onClick={() => setSelectedEquippedItem(item)}
                  >
                    {slotContent}
                  </GameAppButton>
                );
              })}
            </div>
          </div>
          <section className="character-loadout-summary" aria-labelledby="character-loadout-summary-title">
            <GameAppSectionHeader title="Combat totals" titleId="character-loadout-summary-title" meta="Live equipment" />
            <dl className="game-app-stats">
              <dt>Health</dt><dd>{formatStat(derived?.maximumHealth)}</dd>
              <dt>Attack</dt><dd>{formatStat(derived?.universalAttackPower)}</dd>
              <dt>Defense</dt><dd>{formatStat(derived?.universalDefense)}</dd>
              <dt>Gear</dt><dd>+{formatStat(equipment?.totalAttackPowerBonus)} ATK / +{formatStat(equipment?.totalDefenseBonus)} DEF</dd>
            </dl>
          </section>
          {equipment?.repairMessage
            ? <GameAppText className="equipment-repair-message" role="status" tone="helper">{equipment.repairMessage}</GameAppText>
            : null}
        </section> : null}

        {section === "kits" ? <section className="character-kits" aria-labelledby="character-kits-title">
          <GameAppSectionHeader
            className="destination-section-heading"
            title="Combat Kits"
            titleId="character-kits-title"
            description="Save your equipped pieces. Empty slots are welcome."
          />
          <div className="character-kit-list">
            {(equipment?.kits ?? []).map((kit) => {
              const active = equipment?.activeKitIndex === kit.kitIndex;
              const invalidReason = kit.valid ? null : combatKitInvalidReasonLabel(kit.invalidReason);
              return (
                <details key={kit.kitIndex} className={`character-kit-row${active ? " active" : ""}`}>
                  <summary className="game-app-row"><span className="game-app-count">{kit.kitIndex}</span><strong>{kit.name}</strong><small>{active ? "Active" : kit.valid ? `${Object.values(kit.items).filter(Boolean).length} pieces` : "Empty or unavailable"}</small></summary>
                  <div>
                    <GameAppText tone="helper">{invalidReason ?? Object.values(kit.items).filter(Boolean).map((item) => item!.displayName).join(" · ")}</GameAppText>
                    <GameAppButton type="button" disabled={equipmentBusy || !onSaveKit || !Object.values(equipment?.active ?? {}).some(Boolean)} onClick={() => onSaveKit?.(kit.kitIndex)}>Save current equipment</GameAppButton>
                    <GameAppButton type="button" variant={active ? "quiet" : "primary"} disabled={equipmentBusy || !kit.valid || !onActivateKit} onClick={() => onActivateKit?.(kit.kitIndex)}>{active ? "Active" : "Activate"}</GameAppButton>
                  </div>
                </details>
              );
            })}
          </div>
        </section> : null}

      </div>
      {selectedEquippedItem ? <GameActionPrompt
        title={selectedEquippedItem.displayName}
        category={SLOT_LABELS[selectedEquippedItem.derived.slot]}
        artwork={<ItemArtwork itemId={selectedEquippedItem.definitionId} category={selectedEquippedItem.category} label={selectedEquippedItem.displayName} />}
        detail={selectedEquippedItem.ring
          ? ringTierName(selectedEquippedItem) ?? selectedEquippedItem.displayName
          : selectedEquippedItem.usesRemaining != null
            ? equipmentEffectLabel(selectedEquippedItem)
            : `+${selectedEquippedItem.itemLevel} · ${equipmentEffectLabel(selectedEquippedItem)}`}
        {...(selectedEquippedItem.ring
          ? { content: <RingBonusLines lines={ringBonusPresentation(selectedEquippedItem, equipment)} /> }
          : {})}
        elevated
        dismissOnOutsideClick
        ariaLabel={`${selectedEquippedItem.displayName} equipment actions`}
        actions={[{
          key: "unequip",
          label: "Unequip",
          enabled: !equipmentBusy && Boolean(onUnequip),
          busy: equipmentBusy,
          onSelect: () => {
            onUnequip?.(selectedEquippedItem);
            setSelectedEquippedItem(null);
          }
        }]}
        onCancel={() => setSelectedEquippedItem(null)}
      /> : null}
    </DestinationShell>
  );
}

function formatStat(value: number | undefined): string {
  if (value === undefined) return "—";
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

function equipmentEffectLabel(item: EquipmentInstanceV2): string {
  if (item.usesRemaining != null) return `${item.usesRemaining} uses left`;
  return item.derived.utilityKind === "none"
    ? `${item.derived.universalAttackContribution.toFixed(1)} ATK / ${item.derived.universalDefenseContribution.toFixed(1)} DEF`
    : equipmentUtilityLabel(item);
}


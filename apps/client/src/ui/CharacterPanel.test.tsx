// @vitest-environment jsdom

import {
  emptyEquipmentSlots,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  type EquipmentInstanceV2,
  type EquipmentLocation,
  type EquipmentSnapshotV2
} from "@ash-atlas/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CharacterPanel, compatibleItemsForSlot } from "./CharacterPanel.js";
vi.mock("./SalonPlayerLayer.js", () => ({ PlayerAppearancePreview: () => <div aria-label="Character preview" /> }));

afterEach(cleanup);

describe("CharacterPanel", () => {
  it("renders seven authoritative occupied or empty equipment slots", () => {
    render(<CharacterPanel open equipment={snapshot()} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Adventurer" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /equipment slot:/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Melee equipment slot: Starter Sword" })).not.toBeNull();
    expect(screen.getByLabelText("Chest equipment slot: Empty")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Chest equipment slot: Empty" })).toBeNull();
    expect(screen.queryByText("Combat Stats")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Stats" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Kits" })).toBeTruthy();
    expect(screen.getByText("Combat totals")).toBeTruthy();
    expect(screen.queryByText("Resource stack")).toBeNull();
  });

  it("opens the canonical compact unequip prompt without legacy guidance", () => {
    const onUnequip = vi.fn();
    render(<CharacterPanel open equipment={snapshot()} onUnequip={onUnequip} onClose={vi.fn()} />);
    expect(screen.queryByText(/Automatic:/)).toBeNull();
    expect(screen.queryByText("No items available for this slot.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Melee equipment slot: Starter Sword" }));
    expect(screen.getByRole("button", { name: "Unequip" })).toBeTruthy();
    expect(screen.queryAllByText("Empty slot").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Unequip" }));
    expect(onUnequip).toHaveBeenCalledWith(expect.objectContaining({ definitionId: "starter_sword" }));
  });

  it("does not open a slot picker from an occupied loadout card", () => {
    render(<CharacterPanel open equipment={snapshot()} onEquip={vi.fn()} onUnequip={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Melee equipment slot: Starter Sword" }));
    expect(screen.queryByRole("region", { name: "Melee applicable items" })).toBeNull();
    expect(screen.queryByText("Masterwork Sword")).toBeNull();
  });

  it("closes the compact prompt after an authoritative unequip action", () => {
    const before = snapshot();
    const onUnequip = vi.fn();
    render(<CharacterPanel open equipment={before} onUnequip={onUnequip} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Melee equipment slot: Starter Sword" }));
    fireEvent.click(screen.getByRole("button", { name: "Unequip" }));
    expect(onUnequip).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Unequip" })).toBeNull();
  });

  it("keeps empty phone slots display-only and opens occupied cards in place", () => {
    render(<CharacterPanel open layout="phone" equipment={snapshot()} onUnequip={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Melee equipment slot: Starter Sword" }));
    expect(screen.getByRole("button", { name: "Unequip" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Chest equipment slot: Empty" })).toBeNull();
    expect(screen.queryByText("No items available for this slot.")).toBeNull();
    expect(screen.queryByText("Derived Combat Stats")).toBeNull();
    expect(screen.queryByText("PvE Defense")).toBeNull();
    expect(screen.queryByText("Combat Kits")).toBeNull();
    expect(document.querySelectorAll(".phone-menu-header")).toHaveLength(1);
    expect(document.querySelectorAll(".phone-menu-footer")).toHaveLength(1);
  });

  it("keeps Unequip available when the equipped item has no alternatives", () => {
    const equipment = snapshot();
    equipment.instances = [equipment.instances[0]!];
    const onUnequip = vi.fn();
    render(<CharacterPanel
      open layout="phone" equipment={equipment} phoneSelectedSlot="melee"
      onUnequip={onUnequip} onBackPhoneChild={vi.fn()} onClose={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Melee equipment slot: Starter Sword" }));
    fireEvent.click(screen.getByRole("button", { name: "Unequip" }));
    expect(onUnequip).toHaveBeenCalledOnce();
  });

  it("uses the destination back action on phone", () => {
    const onClose = vi.fn();
    render(<CharacterPanel open layout="phone" equipment={snapshot()} onClose={onClose} />);
    fireEvent.click(document.querySelector<HTMLButtonElement>(".phone-menu-back")!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("orders the current compatible item first and excludes mismatched slots", () => {
    const equipment = snapshot();
    expect(compatibleItemsForSlot(equipment, "melee").map(({ displayName }) => displayName)).toEqual(["Starter Sword", "Masterwork Sword"]);
    expect(compatibleItemsForSlot(equipment, "secondary").map(({ displayName }) => displayName)).toEqual(["Starter Bow"]);
  });

  it("excludes owned equipment that is not carried", () => {
    const equipment = snapshot();
    equipment.instances.push(
      item("stored", "starter_staff", "Stored Staff", "melee", "melee_weapon", 4, "manor_storage"),
      item("dropped", "starter_sword", "Dropped Sword", "melee", "melee_weapon", 4, "world_drop"),
      item("escrow", "starter_sword", "Escrow Sword", "melee", "melee_weapon", 4, "market_escrow"),
      item("collection", "starter_sword", "Collection Sword", "melee", "melee_weapon", 4, "market_collection"),
      item("destroyed", "starter_sword", "Destroyed Sword", "melee", "melee_weapon", 4, "destroyed")
    );

    expect(compatibleItemsForSlot(equipment, "melee").map(({ instanceId }) => instanceId))
      .toEqual(["starter", "masterwork"]);
  });

  it("merges an equipped instance missing from inventory and deduplicates by stable instance id", () => {
    const equipment = snapshot();
    equipment.instances = [equipment.instances[1]!, { ...equipment.active.melee! }];
    expect(compatibleItemsForSlot(equipment, "melee").map(({ instanceId }) => instanceId)).toEqual(["starter", "masterwork"]);
    equipment.instances = [equipment.instances[0]!];
    expect(compatibleItemsForSlot(equipment, "melee").map(({ instanceId }) => instanceId)).toEqual(["starter", "masterwork"]);
  });

  it("is wired to the existing authoritative equipment mutation path", () => {
    const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
    const characterWiring = app.slice(app.indexOf("<CharacterPanel"), app.indexOf("<InventoryPanel"));
    expect(characterWiring).toContain("clientRef.current?.equipItem");
    expect(characterWiring).toContain("clientRef.current?.unequipItem");
    expect(characterWiring).toContain("clientRef.current?.toggleReadiedWeapon");
    expect(characterWiring).toContain("requestCombatKitActivation");
  });
});

function snapshot(): EquipmentSnapshotV2 {
  const starter = item("starter", "starter_sword", "Starter Sword", "melee", "melee_weapon", 0, "equipped");
  const masterwork = item("masterwork", "starter_sword", "Masterwork Sword", "melee", "melee_weapon", 8, "inventory");
  const bow = item("bow", "starter_bow", "Starter Bow", "secondary", "ranged_weapon", 1, "inventory");
  const active = { ...emptyEquipmentSlots<EquipmentInstanceV2 | null>(null), melee: starter };
  const derivedStats = resolveEquipmentCombatStats({
    context: "pvp_open_world",
    characterLevel: 8,
    classId: "warrior",
    classRank: 2,
    loadout: {
      active: {
        ...emptyEquipmentSlots(null),
        melee: {
          instanceId: starter.instanceId,
          itemLevel: starter.itemLevel,
          definition: requireEquipmentDefinition(starter.definitionId)
        }
      },
      readiedWeaponSlot: "melee"
    }
  });
  return {
    snapshotVersion: 2, balanceVersion: 2, playerId: "player-1",
    characterLevel: 8, repairMessage: null, instances: [starter, masterwork, bow],
    active, readiedWeaponSlot: "melee", activeKitIndex: null, kits: [], inventoryRevision: 3,
    activeRevision: 1, checkpointRevision: 1,
    derivedStats,
    weapon: starter, chest: null, totalAttackPowerBonus: 0, totalDefenseBonus: 0
  };
}

function item(
  instanceId: string,
  definitionId: EquipmentInstanceV2["definitionId"],
  displayName: string,
  slot: "melee" | "secondary",
  category: "melee_weapon" | "ranged_weapon",
  itemLevel: number,
  location: EquipmentLocation
): EquipmentInstanceV2 {
  const definition = requireEquipmentDefinition(definitionId);
  const derived = resolveEquipmentItemDerivedStats({
    item: { instanceId, definition, itemLevel },
    slot,
    classId: "warrior"
  });
  return {
    instanceId, definitionId, displayName, ownerPlayerId: "player-1", location,
    equippedSlot: location === "equipped" ? slot : null, itemLevel, maximumItemLevel: 25,
    category, balanceVersion: 2, enchantmentIdentity: null,
    attackPowerBonus: Math.round(derived.universalAttackContribution),
    defenseBonus: Math.round(derived.universalDefenseContribution),
    weaponCategory: category === "melee_weapon" ? "sword" : "bow", armorCategory: null,
    twoHanded: definition.twoHanded, savedKitIndices: [], derived,
    nextUpgradeCost: "10", nextUpgradeLevel: itemLevel + 1, upgradeDisabledReason: null,
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

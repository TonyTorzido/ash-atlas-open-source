// @vitest-environment jsdom

import {
  emptyEquipmentSlots,
  emptyInventoryTotals,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  type BackpackSnapshot,
  type BackpackInstanceSnapshot,
  type EquipmentInstanceV2,
  type EquipmentSnapshotV2,
  type InventoryProtectionSnapshot
} from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeInventorySnapshot } from "../inventory/inventoryPanelModel.js";
import { InventoryPanel } from "./InventoryPanel.js";

afterEach(() => {
  localStorage.clear();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("InventoryPanel", () => {
  it("persists favorites per player and sorts them first", () => {
    const props = { open: true, inventory: inventory(), hasSnapshot: true, connectionStatus: "online" as const, droppingItemKey: null, equipment: equipment(), onChooseDrop: vi.fn(), onClose: vi.fn() };
    const view = render(<InventoryPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Favorite Wood" }));
    expect(itemRows()[0]?.textContent).toContain("Wood");
    view.unmount();
    render(<InventoryPanel {...props} />);
    expect(screen.getByRole("button", { name: "Unfavorite Wood" }).getAttribute("aria-pressed")).toBe("true");
    expect(itemRows()[0]?.textContent).toContain("Wood");
  });

  it("confirms an affordable upgrade inside the compact item prompt", () => {
    const onUpgrade = vi.fn();
    render(<InventoryPanel open inventory={inventory()} hasSnapshot connectionStatus="online" droppingItemKey={null} equipment={equipment()} goldBalance="100" onUpgrade={onUpgrade} onChooseDrop={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Starter Sword, quantity/ }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade · 10 Gold" }));
    expect(onUpgrade).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(onUpgrade).toHaveBeenCalledWith(expect.objectContaining({ itemLevel: 0 }));
  });

  const groupedInventory = () => {
    const stack = (resourceType: string, quantity: number, slotIndex: number) => ({
      resourceType, quantity, slotIndex, stackId: `00000000-0000-4000-8000-0000000002${String(slotIndex).padStart(2, "0")}`
    });
    const meats = ["deer_cut", "wolf_cut", "hog_cut", "bear_cut", "frog_legs", "squid_cut"];
    const items = [...meats.map((id, index) => stack(id, 2, index)), stack("fire_feather", 1, 10), stack("ice_feather", 1, 11), stack("wood", 3, 12)];
    return normalizeInventorySnapshot({ playerId: "player-1", items, unlockedSlots: 16, totals: emptyInventoryTotals() }, "player-1");
  };
  const renderGrouped = () => render(<InventoryPanel open inventory={groupedInventory()} hasSnapshot connectionStatus="online" droppingItemKey={null} onChooseDrop={vi.fn()} onClose={vi.fn()} />);
  const rowNames = () => itemRows().map((row) => row.textContent ?? "");

  it("collapses a group above four kinds into one expandable row, groups first, and leaves smaller groups alone", () => {
    renderGrouped();
    expect(itemRows()).toHaveLength(4);
    // Order: group rows A-Z, then the remaining items A-Z.
    expect(rowNames().map((text) => text.slice(0, 5))).toEqual(["Meat6", "Ember", "Frost", "Wood×"]);
    const group = screen.getByRole("button", { name: /^Meat, 6 kinds, quantity 12/ });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Deer Cut, quantity/ })).toBeNull();
    fireEvent.click(group);
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(itemRows()).toHaveLength(10);
    // Members stay contiguous directly under the group row, then the list continues with Ember Feather.
    const names = rowNames();
    expect(names.slice(1, 7).every((text) => /Cut|Legs/.test(text))).toBe(true);
    expect(names[7]?.startsWith("Ember")).toBe(true);
    fireEvent.click(group);
    expect(itemRows()).toHaveLength(4);
  });

  it("taps a group member star to favorite it inside the group and long-presses to pin it to the top", () => {
    vi.useFakeTimers();
    renderGrouped();
    fireEvent.click(screen.getByRole("button", { name: /^Meat, 6 kinds/ }));
    fireEvent.click(screen.getByRole("button", { name: "Favorite Wolf Cut" }));
    expect(rowNames()[1]).toContain("Wolf Cut");
    expect(rowNames()[0]).toContain("Meat");
    const star = screen.getByRole("button", { name: "Favorite Hog Cut" });
    fireEvent.pointerDown(star);
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerUp(star);
    fireEvent.click(star);
    expect(rowNames()[0]).toContain("Hog Cut");
    expect(screen.getByRole("button", { name: "Unpin Hog Cut" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Meat, 5 kinds, quantity 10/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unpin Hog Cut" }));
    expect(screen.getByRole("button", { name: /^Meat, 6 kinds, quantity 12/ })).toBeTruthy();
  });

  it("filters the tab as you type and auto-expands a group with matching members", () => {
    renderGrouped();
    const search = screen.getByRole("textbox", { name: "Search inventory" });
    expect(document.activeElement).not.toBe(search);
    fireEvent.change(search, { target: { value: "wolf" } });
    expect(rowNames().map((text) => text.slice(0, 4))).toEqual(["Meat", "Wolf"]);
    expect(screen.getByRole("button", { name: /^Meat, 6 kinds, quantity 12/ }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No items match.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(itemRows()).toHaveLength(4);
    expect(screen.getByRole("button", { name: /^Meat, 6 kinds/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("groups raw mined materials as Ores and minerals once more than four kinds are held", () => {
    const stack = (resourceType: string, slotIndex: number) => ({ resourceType, quantity: 1, slotIndex, stackId: `00000000-0000-4000-8000-0000000003${String(slotIndex).padStart(2, "0")}` });
    const ids = ["stone", "ore", "iron", "coal", "sulfur", "iron_bar"];
    const snapshot = normalizeInventorySnapshot({ playerId: "player-1", items: ids.map((id, index) => stack(id, index)), unlockedSlots: 16, totals: emptyInventoryTotals() }, "player-1");
    render(<InventoryPanel open inventory={snapshot} hasSnapshot connectionStatus="online" droppingItemKey={null} onChooseDrop={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Ores and minerals, 5 kinds/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Iron Bar, quantity/ })).toBeTruthy();
  });

  it("groups edible non-cut items as Food while raw cuts stay in Meat", () => {
    const stack = (resourceType: string, slotIndex: number) => ({ resourceType, quantity: 1, slotIndex, stackId: `00000000-0000-4000-8000-0000000004${String(slotIndex).padStart(2, "0")}` });
    const ids = ["simple_food", "giving_berry", "field_ration", "hearty_ration", "elemental_ration", "deer_cut"];
    const snapshot = normalizeInventorySnapshot({ playerId: "player-1", items: ids.map((id, index) => stack(id, index)), unlockedSlots: 16, totals: emptyInventoryTotals() }, "player-1");
    render(<InventoryPanel open inventory={snapshot} hasSnapshot connectionStatus="online" droppingItemKey={null} onChooseDrop={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Food, 5 kinds/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Deer Cut, quantity/ })).toBeTruthy();
  });

  it("renders nothing while closed", () => {
    const { container } = render(<InventoryPanel open={false} inventory={inventory()} hasSnapshot={false} connectionStatus="offline" droppingItemKey={null} onChooseDrop={vi.fn()} onClose={vi.fn()} />);
    expect(container.childElementCount).toBe(0);
  });

  it("shows each balance and unique item once, with server carry weight and no empty cells", () => {
    render(<InventoryPanel open inventory={{ ...inventory(), currentWeightGrams: "72400", maximumWeightGrams: "100000" }} hasSnapshot connectionStatus="online" droppingItemKey={null} equipment={equipment()} onChooseDrop={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("72.4 of 100 kg");
    expect(itemRows()).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /Wood, quantity 12/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Starter Sword, quantity 1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Masterwork Sword, quantity 1/ })).toBeTruthy();
    expect(screen.queryByText(/empty slots|slots used/i)).toBeNull();
  });

  it("returns to All after Inventory closes so occupied slots stay visible", () => {
    const props = {
      inventory: inventory(),
      equipment: equipment(),
      hasSnapshot: true,
      connectionStatus: "online" as const,
      droppingItemKey: null,
      onChooseDrop: vi.fn(),
      onClose: vi.fn()
    };
    const view = render(<InventoryPanel open {...props} />);

    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
    expect(screen.queryByRole("button", { name: /Starter Sword, quantity/ })).toBeNull();

    view.rerender(<InventoryPanel open={false} {...props} />);
    view.rerender(<InventoryPanel open {...props} />);

    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByRole("button", { name: /Starter Sword, quantity/ })).not.toBeNull();
  });

  it("keeps backpack management out of the Inventory header", () => {
    render(
      <InventoryPanel
        open
        inventory={inventory()}
        hasSnapshot
        connectionStatus="online"
        droppingItemKey={null}
        onChooseDrop={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByText("Travel pack")).toBeNull();
    expect(screen.queryByText(/slots used.*equipment items/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Backpacks" })).toBeNull();
  });

  it("uses canonical app primitives for the inventory heading, scroll owner, and controls", () => {
    render(
      <InventoryPanel
        open
        inventory={{ ...inventory(), currentWeightGrams: "10", maximumWeightGrams: "100" }}
        hasSnapshot
        connectionStatus="online"
        droppingItemKey={null}
        onOpenProtection={vi.fn()}
        onChooseDrop={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(document.querySelector(".game-app-scroll-region.inventory-carry-scroll")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Backpacks" })).toBeNull();
    expect(screen.getByRole("button", { name: "Item Protection" }).classList.contains("game-app-button-standard")).toBe(true);
    expect(screen.getByRole("button", { name: /Wood, quantity 12/ }).classList.contains("game-app-button")).toBe(true);
  });

  it("shows a red Broken label and blocks Equip with the repair reason for broken chest armour", () => {
    const base = equipment();
    const broken = { ...base.instances[1]!, category: "chest_armor" as const, condition: 0, displayName: "Padded Tunic" };
    const snapshot = { ...base, instances: [base.instances[0]!, broken] };
    render(<InventoryPanel open inventory={inventory()} hasSnapshot connectionStatus="online" droppingItemKey={null} equipment={snapshot} protection={protection()} onEquip={vi.fn()} onChooseDrop={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    const row = screen.getByRole("button", { name: /Padded Tunic, quantity 1/ });
    expect(within(row).getByText("Broken").classList.contains("item-broken-label")).toBe(true);
    expect(row.textContent).not.toContain("0% condition");
    fireEvent.click(row);
    expect(screen.getAllByText("Broken").length).toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: "Equip" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Repair this armor before equipping it.")).toBeTruthy();
  });

  it("opens the themed resource action menu and exposes only equipment actions in the detail pane", () => {
    const onEquip = vi.fn();
    const onUnequip = vi.fn();
    const onUpgrade = vi.fn();
    const onChooseDrop = vi.fn();
    render(<InventoryPanel open inventory={inventory()} hasSnapshot connectionStatus="online" droppingItemKey={null} equipment={equipment()} protection={protection()} onEquip={onEquip} onUnequip={onUnequip} onUpgrade={onUpgrade} onChooseDrop={onChooseDrop} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
    expect(itemRows()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Wood, quantity 12/ }));
    expect(screen.getAllByText("Common").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Use/ })).toBeNull();
    expect(screen.queryByText("This item cannot be used.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Split/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Drop/ }));
    expect(onChooseDrop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("complementary", { name: "Inventory item details" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    fireEvent.click(screen.getByRole("button", { name: /Masterwork Sword, quantity 1/ }));
    expect(screen.getAllByText("Common").length).toBeGreaterThan(0);
    expect(screen.getByText(/Attack.*Defense/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(screen.queryByText("PvE contribution")).toBeNull();
    expect(screen.getByRole("button", { name: "Equip" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Maximum upgrade reached.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Maximum Level" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /Starter Sword, quantity 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Unequip" }));
    expect(onUnequip).toHaveBeenCalledTimes(1);
  });

  it("shows current Bitter Blood progress for Venomsteel equipment", () => {
    const snapshot = equipment();
    const target = snapshot.instances.find(({ itemLevel }) => itemLevel === 25)!;
    const venomsteel = {
      ...snapshot,
      instances: snapshot.instances.map((item) => item.instanceId === target.instanceId
        ? {
            ...item,
            enchantmentIdentity: "enh:v1:opal:venomsteel",
            requiredAchievementId: "bitter_blood" as const,
            achievementRequirementMet: false
          }
        : item)
    };
    render(<InventoryPanel
      open
      inventory={inventory()}
      hasSnapshot
      connectionStatus="online"
      droppingItemKey={null}
      equipment={venomsteel}
      achievements={{
        playerId: "player-1",
        achievements: [{
          achievementId: "bitter_blood",
          title: "Bitter Blood",
          badgeId: "bitter_blood",
          completed: false,
          completedAt: null,
          statKey: "poison_damage_taken",
          value: 184,
          requiredValue: 250
        }],
        serverTime: 1
      }}
      onChooseDrop={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Masterwork Sword, quantity 1/ }));
    expect(screen.getByText(/Bitter Blood · 184 \/ 250 poison damage taken/)).not.toBeNull();
  });

  it("allows completed Bitter Blood progress to supersede a stale equipment projection", () => {
    const snapshot = equipment();
    const target = snapshot.instances.find(({ itemLevel }) => itemLevel === 25)!;
    const onEquip = vi.fn();
    render(<InventoryPanel
      open
      inventory={inventory()}
      hasSnapshot
      connectionStatus="online"
      droppingItemKey={null}
      equipment={{
        ...snapshot,
        instances: snapshot.instances.map((item) => item.instanceId === target.instanceId
          ? {
              ...item,
              enchantmentIdentity: "enh:v1:opal:venomsteel",
              requiredAchievementId: "bitter_blood" as const,
              achievementRequirementMet: false
            }
          : item)
      }}
      achievements={{
        playerId: "player-1",
        achievements: [{
          achievementId: "bitter_blood",
          title: "Bitter Blood",
          badgeId: "bitter_blood",
          completed: true,
          completedAt: "2026-01-01T00:00:00.000Z",
          statKey: "poison_damage_taken",
          value: 250,
          requiredValue: 250
        }],
        serverTime: 1
      }}
      onEquip={onEquip}
      onChooseDrop={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Masterwork Sword, quantity 1/ }));
    expect(screen.getByText("✓ Bitter Blood")).not.toBeNull();
    const equipButton = screen.getByRole("button", { name: "Equip" });
    expect(equipButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(equipButton);
    expect(onEquip).toHaveBeenCalledOnce();
  });

  it("keeps authoritative items visible while disconnected", () => {
    render(<InventoryPanel open inventory={inventory()} hasSnapshot connectionStatus="offline" droppingItemKey={null} onChooseDrop={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Offline. Showing your last inventory.");
    expect(screen.getByRole("button", { name: /Wood, quantity 12/ })).not.toBeNull();
  });

  it("keeps Equipment resource-free and gives owned backpacks their own catalog category", () => {
    const backpacks = backpackSnapshot([
      makeBackpack("inventory-pack", "inventory", 0),
      makeBackpack("equipped-pack", "equipped", 2, 0)
    ]);
    render(<InventoryPanel open inventory={inventory()} hasSnapshot connectionStatus="online" droppingItemKey={null}
      equipment={equipment()} backpacks={backpacks} goldBalance="10000" onEquipBackpack={vi.fn()} onUnequipBackpack={vi.fn()} onUpgradeBackpack={vi.fn()}
      onChooseDrop={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    expect(screen.queryByRole("button", { name: /Backpack \+0, quantity/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Starter Sword, quantity 1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Backpacks" }));
    expect(screen.getAllByRole("button", { name: /Backpack \+.*quantity/ })).toHaveLength(2);
  });

  it("groups identical backpack capacity rows while keeping the representative instance actionable", () => {
    const first = backpackWithId("backpack-1", "inventory", 9);
    const second = backpackWithId("backpack-2", "inventory", 9);
    const onUpgradeBackpack = vi.fn();
    render(<InventoryPanel open inventory={{ ...inventory(), totals: { ...emptyInventoryTotals(), leather: 1000 } }} hasSnapshot connectionStatus="online" droppingItemKey={null}
      backpacks={backpackSnapshot([first, second])} goldBalance="100000" onUpgradeBackpack={onUpgradeBackpack}
      onChooseDrop={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Backpacks" }));
    expect(itemRows()).toHaveLength(1);
    const row = screen.getByRole("button", { name: /Backpack \+9, quantity 2/ });
    expect(row.textContent).toContain("×2");
    expect(row.classList.contains("inventory-entry-row--backpack")).toBe(true);
    expect(row.getAttribute("aria-label")).toContain("0 kg");
    const favorite = screen.getByRole("button", { name: "Favorite Backpack +9" });
    fireEvent.click(favorite);
    expect(screen.getByRole("button", { name: "Unfavorite Backpack +9" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("ash-atlas:inventory-favorites:v1:player-1") ?? "[]"))
      .toEqual(expect.arrayContaining(["backpack:backpack-1", "backpack:backpack-2"]));
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to +10" }));
    expect(onUpgradeBackpack).toHaveBeenCalledWith(first);
    expect(onUpgradeBackpack).not.toHaveBeenCalledWith(second);
  });

  it("offers backpack upgrade without any equip action from the item detail prompt", () => {
    const backpack = makeBackpack("inventory-pack", "inventory", 0);
    const onUpgradeBackpack = vi.fn();
    render(<InventoryPanel open inventory={{ ...inventory(), totals: { ...emptyInventoryTotals(), leather: 20 } }} hasSnapshot connectionStatus="online" droppingItemKey={null}
      backpacks={backpackSnapshot([backpack])} goldBalance="500" onEquipBackpack={vi.fn()} onUpgradeBackpack={onUpgradeBackpack}
      onChooseDrop={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Backpacks" }));
    fireEvent.click(screen.getByRole("button", { name: /Backpack \+0, quantity/ }));
    expect(screen.getByRole("button", { name: "Upgrade to +1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Equip|Unequip|Position/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to +1" }));
    expect(onUpgradeBackpack).toHaveBeenCalledOnce();
  });

  it("hides retained items until a fresh authoritative snapshot is available", () => {
    render(<InventoryPanel open inventory={inventory()} hasSnapshot={false} connectionStatus="online" droppingItemKey={null} onChooseDrop={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole("status").textContent).toContain("Loading inventory");
    expect(screen.queryByRole("button", { name: /Wood, quantity 12/ })).toBeNull();
  });

  it("uses a Giving Berry from its stack instead of opening drop flow", () => {
    const onUseItem = vi.fn(() => true);
    const onChooseDrop = vi.fn();
    const berryInventory = normalizeInventorySnapshot({
      playerId: "player-1",
      items: [{
        resourceType: "giving_berry",
        quantity: 2,
        stackId: "00000000-0000-4000-8000-000000000010",
        slotIndex: 0
      }],
      totals: { ...emptyInventoryTotals(), giving_berry: 2 }
    }, "player-1");
    render(<InventoryPanel
      open
      inventory={berryInventory}
      hasSnapshot
      connectionStatus="online"
      droppingItemKey={null}
      onUseItem={onUseItem}
      onChooseDrop={onChooseDrop}
      onClose={vi.fn()}
    />);

    const berry = screen.getByRole("button", {
      name: /Giving Berry, quantity 2/
    });
    fireEvent.click(berry);
    expect(screen.getByText("Uncommon")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Use/ }));
    expect(onUseItem).toHaveBeenCalledWith(
      "giving_berry",
      "00000000-0000-4000-8000-000000000010"
    );
    expect(onChooseDrop).not.toHaveBeenCalled();
  });

  it("equips and unequips a Manor skin from the inventory and locks the equipped one", () => {
    const onEquipManorSkin = vi.fn(() => true);
    const onChooseDrop = vi.fn();
    const skins = normalizeInventorySnapshot({
      playerId: "player-1",
      items: [
        { resourceType: "manor_skin", variant: "samurai_manor", quantity: 1, stackId: "00000000-0000-4000-8000-000000000020", slotIndex: 0 },
        { resourceType: "manor_skin", variant: "haunted_manor", quantity: 1, stackId: "00000000-0000-4000-8000-000000000021", slotIndex: 1 }
      ],
      totals: emptyInventoryTotals()
    }, "player-1");
    const skinProtection: InventoryProtectionSnapshot = {
      playerId: "player-1", revision: 1, materialPolicies: [], uniqueItems: [],
      stackAllocations: [
        { stackId: "00000000-0000-4000-8000-000000000020", itemId: "manor_skin", variant: "samurai_manor", protectedQuantity: 1, movableQuantity: 0, status: "protected", reason: "Equipped on your Manor." },
        { stackId: "00000000-0000-4000-8000-000000000021", itemId: "manor_skin", variant: "haunted_manor", protectedQuantity: 0, movableQuantity: 1, status: "none", reason: null }
      ]
    };
    render(<InventoryPanel open inventory={skins} hasSnapshot connectionStatus="online" droppingItemKey={null}
      protection={skinProtection} equippedManorSkin="samurai_manor" onEquipManorSkin={onEquipManorSkin}
      onChooseDrop={onChooseDrop} onClose={vi.fn()} />);
    const equipped = screen.getByRole("button", { name: /Samurai Manor Skin, quantity 1/ });
    expect(equipped.textContent).toContain("Equipped");
    fireEvent.click(equipped);
    expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
    // Unusable actions are hidden; the reason is shown instead.
    expect(screen.queryByRole("button", { name: /^Drop/ })).toBeNull();
    expect(screen.getByText(/Unequip it before you drop, trade, gift, sell or store it/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unequip" }));
    expect(onEquipManorSkin).toHaveBeenLastCalledWith("manor_lobby");
    const other = screen.getByRole("button", { name: /Haunted Manor Skin, quantity 1/ });
    expect(other.textContent).not.toContain("Equipped");
    fireEvent.click(other);
    fireEvent.click(screen.getByRole("button", { name: "Equip on Manor" }));
    expect(onEquipManorSkin).toHaveBeenLastCalledWith("haunted_manor", "haunted_manor");
    expect(onChooseDrop).not.toHaveBeenCalled();
  });

  it("keeps the Store-on-Manor-floor action for resource stacks", () => {
    const onChooseDrop = vi.fn();
    render(<InventoryPanel open inventory={inventory()} hasSnapshot connectionStatus="online" droppingItemKey={null} manorMode protection={protection()} onChooseDrop={onChooseDrop} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Wood, quantity 12/ }));
    fireEvent.click(screen.getByRole("button", { name: /Store/ }));
    expect(onChooseDrop).toHaveBeenCalledTimes(1);
  });

  it("keeps phone resources at the root and routes equipment details through child navigation", () => {
    const onChooseDrop = vi.fn();
    const onOpenPhoneEquipmentDetail = vi.fn();
    const onBackPhoneChild = vi.fn();
    const view = render(<InventoryPanel open layout="phone" inventory={inventory()} hasSnapshot connectionStatus="online" droppingItemKey={null} equipment={equipment()} protection={protection()} phoneDetailInstanceId={null} onOpenPhoneEquipmentDetail={onOpenPhoneEquipmentDetail} onBackPhoneChild={onBackPhoneChild} onChooseDrop={onChooseDrop} onClose={vi.fn()} />);
    const shell = screen.getByRole("dialog", { name: "Inventory" });
    expect(shell.classList.contains("phone-menu-layer")).toBe(true);
    expect(screen.getByLabelText("Inventory weight")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Inventory categories" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to Game Menu" })).toBeTruthy();
    const wood = screen.getByRole("button", { name: /Wood, quantity 12/ });
    fireEvent.click(wood);
    fireEvent.click(screen.getByRole("button", { name: /Drop/ }));
    expect(onChooseDrop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("complementary", { name: "Inventory item details" })).toBeNull();

    const sword = screen.getByRole("button", { name: /Starter Sword, quantity 1/ });
    fireEvent.click(sword);
    expect(onOpenPhoneEquipmentDetail).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    view.rerender(<InventoryPanel open layout="phone" inventory={inventory()} hasSnapshot connectionStatus="online" droppingItemKey={null} equipment={equipment()} protection={protection()} phoneDetailInstanceId="00000000-0000-4000-8000-000000000001" onOpenPhoneEquipmentDetail={onOpenPhoneEquipmentDetail} onBackPhoneChild={onBackPhoneChild} onChooseDrop={onChooseDrop} onClose={vi.fn()} />);
    expect(screen.getByRole("complementary", { name: "Starter Sword actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to Inventory" }));
    expect(onBackPhoneChild).toHaveBeenCalledOnce();
    expect(view.container.querySelectorAll(".phone-menu-footer")).toHaveLength(1);
  });

  it("keeps phone Inventory open when changing the Items category at the root", () => {
    const onBackPhoneChild = vi.fn();
    render(<InventoryPanel open layout="phone" inventory={inventory()} hasSnapshot connectionStatus="online" droppingItemKey={null}
      equipment={equipment()} phoneDetailInstanceId={null} onBackPhoneChild={onBackPhoneChild} onChooseDrop={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));

    expect(screen.getByRole("dialog", { name: "Inventory" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Resources" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /Wood, quantity 12/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Starter Sword, quantity 1/ })).toBeNull();
    expect(onBackPhoneChild).not.toHaveBeenCalled();
  });
});

function inventory() {
  return normalizeInventorySnapshot({
    playerId: "player-1",
    items: [
      {
        resourceType: "wood",
        quantity: 12,
        stackId: "00000000-0000-4000-8000-000000000101",
        slotIndex: 0
      },
      {
        resourceType: "mystery_relic",
        quantity: 2,
        stackId: "00000000-0000-4000-8000-000000000102",
        slotIndex: 1
      }
    ],
    unlockedSlots: 16,
    totals: { ...emptyInventoryTotals(), wood: 12 }
  }, "player-1");
}

function protection(): InventoryProtectionSnapshot {
  return {
    playerId: "player-1",
    revision: 1,
    materialPolicies: [],
    uniqueItems: [],
    stackAllocations: [{
      stackId: "00000000-0000-4000-8000-000000000101",
      itemId: "wood",
      variant: null,
      protectedQuantity: 0,
      movableQuantity: 12,
      status: "none",
      reason: null
    }, {
      stackId: "00000000-0000-4000-8000-000000000102",
      itemId: "mystery_relic",
      variant: null,
      protectedQuantity: 0,
      movableQuantity: 2,
      status: "none",
      reason: null
    }]
  };
}

function backpackSnapshot(items: BackpackInstanceSnapshot[]): BackpackSnapshot {
  const equipped = items.filter((item) => item.location === "equipped");
  const owned = items.filter((item) => item.location !== "destroyed");
  return {
    playerId: "player-1",
    revision: 1,
    baseCapacityGrams: 1_000_000,
    backpackBonusGrams: owned.reduce((total, item) => total + (item.capacityBonusGrams ?? 0), 0),
    maximumCapacityGrams: 1_000_000 + owned.reduce((total, item) => total + (item.capacityBonusGrams ?? 0), 0),
    equipped: [
      equipped.find((item) => item.equippedSlot === 0) ?? null,
      equipped.find((item) => item.equippedSlot === 1) ?? null,
      equipped.find((item) => item.equippedSlot === 2) ?? null,
      equipped.find((item) => item.equippedSlot === 3) ?? null
    ],
    instances: items
  };
}

function makeBackpack(instanceId: string, location: BackpackInstanceSnapshot["location"], level: number, equippedSlot: number | null = null): BackpackInstanceSnapshot {
  return {
    instanceId: `00000000-0000-4000-8000-${instanceId === "inventory-pack" ? "000000000701" : "000000000702"}`,
    ownerPlayerId: "player-1",
    definitionId: "starter_backpack",
    displayName: `Backpack +${level}`,
    location,
    upgradeLevel: level,
    capacityBonusGrams: 5_000 * (level + 1),
    unitWeightGrams: 0,
    equippedSlot,
    manorId: null,
    manorSlotIndex: null,
    version: 1,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

function backpackWithId(instanceId: string, location: BackpackInstanceSnapshot["location"], level: number): BackpackInstanceSnapshot {
  return { ...makeBackpack("inventory-pack", location, level), instanceId };
}

function equipment(): EquipmentSnapshotV2 {
  const starter = equipmentItem(0, "00000000-0000-4000-8000-000000000001");
  const maximum = equipmentItem(25, "00000000-0000-4000-8000-000000000002");
  const active = { ...emptyEquipmentSlots<EquipmentInstanceV2 | null>(null), melee: starter };
  const derivedStats = resolveEquipmentCombatStats({
    context: "pvp_open_world",
    characterLevel: 25,
    classId: "warrior",
    classRank: 0,
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
    snapshotVersion: 2,
    balanceVersion: 2,
    playerId: "player-1",
    characterLevel: 25,
    repairMessage: null,
    instances: [starter, maximum],
    active,
    readiedWeaponSlot: "melee",
    activeKitIndex: null,
    kits: [],
    inventoryRevision: 2,
    activeRevision: 1,
    checkpointRevision: 1,
    derivedStats,
    weapon: starter,
    chest: null,
    totalAttackPowerBonus: 2,
    totalDefenseBonus: 0
  };
}

function equipmentItem(level: number, instanceId: string): EquipmentInstanceV2 {
  const definition = requireEquipmentDefinition("starter_sword");
  const derived = resolveEquipmentItemDerivedStats({
    item: { instanceId, definition, itemLevel: level },
    slot: "melee",
    classId: "warrior"
  });
  return {
    instanceId,
    definitionId: "starter_sword",
    displayName: level === 25 ? "Masterwork Sword" : "Starter Sword",
    ownerPlayerId: "player-1",
    location: level === 0 ? "equipped" : "inventory",
    inventorySlotIndex: level === 25 ? 2 : 3,
    equippedSlot: level === 0 ? "melee" : null,
    itemLevel: level,
    maximumItemLevel: 25,
    category: "melee_weapon",
    balanceVersion: 2,
    enchantmentIdentity: null,
    attackPowerBonus: Math.round(derived.universalAttackContribution),
    defenseBonus: Math.round(derived.universalDefenseContribution),
    weaponCategory: "sword",
    armorCategory: null,
    twoHanded: false,
    savedKitIndices: level === 0 ? [1] : [],
    derived,
    nextUpgradeCost: level === 25 ? null : "10",
    nextUpgradeLevel: level === 25 ? null : level + 1,
    upgradeDisabledReason: level === 25 ? "maximum_level" : null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

/** Rows of the item list, leaving out the currency chips above it. */
function itemRows(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Inventory items" })).getAllByRole("listitem");
}

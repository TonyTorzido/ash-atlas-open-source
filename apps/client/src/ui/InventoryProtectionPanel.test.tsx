// @vitest-environment jsdom

import {
  emptyInventoryTotals,
  type EquipmentSnapshotV2,
  type InventoryProtectionSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InventoryProtectionPanel } from "./InventoryProtectionPanel.js";

afterEach(cleanup);

describe("InventoryProtectionPanel", () => {
  it("keeps navigation outside the active keyboard-scrollable region", () => {
    const view = renderPanel({ equipment: equipmentSnapshot() });
    const tabs = screen.getByRole("tablist", { name: "Protection sections" });
    const regions = view.container.querySelectorAll<HTMLElement>(".inventory-protection-scroll");
    expect(regions).toHaveLength(2);
    expect(regions[0]!.hidden).toBe(false);
    expect(regions[0]!.tabIndex).toBe(0);
    expect(regions[0]!.contains(tabs)).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Equipment locks" }));
    expect(regions[0]!.hidden).toBe(true);
    expect(regions[1]!.hidden).toBe(false);
    expect(regions[1]!.tabIndex).toBe(0);
  });
  it("opens on its shell instead of summoning the numeric keyboard", async () => {
    renderPanel();

    const dialog = screen.getByRole("dialog", { name: "Item Protection" });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(screen.getByRole("textbox")).not.toBe(document.activeElement);
  });

  it("edits and saves a material quantity safely in StrictMode", () => {
    const onSetMaterialKeep = vi.fn(() => true);
    expect(() => {
      renderPanel({ onSetMaterialKeep });
      const input = screen.getByRole("textbox", {
        name: "Keep Leather in Inventory"
      }) as HTMLInputElement;
      input.focus();
      fireEvent.change(input, { target: { value: "100" } });
      expect(screen.getByRole("dialog", { name: "Item Protection" })).not.toBeNull();
      expect(input.value).toBe("100");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(input).not.toBe(document.activeElement);
    }).not.toThrow();

    expect(onSetMaterialKeep).toHaveBeenCalledWith(
      "leather",
      "tanned",
      100,
      7
    );
  });

  it("uses custom material controls without native number or checkbox inputs", () => {
    const onSetMaterialKeep = vi.fn(() => true);
    const onSetUnique = vi.fn(() => true);
    const view = renderPanel({
      onSetMaterialKeep,
      onSetUnique,
      equipment: equipmentSnapshot()
    });
    expect(view.container.querySelector('input[type="number"]')).toBeNull();
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
    const input = screen.getByRole("textbox", {
      name: "Keep Leather in Inventory"
    }) as HTMLInputElement;
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Increase protected Leather" }));
    expect(input.value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSetMaterialKeep).toHaveBeenCalledWith("leather", "tanned", 3, 7);
    fireEvent.click(screen.getByRole("tab", { name: "Equipment locks" }));
    fireEvent.click(screen.getByRole("button", { name: "Protect" }));
    expect(onSetUnique).toHaveBeenCalledWith("editable", true, 7);
  });

  it("shows explicit system protection and busy locking", () => {
    renderPanel({
      equipment: equipmentSnapshot(),
      busy: true
    });
    expect(screen.getByRole("button", { name: "Saving..." })).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Equipment locks" }));
    const systemLocked = screen.getByRole("button", { name: "Auto-protected" }) as HTMLButtonElement;
    expect(systemLocked.disabled).toBe(true);
  });

  it("does not submit an empty draft as zero", () => {
    const onSetMaterialKeep = vi.fn(() => true);
    renderPanel({ onSetMaterialKeep });
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSetMaterialKeep).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(screen.getByRole("alert").textContent).toMatch(/nonnegative whole number/i);
    expect(screen.getByRole("dialog", { name: "Item Protection" })).not.toBeNull();
  });

  it.each([
    ["negative", "-1"],
    ["decimal", "1.5"],
    ["NaN", "NaN"],
    ["scientific notation", "1e2"],
    ["unsafe integer", "9007199254740992"]
  ])("rejects a %s draft", (_label, value) => {
    const onSetMaterialKeep = vi.fn(() => true);
    renderPanel({ onSetMaterialKeep });
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSetMaterialKeep).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/safe integer range/i);
    expect(screen.getByRole("dialog", { name: "Item Protection" })).not.toBeNull();
  });

  it("preserves active drafts across totals and refreshes changed authoritative revisions", () => {
    const view = renderPanel();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "100" } });

    view.rerender(panel({
      inventory: inventorySnapshot(175),
      protection: protectionSnapshot(7, 2, 175)
    }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("100");

    view.rerender(panel({
      inventory: inventorySnapshot(175),
      protection: protectionSnapshot(8, 100, 175)
    }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("100");

    view.rerender(panel({
      inventory: inventorySnapshot(175),
      protection: protectionSnapshot(9, 42, 175)
    }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("42");
  });

  it("shows the current carried total instead of a stale policy total", () => {
    renderPanel({
      inventory: inventorySnapshot(175),
      protection: protectionSnapshot(7, 2, 9)
    });
    expect(screen.getByText(/175 carried/)).toBeTruthy();
    expect(screen.queryByText(/9 carried/)).toBeNull();
  });

  it("initializes newly appearing material identities without replacing active drafts", () => {
    const view = renderPanel();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Keep Leather in Inventory" }),
      { target: { value: "100" } }
    );
    const inventory = inventorySnapshot();
    view.rerender(panel({
      inventory: {
        ...inventory,
        items: [...inventory.items, {
          playerId: "player",
          resourceType: "wood",
          variant: null,
          quantity: 5,
          stackId: "00000000-0000-4000-8000-000000000002",
          slotIndex: 1,
          manualSplit: false
        }],
        totals: { ...inventory.totals, wood: 5 }
      }
    }));

    expect((
      screen.getByRole("textbox", { name: "Keep Leather in Inventory" }) as
        HTMLInputElement
    ).value).toBe("100");
    expect((
      screen.getByRole("textbox", { name: "Keep Wood in Inventory" }) as
        HTMLInputElement
    ).value).toBe("0");
  });

  it("discards abandoned edits when closed and reopened", () => {
    const view = renderPanel();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "100" } });
    view.rerender(panel({ open: false }));
    view.rerender(panel());

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("2");
  });
});

type PanelOverrides = {
  open?: boolean;
  protection?: InventoryProtectionSnapshot;
  inventory?: PlayerInventorySnapshot;
  onSetMaterialKeep?: (
    itemId: "leather",
    variant: string | null,
    quantity: number,
    revision: number
  ) => boolean;
  onSetUnique?: (
    equipmentInstanceId: string,
    protectedValue: boolean,
    revision: number
  ) => boolean;
  equipment?: EquipmentSnapshotV2;
  busy?: boolean;
};

function renderPanel(overrides: PanelOverrides = {}) {
  return render(panel(overrides));
}

function panel(overrides: PanelOverrides = {}): React.JSX.Element {
  return (
    <StrictMode>
      <InventoryProtectionPanel
        open={overrides.open ?? true}
        protection={overrides.protection ?? protectionSnapshot()}
        inventory={overrides.inventory ?? inventorySnapshot()}
        equipment={overrides.equipment ?? null}
        online
        busy={overrides.busy ?? false}
        layout="phone"
        onSetMaterialKeep={overrides.onSetMaterialKeep ?? (() => true)}
        onSetUnique={overrides.onSetUnique ?? vi.fn()}
        onClose={vi.fn()}
      />
    </StrictMode>
  );
}

function equipmentSnapshot(): EquipmentSnapshotV2 {
  return {
    playerId: "player",
    instances: [
      {
        instanceId: "editable",
        displayName: "Bronze Axe",
        itemLevel: 2,
        location: "inventory"
      },
      {
        instanceId: "system",
        displayName: "Equipped Spear",
        itemLevel: 3,
        location: "equipped"
      }
    ]
  } as EquipmentSnapshotV2;
}

function protectionSnapshot(
  revision = 7,
  keepQuantity = 2,
  currentTotal = 120
): InventoryProtectionSnapshot {
  return {
    playerId: "player",
    revision,
    materialPolicies: [{
      itemId: "leather",
      variant: "tanned",
      keepQuantity,
      currentTotal
    }],
    uniqueItems: [
      { equipmentInstanceId: "editable", protected: false, systemReason: null },
      {
        equipmentInstanceId: "system",
        protected: true,
        systemReason: "Equipped items cannot be stored"
      }
    ],
    stackAllocations: []
  };
}

function inventorySnapshot(quantity = 120): PlayerInventorySnapshot {
  return {
    playerId: "player",
    revision: 0,
    items: [{
      playerId: "player",
      resourceType: "leather",
      variant: "tanned",
      quantity,
      stackId: "00000000-0000-4000-8000-000000000001",
      slotIndex: 0,
      manualSplit: false
    }],
    unlockedSlots: 16,
    totals: { ...emptyInventoryTotals(), leather: quantity }
  };
}

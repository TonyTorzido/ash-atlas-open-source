// @vitest-environment jsdom

import {
  emptyInventoryTotals,
  type CityWarehouseSnapshot,
  type InventoryProtectionSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CityWarehousePanel } from "./CityWarehousePanel.js";

const warehouseId = "00000000-0000-4000-8000-000000000001";
const woodStackId = "00000000-0000-4000-8000-000000000101";

const callbacks = {
  onDonate: vi.fn(() => true),
  onDonateAll: vi.fn(() => true),
  onDonateGold: vi.fn(() => true),
  onMove: vi.fn(() => true),
  onMoveInventory: vi.fn(() => true),
  onReorganizeInventory: vi.fn(() => true),
  onClose: vi.fn()
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("City Warehouse donations", () => {
  it("stages exact donations in Ash Atlas confirmation without native UI", () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Wood, quantity 30/ }));
    const actionDialog = screen.getByLabelText("Wood actions");
    fireEvent.click(
      within(actionDialog).getByRole("button", { name: "Donate" }),
    );
    fireEvent.change(within(actionDialog).getByRole("spinbutton", { name: "Donate quantity" }), {
      target: { value: "7" }
    });
    fireEvent.click(within(actionDialog).getByRole("button", { name: "Donate 7" }));

    const confirmation = screen.getByRole("dialog", { name: "Donate 7 Wood?" });
    expect(confirmation.textContent).toContain(
      "Donated materials become permanent city property and cannot be withdrawn."
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(callbacks.onDonate).not.toHaveBeenCalled();

    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(callbacks.onDonate).not.toHaveBeenCalled();
  });

  it("confirms one exact stack request and blocks repeat submission", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Wood, quantity 30/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Donate All" }),
    );

    const confirmation = screen.getByRole("dialog", { name: "Donate 30 Wood?" });
    const confirm = within(confirmation).getByRole("button", { name: "Donate 30" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(callbacks.onDonate).toHaveBeenCalledTimes(1);
    expect(callbacks.onDonate).toHaveBeenCalledWith({
      warehouseStructureId: warehouseId,
      stackId: woodStackId,
      itemId: "wood",
      displayName: "Wood",
      variant: null,
      quantity: 30
    });
  });

  it("retains game-styled bulk confirmation and cancel is inert", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Donate All Eligible" }));
    const confirmation = screen.getByRole("dialog", {
      name: "Donate all eligible materials?"
    });
    expect(confirmation.textContent).toContain("Protected quantities remain");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(callbacks.onDonateAll).not.toHaveBeenCalled();
  });
});

describe("City Warehouse authoritative states", () => {
  it("does not expose Visit from the open Warehouse panel", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Visit" })).toBeNull();

    cleanup();
    renderPanel({ layout: "phone" });
    expect(screen.queryByRole("button", { name: "Visit" })).toBeNull();
  });

  it("uses a single Back action in the phone footer", () => {
    renderPanel({ layout: "phone" });
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Return to Game" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to World" })).toBeNull();
  });

  it("validates and fences one permanent Gold donation", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Donate Gold" }));
    const dialog = screen.getByRole("dialog", { name: "Donate Gold" });
    const input = within(dialog).getByRole("spinbutton", {
      name: "Whole Gold amount"
    });
    const donate = within(dialog).getByRole("button", { name: "Donate" });
    expect((donate as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "1001" } });
    expect(within(dialog).getByRole("alert").textContent).toContain("wallet");
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(donate);
    fireEvent.click(donate);

    expect(callbacks.onDonateGold).toHaveBeenCalledTimes(1);
    expect(callbacks.onDonateGold).toHaveBeenCalledWith("100");
  });

  it("caps the Gold Max action to the wallet and avoids native prompts", () => {
    const nativePrompt = vi.spyOn(window, "prompt");
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Donate Gold" }));
    const dialog = screen.getByRole("dialog", { name: "Donate Gold" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Max" }));
    expect((within(dialog).getByRole("spinbutton", {
      name: "Whole Gold amount"
    }) as HTMLInputElement).value).toBe("1000");
    expect(nativePrompt).not.toHaveBeenCalled();
  });

  it("renders actual items, artwork, names, variants, quantities, and weight", () => {
    const { container } = renderPanel();
    for (const label of [
      /Wood, quantity 25/,
      /Stone, quantity 12/,
      /Balsam Resin, quantity 6/,
      /Tanned Leather, quantity 4/,
      /Ore, quantity 9/
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(container.querySelectorAll(
      '[aria-label="City Warehouse"] .inventory-entry-row .item-artwork'
    )).toHaveLength(5);
    expect(screen.getByText("Tier 2", { exact: false })).toBeTruthy();
    expect(screen.getByText("Storage weight")).toBeTruthy();
  });

  it("renders loading, empty, error, and feedback without an indefinite loader", () => {
    const view = renderPanel({ warehouse: null });
    expect(screen.getByRole("status").textContent).toContain(
      "Loading authoritative City Warehouse"
    );

    view.rerender(panel({
      warehouse: { ...warehouseSnapshot(), stacks: [], usedSlots: 0 },
      feedback: "Mesa City Warehouse opened. The Warehouse is empty."
    }));
    expect(screen.getByText(/This City Warehouse is empty/)).toBeTruthy();

    view.rerender(panel({
      warehouse: null,
      error: "You must be standing near this City Warehouse."
    }));
    expect(screen.getByRole("alert").textContent).toContain("standing near");
    expect(screen.queryByText(/Loading authoritative City Warehouse/)).toBeNull();
  });

  it("switches phone panes and exposes the donated Warehouse material", () => {
    renderPanel({ layout: "phone" });
    expect(screen.getByRole("region", { name: "Player Inventory" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "City Warehouse" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "City Warehouse" }));
    expect(screen.getByRole("region", { name: "City Warehouse" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Wood, quantity 25/ })).toBeTruthy();
  });
});

function renderPanel(overrides: PanelOverrides = {}) {
  return render(panel(overrides));
}

type PanelOverrides = Partial<{
  warehouse: CityWarehouseSnapshot | null;
  activeWarehouseStructureId: string | null;
  pending: boolean;
  feedback: string | null;
  error: string | null;
  layout: "desktop" | "phone";
}>;

function panel(overrides: PanelOverrides = {}): React.JSX.Element {
  return (
    <CityWarehousePanel
      open
      warehouse={overrides.warehouse === undefined
        ? warehouseSnapshot()
        : overrides.warehouse}
      activeWarehouseStructureId={
        overrides.activeWarehouseStructureId === undefined
          ? warehouseId
          : overrides.activeWarehouseStructureId
      }
      inventory={inventorySnapshot()}
      protection={protectionSnapshot()}
      online
      pending={overrides.pending ?? false}
      feedback={overrides.feedback ?? null}
      error={overrides.error ?? null}
      walletGold="1000"
      layout={overrides.layout ?? "desktop"}
      {...callbacks}
    />
  );
}

function inventorySnapshot(): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    revision: 0,
    items: [{
      playerId: "player-1",
      resourceType: "wood",
      variant: null,
      quantity: 30,
      stackId: woodStackId,
      slotIndex: 0,
      manualSplit: false
    }],
    unlockedSlots: 16,
    totals: { ...emptyInventoryTotals(), wood: 30 }
  };
}

function protectionSnapshot(): InventoryProtectionSnapshot {
  return {
    playerId: "player-1",
    revision: 1,
    materialPolicies: [],
    uniqueItems: [],
    stackAllocations: [{
      stackId: woodStackId,
      itemId: "wood",
      variant: null,
      protectedQuantity: 0,
      movableQuantity: 30,
      status: "none",
      reason: null
    }]
  };
}

function warehouseSnapshot(): CityWarehouseSnapshot {
  return {
    cityId: "00000000-0000-4000-8000-000000000002",
    structureId: warehouseId,
    cityName: "Mesa",
    tier: 2,
    currentWeightGrams: "8650",
    maximumWeightGrams: "1000000",
    usedSlots: 5,
    totalSlots: 100,
    revision: "5",
    canReorganize: false,
    gold: {
      balance: "0", capacity: "30000", remainingCapacity: "30000",
      lifetimeDonated: "0", lifetimeSpent: "0", revision: "0",
      canDonate: true, recentDonations: []
    },
    stacks: [
      stack(201, 0, "wood", null, 25),
      stack(202, 3, "stone", null, 12),
      stack(203, 8, "balsam_resin", null, 6),
      stack(204, 14, "leather", "tanned", 4),
      stack(205, 19, "ore", null, 9)
    ]
  };
}

function stack(
  id: number,
  slotIndex: number,
  itemId: CityWarehouseSnapshot["stacks"][number]["itemId"],
  variant: string | null,
  quantity: number
): CityWarehouseSnapshot["stacks"][number] {
  return {
    stackId: `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
    slotIndex,
    itemId,
    variant,
    quantity,
    version: "1"
  };
}

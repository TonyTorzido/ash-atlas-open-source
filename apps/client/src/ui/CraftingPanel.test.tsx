// @vitest-environment jsdom

import { emptyInventoryTotals, type PlayerInventorySnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CraftingPanel } from "./CraftingPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CraftingPanel", () => {
  it("exposes the Torch recipe in the phone Game Menu app and sends one craft request", () => {
    const onCraftTorches = vi.fn(() => true);
    render(<CraftingPanel
      open
      layout="phone"
      inventory={inventory({ coal: 10, crude_oil: 100 })}
      hasSnapshot
      connectionStatus="online"
      onCraftTorches={onCraftTorches}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("dialog", { name: "Crafting" })).toBeTruthy();
    expect(screen.getByText("+25")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Craft 25 Torches" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("Torch requirements").textContent).toContain("10 Coal");
    expect(screen.getByLabelText("Torch requirements").textContent).toContain("100 Crude Oil");
    fireEvent.click(screen.getByRole("button", { name: "Craft 25 Torches" }));
    expect(onCraftTorches).toHaveBeenCalledOnce();
  });

  it("keeps crafting unavailable until the authoritative recipe materials exist", () => {
    render(<CraftingPanel
      open
      layout="desktop"
      inventory={inventory({ coal: 9, crude_oil: 100 })}
      hasSnapshot
      connectionStatus="online"
      onCraftTorches={vi.fn(() => true)}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("dialog", { name: "Crafting" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Craft 25 Torches" }).hasAttribute("disabled")).toBe(true);
    const recipeGroups = ["Supplies", "Bags", "Field consumables"]
      .map((name) => within(screen.getByRole("region", { name })).getAllByRole("img", { name: "Cannot craft yet" }).length);
    expect(recipeGroups.reduce((total, count) => total + count, 0)).toBe(16);
    expect(screen.getByLabelText("Coal 10, have 9, missing 1")).toBeTruthy();
    expect(screen.queryByText("Missing materials")).toBeNull();
  });

  it("projects protocol default variants and sums split material stacks", () => {
    render(<CraftingPanel
      open
      layout="desktop"
      inventory={{
        ...inventory(),
        items: [
          { playerId: "burner-1", resourceType: "coal", variant: null, quantity: 6 },
          { playerId: "burner-1", resourceType: "coal", variant: null, quantity: 4 },
          { playerId: "burner-1", resourceType: "crude_oil", variant: null, quantity: 100 }
        ],
        totals: { ...emptyInventoryTotals(), coal: 10, crude_oil: 100 }
      }}
      hasSnapshot
      connectionStatus="online"
      onCraftTorches={vi.fn(() => true)}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Craft 25 Torches" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("Coal 10, have 10")).toBeTruthy();
    expect(screen.getByLabelText("Crude Oil 100, have 100")).toBeTruthy();
  });

  it("lists swag weapons read-only by base weapon with have/need chips", () => {
    render(<CraftingPanel
      open
      layout="phone"
      inventory={{
        ...inventory(),
        items: [
          { playerId: "burner-1", resourceType: "iron_bar", variant: null, quantity: 10 },
          { playerId: "burner-1", resourceType: "wood", variant: null, quantity: 50 },
          { playerId: "burner-1", resourceType: "rusted_legion_blade", variant: null, quantity: 3 },
          { playerId: "burner-1", resourceType: "ancient_coin", variant: null, quantity: 1 }
        ]
      }}
      hasSnapshot
      connectionStatus="online"
      onCraftTorches={vi.fn(() => true)}
      onClose={vi.fn()}
    />);

    const swag = screen.getByRole("region", { name: "Swag weapons" });
    expect(swag.textContent).toContain("Craft at your Manor's Smithing Station.");
    expect(within(swag).queryAllByRole("button")).toHaveLength(0);
    const swords = within(swag).getByRole("region", { name: "Sword swag weapons" });
    expect(within(swords).getAllByRole("article")).toHaveLength(3);
    const gladius = within(swords).getByRole("group", { name: "Legion Gladius materials" });
    expect(within(gladius).getByRole("img", { name: "Rusted Legion Blade 3, have 3" })).toBeTruthy();
    expect(within(gladius).getByRole("img", { name: "Ancient Coin 3, have 1, missing 2" })).toBeTruthy();
    expect(within(swag).getAllByRole("region")).toHaveLength(8);
  });

  it("exposes the canonical Backpack +0 recipe in Crafting", () => {
    const onCraftBackpack = vi.fn(() => true);
    render(<CraftingPanel
      open
      layout="desktop"
      inventory={inventoryWithBackpackMaterials()}
      hasSnapshot
      connectionStatus="online"
      goldBalance="2000"
      onCraftTorches={vi.fn(() => true)}
      onCraftBackpack={onCraftBackpack}
      leatherworkingRank={1}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "Backpack +0" })).toBeTruthy();
    expect(screen.getByLabelText("Leather 80, have 80")).toBeTruthy();
    expect(screen.getByLabelText("Gold 2,000, have 2,000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Craft Backpack +0" }));
    expect(onCraftBackpack).toHaveBeenCalledOnce();
  });

  it("disables the Backpack craft below Leatherworking rank 1 and says why", () => {
    render(<CraftingPanel
      open
      layout="desktop"
      inventory={inventoryWithBackpackMaterials()}
      hasSnapshot
      connectionStatus="online"
      goldBalance="2000"
      onCraftTorches={vi.fn(() => true)}
      onCraftBackpack={vi.fn(() => true)}
      onClose={vi.fn()}
    />);
    expect((screen.getByRole("button", { name: "Craft Backpack +0" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Needs Leatherworking rank 1 to craft a Backpack.")).toBeTruthy();
  });
});

describe("CraftingPanel groups and search", () => {
  const renderPanel = () => render(<CraftingPanel
    open
    layout="phone"
    inventory={inventory()}
    hasSnapshot
    connectionStatus="online"
    onCraftTorches={vi.fn(() => true)}
    onClose={vi.fn()}
  />);

  it("groups recipes under sub-headers", () => {
    renderPanel();
    for (const title of ["Supplies", "Bags", "Field Consumables", "Gathering Tools", "Utility Gear", "Swag Weapons"]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
  });

  it("filters by recipe or material name, hides empty groups, and clears", () => {
    renderPanel();
    const search = screen.getByRole("textbox", { name: "Search recipes" });
    fireEvent.change(search, { target: { value: "torch" } });
    expect(screen.getByRole("button", { name: "Craft 25 Torches" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Bags" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Swag Weapons" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Field Consumables" })).toBeNull();
    expect(screen.queryByText("Fertilizer")).toBeNull();

    fireEvent.change(search, { target: { value: "LEATHER" } });
    expect(screen.getByRole("heading", { name: "Bags" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Supplies" })).toBeNull();

    fireEvent.change(search, { target: { value: "zzzz-nothing" } });
    expect(screen.getByText("No recipes match.")).toBeTruthy();
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect((search as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("No recipes match.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Supplies" })).toBeTruthy();
  });

  it("crafts starter gathering tools on the player once materials are carried", () => {
    const onCraftGatheringTool = vi.fn(() => true);
    const props = {
      open: true,
      layout: "phone" as const,
      inventory: {
        ...inventory(),
        items: [{ playerId: "burner-1", resourceType: "wood" as const, variant: null, quantity: 20 }],
        totals: { ...emptyInventoryTotals(), wood: 20 }
      },
      hasSnapshot: true,
      onCraftTorches: vi.fn(() => true),
      onCraftGatheringTool,
      onClose: vi.fn()
    };
    const { rerender } = render(<CraftingPanel {...props} connectionStatus="online" />);
    const tools = within(screen.getByRole("region", { name: "Gathering tools" }));
    expect(tools.getByRole("button", { name: "Craft Stone Hatchet" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(tools.getByRole("button", { name: "Craft Wooden Hatchet" }));
    expect(onCraftGatheringTool).toHaveBeenCalledWith("wooden_axe");

    rerender(<CraftingPanel {...props} connectionStatus="offline" />);
    expect(tools.getByRole("button", { name: "Craft Wooden Hatchet" }).hasAttribute("disabled")).toBe(true);
    rerender(<CraftingPanel {...props} connectionStatus="online" busy />);
    expect(tools.getAllByRole("button", { name: "Crafting…" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
  });
});

function inventory(values: Partial<Record<"coal" | "crude_oil", number>> = {}): PlayerInventorySnapshot {
  const coal = values.coal ?? 0;
  const crudeOil = values.crude_oil ?? 0;
  return {
    playerId: "burner-1",
    revision: 1,
    items: [
      ...(coal > 0 ? [{ playerId: "burner-1", resourceType: "coal" as const, variant: null, quantity: coal }] : []),
      ...(crudeOil > 0 ? [{ playerId: "burner-1", resourceType: "crude_oil" as const, variant: null, quantity: crudeOil }] : [])
    ],
    totals: { ...emptyInventoryTotals(), coal, crude_oil: crudeOil },
    unlockedSlots: 16
  };
}

function inventoryWithBackpackMaterials(): PlayerInventorySnapshot {
  return {
    ...inventory(),
    items: [{ playerId: "burner-1", resourceType: "leather", variant: null, quantity: 80 }],
    totals: { ...emptyInventoryTotals(), leather: 80 }
  };
}

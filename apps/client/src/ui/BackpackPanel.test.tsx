// @vitest-environment jsdom

import {
  emptyInventoryTotals,
  type BackpackInstanceSnapshot,
  type BackpackSnapshot
} from "@ash-atlas/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BackpackPanel } from "./BackpackPanel.js";

describe("BackpackPanel", () => {
  it("directs new backpack crafting to the canonical Crafting menu", () => {
    render(
      <BackpackPanel
        open
        backpacks={snapshot()}
        inventory={{
          playerId: "player-1",
          revision: 1,
          items: [],
          totals: { ...emptyInventoryTotals(), leather: 50 },
          unlockedSlots: 40
        }}
        goldBalance="100"
        online
        pending={false}
        feedback={null}
        onEquip={vi.fn()}
        onUnequip={vi.fn()}
        onUpgrade={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/No backpacks owned\. Craft a Backpack \+0 from the Crafting menu/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Craft Backpack +0" })).toBeNull();
  });

  it("shows explicit upgrade levels and the maximum +10 state", () => {
    render(
      <BackpackPanel
        open
        backpacks={snapshot([
          instance("starter", "starter_backpack", 0, 1),
          instance("trailblazer", "trailblazer_backpack", 1, 15),
          null,
          null
        ])}
        inventory={{
          playerId: "player-1",
          revision: 1,
          items: [],
          totals: { ...emptyInventoryTotals(), leather: 100 },
          unlockedSlots: 56
        }}
        goldBalance="500"
        online
        pending={false}
        feedback={null}
        onCreate={vi.fn()}
        onEquip={vi.fn()}
        onUnequip={vi.fn()}
        onUpgrade={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Upgrade to +1" })).toBeTruthy();
    expect(screen.getByText("Maximum upgrade +10")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Equip|Unequip|Position/ })).toBeNull();
  });
});

function snapshot(
  equipped: BackpackSnapshot["equipped"] = [null, null, null, null]
): BackpackSnapshot {
  return {
    playerId: "player-1",
    revision: 1,
    baseSlots: 40,
    backpackBonusSlots: equipped.reduce(
      (total, item) => total + (item?.capacityBonus ?? 0),
      0
    ),
    effectiveSlots: 40 + equipped.reduce(
      (total, item) => total + (item?.capacityBonus ?? 0),
      0
    ),
    maximumSlots: 100,
    equipped,
    instances: equipped.filter(
      (item): item is BackpackInstanceSnapshot => item !== null
    )
  };
}

function instance(
  instanceId: string,
  definitionId: BackpackInstanceSnapshot["definitionId"],
  equippedSlot: number,
  capacityBonus: number
): BackpackInstanceSnapshot {
  return {
    instanceId,
    ownerPlayerId: "player-1",
    definitionId,
    displayName: definitionId === "starter_backpack"
      ? "Starter Pack"
      : "Trailblazer Pack",
    location: "equipped",
    capacityBonus,
    upgradeLevel: definitionId === "starter_backpack" ? 0 : 10,
    equippedSlot,
    inventorySlotIndex: null,
    manorId: null,
    manorSlotIndex: null,
    version: 1,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z"
  };
}

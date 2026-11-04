// @vitest-environment jsdom

import type { EquipmentInstanceV2 } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EquipmentSellCard } from "./MarketOverlay.js";

afterEach(cleanup);

describe("EquipmentSellCard price currency", () => {
  it("lists in Gold by default and in Glimmer after the toggle, confirming in that currency", () => {
    const onList = vi.fn(() => true);
    render(<EquipmentSellCard instance={ring()} disabled={false} onList={onList} />);

    const toggle = screen.getByRole("group", { name: "Price currency" });
    expect(toggle.querySelector("[aria-pressed='true']")?.textContent).toBe("Gold");
    fireEvent.change(screen.getByLabelText("Asking price"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Glimmer" }));
    expect(toggle.querySelector("[aria-pressed='true']")?.textContent).toBe("Glimmer");

    fireEvent.click(screen.getByRole("button", { name: "List item" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm · 250 Glimmer" }));
    expect(onList).toHaveBeenCalledWith(ring().instanceId, "250", "glimmer");
  });

  it("returns to review when the currency changes after Review", () => {
    const onList = vi.fn(() => true);
    render(<EquipmentSellCard instance={ring()} disabled={false} onList={onList} />);
    fireEvent.change(screen.getByLabelText("Asking price"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "List item" }));
    expect(screen.getByRole("button", { name: "Confirm · 40 gold" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Glimmer" }));
    expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull();
    expect(onList).not.toHaveBeenCalled();
  });
});

function ring(): EquipmentInstanceV2 {
  return {
    instanceId: "00000000-0000-4000-8000-000000000004",
    definitionId: "chopping_ring",
    displayName: "Chopping Ring",
    ownerPlayerId: "player-1",
    location: "inventory",
    equippedSlot: null,
    droppable: false,
    itemLevel: 0,
    category: "ring",
    savedKitIndices: [],
    derived: {},
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z"
  } as unknown as EquipmentInstanceV2;
}

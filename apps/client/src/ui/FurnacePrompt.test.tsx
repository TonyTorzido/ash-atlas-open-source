// @vitest-environment jsdom

import { emptyInventoryTotals, type FurnaceStateSnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FurnaceActionPrompt, FurnacePrompt } from "./FurnacePrompt.js";

afterEach(cleanup);

describe("FurnacePrompt", () => {
  it("presents the compact Furnace action and requires an explicit Use before approach", () => {
    const onSmelt = vi.fn();
    const onClose = vi.fn();
    render(<FurnaceActionPrompt
      furnace={state(null).furnace}
      state={null}
      ownPlayerId="owner"
      connected
      feedback={null}
      collecting={false}
      onSmelt={onSmelt}
      onCollect={vi.fn()}
      onClose={onClose}
    />);

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("CRAFTING")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(onSmelt).toHaveBeenCalledWith();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("presents the canonical recipe rail and starts the selected batch", () => {
    const onStart = vi.fn();
    render(<FurnacePrompt
      state={state(null)}
      inventory={{
        playerId: "owner",
        revision: 1,
        items: [],
        totals: { ...emptyInventoryTotals(), iron: 50, wood: 1_000 },
        unlockedSlots: 40
      }}
      feedback={null}
      busy={false}
      onStart={onStart}
      onCollect={vi.fn()}
      onClose={vi.fn()}
    />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: /Iron Bar 27 minutes/i }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(screen.getByText("5 Iron Bars")).toBeTruthy();
    expect(screen.getByRole("img", { name: /30, have 50$/u }).textContent).toBe("30");
    expect(screen.getByRole("img", { name: /450, have 1,000$/u }).textContent).toBe("450");
    expect(screen.getByRole("img", { name: "Can craft" })).toBeTruthy();
    expect(screen.getByText("27 minutes each")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Queue 5 Iron Bars" }));
    expect(onStart).toHaveBeenCalledWith("iron_bar", 5);
  });

  it("offers collection for only the completed uncollected bars", () => {
    render(<FurnacePrompt
      state={state({
        jobId: "00000000-0000-4000-8000-000000000004",
        recipeId: "iron_bar",
        outputItemId: "iron_bar",
        outputDisplayName: "Iron Bar",
        requestedQuantity: 3,
        completedQuantity: 2,
        collectedQuantity: 1,
        readyQuantity: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        nextCompletesAt: "2099-01-01T00:00:00.000Z",
        productionFinished: false
      })}
      inventory={{ playerId: "owner", revision: 1, items: [], totals: emptyInventoryTotals() }}
      feedback={null}
      busy={false}
      onStart={vi.fn()}
      onCollect={vi.fn()}
      onClose={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "View queue · 2 / 5 slots" }));
    expect(screen.getByRole("button", { name: "Collect 1 item" })).toBeTruthy();
    expect(screen.getAllByText("1 ready to collect")).toHaveLength(2);
    expect(screen.getByRole("progressbar", { name: "Progress toward Iron Bar" })).toBeTruthy();
  });

  it("opens on recipes and uses Back to Furnace to return from the explicit queue view", () => {
    const onClose = vi.fn();
    render(<FurnacePrompt
      state={state({
        jobId: "00000000-0000-4000-8000-000000000004",
        recipeId: "iron_bar",
        outputItemId: "iron_bar",
        outputDisplayName: "Iron Bar",
        requestedQuantity: 1,
        completedQuantity: 0,
        collectedQuantity: 0,
        readyQuantity: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        nextCompletesAt: "2099-01-01T00:00:00.000Z",
        productionFinished: false
      })}
      inventory={{ playerId: "owner", revision: 1, items: [], totals: emptyInventoryTotals() }}
      feedback={null}
      busy={false}
      layout="phone"
      onStart={vi.fn()}
      onCollect={vi.fn()}
      onClose={onClose}
    />);

    expect(screen.getByRole("navigation", { name: "Furnace recipes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View queue · 1 / 5 slots" }));
    expect(screen.getByText("Production queue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to Furnace" }));
    expect(screen.getByRole("navigation", { name: "Furnace recipes" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to World" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("refines Glimmer Oil with the Glimmer cost and balance shown, and explains a shortfall", () => {
    const onRefine = vi.fn(() => true);
    const props = {
      state: state(null),
      inventory: {
        playerId: "owner",
        revision: 1,
        items: [],
        totals: { ...emptyInventoryTotals(), crude_oil: 30 }
      },
      feedback: null,
      busy: false,
      onStart: vi.fn(),
      onRefineGlimmerOil: onRefine,
      onCollect: vi.fn(),
      onClose: vi.fn()
    };
    const { rerender } = render(<FurnacePrompt {...props} glimmerBalance="25" />);
    fireEvent.click(screen.getByRole("button", { name: /Glimmer Oil Instant/i }));
    fireEvent.click(screen.getByRole("button", { name: "20" }));
    expect(screen.getByRole("img", { name: "Glimmer 20, have 25" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Crude Oil 20, have 30" })).toBeTruthy();
    expect(screen.getByText("Instant · uses no queue slot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refine 20 Glimmer Oil" }));
    expect(onRefine).toHaveBeenCalledWith(20);

    rerender(<FurnacePrompt {...props} glimmerBalance="12" />);
    expect(screen.getByText("Need 8 more Glimmer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refine 20 Glimmer Oil" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(screen.getByRole("button", { name: "Refine 12 Glimmer Oil" }).hasAttribute("disabled")).toBe(false);
  });
});

function state(job: FurnaceStateSnapshot["jobs"][number] | null): FurnaceStateSnapshot {
  return {
    furnace: {
      furnaceId: "00000000-0000-4000-8000-000000000002",
      manorId: "00000000-0000-4000-8000-000000000003",
      ownerPlayerId: "owner",
      ownerUsername: "Ash",
      regionCode: "world-test",
      lat: 35,
      lon: -106,
      builtAt: "2026-01-01T00:00:00.000Z",
      placementRevision: 1
    },
    jobs: job ? [job] : [],
    queueCapacity: 5,
    occupiedSlots: job ? job.requestedQuantity - job.collectedQuantity : 0,
    serverTime: Date.now()
  };
}

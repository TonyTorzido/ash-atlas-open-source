// @vitest-environment jsdom

import { emptyInventoryTotals, type JewelStationState } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

import { JewelStationPanel } from "./JewelStationPanel.js";

function renderPanel(
  state: JewelStationState | null,
  overrides: Partial<React.ComponentProps<typeof JewelStationPanel>> = {}
) {
  const handlers = { onImbue: vi.fn(), onReforge: vi.fn(), onInscribe: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() };
  render(<JewelStationPanel
    open
    state={state}
    feedback={null}
    busy={false}
    online
    layout="desktop"
    {...handlers}
    {...overrides}
  />);
  return handlers;
}

describe("JewelStationPanel", () => {
  it("shows an opening failure and keeps retry available", () => {
    const onRetry = vi.fn();
    renderPanel(null, { feedback: "The Jewel Station did not respond. Try again.", onRetry });

    expect(screen.getByRole("alert").textContent).toContain("The Jewel Station did not respond. Try again.");
    screen.getByRole("button", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("infuses with four bars and no gemstone step", () => {
    const { onImbue } = renderPanel(stationState({ identity: null, totals: { whetted_bar: 4 } }));

    fireEvent.change(screen.getByLabelText("Metal"), { target: { value: "whetted" } });
    fireEvent.click(screen.getByRole("button", { name: "Infuse with Whetted" }));
    fireEvent.click(screen.getByRole("button", { name: "Infuse Whetted" }));
    expect(onImbue).toHaveBeenCalledWith("axe-1", "whetted");
  });

  it("blocks infusion without enough bars", () => {
    renderPanel(stationState({ identity: null, totals: { whetted_bar: 3 } }));
    fireEvent.change(screen.getByLabelText("Metal"), { target: { value: "whetted" } });
    expect(screen.getByRole("button", { name: "Infuse with Whetted" }).hasAttribute("disabled")).toBe(true);
  });

  it("locks Venom until Bitter Blood is complete", () => {
    const locked = renderPanel(stationState({ identity: null, totals: { venomsteel_bar: 4 } }));
    const action = screen.getByRole("button", { name: "Infuse with Venom" });
    expect(action.hasAttribute("disabled")).toBe(true);
    fireEvent.click(action);
    expect(locked.onImbue).not.toHaveBeenCalled();
  });

  it("changes the metal of an infused item for 230 Lumen", () => {
    const { onReforge } = renderPanel(stationState({ identity: "enh:v1:none:gale", totals: { lumen: 230 } }));

    fireEvent.click(screen.getByRole("button", { name: "Change Metal (230 Lumen)" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Change Metal (230 Lumen)" }).at(-1)!);
    expect(onReforge).toHaveBeenCalledWith("axe-1", { changeMetal: true });
  });

  it("hides the metal change without enough Lumen", () => {
    renderPanel(stationState({ identity: "enh:v1:none:gale", totals: { lumen: 229 } }));
    expect(screen.queryByRole("button", { name: /Change Metal/ })).toBeNull();
  });

  it("offers a 120 Lumen gem change and one 230 fee for both", () => {
    const { onReforge } = renderPanel(stationState({
      identity: "enh:v1:ruby:gale",
      totals: { lumen: 230 },
      stones: { opal: 1 }
    }));
    expect(screen.queryByRole("button", { name: /Change Gem/ })).toBeNull();
    fireEvent.change(screen.getByLabelText(/New gem/), { target: { value: "opal" } });
    expect(screen.getByRole("button", { name: "Change Both (230 Lumen)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change Gem (120 Lumen)" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Change Gem (120 Lumen)" }).at(-1)!);
    expect(onReforge).toHaveBeenCalledWith("axe-1", { gemstone: "opal", changeMetal: false });
  });
});

function stationState(input: {
  identity: string | null;
  totals: Record<string, number>;
  bitterBloodCompleted?: boolean;
  stones?: Record<string, number>;
}): JewelStationState {
  const completed = input.bitterBloodCompleted ?? false;
  return {
    equipment: {
      instances: [{
        instanceId: "axe-1",
        definitionId: "double_axe",
        displayName: "Double Axe",
        location: "inventory",
        category: "melee_weapon",
        enchantmentIdentity: input.identity
      }]
    },
    inventory: {
      playerId: "player-1",
      revision: 1,
      items: Object.entries(input.stones ?? {}).map(([variant, quantity]) => ({
        playerId: "player-1", resourceType: "enchantment_stone", variant, quantity
      })),
      totals: { ...emptyInventoryTotals(), ...input.totals }
    },
    achievements: {
      playerId: "player-1",
      achievements: [{
        achievementId: "bitter_blood",
        title: "Bitter Blood",
        badgeId: "bitter_blood",
        completed,
        completedAt: completed ? "2026-08-25T00:00:00.000Z" : null,
        statKey: "poison_damage_taken",
        value: completed ? 250 : 0,
        requiredValue: 250
      }],
      serverTime: 1
    }
  } as unknown as JewelStationState;
}

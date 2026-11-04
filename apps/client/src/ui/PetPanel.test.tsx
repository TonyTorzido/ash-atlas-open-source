// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { PET_SPECIES_IDS, type PetSnapshot, type PetStateSnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PetPanel } from "./PetPanel.js";

afterEach(cleanup);

const dog = {
  id: "pet-1", species: "trail_hound", name: "Trail Hound", level: 0, effectiveLevel: 0,
  unlockedAbilities: [], status: "ready", activeUntil: null, restUntil: null, pausedRemainingMs: null,
  lastFedAt: null, health: 90, maxHealth: 90, damage: 4, defense: 0, abilityReadyAt: {}, restDurationMs: 43_200_000
} as unknown as PetSnapshot;

const state = {
  pets: [dog], activePetId: null, gearCapLevel: 1, healItemQuantity: 0,
  eggs: [{ itemId: "clutch_egg", species: "emberclaw_raptor", quantity: 1 }],
  hermitOffers: [], treantCap: 0, minions: [], serverTime: new Date().toISOString()
} as unknown as PetStateSnapshot;

describe("PetPanel locked roster", () => {
  it("lists every pet you don't have, locked, with how to unlock it", () => {
    const noop = vi.fn();
    render(<PetPanel open state={state} connectionStatus="online" busy={null} error={null} notice={null}
      onClose={noop} onCall={noop} onDismiss={noop} onFeed={noop} onHeal={noop} onTrain={noop}
      onUnlock={noop} onHatch={noop} onBuyFromHermit={noop} onGrowTreant={noop} />);
    const locked = screen.getByRole("region", { name: "Locked pets" });
    expect(within(locked).queryByText("Trail Hound")).toBeNull();
    expect(within(locked).getAllByText("To unlock")).toHaveLength(PET_SPECIES_IDS.length - 1);
    expect(within(locked).getAllByText(/Grove Hermit in Blightwood Grove/u)).toHaveLength(2);
    expect(within(locked).getByText("Needs Rare Beast Mastery rank 1.")).toBeTruthy();
    expect(within(locked).getByText(/You have an Emberclaw Raptor egg/u)).toBeTruthy();
  });
});

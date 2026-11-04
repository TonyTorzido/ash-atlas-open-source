// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NearbySapling } from "../features/pets/useSaplingFeature.js";
import { SaplingPrompt } from "./SaplingPrompt.js";

afterEach(cleanup);

const HOUR = 3_600_000;
function entry(overrides: Partial<NearbySapling> = {}, sapling: Partial<NearbySapling["sapling"]> = {}): NearbySapling {
  return {
    sapling: {
      saplingId: "s1", stateRevision: 0, ownerPlayerId: "p1", ownerUsername: "Planter", lat: 0, lon: 0, state: "sapling",
      plantedAt: "2026-10-03T00:00:00Z", lastTendedAt: "2026-10-03T00:00:00Z", tendReadyAt: "2026-10-04T00:00:00Z",
      diesAt: "2026-10-05T00:00:00Z", maturesAt: "2026-10-08T00:00:00Z", fastGrowth: false, berryReadyAt: null,
      berryAvailable: false, ...sapling
    },
    distanceM: 5, inRange: true, phase: "needs_tending", growthPercent: 30,
    tendReadyInMs: 0, diesInMs: 30 * HOUR, maturesInMs: 50 * HOUR, berryReadyInMs: null, ...overrides
  };
}

function renderPrompt(e: NearbySapling, groveLoreRank = 0, own = "me", hasShovel = false) {
  const handlers = { onTend: vi.fn(), onPull: vi.fn(), onGather: vi.fn(), onChop: vi.fn(), onClose: vi.fn() };
  render(<SaplingPrompt entry={e} ownPlayerId={own} groveLoreRank={groveLoreRank} hasShovel={hasShovel} online busy={false} {...handlers} />);
  return handlers;
}

describe("SaplingPrompt", () => {
  it("shows owner, stage, growth and timers, and tends in range", () => {
    const handlers = renderPrompt(entry());
    expect(screen.getByText("Planted by Planter")).toBeTruthy();
    expect(screen.getByText("Stage: Sapling")).toBeTruthy();
    expect(screen.getByText("Growth: 30%")).toBeTruthy();
    expect(screen.getByText("Matures in 2d 2h")).toBeTruthy();
    expect(screen.getByText("Tend now")).toBeTruthy();
    expect(screen.getByText("Sick: it does not heal until tended")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tend" }));
    expect(handlers.onTend).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Pull up" })).toBeNull();
  });

  it("warns when dying and offers Pull only at Grove Lore rank 3", () => {
    renderPrompt(entry({ phase: "dying", diesInMs: 5 * HOUR }), 3);
    expect(screen.getByText("Dying: tend within 5h 0m")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pull up" })).toBeTruthy();
  });

  it("offers Pull with a Shovel at any Grove Lore rank, on anyone's sapling", () => {
    renderPrompt(entry(), 0, "someone-else", true);
    expect(screen.getByRole("button", { name: "Pull up" })).toBeTruthy();
  });

  it("keeps actions available out of range (choosing one walks there first)", () => {
    const handlers = renderPrompt(entry({ inRange: false, distanceM: 60 }), 3);
    fireEvent.click(screen.getByRole("button", { name: "Pull up" }));
    expect(handlers.onPull).toHaveBeenCalled();
    expect(screen.queryByText(/Move within .* m to use it/)).toBeNull();
  });

  it("grown trees gather when the berry is ready and show the regrow time otherwise", () => {
    const grown = { state: "grown" as const, tendReadyAt: null, diesAt: null, maturesAt: null };
    const handlers = renderPrompt(entry({ phase: null, growthPercent: null, berryReadyInMs: null }, grown));
    expect(screen.getByText("Stage: Grown Giving Tree")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Gather berry" }));
    expect(handlers.onGather).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Chop" }));
    expect(handlers.onChop).toHaveBeenCalled();
    cleanup();
    renderPrompt(entry({ phase: null, growthPercent: null, berryReadyInMs: 3 * HOUR }, grown));
    expect(screen.queryByRole("button", { name: "Gather berry" })).toBeNull();
    expect((screen.getByRole("button", { name: "Chop" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByText("Berries regrow in 3h 0m").length).toBeGreaterThan(0);
    cleanup();
    renderPrompt(entry({ inRange: false, distanceM: 60, phase: null, growthPercent: null }, grown));
    expect(screen.getByRole("button", { name: "Chop" })).toBeTruthy();
  });
});

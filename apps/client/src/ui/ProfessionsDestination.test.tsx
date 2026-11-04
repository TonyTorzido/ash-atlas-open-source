// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MasterySnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfessionsDestination } from "./ProfessionsDestination.js";

afterEach(cleanup);

const list = () => screen.getByRole("navigation", { name: "Professions" });
const group = (label: string) => screen.getByRole("region", { name: `${label} professions` });
const sheet = () => document.querySelector<HTMLElement>(".skill-v3-sheet");

describe("ProfessionsDestination", () => {
  it("shows every profession on one page grouped by category, without tabs or an SP balance", () => {
    renderDestination();
    expect(screen.queryByRole("tablist", { name: "Profession categories" })).toBeNull();
    expect(screen.queryByText(/skill points|SP balance/i)).toBeNull();
    const cards = (label: string, state: "live" | "future") =>
      Array.from(group(label).querySelectorAll<HTMLElement>(`.professions-entry-grid[data-content-state="${state}"] .profession-entry-card`), (card) => card.querySelector("strong")?.textContent);
    expect(cards("Gathering", "live")).toEqual(["Woodcutter", "Miner", "Oil Worker"]);
    expect(cards("Crafting", "live")).toEqual(["Metallurgy"]);
    expect(cards("Trade & World", "live")).toEqual(["Builder"]);
    expect(document.querySelector(".professions-list .progression-map")).toBeNull();
  });

  it("uses Main Menu as the root Back action", () => {
    const onClose = vi.fn();
    renderDestination("desktop", onClose);
    const back = screen.getByRole("button", { name: "Back to Game Menu" });
    expect(back.closest(".game-app-footer")).toBeTruthy();
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses supplied sprites for every live card", () => {
    renderDestination();
    expect(Array.from(list().querySelectorAll<HTMLElement>("[data-sprite-key]"), (icon) => icon.dataset.spriteKey)).toEqual([
      "woodcutter", "miner", "oil_worker",
      "metallurgy", "builder",
    ]);
    // Live Trades: Woodcutter, Miner, Oil Worker, Builder and one Metallurgy. Hunter and Breeder are retired.
    expect(Array.from(list().querySelectorAll<HTMLElement>(".profession-entry-card[data-content-state=\"live\"] strong"), (label) => label.textContent))
      .toEqual(["Woodcutter", "Miner", "Oil Worker", "Metallurgy", "Builder"]);
    expect(screen.queryByRole("button", { name: /^(Hunter|Breeder),/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Metallurgy,/ })).toHaveLength(1);
    expect(list().querySelector(".progression-icon-fallback")).toBeNull();
  });

  it("shows rank, an XP meter, XP to the next rank, and the mastery title once mastered", () => {
    const partial = masteries();
    render(<ProfessionsDestination open layout="desktop" onClose={vi.fn()} masteries={{
      ...partial,
      professions: { ...partial.professions, miner: { ...partial.professions.miner, xp: 1_500, rank: 2, nextRankXp: 2_000, mastered: false, completedAt: null, title: "Apprentice Miner" } }
    }} />);
    const miner = screen.getByRole("button", { name: /^Miner, Live mastery, Rank 2\/8/ });
    expect(miner.textContent).toContain("Rank 2/8");
    expect(miner.textContent).not.toContain("Apprentice Miner");
    expect(miner.textContent).toContain("500 XP to Rank 3");
    expect(miner.querySelector<HTMLElement>(".profession-entry-card-meter > i")!.style.width).not.toBe("");
    expect(screen.getByRole("button", { name: /^Woodcutter/ }).textContent).toContain("Mastered");
    expect(screen.getByRole("button", { name: /^Woodcutter/ }).textContent).toContain("Master Woodcutter");
    expect(screen.queryByRole("button", { name: /^(Alchemy|Blacksmithing|Leatherworking|Cartography|Tradecraft)/ })).toBeNull();
  });

  it("opens authoritative live rank, XP, title, and milestone values in the detail sheet", () => {
    const { container } = renderDestination();
    fireEvent.click(screen.getByRole("button", { name: /Oil Worker/ }));
    expect(sheet()?.getAttribute("data-layout")).toBe("desktop");
    expect(list()).toBeTruthy();
    expect(screen.getByText("25,000 / 25,000 XP · Mastered")).toBeTruthy();
    expect(container.querySelector('[data-milestone="2"]')).toBeTruthy();
    expect(container.querySelector('[data-milestone="5"]')).toBeTruthy();
    expect(container.querySelector('[data-milestone="8"]')).toBeTruthy();
    expect(sheet()!.querySelector(".profession-detail-header")).toBeTruthy();
    expect(sheet()!.querySelector(".profession-detail-ranks")).toBeTruthy();
    expect(container.querySelector(".profession-summary-grid")).toBeNull();
  });

  it("keeps Oil Worker’s authoritative remote harvest action in the detail sheet", () => {
    const onRemoteHarvestOilWell = vi.fn();
    render(<ProfessionsDestination
      open
      layout="phone"
      masteries={masteries()}
      oilWell={{
        structureId: "well-1", ownerPlayerId: "p1", ownerUsername: "p1",
        storedCrudeOil: 17, capacity: 128, productionPerHour: 10, serverTime: 0,
        nextUnitAt: new Date(6 * 60_000).toISOString(),
        fullAt: new Date(111 * 6 * 60_000).toISOString(),
        canHarvest: true, canDestroy: true
      }}
      onRemoteHarvestOilWell={onRemoteHarvestOilWell}
      onClose={() => undefined}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Oil Worker/ }));
    const harvest = within(sheet()!).getByRole("button", { name: "Harvest Crude" });
    expect((harvest as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(harvest);
    expect(onRemoteHarvestOilWell).toHaveBeenCalledOnce();
  });

  it("closes the sheet with its scrim or the footer Back, keeping the list", async () => {
    renderDestination();
    fireEvent.click(screen.getByRole("button", { name: /Woodcutter/ }));
    expect(sheet()).toBeTruthy();
    fireEvent.click(document.querySelector(".skill-v3-sheet-scrim")!);
    // The sheet stays mounted for its exit animation, inert, then unmounts.
    expect(sheet()?.getAttribute("data-state")).toBe("closing");
    await waitFor(() => expect(sheet()).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Miner/ }));
    const back = screen.getByRole("button", { name: "Back to Professions" });
    expect(back.closest(".game-app-footer")).toBeTruthy();
    fireEvent.click(back);
    await waitFor(() => expect(sheet()).toBeNull());
    expect(screen.getByRole("button", { name: "Back to Game Menu" })).toBeTruthy();
  });

  it("removes the former mastery and preview labels from every profession state", () => {
    renderDestination();
    expect(document.body.textContent).not.toMatch(/Authoritative mastery|Read-only preview|Read-only previews/);
    fireEvent.click(screen.getByRole("button", { name: /Miner/ }));
    expect(document.body.textContent).not.toMatch(/Authoritative mastery|Read-only preview|Read-only previews/);
  });

  it("closes the phone sheet on Escape without closing the destination", async () => {
    const onClose = vi.fn();
    renderDestination("phone", onClose);
    fireEvent.click(screen.getByRole("button", { name: /Miner/ }));
    expect(sheet()?.getAttribute("data-layout")).toBe("phone");
    expect(screen.getByRole("button", { name: "Back to Professions" }).closest(".phone-menu-footer")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(sheet()).toBeNull());
    expect(list()).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

function renderDestination(layout: "desktop" | "phone" = "desktop", onClose = vi.fn()) {
  return render(<ProfessionsDestination
    open
    layout={layout}
    masteries={masteries()}
    onClose={onClose}
  />);
}

function masteries(): MasterySnapshot {
  const complete = (trackId: "warrior" | "woodcutter" | "miner" | "builder" | "oil_worker" | "metallurgy", maximumRank: number, title: string) => ({
    trackId,
    xp: trackId === "warrior" ? 72_000 : trackId === "oil_worker" ? 25_000 : 100_000,
    rank: maximumRank,
    maximumRank,
    nextRankXp: null,
    completedAt: "2026-01-01T00:00:00.000Z",
    mastered: true,
    title
  });
  return {
    playerId: "p1",
    warrior: complete("warrior", 15, "Master Warrior"),
    professions: {
      woodcutter: complete("woodcutter", 8, "Master Woodcutter"),
      miner: complete("miner", 8, "Master Miner"),
      builder: complete("builder", 8, "Master Builder"),
      oil_worker: complete("oil_worker", 8, "Master Oil Worker"),
      metallurgy: complete("metallurgy", 8, "Master Metallurgy")
    },
    achievementIds: [],
    equippedTitle: "Master Warrior",
    serverTime: 0
  };
}

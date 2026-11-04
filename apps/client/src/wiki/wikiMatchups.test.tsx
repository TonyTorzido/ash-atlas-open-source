// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GENERATED_WIKI_DATA as data } from "../../../server/src/wiki/generatedWikiData.js";
import { MatchupExplorer } from "./MatchupExplorer.js";

afterEach(() => { cleanup(); });
beforeEach(() => { window.history.replaceState({}, "", "/wiki/character/matchups"); });

function renderExplorer() {
  return render(<MatchupExplorer matchups={data.matchups} />);
}

function rowValue(section: HTMLElement, name: string): string {
  const row = within(section).getByText(name, { selector: ".wiki-mx-row > span" }).closest(".wiki-mx-row")!;
  return row.querySelector("strong")!.textContent!;
}

describe("Weapon & Armor Matchups explorer", () => {
  it("shows what to bring and wear against the default monster, with a plain reason", () => {
    renderExplorer();
    expect(screen.getByRole("heading", { level: 2, name: "Wolf" })).toBeTruthy();
    expect(screen.getByText("Bite (Dagger) · Fur (Tunic)")).toBeTruthy();
    expect(screen.getByText("Fur (Tunic) gives way to Axe, Sling, Staff and Wand, and it shrugs off Unarmed.")).toBeTruthy();
    const bring = screen.getByTestId("matchup-bring");
    expect(rowValue(bring, "Sword")).toBe("8");
    expect(rowValue(bring, "Longbow")).toBe("4");
    expect(within(bring).getByRole("heading", { name: "Weak" }).parentElement!.textContent).toContain("Unarmed");
  });

  it("switches modes, updates the hash, and jumps from a monster card back to monster mode", () => {
    renderExplorer();
    fireEvent.click(screen.getByRole("button", { name: "I'm holding…" }));
    expect(window.location.hash).toBe("#weapon=sword");
    expect(screen.getByRole("heading", { level: 2, name: "Sword" })).toBeTruthy();
    const strong = screen.getByRole("region", { name: "Strong against" });
    fireEvent.click(within(strong).getByRole("button", { name: /Bandit/ }));
    expect(window.location.hash).toBe("#monster=bandit");
    expect(screen.getByRole("heading", { level: 2, name: "Bandit" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "I'm wearing…" }));
    expect(window.location.hash).toBe("#armor=leather");
    expect(screen.getByRole("heading", { level: 2, name: "Leather" })).toBeTruthy();
  });

  it("opens a deep link and follows browser history", () => {
    window.history.replaceState({}, "", "/wiki/character/matchups#armor=breastplate");
    renderExplorer();
    expect(screen.getByRole("heading", { level: 2, name: "Breastplate" })).toBeTruthy();
    window.history.pushState({}, "", "/wiki/character/matchups#monster=ogre");
    fireEvent(window, new PopStateEvent("popstate"));
    expect(screen.getByRole("heading", { level: 2, name: "Ogre" })).toBeTruthy();
  });

  it("updates every number live from the level steppers through the shared resolver", () => {
    renderExplorer();
    const bring = screen.getByTestId("matchup-bring");
    expect(rowValue(bring, "Sword")).toBe("8");
    fireEvent.click(screen.getByRole("button", { name: "Raise you level" }));
    expect(screen.getByLabelText("You level", { selector: "output" }).textContent).toBe("11");
    expect(rowValue(screen.getByTestId("matchup-bring"), "Sword")).toBe("9");
    fireEvent.click(screen.getByRole("button", { name: "Raise them level" }));
    fireEvent.click(screen.getByRole("button", { name: "Raise them level" }));
    expect(rowValue(screen.getByTestId("matchup-bring"), "Sword")).toBe("7");
    // Damage taken: Wolf Bite (Dagger, 4 into Leather) at level 12 vs leather level 11.
    expect(rowValue(screen.getByTestId("matchup-wear"), "Leather")).toBe(String(Math.round(4 + 12 - 11)));
  });

  it("hides upcoming weapons until the toggle is on, everywhere", () => {
    renderExplorer();
    expect(within(screen.getByTestId("matchup-bring")).queryByText("Martial Arts")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show upcoming weapons" }));
    expect(rowValue(screen.getByTestId("matchup-bring"), "Martial Arts")).toBe("5");
    const grid = screen.getByRole("table", { name: /Equal-level hit by weapon/ });
    expect(within(grid).getByRole("rowheader", { name: "Brass Knuckles" })).toBeTruthy();
    expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent))
      .toEqual(["Weapon", "Unarmored", "Tunic", "Leather", "Chainmail", "Breastplate", "Shield", "Wyrm Shield"]);
  });

  it("filters the monster picker by boss and search", () => {
    renderExplorer();
    const picker = screen.getByRole("group", { name: "Choose a monster" });
    fireEvent.click(screen.getByRole("button", { name: "Bosses" }));
    expect(within(picker).getByRole("button", { name: /The Xoral/ })).toBeTruthy();
    expect(within(picker).queryByRole("button", { name: /^Wolf$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "fur" } });
    expect(within(screen.getByRole("group", { name: "Choose a monster" })).getByRole("button", { name: /^Wolf/ })).toBeTruthy();
  });
});

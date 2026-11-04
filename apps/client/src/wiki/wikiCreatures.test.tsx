// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GENERATED_WIKI_DATA as data } from "../../../server/src/wiki/generatedWikiData.js";
import { CreatureRoster } from "./CreatureRoster.js";

afterEach(() => { cleanup(); });

function renderCreatures() {
  return render(<CreatureRoster creatures={data.creatures} />);
}

describe("Creatures roster", () => {
  it("shows flavor gear, links to the matchups page, and follows the level control", () => {
    renderCreatures();
    const wolf = screen.getByTestId("creature-wolf");
    expect(within(wolf).getByText("Bite (Dagger) · Fur (Tunic)")).toBeTruthy();
    expect(within(wolf).getByRole("link").getAttribute("href")).toBe("/wiki/character/matchups#monster=wolf");
    expect(within(wolf).getByText("Uncommon")).toBeTruthy();
    // Dagger into bare skin: 10 + 10 - 1.
    expect(screen.getByTestId("creature-wolf-hit").textContent).toBe("19");

    fireEvent.click(screen.getByRole("button", { name: "Raise creature level" }));
    expect(screen.getByLabelText("Creature level", { selector: "output" }).textContent).toBe("11");
    expect(screen.getByTestId("creature-wolf-hit").textContent).toBe("20");

    const bird = screen.getByTestId("creature-fire_bird");
    expect(within(bird).getByText("Hits ×1.5")).toBeTruthy();
    expect(bird.textContent).toContain("25 fixed");
  });
});

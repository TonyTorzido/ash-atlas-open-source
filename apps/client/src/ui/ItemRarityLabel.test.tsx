// @vitest-environment jsdom

import { ITEM_RARITIES } from "@ash-atlas/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ItemRarityLabel } from "./ItemRarityLabel.js";

describe("ItemRarityLabel", () => {
  it("renders visible text for every supported item rarity", () => {
    render(<>{ITEM_RARITIES.map((rarity) => (
      <ItemRarityLabel key={rarity} rarity={rarity} />
    ))}</>);

    for (const rarity of ITEM_RARITIES) {
      const label = screen.getByText(rarity[0]!.toUpperCase() + rarity.slice(1));
      expect(label.getAttribute("data-rarity")).toBe(rarity);
    }
  });
});

import { describe, expect, it } from "vitest";

import { offeringProgress, offeringSummary, RARE_BEAST_TROPHY_ITEM_IDS, WORLD_KNOWLEDGE_OVERWORLD_PARTS } from "./skillUnlockOfferings.js";

const parts = WORLD_KNOWLEDGE_OVERWORLD_PARTS.rare_beast_mastery!.parts;

describe("distinct_items offering part", () => {
  it("lists the five approved trophies and asks for three different ones", () => {
    expect(RARE_BEAST_TROPHY_ITEM_IDS).toEqual(["stormwing_talon", "chimera_horn", "patriarch_tusk", "elder_serpent_horn", "kraken_beak"]);
    expect(parts).toEqual([expect.objectContaining({ kind: "distinct_items", count: 3 })]);
    expect(offeringSummary(parts)).toBe("3 different trophies");
  });

  it("does not count duplicates of one trophy", () => {
    const [progress] = offeringProgress(parts, (itemId) => (itemId === "stormwing_talon" ? 3 : 0));
    expect(progress).toMatchObject({ have: 1, need: 3, met: false });
  });

  it("is met by three different trophies and spends exactly one of each", () => {
    const held: Record<string, number> = { kraken_beak: 2, chimera_horn: 1, stormwing_talon: 5, patriarch_tusk: 1 };
    const [progress] = offeringProgress(parts, (itemId) => held[itemId] ?? 0);
    expect(progress).toMatchObject({ have: 3, need: 3, met: true });
    expect(progress!.spend).toEqual([
      { itemId: "stormwing_talon", quantity: 1 },
      { itemId: "chimera_horn", quantity: 1 },
      { itemId: "patriarch_tusk", quantity: 1 }
    ]);
  });
});

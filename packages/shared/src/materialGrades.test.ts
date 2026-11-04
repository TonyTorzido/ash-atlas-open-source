import { describe, expect, it } from "vitest";

import { FURNACE_RECIPES, furnaceCategoryInputs, furnaceRecipeInputs } from "./furnace.js";
import { KITCHEN_COOK_ANY_CATEGORY, KITCHEN_RECIPES } from "./kitchen.js";
import { LOOM_RECIPES } from "./loom.js";
import {
  CATEGORY,
  GOBLIN_MARKET_RESOURCE_UNIT_PRICES,
  categoryAccepts,
  categoryEligible,
  highGradeGuardMessage,
  materialBreakdown,
  materialGrade,
  pickCategoryInputs,
  stationBreakdowns
} from "./materialGrades.js";
import { TANNERY_RECIPES } from "./tannery.js";

const held = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe("material grades and categories", () => {
  it("uses catalog rarity as grade and lets basics join their category", () => {
    expect(materialGrade("antler")).toBe(1);
    expect(materialGrade("fang")).toBe(2);
    expect(materialGrade("chimera_horn")).toBe(4);
    expect(categoryAccepts(CATEGORY.anyBones, "bone")).toBe(true);
    expect(categoryAccepts(CATEGORY.anyFish, "freshwater_fish")).toBe(true);
    expect(categoryAccepts(CATEGORY.anyScalesG2, "chitin")).toBe(false);
    expect(categoryAccepts(CATEGORY.anyWoodyPlant, "dryad_heartwood")).toBe(true);
    expect(categoryAccepts(CATEGORY.anyWoodyPlant, "grave_vine")).toBe(false);
  });

  it("never treats dungeon tokens, premium or signature items as category materials", () => {
    for (const itemId of ["raptor_scale", "giant_egg", "lumen", "dusk_heart", "ice_feather", "gift_box"]) {
      expect(categoryEligible(itemId)).toBe(false);
      expect(materialBreakdown(itemId)).toBeNull();
    }
  });
});

describe("pickCategoryInputs", () => {
  it("orders by grade, then Goblin floor, then quantity held, then item id", () => {
    const result = pickCategoryInputs([], [{ category: CATEGORY.anyBones, quantity: 10 }], held({
      shark_tooth: 50, fang: 3, claw: 4, bone: 2, antler: 5
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // G1 Bone (unsold, floor 0) before G1 Antler (2g); then G2 Claw (more held) before G2 Fang.
    expect(result.picks[0]).toEqual([
      { itemId: "bone", quantity: 2 },
      { itemId: "antler", quantity: 5 },
      { itemId: "claw", quantity: 3 }
    ]);
    expect(result.highGrade).toEqual([]);
  });

  it("reserves exact inputs first and excludes items the player cannot spend", () => {
    const result = pickCategoryInputs(
      [{ itemId: "iron_bar", quantity: 10 }, { itemId: "ice_feather", quantity: 1 }],
      [{ category: CATEGORY.anyScales, quantity: 10 }, { category: CATEGORY.anyFish, quantity: 10 }],
      held({ iron_bar: 10, ice_feather: 1, chitin: 6, merfolk_scale: 9, freshwater_fish: 4, pike_fillet: 8, raptor_scale: 50 })
    );
    expect(result.ok && result.picks).toEqual([
      [{ itemId: "chitin", quantity: 6 }, { itemId: "merfolk_scale", quantity: 4 }],
      [{ itemId: "freshwater_fish", quantity: 4 }, { itemId: "pike_fillet", quantity: 6 }]
    ]);
    expect(pickCategoryInputs([], [{ category: CATEGORY.anyBones, quantity: 3 }], held({ bone: 2 })))
      .toEqual({ ok: false, reason: "materials_required", label: "any Bones" });
  });

  it("flags G4+ picks for the guard and validates explicit picks (picks_changed)", () => {
    const auto = pickCategoryInputs([], [{ category: CATEGORY.anyVenomsG2, quantity: 1 }], held({ chimera_flame_gland: 1 }));
    expect(auto.ok && auto.highGrade).toEqual([{ itemId: "chimera_flame_gland", quantity: 1 }]);
    const inputs = [{ category: CATEGORY.anyBones, quantity: 1 }];
    expect(highGradeGuardMessage([{ itemId: "chimera_horn", quantity: 1 }])).toBe("This will use your Chimera Horn (Epic).");
    // Explicit choice of a non-lowest item is honoured (R6).
    const chosen = pickCategoryInputs([], inputs, held({ bone: 5, fang: 1 }), [[{ itemId: "fang", quantity: 1 }]]);
    expect(chosen.ok && chosen.debits).toEqual([{ itemId: "fang", quantity: 1 }]);
    // The previewed item is gone, ineligible, or the total is wrong: nothing is spent (R7).
    for (const picks of [[{ itemId: "fang", quantity: 1 }], [{ itemId: "raptor_scale", quantity: 1 }], [{ itemId: "bone", quantity: 2 }]]) {
      expect(pickCategoryInputs([], inputs, held({ bone: 5 }), [picks])).toMatchObject({ ok: false, reason: "picks_changed" });
    }
  });
});

describe("breakdown", () => {
  it("yields the section 1.3 table at existing stations", () => {
    expect(TANNERY_RECIPES.jaguar_pelt).toMatchObject({ outputItemId: "leather", outputPerInput: 12, maximumQuantity: 25, durationMs: 5_000 });
    expect(TANNERY_RECIPES.shell).toMatchObject({ outputItemId: "chitin", outputPerInput: 1 });
    expect(TANNERY_RECIPES.patriarch_tusk).toMatchObject({ outputItemId: "bone", outputPerInput: 20, breakdownGrade: 5 });
    expect(LOOM_RECIPES.centaur_horsehair).toMatchObject({ outputItemId: "cloth", outputPerInput: 4, inputMultiple: 1 });
    expect(LOOM_RECIPES.harpy_plume).toMatchObject({ outputItemId: "feather", outputPerInput: 4 });
    expect(KITCHEN_RECIPES.blubber).toMatchObject({ outputItemId: "crude_oil", outputPerBatch: 4 });
    expect(KITCHEN_RECIPES.animal_fat).toMatchObject({ outputItemId: "crude_oil", outputPerBatch: 2 });
    expect(materialBreakdown("mana_shard")).toMatchObject({ station: "furnace", outputItemId: "crystal", outputPerInput: 4 });
    expect(materialBreakdown("charged_core")).toMatchObject({ outputItemId: "gale_splinter", outputPerInput: 12 });
    // Venoms wait for the Reagent basic.
    expect(materialBreakdown("venom_sac")).toBeNull();
  });

  it("keeps every Goblin floor at or above its breakdown value (no NPC-gold arbitrage)", () => {
    for (const station of ["tannery", "loom", "furnace", "kitchen"] as const) {
      for (const entry of stationBreakdowns(station)) {
        const floor = GOBLIN_MARKET_RESOURCE_UNIT_PRICES[entry.inputItemId] ?? 0;
        const value = entry.outputPerInput * (GOBLIN_MARKET_RESOURCE_UNIT_PRICES[entry.outputItemId] ?? 0);
        expect(floor, entry.inputItemId).toBeGreaterThanOrEqual(value);
      }
    }
  });
});

describe("switched recipes", () => {
  it("furnace bars take categories and Skyrise smelts from Zephyr", () => {
    expect(furnaceCategoryInputs("revenant_bar", 2)).toEqual([{ category: CATEGORY.anyBones, quantity: 18 }]);
    expect(FURNACE_RECIPES.venomsteel_bar.inputs.map((input) => input.itemId)).toContain("dusk_heart");
    expect(furnaceCategoryInputs("ice_bar", 1)).toHaveLength(2);
    expect(furnaceRecipeInputs("skyrise_bar", 1).map((input) => [input.itemId, input.quantity]))
      .toEqual([["iron_bar", 4], ["skyrise_stone", 4], ["zephyr", 9]]);
  });

  it("Kitchen cook-any covers one-per-batch raw meat and fish only", () => {
    expect(categoryAccepts(KITCHEN_COOK_ANY_CATEGORY, "jaguar_cut")).toBe(true);
    expect(categoryAccepts(KITCHEN_COOK_ANY_CATEGORY, "pike_fillet")).toBe(true);
    expect(categoryAccepts(KITCHEN_COOK_ANY_CATEGORY, "freshwater_fish")).toBe(false);
    expect(categoryAccepts(KITCHEN_COOK_ANY_CATEGORY, "scorching_bird_meat")).toBe(false);
    expect(categoryAccepts(KITCHEN_COOK_ANY_CATEGORY, "deer_meat")).toBe(false);
  });
});

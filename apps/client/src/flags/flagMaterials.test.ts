import {
  emptyInventoryTotals,
  type FlagBuildMaterial,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  flagDeductionFeedback,
  flagMaterialGate,
  flagMaterialStatus,
  flagRecipeRequirements,
  insufficientFlagFeedback,
  shouldShowInsufficientFlagFeedback
} from "./flagMaterials.js";

const recipe = [
  { itemId: "wood", quantity: 3 },
  { itemId: "leather", quantity: 2 }
] satisfies FlagBuildMaterial[];

describe("authoritative flag material feedback", () => {
  it("becomes insufficient when any recipe material is missing", () => {
    const status = flagMaterialStatus(recipe, inventory({ wood: 4, leather: 1 }));

    expect(status.affordable).toBe(false);
    expect(flagMaterialGate(status, true)).toBe("insufficient");
    expect(status.materials.find(({ itemId }) => itemId === "leather")?.missing)
      .toBe(true);
  });

  it("returns to allowed as soon as the authoritative inventory is affordable", () => {
    const status = flagMaterialStatus(recipe, inventory({ wood: 3, leather: 2 }));

    expect(status.affordable).toBe(true);
    expect(flagMaterialGate(status, true)).toBe("allowed");
  });

  it("does not allow placement before recipe and inventory synchronization", () => {
    expect(flagMaterialGate(flagMaterialStatus([], inventory()), true))
      .toBe("syncing");
    expect(flagMaterialGate(flagMaterialStatus(recipe, inventory()), false))
      .toBe("syncing");
  });

  it("shows every current/required quantity and marks only missing lines red", () => {
    const feedback = insufficientFlagFeedback(
      flagMaterialStatus(recipe, inventory({ wood: 4, leather: 0 })),
      "player-1",
      "attempt-1"
    );

    expect(feedback.map(({ label }) => label)).toEqual([
      "4 / 3",
      "0 / 2"
    ]);
    expect(feedback.map(({ icon }) => icon)).toEqual(["wood", "leather"]);
    expect(feedback.map(({ kind }) => kind)).toEqual([
      "resource",
      "resource_missing"
    ]);
  });

  it("coalesces identical rapid feedback but allows changed totals immediately", () => {
    const previous = { fingerprint: "wood:0/3|leather:0/2", shownAt: 1_000 };

    expect(shouldShowInsufficientFlagFeedback(
      previous,
      previous.fingerprint,
      2_000
    )).toBe(false);
    expect(shouldShowInsufficientFlagFeedback(
      previous,
      "wood:1/3|leather:0/2",
      2_000
    )).toBe(true);
    expect(shouldShowInsufficientFlagFeedback(
      previous,
      previous.fingerprint,
      3_200
    )).toBe(true);
  });

  it("derives icon requirements for every server-provided material", () => {
    expect(flagRecipeRequirements([
      ...recipe,
      { itemId: "stone", quantity: 7 }
    ])).toEqual([
      { itemId: "wood", quantity: 3 },
      { itemId: "leather", quantity: 2 },
      { itemId: "stone", quantity: 7 }
    ]);
  });

  it("shows each authoritative deduction with its remaining total", () => {
    const feedback = flagDeductionFeedback(
      recipe,
      inventory({ wood: 41, leather: 6 }),
      "player-1",
      "build-1"
    );

    expect(feedback.map(({ label }) => label)).toEqual([
      "\u22123 \u00b7 41",
      "\u22122 \u00b7 6"
    ]);
    expect(feedback.map(({ icon }) => icon)).toEqual(["wood", "leather"]);
    expect(feedback.every(({ kind }) => kind === "resource_spent")).toBe(true);
  });
});

function inventory(
  totals: Partial<PlayerInventorySnapshot["totals"]> = {}
): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    revision: 0,
    items: [],
    totals: { ...emptyInventoryTotals(), ...totals }
  };
}

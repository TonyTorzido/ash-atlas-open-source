import { describe, expect, it } from "vitest";

import {
  chooseDeathDropBackpack,
  deathBackpackDropSkipReason,
  deathDropSummaryText,
  planDeathDropOverflow
} from "./deathBackpackDrop.js";

const pack = (instanceId: string, upgradeLevel: number, location: "equipped" | "inventory", equippedSlot: number | null = null) =>
  ({ instanceId, upgradeLevel, location, equippedSlot });

describe("death backpack drop", () => {
  it("drops the lowest-level backpack, equipped before spare, then highest slot, then id", () => {
    expect(chooseDeathDropBackpack([pack("a", 2, "equipped", 0), pack("b", 0, "equipped", 1), pack("c", 1, "inventory")])?.instanceId).toBe("b");
    expect(chooseDeathDropBackpack([pack("spare", 0, "inventory"), pack("worn", 0, "equipped", 0)])?.instanceId).toBe("worn");
    expect(chooseDeathDropBackpack([pack("low", 0, "equipped", 0), pack("high", 0, "equipped", 3)])?.instanceId).toBe("high");
    expect(chooseDeathDropBackpack([pack("z", 0, "inventory"), pack("m", 0, "inventory")])?.instanceId).toBe("m");
    expect(chooseDeathDropBackpack([])).toBeNull();
  });

  it("skips unknown context, interiors, dungeons and beginners", () => {
    expect(deathBackpackDropSkipReason({ space: null, killedByPlayer: true, level: 10 })).toBe("unknown_context");
    expect(deathBackpackDropSkipReason({ space: "interior", killedByPlayer: false, level: 10 })).toBe("interior");
    expect(deathBackpackDropSkipReason({ space: "dungeon", killedByPlayer: false, level: 10 })).toBe("dungeon");
    expect(deathBackpackDropSkipReason({ space: "overworld", killedByPlayer: false, level: 3 })).toBe("protected");
    expect(deathBackpackDropSkipReason({ space: "overworld", killedByPlayer: true, level: 4 })).toBeNull();
    expect(deathBackpackDropSkipReason({ space: "overworld", killedByPlayer: false, level: 4 })).toBeNull();
  });

  const always = (value: number) => () => value;
  const overflowInput = (random: () => number) => ({
    carriedWeightGrams: 20_000n,
    maximumWeightGramsAfter: 10_000n,
    random,
    stacks: [
      { itemId: "wood", variant: null, quantity: 100, droppableQuantity: 100, unitWeightGrams: 100 }, // 10 kg
      { itemId: "iron_bar", variant: null, quantity: 10, droppableQuantity: 10, unitWeightGrams: 500 }, // 5 kg
      { itemId: "lumen", variant: null, quantity: 500, droppableQuantity: 500, unitWeightGrams: 0 },
      { itemId: "relic", variant: null, quantity: 1, droppableQuantity: 0, unitWeightGrams: 50_000 }
    ],
    equipment: [
      { instanceId: "b", itemId: "starter_bow", unitWeightGrams: 1_500, droppable: true },
      { instanceId: "a", itemId: "starter_bow", unitWeightGrams: 1_500, droppable: true },
      { instanceId: "kit", itemId: "starter_bow", unitWeightGrams: 1_500, droppable: false }
    ]
  });

  it("drops nothing else when the load still fits", () => {
    expect(planDeathDropOverflow({
      carriedWeightGrams: 900n, maximumWeightGramsAfter: 1_000n, random: always(0),
      stacks: [{ itemId: "wood", variant: null, quantity: 9, droppableQuantity: 9, unitWeightGrams: 100 }],
      equipment: []
    })).toEqual({ entries: [], stacks: [], equipmentInstanceIds: [], fits: true });
  });

  it("walks the shuffled mix of stacks and gear, taking only the units still needed", () => {
    // 0.999 never swaps, so the walk follows the stable key order: gear a, gear b, iron bars, wood.
    const unshuffled = planDeathDropOverflow(overflowInput(always(0.999)));
    expect(unshuffled.entries).toEqual([
      { kind: "equipment", itemId: "starter_bow", instanceId: "a" },
      { kind: "equipment", itemId: "starter_bow", instanceId: "b" },
      { kind: "stack", itemId: "iron_bar", variant: null, quantity: 10 },
      { kind: "stack", itemId: "wood", variant: null, quantity: 20 }
    ]);
    expect(unshuffled.fits).toBe(true);
    // 0 always swaps with the front: gear b, iron bars, wood (35 of 100), and gear a is never needed.
    const shuffled = planDeathDropOverflow(overflowInput(always(0)));
    expect(shuffled.entries).toEqual([
      { kind: "equipment", itemId: "starter_bow", instanceId: "b" },
      { kind: "stack", itemId: "iron_bar", variant: null, quantity: 10 },
      { kind: "stack", itemId: "wood", variant: null, quantity: 35 }
    ]);
    expect(shuffled.stacks).toEqual([
      { itemId: "iron_bar", variant: null, quantity: 10 },
      { itemId: "wood", variant: null, quantity: 35 }
    ]);
    expect(shuffled.equipmentInstanceIds).toEqual(["b"]);
    for (const plan of [unshuffled, shuffled]) {
      const chosen = plan.entries.map((entry) => entry.kind === "stack" ? entry.itemId : entry.instanceId);
      expect(chosen).not.toContain("lumen");
      expect(chosen).not.toContain("relic");
      expect(chosen).not.toContain("kit");
    }
  });

  it("gives the same plan for the same random sequence, whatever the input order", () => {
    const sequence = () => {
      const values = [0.42, 0.07, 0.9, 0.5];
      let index = 0;
      return () => values[index++ % values.length]!;
    };
    const forward = planDeathDropOverflow(overflowInput(sequence()));
    const reversedInput = overflowInput(sequence());
    const reversed = planDeathDropOverflow({
      ...reversedInput,
      stacks: [...reversedInput.stacks].reverse(),
      equipment: [...reversedInput.equipment].reverse()
    });
    expect(reversed).toEqual(forward);
    expect(forward.fits).toBe(true);
  });

  it("reports when nothing droppable can make the load fit", () => {
    expect(planDeathDropOverflow({
      carriedWeightGrams: 5_000n, maximumWeightGramsAfter: 1_000n, random: always(0.5),
      stacks: [{ itemId: "wood", variant: null, quantity: 10, droppableQuantity: 10, unitWeightGrams: 100 }],
      equipment: [{ instanceId: "kit", itemId: "starter_bow", unitWeightGrams: 9_000, droppable: false }]
    }).fits).toBe(false);
  });

  it("summarizes the dropped lines", () => {
    expect(deathDropSummaryText({ outcome: "protected", lines: [] })).toBeNull();
    expect(deathDropSummaryText({
      outcome: "dropped",
      lines: [
        { kind: "backpack", itemId: "starter_backpack", name: "Backpack +0", quantity: 1 },
        { kind: "item", itemId: "hog_carcass", name: "Hog Carcass", quantity: 3 }
      ]
    })).toBe("Dropped Backpack +0, Hog Carcass x3");
  });
});

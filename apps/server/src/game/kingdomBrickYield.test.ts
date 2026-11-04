import { describe, expect, it } from "vitest";

import { kingdomBrickYieldChance } from "./kingdomBrickYield.js";

describe("kingdom brick yield chance", () => {
  it("rolls 10% normally and 25% on war land for Boundary Writ", () => {
    expect(kingdomBrickYieldChance(false)).toBe(0.1);
    expect(kingdomBrickYieldChance(true)).toBe(0.25);
  });
});

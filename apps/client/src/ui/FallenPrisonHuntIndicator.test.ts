import { describe, expect, it } from "vitest";

import { fallenPrisonHuntLabel } from "./FallenPrisonHuntIndicator.js";

describe("Fallen Prison hunt indicator", () => {
  it("shows only the compass point and the coarse band, and the smoke once in sight", () => {
    expect(fallenPrisonHuntLabel({ direction: "north-east", band: "far", smokeInSight: false })).toBe("North-east, far");
    expect(fallenPrisonHuntLabel({ direction: "south", band: "closer", smokeInSight: false })).toBe("South, closer");
    expect(fallenPrisonHuntLabel({ direction: "west", band: "near", smokeInSight: true })).toBe("West, near. Look for the smoke.");
    expect(fallenPrisonHuntLabel({ direction: "west", band: "near", smokeInSight: true })).not.toMatch(/[0-9]|✕|×/u);
  });
});

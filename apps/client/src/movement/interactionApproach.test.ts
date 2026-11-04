import { distanceMeters } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { getClosestInteractionApproachPoint } from "./interactionApproach.js";

describe("interaction approach movement", () => {
  it("targets a buffered point just inside the interaction radius", () => {
    const target = { lat: 35, lon: -106 };
    const player = { lat: 35, lon: -106 + 200 / 91_188 };
    const approach = getClosestInteractionApproachPoint(player, target, 20, 2);

    expect(approach).not.toBeNull();
    expect(distanceMeters(target, approach!)).toBeCloseTo(18, 1);
    expect(distanceMeters(player, approach!)).toBeLessThan(distanceMeters(player, target));
  });

  it("does not create a movement target when already in range", () => {
    const target = { lat: 35, lon: -106 };
    const player = { lat: 35, lon: -106 + 19 / 91_188 };

    expect(getClosestInteractionApproachPoint(player, target, 20, 2)).toBeNull();
  });
});

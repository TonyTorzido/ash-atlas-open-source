import { describe, expect, it } from "vitest";

import { resolveDodgeChance } from "./dodgeResolver.js";

describe("resolveDodgeChance", () => {
  it.each([
    [0.40, 0, false, false, 0.40],
    [0.40, 0, true, true, 0.20],
    [0.30, 0, true, true, 0.15],
    [0.18, 0, true, true, 0.09],
    [0.40, 0, false, true, 0.40],
    [0.40, 0.25, true, true, 0.075]
  ])("resolves %f - %f with Ninja=%s Ice weapon=%s to %f", (base, flatAntiDodge, ninja, ice, final) => {
    const resolved = resolveDodgeChance({
      base,
      flatAntiDodge,
      defenderIsActiveNinja: ninja,
      attackerUsedIceMetalWeapon: ice
    });
    expect(resolved).toMatchObject({ base, iceMetalNinjaMultiplierApplied: ninja && ice });
    expect(resolved.afterFlat).toBeCloseTo(Math.max(0, base - flatAntiDodge));
    expect(resolved.final).toBeCloseTo(final);
  });

  it("does not treat armor as a weapon input", () => {
    expect(resolveDodgeChance({ base: 0.40, flatAntiDodge: 0, defenderIsActiveNinja: true, attackerUsedIceMetalWeapon: false }).final).toBe(0.40);
  });
});

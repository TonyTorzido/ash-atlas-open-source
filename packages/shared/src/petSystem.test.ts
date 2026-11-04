import { describe, expect, it } from "vitest";

import {
  PET_SPECIES_DEFINITIONS,
  PET_SPECIES_IDS,
  petAbilityCooldownMs,
  petActiveDurationMs,
  petCombatStats,
  petEffectiveLevel,
  petGearCapLevel,
  petRestDurationMs,
  petSpeciesForItem
} from "./petSystem.js";

const HOUR = 60 * 60 * 1_000;

describe("pet rules", () => {
  it("rests 14 h minus 40 min per level, at least 7 h (7 h with Druid rank 2)", () => {
    expect(petRestDurationMs(0)).toBe(14 * HOUR);
    expect(petRestDurationMs(5)).toBe(38400000);
    expect(petRestDurationMs(20)).toBe(7 * HOUR);
    expect(petRestDurationMs(0, 2)).toBe(7 * HOUR);
  });

  it("caps effective training at the average of the best weapon and armour level", () => {
    expect(petGearCapLevel(10, 5)).toBe(7);
    expect(petEffectiveLevel(12, 7)).toBe(7);
    expect(petEffectiveLevel(3, 7)).toBe(3);
  });

  it("maps source stats and cuts only ability cooldowns with Companion Bond", () => {
    expect(petCombatStats("trail_hound", 0)).toEqual({ maxHp: 101, damage: 4, defense: 0 });
    expect(petCombatStats("storm_chick", 0).damage).toBe(1);
    expect(petCombatStats("brood_spinner", 3)).toEqual({ maxHp: 155, damage: 10, defense: 6 });
    expect(petAbilityCooldownMs("hold_fast", 3)).toBe(52_800);
    expect(petActiveDurationMs("ember_drake", 3)).toBe(9_000_000);
    expect(petActiveDurationMs("trail_hound", 3)).toBe(4_500_000);
  });

  it("defines every species with two abilities; later sources stay unavailable until their content ships", () => {
    for (const id of PET_SPECIES_IDS) expect(PET_SPECIES_DEFINITIONS[id].abilities).toHaveLength(2);
    expect(petSpeciesForItem("brood_egg")).toBe("brood_spinner");
    expect(petSpeciesForItem("wyrm_egg")).toBe("ember_drake");
    expect(["ember_drake", "deep_crawler", "glade_wisp"].map((id) =>
      PET_SPECIES_DEFINITIONS[id as "ember_drake"].source.available)).toEqual([true, false, false]);
  });
});

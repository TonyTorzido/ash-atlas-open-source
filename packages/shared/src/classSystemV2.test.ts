import { describe, expect, it } from "vitest";
import {
  ALL_TECHNIQUE_DEFINITIONS, CLASS_DEFINITIONS, CLASS_INNATE_DEFINITIONS, LAUNCH_ACTIVE_ABILITY_IDS,
  LAUNCH_CLASS_IDS, TECHNIQUE_BY_ID, ULTIMATE_UNLOCK_RANK, unlockedUltimateSlots
} from "./classes.js";

describe("Class System V2 catalog", () => {
  it("publishes four regulars, six passives, and one Rank 14 ultimate per V2 launch class", () => {
    // Knight and Druid launch on their own kits, not V2 technique sets.
    for (const classId of LAUNCH_CLASS_IDS.filter((id) => id !== "knight" && id !== "druid")) {
      const definitions = ALL_TECHNIQUE_DEFINITIONS.filter((entry) => entry.classId === classId && entry.id.includes("_v2_"));
      expect(definitions.filter((entry) => entry.kind === "normal")).toHaveLength(4);
      expect(definitions.filter((entry) => entry.kind === "passive")).toHaveLength(6);
      expect(definitions.filter((entry) => entry.kind === "ultimate")).toHaveLength(1);
      // The roster launches without hotbar actives (LAUNCH_ACTIVE_ABILITY_IDS is empty by design).
      expect(LAUNCH_ACTIVE_ABILITY_IDS[classId]).toHaveLength(0);
      expect(definitions.find((entry) => entry.kind === "ultimate")).toMatchObject({ unlockLevel: 14, cooldownMs: 300_000 });
    }
    expect(ULTIMATE_UNLOCK_RANK).toBe(14);
    expect([unlockedUltimateSlots(13), unlockedUltimateSlots(14)]).toEqual([0, 1]);
  });

  it("carries explicit activation, drag, and weapon-category contracts without id collisions", () => {
    const launchActives = LAUNCH_CLASS_IDS.flatMap((classId) => LAUNCH_ACTIVE_ABILITY_IDS[classId].map((id) => TECHNIQUE_BY_ID[id]!));
    expect(launchActives.every((entry) => entry.activation !== undefined)).toBe(true);
    expect(launchActives.filter((entry) => entry.activation === "drag").every((entry) => entry.dragTargetKind !== undefined)).toBe(true);
    expect(TECHNIQUE_BY_ID.ranger_v2_throughshot?.allowedWeaponCategories).toEqual(["bow", "crossbow", "sling"]);
    expect(TECHNIQUE_BY_ID.ninja_v2_twin_fang?.allowedWeaponCategories).toEqual(["shuriken"]);
    for (const id of ["ranger_v2_threefold_volley", "ranger_v2_marked_quarry", "ninja_v2_twin_fang", "ninja_v2_thousand_shadows"]) {
      expect(TECHNIQUE_BY_ID[id]?.targetRangeM).toBeUndefined();
    }
    expect(new Set(ALL_TECHNIQUE_DEFINITIONS.map((entry) => entry.id)).size).toBe(ALL_TECHNIQUE_DEFINITIONS.length);
  });

  it("publishes the exact launch V2 area and placement ranges", () => {
    expect(TECHNIQUE_BY_ID.warrior_v2_sundering_arc).toMatchObject({ targetRadiusM: 150 });
    expect(TECHNIQUE_BY_ID.warrior_v2_faultline).toMatchObject({ name: "Blood Rush", cooldownMs: 25_000, targetRangeM: 250 });
    expect(TECHNIQUE_BY_ID.warrior_v2_rallying_roar).toMatchObject({ targetRadiusM: 650 });
    expect(TECHNIQUE_BY_ID.warrior_v2_worldbreaker).toMatchObject({ targetRadiusM: 350 });
    expect(TECHNIQUE_BY_ID.ranger_v2_throughshot).toMatchObject({ targetRadiusM: 150 });
    expect(TECHNIQUE_BY_ID.ranger_v2_black_rain).toMatchObject({ targetRangeM: 650, targetRadiusM: 300 });
    expect(TECHNIQUE_BY_ID.ranger_v2_snare_shot).toMatchObject({ name: "Snare Trap", targetRangeM: 300, targetRadiusM: 25 });
    expect(TECHNIQUE_BY_ID.ninja_v2_shuriken_fan).toMatchObject({ targetRadiusM: 300 });
    expect(TECHNIQUE_BY_ID.ninja_v2_shadowstep).toMatchObject({ targetRangeM: 120 });
  });

  it("publishes the exact redesigned names, cooldowns, and activation modes on stable IDs", () => {
    for (const [id, name, cooldownMs, activation] of [
      ["warrior_v2_sundering_arc", "Cleave", 18_000, "armed"], ["warrior_v2_iron_reversal", "Iron Reversal", 22_000, "instant"],
      ["warrior_v2_faultline", "Blood Rush", 25_000, "instant"], ["warrior_v2_rallying_roar", "Rallying Roar", 35_000, "instant"], ["warrior_v2_worldbreaker", "Worldbreaker", 300_000, "instant"],
      ["ranger_v2_throughshot", "Piercing Arrow", 18_000, "armed"], ["ranger_v2_threefold_volley", "Retreat Volley", 24_000, "instant"],
      ["ranger_v2_marked_quarry", "Quarry Sign", 25_000, "instant"], ["ranger_v2_snare_shot", "Snare Trap", 25_000, "drag"], ["ranger_v2_black_rain", "Black Rain", 300_000, "drag"],
      ["ninja_v2_twin_fang", "Steel Tempest", 20_000, "instant"], ["ninja_v2_smoke_bomb", "Substitution", 25_000, "instant"],
      ["ninja_v2_shadowstep", "Ghost Step", 20_000, "drag"], ["ninja_v2_shuriken_fan", "Razor Fan", 18_000, "instant"], ["ninja_v2_thousand_shadows", "Thousand Blades", 300_000, "instant"]
    ] as const) expect(TECHNIQUE_BY_ID[id]).toMatchObject({ name, cooldownMs, activation });
  });

  it("publishes one permanent innate outside the technique catalog for every launch class", () => {
    expect(Object.keys(CLASS_INNATE_DEFINITIONS).sort()).toEqual([...LAUNCH_CLASS_IDS].sort());
    for (const classId of LAUNCH_CLASS_IDS) {
      const innate = CLASS_INNATE_DEFINITIONS[classId];
      expect(CLASS_DEFINITIONS[classId].innate).toBe(innate);
      expect(innate.classId).toBe(classId);
      expect(ALL_TECHNIQUE_DEFINITIONS.some(({ id }) => id === innate.id)).toBe(false);
    }
  });

  it("publishes Ninja's close-quarters Shuriken rule and Shuriken mastery without armor mastery", () => {
    expect(CLASS_DEFINITIONS.ninja.guaranteedTraits).toEqual([
      expect.objectContaining({
        id: "ninja_close_quarters_shuriken",
        name: "Close-Quarters Shuriken",
        levels: [1],
        description: "Shuriken remain usable and readied in melee range; the Ninja does not automatically switch to a melee weapon."
      }),
      expect.objectContaining({ id: "ninja_weapon_mastery", levels: [5, 9, 13] })
    ]);
    expect(CLASS_DEFINITIONS.ninja.guaranteedTraits[1]?.description).toContain("+4");
    expect(CLASS_DEFINITIONS.ninja.guaranteedTraits.some((trait) => trait?.id === "ninja_armor_mastery")).toBe(false);
  });

  it("discloses Ranger Bow mastery attack and range progression", () => {
    expect(CLASS_DEFINITIONS.ranger.guaranteedTraits[0]).toMatchObject({
      id: "ranger_weapon_mastery",
      levels: [5, 9, 13]
    });
    expect(CLASS_DEFINITIONS.ranger.guaranteedTraits[0]?.description).toContain("+1, +2, then +4 flat Attack");
    expect(CLASS_DEFINITIONS.ranger.guaranteedTraits[0]?.description).toContain("+25, +40, then +55 meters range");
  });
});

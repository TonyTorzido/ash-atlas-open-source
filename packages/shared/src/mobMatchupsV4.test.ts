import { describe, expect, it } from "vitest";

import { ARMOUR_TYPES_V4, DAMAGE_TYPES_V4 } from "./damageMatrixV4.js";
import { MOB_MATCHUPS } from "./mobMatchups.js";
import { MOB_V4_TYPES, mobV4Profile } from "./mobMatchupsV4.js";

describe("mob v4 types", () => {
  it("covers every archetype with valid types", () => {
    expect(Object.keys(MOB_V4_TYPES).sort()).toEqual(Object.keys(MOB_MATCHUPS).sort());
    for (const types of Object.values(MOB_V4_TYPES)) {
      expect(DAMAGE_TYPES_V4).toContain(types.damageType);
      expect(ARMOUR_TYPES_V4).toContain(types.armourType);
    }
  });

  it("follows the spec family defaults", () => {
    expect(MOB_V4_TYPES.wolf).toEqual({ damageType: "slash", armourType: "leather", tier: "low" });
    expect(MOB_V4_TYPES.alligator.armourType).toBe("mail");
    expect(MOB_V4_TYPES.coastal_crab.armourType).toBe("plate");
    expect(MOB_V4_TYPES.skeleton.armourType).toBe("bone");
    expect(MOB_V4_TYPES.gallows_ghost).toMatchObject({ damageType: "arcane", armourType: "spirit" });
    expect(MOB_V4_TYPES.barrow_wight.armourType).toBe("spirit");
    expect(MOB_V4_TYPES.slime.armourType).toBe("ooze");
    expect(MOB_V4_TYPES.blight_treant.armourType).toBe("bark");
    expect(MOB_V4_TYPES.capercaillie.damageType).toBe("pierce");
    expect(MOB_V4_TYPES.ogre.damageType).toBe("blunt");
  });

  it("bases mob hits on the tier and keeps the matchup multiplier", () => {
    expect(mobV4Profile("wolf")).toEqual({ damageType: "slash", armourType: "leather", tier: "low", baseDamage: 7, damageMultiplier: 1 });
    expect(mobV4Profile("bear")).toMatchObject({ tier: "medium", baseDamage: 12 });
    expect(mobV4Profile("elder_dragon")).toMatchObject({ tier: "strong", baseDamage: 25, damageMultiplier: 1.5 });
    expect(mobV4Profile("kraken").tier).toBe("strong");
  });

  it("hits a 100 HP player in ~14 / 8 / 4 hits at equal level and multiplier 1.0", () => {
    const hitsToKill = (archetype: Parameters<typeof mobV4Profile>[0]) => {
      const profile = mobV4Profile(archetype);
      return Math.ceil(100 / Math.round(profile.baseDamage * profile.damageMultiplier));
    };
    expect(hitsToKill("wolf")).toBe(15);
    expect(hitsToKill("bear")).toBe(9);
    expect(hitsToKill("bridge_troll")).toBe(4);
    expect(hitsToKill("elder_dragon")).toBe(3);
  });
});

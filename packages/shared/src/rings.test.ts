import { describe, expect, it } from "vitest";

import {
  RING_TIERS,
  isValidRingBonusRolls,
  resolveWornRingBonuses,
  ringDumpShards,
  ringPolishCost,
  ringTierWeights,
  rollConversionRingBonus,
  rollRingBonuses,
  rollRingDrops,
  seededRingRandom
} from "./rings.js";
import { wornRingMetals } from "./equipmentBalance.js";
import { metalEquipmentEnhancement, serializeEquipmentEnhancement } from "./equipmentEnhancements.js";

describe("random-roll rings", () => {
  it("rolls the tier's bonus count with no duplicate and only legal strengths", () => {
    const random = seededRingRandom("rolls");
    for (let index = 0; index < 400; index += 1) {
      for (const tier of RING_TIERS) {
        const bonuses = rollRingBonuses(tier, random);
        expect(isValidRingBonusRolls(tier, bonuses)).toBe(true);
        if (tier !== "peerless") expect(bonuses.some((roll) => roll.id.startsWith("attune_"))).toBe(false);
        if (tier === "fine" || tier === "plain") expect(bonuses.some((roll) => roll.id === "gloom_ward")).toBe(false);
      }
    }
    expect(isValidRingBonusRolls("plain", rollConversionRingBonus(random) ? [rollConversionRingBonus(random)] : [])).toBe(true);
  });

  it("prices polish and dump per tier, half polish for Atlas Pass", () => {
    expect([ringPolishCost("fine", false), ringPolishCost("prime", false), ringPolishCost("peerless", false)]).toEqual([12, 30, 60]);
    expect([ringPolishCost("fine", true), ringPolishCost("prime", true), ringPolishCost("peerless", true)]).toEqual([7, 18, 36]);
    expect(ringDumpShards("plain", false)).toBe(4);
    expect([ringDumpShards("peerless", true), ringDumpShards("peerless", false)]).toEqual([22, 38]);
  });

  it("shifts tier weights for elites, bosses and Peerless luck", () => {
    expect(ringTierWeights({ mobLevel: 5, source: "normal" })).toEqual([76, 24, 0, 0]);
    expect(ringTierWeights({ mobLevel: 5, source: "elite" })).toEqual([61, 39, 0, 0]);
    expect(ringTierWeights({ mobLevel: 15, source: "boss" })).toEqual([18, 42, 28, 12]);
    // Peerless luck only counts where Peerless already has weight.
    expect(ringTierWeights({ mobLevel: 5, source: "normal", peerlessLuck: 10 })).toEqual([76, 24, 0, 0]);
    expect(ringTierWeights({ mobLevel: 35, source: "normal", peerlessLuck: 10 })).toEqual([0, 22, 42, 36]);
    expect(rollRingDrops({ source: null, mobLevel: 30, random: () => 0 })).toEqual([]);
    expect(rollRingDrops({ source: "legendary", mobLevel: 30, random: () => 0 })).toHaveLength(2);
  });

  it("never stacks a bonus across both rings: highest wins, equal keeps slot 1", () => {
    const resolved = resolveWornRingBonuses([
      { instanceId: "a", tier: "fine", rough: false, bonuses: [{ id: "max_hp" }, { id: "dodge" }] },
      { instanceId: "b", tier: "peerless", rough: false, bonuses: [{ id: "max_hp" }, { id: "land_speed" }] }
    ]);
    expect(resolved.totals).toEqual({ max_hp: 17, land_speed: 3.75 });
    expect(resolved.lines.find((line) => line.instanceId === "a" && line.id === "max_hp")?.state).toBe("duplicate");
    expect(resolved.lines.find((line) => line.id === "dodge")?.state).toBe("inactive");
    const equal = resolveWornRingBonuses([
      { instanceId: "a", tier: "plain", rough: false, bonuses: [{ id: "venom_ward" }] },
      { instanceId: "b", tier: "fine", rough: false, bonuses: [{ id: "venom_ward" }, { id: "max_hp" }] }
    ]);
    expect(equal.lines.find((line) => line.instanceId === "a")?.state).toBe("active");
    expect(equal.lines.find((line) => line.instanceId === "b" && line.id === "venom_ward")?.state).toBe("duplicate");
  });

  it("reads worn weapon and armor metals for metal-gated bonuses", () => {
    const lightning = serializeEquipmentEnhancement(metalEquipmentEnhancement(null, "lightning"));
    expect([...wornRingMetals([lightning, null, "not-an-identity"])]).toEqual(["lightning"]);
  });
});

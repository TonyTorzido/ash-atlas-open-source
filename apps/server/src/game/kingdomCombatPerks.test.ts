import { describe, expect, it } from "vitest";

import { resolveKingdomCombatPerkEffects, breachCompanyAttackBonus, type KingdomCombatMember } from "./kingdomCombatPerks.js";

const druid: KingdomCombatMember = { kingdomId: "k1", perkIds: new Set(["verdant_surge"]) };
const plain: KingdomCombatMember = { kingdomId: "k1", perkIds: new Set() };
const at = (playerId: string, regionCode = "world") => ({ playerId, lat: 0, lon: 0, regionCode });

describe("kingdom combat perk effects", () => {
  it("Verdant Surge heals +4 on own kingdom land and in dungeons only", () => {
    const effects = resolveKingdomCombatPerkEffects({
      footprints: [at("home"), at("away"), at("dungeon", "interior:dungeon:abc"), at("nobody")],
      members: new Map([["home", druid], ["away", druid], ["dungeon", druid], ["nobody", plain]]),
      onOwnKingdomLand: new Set(["home", "nobody"])
    });
    expect(effects.get("home")?.healingBonus).toBe(4);
    expect(effects.get("away")?.healingBonus).toBe(0);
    expect(effects.get("dungeon")?.healingBonus).toBe(4);
    expect(effects.get("nobody")?.healingBonus).toBe(0);
  });

  it("Breach Company counts other kingdom members within 550 m, capped at +4", () => {
    const shock: KingdomCombatMember = { kingdomId: "k1", perkIds: new Set(["breach_company"]) };
    const other: KingdomCombatMember = { kingdomId: "k2", perkIds: new Set() };
    // 0.001 degrees of latitude is about 111 m.
    const near = (playerId: string, steps: number, regionCode = "world") =>
      ({ playerId, lat: steps * 0.001, lon: 0, regionCode });
    const members = new Map<string, KingdomCombatMember>([
      ["self", shock], ["a", plain], ["b", plain], ["c", plain], ["d", plain],
      ["far", plain], ["rival", other], ["inside", plain]
    ]);
    const footprints = [
      near("self", 0), near("a", 1), near("b", 2), near("far", 6), near("rival", 1), near("inside", 1, "interior:dungeon:x")
    ];
    const run = (list: typeof footprints) =>
      resolveKingdomCombatPerkEffects({ footprints: list, members, onOwnKingdomLand: new Set() })
        .get("self")?.attackBonus;
    // a and b are in range; far (about 666 m), another kingdom and another region are not.
    expect(run(footprints)).toBe(2);
    expect(run([near("self", 0)])).toBe(0);
    expect(run([...footprints, near("c", 3), near("d", 4)])).toBe(4);
    expect(run([...footprints, near("c", 3), near("d", 4), near("far", 5)])).toBe(4);
  });

  it("The Spearhead grants +25 speed only while its buff is in the member's perks", () => {
    const spearhead: KingdomCombatMember = { kingdomId: "k1", perkIds: new Set(["the_spearhead"]) };
    const effects = resolveKingdomCombatPerkEffects({
      footprints: [at("v"), at("p")],
      members: new Map([["v", spearhead], ["p", plain]]),
      onOwnKingdomLand: new Set()
    });
    expect(effects.get("v")?.speedBonus).toBe(25);
    expect(effects.get("p")?.speedBonus).toBe(0);
  });

  it("Treacherous Ground adds +3 attack near a dungeon entrance, on top of Breach Company", () => {
    const terrain: KingdomCombatMember = { kingdomId: "k1", perkIds: new Set(["treacherous_ground", "breach_company"]) };
    const effects = resolveKingdomCombatPerkEffects({
      footprints: [at("gate"), at("field"), at("plain")],
      members: new Map([["gate", terrain], ["field", { kingdomId: "k2", perkIds: new Set(["treacherous_ground"]) }], ["plain", plain]]),
      onOwnKingdomLand: new Set(),
      nearDungeonEntrance: new Set(["gate", "plain"])
    });
    // gate also has plain (same kingdom, same spot) nearby for Breach Company.
    expect(effects.get("gate")?.attackBonus).toBe(4);
    expect(effects.get("field")?.attackBonus).toBe(0);
    expect(effects.get("plain")?.attackBonus).toBe(0);
  });

  it("clamps the shared bonus", () => {
    expect(breachCompanyAttackBonus(-1)).toBe(0);
    expect(breachCompanyAttackBonus(2)).toBe(2);
    expect(breachCompanyAttackBonus(9)).toBe(4);
  });
});

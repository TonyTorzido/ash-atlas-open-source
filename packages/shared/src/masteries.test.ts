import { describe, expect, it } from "vitest";

import {
  BREEDER_MAX_RANK,
  BREEDER_PROBABILITY_CONFIG,
  BREEDER_PUBLIC_RANK_LABELS,
  PROFESSION_XP_AWARDS,
  PROFESSION_IDS,
  RETIRED_PROFESSION_IDS,
  PROFESSION_MAX_RANK,
  PROFESSION_MAX_XP,
  PROFESSION_XP_THRESHOLDS,
  OIL_WORKER_MAX_XP,
  OIL_WORKER_XP_THRESHOLDS,
  OIL_WELL_CAPACITY_BY_OIL_WORKER_RANK,
  WARRIOR_MAX_RANK,
  WARRIOR_MAX_XP,
  WARRIOR_REQUIREMENT_GROWTH,
  WARRIOR_XP_THRESHOLDS,
  professionEffects,
  builderXpForConstruction,
  professionRankForXp,
  professionMaxXp,
  professionMaxRank,
  breederProbabilityConfig,
  warriorEffects,
  warriorRankForXp,
  metallurgyIronSuccessChance
} from "./masteries.js";

describe("launch mastery curves", () => {
  it("uses the exact Warrior V3 0-15 thresholds and clamps at 72,000 XP", () => {
    expect(WARRIOR_XP_THRESHOLDS).toEqual([
      0, 1_193, 2_600, 4_257, 6_212, 8_515, 11_231, 14_432,
      18_205, 22_652, 27_895, 34_075, 41_360, 49_946, 60_068, 72_000
    ]);
    expect(WARRIOR_MAX_RANK).toBe(15);
    expect(WARRIOR_MAX_XP).toBe(72_000);
    expect(WARRIOR_REQUIREMENT_GROWTH).toBeCloseTo(1.1787686347935873, 14);
    WARRIOR_XP_THRESHOLDS.forEach((xp, rank) => {
      expect(warriorRankForXp(xp)).toBe(rank);
      if (rank > 0) expect(warriorRankForXp(xp - 1)).toBe(rank - 1);
      if (rank < WARRIOR_MAX_RANK) expect(warriorRankForXp(xp + 1)).toBe(rank);
    });
    expect(WARRIOR_XP_THRESHOLDS.every((threshold, rank) =>
      rank === 0 || threshold > WARRIOR_XP_THRESHOLDS[rank - 1]!
    )).toBe(true);
    const requirements = WARRIOR_XP_THRESHOLDS.slice(1).map(
      (threshold, index) => threshold - WARRIOR_XP_THRESHOLDS[index]!
    );
    expect(requirements.at(-1)! / requirements[0]!).toBeCloseTo(10.0017, 4);
    expect(warriorRankForXp(-1)).toBe(0);
    expect(warriorRankForXp(999_999)).toBe(15);
  });

  it("uses the exact shared profession curve independently for the four active tracks", () => {
    expect(PROFESSION_XP_THRESHOLDS).toEqual([
      0, 3_021, 7_218, 13_049, 21_152, 32_412, 48_056, 69_795, 100_000
    ]);
    expect(PROFESSION_MAX_XP).toBe(100_000);
    expect(PROFESSION_MAX_RANK).toBe(8);
    PROFESSION_XP_THRESHOLDS.forEach((xp, rank) => {
      expect(professionRankForXp(xp)).toBe(rank);
      if (rank > 0) expect(professionRankForXp(xp - 1)).toBe(rank - 1);
      if (rank < PROFESSION_MAX_RANK) expect(professionRankForXp(xp + 1)).toBe(rank);
    });
    const requirements = PROFESSION_XP_THRESHOLDS.slice(1).map(
      (threshold, index) => threshold - PROFESSION_XP_THRESHOLDS[index]!
    );
    expect(requirements.at(-1)! / requirements[0]!).toBeCloseTo(10, 2);
    expect(PROFESSION_XP_THRESHOLDS.every((threshold, index) =>
      index === 0 || threshold > PROFESSION_XP_THRESHOLDS[index - 1]!
    )).toBe(true);
    expect(PROFESSION_IDS).toEqual(["woodcutter", "miner", "builder", "oil_worker", "metallurgy"]);
    expect(RETIRED_PROFESSION_IDS).toEqual(["hunter", "breeder"]);
    expect(new Map(PROFESSION_IDS.map((id) => [id, professionRankForXp(id === "miner" ? 7_218 : 0)])))
      .toEqual(new Map([["woodcutter", 0], ["miner", 2], ["builder", 0], ["oil_worker", 0], ["metallurgy", 0]]));
  });

  it("uses the exact Oil Worker curve and capacity table", () => {
    expect(OIL_WORKER_MAX_XP).toBe(25_000);
    expect(OIL_WORKER_XP_THRESHOLDS).toEqual([0, 755, 1_804, 3_262, 5_288, 8_103, 12_014, 17_449, 25_000]);
    OIL_WORKER_XP_THRESHOLDS.forEach((xp, rank) => expect(professionRankForXp(xp, "oil_worker")).toBe(rank));
    expect(professionMaxXp("oil_worker")).toBe(25_000);
    expect(OIL_WELL_CAPACITY_BY_OIL_WORKER_RANK).toEqual([120, 124, 128, 132, 136, 140, 144, 147, 150]);
    expect((25_000 - 17_449) / 755).toBeCloseTo(10.001, 3);
  });

  it("keeps the legacy dog-breeding probabilities for the dog breeding service", () => {
    expect(BREEDER_MAX_RANK).toBe(4);
    expect(BREEDER_PUBLIC_RANK_LABELS).toEqual(["I", "II", "III", "IV", "V"]);
    expect(BREEDER_PROBABILITY_CONFIG).toEqual([
      { breakthroughMultiplier: 1, regressionReductionChance: 0, traitInheritanceAdditivePoints: 0 },
      { breakthroughMultiplier: 1.02, regressionReductionChance: 0.05, traitInheritanceAdditivePoints: 0.02 },
      { breakthroughMultiplier: 1.04, regressionReductionChance: 0.10, traitInheritanceAdditivePoints: 0.03 },
      { breakthroughMultiplier: 1.07, regressionReductionChance: 0.16, traitInheritanceAdditivePoints: 0.05 },
      { breakthroughMultiplier: 1.10, regressionReductionChance: 0.22, traitInheritanceAdditivePoints: 0.08 }
    ]);
    expect(breederProbabilityConfig(1).focusUnlocked).toBe(false);
    expect(breederProbabilityConfig(2).focusUnlocked).toBe(true);
  });

  it("defines the Profession V2 fixed awards", () => {
    expect(PROFESSION_XP_AWARDS).toEqual({
      woodHarvest: 15,
      stoneMine: 25,
      flagBuild: 25,
      flagReinforcement: 25,
      metallurgyIronSuccess: 1_500,
      metallurgyIronFailure: 1_000,
      metallurgyMetalBar: 3_000
    });
  });

  it("centralizes the exact Warrior mastery totals", () => {
    expect(warriorEffects(15)).toEqual({
      normalRageGenerationBonus: 0.06,
      lowHealthRageGenerationBonus: 0.15,
      maximumHealthBonus: 0,
      permanentDamageReduction: 0.03,
      punishingStrikeBonus: 0.42,
      guardedStrikeBonus: 0.27,
      guardedStrikeReduction: 0.16,
      guardedStrikeDurationMs: 3_250,
      empoweredRageRefund: 5,
      cleavePrimaryMultiplier: 1.05,
      cleaveSecondaryMultiplier: 0.70,
      cleaveRadiusM: 70,
      cleaveMaximumSecondaryTargets: 4,
      cleaveCooldownMs: 7_200,
      fortifyReduction: 0.23,
      fortifyDurationMs: 4_750,
      fortifyCooldownMs: 14_400,
      rageDecayDelayBonusMs: 3_000,
      rageDecayRateMultiplier: 0.9
    });
  });

  it("centralizes all profession mastery totals while leaving rank zero open", () => {
    expect(professionEffects("woodcutter", 0)).toMatchObject({ speedBonus: 0, bonusYieldChance: 0, instantChance: 0 });
    expect(professionEffects("woodcutter", 8)).toEqual({ speedBonus: 0.08, bonusYieldChance: 0.08, instantChance: 0.04, rhythmBonus: 0.05 });
    expect(professionEffects("miner", 8)).toEqual({ speedBonus: 0.08, mineMemory: true, bonusYieldChance: 0.08, instantChance: 0.03, unbrokenVeinChance: 0.03 });
    expect(professionEffects("builder", 8)).toEqual({ generalSpeedBonus: 0.08, flagSpeedBonus: 0.08, reinforcementSpeedBonus: 0.08, flagRefundChance: 0.03 });
    expect(professionEffects("oil_worker", 8)).toEqual({ capacity: 150, exactTimeUntilFull: true, remoteMonitoring: true, fullWellAlert: true, remoteHarvest: true });
    expect(professionEffects("metallurgy", 0)).toEqual({ ironSuccessChance: 0.75, slagRecoveryCost: null, slagRecoveryUnlocked: false });
    expect(professionEffects("metallurgy", 2)).toEqual({ ironSuccessChance: 0.8, slagRecoveryCost: 5, slagRecoveryUnlocked: true });
    expect(professionEffects("metallurgy", 5)).toEqual({ ironSuccessChance: 0.9, slagRecoveryCost: 4, slagRecoveryUnlocked: true });
    expect(professionEffects("metallurgy", 8)).toEqual({ ironSuccessChance: 1, slagRecoveryCost: 3, slagRecoveryUnlocked: true });
    expect(metallurgyIronSuccessChance(1)).toBe(0.75);
  });

  it("bases Builder XP only on authoritative intended duration", () => {
    expect(builderXpForConstruction(10)).toBe(17);
    expect(builderXpForConstruction(30)).toBe(50);
    expect(builderXpForConstruction(60)).toBe(100);
    expect(builderXpForConstruction(120)).toBe(200);
    expect(() => builderXpForConstruction(-1)).toThrow("nonnegative");
  });
});

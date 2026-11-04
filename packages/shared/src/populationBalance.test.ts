import { describe, expect, it } from "vitest";

import {
  POPULATION_BALANCE,
  POPULATION_DENSITY_MULTIPLIERS,
  POPULATION_DENSITY_REVISION,
  deerGroupSizeForUnit,
  sapCrawlerGroupSizeForUnit,
  validatePopulationBalance,
  wolfPackSizeForUnit
} from "./populationBalance.js";

describe("population balance", () => {
  it("exposes the canonical production wildlife targets", () => {
    expect(POPULATION_DENSITY_REVISION)
      .toBe("population-land-encounter-density-v2");
    expect(POPULATION_DENSITY_MULTIPLIERS).toEqual({
      tree: 1.25,
      flax: 1,
      deer: 2,
      wolf_pack: 2
    });
    expect(POPULATION_BALANCE.common.deer).toEqual({
      densityPerEligibleKm2: 3.2 * POPULATION_DENSITY_MULTIPLIERS.deer,
      minimumSpacingM: 45,
      candidateOversamplingFactor: 1.03
    });
    expect(POPULATION_BALANCE.common.deer_group).toEqual({
      densityPerEligibleKm2: 2.56,
      minimumSpacingM: 45,
      candidateOversamplingFactor: 1.03
    });
    expect(POPULATION_BALANCE.common.wolf_pack).toEqual({
      densityPerEligibleKm2:
        (1 / 2.4) * POPULATION_DENSITY_MULTIPLIERS.wolf_pack,
      minimumSpacingM: 700,
      candidateOversamplingFactor: 1.6
    });
    expect(POPULATION_BALANCE.rare.ogre).toEqual({
      targetAreaKm2: 4,
      candidateOversamplingFactor: 1.25
    });
    expect(POPULATION_BALANCE.rare.sap_crawler_group).toEqual({
      targetAreaKm2: 8,
      candidateOversamplingFactor: 1.25
    });
    expect(POPULATION_BALANCE.common.tree).toEqual({
      densityPerEligibleKm2: 4 * POPULATION_DENSITY_MULTIPLIERS.tree,
      minimumSpacingM: 70,
      candidateOversamplingFactor: 1.08
    });
    expect(POPULATION_BALANCE.common.tree.densityPerEligibleKm2).toBe(5);
    expect(POPULATION_BALANCE.rare.stone).toEqual({
      targetAreaKm2: 5,
      candidateOversamplingFactor: 1.115
    });
    expect(POPULATION_BALANCE.common.tree.densityPerEligibleKm2 / 4)
      .toBe(POPULATION_DENSITY_MULTIPLIERS.tree);
    expect(POPULATION_BALANCE.common.deer_group.densityPerEligibleKm2 * 2.5)
      .toBeCloseTo(3.2 * POPULATION_DENSITY_MULTIPLIERS.deer, 10);
    expect(
      POPULATION_BALANCE.common.wolf_pack.densityPerEligibleKm2 / (1 / 2.4)
    ).toBe(POPULATION_DENSITY_MULTIPLIERS.wolf_pack);
    expect(JSON.stringify(POPULATION_BALANCE.rare.ogre)).toBe(JSON.stringify({
      targetAreaKm2: 4,
      candidateOversamplingFactor: 1.25
    }));
  });

  it("applies the exact 37.5/62.5 Resin Crawler group-size distribution", () => {
    expect(sapCrawlerGroupSizeForUnit(0)).toBe(3);
    expect(sapCrawlerGroupSizeForUnit(0.374999)).toBe(3);
    expect(sapCrawlerGroupSizeForUnit(0.375)).toBe(4);
    expect(sapCrawlerGroupSizeForUnit(0.999999)).toBe(4);
    expect(() => sapCrawlerGroupSizeForUnit(-0.01)).toThrow();
    expect(() => sapCrawlerGroupSizeForUnit(1)).toThrow();
    expect(() => sapCrawlerGroupSizeForUnit(Number.NaN)).toThrow();
    expect(POPULATION_BALANCE.sapCrawlerGroupSize.outcomes.reduce(
      (total, outcome) => total + outcome.probability,
      0
    )).toBe(1);
  });

  it("applies the exact 20/40/40 Deer group-size distribution", () => {
    expect(deerGroupSizeForUnit(0)).toBe(1);
    expect(deerGroupSizeForUnit(0.199999)).toBe(1);
    expect(deerGroupSizeForUnit(0.20)).toBe(2);
    expect(deerGroupSizeForUnit(0.599999)).toBe(2);
    expect(deerGroupSizeForUnit(0.600001)).toBe(3);
    expect(deerGroupSizeForUnit(0.999999)).toBe(3);
    expect(POPULATION_BALANCE.deerGroupSize.outcomes.reduce(
      (total, outcome) => total + outcome.probability,
      0
    )).toBe(1);
  });

  it("validates and applies the exact 20/80 pack-size distribution", () => {
    expect(() => validatePopulationBalance()).not.toThrow();
    expect(wolfPackSizeForUnit(0)).toBe(2);
    expect(wolfPackSizeForUnit(0.199999)).toBe(2);
    expect(wolfPackSizeForUnit(0.20)).toBe(3);
    expect(wolfPackSizeForUnit(0.999999)).toBe(3);
    expect(POPULATION_BALANCE.wolfPackSize.outcomes.reduce(
      (average, outcome) =>
        average + outcome.memberCount * outcome.probability,
      0
    )).toBeCloseTo(2.8, 10);
  });

  it("rejects invalid pack-size probabilities", () => {
    expect(() => validatePopulationBalance({
      wolfPackSize: { outcomes: [{ probability: Number.NaN }, { probability: 1 }] }
    })).toThrow("finite and nonnegative");
    expect(() => validatePopulationBalance({
      wolfPackSize: { outcomes: [{ probability: -0.1 }, { probability: 1.1 }] }
    })).toThrow("finite and nonnegative");
    expect(() => validatePopulationBalance({
      wolfPackSize: { outcomes: [{ probability: 0.15 }, { probability: 0.6 }] }
    })).toThrow("total exactly 1");
  });
});

import { describe, expect, it } from "vitest";

import {
  BASE_PLAYER_MAX_HEALTH,
  CURRENT_LEVEL_CAP,
  EQUIPMENT_LEVEL_CAP,
  FUTURE_PLAYER_MAX_HEALTH_SAFETY_CAP,
  MAX_CURRENT_ERA_XP,
  POST_CAP_XP_PER_REWARD,
  PROGRESSION_BALANCE_VERSION,
  PROGRESSION_CURVE_VERSION,
  REQUIREMENT_GROWTH,
  TOTAL_XP_FOR_LEVEL,
  damageFromStats,
  levelForTotalXp,
  levelUpHealth,
  playerPveStats,
  preserveCurrentHealthPercentage,
  resolvePlayerMaxHealth,
  standardizedPvpDamage,
  totalXpForLevel,
  xpLevelDifferenceMultiplier,
  xpProgress
} from "./progression.js";
import { BASIC_ATTACK_INTERVAL_MS } from "./combatConstants.js";

describe("progression curve", () => {
  it("uses every exact version-three threshold monotonically", () => {
    const expected = [
      0, 7_194, 15_270, 24_337, 34_517, 45_946, 58_778, 73_184, 89_357,
      107_516, 127_902, 150_791, 176_487, 205_337, 237_728, 274_092,
      314_919, 360_756, 412_217, 469_993, 534_858, 607_683, 689_444,
      781_238, 884_296, 1_000_000,
      1_129_902, 1_275_743, 1_439_481, 1_623_310, 1_829_697, 2_061_409,
      2_321_554, 2_613_621, 2_941_527, 3_309_670, 3_722_986, 4_187_020,
      4_707_995, 5_292_897, 5_949_572
    ];
    expect(PROGRESSION_CURVE_VERSION).toBe(3);
    expect(Object.values(TOTAL_XP_FOR_LEVEL)).toEqual(expected);
    for (let level = 0; level <= CURRENT_LEVEL_CAP; level += 1) {
      expect(totalXpForLevel(level)).toBe(expected[level]);
      expect(levelForTotalXp(expected[level]!)).toBe(level);
      if (level > 0) expect(expected[level]).toBeGreaterThan(expected[level - 1]!);
      if (level > 0) expect(levelForTotalXp(expected[level]! - 1)).toBe(level - 1);
      if (level < CURRENT_LEVEL_CAP) expect(levelForTotalXp(expected[level]! + 1)).toBe(level);
    }
  });

  it("extends the same geometric curve through Level 40", () => {
    const a = 1_000_000 * (REQUIREMENT_GROWTH - 1) / (REQUIREMENT_GROWTH ** 25 - 1);
    for (let level = 0; level <= 40; level += 1) {
      expect(TOTAL_XP_FOR_LEVEL[level as keyof typeof TOTAL_XP_FOR_LEVEL])
        .toBe(Math.round(a * (REQUIREMENT_GROWTH ** level - 1) / (REQUIREMENT_GROWTH - 1)));
    }
  });

  it("enforces the Level 40 character cap while gear stays capped at 25", () => {
    expect(CURRENT_LEVEL_CAP).toBe(40);
    expect(EQUIPMENT_LEVEL_CAP).toBe(25);
    expect(MAX_CURRENT_ERA_XP).toBe(totalXpForLevel(40));
    expect(MAX_CURRENT_ERA_XP).toBe(5_949_572);
    // XP banked past Level 25 while the cap was 25 counts toward Levels 26-40 again.
    expect(levelForTotalXp(2_000_000)).toBe(30);
    expect(levelForTotalXp(TOTAL_XP_FOR_LEVEL[40] + 1)).toBe(40);
    expect(xpProgress(2_000_000)).toMatchObject({ level: 30, atCap: false, nextLevelTotalXp: 2_061_409 });
  });

  it("caps level while cycling post-cap reward XP", () => {
    expect(levelForTotalXp(MAX_CURRENT_ERA_XP + 99_999)).toBe(40);
    expect(xpProgress(MAX_CURRENT_ERA_XP + 1)).toEqual({
      level: 40,
      xpIntoLevel: 1,
      xpForNextLevel: POST_CAP_XP_PER_REWARD,
      nextLevelTotalXp: null,
      atCap: true
    });
    expect(xpProgress(MAX_CURRENT_ERA_XP + POST_CAP_XP_PER_REWARD)).toMatchObject({
      level: 40,
      xpIntoLevel: 0,
      xpForNextLevel: POST_CAP_XP_PER_REWARD,
      atCap: true
    });
    expect(() => totalXpForLevel(41)).toThrow(/between 0 and 40/i);
  });

  it("calculates XP within the current level", () => {
    expect(xpProgress(50_000)).toMatchObject({
      level: 5,
      xpIntoLevel: 4_054,
      xpForNextLevel: 12_832,
      nextLevelTotalXp: 58_778,
      atCap: false
    });
  });

  it("makes level-24 equal-level work ten times the level-0 continuous model", () => {
    const requirements = Array.from(
      { length: CURRENT_LEVEL_CAP },
      (_, level) => totalXpForLevel(level + 1) - totalXpForLevel(level)
    );
    expect((REQUIREMENT_GROWTH / 1.02) ** 24).toBeCloseTo(10, 12);
    const integerWorkRatio = requirements[24]! / requirements[0]! / (1.02 ** 24);
    expect(integerWorkRatio).toBeCloseTo(9.999397142, 9);
    expect(Math.abs(integerWorkRatio - 10)).toBeLessThan(0.001);
  });
});

describe("progression combat rules", () => {
  it("keeps fixed health and leaves combat power entirely to equipment", () => {
    expect(playerPveStats(0)).toMatchObject({ maxHealth: 100, attackPower: 10, defense: 0 });
    expect(playerPveStats(4)).toMatchObject({ maxHealth: 100, attackPower: 10, defense: 0 });
    expect(playerPveStats(5)).toMatchObject({ maxHealth: 100, attackPower: 10, defense: 0 });
    expect(playerPveStats(25, { attackPower: 2, defense: 2 })).toMatchObject({
      maxHealth: 100,
      attackPower: 12,
      defense: 2,
      attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
      attackRangeM: 100
    });
  });

  it("uses the transparent defense formula with minimum damage one", () => {
    expect(damageFromStats(10, 0)).toBe(10);
    expect(damageFromStats(10, 100)).toBe(1);
    expect(damageFromStats(0, 999)).toBe(1);
  });

  it("standardizes PvP damage to the same health percentage", () => {
    expect(standardizedPvpDamage(100)).toBe(10);
    expect(standardizedPvpDamage(200)).toBe(20);
    expect(100 / standardizedPvpDamage(100)).toBe(200 / standardizedPvpDamage(200));
  });

  it("preserves health percentage without killing, filling, or duplicating healing", () => {
    expect(levelUpHealth(40, 100, 120)).toBe(48);
    expect(levelUpHealth(100, 100, 120)).toBe(120);
    expect(levelUpHealth(40, 120, 100)).toBe(33);
    expect(preserveCurrentHealthPercentage(40, 200, 100)).toBe(20);
    expect(preserveCurrentHealthPercentage(1, 200, 100)).toBe(1);
    expect(preserveCurrentHealthPercentage(199, 200, 1)).toBe(1);
    expect(preserveCurrentHealthPercentage(0, 200, 100)).toBe(0);
    expect(preserveCurrentHealthPercentage(200, 200, 100)).toBe(100);
  });

  it("centralizes ordinary and future exceptional maximum health", () => {
    expect(PROGRESSION_BALANCE_VERSION).toBe(3);
    expect(BASE_PLAYER_MAX_HEALTH).toBe(100);
    expect(resolvePlayerMaxHealth()).toBe(100);
    expect(resolvePlayerMaxHealth({
      exceptionalModifiers: [
        { source: "subclass", sourceId: "future_tank", flatBonus: 25 },
        { source: "event", sourceId: "future_event", flatBonus: 5 }
      ]
    })).toBe(130);
    expect(resolvePlayerMaxHealth({
      exceptionalModifiers: [
        { source: "rare_ring", sourceId: "future_ring", flatBonus: 10_000 }
      ]
    })).toBe(FUTURE_PLAYER_MAX_HEALTH_SAFETY_CAP);
  });

  it("applies every level-difference boundary", () => {
    expect(xpLevelDifferenceMultiplier(10, 11)).toBe(1);
    expect(xpLevelDifferenceMultiplier(10, 16)).toBe(1);
    expect(xpLevelDifferenceMultiplier(10, 30)).toBe(1);
    expect(xpLevelDifferenceMultiplier(10, 10)).toBe(1);
    expect(xpLevelDifferenceMultiplier(10, 8)).toBe(1);
    expect(xpLevelDifferenceMultiplier(10, 7)).toBe(0.7);
    expect(xpLevelDifferenceMultiplier(10, 5)).toBe(0.7);
    expect(xpLevelDifferenceMultiplier(10, 4)).toBe(0.3);
    expect(xpLevelDifferenceMultiplier(10, 1)).toBe(0.3);
    expect(xpLevelDifferenceMultiplier(10, 0)).toBe(0.1);
  });
});

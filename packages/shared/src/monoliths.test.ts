import { describe, expect, it } from "vitest";

import {
  MONOLITH_LIFETIME_MS,
  MONOLITH_REMNANT_MS,
  monolithBuildingDamage,
  monolithEffective,
  monolithHunterBonusPercent,
  monolithHunterYield,
  monolithPhase,
  monolithTypeUnlocked
} from "./monoliths.js";

describe("monolith rules", () => {
  it("gates the six types by Field Engineering rank", () => {
    expect(monolithTypeUnlocked("healer", 1)).toBe(true);
    expect(monolithTypeUnlocked("berserker", 1)).toBe(false);
    expect(monolithTypeUnlocked("berserker", 2)).toBe(true);
    expect(monolithTypeUnlocked("fortified", 2)).toBe(false);
    expect(monolithTypeUnlocked("hunter", 3)).toBe(true);
  });

  it("applies Frenzy +30% and Fortified x0.55 to building damage", () => {
    expect(monolithBuildingDamage(1_000, { berserker: true, fortified: false })).toBe(1_300);
    expect(monolithBuildingDamage(1_000, { berserker: false, fortified: true })).toBe(550);
    expect(monolithBuildingDamage(1_000, { berserker: true, fortified: true })).toBe(715);
  });

  it("lives 20 h, leaves inert remnants for 30 h, and burns down", () => {
    const times = { expiresAtMs: MONOLITH_LIFETIME_MS, remnantUntilMs: MONOLITH_LIFETIME_MS + MONOLITH_REMNANT_MS, burnUntilMs: null };
    expect(monolithPhase(times, 0)).toBe("active");
    expect(monolithEffective(times, MONOLITH_LIFETIME_MS - 1)).toBe(true);
    expect(monolithPhase(times, MONOLITH_LIFETIME_MS)).toBe("remnant");
    expect(monolithEffective(times, MONOLITH_LIFETIME_MS)).toBe(false);
    expect(monolithPhase(times, MONOLITH_LIFETIME_MS + MONOLITH_REMNANT_MS)).toBe("gone");
    const burning = { ...times, burnUntilMs: 4_800_000 };
    expect(monolithPhase(burning, 1_000)).toBe("burning");
    expect(monolithEffective(burning, 1_000)).toBe(true);
    expect(monolithPhase(burning, 4_800_000)).toBe("gone");
  });

  it("pays Hunter +27% (+8% at rank 3) with a deterministic fractional roll", () => {
    expect(monolithHunterBonusPercent(2)).toBe(27);
    expect(monolithHunterBonusPercent(3)).toBe(35);
    expect(monolithHunterYield(5, 20, 0.99)).toBe(6);
    expect(monolithHunterYield(1, 20, 0.1)).toBe(2);
    expect(monolithHunterYield(1, 20, 0.5)).toBe(1);
  });
});

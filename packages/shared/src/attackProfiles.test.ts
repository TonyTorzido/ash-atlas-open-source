import { describe, expect, it } from "vitest";

import {
  SWING_COMBO_LENGTH,
  SWING_COMBO_RESET_MS,
  SWING_DAMAGE_FACTORS,
  SWING_KNOCKBACK_M,
  SWING_RECOVERY_TICKS
} from "./actionCombat.js";
import {
  ATTACK_PROFILES,
  AXE_GENERIC_ATTACK_PROFILE,
  AXE_WARRIOR_ATTACK_PROFILE,
  COMBAT_STYLE_IDS,
  DEFAULT_ATTACK_PROFILE,
  SWORD_GENERIC_ATTACK_PROFILE,
  SWORD_RONIN_ATTACK_PROFILE,
  attackComboNextIndex,
  attackProfileComboCycleMs,
  attackProfileDamagePerSecond,
  attackProfileFor,
  attackProfileForStyle,
  attackProfileProblems,
  attackStepCycleTicks,
  attackStepServerHitDelayTicks,
  combatStyleFor,
  equalDpsDamageMultipliers,
  isAttackFinisherStep,
  parseSwingEventAbilityId,
  swingEventAbilityId,
  type AttackProfile
} from "./attackProfiles.js";
import { CLASS_IDS } from "./classContracts.js";
import { SPECIALIZATION_IDS } from "./skillSystemV3.js";

/** A made-up slow four-step combo, standing in for future animator numbers. */
const SLOW_FOUR_STEP: AttackProfile = {
  id: "test:slow",
  label: "Slow test combo",
  combo: [
    { windupMs: 200, recoveryMs: 600, damageMultiplier: 1, knockbackM: 0 },
    { windupMs: 150, recoveryMs: 450, damageMultiplier: 1, knockbackM: 0 },
    { windupMs: 250, recoveryMs: 750, damageMultiplier: 1, knockbackM: 0 },
    { windupMs: 400, recoveryMs: 1_000, damageMultiplier: 1, knockbackM: 0 }
  ],
  comboResetMs: 1_800,
  hitTiming: "contact"
};

const delays = (profile: AttackProfile) => profile.combo.map((step) => attackStepServerHitDelayTicks(profile, step));
const defaultDps = attackProfileDamagePerSecond(DEFAULT_ATTACK_PROFILE);

describe("default attack profile", () => {
  it("reproduces today's swing timing exactly", () => {
    expect(DEFAULT_ATTACK_PROFILE.combo).toHaveLength(SWING_COMBO_LENGTH);
    expect(DEFAULT_ATTACK_PROFILE.combo.map(attackStepCycleTicks)).toEqual([...SWING_RECOVERY_TICKS]);
    expect(DEFAULT_ATTACK_PROFILE.combo.map((step) => step.damageMultiplier)).toEqual([...SWING_DAMAGE_FACTORS]);
    expect(DEFAULT_ATTACK_PROFILE.combo.map((step) => step.knockbackM)).toEqual([...SWING_KNOCKBACK_M]);
    expect(DEFAULT_ATTACK_PROFILE.comboResetMs).toBe(SWING_COMBO_RESET_MS);
    // The drawn contact frame (player-renderer SWING_CONTACT_MS: swing 105, finisher 119).
    expect(DEFAULT_ATTACK_PROFILE.combo.map((step) => step.windupMs)).toEqual([105, 105, 119]);
    expect(attackProfileComboCycleMs(DEFAULT_ATTACK_PROFILE)).toBe(2_300);
  });

  it("lands every default hit on the press", () => {
    expect(DEFAULT_ATTACK_PROFILE.hitTiming).toBe("press");
    expect(delays(DEFAULT_ATTACK_PROFILE)).toEqual([0, 0, 0]);
  });

  it("only the last step is the finisher", () => {
    expect([0, 1, 2].map((index) => isAttackFinisherStep(DEFAULT_ATTACK_PROFILE, index))).toEqual([false, false, true]);
  });

  it("chains with the old combo rule", () => {
    expect(attackComboNextIndex(DEFAULT_ATTACK_PROFILE, null, 0, 1_000)).toBe(0);
    expect(attackComboNextIndex(DEFAULT_ATTACK_PROFILE, 0, 1_000, 1_700)).toBe(1);
    expect(attackComboNextIndex(DEFAULT_ATTACK_PROFILE, 2, 1_000, 1_900)).toBe(0);
    expect(attackComboNextIndex(DEFAULT_ATTACK_PROFILE, 1, 1_000, 1_000 + SWING_COMBO_RESET_MS)).toBe(2);
    expect(attackComboNextIndex(DEFAULT_ATTACK_PROFILE, 1, 1_000, 1_001 + SWING_COMBO_RESET_MS)).toBe(0);
  });
});

describe("combat style resolver", () => {
  it("maps a class holding a weapon family to its style", () => {
    expect(combatStyleFor("warrior", "sword")).toBe("sword:generic");
    expect(combatStyleFor(null, "sword")).toBe("sword:generic");
    expect(combatStyleFor("ronin", "sword")).toBe("sword:ronin");
    expect(combatStyleFor("ronin", "axe")).toBe("axe:generic");
    expect(combatStyleFor(null, "axe")).toBe("axe:generic");
    expect(combatStyleFor("warrior", "axe")).toBe("axe:warrior");
    expect(combatStyleFor("ranger", "axe")).toBe("axe:generic");
    expect(combatStyleFor("warrior", "bow")).toBe("default");
    expect(combatStyleFor("warrior", null)).toBe("default");
    expect(combatStyleFor(undefined, undefined)).toBe("default");
    expect(combatStyleFor("toString", "sword")).toBe("sword:generic");
  });

  it("the Ronin class with a sword is the only class that resolves to the Ronin style (classes-ronin-warrior)", () => {
    expect(SPECIALIZATION_IDS).toContain("ronin");
    expect(combatStyleFor("ronin", "sword")).toBe("sword:ronin");
    for (const id of [...CLASS_IDS, ...SPECIALIZATION_IDS].filter((x) => x !== "ronin")) expect(combatStyleFor(id, "sword")).toBe("sword:generic");
    expect(combatStyleFor(null, "sword")).toBe("sword:generic");
  });

  it("every style has a profile and unknown styles fall back to the default", () => {
    for (const style of COMBAT_STYLE_IDS) expect(attackProfileForStyle(style).id).toBe(style);
    expect(attackProfileForStyle("nope")).toBe(DEFAULT_ATTACK_PROFILE);
    expect(attackProfileForStyle(null)).toBe(DEFAULT_ATTACK_PROFILE);
    expect(attackProfileFor("ronin", "sword")).toBe(SWORD_RONIN_ATTACK_PROFILE);
  });

  it("every profile is valid data", () => {
    for (const profile of Object.values(ATTACK_PROFILES)) expect(attackProfileProblems(profile)).toEqual([]);
    expect(attackProfileProblems(SLOW_FOUR_STEP)).toEqual([]);
  });

  it("flags bad data", () => {
    expect(attackProfileProblems({ ...SLOW_FOUR_STEP, comboResetMs: 900 }).some((problem) => problem.includes("comboResetMs"))).toBe(true);
    const freeHit: AttackProfile = { ...SLOW_FOUR_STEP, combo: [{ windupMs: 100, recoveryMs: 500, damageMultiplier: 0, knockbackM: 0 }] };
    expect(attackProfileProblems(freeHit).some((problem) => problem.includes("damageMultiplier"))).toBe(true);
    const lateHit: AttackProfile = { ...SLOW_FOUR_STEP, combo: [{ windupMs: 500, recoveryMs: 10, damageMultiplier: 1, knockbackM: 0 }] };
    expect(attackProfileProblems(lateHit).some((problem) => problem.includes("contact"))).toBe(true);
    expect(attackProfileProblems({ ...SLOW_FOUR_STEP, combo: [] })).not.toEqual([]);
  });
});

describe("cadence per profile", () => {
  it("sword:generic: contact 100/100/133, next press 500/500/650, reset 1.0 s", () => {
    const profile = SWORD_GENERIC_ATTACK_PROFILE;
    expect(profile.combo.map((step) => step.windupMs)).toEqual([100, 100, 133]);
    expect(profile.combo.map(attackStepCycleTicks)).toEqual([10, 10, 13]);
    expect(attackProfileComboCycleMs(profile)).toBe(1_650);
    expect(profile.comboResetMs).toBe(1_000);
    // Hits resolve at contact: 100 ms = 2 ticks, 133 ms rounds to 3 ticks (150 ms).
    expect(delays(profile)).toEqual([2, 2, 3]);
  });

  it("sword:ronin: contact 133/133/200, next press 650/800/1000, reset 1.5 s", () => {
    const profile = SWORD_RONIN_ATTACK_PROFILE;
    expect(profile.combo.map((step) => step.windupMs)).toEqual([133, 133, 200]);
    expect(profile.combo.map(attackStepCycleTicks)).toEqual([13, 16, 20]);
    expect(attackProfileComboCycleMs(profile)).toBe(2_450);
    expect(profile.comboResetMs).toBe(1_500);
    expect(delays(profile)).toEqual([3, 3, 4]);
  });

  it("axe:generic: contact 200/200/300, next press 800/800/1100, reset 1.5 s", () => {
    const profile = AXE_GENERIC_ATTACK_PROFILE;
    expect(profile.combo.map((step) => step.windupMs)).toEqual([200, 200, 300]);
    expect(profile.combo.map(attackStepCycleTicks)).toEqual([16, 16, 22]);
    expect(attackProfileComboCycleMs(profile)).toBe(2_700);
    expect(profile.comboResetMs).toBe(1_500);
    expect(delays(profile)).toEqual([4, 4, 6]);
  });

  it("axe:warrior: contact 233/133/367, next press 800/600/1200, reset 1.6 s", () => {
    const profile = AXE_WARRIOR_ATTACK_PROFILE;
    expect(profile.combo.map((step) => step.windupMs)).toEqual([233, 133, 367]);
    expect(profile.combo.map(attackStepCycleTicks)).toEqual([16, 12, 24]);
    expect(attackProfileComboCycleMs(profile)).toBe(2_600);
    expect(profile.comboResetMs).toBe(1_600);
    expect(delays(profile)).toEqual([5, 3, 7]);
  });

  it("counts any step's cadence in server ticks and wraps a longer combo", () => {
    expect(SLOW_FOUR_STEP.combo.map(attackStepCycleTicks)).toEqual([16, 12, 20, 28]);
    expect(attackStepCycleTicks({ windupMs: 130, recoveryMs: 540, damageMultiplier: 1, knockbackM: 0 })).toBe(13);
    expect(delays(SLOW_FOUR_STEP)).toEqual([4, 3, 5, 8]);
    expect(attackComboNextIndex(SLOW_FOUR_STEP, 2, 1_000, 2_000)).toBe(3);
    expect(attackComboNextIndex(SLOW_FOUR_STEP, 3, 1_000, 2_400)).toBe(0);
    expect(isAttackFinisherStep(SLOW_FOUR_STEP, 3)).toBe(true);
  });
});

describe("equal DPS", () => {
  it("default DPS is 1.75 basic hits per 2.3 s", () => {
    expect(defaultDps).toBeCloseTo(1.75 / 2.3, 10);
  });

  it("both sword styles match the default DPS within 0.1 %", () => {
    for (const profile of [SWORD_GENERIC_ATTACK_PROFILE, SWORD_RONIN_ATTACK_PROFILE]) {
      expect(Math.abs(attackProfileDamagePerSecond(profile) / defaultDps - 1)).toBeLessThan(0.001);
    }
  });

  it("both axe styles keep the default DPS as specified (axe-combos.md: -0.2 % / +0.1 %)", () => {
    expect(attackProfileDamagePerSecond(AXE_GENERIC_ATTACK_PROFILE) / defaultDps).toBeCloseTo(0.998, 3);
    expect(attackProfileDamagePerSecond(AXE_WARRIOR_ATTACK_PROFILE) / defaultDps).toBeCloseTo(1.001, 3);
  });

  it("the animator's proposed factors were close but high; the corrected ones keep the proposed shape", () => {
    const proposed = (profile: AttackProfile, factors: number[]): AttackProfile => ({
      ...profile, combo: profile.combo.map((step, index) => ({ ...step, damageMultiplier: factors[index]! }))
    });
    expect(attackProfileDamagePerSecond(proposed(SWORD_GENERIC_ATTACK_PROFILE, [0.36, 0.36, 0.54])) / defaultDps).toBeCloseTo(1.0036, 4);
    expect(attackProfileDamagePerSecond(proposed(SWORD_RONIN_ATTACK_PROFILE, [0.54, 0.54, 0.8])) / defaultDps).toBeCloseTo(1.0085, 4);
    const generic = equalDpsDamageMultipliers(SWORD_GENERIC_ATTACK_PROFILE.combo.map((step, index) => ({ ...step, weight: [1, 1, 1.5][index]! })));
    expect(generic.map((value) => Math.round(value * 1_000) / 1_000)).toEqual([0.359, 0.359, 0.538]);
    const ronin = equalDpsDamageMultipliers(SWORD_RONIN_ATTACK_PROFILE.combo.map((step, index) => ({ ...step, weight: [0.54, 0.54, 0.8][index]! })));
    expect(ronin.map((value) => Math.round(value * 1_000) / 1_000)).toEqual([0.535, 0.535, 0.793]);
  });

  it("multipliers set from the cadence keep the default DPS on any combo", () => {
    const multipliers = equalDpsDamageMultipliers(SLOW_FOUR_STEP.combo);
    const tuned: AttackProfile = {
      ...SLOW_FOUR_STEP,
      combo: SLOW_FOUR_STEP.combo.map((step, index) => ({ ...step, damageMultiplier: multipliers[index]! }))
    };
    expect(attackProfileDamagePerSecond(tuned)).toBeCloseTo(defaultDps, 10);
    // Time-proportional by default: the 1.4 s finisher hits 1.75x the 0.8 s opener.
    expect(multipliers[3]! / multipliers[0]!).toBeCloseTo(1_400 / 800, 10);
  });
});

describe("SWING event ability id", () => {
  it("is unchanged for the default and tagged with the style otherwise", () => {
    expect([0, 1, 2].map((index) => swingEventAbilityId(index))).toEqual(["swing_0", "swing_1", "swing_2"]);
    expect(swingEventAbilityId(2, SWORD_GENERIC_ATTACK_PROFILE)).toBe("swing_2@sword:generic");
    expect(parseSwingEventAbilityId("swing_2")).toEqual({ comboIndex: 2, profile: DEFAULT_ATTACK_PROFILE });
    expect(parseSwingEventAbilityId("swing_1@sword:ronin")?.profile).toBe(SWORD_RONIN_ATTACK_PROFILE);
    expect(parseSwingEventAbilityId("swing_1@unknown")?.profile).toBe(DEFAULT_ATTACK_PROFILE);
    expect(parseSwingEventAbilityId("shot")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { bearingDegrees as initialBearingDegrees } from "./boss.js";
import { distanceMeters } from "./geo.js";
import { MOB_ARCHETYPE_PARAMS, MOB_SIGNATURES, scaleMobArchetypeParams, scaleMobSignature } from "./mobArchetypes.js";
import {
  MOB_RANGED_AIM_MS,
  MOB_TACTICS_TOKEN_MAX_HOLD_MS,
  clampMobTelegraphScale,
  mobTacticsTokenMaxHoldMs,
  scaleMobRhythm,
  scaleTelegraphMs,
  MOB_TACTICS_BACKOFF_M,
  MOB_TACTICS_COOLDOWN_MIN_MS,
  MOB_TACTICS_ENGAGE_SEATS,
  MOB_TACTICS_MELEE_TOKENS,
  MOB_TACTICS_TIER_COST,
  angleDiffDeg,
  deriveMobRhythm,
  isTacticsRanged,
  jitteredCooldownMs,
  minSlotAngleDeg,
  normalizeAngleDeg,
  rangedLaneContains,
  ringCapacity,
  ringSlotPosition,
  tacticsHash01,
  tacticsMsToTicks,
  tacticsPool,
  tacticsRingRadiusM,
  tacticsTokenCost,
  MOB_TACTICS_MELEE_WINDUP_MS
} from "./mobTactics.js";
import { MOB_MELEE_WINDUP_MS, SWING_RANGE_M } from "./actionCombat.js";
import { BASIC_ATTACK_INTERVAL_MS, MELEE_ATTACK_RANGE_M, RANGED_ATTACK_RANGE_M } from "./combatConstants.js";

const origin = { lat: 35.0844, lon: -106.6504 };

describe("mob tactics constants", () => {
  it("costs epic and legendary mobs 2 points, the rest 1, and the pool is 2", () => {
    expect(MOB_TACTICS_MELEE_TOKENS).toBe(2);
    expect(tacticsTokenCost("common")).toBe(1);
    expect(tacticsTokenCost("rare")).toBe(1);
    expect(tacticsTokenCost("epic")).toBe(2);
    expect(tacticsTokenCost("legendary")).toBe(2);
    expect(Object.keys(MOB_TACTICS_TIER_COST)).toHaveLength(5);
  });

  it("puts the wait ring one short step outside swing reach and the engage ring inside it", () => {
    const wait = tacticsRingRadiusM(MELEE_ATTACK_RANGE_M, "wait");
    const engage = tacticsRingRadiusM(MELEE_ATTACK_RANGE_M, "engage");
    expect(wait).toBe(150);
    expect(engage).toBe(85);
    expect(wait - 130).toBeLessThanOrEqual(25);
    expect(engage).toBeLessThan(SWING_RANGE_M);
  });

  it("keeps the ranged ring on screen", () => {
    expect(tacticsRingRadiusM(RANGED_ATTACK_RANGE_M, "outer")).toBe(225);
    expect(tacticsRingRadiusM(1_000, "outer")).toBe(260);
  });

  it("fits the engage seats on the engage ring", () => {
    expect(ringCapacity(tacticsRingRadiusM(MELEE_ATTACK_RANGE_M, "engage"))).toBeGreaterThanOrEqual(MOB_TACTICS_ENGAGE_SEATS);
  });
});

describe("mob rhythm", () => {
  it("telegraph time: a 1.1 s melee windup, a readable recover, the cooldown floor (1.65 s cycle)", () => {
    const rhythm = deriveMobRhythm(BASIC_ATTACK_INTERVAL_MS, MELEE_ATTACK_RANGE_M);
    expect(rhythm.windupMs).toBe(MOB_TACTICS_MELEE_WINDUP_MS);
    expect(rhythm.windupMs).toBe(1_100);
    expect(rhythm.recoverMs).toBe(250);
    expect(rhythm.cooldownMs).toBe(MOB_TACTICS_COOLDOWN_MIN_MS);
    expect(rhythm.windupMs + rhythm.recoverMs + rhythm.cooldownMs).toBe(1_650);
    expect(rhythm.backoffM).toBe(MOB_TACTICS_BACKOFF_M);
  });

  it("gives ranged mobs an aim windup; the cooldown floor lengthens their cycle", () => {
    expect(isTacticsRanged(RANGED_ATTACK_RANGE_M * 0.7)).toBe(true);
    expect(tacticsPool(RANGED_ATTACK_RANGE_M * 0.7)).toBe("ranged");
    expect(tacticsPool(MELEE_ATTACK_RANGE_M)).toBe("melee");
    const rhythm = deriveMobRhythm(BASIC_ATTACK_INTERVAL_MS, 210);
    expect(rhythm.windupMs).toBe(MOB_RANGED_AIM_MS);
    expect(rhythm.windupMs).toBe(900);
    expect(rhythm.windupMs + rhythm.recoverMs + rhythm.cooldownMs).toBe(1_550);
  });

  it("floors the cooldown and honours overrides", () => {
    expect(deriveMobRhythm(500, 100).cooldownMs).toBe(MOB_TACTICS_COOLDOWN_MIN_MS);
    expect(deriveMobRhythm(1_400, 100, { windupMs: 600, cooldownMs: 100 })).toMatchObject({ windupMs: 600, cooldownMs: 100 });
  });

  it("jitters the cooldown by at most 10 percent, deterministically", () => {
    const rhythm = deriveMobRhythm(BASIC_ATTACK_INTERVAL_MS, MELEE_ATTACK_RANGE_M);
    const values = new Set<number>();
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const value = jitteredCooldownMs(rhythm, "wolf-1", cycle);
      expect(value).toBeGreaterThanOrEqual(rhythm.cooldownMs * 0.9 - 1);
      expect(value).toBeLessThanOrEqual(rhythm.cooldownMs * 1.1 + 1);
      expect(jitteredCooldownMs(rhythm, "wolf-1", cycle)).toBe(value);
      values.add(value);
    }
    expect(values.size).toBeGreaterThan(5);
  });

  it("hashes into [0, 1)", () => {
    for (const id of ["a", "wolf-1", "", "x".repeat(50)]) {
      const value = tacticsHash01(id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("converts ms to ticks", () => {
    expect(tacticsMsToTicks(450, 20)).toBe(9);
    expect(tacticsMsToTicks(300, 20)).toBe(6);
    expect(tacticsMsToTicks(1, 20)).toBe(1);
    expect(tacticsMsToTicks(0, 20)).toBe(0);
  });
});

describe("ring geometry", () => {
  it("wraps angles", () => {
    expect(normalizeAngleDeg(-10)).toBe(350);
    expect(normalizeAngleDeg(370)).toBe(10);
    expect(angleDiffDeg(350, 10)).toBe(20);
    expect(angleDiffDeg(10, 350)).toBe(-20);
    expect(Math.abs(angleDiffDeg(0, 180))).toBe(180);
  });

  it("derives the minimum slot angle from the spacing", () => {
    const angle = minSlotAngleDeg(85);
    expect(angle).toBeGreaterThan(36);
    expect(angle).toBeLessThan(38);
    expect(minSlotAngleDeg(10)).toBe(180);
  });

  it("places slots on the ring at the given bearing", () => {
    const slot = ringSlotPosition(origin, 85, 90);
    expect(distanceMeters(slot, origin)).toBeCloseTo(85, 0);
    expect(initialBearingDegrees(origin, slot)).toBeCloseTo(90, 0);
    expect(initialBearingDegrees(origin, ringSlotPosition(origin, 85, -90))).toBeCloseTo(270, 0);
  });
});

describe("ranged lane", () => {
  it("hits inside the lane and misses outside it", () => {
    // facing east: lane runs along +x
    expect(rangedLaneContains(90, 300, 40, 100, 0)).toBe(true);
    expect(rangedLaneContains(90, 300, 40, 100, 19)).toBe(true);
    expect(rangedLaneContains(90, 300, 40, 100, 21)).toBe(false);
    expect(rangedLaneContains(90, 300, 40, 301, 0)).toBe(false);
    expect(rangedLaneContains(90, 300, 40, -1, 0)).toBe(false);
    expect(rangedLaneContains(0, 300, 40, 0, 250)).toBe(true);
    expect(rangedLaneContains(0, 300, 40, 25, 250)).toBe(false);
    expect(rangedLaneContains(Number.NaN, 300, 40, 0, 10)).toBe(false);
  });
});

describe("MOB_TELEGRAPH_SCALE helpers", () => {
  it("scale 2.0 doubles a windup and keeps recover and cooldown", () => {
    const rhythm = deriveMobRhythm(1_400, 100);
    const doubled = scaleMobRhythm(rhythm, 2);
    expect(doubled.windupMs).toBe(2 * rhythm.windupMs);
    expect(doubled.recoverMs).toBe(rhythm.recoverMs);
    expect(doubled.cooldownMs).toBe(rhythm.cooldownMs);
    expect(scaleMobRhythm(rhythm, 1)).toBe(rhythm);
    expect(scaleMobArchetypeParams(MOB_ARCHETYPE_PARAMS.brute, 2).windupMs).toBe(2 * MOB_ARCHETYPE_PARAMS.brute.windupMs);
    expect(scaleMobSignature(MOB_SIGNATURES.double_strike, 2).telegraphMs).toEqual(MOB_SIGNATURES.double_strike.telegraphMs.map((ms) => 2 * ms));
    expect(scaleMobSignature(MOB_SIGNATURES.slam, 1)).toBe(MOB_SIGNATURES.slam);
    expect(mobTacticsTokenMaxHoldMs(2)).toBe(2 * MOB_TACTICS_TOKEN_MAX_HOLD_MS);
    expect(scaleTelegraphMs(MOB_RANGED_AIM_MS, 2)).toBe(2 * MOB_RANGED_AIM_MS);
    expect([0, 0.5, 1, 2.5, 3, 7, Number.NaN, Number.POSITIVE_INFINITY, undefined].map((raw) => clampMobTelegraphScale(raw)))
      .toEqual([1, 1, 1, 2.5, 3, 3, 1, 1, 1]);
  });
});

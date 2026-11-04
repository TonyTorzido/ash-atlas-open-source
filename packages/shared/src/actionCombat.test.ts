import { describe, expect, it } from "vitest";

import {
  MOB_MELEE_WINDUP_POINT_BLANK_M,
  MOB_MELEE_WINDUP_RANGE_SLACK_M,
  SHOT_RANGE_M,
  SHOT_WIDTH_M,
  SWING_COMBO_LENGTH,
  SWING_DAMAGE_FACTORS,
  SWING_HALF_ANGLE_DEG,
  SWING_KNOCKBACK_M,
  SWING_LAG_COMP_MAX_MS,
  SWING_POINT_BLANK_M,
  SWING_RANGE_M,
  SWING_RECOVERY_TICKS,
  SWING_TARGET_RADIUS_M,
  POSITION_HISTORY_TICKS,
  meleeWindupConeContains,
  shotLineContains,
  shotProfileForWeapon,
  ARCANE_BLAST_SHOT_PROFILE,
  BOW_SHOT_PROFILE,
  HOLY_ARC_SHOT_PROFILE,
  holyArcHealAmount,
  resolveHolyArcPath,
  SHOT_DAMAGE_FACTOR,
  SHOT_RECOVERY_TICKS,
  swingArcContains,
  toLocalMeters,
  type LocalMetersOut
} from "./actionCombat.js";
import { destinationPoint, distanceMeters } from "./geo.js";

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Local point at `distanceM` and compass bearing (0 = north, 90 = east). */
const polar = (distanceM: number, bearingDeg: number) => ({
  x: distanceM * Math.sin(rad(bearingDeg)),
  y: distanceM * Math.cos(rad(bearingDeg))
});
const NORTH = { dirX: 0, dirY: 1 };

describe("action combat constants", () => {
  it("keep the per-combo tables the same length", () => {
    expect(SWING_COMBO_LENGTH).toBe(3);
    expect(SWING_RECOVERY_TICKS).toHaveLength(SWING_COMBO_LENGTH);
    expect(SWING_KNOCKBACK_M).toHaveLength(SWING_COMBO_LENGTH);
  });

  it("covers the lag compensation cap with the position history ring", () => {
    expect(POSITION_HISTORY_TICKS * 50).toBeGreaterThanOrEqual(SWING_LAG_COMP_MAX_MS);
  });

  it("keeps the v1 damage factors", () => {
    expect([...SWING_DAMAGE_FACTORS]).toEqual([0.5, 0.5, 0.75]);
  });
});

describe("toLocalMeters", () => {
  const out: LocalMetersOut = { x: Number.NaN, y: Number.NaN };

  it("is zero at the origin and writes into out", () => {
    toLocalMeters(35, -106, Math.cos(rad(35)), 35, -106, out);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });

  it.each([0, 35, 60, -45, 80])("matches great-circle distance and bearing at latitude %d", (lat0) => {
    const origin = { lat: lat0, lon: 20 };
    const cosLat0 = Math.cos(rad(lat0));
    for (const bearing of [0, 45, 90, 135, 180, 270, 315]) {
      const target = destinationPoint(origin, 100, bearing);
      toLocalMeters(origin.lat, origin.lon, cosLat0, target.lat, target.lon, out);
      expect(Math.hypot(out.x, out.y)).toBeCloseTo(distanceMeters(origin, target), 0);
      const expected = polar(100, bearing);
      expect(out.x).toBeCloseTo(expected.x, 0);
      expect(out.y).toBeCloseTo(expected.y, 0);
    }
  });

  it("scales east-west metres by cos(latitude)", () => {
    toLocalMeters(0, 0, 1, 0, 0.001, out);
    const atEquator = out.x;
    toLocalMeters(60, 0, Math.cos(rad(60)), 60, 0.001, out);
    expect(out.x / atEquator).toBeCloseTo(0.5, 6);
    toLocalMeters(60, 0, Math.cos(rad(60)), 60.001, 0, out);
    expect(out.y).toBeCloseTo(atEquator, 6);
  });

  it("takes the short way across the antimeridian", () => {
    toLocalMeters(0, 179.9995, 1, 0, -179.9995, out);
    expect(out.x).toBeGreaterThan(0);
    expect(out.x).toBeLessThan(120);
    toLocalMeters(0, -179.9995, 1, 0, 179.9995, out);
    expect(out.x).toBeLessThan(0);
    expect(out.x).toBeGreaterThan(-120);
  });
});

describe("swingArcContains", () => {
  it("hits straight ahead within range and misses beyond it", () => {
    expect(swingArcContains(0, 1, 0, 100, 0)).toBe(true);
    expect(swingArcContains(0, 1, 0, SWING_RANGE_M, 0)).toBe(true);
    expect(swingArcContains(0, 1, 0, SWING_RANGE_M + 0.01, 0)).toBe(false);
  });

  it("measures range to the target edge", () => {
    const r = SWING_TARGET_RADIUS_M;
    expect(swingArcContains(0, 1, 0, SWING_RANGE_M + r - 0.01, r)).toBe(true);
    expect(swingArcContains(0, 1, 0, SWING_RANGE_M + r + 0.01, r)).toBe(false);
  });

  it("includes centres on the arc edge and excludes just past it", () => {
    const inside = polar(80, SWING_HALF_ANGLE_DEG - 0.1);
    const outside = polar(80, SWING_HALF_ANGLE_DEG + 0.1);
    expect(swingArcContains(NORTH.dirX, NORTH.dirY, inside.x, inside.y, 0)).toBe(true);
    expect(swingArcContains(NORTH.dirX, NORTH.dirY, outside.x, outside.y, 0)).toBe(false);
    const mirrored = polar(80, -(SWING_HALF_ANGLE_DEG - 0.1));
    expect(swingArcContains(NORTH.dirX, NORTH.dirY, mirrored.x, mirrored.y, 0)).toBe(true);
  });

  it("widens the arc by the target radius (circle touching the edge ray)", () => {
    const r = SWING_TARGET_RADIUS_M;
    const distanceM = 80;
    // The circle touches the edge ray when distance * sin(beyond) == r.
    const touchDeg = (Math.asin(r / distanceM) * 180) / Math.PI;
    const touching = polar(distanceM, SWING_HALF_ANGLE_DEG + touchDeg - 0.2);
    const clear = polar(distanceM, SWING_HALF_ANGLE_DEG + touchDeg + 0.2);
    expect(swingArcContains(0, 1, touching.x, touching.y, r)).toBe(true);
    expect(swingArcContains(0, 1, clear.x, clear.y, r)).toBe(false);
    expect(swingArcContains(0, 1, touching.x, touching.y, 0)).toBe(false);
  });

  it("ignores the angle at point blank", () => {
    const behind = polar(SWING_POINT_BLANK_M - 0.5, 180);
    const side = polar(SWING_POINT_BLANK_M, 90);
    const justOutside = polar(SWING_POINT_BLANK_M + 0.5, 180);
    expect(swingArcContains(0, 1, behind.x, behind.y, 0)).toBe(true);
    expect(swingArcContains(0, 1, side.x, side.y, 0)).toBe(true);
    expect(swingArcContains(0, 1, 0, 0, 0)).toBe(true);
    expect(swingArcContains(0, 1, justOutside.x, justOutside.y, SWING_TARGET_RADIUS_M)).toBe(false);
  });

  it("misses targets behind and to the side even with a big radius", () => {
    for (const bearing of [100, 135, 180, 225, 260]) {
      const p = polar(60, bearing);
      expect(swingArcContains(0, 1, p.x, p.y, SWING_TARGET_RADIUS_M)).toBe(false);
    }
  });

  it("works for any aim direction and normalises near-unit vectors", () => {
    const aim = 237;
    const dirX = Math.sin(rad(aim)) * 1.02;
    const dirY = Math.cos(rad(aim)) * 1.02;
    const ahead = polar(90, aim + 30);
    const behind = polar(90, aim + 180);
    expect(swingArcContains(dirX, dirY, ahead.x, ahead.y, 0)).toBe(true);
    expect(swingArcContains(dirX, dirY, behind.x, behind.y, 0)).toBe(false);
  });

  it("rejects degenerate input", () => {
    expect(swingArcContains(0, 0, 0, 50, 0)).toBe(false);
    expect(swingArcContains(Number.NaN, 1, 0, 50, 0)).toBe(false);
    expect(swingArcContains(0, 1, Number.NaN, 50, 0)).toBe(false);
    expect(swingArcContains(0, 1, 0, Number.POSITIVE_INFINITY, 0)).toBe(false);
  });
});

describe("shotLineContains", () => {
  const halfWidth = SHOT_WIDTH_M / 2;

  it("returns the distance along the line for targets on it", () => {
    expect(shotLineContains(0, 1, 0, 150, 0)).toBeCloseTo(150, 9);
    expect(shotLineContains(1, 0, 42, 0, 0)).toBeCloseTo(42, 9);
    expect(shotLineContains(0, 1, 0, 0, 0)).toBe(0);
  });

  it("limits range to the target edge", () => {
    expect(shotLineContains(0, 1, 0, SHOT_RANGE_M, 0)).toBeCloseTo(SHOT_RANGE_M, 9);
    expect(shotLineContains(0, 1, 0, SHOT_RANGE_M + 0.01, 0)).toBeNull();
    expect(shotLineContains(0, 1, 0, SHOT_RANGE_M + 19.9, 20)).not.toBeNull();
    expect(shotLineContains(0, 1, 0, SHOT_RANGE_M + 20.1, 20)).toBeNull();
  });

  it("uses half the corridor width plus the target radius sideways", () => {
    expect(shotLineContains(0, 1, halfWidth - 0.01, 100, 0)).not.toBeNull();
    expect(shotLineContains(0, 1, -(halfWidth - 0.01), 100, 0)).not.toBeNull();
    expect(shotLineContains(0, 1, halfWidth + 0.01, 100, 0)).toBeNull();
    expect(shotLineContains(0, 1, halfWidth + 19.9, 100, 20)).not.toBeNull();
    expect(shotLineContains(0, 1, halfWidth + 20.1, 100, 20)).toBeNull();
  });

  it("never hits behind the shooter", () => {
    expect(shotLineContains(0, 1, 0, -1, 20)).toBeNull();
    expect(shotLineContains(0, 1, 0, -100, 20)).toBeNull();
  });

  it("measures along a diagonal aim", () => {
    const d = Math.SQRT1_2;
    expect(shotLineContains(d, d, 100 * d, 100 * d, 0)).toBeCloseTo(100, 9);
    // 4 m off the diagonal line, still inside the 5 m arrow half width.
    expect(shotLineContains(d, d, 100 * d - 4 * d, 100 * d + 4 * d, 0)).toBeCloseTo(100, 9);
  });

  it("rejects degenerate input", () => {
    expect(shotLineContains(0, 0, 0, 50, 0)).toBeNull();
    expect(shotLineContains(0, 1, Number.NaN, 50, 0)).toBeNull();
  });
});

describe("shot profiles", () => {
  it("staff and wand cast the arcane blast, other ranged weapons shoot arrows, melee swings", () => {
    expect(shotProfileForWeapon("staff", false)).toBe(ARCANE_BLAST_SHOT_PROFILE);
    expect(shotProfileForWeapon("wand", true)).toBe(ARCANE_BLAST_SHOT_PROFILE);
    expect(shotProfileForWeapon("bow", true)).toBe(BOW_SHOT_PROFILE);
    expect(shotProfileForWeapon("shuriken", true)).toBe(BOW_SHOT_PROFILE);
    expect(shotProfileForWeapon("sword", false)).toBeNull();
    expect(shotProfileForWeapon(null, false)).toBeNull();
  });

  it("keeps the bow exactly on the SHOT_* rules", () => {
    expect(BOW_SHOT_PROFILE).toEqual({
      id: "arrow", rangeM: SHOT_RANGE_M, widthM: SHOT_WIDTH_M, recoveryTicks: SHOT_RECOVERY_TICKS, damageFactor: SHOT_DAMAGE_FACTOR
    });
  });

  it("keeps the arcane blast DPS within 10 % of the bow's", () => {
    const dps = (profile: typeof BOW_SHOT_PROFILE) => profile.damageFactor / (profile.recoveryTicks * 0.05);
    const ratio = dps(ARCANE_BLAST_SHOT_PROFILE) / dps(BOW_SHOT_PROFILE);
    expect(ratio).toBeGreaterThanOrEqual(0.9);
    expect(ratio).toBeLessThanOrEqual(1.1);
  });

  it("tests the arcane blast corridor with its own range and width", () => {
    const { rangeM, widthM } = ARCANE_BLAST_SHOT_PROFILE;
    expect(shotLineContains(0, 1, 0, rangeM, 0, ARCANE_BLAST_SHOT_PROFILE)).toBeCloseTo(rangeM, 9);
    expect(shotLineContains(0, 1, 0, rangeM + 0.01, 0, ARCANE_BLAST_SHOT_PROFILE)).toBeNull();
    expect(shotLineContains(0, 1, widthM / 2 - 0.01, 100, 0, ARCANE_BLAST_SHOT_PROFILE)).not.toBeNull();
    expect(shotLineContains(0, 1, widthM / 2 + 0.01, 100, 0, ARCANE_BLAST_SHOT_PROFILE)).toBeNull();
  });
});

describe("holy arc", () => {
  it("the scepter casts the holy arc only with the CLERIC_ARC_ENABLED flag; off, it swings", () => {
    expect(shotProfileForWeapon("scepter", false)).toBeNull();
    expect(shotProfileForWeapon("scepter", false, { holyArc: false })).toBeNull();
    expect(shotProfileForWeapon("scepter", false, { holyArc: true })).toBe(HOLY_ARC_SHOT_PROFILE);
    // The flag never changes other weapons.
    expect(shotProfileForWeapon("staff", false, { holyArc: true })).toBe(ARCANE_BLAST_SHOT_PROFILE);
    expect(shotProfileForWeapon("sword", false, { holyArc: true })).toBeNull();
  });

  it("lands at 70-80 % of the bow's damage per second with ~300 m range and ~1.0 s recovery", () => {
    const dps = (profile: typeof BOW_SHOT_PROFILE) => profile.damageFactor / (profile.recoveryTicks * 0.05);
    const ratio = dps(HOLY_ARC_SHOT_PROFILE) / dps(BOW_SHOT_PROFILE);
    expect(ratio).toBeGreaterThanOrEqual(0.7);
    expect(ratio).toBeLessThanOrEqual(0.8);
    expect(HOLY_ARC_SHOT_PROFILE.rangeM).toBe(300);
    expect(HOLY_ARC_SHOT_PROFILE.recoveryTicks * 50).toBe(1_000);
  });

  it("heals 1.5x the arc's base damage", () => {
    expect(holyArcHealAmount(10)).toBe(8);
    expect(holyArcHealAmount(100)).toBe(84);
    expect(holyArcHealAmount(0)).toBe(0);
    expect(holyArcHealAmount(Number.NaN)).toBe(0);
  });

  it("heals the allies before the first enemy in line order and stops on that enemy", () => {
    const path = resolveHolyArcPath([
      { id: "far-ally", alongM: 150, role: "ally" },
      { id: "near-ally", alongM: 40, role: "ally" },
      { id: "far-mob", alongM: 200, role: "enemy" },
      { id: "mob", alongM: 120, role: "enemy" },
      { id: "mid-ally", alongM: 90, role: "ally" }
    ], 300);
    expect(path).toEqual({ healIds: ["near-ally", "mid-ally"], enemyId: "mob", reachM: 120 });
  });

  it("heals along the full range when no enemy is on the line", () => {
    expect(resolveHolyArcPath([
      { id: "b", alongM: 260, role: "ally" },
      { id: "a", alongM: 10, role: "ally" }
    ], 300)).toEqual({ healIds: ["a", "b"], enemyId: null, reachM: 300 });
    expect(resolveHolyArcPath([], 300)).toEqual({ healIds: [], enemyId: null, reachM: 300 });
  });

  it("an enemy in front of every ally stops the arc before any heal", () => {
    expect(resolveHolyArcPath([
      { id: "ally", alongM: 60, role: "ally" },
      { id: "mob", alongM: 30, role: "enemy" }
    ], 300)).toEqual({ healIds: [], enemyId: "mob", reachM: 30 });
  });
});

describe("meleeWindupConeContains", () => {
  it("holds straight ahead within range plus slack and drops just past it", () => {
    expect(meleeWindupConeContains(90, 60, 60 + MOB_MELEE_WINDUP_RANGE_SLACK_M, 0)).toBe(true);
    expect(meleeWindupConeContains(90, 60, 60 + MOB_MELEE_WINDUP_RANGE_SLACK_M + 1, 0)).toBe(false);
  });

  it("is 90 degrees wide around the compass facing", () => {
    // Facing north: 44 degrees off still counts, 46 does not.
    const inside = (44 * Math.PI) / 180;
    const outside = (46 * Math.PI) / 180;
    expect(meleeWindupConeContains(0, 60, 50 * Math.sin(inside), 50 * Math.cos(inside))).toBe(true);
    expect(meleeWindupConeContains(0, 60, 50 * Math.sin(outside), 50 * Math.cos(outside))).toBe(false);
    expect(meleeWindupConeContains(180, 60, 0, -50)).toBe(true);
    expect(meleeWindupConeContains(180, 60, 0, 50)).toBe(false);
  });

  it("always holds at point blank and rejects bad input", () => {
    expect(meleeWindupConeContains(0, 60, 0, -MOB_MELEE_WINDUP_POINT_BLANK_M)).toBe(true);
    expect(meleeWindupConeContains(0, 60, Number.NaN, 0)).toBe(false);
  });
});

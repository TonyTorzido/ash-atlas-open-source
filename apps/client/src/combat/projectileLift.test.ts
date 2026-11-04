import { describe, expect, it } from "vitest";
import { MOB_RANGED_AIM_ID, destinationPoint, distanceMeters } from "@ash-atlas/shared";
import { COMBAT_CHEST_HEIGHT_SHARE, combatChestLiftPx, combatChestPointInto } from "../map/spritePresentation.js";
import {
  MOB_PROJECTILE_ABILITY_IDS,
  MOB_SHOT_FLIGHT_MS,
  liftedProjectilePoint,
  mobProjectileGroundPath,
  mobShotFlightProgress
} from "./projectileLift.js";
import { autoAimDirection } from "./swingAim.js";

describe("lifted projectiles (hurt circles)", () => {
  it("draws the projectile at chest height while the shadow stays on the true ground path", () => {
    const start = { x: 100, y: 400 };
    const end = { x: 300, y: 200 };
    const lift = combatChestLiftPx(60, "player");
    expect(lift).toBeCloseTo(60 * COMBAT_CHEST_HEIGHT_SHARE.player, 9);
    const mid = liftedProjectilePoint(start, end, 0.5, lift);
    expect(mid.ground).toEqual({ x: 200, y: 300 });
    expect(mid.body).toEqual({ x: 200, y: 300 - lift });
    // The shadow traces the authoritative path end to end, and progress clamps.
    expect(liftedProjectilePoint(start, end, 0, lift).ground).toEqual(start);
    expect(liftedProjectilePoint(start, end, 2, lift).ground).toEqual(end);
    expect(liftedProjectilePoint(start, end, Number.NaN, lift).ground).toEqual(start);
  });

  it("keeps the chest share between 45% and 55% of the sprite height per entity type", () => {
    for (const share of Object.values(COMBAT_CHEST_HEIGHT_SHARE)) {
      expect(share).toBeGreaterThanOrEqual(0.45);
      expect(share).toBeLessThanOrEqual(0.55);
    }
    expect(combatChestLiftPx(Number.NaN, "mob")).toBe(0);
  });

  it("anchors impact VFX at the chest: feet plus the height offset", () => {
    const out = { x: 0, y: 0 };
    expect(combatChestPointInto(50, 500, 80, "mob", out)).toEqual({ x: 50, y: 500 - 80 * COMBAT_CHEST_HEIGHT_SHARE.mob });
    expect(combatChestPointInto(50, 500, 80, "player", out).y).toBeCloseTo(500 - 80 * COMBAT_CHEST_HEIGHT_SHARE.player, 9);
  });

  it("flies mob shots along the telegraphed ground path", () => {
    const origin = { lat: 35.0844, lon: -106.6504 };
    expect(MOB_PROJECTILE_ABILITY_IDS.has(MOB_RANGED_AIM_ID)).toBe(true);
    const line = mobProjectileGroundPath({ kind: "line", origin, facingDegrees: 90, lengthM: 200, widthM: 40 }, null)!;
    expect(line.start).toEqual(origin);
    expect(distanceMeters(line.start, line.end)).toBeCloseTo(200, 0);
    const caster = destinationPoint(origin, 250, 0);
    const blast = mobProjectileGroundPath({ kind: "circle", center: origin, radiusM: 86 }, caster)!;
    expect(blast).toEqual({ start: caster, end: origin });
    expect(mobProjectileGroundPath({ kind: "circle", center: origin, radiusM: 86 }, null)).toBeNull();
    expect(mobShotFlightProgress(-1)).toBeNull();
    expect(mobShotFlightProgress(MOB_SHOT_FLIGHT_MS / 2)).toBeCloseTo(0.5, 9);
    expect(mobShotFlightProgress(MOB_SHOT_FLIGHT_MS + 1)).toBeNull();
  });
});

describe("tap auto-aim uses hurt circles", () => {
  it("picks a big mob whose circle edge is in reach even though its centre is past the swing range", () => {
    const origin = { lat: 35.0844, lon: -106.6504 };
    const big = { ...destinationPoint(origin, 140, 90), radiusM: 40 };
    expect(autoAimDirection(origin, [big], 110, null)).not.toBeNull();
    expect(autoAimDirection(origin, [{ ...big, radiusM: 20 }], 110, null)).toBeNull();
  });
});

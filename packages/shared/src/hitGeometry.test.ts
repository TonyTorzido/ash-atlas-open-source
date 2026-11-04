import { describe, expect, it } from "vitest";
import { SHOT_RANGE_M, SWING_RANGE_M, shotLineContains, swingArcContains } from "./actionCombat.js";
import { MELEE_ATTACK_RANGE_M } from "./combatConstants.js";
import {
  MOB_HURT_RADIUS_MAX_M,
  MOB_HURT_RADIUS_SCALE,
  PLAYER_HURT_RADIUS_M,
  circleVsCircle,
  circleVsCone,
  circleVsRect,
  circleVsSegment,
  hurtShapeReachM,
  mobHurtRadiusM
} from "./hitGeometry.js";
import { MOB_SIGNATURES } from "./mobArchetypes.js";
import {
  MOB_TACTICS_BODY_WIDTH_M,
  MOB_TACTICS_MELEE_REACH_M,
  MOB_TACTICS_MELEE_REACH_SLACK_M,
  MOB_TACTICS_PLAYER_BODY_WIDTH_M,
  mobTacticsBodyWidthM
} from "./mobTactics.js";

/** Largest centre distance straight ahead (+y) that still hits, by bisection on a monotone hit test. */
function connectDistanceM(hits: (distanceM: number) => boolean): number {
  let low = 0;
  let high = 2_000;
  if (!hits(low)) return 0;
  for (let step = 0; step < 60; step += 1) {
    const mid = (low + high) / 2;
    if (hits(mid)) low = mid; else high = mid;
  }
  return low;
}

describe("hurt circle constants", () => {
  it("builds the player hurt circle on the player body width (0.65 x half width)", () => {
    expect(PLAYER_HURT_RADIUS_M).toBeCloseTo(0.65 * MOB_TACTICS_PLAYER_BODY_WIDTH_M / 2, 9);
    expect(PLAYER_HURT_RADIUS_M).toBeGreaterThan(12);
    expect(PLAYER_HURT_RADIUS_M).toBeLessThan(16);
  });

  it("derives mob hurt circles from the art, slightly generous, and bounds them for broad phase", () => {
    expect(MOB_HURT_RADIUS_SCALE).toBeGreaterThanOrEqual(1);
    expect(MOB_HURT_RADIUS_SCALE).toBeLessThanOrEqual(1.1);
    expect(mobHurtRadiusM("wolf")).toBeCloseTo(MOB_HURT_RADIUS_SCALE * mobTacticsBodyWidthM("wolf") / 2, 9);
    expect(mobHurtRadiusM(null)).toBeCloseTo(MOB_HURT_RADIUS_SCALE * MOB_TACTICS_BODY_WIDTH_M / 2, 9);
    expect(mobHurtRadiusM("bear")).toBeGreaterThan(mobHurtRadiusM("wolf"));
    expect(MOB_HURT_RADIUS_MAX_M).toBeGreaterThanOrEqual(mobHurtRadiusM("bear"));
  });

  it("compensates a drawn shape by the hurt radius, never below the floor", () => {
    expect(hurtShapeReachM(150, 13.8)).toBeCloseTo(136.2, 9);
    expect(hurtShapeReachM(10, 40)).toBe(1);
    expect(hurtShapeReachM(10, 40, 5)).toBe(5);
  });
});

describe("circleVsCircle", () => {
  it("hits when touching and misses just past", () => {
    expect(circleVsCircle(0, 0, 10, 30, 0, 20)).toBe(true);
    expect(circleVsCircle(0, 0, 10, 30.01, 0, 20)).toBe(false);
    expect(circleVsCircle(0, 0, 10, Number.NaN, 0, 20)).toBe(false);
  });
});

describe("circleVsCone", () => {
  const r = 10;
  it("reaches the circle edge straight ahead", () => {
    expect(circleVsCone(0, 100, 90, 0, 100 + r - 0.01, r)).toBe(true);
    expect(circleVsCone(0, 100, 90, 0, 100 + r + 0.01, r)).toBe(false);
  });

  it("hits a circle whose centre is outside the wedge but which touches the edge", () => {
    // 50 m out on a bearing of 45 + 10 degrees: distance to the 45 degree edge is 50 sin 10 = 8.68 m.
    const angle = (55 * Math.PI) / 180;
    const x = 50 * Math.sin(angle);
    const y = 50 * Math.cos(angle);
    expect(circleVsCone(0, 100, 90, x, y, 8.7)).toBe(true);
    expect(circleVsCone(0, 100, 90, x, y, 8.6)).toBe(false);
  });

  it("clamps the edge test at the arc end (no infinite edge ray)", () => {
    // Just past the far corner of the right edge, outside the wedge: the nearest point is the arc end.
    const edge = (45 * Math.PI) / 180;
    const corner = { x: 100 * Math.sin(edge), y: 100 * Math.cos(edge) };
    const out = { x: corner.x + 12, y: corner.y };
    expect(circleVsCone(0, 100, 90, out.x, out.y, 11)).toBe(false);
    expect(circleVsCone(0, 100, 90, out.x, out.y, 12.1)).toBe(true);
  });

  it("hits when the apex is inside the circle, misses behind, and follows the compass facing", () => {
    expect(circleVsCone(0, 100, 30, 0, -5, r)).toBe(true);
    expect(circleVsCone(0, 100, 90, 0, -30, r)).toBe(false);
    expect(circleVsCone(90, 100, 90, 105, 0, r)).toBe(true);
    expect(circleVsCone(90, 100, 90, 0, 105, r)).toBe(false);
    expect(circleVsCone(0, 100, 90, Number.NaN, 0, r)).toBe(false);
  });
});

describe("circleVsRect (lane decal)", () => {
  it("needs the whole hurt circle to leave the lane sideways and past the end", () => {
    expect(circleVsRect(0, 200, 40, 20 + 10 - 0.01, 100, 10)).toBe(true);
    expect(circleVsRect(0, 200, 40, 20 + 10 + 0.01, 100, 10)).toBe(false);
    expect(circleVsRect(0, 200, 40, 0, 200 + 9.99, 10)).toBe(true);
    expect(circleVsRect(0, 200, 40, 0, 210.01, 10)).toBe(false);
  });

  it("rounds the corners (distance to the rectangle) and follows the facing", () => {
    // 8 m past the end and 8 m past the side: 11.3 m from the corner.
    expect(circleVsRect(0, 200, 40, 28, 208, 11)).toBe(false);
    expect(circleVsRect(0, 200, 40, 28, 208, 11.4)).toBe(true);
    expect(circleVsRect(90, 200, 40, 150, 0, 1)).toBe(true);
    expect(circleVsRect(90, 200, 40, 0, 150, 1)).toBe(false);
  });
});

describe("circleVsSegment (swept projectile)", () => {
  it("hits along the path within half width + radius and misses beyond", () => {
    expect(circleVsSegment(0, 0, 0, 300, 5, 14.99, 150, 10)).toBe(true);
    expect(circleVsSegment(0, 0, 0, 300, 5, 15.01, 150, 10)).toBe(false);
    expect(circleVsSegment(0, 0, 0, 300, 5, 0, 314.99, 10)).toBe(true);
    expect(circleVsSegment(0, 0, 0, 300, 5, 0, -15.01, 10)).toBe(false);
  });

  it("cannot tunnel: a fast shot that skips over a small body between two tick samples still hits", () => {
    // 1200 m/s at 20 Hz = 60 m per tick. Samples at y = 0, 60, 120; the body sits at y = 90 with a 6 m radius.
    const body = { x: 2, y: 90, r: 6 };
    const halfWidth = 1;
    const sampledHit = [0, 60, 120].some((y) => Math.hypot(body.x, body.y - y) <= body.r + halfWidth);
    expect(sampledHit).toBe(false);
    expect(circleVsSegment(0, 0, 0, 120, halfWidth, body.x, body.y, body.r)).toBe(true);
  });

  it("treats a zero-length segment as a circle and rejects bad input", () => {
    expect(circleVsSegment(0, 0, 0, 0, 0, 3, 4, 5)).toBe(true);
    expect(circleVsSegment(0, 0, 0, 0, 0, 3, 4.1, 5)).toBe(false);
    expect(circleVsSegment(0, 0, Number.NaN, 0, 0, 0, 0, 5)).toBe(false);
  });
});

/**
 * Effective reach parity (docs/plans/hurt-circles.md): the centre-to-centre distance at which each attack connects
 * straight ahead, before (point or flat-20 m tests) and after (hurt circles). Drawn sizes use hurtShapeReachM like
 * the server does. Tolerance 2 m, except the player's attacks on a wolf, which are about 1 m generous by design.
 */
describe("effective reach parity table", () => {
  const rp = PLAYER_HURT_RADIUS_M;
  const rWolf = mobHurtRadiusM("wolf");
  const coneHit = (rangeM: number, angleDeg: number, r: number) => (d: number) => circleVsCone(0, rangeM, angleDeg, 0, d, r);
  const laneHit = (lengthM: number, widthM: number, r: number) => (d: number) => circleVsRect(0, lengthM, widthM, 0, d, r);
  const R = MELEE_ATTACK_RANGE_M;
  const rows: Array<[string, number, number]> = [
    ["player swing vs wolf", 130 + 20, connectDistanceM((d) => swingArcContains(0, 1, 0, d, rWolf))],
    ["player shot vs wolf", 300 + 20, connectDistanceM((d) => shotLineContains(0, 1, 0, d, rWolf) !== null)],
    ["managed mob melee", MOB_TACTICS_MELEE_REACH_M + MOB_TACTICS_MELEE_REACH_SLACK_M,
      connectDistanceM(coneHit(hurtShapeReachM(MOB_TACTICS_MELEE_REACH_M + MOB_TACTICS_MELEE_REACH_SLACK_M, rp), 90, rp))],
    ["unmanaged melee windup (100 m mob)", R + 5, connectDistanceM(coneHit(hurtShapeReachM(R + 5, rp), 90, rp))],
    ["ranged aim (300 m caster)", 300, connectDistanceM(laneHit(hurtShapeReachM(300, rp), 40, rp))],
    ["maul", MOB_SIGNATURES.maul.rangeM, connectDistanceM(coneHit(hurtShapeReachM(MOB_SIGNATURES.maul.rangeM, rp), 100, rp))],
    ["slam", MOB_SIGNATURES.slam.radiusM, connectDistanceM((d) => circleVsCircle(0, d, rp, 0, 0, hurtShapeReachM(MOB_SIGNATURES.slam.radiusM, rp)))],
    ["ground blast", MOB_SIGNATURES.ground_blast.radiusM,
      connectDistanceM((d) => circleVsCircle(0, d, rp, 0, 0, hurtShapeReachM(MOB_SIGNATURES.ground_blast.radiusM, rp)))],
    ["volley line", MOB_SIGNATURES.volley.rangeM, connectDistanceM(laneHit(hurtShapeReachM(MOB_SIGNATURES.volley.rangeM, rp), 40, rp))],
    ["swoop", MOB_SIGNATURES.swoop.rangeM, connectDistanceM(coneHit(hurtShapeReachM(MOB_SIGNATURES.swoop.rangeM, rp), 90, rp))]
  ];
  it.each(rows)("%s connects where it used to", (_name, oldM, newM) => {
    expect(Math.abs(newM - oldM)).toBeLessThanOrEqual(2);
  });

  it("keeps the player's swing at the old 150 m on the generic body too", () => {
    expect(SWING_RANGE_M + mobHurtRadiusM(null)).toBeGreaterThan(148);
    expect(SWING_RANGE_M + mobHurtRadiusM(null)).toBeLessThan(153);
    expect(SHOT_RANGE_M + rWolf).toBeCloseTo(320, -1);
  });
});

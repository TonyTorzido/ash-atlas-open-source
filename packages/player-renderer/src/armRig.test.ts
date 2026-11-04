import { describe, expect, it } from "vitest";

import {
  ARM_RIG_TUNING,
  armChainForSide,
  bendArmPoint,
  createArmBend,
  createArmChain,
  poseArmBend
} from "./armRig.js";
import { createArmGeometry } from "./gatherAnimation.js";

describe("bendable arm", () => {
  const geometry = createArmGeometry();
  const point = { x: 0, y: 0 };
  const across = (chain: ReturnType<typeof createArmChain>, along: number, offset: number) => ({
    x: chain.shoulderX + chain.axisX * along * chain.length + chain.normalX * offset,
    y: chain.shoulderY + chain.axisY * along * chain.length + chain.normalY * offset
  });

  it("leaves every point exactly in place at the rest pose", () => {
    for (const sign of [1, -1]) {
      const chain = armChainForSide(geometry, sign, createArmChain());
      const bend = poseArmBend(chain, 0, 0, createArmBend());
      for (const [along, offset] of [[1, 0], [0.3, 1.5], [-0.2, -1], [0.55, 2], [1.2, -2]]) {
        const rest = across(chain, along!, offset!);
        bendArmPoint(chain, bend, rest.x, rest.y, point);
        expect(point.x).toBeCloseTo(rest.x, 6);
        expect(point.y).toBeCloseTo(rest.y, 6);
      }
    }
  });

  it("keeps the arm's thickness and the fist's shape at every pose", () => {
    const chain = armChainForSide(geometry, 1, createArmChain());
    const bend = createArmBend();
    for (const [upper, elbow] of [[60, 100], [40, 0], [10, 50], [-20, 30], [72, 90]]) {
      poseArmBend(chain, upper!, elbow!, bend);
      // Any row across the upper arm, the elbow, the forearm or the fist keeps its width.
      for (const along of [0.15, 0.35, 0.5, 0.55, 0.6, 0.8, 1, 1.25]) {
        const inner = across(chain, along, -2.5);
        const outer = across(chain, along, 2.5);
        const a = bendArmPoint(chain, bend, inner.x, inner.y, { x: 0, y: 0 });
        const b = bendArmPoint(chain, bend, outer.x, outer.y, { x: 0, y: 0 });
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(5, 5);
      }
      // The whole fist moves rigidly.
      const p = across(chain, 0.8, -2);
      const q = across(chain, 1.3, 2.5);
      const a = bendArmPoint(chain, bend, p.x, p.y, { x: 0, y: 0 });
      const b = bendArmPoint(chain, bend, q.x, q.y, { x: 0, y: 0 });
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(Math.hypot(q.x - p.x, q.y - p.y), 5);
      // The fist the rig reports is where the rest fist centre lands.
      bendArmPoint(chain, bend, chain.fistX, chain.fistY, point);
      expect(point.x).toBeCloseTo(bend.fistX, 5);
      expect(point.y).toBeCloseTo(bend.fistY, 5);
    }
  });

  it("raises the fist when the elbow bends and caps the turns", () => {
    const chain = armChainForSide(geometry, 1, createArmChain());
    const bent = poseArmBend(chain, 45, 90, createArmBend());
    expect(bent.fistY).toBeLessThan(chain.shoulderY);
    expect(bent.fistX).toBeGreaterThan(chain.shoulderX);
    const capped = poseArmBend(chain, 200, 400, createArmBend());
    expect(-capped.upperTurn * 180 / Math.PI).toBeCloseTo(ARM_RIG_TUNING.maxRaiseDegrees, 6);
    expect(Math.abs(capped.bend) * 180 / Math.PI).toBeCloseTo(ARM_RIG_TUNING.maxBendDegrees, 6);
    // The art above the shoulder dome never moves.
    const cap = across(chain, ARM_RIG_TUNING.blendStart - 0.05, 1);
    bendArmPoint(chain, capped, cap.x, cap.y, point);
    expect(point.x).toBe(cap.x);
    expect(point.y).toBe(cap.y);
  });

  it("moves the whole arm rigidly about the shoulder joint and the forearm rigidly about the mid-arm elbow", () => {
    const chain = armChainForSide(geometry, 1, createArmChain());
    const pose = poseArmBend(chain, 110, 40, createArmBend());
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    // Any two points of the upper arm (from the shoulder joint down to the elbow) keep their distance.
    const u1 = across(chain, 0.02, -3);
    const u2 = across(chain, 0.5, 3);
    expect(dist(bendArmPoint(chain, pose, u1.x, u1.y, { x: 0, y: 0 }), bendArmPoint(chain, pose, u2.x, u2.y, { x: 0, y: 0 })))
      .toBeCloseTo(dist(u1, u2), 5);
    // The shoulder joint itself never moves; the elbow sits on the arm's centre line.
    const joint = bendArmPoint(chain, pose, chain.shoulderX, chain.shoulderY, { x: 0, y: 0 });
    expect(joint.x).toBeCloseTo(chain.shoulderX, 6);
    expect(joint.y).toBeCloseTo(chain.shoulderY, 6);
    expect(dist({ x: pose.elbowRestX, y: pose.elbowRestY }, { x: chain.shoulderX, y: chain.shoulderY }))
      .toBeCloseTo(ARM_RIG_TUNING.elbowAt * chain.length, 6);
    // Forearm and fist are one rigid piece.
    const f1 = across(chain, 0.6, -3);
    const f2 = across(chain, 1.3, 3);
    expect(dist(bendArmPoint(chain, pose, f1.x, f1.y, { x: 0, y: 0 }), bendArmPoint(chain, pose, f2.x, f2.y, { x: 0, y: 0 })))
      .toBeCloseTo(dist(f1, f2), 5);
    // Limits.
    const capped = poseArmBend(chain, 300, 400, createArmBend());
    expect(-capped.upperTurn * 180 / Math.PI).toBeCloseTo(ARM_RIG_TUNING.maxRaiseDegrees, 6);
    expect(Math.abs(capped.bend) * 180 / Math.PI).toBeCloseTo(ARM_RIG_TUNING.maxBendDegrees, 6);
    expect(Math.abs(poseArmBend(chain, 0, -50, createArmBend()).bend)).toBe(0);
  });

  it("mirrors the left arm", () => {
    const right = armChainForSide(geometry, 1, createArmChain());
    const left = armChainForSide(geometry, -1, createArmChain());
    const rightBend = poseArmBend(right, 50, 80, createArmBend());
    const leftBend = poseArmBend(left, 50, 80, createArmBend());
    for (const along of [0.2, 0.55, 1.1]) {
      const r = across(right, along, 1.5);
      const a = bendArmPoint(right, rightBend, r.x, r.y, { x: 0, y: 0 });
      const b = bendArmPoint(left, leftBend, 2 * geometry.centerX - r.x, r.y, { x: 0, y: 0 });
      expect(b.x).toBeCloseTo(2 * geometry.centerX - a.x, 5);
      expect(b.y).toBeCloseTo(a.y, 5);
    }
  });
});

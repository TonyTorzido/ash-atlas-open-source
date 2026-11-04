import { describe, expect, it } from "vitest";

import { DEFAULT_PROJECTILE_TRANSFORM } from "@ash-atlas/shared";

import {
  projectileAimRadians,
  resolveProjectileSpriteTransform
} from "./projectile.js";

describe("projectile presentation geometry", () => {
  it.each([
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, 0],
    [{ x: 10, y: 0 }, { x: 0, y: 0 }, Math.PI],
    [{ x: 0, y: 10 }, { x: 0, y: 0 }, -Math.PI / 2],
    [{ x: 0, y: 0 }, { x: 0, y: 10 }, Math.PI / 2],
    [{ x: 0, y: 0 }, { x: -10, y: 10 }, 3 * Math.PI / 4]
  ] as const)("aims the projectile along the travel vector", (source, target, expected) => {
    expect(projectileAimRadians(source, target)).toBeCloseTo(expected);
  });

  it("uses a stable right-facing direction for a zero-length travel vector", () => {
    expect(projectileAimRadians({ x: 4, y: 4 }, { x: 4, y: 4 })).toBe(0);
    expect(resolveProjectileSpriteTransform(
      { ...DEFAULT_PROJECTILE_TRANSFORM },
      projectileAimRadians({ x: 4, y: 4 }, { x: 4, y: 4 }),
      { x: 4, y: 4 }
    ).rotationRadians).toBe(0);
  });

  it("keeps legacy center anchoring while aiming right-authored artwork", () => {
    const result = resolveProjectileSpriteTransform(
      { ...DEFAULT_PROJECTILE_TRANSFORM },
      projectileAimRadians({ x: 0, y: 0 }, { x: 10, y: 10 }),
      { x: 20, y: 30 }
    );
    expect(result.anchorX).toBe(0.5);
    expect(result.anchorY).toBe(0.5);
    expect(result.positionX).toBe(20);
    expect(result.positionY).toBe(30);
    expect(result.rotationRadians).toBeCloseTo(Math.PI / 4);
  });

  it("aligns an arbitrary tail-to-impact axis and rotates local offsets", () => {
    const result = resolveProjectileSpriteTransform({
      ...DEFAULT_PROJECTILE_TRANSFORM,
      impactX: 0.8,
      impactY: 0.2,
      tailX: 0.2,
      tailY: 0.8,
      offsetX: 4,
      offsetY: 2,
      scaleX: 2,
      scaleY: 0.5
    }, Math.PI / 2, { x: 10, y: 20 }, 3);
    expect(result.anchorX).toBe(0.8);
    expect(result.anchorY).toBe(0.2);
    expect(result.positionX).toBeCloseTo(8);
    expect(result.positionY).toBeCloseTo(24);
    expect(result.scaleX).toBe(6);
    expect(result.scaleY).toBe(1.5);
    const transformedAxis = Math.atan2(
      (0.2 - 0.8) * result.scaleY,
      (0.8 - 0.2) * result.scaleX
    ) + result.rotationRadians;
    expect(transformedAxis).toBeCloseTo(Math.PI / 2);
  });

  it("keeps flipped artwork aimed through signed scale", () => {
    const result = resolveProjectileSpriteTransform({
      ...DEFAULT_PROJECTILE_TRANSFORM,
      scaleX: -1
    }, 0, { x: 0, y: 0 });
    expect(Math.abs(result.rotationRadians)).toBeCloseTo(Math.PI);
  });
});

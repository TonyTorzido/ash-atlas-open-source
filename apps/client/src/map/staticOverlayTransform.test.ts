import { describe, expect, it } from "vitest";

import {
  applyStaticOverlayContainerTransform,
  computeStaticOverlayContainerTransform,
  resetStaticOverlayContainerTransform,
  type StaticOverlayTransformReference,
  type StaticOverlayTransformTarget
} from "./staticOverlayTransform.js";

describe("staticOverlayTransform", () => {
  it("translates static geometry during map drag", () => {
    const transform = computeStaticOverlayContainerTransform(
      reference(100, 80, 200, 80),
      reference(124, 54, 224, 54)
    );

    expect(transform).toMatchObject({
      pivotX: 100,
      pivotY: 80,
      x: 124,
      y: 54,
      scale: 1
    });
    expect(transform.rotation).toBeCloseTo(0, 6);
  });

  it("scales static geometry during map zoom", () => {
    const transform = computeStaticOverlayContainerTransform(
      reference(100, 100, 200, 100),
      reference(100, 100, 300, 100)
    );

    expect(transform.scale).toBeCloseTo(2, 6);
    expect(transform.rotation).toBeCloseTo(0, 6);
  });

  it("rotates static geometry when the map bearing changes", () => {
    const transform = computeStaticOverlayContainerTransform(
      reference(100, 100, 200, 100),
      reference(100, 100, 100, 200)
    );

    expect(transform.scale).toBeCloseTo(1, 6);
    expect(transform.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it("applies and resets a Pixi-compatible container transform", () => {
    const target = fakeTransformTarget();

    applyStaticOverlayContainerTransform(target, {
      pivotX: 10,
      pivotY: 20,
      x: 30,
      y: 40,
      scale: 1.5,
      rotation: 0.25
    });

    expect(target.snapshot()).toEqual({
      pivotX: 10,
      pivotY: 20,
      x: 30,
      y: 40,
      scale: 1.5,
      rotation: 0.25
    });

    resetStaticOverlayContainerTransform(target);

    expect(target.snapshot()).toEqual({
      pivotX: 0,
      pivotY: 0,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0
    });
  });
});

function reference(
  originX: number,
  originY: number,
  axisX: number,
  axisY: number
): StaticOverlayTransformReference {
  return {
    origin: {
      x: originX,
      y: originY
    },
    axis: {
      x: axisX,
      y: axisY
    }
  };
}

function fakeTransformTarget(): StaticOverlayTransformTarget & {
  snapshot(): {
    pivotX: number;
    pivotY: number;
    x: number;
    y: number;
    scale: number;
    rotation: number;
  };
} {
  const state = {
    pivotX: 0,
    pivotY: 0,
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0
  };
  return {
    pivot: {
      set(x: number, y: number) {
        state.pivotX = x;
        state.pivotY = y;
      }
    },
    position: {
      set(x: number, y: number) {
        state.x = x;
        state.y = y;
      }
    },
    scale: {
      set(value: number) {
        state.scale = value;
      }
    },
    get rotation() {
      return state.rotation;
    },
    set rotation(value: number) {
      state.rotation = value;
    },
    snapshot: () => ({ ...state })
  };
}

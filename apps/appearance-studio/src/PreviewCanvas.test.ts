import { describe, expect, it } from "vitest";
import { DEFAULT_PLAYER_APPEARANCE_CATALOG } from "@ash-atlas/shared";

import {
  movePivot,
  nearestAnchor,
  previewSnapshot,
  resolvePlayerHitGeometryPreview,
  resolveProjectilePointEditorTransform
} from "./PreviewCanvas.js";

describe("Appearance Studio preview anchor editing", () => {
  it("selects only the nearest anchor within the pointer hit radius", () => {
    const anchors = {
      face: { x: 4, y: -35 },
      chest: { x: 0, y: -21 }
    };

    expect(nearestAnchor(anchors, { x: 3.5, y: -35 }, 3)).toBe("face");
    expect(nearestAnchor(anchors, { x: 20, y: 20 }, 3)).toBeUndefined();
  });

  it("moves the item pivot while preserving the sprite's visual position", () => {
    const result = movePivot({
      pivotX: 0.25,
      pivotY: 0.5,
      offsetX: 5,
      offsetY: 6,
      textureWidth: 100,
      textureHeight: 200,
      scaleX: 0.5,
      scaleY: 0.5,
      rotationRadians: 0
    }, 10, -20);

    expect(result.pivot.pivotX).toBeCloseTo(0.45);
    expect(result.pivot.pivotY).toBeCloseTo(0.3);
    expect(result.offsetDeltaX).toBeCloseTo(10);
    expect(result.offsetDeltaY).toBeCloseTo(-20);
    expect(result.pivot.offsetX).toBeCloseTo(15);
    expect(result.pivot.offsetY).toBeCloseTo(-14);
  });

  it("keeps the projectile artwork stationary while aim points move", () => {
    const base = {
      offsetX: 3,
      offsetY: -2,
      rotationDegrees: 12,
      scaleX: 0.05,
      scaleY: 0.04,
      impactX: 0.9,
      impactY: 0.5,
      tailX: 0.1,
      tailY: 0.5
    };
    const before = resolveProjectilePointEditorTransform(
      base,
      Math.PI / 4,
      { x: 10, y: 20 }
    );
    const after = resolveProjectilePointEditorTransform(
      { ...base, impactX: 0.75, impactY: 0.25, tailX: 0.2, tailY: 0.8 },
      Math.PI / 4,
      { x: 10, y: 20 }
    );

    expect(after).toEqual(before);
  });

  it("previews standalone Pants as a Legs style while preserving Gear slots", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const pants = catalog.appearances.find(({ appearanceId }) =>
      appearanceId === "cloth-pants-black"
    )!;
    const chest = catalog.appearances.find(({ appearanceId }) =>
      appearanceId === "breastplate-armor"
    )!;

    const snapshot = previewSnapshot(
      catalog,
      pants,
      4,
      [chest.appearanceId],
      "item",
      null
    );

    expect(snapshot.styles?.legs).toBe("cloth-pants-black");
    expect(snapshot.slots.chest).toMatchObject({
      equipmentDefinitionId: "breast_plate",
      appearanceId: "breastplate-armor"
    });
  });

  it("keeps the selected appearance rendered while editing MAIN", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const blueEyes = catalog.appearances.find(({ appearanceId }) =>
      appearanceId === "blue-eyes-1"
    )!;

    const snapshot = previewSnapshot(catalog, blueEyes, 4, [], "main", null);

    expect(snapshot.styles?.eyes).toBe("blue-eyes-1");
  });

  it("previews a Beard as an independent face overlay", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const beard = {
      appearanceId: "beard-test",
      displayName: "Beard Test",
      familyId: "beard",
      assetKey: "cosmetics/beard-test.png",
      cosmetic: false,
      placements: {}
    } as const;
    catalog.appearances.push(beard);

    const snapshot = previewSnapshot(catalog, beard, 4, [], "item", null);

    expect(snapshot.styles?.beard).toBe("beard-test");
    expect(snapshot.slots).toEqual({});
  });

  it("maps player hit geometry to the anchored artwork frame", () => {
    const rectangle = resolvePlayerHitGeometryPreview({
      shape: "rectangle",
      centerX: 0.25,
      centerY: 0.5,
      width: 0.5,
      height: 0.25
    }, 80, 113, 3, 0.4, 0.8);
    expect(rectangle).toMatchObject({ shape: "rectangle", width: 40, height: 28.25 });
    expect(rectangle.centerX).toBeCloseTo(-12);
    expect(rectangle.centerY).toBeCloseTo(-33.9);
    if (rectangle.shape !== "rectangle") throw new Error("Expected rectangle preview");
    expect(rectangle.left).toBeCloseTo(-32);
    expect(rectangle.top).toBeCloseTo(-48.025);

    const circleAtScaleOne = resolvePlayerHitGeometryPreview({
      shape: "circle",
      centerX: 0.5,
      centerY: 1,
      radiusPx: 24
    }, 80, 120, 1, 0.5, 1);
    const circleAtScaleThree = resolvePlayerHitGeometryPreview({
      shape: "circle",
      centerX: 0.5,
      centerY: 1,
      radiusPx: 24
    }, 80, 120, 3, 0.5, 1);
    expect(circleAtScaleOne).toMatchObject({ radius: 24 });
    expect(circleAtScaleThree).toMatchObject({ radius: 8 });
  });
});

import type { ManorWorldSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { pickManorHitBox } from "./pixiOverlay.js";
import {
  worldPngInteractionHitBox,
  WORLD_PNG_PRESENTATION
} from "./worldPngPresentation.js";

const manor: ManorWorldSnapshot = {
  manorId: "manor-a",
  ownerPlayerId: "a",
  ownerUsername: "Ash",
  regionCode: "world-test",
  lat: 35,
  lon: -106,
  builtAt: "2026-07-12T00:00:00.000Z",
  placementRevision: 1
};

describe("Pixi manor marker hitbox", () => {
  it("selects only a marker inside its bounded hit radius", () => {
    const hitBoxes = [{ shape: "circle" as const, manor, x: 100, y: 80, radius: 29 }];
    expect(pickManorHitBox({ x: 100, y: 80 }, hitBoxes, [manor])).toEqual(manor);
    expect(pickManorHitBox({ x: 130, y: 80 }, hitBoxes, [manor])).toBeNull();
  });

  it("uses the Studio-authored Manor rectangle for production picking", () => {
    const presentation = WORLD_PNG_PRESENTATION.manor;
    const hitBox = worldPngInteractionHitBox({
      x: 100,
      y: 100,
      zoom: 15,
      presentation
    });

    expect(presentation.hitGeometry).toMatchObject({
      shape: "rectangle",
      centerX: 0.5,
      centerY: 0.5,
      width: 0.894,
      height: 0.755
    });
    expect(hitBox.shape).toBe("rectangle");
    if (hitBox.shape !== "rectangle") return;

    const hitBoxes = [{ manor, ...hitBox }];
    expect(pickManorHitBox({
      x: (hitBox.left + hitBox.right) / 2,
      y: (hitBox.top + hitBox.bottom) / 2
    }, hitBoxes, [manor])).toEqual(manor);
    expect(pickManorHitBox({
      x: hitBox.right + 0.1,
      y: (hitBox.top + hitBox.bottom) / 2
    }, hitBoxes, [manor])).toBeNull();
  });
});

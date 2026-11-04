import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cityStructurePresentationKey,
  isRenderableCityStructureType,
  scaledSpritePresentation,
  WORLD_PNG_PRESENTATION,
  worldLabelPositionBelowHitBox,
  worldPngDimensionsForZoom,
  fixedWorldPngDimensions,
  worldPngInteractionHitBox,
  worldPngScaleForZoom
} from "./worldPngPresentation.js";
import { setWorldPngMasterScalePreview } from "./worldPngMasterScale.js";
import { SPRITE_PRESENTATION, spriteHeightForZoom } from "./spritePresentation.js";
import {
  staticSpriteLocalScaleDuringTransform
} from "./spritePresentation.js";

// Exercise authored dimensions independently of the production master multiplier.
beforeEach(() => { setWorldPngMasterScalePreview(1); });
afterEach(() => { setWorldPngMasterScalePreview(null); });

describe("city structure PNG presentation", () => {
  it("places world labels 2px below the bottom-center of either base hitbox shape", () => {
    expect(worldLabelPositionBelowHitBox({
      shape: "circle",
      x: 40,
      y: 25,
      radius: 12
    })).toEqual({ x: 40, y: 39 });
    expect(worldLabelPositionBelowHitBox({
      shape: "rectangle",
      left: 10,
      top: 20,
      right: 50,
      bottom: 65
    })).toEqual({ x: 30, y: 67 });
  });

  it("defines every supported city structure presentation", () => {
    expect(Object.keys(WORLD_PNG_PRESENTATION.cityStructures).sort()).toEqual([
      "armory",
      "barracks",
      "cistern_warrens",
      "city_house",
      "city_kennel",
      "demolition_factory",
      "goblin_market",
      "market",
      "mayor_house",
      "monument_forestry",
      "monument_hunting",
      "monument_mining",
      "oil_well",
      "powder_works",
      "salon",
      "siege_workshop",
      "warehouse"
    ]);
    expect(isRenderableCityStructureType("city_house")).toBe(true);
    expect(isRenderableCityStructureType("mayor_house")).toBe(true);
    expect(isRenderableCityStructureType("warehouse")).toBe(true);
    expect(isRenderableCityStructureType("city_kennel")).toBe(true);
    expect(isRenderableCityStructureType("barracks")).toBe(true);
    expect(isRenderableCityStructureType("demolition_factory")).toBe(true);
    expect(isRenderableCityStructureType("armory")).toBe(false);
    expect(isRenderableCityStructureType("siege_workshop")).toBe(false);
    expect(isRenderableCityStructureType("powder_works")).toBe(false);
  });

  it("keeps the goblin market independent from the human market presentation", () => {
    expect(WORLD_PNG_PRESENTATION.cityStructures.goblin_market)
      .not.toBe(WORLD_PNG_PRESENTATION.cityStructures.market);
    expect(WORLD_PNG_PRESENTATION.cityStructures.goblin_market)
      .toMatchObject({ width: 81.4, height: 81.4 });
    expect(WORLD_PNG_PRESENTATION.cityStructures.goblin_market.source)
      .toBe("WORLD_PNG_PRESENTATION.cityStructures.goblin_market");
  });

  it("resolves Monument presentation by district with a legacy Mining fallback", () => {
    expect(cityStructurePresentationKey({ type: "monument", districtType: "mining" }))
      .toBe("monument_mining");
    expect(cityStructurePresentationKey({ type: "monument", districtType: "forestry" }))
      .toBe("monument_forestry");
    expect(cityStructurePresentationKey({ type: "monument", districtType: "hunting" }))
      .toBe("monument_hunting");
    expect(cityStructurePresentationKey({ type: "monument", districtType: null }))
      .toBe("monument_mining");
    expect(cityStructurePresentationKey({ type: "warehouse", districtType: null }))
      .toBe("warehouse");
    expect(cityStructurePresentationKey({ type: "armory", districtType: null }))
      .toBeNull();
  });

  it.each(["weaponsmith"] as const)(
    "ignores a stale %s snapshot before sprite or hit-box creation",
    (type) => {
      expect(isRenderableCityStructureType(type)).toBe(false);
    }
  );

  it("keeps authored zoom-15 sizes and applies the shared curve to ground PNGs", () => {
    const expected = (zoom: number) => Math.max(
      0.25,
      2 ** ((zoom - 15) * 0.70389327891398)
    );
    expect(expected(10)).toBe(0.25);
    expect(expected(15.1)).toBeCloseTo(1.05, 12);
    expect(expected(15.2)).toBeCloseTo(1.1025, 12);
    expect(expected(16.5)).toBeCloseTo(2.0789281794113688);
    for (const presentation of [
      WORLD_PNG_PRESENTATION.manor,
      WORLD_PNG_PRESENTATION.furnace,
      WORLD_PNG_PRESENTATION.atlasShrine,
      WORLD_PNG_PRESENTATION.cityStructures.city_house,
      WORLD_PNG_PRESENTATION.loom,
      WORLD_PNG_PRESENTATION.tannery,
      WORLD_PNG_PRESENTATION.cityStructures.cistern_warrens
    ]) {
      expect(worldPngDimensionsForZoom(presentation, 15)).toEqual({
        width: presentation.width,
        height: presentation.height
      });
      expect(worldPngDimensionsForZoom(presentation, 10).height / presentation.height)
        .toBeCloseTo(expected(10));
      expect(worldPngDimensionsForZoom(presentation, 15.1).height / presentation.height)
        .toBeCloseTo(expected(15.1));
      expect(worldPngDimensionsForZoom(presentation, 15.2).height /
        worldPngDimensionsForZoom(presentation, 15.1).height).toBeCloseTo(1.05, 12);
      expect(worldPngDimensionsForZoom(presentation, 16.5).height / presentation.height)
        .toBeCloseTo(expected(16.5));
    }
  });

  it("keeps world buildings zoom-scaled while UI feedback and map destinations stay fixed", () => {
    expect(WORLD_PNG_PRESENTATION.tannery.zoomStrength).toBe(0.70389327891398);
    expect(WORLD_PNG_PRESENTATION.loom.zoomStrength).toBe(0.70389327891398);
    expect(WORLD_PNG_PRESENTATION.loom.source).toBe("WORLD_PNG_PRESENTATION.loom");
    expect(WORLD_PNG_PRESENTATION.loom).not.toBe(WORLD_PNG_PRESENTATION.tannery);
    expect(WORLD_PNG_PRESENTATION.cityStructures.cistern_warrens.zoomStrength)
      .toBe(0.70389327891398);
    expect(WORLD_PNG_PRESENTATION.resinGain).not.toHaveProperty("zoomStrength");
    expect(WORLD_PNG_PRESENTATION.worldMapManor).not.toHaveProperty("zoomStrength");
    expect(WORLD_PNG_PRESENTATION.worldMapCity).not.toHaveProperty("zoomStrength");
    expect(WORLD_PNG_PRESENTATION.atlasShrine.zoomStrength).toBe(0.70389327891398);
    expect(WORLD_PNG_PRESENTATION.atlasShrine.maxHeightPx).toBeNull();
  });

  it("matches settled fixed-ground size during a frozen live transform", () => {
    const fixedPresentation = WORLD_PNG_PRESENTATION.manor;
    const presentation = scaledSpritePresentation(fixedPresentation);
    const committedZoom = 15;
    const currentZoom = 16.5;
    const parentScale = 2 ** (currentZoom - committedZoom);
    const committedScale = 1;
    const correctedScale = staticSpriteLocalScaleDuringTransform(
      committedScale,
      parentScale,
      currentZoom,
      committedZoom,
      presentation
    );

    expect(fixedPresentation.height * correctedScale * parentScale).toBeCloseTo(
      worldPngDimensionsForZoom(fixedPresentation, currentZoom).height
    );
    expect(8 * correctedScale * parentScale).toBeCloseTo(
      8 * worldPngScaleForZoom(fixedPresentation, currentZoom)
    );
  });

  it("scales all world art, including the player, flag and buoy", () => {
    setWorldPngMasterScalePreview(2);
    try {
      expect(spriteHeightForZoom(15, 15, SPRITE_PRESENTATION.deer))
        .toBe(SPRITE_PRESENTATION.deer.baseHeightPx * 2);
      expect(spriteHeightForZoom(15, 15, SPRITE_PRESENTATION.kingdomSeat))
        .toBe(SPRITE_PRESENTATION.kingdomSeat.baseHeightPx * 2);
      expect(spriteHeightForZoom(15, 15, SPRITE_PRESENTATION.player))
        .toBe(SPRITE_PRESENTATION.player.baseHeightPx * 2);
      expect(spriteHeightForZoom(15, 15, SPRITE_PRESENTATION.flag))
        .toBe(SPRITE_PRESENTATION.flag.baseHeightPx * 2);
      expect(spriteHeightForZoom(15, 15, SPRITE_PRESENTATION.buoy))
        .toBe(SPRITE_PRESENTATION.buoy.baseHeightPx * 2);
      expect(worldPngDimensionsForZoom(WORLD_PNG_PRESENTATION.manor, 15).height)
        .toBe(WORLD_PNG_PRESENTATION.manor.height * 2);
      expect(worldPngDimensionsForZoom(WORLD_PNG_PRESENTATION.atlasShrine, 15).height)
        .toBe(WORLD_PNG_PRESENTATION.atlasShrine.height * 2);
      expect(fixedWorldPngDimensions(WORLD_PNG_PRESENTATION.worldMapAtlasShrine).height)
        .toBe(WORLD_PNG_PRESENTATION.worldMapAtlasShrine.height * 2);
      expect(fixedWorldPngDimensions(WORLD_PNG_PRESENTATION.resinGain).width)
        .toBe(WORLD_PNG_PRESENTATION.resinGain.width * 2);
      const cityHit = worldPngInteractionHitBox({
        x: 0,
        y: 0,
        zoom: 15,
        presentation: WORLD_PNG_PRESENTATION.city
      });
      const shrineHit = worldPngInteractionHitBox({
        x: 0,
        y: 0,
        zoom: 15,
        presentation: WORLD_PNG_PRESENTATION.atlasShrine
      });
      expect(cityHit.shape === "circle" ? cityHit.radius : 0)
        .toBe(WORLD_PNG_PRESENTATION.city.hitGeometry.shape === "circle"
          ? WORLD_PNG_PRESENTATION.city.hitGeometry.radiusPx * 2
          : 0);
      expect(shrineHit.shape === "circle" ? shrineHit.radius : 0)
        .toBe(WORLD_PNG_PRESENTATION.atlasShrine.hitGeometry.shape === "circle"
          ? WORLD_PNG_PRESENTATION.atlasShrine.hitGeometry.radiusPx * 2
          : 0);
    } finally {
      setWorldPngMasterScalePreview(null);
    }
  });
});

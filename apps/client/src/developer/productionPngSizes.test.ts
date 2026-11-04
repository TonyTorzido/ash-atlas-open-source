import { setWorldPngMasterScalePreview } from "../map/worldPngMasterScale.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MAP_ZOOM } from "../map/mapZoomConfig.js";
import { SPRITE_PRESENTATION, spriteHeightForZoom } from "../map/spritePresentation.js";
import { WORLD_PNG_PRESENTATION } from "../map/worldPngPresentation.js";
import { DEV_PNG_ASSETS, type DevPngAsset } from "./devPngCatalog.js";
import { DevPngLabController } from "./devPngLabController.js";
import { calculateDevPngSize } from "./devPngSizing.js";

const TARGETS = [
  target("Giving Tree", "World Resource", "zoom-scaled", 86.4, 86.4, 0.888),
  target("Ogre", "World Mob", "zoom-scaled", 67.2, 67.2, 0.90727454977531),
  target("Deer", "World Mob", "zoom-scaled", 69.5, 69.5, 0.85),
  target("Wolf", "World Mob", "zoom-scaled", 65.4, 65.4, 0.89),
  target("Atlas Shrine", "World Flag Upgrade", "zoom-scaled", 44, 44, 0.7709466959157933),
  target("City House", "World City Facility", "zoom-scaled", 62, 77.5, 0.7397486496791824),
  target("City Warehouse", "World City Facility", "zoom-scaled", 90, 90, 0.7195493142867025),
  target("Cistern Warrens", "World City Facility", "zoom-scaled", 84.7, 56.5, 0.7871025779411616),
  target("City Salon", "World City Facility", "zoom-scaled", 61.9, 61.9, 0.7531968700369506),
  target("City Kennel", "World City Facility", "zoom-scaled", 87.2, 91.8, 0.6848224804382121),
  target("City Market", "World City Facility", "zoom-scaled", 88.2, 58.8, 0.6199870042398438),
  target("Oil Well", "World City Facility", "zoom-scaled", 60, 60, 0.641),
  target("Mining Monument", "World City Facility", "zoom-scaled", 66, 66, 0.6715332864443002),
  target("Forestry Monument", "World City Facility", "zoom-scaled", 66, 66, 0.6715332864443002),
  target("Hunting Monument", "World City Facility", "zoom-scaled", 66, 68.73881204231081, 0.8063800575824432),
  target("Tannery", "World Tannery", "zoom-scaled", 64, 64, 0.6941156750160197),
  target("City Hall", "World City Hall", "zoom-scaled", 87.7, 87.7, 0.7842975020090887),
  target("Castle", "World Map Destination", "fixed", 62, 62, 0.5),
  target("Mayor House", "World City Facility", "zoom-scaled", 61.2, 61.2, 0.7506125809213451)
] as const;

// Exercise authored dimensions independently of the production master multiplier.
beforeEach(() => { setWorldPngMasterScalePreview(1); });
afterEach(() => { setWorldPngMasterScalePreview(null); });

describe("final production PNG sizes", () => {
  it("bases requested scales on intrinsic source PNG dimensions", () => {
    const requested = [
      originalTarget("Coal Mine", "World Resource", "zoom-scaled", 1254, 1254, 87.8 / 1254, 0.6945400593854144),
      originalTarget("Iron Mine", "World Resource", "zoom-scaled", 1254, 1254, 87.8 / 1254, 0.6534282474917676),
      originalTarget("Stone Mine", "World Resource", "zoom-scaled", 1536, 1024, 87.8 / 1024, 0.658567796630188),
      originalTarget("Manor", "World Manor", "zoom-scaled", 1254, 1254, 75.2 / 1254, 1),
      originalTarget("Furnace", "World Furnace", "zoom-scaled", 1254, 1254, 58.6 / 1254, 0.8320641350555037),
      originalTarget("Willow", "World Resource", "zoom-scaled", 1254, 1254, 113.8 / 1254, 0.7902503938251205),
      originalTarget("Chinese Pistache", "World Resource", "zoom-scaled", 1254, 1254, 81.5 / 1254, 0.888)
    ] as const;

    for (const expected of requested) {
      const asset = requestedAsset(expected.label, expected.usageLabel);
      const size = calculateDevPngSize(
        asset,
        { width: expected.originalWidth, height: expected.originalHeight },
        DEFAULT_MAP_ZOOM,
        1
      );
      expect(asset.productionSize?.kind).toBe(expected.kind);
      expect(asset.anchor.y).toBe(expected.anchorY);
      expect(size.width).toBeCloseTo(expected.originalWidth * expected.multiplier);
      expect(size.height).toBeCloseTo(expected.originalHeight * expected.multiplier);
    }
  });

  it("resolves the requested usages to their production values and anchors", () => {
    expect(TARGETS).toHaveLength(19);

    for (const expected of TARGETS) {
      const asset = requestedAsset(expected.label, expected.usageLabel);
      expect(asset.productionSize?.kind).toBe(expected.kind);
      expect(asset.anchor.y).toBe(expected.anchorY);
      const size = calculateDevPngSize(
        asset,
        { width: expected.width, height: expected.height },
        DEFAULT_MAP_ZOOM,
        1
      );
      expect(size.width).toBeCloseTo(expected.width);
      expect(size.height).toBeCloseTo(expected.height);
    }
  });

  it("preserves zoom behavior around the intrinsic-size-based defaults", () => {
    expectZoomScale("stoneMine", 1024, 87.8 / 1024, 0.25);
    expectZoomScale("coalMine", 1254, 87.8 / 1254, 0.25);
    expectZoomScale("ironMine", 1254, 87.8 / 1254, 0.25);
    expectZoomScale("willowTree", 1254, 113.8 / 1254, 0.25);
    expectZoomScale("chinesePistache", 1254, 81.5 / 1254, 0.25);

    for (const key of ["stoneMine", "coalMine", "ironMine", "willowTree", "chinesePistache"] as const) {
      const presentation = SPRITE_PRESENTATION[key];
      expect(spriteHeightForZoom(DEFAULT_MAP_ZOOM - 0.5, DEFAULT_MAP_ZOOM, presentation))
        .toBeLessThan(presentation.baseHeightPx);
      expect(spriteHeightForZoom(DEFAULT_MAP_ZOOM + 0.5, DEFAULT_MAP_ZOOM, presentation))
        .toBeGreaterThan(presentation.baseHeightPx);
    }
  });

  it("keeps fixed production rendering and PNG Lab on one shared authority", () => {
    expect(WORLD_PNG_PRESENTATION.atlasShrine.width).toBe(44);
    expect(WORLD_PNG_PRESENTATION.city.width).toBe(186);
    expect(WORLD_PNG_PRESENTATION.manor.width).toBe(75.2);
    expect(WORLD_PNG_PRESENTATION.furnace.width).toBe(58.6);
    expect(WORLD_PNG_PRESENTATION.cityStructures.oil_well.width).toBe(60);
    expect(WORLD_PNG_PRESENTATION.worldMapAtlasShrine.width).toBe(40);
    expect(WORLD_PNG_PRESENTATION.worldMapManor.width).toBe(42);
    expect(WORLD_PNG_PRESENTATION.worldMapCity.width).toBe(50);
    expect(WORLD_PNG_PRESENTATION.worldMapKingdom.width).toBe(62);
    expect(Object.fromEntries(
      Object.entries(WORLD_PNG_PRESENTATION.cityStructures)
        .map(([key, value]) => [key, value.width])
    )).toEqual({
      city_house: 62,
      mayor_house: 61.2,
      oil_well: 60,
      warehouse: 90,
      cistern_warrens: 84.7,
      salon: 61.9,
      city_kennel: 87.2,
      market: 88.2,
      barracks: 80,
      armory: 80,
      siege_workshop: 80,
      powder_works: 80,
      demolition_factory: 80,
      goblin_market: 81.4,
      monument_mining: 66,
      monument_forestry: 66,
      monument_hunting: 66
    });
  });

  it("resets local sizing to the new production value without applying a factor twice", () => {
    const asset = requestedAsset("Stone Mine", "World Resource");
    const controller = new DevPngLabController();
    controller.selectAsset(asset.id);
    controller.setNextMultiplier(0.7);
    controller.setNextMultiplier(1);

    expect(controller.getSnapshot().nextMultiplier).toBe(1);
    const productionSize = calculateDevPngSize(
      asset,
      { width: 1536, height: 1024 },
      DEFAULT_MAP_ZOOM,
      1
    );
    expect(productionSize.width).toBeCloseTo(131.7);
    expect(productionSize.height).toBeCloseTo(87.8);
    const doubledSize = calculateDevPngSize(
      asset,
      { width: 1536, height: 1024 },
      DEFAULT_MAP_ZOOM,
      2
    );
    expect(doubledSize.width).toBeCloseTo(263.4);
    expect(doubledSize.height).toBeCloseTo(175.6);

    const shrine = requestedAsset("Atlas Shrine", "World Flag Upgrade");
    controller.selectAsset(shrine.id);
    controller.setNextMultiplier(2);
    controller.setNextMultiplier(1);
    expect(calculateDevPngSize(shrine, { width: 44, height: 44 }, DEFAULT_MAP_ZOOM, 1))
      .toMatchObject({ width: 44, height: 44 });
  });

  it("uses the reference mob size while leaving alternate usages and unrelated families unchanged", () => {
    const sapCrawler = requestedAsset("Resin Crawler", "World Mob");
    expect(sapCrawler.productionSize).toMatchObject({
      kind: "zoom-scaled",
      presentation: {
        baseHeightPx: 54.6,
        minHeightPx: 13.65,
        maxHeightPx: null,
        anchorY: 0.836,
        hitGeometry: {
          shape: "rectangle",
          centerX: 0.5,
          centerY: 0.646,
          width: 0.516,
          height: 0.544
        }
      }
    });
    expect(requestedAsset("Dog Adult", "Adult World Companion").productionSize)
      .toMatchObject({ kind: "zoom-scaled", presentation: SPRITE_PRESENTATION.dog });
    expect(requestedAsset("Dog Baby", "Pets Puppy / Young Profile").productionSize)
      .toMatchObject({ kind: "fixed", width: 64, height: 64 });
    expect(requestedAsset("Dog Elder", "Pets Elder Profile").productionSize)
      .toMatchObject({ kind: "fixed", width: 64, height: 64 });
    expect(requestedAsset("City", "World Map Destination").productionSize)
      .toMatchObject({ kind: "fixed", width: 50, height: 50 });
    expect(requestedAsset("Atlas Shrine", "World Map Destination").productionSize)
      .toMatchObject({ kind: "fixed", width: 40, height: 40 });
    expect(SPRITE_PRESENTATION.stone.baseHeightPx).toBe(28);
    expect(SPRITE_PRESENTATION.wood.baseHeightPx).toBe(28);
    expect(SPRITE_PRESENTATION.leather.baseHeightPx).toBe(28);
    expect(WORLD_PNG_PRESENTATION.resinGain.width).toBe(20);
  });
});

function target(
  label: string,
  usageLabel: string,
  kind: "fixed" | "zoom-scaled",
  width: number,
  height: number,
  anchorY: number
) {
  return { label, usageLabel, kind, width, height, anchorY };
}

function originalTarget(
  label: string,
  usageLabel: string,
  kind: "fixed" | "zoom-scaled",
  originalWidth: number,
  originalHeight: number,
  multiplier: number,
  anchorY: number
) {
  return { label, usageLabel, kind, originalWidth, originalHeight, multiplier, anchorY };
}

function requestedAsset(label: string, usageLabel: string): DevPngAsset {
  const asset = DEV_PNG_ASSETS.find((entry) =>
    entry.label === label && entry.usageLabel === usageLabel
  );
  expect(asset, `${label} — ${usageLabel}`).toBeDefined();
  return asset!;
}

function expectZoomScale(
  key: "stoneMine" | "coalMine" | "ironMine" | "willowTree" | "chinesePistache",
  originalHeight: number,
  factor: number,
  minRatio: number
): void {
  const presentation = SPRITE_PRESENTATION[key];
  expect(presentation.baseHeightPx).toBeCloseTo(originalHeight * factor);
  expect(presentation.minHeightPx).toBeCloseTo(originalHeight * factor * minRatio);
  expect(presentation.maxHeightPx).toBeNull();
}

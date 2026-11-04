import { describe, expect, it } from "vitest";

import {
  RUNTIME_PNG_WORLD_OBJECT_FIXED_KEYS,
  RUNTIME_PNG_PRESENTATION_CATALOG,
  RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX,
  RUNTIME_PNG_ITEM_INVENTORY_FRAME_PX,
  WORLD_OBJECT_ZOOM_POLICY,
  isRuntimePngWorldObjectFixedKey,
  isRuntimePngMasterScaleEligible,
  parseRuntimePngPresentationCatalog,
  runtimePngItemDisplayScale,
  runtimePngItemGroundHitGeometry,
  runtimePngItemGroundVisualHeight,
  runtimePngItemPresentation,
  runtimePngItemPresentationKey
} from "./runtimePngPresentation.js";

describe("runtime PNG presentation geometry", () => {
  it("keeps item context frames on the shared cross-device contract", () => {
    expect(RUNTIME_PNG_ITEM_INVENTORY_FRAME_PX).toBe(34);
  });

  it("accepts the canonical circle and rectangle geometry", () => {
    expect(parseRuntimePngPresentationCatalog(RUNTIME_PNG_PRESENTATION_CATALOG))
      .toEqual(RUNTIME_PNG_PRESENTATION_CATALOG);
  });

  it("applies one authoritative zoom curve to every runtime sprite family", () => {
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.schemaVersion).toBe(4);
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.revision).toBe(98);
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.masterScale).toBe(0.8);
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.fixed).toMatchObject({
      "cityStructures.goblin_market": {
        width: 81.4,
        height: 81.4,
        anchorX: 0.4414086695134354,
        anchorY: 0.6925709301513856
      },
      "cityStructures.monument_mining": { width: 66, height: 66 },
      "cityStructures.monument_forestry": { width: 66, height: 66 },
      "cityStructures.monument_hunting": { width: 66, height: 68.73881204231081 }
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.city).toMatchObject({
      anchorX: 0.3852997298075309,
      anchorY: 0.7842975020090887
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.goblinHall).toMatchObject({
      anchorX: 0.36272984439635364,
      anchorY: 0.7338529507384846
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.goblinHall)
      .not.toEqual(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.city);
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.flax).toMatchObject({
      baseHeightPx: 54,
      horizontalScale: 1,
      anchorX: 0.5,
      anchorY: 0.94,
      hitGeometry: { shape: "rectangle", width: 0.734, height: 1.1 }
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.sulfurMine).toMatchObject({
      baseHeightPx: 50,
      anchorX: 0.6066943914776428,
      anchorY: 0.7545774758715016,
      hitGeometry: { shape: "rectangle", width: 1, height: 1 }
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.slag).toMatchObject({
      baseHeightPx: 28,
      anchorX: 0.5,
      anchorY: 0.815,
      hitGeometry: { shape: "rectangle", width: 1, height: 1 }
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.iron_bar).toMatchObject({
      baseHeightPx: RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX,
      minHeightPx: RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX * 0.25,
      anchorY: 0.815
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.sprites["militaryUnits.field_ballista.launch"])
      .toMatchObject({
        baseHeightPx: 57.1,
        minHeightPx: 14.275,
        anchorX: 0.5,
        anchorY: 1,
        hitGeometry: { shape: "rectangle", width: 1, height: 1 }
      });
    expect(WORLD_OBJECT_ZOOM_POLICY).toEqual({
      baseZoom: 15,
      zoomStrength: 0.70389327891398,
      minScale: 0.25,
      maxScale: null
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.fixed.tannery).toMatchObject({
      width: 64,
      height: 64,
      anchorX: 0.41105648300567565,
      anchorY: 0.6941156750160197
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.fixed.loom).toMatchObject({
      width: 64,
      height: 64,
      anchorX: 0.4361071833091936,
      anchorY: 0.7417826205784411,
      hitGeometry: {
        shape: "rectangle",
        centerX: 0.5109224139036008,
        centerY: 0.5086474223071392,
        width: 1,
        height: 1
      }
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.fixed.kitchen).toMatchObject({
      width: 58,
      height: 58,
      anchorX: 0.5,
      anchorY: 0.82
    });
    expect(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.buoy).toMatchObject({
      baseHeightPx: 61.5,
      minHeightPx: 15.375,
      maxHeightPx: null,
      anchorX: 0.5,
      anchorY: 39 / 41,
      hitGeometry: {
        shape: "circle",
        centerX: 0.5,
        centerY: 39 / 41,
        radiusPx: 24
      }
    });
    for (const presentation of Object.values(RUNTIME_PNG_PRESENTATION_CATALOG.sprites)) {
      expect(presentation.zoomStrength).toBe(WORLD_OBJECT_ZOOM_POLICY.zoomStrength);
      expect(presentation.minHeightPx).toBeCloseTo(
        presentation.baseHeightPx * WORLD_OBJECT_ZOOM_POLICY.minScale
      );
      expect(presentation.maxHeightPx).toBeNull();
    }
  });

  it.each([0.24, 4.01, Number.POSITIVE_INFINITY])(
    "rejects an out-of-range master scale of %s",
    (masterScale) => {
      const catalog = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
      catalog.masterScale = masterScale;
      expect(() => parseRuntimePngPresentationCatalog(catalog)).toThrow();
    }
  );

  it("applies the master scale to every world sprite including player, flag and buoy", () => {
    expect(isRuntimePngMasterScaleEligible("sprite", "player")).toBe(true);
    expect(isRuntimePngMasterScaleEligible("sprite", "flag")).toBe(true);
    expect(isRuntimePngMasterScaleEligible("sprite", "buoy")).toBe(true);
    expect(isRuntimePngMasterScaleEligible("sprite", "kingdomSeat")).toBe(true);
    expect(isRuntimePngMasterScaleEligible("fixed", "atlasShrine")).toBe(true);
    expect(isRuntimePngMasterScaleEligible("fixed", "worldMapAtlasShrine")).toBe(true);
  });

  it("resolves shared item presentation keys and keeps unknown assets safe", () => {
    expect(runtimePngItemPresentationKey("simple_food")).toBe("food");
    expect(runtimePngItemPresentationKey("freshwater_fish")).toBe("freshwater_fish");
    expect(runtimePngItemPresentationKey("ashen_fish")).toBe("freshwater_fish");
    expect(runtimePngItemPresentationKey("fishing_rod")).toBe("fishing_rod");
    expect(runtimePngItemPresentationKey("sulfur")).toBe("sulfur");
    expect(runtimePngItemPresentationKey("squid_meat")).toBe("generic");
    expect(runtimePngItemPresentationKey("cloth")).toBe("cloth");
    expect(runtimePngItemPresentation("frog_legs")?.baseHeightPx)
      .toBe(RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX);
    expect(runtimePngItemDisplayScale("iron_bar")).toBe(1);
    expect(runtimePngItemDisplayScale("legacy_item_without_metadata")).toBe(1);
  });

  it("keeps inventory overrides separate while projecting one ground size to indoor player units", () => {
    const catalog = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    catalog.sprites.iron_bar!.inventoryHeightPx = 14;
    const item = parseRuntimePngPresentationCatalog(catalog).sprites.iron_bar!;

    expect(item.baseHeightPx).toBe(28);
    expect(item.inventoryHeightPx).toBe(14);
    expect(runtimePngItemGroundVisualHeight(item.baseHeightPx, 70)).toBe(70);
    expect(runtimePngItemGroundVisualHeight(56, 70)).toBe(140);
    expect(runtimePngItemGroundHitGeometry(item)).toEqual({
      shape: "rectangle",
      centerX: 0.5,
      centerY: 0.5,
      width: 1,
      height: 1
    });

    const custom = { ...item, hitGeometryMode: "custom" as const };
    expect(runtimePngItemGroundHitGeometry(custom)).toBe(item.hitGeometry);
  });

  it("keeps persistent world buildings on the shared zoom presentation contract", () => {
    expect(RUNTIME_PNG_WORLD_OBJECT_FIXED_KEYS).toContain("tannery");
    expect(RUNTIME_PNG_WORLD_OBJECT_FIXED_KEYS).toContain("loom");
    expect(RUNTIME_PNG_WORLD_OBJECT_FIXED_KEYS).toContain("kitchen");
    expect(RUNTIME_PNG_WORLD_OBJECT_FIXED_KEYS).toContain("cityStructures.cistern_warrens");
    expect(RUNTIME_PNG_WORLD_OBJECT_FIXED_KEYS).not.toContain("worldMapCity");
    expect(RUNTIME_PNG_WORLD_OBJECT_FIXED_KEYS.every((key) => key in RUNTIME_PNG_PRESENTATION_CATALOG.fixed))
      .toBe(true);
    expect(isRuntimePngWorldObjectFixedKey("tannery")).toBe(true);
    expect(isRuntimePngWorldObjectFixedKey("loom")).toBe(true);
    expect(isRuntimePngWorldObjectFixedKey("worldMapCity")).toBe(false);
  });

  it("rejects sprite zoom values that diverge from the checked-in policy", () => {
    const catalog = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    catalog.sprites.tree!.zoomStrength = 0.1;
    expect(() => parseRuntimePngPresentationCatalog(catalog)).toThrow(
      /Zoom strength must follow the world-object zoom policy/u
    );

    const capped = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    capped.sprites.tree!.maxHeightPx = capped.sprites.tree!.baseHeightPx * 1.1;
    expect(() => parseRuntimePngPresentationCatalog(capped)).toThrow(
      /Maximum height must follow the world-object zoom policy/u
    );
  });

  it("preserves validation for a future numeric upper scale", () => {
    const catalog = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    catalog.worldObjectZoomPolicy.maxScale = 1.1;
    for (const presentation of Object.values(catalog.sprites)) {
      presentation.maxHeightPx = presentation.baseHeightPx * 1.1;
    }
    expect(parseRuntimePngPresentationCatalog(catalog)).toEqual(catalog);

    catalog.sprites.tree!.maxHeightPx = null;
    expect(() => parseRuntimePngPresentationCatalog(catalog)).toThrow(
      /Maximum height must follow the world-object zoom policy/u
    );
  });

  it("accepts legacy sprites without horizontal scale and rejects non-positive stretch", () => {
    const legacy = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    delete legacy.sprites.dog!.horizontalScale;
    expect(parseRuntimePngPresentationCatalog(legacy).sprites.dog?.horizontalScale)
      .toBeUndefined();

    const invalid = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    invalid.sprites.dog!.horizontalScale = 0;
    expect(() => parseRuntimePngPresentationCatalog(invalid)).toThrow();
  });

  it.each([
    { path: "center", patch: { centerX: 3 } },
    { path: "radius", patch: { radiusPx: 0 } },
    { path: "rectangle width", patch: { shape: "rectangle", width: 5, height: 1 } }
  ])("rejects unsafe $path geometry", ({ patch }) => {
    const catalog = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    const player = catalog.sprites.player!;
    player.hitGeometry = {
      ...player.hitGeometry,
      ...patch
    } as typeof player.hitGeometry;
    expect(() => parseRuntimePngPresentationCatalog(catalog)).toThrow();
  });
});

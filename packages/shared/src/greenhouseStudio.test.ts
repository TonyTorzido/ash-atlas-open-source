import { describe, expect, it } from "vitest";

import {
  GREENHOUSE_STUDIO_CATALOG,
  GREENHOUSE_WATER_STORAGE_ANCHOR_ID,
  GREENHOUSE_WATER_STORAGE_ART_ID,
  parseGreenhouseStudioCatalog,
  serializeGreenhouseStudioCatalog,
  greenhousePlacementIssue,
  resolveGreenhousePlacementPosition,
  greenhouseTemplateFootprint,
  greenhouseTemplateTouchContainsPoint,
  greenhouseTemplateTouchBounds,
  greenhouseTemplateImageFrame,
  greenhousePlantStageArtFrame
} from "./greenhouseStudio.js";

describe("greenhouse Studio catalog", () => {
  it("migrates the original 15-anchor schema without changing stable identities", () => {
    const legacy = {
      schemaVersion: 1,
      catalogRevision: 4,
      roomId: GREENHOUSE_STUDIO_CATALOG.roomId,
      roomWidth: GREENHOUSE_STUDIO_CATALOG.roomWidth,
      roomHeight: GREENHOUSE_STUDIO_CATALOG.roomHeight,
      anchors: GREENHOUSE_STUDIO_CATALOG.anchors
    };
    const migrated = parseGreenhouseStudioCatalog(legacy);
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.waterStorage.anchorId).toBe(GREENHOUSE_WATER_STORAGE_ANCHOR_ID);
    expect(migrated.waterStorageArt.overlayId).toBe(GREENHOUSE_WATER_STORAGE_ART_ID);
    expect(migrated.anchors.map((anchor) => anchor.anchorId)).toEqual(GREENHOUSE_STUDIO_CATALOG.anchors.map((anchor) => anchor.anchorId));
    expect(migrated.geometry.templates.pot.assetPath).toContain("greenhouse-pot.png");
    expect(migrated.geometry.templates.waterTank.renderWidth).toBeGreaterThan(0);
    expect(migrated.geometry.templates.pot.pivotX).toBe(0.5);
    expect(migrated.geometry.templates.pot.pivotY).toBe(0.5);
  });

  it("rejects duplicate overlay assets and out-of-room placement", () => {
    const base = structuredClone(GREENHOUSE_STUDIO_CATALOG);
    const overlay = {
      overlayId: "greenhouse-overlay:01",
      assetPath: "apps/client/src/assets/structures/greenhouse-overlays/overlay-01.png",
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      rotationDeg: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1
    };
    expect(() => parseGreenhouseStudioCatalog({ ...base, overlays: [overlay, { ...overlay, overlayId: "greenhouse-overlay:02" }] })).toThrow(/overlay assets/i);
    expect(() => parseGreenhouseStudioCatalog({ ...base, overlays: [{ ...overlay, x: base.roomWidth - 50, width: 100 }] })).toThrow(/outside the room/i);
    expect(() => parseGreenhouseStudioCatalog({ ...base, waterStorageArt: { ...base.waterStorageArt, x: base.roomWidth - 50, width: 100 } })).toThrow(/water-storage art/i);
  });

  it("defaults legacy catalogs to a shared floor, templates, and fixed exit", () => {
    const migrated = parseGreenhouseStudioCatalog({
      schemaVersion: 2,
      catalogRevision: 5,
      roomId: GREENHOUSE_STUDIO_CATALOG.roomId,
      roomWidth: 500,
      roomHeight: 400,
      anchors: GREENHOUSE_STUDIO_CATALOG.anchors.map((anchor) => ({ ...anchor, x: Math.min(500, anchor.x), y: Math.min(400, anchor.y) })),
      waterStorage: { ...GREENHOUSE_STUDIO_CATALOG.waterStorage, x: 420, y: 300 },
      waterStorageArt: { ...GREENHOUSE_STUDIO_CATALOG.waterStorageArt, x: 340, y: 220, width: 80, height: 80 },
      overlays: []
    });
    expect(migrated.geometry.surfaces.some((surface) => surface.kind === "floor")).toBe(true);
    expect(migrated.geometry.templates.pot.templateId).toBe("pot");
    expect(migrated.geometry.exit.anchorId).toContain("greenhouse-exit");
  });

  it("shares physical placement validation while allowing touch areas to be broader", () => {
    const pot = greenhouseTemplateFootprint(GREENHOUSE_STUDIO_CATALOG, "pot", 600, 700);
    expect(pot).toHaveLength(4);
    expect(greenhousePlacementIssue(GREENHOUSE_STUDIO_CATALOG, "pot", 600, 700)).toBeNull();
    expect(greenhousePlacementIssue(GREENHOUSE_STUDIO_CATALOG, "pot", 1, 1)).toMatch(/inside the floor/i);
    expect(greenhousePlacementIssue(GREENHOUSE_STUDIO_CATALOG, "pot", 600, 700, [{ kind: "pot", x: 600, y: 700 }])).toMatch(/overlaps/i);
    const blockedCatalog = {
      ...GREENHOUSE_STUDIO_CATALOG,
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        colliders: [{ colliderId: "greenhouse-blocker:test", points: [{ x: 540, y: 640 }, { x: 660, y: 640 }, { x: 660, y: 760 }, { x: 540, y: 760 }] }]
      }
    };
    expect(greenhousePlacementIssue(blockedCatalog, "pot", 600, 700)).toMatch(/wall or blocker/i);
    const wallCatalog = {
      ...GREENHOUSE_STUDIO_CATALOG,
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        surfaces: [...GREENHOUSE_STUDIO_CATALOG.geometry.surfaces, { surfaceId: "greenhouse-wall:test", kind: "back_wall" as const, points: [{ x: 540, y: 640 }, { x: 660, y: 640 }, { x: 660, y: 760 }, { x: 540, y: 760 }] }]
      }
    };
    expect(greenhousePlacementIssue(wallCatalog, "pot", 600, 700)).toMatch(/wall or blocker/i);
  });

  it("sweeps placement previews to the first valid point and stops at occupied plots", () => {
    const blockedCatalog = {
      ...GREENHOUSE_STUDIO_CATALOG,
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        colliders: [{ colliderId: "greenhouse-blocker:test", points: [{ x: 690, y: 620 }, { x: 790, y: 620 }, { x: 790, y: 780 }, { x: 690, y: 780 }] }]
      }
    };
    const resolved = resolveGreenhousePlacementPosition(blockedCatalog, "pot", { x: 900, y: 700 }, [], { x: 600, y: 700 });
    expect(resolved).not.toBeNull();
    expect(resolved!.x).toBeLessThan(690);
    expect(greenhousePlacementIssue(blockedCatalog, "pot", resolved!.x, resolved!.y)).toBeNull();
    const movedAway = resolveGreenhousePlacementPosition(blockedCatalog, "pot", { x: 400, y: 700 }, [], { x: resolved!.x, y: resolved!.y });
    expect(movedAway).not.toBeNull();
    expect(movedAway!.x).toBeCloseTo(400, 0);

    const angled = {
      ...GREENHOUSE_STUDIO_CATALOG,
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        colliders: [{ colliderId: "greenhouse-blocker:angled", points: [{ x: 680, y: 450 }, { x: 760, y: 500 }, { x: 680, y: 550 }, { x: 640, y: 500 }] }]
      }
    };
    const slid = resolveGreenhousePlacementPosition(angled, "pot", { x: 900, y: 300 }, [], { x: 500, y: 700 });
    expect(slid).not.toBeNull();
    expect(greenhousePlacementIssue(angled, "pot", slid!.x, slid!.y)).toBeNull();
    expect(Math.hypot(slid!.x - 500, slid!.y - 700)).toBeGreaterThan(1);

    const occupied = resolveGreenhousePlacementPosition(GREENHOUSE_STUDIO_CATALOG, "pot", { x: 700, y: 700 }, [{ kind: "pot", x: 700, y: 700 }]);
    expect(occupied).not.toBeNull();
    expect(greenhousePlacementIssue(GREENHOUSE_STUDIO_CATALOG, "pot", occupied!.x, occupied!.y, [{ kind: "pot", x: 700, y: 700 }])).toBeNull();

    const concaveFloor = {
      ...GREENHOUSE_STUDIO_CATALOG,
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        surfaces: [{ surfaceId: "floor:l", kind: "floor" as const, points: [{ x: 0, y: 0 }, { x: 1_000, y: 0 }, { x: 1_000, y: 500 }, { x: 500, y: 500 }, { x: 500, y: 1_000 }, { x: 0, y: 1_000 }] }],
        colliders: []
      }
    };
    const concaveResolved = resolveGreenhousePlacementPosition(concaveFloor, "pot", { x: 700, y: 300 }, [], { x: 300, y: 700 });
    expect(concaveResolved).not.toBeNull();
    expect(greenhousePlacementIssue(concaveFloor, "pot", concaveResolved!.x, concaveResolved!.y)).toBeNull();

    const noSpace = {
      ...GREENHOUSE_STUDIO_CATALOG,
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        colliders: [{ colliderId: "greenhouse-blocker:all", points: [{ x: -10, y: -10 }, { x: 2_000, y: -10 }, { x: 2_000, y: 2_000 }, { x: -10, y: 2_000 }] }]
      }
    };
    expect(resolveGreenhousePlacementPosition(noSpace, "pot", { x: 600, y: 700 }, [])).toBeNull();
  });

  it("publishes v4 templates without legacy room-positioned objects", () => {
    const serialized = serializeGreenhouseStudioCatalog(GREENHOUSE_STUDIO_CATALOG);
    expect(serialized.schemaVersion).toBe(4);
    expect(serialized).not.toHaveProperty("anchors");
    expect(serialized).not.toHaveProperty("waterStorage");
    expect(serialized).not.toHaveProperty("waterStorageArt");
    expect((serialized.geometry as { templates: { pot: { assetPath: string } } }).templates.pot.assetPath).toContain("greenhouse-pot.png");
  });

  it("uses the authored touch shape independently from physical placement", () => {
    expect(greenhouseTemplateTouchContainsPoint(GREENHOUSE_STUDIO_CATALOG, "pot", 300, 300, 300, 300)).toBe(true);
    expect(greenhouseTemplateTouchContainsPoint(GREENHOUSE_STUDIO_CATALOG, "pot", 300, 300, 390, 390)).toBe(false);
    const rectangleCatalog = {
      ...GREENHOUSE_STUDIO_CATALOG,
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        templates: {
          ...GREENHOUSE_STUDIO_CATALOG.geometry.templates,
          pot: {
            ...GREENHOUSE_STUDIO_CATALOG.geometry.templates.pot,
            touchArea: { kind: "polygon" as const, points: [{ x: -40, y: -20 }, { x: 40, y: -20 }, { x: 40, y: 20 }, { x: -40, y: 20 }] }
          }
        }
      }
    };
    expect(greenhouseTemplateTouchContainsPoint(rectangleCatalog, "pot", 300, 300, 335, 315)).toBe(true);
    expect(greenhouseTemplateTouchContainsPoint(rectangleCatalog, "pot", 300, 300, 345, 325)).toBe(false);
  });

  it("centers the physical footprint on the rendered image frame with an off-center pivot", () => {
    const catalog = {
      ...structuredClone(GREENHOUSE_STUDIO_CATALOG),
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        templates: {
          ...GREENHOUSE_STUDIO_CATALOG.geometry.templates,
          pot: {
            ...GREENHOUSE_STUDIO_CATALOG.geometry.templates.pot,
            renderWidth: 96,
            renderHeight: 72,
            pivotX: 0.25,
            pivotY: 0.75,
            physicalFootprint: [{ x: -28, y: -20 }, { x: 28, y: -20 }, { x: 28, y: 20 }, { x: -28, y: 20 }]
          }
        }
      }
    };
    expect(greenhouseTemplateImageFrame(catalog, "pot", 300, 300)).toEqual({
      x: 276,
      y: 246,
      width: 96,
      height: 72
    });
    expect(greenhouseTemplateFootprint(catalog, "pot", 300, 300)).toEqual([
      { x: 296, y: 262 },
      { x: 352, y: 262 },
      { x: 352, y: 302 },
      { x: 296, y: 302 }
    ]);
  });

  it.each(["pot", "water_tank"] as const)("keeps %s footprint growth symmetric around its non-square image frame", (kind) => {
    const catalog = structuredClone(GREENHOUSE_STUDIO_CATALOG);
    const template = kind === "pot" ? catalog.geometry.templates.pot : catalog.geometry.templates.waterTank;
    Object.assign(template, { renderWidth: 96, renderHeight: 72, pivotX: 0.2, pivotY: 0.8 });
    const touchBefore = greenhouseTemplateTouchBounds(catalog, kind, 300, 300);
    for (const [width, height] of [[56, 109], [180, 30], [220, 200]] as const) {
      Object.assign(template, { physicalFootprint: [
        { x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 },
        { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }
      ] });
      const frame = greenhouseTemplateImageFrame(catalog, kind, 300, 300);
      const points = greenhouseTemplateFootprint(catalog, kind, 300, 300);
      const minX = Math.min(...points.map((point) => point.x));
      const maxX = Math.max(...points.map((point) => point.x));
      const minY = Math.min(...points.map((point) => point.y));
      const maxY = Math.max(...points.map((point) => point.y));
      expect((minX + maxX) / 2).toBeCloseTo(frame.x + frame.width / 2);
      expect((minY + maxY) / 2).toBeCloseTo(frame.y + frame.height / 2);
      expect(maxX - minX).toBeCloseTo(width);
      expect(maxY - minY).toBeCloseTo(height);
      expect(greenhouseTemplateTouchBounds(catalog, kind, 300, 300)).toEqual(touchBefore);
    }
  });

  it("keeps physical footprints centered when legacy points or dimensions are offset", () => {
    const parsed = parseGreenhouseStudioCatalog({
      ...serializeGreenhouseStudioCatalog(GREENHOUSE_STUDIO_CATALOG),
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        templates: {
          ...GREENHOUSE_STUDIO_CATALOG.geometry.templates,
          pot: {
            ...GREENHOUSE_STUDIO_CATALOG.geometry.templates.pot,
            pivotX: 0.5,
            pivotY: 0.5,
            physicalFootprint: [{ x: 0, y: 10 }, { x: 80, y: 10 }, { x: 80, y: 50 }, { x: 0, y: 50 }]
          }
        }
      }
    });
    expect(parsed.geometry.templates.pot.physicalFootprint).toEqual([
      { x: -40, y: -20 }, { x: 40, y: -20 }, { x: 40, y: 20 }, { x: -40, y: 20 }
    ]);
    const footprint = greenhouseTemplateFootprint(parsed, "pot", 300, 300);
    const xs = footprint.map((point) => point.x);
    const ys = footprint.map((point) => point.y);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBe(300);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBe(300);
    const unparsedCatalog = {
      ...GREENHOUSE_STUDIO_CATALOG,
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        templates: {
          ...GREENHOUSE_STUDIO_CATALOG.geometry.templates,
          pot: {
            ...GREENHOUSE_STUDIO_CATALOG.geometry.templates.pot,
            pivotX: 0.5,
            pivotY: 0.5,
            physicalFootprint: [{ x: 5, y: 5 }, { x: 65, y: 5 }, { x: 65, y: 35 }, { x: 5, y: 35 }]
          }
        }
      }
    };
    const directFootprint = greenhouseTemplateFootprint(unparsedCatalog, "pot", 300, 300);
    expect((Math.min(...directFootprint.map((point) => point.x)) + Math.max(...directFootprint.map((point) => point.x))) / 2).toBe(300);
    expect((Math.min(...directFootprint.map((point) => point.y)) + Math.max(...directFootprint.map((point) => point.y))) / 2).toBe(300);
  });

  it("rejects an image pivot outside normalized PNG coordinates", () => {
    expect(() => parseGreenhouseStudioCatalog({
      ...GREENHOUSE_STUDIO_CATALOG,
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        templates: {
          ...GREENHOUSE_STUDIO_CATALOG.geometry.templates,
          pot: { ...GREENHOUSE_STUDIO_CATALOG.geometry.templates.pot, pivotX: 1.1 }
        }
      }
    })).toThrow(/image pivot/i);
  });

  it("defaults four stage images and resolves authored frames from the Farm Plot anchor", () => {
    const wheatStageArt = GREENHOUSE_STUDIO_CATALOG.geometry.stageArt.filter((stage) => stage.cropId === "wheat");
    expect(wheatStageArt).toHaveLength(4);
    expect(wheatStageArt.map((stage) => stage.artId)).toEqual([
      "wheat_seedling", "wheat_middle_2", "wheat_middle_3", "wheat_full"
    ]);
    expect(GREENHOUSE_STUDIO_CATALOG.geometry.stageArt.filter((stage) => stage.cropId === "giving_berry_tree")).toHaveLength(4);
    const plot = GREENHOUSE_STUDIO_CATALOG.geometry.templates.pot;
    const art = { ...wheatStageArt[0]!, pivotX: 0.25, pivotY: 0.75, offsetX: 10, offsetY: -5, scale: 0.5 };
    const frame = greenhousePlantStageArtFrame(GREENHOUSE_STUDIO_CATALOG, art, 300, 400);
    expect(frame).toEqual({
      x: 300 + 10 - plot.renderWidth * 0.5 * 0.25,
      y: 400 - 5 - plot.renderHeight * 0.5 * 0.75,
      width: plot.renderWidth * 0.5,
      height: plot.renderHeight * 0.5
    });
  });
});

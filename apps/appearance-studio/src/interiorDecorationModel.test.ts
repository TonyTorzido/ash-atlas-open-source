import { DEFAULT_MANOR_TEMPLATE_CATALOG, interiorCatalogFromLegacy } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  decorationSurfacesOf,
  decorationsAfterRoomEdit,
  manorDecorationContainmentReason,
  manorDecorationFootprintClass,
  manorDecorationFootprintInRoom,
  manorDecorationImageCornersInRoom,
  manorDecorationNeedsHorizontalMirror,
  manorDecorationPointToNormalized,
  manorDecorationTransformForImportedPng,
  manorDecorationTransformWithAnchor
} from "./interiorDecorationModel.js";
import type { InteriorDecoration } from "./interiorModules.js";

describe("interior decoration model", () => {
  it("uses the same containment rule for ground and each authored wall surface", () => {
    const room = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === "manor_lobby")!.rooms[0]!;
    const footprint = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const decoration = {
      transform: { x: 90, y: 400, width: 30, height: 120, rotationDeg: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
      footprint
    };
    const leftWall = room.placementSurfaces.find((surface) => surface.kind === "left_wall")!;
    expect(manorDecorationContainmentReason(decoration, leftWall)).toBe(null);
    expect(manorDecorationContainmentReason({ ...decoration, transform: { ...decoration.transform, x: 20 } }, leftWall)).toMatch(/left wall/u);
    expect(manorDecorationContainmentReason(decoration, null)).toMatch(/placement surface/u);
    const rightWall = room.placementSurfaces.find((surface) => surface.kind === "right_wall")!;
    expect(manorDecorationNeedsHorizontalMirror({ mirrorX: false }, leftWall)).toBe(false);
    expect(manorDecorationNeedsHorizontalMirror({ mirrorX: false }, rightWall)).toBe(true);
  });

  it("keeps the PNG frame and normalized footprint on one scaled, rotated, mirrored transform", () => {
    const decoration = {
      transform: { x: 220, y: 180, width: 80, height: 40, rotationDeg: 27, scaleX: 1.4, scaleY: 0.75, anchorX: 0.2, anchorY: 0.8 },
      footprint: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      mirrorX: true
    };
    const imageCorners = manorDecorationImageCornersInRoom(decoration, true);
    const footprint = manorDecorationFootprintInRoom(decoration, true);
    footprint.forEach((point, index) => {
      expect(point.x).toBeCloseTo(imageCorners[index]!.x, 8);
      expect(point.y).toBeCloseTo(imageCorners[index]!.y, 8);
    });
    const normalized = manorDecorationPointToNormalized(imageCorners[2]!, decoration, true);
    expect(normalized.x).toBeCloseTo(1, 8);
    expect(normalized.y).toBeCloseTo(1, 8);
  });

  it("moves a normalized anchor without moving the rendered PNG or footprint", () => {
    const decoration = {
      transform: { x: 220, y: 180, width: 80, height: 40, rotationDeg: 27, scaleX: 1.4, scaleY: 0.75, anchorX: 0.2, anchorY: 0.8 },
      footprint: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }, { x: 0.9, y: 0.8 }, { x: 0.1, y: 0.8 }],
      mirrorX: true
    };
    const before = manorDecorationFootprintInRoom(decoration, true);
    const nextTransform = manorDecorationTransformWithAnchor(decoration.transform, 0.7, 0.3, true);
    const after = manorDecorationFootprintInRoom({ ...decoration, transform: nextTransform }, true);
    after.forEach((point, index) => {
      expect(point.x).toBeCloseTo(before[index]!.x, 8);
      expect(point.y).toBeCloseTo(before[index]!.y, 8);
    });
    expect(nextTransform.anchorX).toBe(0.7);
    expect(nextTransform.anchorY).toBe(0.3);
  });

  it("uses imported PNG proportions for the default frame at unit scale", () => {
    const baseTransform = { x: 220, y: 180, width: 180, height: 120, rotationDeg: 27, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 };
    const square = manorDecorationTransformForImportedPng(baseTransform, 256, 256);
    expect(square).toMatchObject({ x: 220, y: 180, width: 120, height: 120, rotationDeg: 27, scaleX: 1, scaleY: 1 });
    const wide = manorDecorationTransformForImportedPng(baseTransform, 320, 160);
    expect([wide.width, wide.height]).toEqual([180, 90]);
  });

  it("keeps collision footprint styling red while selected noncollision geometry stays neutral", () => {
    expect(manorDecorationFootprintClass(true, false)).toBe("manor-decoration-footprint collision");
    expect(manorDecorationFootprintClass(true, true)).toBe("manor-decoration-footprint collision");
    expect(manorDecorationFootprintClass(false, true)).toBe("manor-decoration-footprint selected");
  });

  it("builds placement surfaces from a room's floors and walls", () => {
    const room = interiorCatalogFromLegacy().spaces.find((space) => space.id === "manor_lobby")!.rooms[0]!;
    const surfaces = decorationSurfacesOf(room);
    expect(surfaces.filter((surface) => surface.kind === "floor")).toHaveLength(room.floors.length);
    expect(surfaces.filter((surface) => surface.kind !== "floor")).toHaveLength(room.walls.length);
    expect(surfaces.map((surface) => surface.id)).toEqual([...room.floors, ...room.walls].map((value) => value.id));
  });

  describe("decorationsAfterRoomEdit", () => {
    const definition = (id: string, roomId = "room_a"): InteriorDecoration => ({
      id, retired: false, name: id, itemId: null, assetKey: "apps/client/src/assets/x.png", roomId, surfaceId: "floor", layer: "in_front", placementMode: "movable",
      transform: { x: 1, y: 1, width: 10, height: 10, rotationDeg: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
      footprint: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], collision: false, zIndex: 0, mirrorX: false
    });

    it("retires deleted stored ids, removes deleted draft ids, and leaves other rooms alone", () => {
      const current = [definition("stored"), definition("draft"), definition("elsewhere", "room_b")];
      const next = decorationsAfterRoomEdit(current, new Set(["stored", "elsewhere"]), "room_a", []);
      expect(next.map((value) => [value.id, value.retired])).toEqual([["stored", true], ["elsewhere", false]]);
    });

    it("replaces edited definitions in place and appends new ones", () => {
      const current = [definition("a"), definition("b")];
      const edited = { ...definition("a"), name: "Renamed" };
      const next = decorationsAfterRoomEdit(current, new Set(["a", "b"]), "room_a", [definition("b"), edited, definition("new")]);
      expect(next.map((value) => [value.id, value.name])).toEqual([["a", "Renamed"], ["b", "b"], ["new", "new"]]);
    });

    it("does not resurrect retired stored definitions", () => {
      const next = decorationsAfterRoomEdit([{ ...definition("gone"), retired: true }], new Set(["gone"]), "room_a", []);
      expect(next).toEqual([{ ...definition("gone"), retired: true }]);
    });
  });
});

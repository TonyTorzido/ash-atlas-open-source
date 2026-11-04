import {
  INVENTORY_CATALOG,
  manorPolygonContainsPolygon,
  manorPolygonGeometryIssues,
  type IndoorNavigationCollider,
  type IndoorPoint,
  type InteriorFloor,
  type InteriorWall,
  type ManorPlacementSurfaceDefinition
} from "@ash-atlas/shared";

import { clamp } from "./interiorCanvasAuthoring.js";
import type { InteriorDecoration } from "./interiorModules.js";

/**
 * Pure decoration geometry shared by the InteriorStudio Decoration Test (and
 * the legacy ManorStudio). Footprints are normalized PNG-local polygons; every
 * helper maps them through one anchored, scaled, rotated, optionally mirrored
 * transform. Browser-safe.
 */

export type ManorDecorationTransform = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
  anchorX: number;
  anchorY: number;
};

export type ManorDecorationDraft = {
  id: string;
  name: string;
  /** Null publishes a universal Manor decoration with no inventory custody. */
  itemId: string | null;
  placementMode: "permanent" | "movable";
  roomId: string;
  assetKey: string;
  sourceUrl: string | null;
  surfaceId: string;
  layer: "behind" | "in_front" | "rug";
  transform: ManorDecorationTransform;
  footprint: IndoorPoint[];
  collision: boolean;
  zIndex: number;
  /** Side-wall art is authored from the left-wall source and mirrored on the right. */
  mirrorX?: boolean;
};

export type ManorDecorationTransformable = Pick<ManorDecorationDraft, "transform" | "footprint"> &
  Partial<Pick<ManorDecorationDraft, "mirrorX">>;

/** Transform one normalized PNG-local point into room coordinates. */
function manorDecorationTransformPoint(
  point: IndoorPoint,
  transform: ManorDecorationTransform,
  mirrorX = false
): IndoorPoint {
  const radians = transform.rotationDeg * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localX = (point.x - transform.anchorX) * transform.width * transform.scaleX * (mirrorX ? -1 : 1);
  const localY = (point.y - transform.anchorY) * transform.height * transform.scaleY;
  return {
    x: transform.x + localX * cos - localY * sin,
    y: transform.y + localX * sin + localY * cos
  };
}

/** Transform a normalized custom footprint into room coordinates. */
export function manorDecorationFootprintInRoom(
  decoration: ManorDecorationTransformable,
  mirrorX = decoration.mirrorX === true
): IndoorPoint[] {
  return decoration.footprint.map((point) => manorDecorationTransformPoint(point, decoration.transform, mirrorX));
}

/** Return the transformed PNG frame corners used by the artwork and footprint editor. */
export function manorDecorationImageCornersInRoom(
  decoration: Pick<ManorDecorationDraft, "transform"> & Partial<Pick<ManorDecorationDraft, "mirrorX">>,
  mirrorX = decoration.mirrorX === true
): IndoorPoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 }
  ].map((point) => manorDecorationTransformPoint(point, decoration.transform, mirrorX));
}

/** Convert a room point back to normalized PNG-local coordinates. */
export function manorDecorationPointToNormalized(
  point: IndoorPoint,
  decoration: Pick<ManorDecorationDraft, "transform"> & Partial<Pick<ManorDecorationDraft, "mirrorX">>,
  mirrorX = decoration.mirrorX === true
): IndoorPoint {
  const transform = decoration.transform;
  const radians = transform.rotationDeg * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const deltaX = point.x - transform.x;
  const deltaY = point.y - transform.y;
  const localX = cos * deltaX + sin * deltaY;
  const localY = -sin * deltaX + cos * deltaY;
  const signedScaleX = transform.scaleX * (mirrorX ? -1 : 1);
  return {
    x: transform.anchorX + localX / (transform.width * signedScaleX),
    y: transform.anchorY + localY / (transform.height * transform.scaleY)
  };
}

/** Change a normalized anchor while keeping the rendered PNG and footprint in place. */
export function manorDecorationTransformWithAnchor(
  transform: ManorDecorationTransform,
  anchorX: number,
  anchorY: number,
  mirrorX = false
): ManorDecorationTransform {
  const nextAnchorX = clamp(anchorX, 0, 1);
  const nextAnchorY = clamp(anchorY, 0, 1);
  const radians = transform.rotationDeg * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localDeltaX = (nextAnchorX - transform.anchorX) * transform.width * transform.scaleX * (mirrorX ? -1 : 1);
  const localDeltaY = (nextAnchorY - transform.anchorY) * transform.height * transform.scaleY;
  return {
    ...transform,
    x: transform.x + localDeltaX * cos - localDeltaY * sin,
    y: transform.y + localDeltaX * sin + localDeltaY * cos,
    anchorX: nextAnchorX,
    anchorY: nextAnchorY
  };
}

/** Keep artwork, footprints, and the right-wall preview on one SVG transform. */
export function manorDecorationSvgTransform(
  transform: ManorDecorationTransform,
  mirrorX = false
): string {
  const horizontalScale = transform.scaleX * (mirrorX ? -1 : 1);
  return `translate(${transform.x} ${transform.y}) rotate(${transform.rotationDeg}) scale(${horizontalScale} ${transform.scaleY}) translate(${-transform.width * transform.anchorX} ${-transform.height * transform.anchorY})`;
}

/** Fit an imported PNG into the current default frame without changing its anchor or unit scales. */
export function manorDecorationTransformForImportedPng(
  transform: ManorDecorationTransform,
  intrinsicWidth: number,
  intrinsicHeight: number
): ManorDecorationTransform {
  if (!Number.isFinite(intrinsicWidth) || intrinsicWidth <= 0 ||
      !Number.isFinite(intrinsicHeight) || intrinsicHeight <= 0 ||
      !Number.isFinite(transform.width) || transform.width <= 0 ||
      !Number.isFinite(transform.height) || transform.height <= 0) {
    return transform;
  }
  const intrinsicRatio = intrinsicWidth / intrinsicHeight;
  const width = Math.min(transform.width, transform.height * intrinsicRatio);
  const height = width / intrinsicRatio;
  return { ...transform, width, height };
}

export function manorDecorationFootprintClass(collision: boolean, selected: boolean): string {
  return `manor-decoration-footprint${collision ? " collision" : selected ? " selected" : ""}`;
}

/** Explain why a draft decoration cannot be placed on its selected surface. */
export function manorDecorationContainmentReason(
  decoration: ManorDecorationTransformable,
  surface: ManorPlacementSurfaceDefinition | null
): string | null {
  if (!surface) return "Select a floor or wall placement surface.";
  const transformValues = Object.values(decoration.transform);
  if (transformValues.some((value) => !Number.isFinite(value))) {
    return "Decoration transform must use finite values.";
  }
  if (decoration.transform.width <= 0 || decoration.transform.height <= 0 ||
    decoration.transform.scaleX === 0 || decoration.transform.scaleY === 0) {
    return "Decoration width and height must be positive; scales must be nonzero.";
  }
  const footprintIssues = manorPolygonGeometryIssues(decoration.footprint);
  if (footprintIssues.length > 0) {
    return `Custom footprint invalid: ${footprintIssues[0]!.replace(/^polygon /u, "")}`;
  }
  const footprint = manorDecorationFootprintInRoom(
    decoration,
    manorDecorationNeedsHorizontalMirror(decoration, surface)
  );
  const container = surface.kind === "floor" ? surface.polygon : surface.roomPolygon;
  return manorPolygonContainsPolygon(container, footprint)
    ? null
    : `The transformed footprint must be fully inside the selected ${surfaceLabel(surface.kind).toLowerCase()} surface.`;
}


/** Right-wall previews mirror left-authored art while keeping footprint points PNG-local. */
export function manorDecorationNeedsHorizontalMirror(
  decoration: Pick<ManorDecorationDraft, "mirrorX">,
  surface: ManorPlacementSurfaceDefinition | null
): boolean {
  if (surface) return surface.kind === "right_wall";
  return decoration.mirrorX === true;
}


export function surfaceLabel(kind: ManorPlacementSurfaceDefinition["kind"]): string {
  if (kind === "floor") return "Floor";
  if (kind === "back_wall") return "Back wall";
  if (kind === "left_wall") return "Left wall";
  return "Right wall";
}

export function surfacePoints(surface: ManorPlacementSurfaceDefinition): readonly IndoorPoint[] {
  return surface.kind === "floor" ? surface.polygon : surface.roomPolygon;
}

export function surfaceBounds(surface: ManorPlacementSurfaceDefinition): { minX: number; minY: number; maxX: number; maxY: number } {
  const points = surfacePoints(surface);
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}

export function defaultDecorationTransform(surface: ManorPlacementSurfaceDefinition): ManorDecorationTransform {
  const placement = surfaceBounds(surface);
  return {
    x: (placement.minX + placement.maxX) / 2,
    y: (placement.minY + placement.maxY) / 2,
    width: Math.min(180, Math.max(12, (placement.maxX - placement.minX) * 0.65)),
    height: Math.min(120, Math.max(12, (placement.maxY - placement.minY) * 0.35)),
    rotationDeg: 0,
    scaleX: 1,
    scaleY: 1,
    anchorX: 0.5,
    anchorY: 0.5
  };
}

/** Inventory items a Manor decoration may bind to for custody. */
export const MANOR_DECORATION_ITEMS = Object.values(INVENTORY_CATALOG)
  .filter((item) => item.manorStorable && item.kind !== "equipment" && item.stackable)
  .sort((left, right) => left.displayName.localeCompare(right.displayName));

/**
 * Walk Test blockers for a room: the footprints of its active, collision-enabled decorations that
 * sit validly on one of the room's surfaces (what the server treats as an extra collider for
 * player placements). Decorations without collision, retired ones and misplaced ones do not block.
 */
export function decorationWalkColliders(
  room: { id: string; floors: readonly InteriorFloor[]; walls: readonly InteriorWall[] },
  decorations: readonly (ManorDecorationTransformable & { id: string; roomId: string; surfaceId: string; retired?: boolean; collision: boolean })[]
): IndoorNavigationCollider[] {
  const surfaces = decorationSurfacesOf(room);
  return decorations.flatMap((decoration) => {
    if (decoration.retired || decoration.roomId !== room.id || !decoration.collision) return [];
    const surface = surfaces.find((candidate) => candidate.id === decoration.surfaceId) ?? null;
    if (!surface || surface.retired || manorDecorationContainmentReason(decoration, surface)) return [];
    const footprint = manorDecorationFootprintInRoom(decoration, manorDecorationNeedsHorizontalMirror(decoration, surface));
    if (manorPolygonGeometryIssues(footprint).length > 0) return [];
    return [{ id: `decoration:${decoration.id}`, kind: "polygon" as const, points: footprint }];
  });
}

/** The placement surfaces of a room: its floors and walls, in the shape the decoration geometry reads. */
export function decorationSurfacesOf(authoring: { floors: readonly InteriorFloor[]; walls: readonly InteriorWall[] }): ManorPlacementSurfaceDefinition[] {
  return [
    ...authoring.floors.map((floor): ManorPlacementSurfaceDefinition => ({ id: floor.id, retired: floor.retired, kind: "floor", polygon: structuredClone(floor.polygon) })),
    ...authoring.walls.map((wall): ManorPlacementSurfaceDefinition => structuredClone(wall))
  ];
}

/**
 * The definitions of a space after the Decoration Test replaced the active
 * decorations of one room with `next`. Definitions are id-preserved: one that is
 * stored on disk and was deleted is retired (published ids are never removed),
 * one that only ever lived in the draft is simply dropped.
 */
export function decorationsAfterRoomEdit(
  current: readonly InteriorDecoration[],
  storedIds: ReadonlySet<string>,
  roomId: string,
  next: readonly InteriorDecoration[]
): InteriorDecoration[] {
  const nextById = new Map(next.map((value) => [value.id, value]));
  const kept = current.flatMap((value): InteriorDecoration[] => {
    if (value.roomId !== roomId || value.retired) return [value];
    const edited = nextById.get(value.id);
    if (edited) return [{ ...edited, retired: false }];
    return storedIds.has(value.id) ? [{ ...value, retired: true }] : [];
  });
  const known = new Set(current.map((value) => value.id));
  return [...kept, ...next.filter((value) => !known.has(value.id)).map((value) => ({ ...value, retired: false }))];
}

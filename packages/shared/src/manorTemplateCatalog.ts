import { z } from "zod";

import { INTERIOR_DATA } from "./data/interiors/index.js";
import { manorTemplateCatalogInputFromInterior } from "./interior/manorView.js";

import {
  STANDARD_INDOOR_SPATIAL_PROFILE,
  isIndoorNavigationPointWalkable,
  type IndoorNavigationPolygonCollider,
  type IndoorRoomNavigation,
  type IndoorPoint
} from "./indoor.js";
import { requireInventoryCatalogItem } from "./inventoryCatalog.js";

/** The canonical schema version for Studio-authored Manor templates. */
export const MANOR_TEMPLATE_CATALOG_SCHEMA_VERSION = 3 as const;

const idSchema = z.string().regex(
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u,
  "must be a safe lowercase ID"
);
const finiteNumber = z.number().finite();
const assetKeySchema = z.string().regex(
  /^apps\/client\/(?:src|public)\/assets\/[a-zA-Z0-9][a-zA-Z0-9/_-]*\.png$/u,
  "must reference a PNG under apps/client/src/assets or apps/client/public/assets"
);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/u, "must be a six-digit hex color");
const pointSchema = z.object({ x: finiteNumber, y: finiteNumber }).strict();
const polygonPointsSchema = z.array(pointSchema).min(3);
const polygonSchema = z.object({
  kind: z.literal("polygon"),
  points: polygonPointsSchema
}).strict();
const uvPointSchema = z.object({ u: finiteNumber, v: finiteNumber }).strict();
const transformSchema = z.object({
  offsetU: finiteNumber,
  offsetV: finiteNumber,
  scaleU: finiteNumber,
  scaleV: finiteNumber,
  rotationDeg: finiteNumber
}).strict();
const cameraSchema = z.object({
  mode: z.literal("fixed_center"),
  center: pointSchema,
  fitPadding: finiteNumber.nonnegative(),
  defaultZoom: finiteNumber.positive(),
  minZoom: finiteNumber.positive(),
  maxZoom: finiteNumber.positive()
}).strict();
const themeSchema = z.object({
  themeId: idSchema,
  floorAssetKey: assetKeySchema,
  backgroundColor: colorSchema,
  floorColor: colorSchema,
  wallColor: colorSchema
}).strict();
const anchorSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  x: finiteNumber,
  y: finiteNumber,
  facing: finiteNumber.optional(),
  type: z.enum(["spawn", "portal", "message"]),
  destinationRoomId: idSchema.optional(),
  destinationAnchorId: idSchema.optional(),
  locked: z.boolean().optional(),
  message: z.string().trim().min(1).max(240).optional(),
  /**
   * Every room this door leads to, each with the label the owner typed in
   * Studio (one button per destination in the door prompt). The first entry is
   * also `destinationRoomId`/`destinationAnchorId`.
   */
  destinations: z.array(z.object({
    destinationRoomId: idSchema,
    destinationAnchorId: idSchema,
    label: z.string().trim().min(1).max(80),
    locked: z.boolean()
  }).strict()).min(1).optional()
}).strict();
const colliderSchema = polygonSchema.extend({
  id: idSchema,
  retired: z.boolean()
}).strict();
const floorSurfaceSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  kind: z.literal("floor"),
  polygon: polygonPointsSchema
}).strict();
const wallSurfaceSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  kind: z.enum(["back_wall", "left_wall", "right_wall"]),
  roomPolygon: polygonPointsSchema,
  imagePolygon: z.array(uvPointSchema).min(3),
  transform: transformSchema
}).strict();
const placementSurfaceSchema = z.discriminatedUnion("kind", [
  floorSurfaceSchema,
  wallSurfaceSchema
]);
const portalHotspotSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  polygon: polygonPointsSchema,
  anchorId: idSchema,
  portalId: idSchema.optional(),
  interactionLabel: z.string().min(1)
}).strict();
const doorVisualSchema = z.object({
  assetKey: assetKeySchema,
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
  anchorX: finiteNumber.min(0).max(1),
  anchorY: finiteNumber.min(0).max(1)
}).strict();
const decorationTransformSchema = z.object({
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
  rotationDeg: finiteNumber,
  scaleX: finiteNumber,
  scaleY: finiteNumber,
  anchorX: finiteNumber.min(0).max(1),
  anchorY: finiteNumber.min(0).max(1)
}).strict();
const decorationSchema = z.object({
  id: idSchema,
  retired: z.boolean().default(false),
  name: z.string().trim().min(1).max(120),
  /** Null marks a universal Manor decoration that has no inventory custody. */
  itemId: z.string().trim().min(1).max(128).nullable().default(null),
  assetKey: assetKeySchema,
  roomId: idSchema,
  surfaceId: idSchema,
  layer: z.enum(["behind", "in_front", "rug"]),
  placementMode: z.enum(["permanent", "movable"]).default("movable"),
  transform: decorationTransformSchema,
  footprint: z.array(z.object({
    x: finiteNumber.min(0).max(1),
    y: finiteNumber.min(0).max(1)
  }).strict()).min(3),
  collision: z.boolean(),
  zIndex: z.number().int().nonnegative(),
  /** Right-wall art is always mirrored from the left-authored PNG once. */
  mirrorX: z.boolean().default(false)
}).strict();
const roomSchema = z.object({
  id: idSchema,
  revision: z.string().min(1),
  retired: z.boolean(),
  name: z.string().min(1),
  active: z.boolean(),
  themeId: idSchema,
  floorAssetKey: assetKeySchema.optional(),
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
  spatialProfileId: z.literal("standard_indoor_v1"),
  spawnAnchorId: idSchema,
  camera: cameraSchema,
  colliders: z.array(colliderSchema),
  placementSurfaces: z.array(placementSurfaceSchema).min(1),
  anchors: z.array(anchorSchema),
  portalHotspots: z.array(portalHotspotSchema),
  /** The authored door back to the overworld (the interior portal record to `world`), shown as a normal door. */
  worldExit: z.object({
    anchorId: idSchema,
    x: finiteNumber,
    y: finiteNumber,
    interactionLabel: z.string().min(1),
    /** The button text in the door prompt (the exit portal label typed in Studio). */
    label: z.string().min(1).optional(),
    polygon: polygonPointsSchema.nullable()
  }).strict().optional()
}).strict();
const exteriorSchema = z.object({
  assetKey: assetKeySchema,
  scale: finiteNumber.min(0.25).max(4)
}).strict();
const templateSchema = z.object({
  id: idSchema,
  revision: z.string().min(1),
  publishedRevisionId: idSchema,
  retired: z.boolean(),
  name: z.string().min(1),
  description: z.string().min(1),
  theme: themeSchema,
  defaultRoomId: idSchema,
  rooms: z.array(roomSchema).min(1),
  doorVisual: doorVisualSchema.nullable(),
  /** Overworld building art of this Manor type; null draws the shared Manor sprite. */
  exterior: exteriorSchema.nullable().default(null),
  decorations: z.array(decorationSchema).default([])
}).strict();
const canonicalCatalogSchema = z.object({
  schemaVersion: z.literal(MANOR_TEMPLATE_CATALOG_SCHEMA_VERSION),
  catalogRevision: z.number().int().nonnegative(),
  templates: z.array(templateSchema).min(1)
}).strict();

export type ManorTemplateCatalog = z.infer<typeof canonicalCatalogSchema>;
export type ManorTemplateDefinition = ManorTemplateCatalog["templates"][number];
export type ManorRoomDefinition = ManorTemplateDefinition["rooms"][number];
export type ManorAnchorDefinition = ManorRoomDefinition["anchors"][number];
export type ManorAnchorDestination = Readonly<{
  destinationRoomId: string;
  destinationAnchorId: string;
  /** Typed door label; absent on legacy single-destination anchors. */
  label?: string;
  locked: boolean;
}>;

/** Every destination of a Manor door anchor (legacy anchors: their single destination). */
export function manorAnchorDestinations(anchor: ManorAnchorDefinition): ManorAnchorDestination[] {
  if (anchor.destinations) return anchor.destinations.map((destination) => ({ ...destination }));
  return anchor.destinationRoomId && anchor.destinationAnchorId
    ? [{ destinationRoomId: anchor.destinationRoomId, destinationAnchorId: anchor.destinationAnchorId, locked: anchor.locked === true }]
    : [];
}
export type ManorColliderDefinition = ManorRoomDefinition["colliders"][number];
export type ManorPlacementSurfaceDefinition = ManorRoomDefinition["placementSurfaces"][number];
export type ManorPortalHotspotDefinition = ManorRoomDefinition["portalHotspots"][number];
export type ManorWorldExitDefinition = NonNullable<ManorRoomDefinition["worldExit"]>;
export type ManorPoint = z.infer<typeof pointSchema>;
export type ManorPolygon = z.infer<typeof polygonSchema>;
export type ManorUvPoint = z.infer<typeof uvPointSchema>;
export type ManorSurfaceTransform = z.infer<typeof transformSchema>;
export type ManorDecorationTransform = z.infer<typeof decorationTransformSchema>;
export type ManorDecorationDefinition = z.infer<typeof decorationSchema>;
export type ManorCatalogValidationIssue = Readonly<{ path: string; message: string }>;

const catalogSchema = z.preprocess(migrateLegacyManorTemplateCatalog, canonicalCatalogSchema);

/** Return a signed area; clockwise and counter-clockwise polygons are both valid. */
export function manorPolygonArea(points: readonly IndoorPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

/** Boundary-inclusive point-in-polygon test for concave polygons. */
export function manorPointInPolygon(
  point: IndoorPoint,
  polygon: readonly IndoorPoint[],
  epsilon = 1e-9
): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++) {
    const first = polygon[current]!;
    const second = polygon[previous]!;
    if (pointSegmentDistance(point, first, second) <= epsilon) return true;
    if ((first.y > point.y) !== (second.y > point.y) &&
      point.x < (second.x - first.x) * (point.y - first.y) /
        (second.y - first.y) + first.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Full polygon-in-polygon containment used by the Studio decoration overlay.
 * It checks vertices and every edge against a concave container, not only a
 * bounding box, so a transformed polygon cannot cross through a notch.
 */
export function manorPolygonContainsPolygon(
  container: readonly IndoorPoint[],
  subject: readonly IndoorPoint[],
  epsilon = 1e-9
): boolean {
  if (manorPolygonGeometryIssues(container).length > 0 ||
    manorPolygonGeometryIssues(subject).length > 0) return false;
  if (!subject.every((point) => manorPointInPolygon(point, container, epsilon))) return false;
  for (let index = 0; index < subject.length; index += 1) {
    const start = subject[index]!;
    const end = subject[(index + 1) % subject.length]!;
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    if (!manorPointInPolygon(midpoint, container, epsilon)) return false;
    for (let boundary = 0; boundary < container.length; boundary += 1) {
      const boundaryStart = container[boundary]!;
      const boundaryEnd = container[(boundary + 1) % container.length]!;
      if (segmentsProperlyIntersect(start, end, boundaryStart, boundaryEnd, epsilon)) {
        return false;
      }
    }
  }
  return true;
}

/** Validate an arbitrary dot-connected polygon used by the Studio overlay. */
export function manorPolygonGeometryIssues(points: readonly IndoorPoint[]): string[] {
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return ["polygon coordinates must be finite"];
  }
  if (points.length < 3) return ["polygon must have at least 3 unique vertices"];
  const unique = new Set(points.map((point) => `${point.x}:${point.y}`));
  if (unique.size < 3) return ["polygon must have at least 3 unique vertices"];
  if (Math.abs(manorPolygonArea(points)) <= 1e-9) return ["polygon must have non-zero area"];
  for (let index = 0; index < points.length; index += 1) {
    if (samePoint(points[index]!, points[(index + 1) % points.length]!)) {
      return ["polygon may not contain adjacent duplicate vertices"];
    }
  }
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersectForValidation(
        points[first]!, points[firstNext]!, points[second]!, points[secondNext]!
      )) return ["polygon must not self-intersect"];
    }
  }
  return [];
}

/** Return the canonical movement inputs for a Manor room. */
export function manorTemplateRoomNavigation(
  room: Pick<ManorRoomDefinition, "width" | "height" | "colliders"> &
    Partial<Pick<ManorRoomDefinition, "placementSurfaces">>
): IndoorRoomNavigation {
  const placementSurfaces = room.placementSurfaces;
  return {
    roomWidth: room.width,
    roomHeight: room.height,
    playerRadius: STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius,
    colliders: room.colliders.filter((collider) => !collider.retired).map((collider): IndoorNavigationPolygonCollider => ({
      id: collider.id,
      kind: "polygon",
      points: collider.points
    })),
    ...(placementSurfaces ? {
      walkableSurfaces: placementSurfaces
        .filter((surface) => !surface.retired && surface.kind === "floor")
        .flatMap((surface) => surface.kind === "floor" ? [surface.polygon] : [])
    } : {})
  };
}

/** Legible starter-room art until an author uploads the room's PNG. */
export function manorRoomPlaceholderDataUrl(room: ManorRoomDefinition): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const surfaces = room.placementSurfaces.filter((surface) => surface.kind === "floor" && !surface.retired)
    .map((surface) => surface.kind === "floor" ? `<polygon points="${surface.polygon.map((point) => `${point.x},${point.y}`).join(" ")}" fill="#302a23" stroke="#8e754b" stroke-width="3"/>` : "").join("");
  const doors = room.portalHotspots.filter((hotspot) => !hotspot.retired).map((hotspot) => {
    const x = hotspot.polygon.reduce((sum, point) => sum + point.x, 0) / hotspot.polygon.length;
    const y = hotspot.polygon.reduce((sum, point) => sum + point.y, 0) / hotspot.polygon.length;
    const locked = room.anchors.find((anchor) => anchor.id === hotspot.anchorId)?.locked;
    return `<polygon points="${hotspot.polygon.map((point) => `${point.x},${point.y}`).join(" ")}" fill="#59432a" stroke="#c5a66b" stroke-width="4"/><text x="${x}" y="${y + 64}" text-anchor="middle" fill="#eadfc5" font-size="22">${escape(hotspot.interactionLabel)}${locked ? " · Locked" : ""}</text>`;
  }).join("");
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${room.width}" height="${room.height}" viewBox="0 0 ${room.width} ${room.height}"><rect width="100%" height="100%" fill="#15130f"/>${surfaces}<text x="${room.width / 2}" y="80" text-anchor="middle" fill="#eadfc5" font-size="32">${escape(room.name)}</text>${doors}</svg>`)}`;
}

/** Transform one normalized PNG-local point into authored room coordinates. */
export function manorDecorationTransformPoint(
  point: IndoorPoint,
  transform: ManorDecorationTransform,
  mirrorX = false
): IndoorPoint {
  const radians = transform.rotationDeg * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localX = (point.x - transform.anchorX) * transform.width * transform.scaleX *
    (mirrorX ? -1 : 1);
  const localY = (point.y - transform.anchorY) * transform.height * transform.scaleY;
  return {
    x: transform.x + localX * cos - localY * sin,
    y: transform.y + localX * sin + localY * cos
  };
}

/** Transform an authored normalized decoration footprint into room coordinates. */
export function manorDecorationFootprintInRoom(
  decoration: Pick<ManorDecorationDefinition, "transform" | "footprint"> &
    Partial<Pick<ManorDecorationDefinition, "mirrorX">>,
  mirrorX = decoration.mirrorX === true
): IndoorPoint[] {
  return decoration.footprint.map((point) =>
    manorDecorationTransformPoint(point, decoration.transform, mirrorX));
}

/**
 * Return whether a transformed decoration is valid for its authored surface.
 *
 * This is deliberately shared by the Studio/runtime clients and the server:
 * a drag may be previewed locally, but the server remains the authority that
 * persists the resolved transform. Collision polygons constrain floor
 * decorations; wall art is expected to overlap the structural wall collider
 * by design.
 */
export function isManorDecorationPlacementValid(
  decoration: Pick<ManorDecorationDefinition, "footprint" | "mirrorX" | "collision">,
  surface: ManorPlacementSurfaceDefinition,
  transform: ManorDecorationTransform,
  collisionPolygons: readonly (readonly IndoorPoint[])[] = []
): boolean {
  const footprint = manorDecorationFootprintInRoom(
    { ...decoration, transform },
    surface.kind === "right_wall" || decoration.mirrorX === true
  );
  if (manorPolygonGeometryIssues(footprint).length > 0) return false;
  const container = surface.kind === "floor" ? surface.polygon : surface.roomPolygon;
  if (!manorPolygonContainsPolygon(container, footprint)) return false;
  if (surface.kind === "floor" && decoration.collision &&
    collisionPolygons.some((polygon) => manorPolygonIntersectsPolygon(footprint, polygon))) {
    return false;
  }
  return true;
}

/** Boundary-inclusive polygon intersection used for decoration collision checks. */
export function manorPolygonIntersectsPolygon(
  first: readonly IndoorPoint[],
  second: readonly IndoorPoint[],
  epsilon = 1e-9
): boolean {
  if (manorPolygonGeometryIssues(first).length > 0 ||
    manorPolygonGeometryIssues(second).length > 0) return true;
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    const firstStart = first[firstIndex]!;
    const firstEnd = first[(firstIndex + 1) % first.length]!;
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      const secondStart = second[secondIndex]!;
      const secondEnd = second[(secondIndex + 1) % second.length]!;
      if (segmentsIntersectInclusive(firstStart, firstEnd, secondStart, secondEnd, epsilon)) {
        return true;
      }
    }
  }
  return manorPointInPolygon(first[0]!, second, epsilon) ||
    manorPointInPolygon(second[0]!, first, epsilon);
}

/**
 * Resolve a requested decoration drag by sliding the transformed footprint
 * along the first blocking polygon edge. The result is always the last
 * canonical-valid position reached from the current transform; no bounding
 * box approximation is used, so rotated, mirrored and concave footprints all
 * follow the same containment rules as placement validation.
 */
export function resolveManorDecorationDragPosition(input: Readonly<{
  decoration: Pick<ManorDecorationDefinition, "footprint" | "mirrorX" | "collision">;
  surface: ManorPlacementSurfaceDefinition;
  currentTransform: ManorDecorationTransform;
  requestedPosition: IndoorPoint;
  collisionPolygons?: readonly (readonly IndoorPoint[])[];
}>): IndoorPoint {
  const collisionPolygons = input.collisionPolygons ?? [];
  const baseTransform = input.currentTransform;
  const withPosition = (position: IndoorPoint): ManorDecorationTransform => ({
    ...baseTransform,
    x: position.x,
    y: position.y
  });
  const valid = (position: IndoorPoint): boolean => isManorDecorationPlacementValid(
    input.decoration,
    input.surface,
    withPosition(position),
    collisionPolygons
  );
  const start = { x: baseTransform.x, y: baseTransform.y };
  if (!valid(start)) return start;
  if (valid(input.requestedPosition)) return { ...input.requestedPosition };

  let position = start;
  let remaining = {
    x: input.requestedPosition.x - start.x,
    y: input.requestedPosition.y - start.y
  };
  for (let iteration = 0; iteration < 8; iteration += 1) {
    if (Math.hypot(remaining.x, remaining.y) <= 1e-7) return position;
    const target = { x: position.x + remaining.x, y: position.y + remaining.y };
    if (valid(target)) return target;

    // Find the first invalid point along the requested segment. A tiny
    // inward bias leaves the persisted footprint on the valid side of a
    // boundary even when the edge itself is also a collision boundary.
    let low = 0;
    let high = 1;
    for (let probe = 0; probe < 42; probe += 1) {
      const middle = (low + high) / 2;
      const candidate = {
        x: position.x + remaining.x * middle,
        y: position.y + remaining.y * middle
      };
      if (valid(candidate)) low = middle;
      else high = middle;
    }
    const safeT = Math.max(0, low - 1e-7);
    position = {
      x: position.x + remaining.x * safeT,
      y: position.y + remaining.y * safeT
    };
    const residual = {
      x: remaining.x * (1 - safeT),
      y: remaining.y * (1 - safeT)
    };
    if (Math.hypot(residual.x, residual.y) <= 1e-7) return position;

    const footprint = manorDecorationFootprintInRoom(
      { ...input.decoration, transform: withPosition(position) },
      input.surface.kind === "right_wall" || input.decoration.mirrorX === true
    );
    const blockingEdges = decorationBlockingEdges(
      input.surface.kind === "floor" ? input.surface.polygon : input.surface.roomPolygon,
      footprint,
      residual,
      collisionPolygons,
      input.surface.kind === "floor" && input.decoration.collision
    );
    const edge = blockingEdges[0];
    if (!edge) return position;
    const edgeLength = Math.hypot(edge.end.x - edge.start.x, edge.end.y - edge.start.y);
    if (edgeLength <= 1e-9) return position;
    const tangent = {
      x: (edge.end.x - edge.start.x) / edgeLength,
      y: (edge.end.y - edge.start.y) / edgeLength
    };
    const projected = residual.x * tangent.x + residual.y * tangent.y;
    if (Math.abs(projected) <= 1e-7) return position;
    remaining = { x: tangent.x * projected, y: tangent.y * projected };
  }
  return position;
}

type DecorationBoundaryEdge = Readonly<{
  start: IndoorPoint;
  end: IndoorPoint;
  distance: number;
  blocks: boolean;
}>;

function decorationBlockingEdges(
  container: readonly IndoorPoint[],
  footprint: readonly IndoorPoint[],
  residual: IndoorPoint,
  collisionPolygons: readonly (readonly IndoorPoint[])[],
  collisionsEnabled: boolean
): DecorationBoundaryEdge[] {
  const edges: DecorationBoundaryEdge[] = [];
  addBoundaryEdges(edges, container, footprint, residual, false);
  if (collisionsEnabled) {
    for (const polygon of collisionPolygons) {
      addBoundaryEdges(edges, polygon, footprint, residual, true);
    }
  }
  edges.sort((left, right) => {
    if (left.blocks !== right.blocks) return left.blocks ? -1 : 1;
    return left.distance - right.distance;
  });
  return edges;
}

function addBoundaryEdges(
  output: DecorationBoundaryEdge[],
  polygon: readonly IndoorPoint[],
  footprint: readonly IndoorPoint[],
  residual: IndoorPoint,
  collision: boolean
): void {
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]!;
    const end = polygon[(index + 1) % polygon.length]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length <= 1e-9) continue;
    const normal = polygonInteriorNormal(polygon, start, end, collision);
    const outwardDot = residual.x * normal.outward.x + residual.y * normal.outward.y;
    const distance = Math.min(...footprint.map((point) => pointSegmentDistance(point, start, end)));
    output.push({
      start,
      end,
      distance,
      blocks: outwardDot > 1e-7
    });
  }
}

function polygonInteriorNormal(
  polygon: readonly IndoorPoint[],
  start: IndoorPoint,
  end: IndoorPoint,
  collision: boolean
): { inward: IndoorPoint; outward: IndoorPoint } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const first = { x: -dy / length, y: dx / length };
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const probe = 1e-4;
  const inward = manorPointInPolygon(
    { x: midpoint.x + first.x * probe, y: midpoint.y + first.y * probe },
    polygon,
    probe * 0.5
  ) ? first : { x: -first.x, y: -first.y };
  // For an obstacle, movement into its interior is the blocking direction;
  // for a containing surface, movement along its outward normal is blocking.
  return collision
    ? { inward, outward: { x: inward.x, y: inward.y } }
    : { inward, outward: { x: -inward.x, y: -inward.y } };
}

function segmentsIntersectInclusive(
  a: IndoorPoint,
  b: IndoorPoint,
  c: IndoorPoint,
  d: IndoorPoint,
  epsilon: number
): boolean {
  const first = crossProduct(a, b, c);
  const second = crossProduct(a, b, d);
  const third = crossProduct(c, d, a);
  const fourth = crossProduct(c, d, b);
  if (((first > epsilon && second < -epsilon) || (first < -epsilon && second > epsilon)) &&
    ((third > epsilon && fourth < -epsilon) || (third < -epsilon && fourth > epsilon))) return true;
  return Math.abs(first) <= epsilon && onSegmentWithEpsilon(c, a, b, epsilon) ||
    Math.abs(second) <= epsilon && onSegmentWithEpsilon(d, a, b, epsilon) ||
    Math.abs(third) <= epsilon && onSegmentWithEpsilon(a, c, d, epsilon) ||
    Math.abs(fourth) <= epsilon && onSegmentWithEpsilon(b, c, d, epsilon);
}

function onSegmentWithEpsilon(
  point: IndoorPoint,
  start: IndoorPoint,
  end: IndoorPoint,
  epsilon: number
): boolean {
  return point.x >= Math.min(start.x, end.x) - epsilon &&
    point.x <= Math.max(start.x, end.x) + epsilon &&
    point.y >= Math.min(start.y, end.y) - epsilon &&
    point.y <= Math.max(start.y, end.y) + epsilon;
}

/**
 * Migrate pre-message Studio catalogs without carrying forward their
 * standalone navigation-area or exit-anchor concepts. The original catalog
 * had no typed portal pairing, so non-spawn anchors and their exit hotspots
 * become retired compatibility records rather than invented destinations.
 */
function migrateLegacyManorTemplateCatalog(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const catalog = structuredClone(value) as Record<string, unknown>;
  if ((catalog.schemaVersion !== 1 && catalog.schemaVersion !== 2) || !Array.isArray(catalog.templates)) return value;
  const legacyVersion = catalog.schemaVersion;
  catalog.schemaVersion = MANOR_TEMPLATE_CATALOG_SCHEMA_VERSION;
  catalog.templates = catalog.templates.map((templateValue) => {
    if (!templateValue || typeof templateValue !== "object" || Array.isArray(templateValue)) return templateValue;
    const template = templateValue as Record<string, unknown>;
    if (!Array.isArray(template.rooms)) return template;
    template.rooms = template.rooms.map((roomValue) => {
      if (!roomValue || typeof roomValue !== "object" || Array.isArray(roomValue)) return roomValue;
      const room = roomValue as Record<string, unknown>;
      if (legacyVersion === 1) {
        const spawnAnchorId = typeof room.spawnAnchorId === "string" ? room.spawnAnchorId : null;
        const anchors = Array.isArray(room.anchors) ? room.anchors : [];
        room.anchors = anchors.map((anchorValue) => {
          if (!anchorValue || typeof anchorValue !== "object" || Array.isArray(anchorValue)) return anchorValue;
          const anchor = anchorValue as Record<string, unknown>;
          const isSpawn = anchor.id === spawnAnchorId;
          return {
            ...anchor,
            type: isSpawn ? "spawn" : "portal",
            ...(isSpawn ? {} : { retired: true })
          };
        });
        const activePortalIds = new Set(
          (room.anchors as Array<Record<string, unknown>>)
            .filter((anchor) => anchor.type === "portal" && anchor.retired === false)
            .map((anchor) => anchor.id)
        );
        if (Array.isArray(room.portalHotspots)) {
          room.portalHotspots = room.portalHotspots.map((hotspotValue) => {
            if (!hotspotValue || typeof hotspotValue !== "object" || Array.isArray(hotspotValue)) return hotspotValue;
            const hotspot = hotspotValue as Record<string, unknown>;
            return activePortalIds.has(hotspot.anchorId) ? hotspot : { ...hotspot, retired: true };
          });
        }
      }
      delete room.navigationAreas;
      return room;
    });
    return template;
  });
  return catalog;
}

export function manorCatalogValidationIssues(value: unknown): ManorCatalogValidationIssue[] {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "$",
      message: issue.message
    }));
  }
  return semanticIssues(parsed.data);
}

export function parseManorTemplateCatalog(value: unknown): ManorTemplateCatalog {
  return validateManorTemplateCatalog(value);
}

export function validateManorTemplateCatalog(value: unknown): ManorTemplateCatalog {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "$",
      message: issue.message
    }))));
  }
  const issues = semanticIssues(parsed.data);
  if (issues.length > 0) throw new Error(formatIssues(issues));
  return parsed.data;
}

function semanticIssues(catalog: ManorTemplateCatalog): ManorCatalogValidationIssue[] {
  const issues: ManorCatalogValidationIssue[] = [];
  duplicateIssues(catalog.templates, "templates", (template) => template.id, issues);
  for (const [templateIndex, template] of catalog.templates.entries()) {
    const templatePath = `templates.${templateIndex}`;
    duplicateIssues(template.rooms, `${templatePath}.rooms`, (room) => room.id, issues);
    duplicateIssues(template.decorations, `${templatePath}.decorations`, (decoration) => decoration.id, issues);
    const rooms = new Map(template.rooms.map((room) => [room.id, room]));
    const defaultRoom = rooms.get(template.defaultRoomId);
    if (!defaultRoom || defaultRoom.retired || !defaultRoom.active) {
      issues.push({ path: `${templatePath}.defaultRoomId`, message: "references an active room" });
    }
    for (const [roomIndex, room] of template.rooms.entries()) {
      const roomPath = `${templatePath}.rooms.${roomIndex}`;
      if (room.themeId !== template.theme.themeId) {
        issues.push({ path: `${roomPath}.themeId`, message: "must reference the template theme" });
      }
      duplicateIssues(room.colliders, `${roomPath}.colliders`, (collider) => collider.id, issues);
      duplicateIssues(room.placementSurfaces, `${roomPath}.placementSurfaces`, (surface) => surface.id, issues);
      duplicateIssues(room.anchors, `${roomPath}.anchors`, (anchor) => anchor.id, issues);
      duplicateIssues(room.portalHotspots, `${roomPath}.portalHotspots`, (hotspot) => hotspot.id, issues);
      const anchors = new Map(room.anchors.map((anchor) => [anchor.id, anchor]));
      const spawn = anchors.get(room.spawnAnchorId);
      if (!spawn || spawn.retired || spawn.type !== "spawn") {
        issues.push({ path: `${roomPath}.spawnAnchorId`, message: "references an active spawn anchor" });
      }
      if (!(room.camera.minZoom <= room.camera.defaultZoom &&
        room.camera.defaultZoom <= room.camera.maxZoom)) {
        issues.push({ path: `${roomPath}.camera`, message: "zoom must satisfy minZoom <= defaultZoom <= maxZoom" });
      }
      if (!pointInBounds(room.camera.center, room.width, room.height)) {
        issues.push({ path: `${roomPath}.camera.center`, message: "is outside room bounds" });
      }
      room.anchors.forEach((anchor, anchorIndex) => {
        if (!anchor.retired && !pointInBounds(anchor, room.width, room.height)) {
          issues.push({ path: `${roomPath}.anchors.${anchorIndex}`, message: "is outside room bounds" });
        }
      });
      const activeFloorSurfaces = room.placementSurfaces.filter((surface) =>
        !surface.retired && surface.kind === "floor"
      );
      if (!room.retired && room.active && activeFloorSurfaces.length === 0) {
        issues.push({ path: `${roomPath}.placementSurfaces`, message: "must include an active floor surface" });
      }
      room.anchors.forEach((anchor, anchorIndex) => {
        if (anchor.retired) return;
        const anchorPath = `${roomPath}.anchors.${anchorIndex}`;
        if (anchor.type === "spawn") {
          if (anchor.destinationRoomId || anchor.destinationAnchorId) {
            issues.push({ path: anchorPath, message: "spawn anchor cannot have a destination anchor" });
          }
          if (anchor.message !== undefined) {
            issues.push({ path: anchorPath, message: "spawn anchor cannot have a message" });
          }
          return;
        }
        if (anchor.type === "message") {
          if (anchor.destinationRoomId || anchor.destinationAnchorId) {
            issues.push({ path: anchorPath, message: "message anchor cannot have a destination anchor" });
          }
          if (!anchor.message?.trim()) {
            issues.push({ path: `${anchorPath}.message`, message: "message anchor requires message text" });
          }
          return;
        }
        if (anchor.message !== undefined) {
          issues.push({ path: anchorPath, message: "portal anchor cannot have a message" });
        }
        const destinations = manorAnchorDestinations(anchor);
        if (!anchor.destinationRoomId || !anchor.destinationAnchorId || destinations.length === 0) {
          issues.push({ path: anchorPath, message: "portal anchor requires a destination anchor" });
          return;
        }
        if (destinations[0]!.destinationRoomId !== anchor.destinationRoomId ||
          destinations[0]!.destinationAnchorId !== anchor.destinationAnchorId) {
          issues.push({ path: `${anchorPath}.destinations`, message: "must start with the anchor destination" });
        }
        if (!isIndoorNavigationPointWalkable(manorTemplateRoomNavigation(room), anchor)) {
          issues.push({ path: anchorPath, message: "portal movement and arrival anchor must be on the walkable floor" });
        }
        const seenDestinations = new Set<string>();
        destinations.forEach((target, targetIndex) => {
          const targetPath = anchor.destinations ? `${anchorPath}.destinations.${targetIndex}` : anchorPath;
          const key = `${target.destinationRoomId}:${target.destinationAnchorId}`;
          if (seenDestinations.has(key)) issues.push({ path: targetPath, message: "duplicate door destination" });
          seenDestinations.add(key);
          const destinationRoom = rooms.get(target.destinationRoomId);
          const destination = destinationRoom?.anchors.find((candidate) =>
            candidate.id === target.destinationAnchorId
          );
          if (!destinationRoom || destinationRoom.retired || !destinationRoom.active ||
            !destination || destination.retired) {
            issues.push({ path: `${targetPath}.destinationAnchorId`, message: "references an active anchor in this template" });
            return;
          }
          if (destination.type !== "portal") {
            issues.push({ path: `${targetPath}.destinationAnchorId`, message: "destination anchor must be a portal anchor" });
            return;
          }
          // The door on the other side leads back to this door (it may have other destinations too).
          if (!manorAnchorDestinations(destination).some((back) =>
            back.destinationRoomId === room.id && back.destinationAnchorId === anchor.id)) {
            issues.push({ path: targetPath, message: "portal pairing must be reciprocal" });
          }
          if (destinationRoom.id === room.id && destination.id === anchor.id) {
            issues.push({ path: targetPath, message: "portal anchor cannot pair with itself" });
          }
        });
      });
      room.colliders.forEach((collider, colliderIndex) => {
        const colliderPath = `${roomPath}.colliders.${colliderIndex}.points`;
        polygonGeometryIssues(collider.points, colliderPath, issues);
        if (!pointsInBounds(collider.points, room.width, room.height)) {
          issues.push({ path: colliderPath, message: "geometry is outside room bounds" });
        }
      });
      room.placementSurfaces.forEach((surface, surfaceIndex) => {
        const surfacePath = `${roomPath}.placementSurfaces.${surfaceIndex}`;
        const points = surface.kind === "floor" ? surface.polygon : surface.roomPolygon;
        polygonGeometryIssues(points, `${surfacePath}.${surface.kind === "floor" ? "polygon" : "roomPolygon"}`, issues);
        if (!pointsInBounds(points, room.width, room.height)) {
          issues.push({ path: surfacePath, message: "geometry is outside room bounds" });
        }
        if (surface.kind !== "floor") {
          if (surface.imagePolygon.length !== surface.roomPolygon.length) {
            issues.push({ path: `${surfacePath}.imagePolygon`, message: "must have one normalized point for each room polygon vertex" });
          }
          polygonGeometryIssues(
            surface.imagePolygon.map((point) => ({ x: point.u, y: point.v })),
            `${surfacePath}.imagePolygon`,
            issues
          );
          surface.imagePolygon.forEach((point, pointIndex) => {
            if (point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1) {
              issues.push({ path: `${surfacePath}.imagePolygon.${pointIndex}`, message: "u/v must be normalized between 0 and 1" });
            }
          });
          if (Math.abs(surface.transform.scaleU) <= 1e-12 || Math.abs(surface.transform.scaleV) <= 1e-12) {
            issues.push({ path: `${surfacePath}.transform`, message: "scaleU and scaleV must be nonzero" });
          }
        }
      });
      room.portalHotspots.forEach((hotspot, hotspotIndex) => {
        if (hotspot.retired) return;
        const hotspotPath = `${roomPath}.portalHotspots.${hotspotIndex}`;
        polygonGeometryIssues(hotspot.polygon, `${hotspotPath}.polygon`, issues);
        if (!pointsInBounds(hotspot.polygon, room.width, room.height)) {
          issues.push({ path: `${hotspotPath}.polygon`, message: "geometry is outside room bounds" });
        }
        if (!anchors.has(hotspot.anchorId) || anchors.get(hotspot.anchorId)?.retired) {
          issues.push({ path: `${hotspotPath}.anchorId`, message: "must bind to an active interaction anchor" });
        } else if (anchors.get(hotspot.anchorId)?.type === "spawn") {
          issues.push({ path: `${hotspotPath}.anchorId`, message: "must bind to an active interaction anchor" });
        }
      });
      if (!room.retired && room.active && spawn && !spawn.retired &&
        !isIndoorNavigationPointWalkable(manorTemplateRoomNavigation(room), spawn)) {
        issues.push({ path: `${roomPath}.spawnAnchorId`, message: "spawn must be inside a walkable floor surface" });
      }
    }
    template.decorations.forEach((decoration, decorationIndex) => {
      if (decoration.retired) return;
      const decorationPath = `${templatePath}.decorations.${decorationIndex}`;
      const room = rooms.get(decoration.roomId);
      if (!room || room.retired || !room.active) {
        issues.push({ path: `${decorationPath}.roomId`, message: "references an active room in this template" });
        return;
      }
      const surface = room.placementSurfaces.find((candidate) => candidate.id === decoration.surfaceId);
      if (!surface || surface.retired) {
        issues.push({ path: `${decorationPath}.surfaceId`, message: "references an active placement surface in its room" });
        return;
      }
      let item;
      if (decoration.itemId !== null) {
        try {
          item = requireInventoryCatalogItem(decoration.itemId);
        } catch {
          issues.push({ path: `${decorationPath}.itemId`, message: "must reference a canonical inventory item" });
        }
      }
      if (item && (!item.manorStorable || item.kind === "equipment" || !item.stackable)) {
        issues.push({
          path: `${decorationPath}.itemId`,
          message: "must reference a storable stackable or consumable inventory item"
        });
      }
      const shouldMirror = surface.kind === "right_wall";
      if (decoration.mirrorX !== shouldMirror) {
        issues.push({
          path: `${decorationPath}.mirrorX`,
          message: shouldMirror
            ? "right-wall art must mirror the left-authored PNG"
            : "only right-wall art may use horizontal mirroring"
        });
      }
      const footprint = manorDecorationFootprintInRoom(
        decoration,
        surface.kind === "right_wall" || decoration.mirrorX === true
      );
      polygonGeometryIssues(footprint, `${decorationPath}.footprint`, issues);
      const container = surface.kind === "floor" ? surface.polygon : surface.roomPolygon;
      if (!manorPolygonContainsPolygon(container, footprint)) {
        issues.push({ path: decorationPath, message: "transformed footprint must remain fully inside its placement surface" });
      }
    });
  }
  return issues;
}

function polygonGeometryIssues(
  points: readonly IndoorPoint[],
  path: string,
  issues: ManorCatalogValidationIssue[]
): void {
  for (const message of manorPolygonGeometryIssues(points)) issues.push({ path, message });
}

function pointsInBounds(points: readonly IndoorPoint[], width: number, height: number): boolean {
  return points.every((point) => pointInBounds(point, width, height));
}

function pointInBounds(point: IndoorPoint, width: number, height: number): boolean {
  return point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
}

function segmentsProperlyIntersect(
  a: IndoorPoint,
  b: IndoorPoint,
  c: IndoorPoint,
  d: IndoorPoint,
  epsilon: number
): boolean {
  const first = crossProduct(a, b, c);
  const second = crossProduct(a, b, d);
  const third = crossProduct(c, d, a);
  const fourth = crossProduct(c, d, b);
  return ((first > epsilon && second < -epsilon) || (first < -epsilon && second > epsilon)) &&
    ((third > epsilon && fourth < -epsilon) || (third < -epsilon && fourth > epsilon));
}

function segmentsIntersectForValidation(
  a: IndoorPoint,
  b: IndoorPoint,
  c: IndoorPoint,
  d: IndoorPoint
): boolean {
  const first = crossProduct(a, b, c);
  const second = crossProduct(a, b, d);
  const third = crossProduct(c, d, a);
  const fourth = crossProduct(c, d, b);
  if (Math.sign(first) !== Math.sign(second) && Math.sign(third) !== Math.sign(fourth) &&
    first !== 0 && second !== 0 && third !== 0 && fourth !== 0) return true;
  return first === 0 && onSegment(c, a, b) || second === 0 && onSegment(d, a, b) ||
    third === 0 && onSegment(a, c, d) || fourth === 0 && onSegment(b, c, d);
}

function crossProduct(a: IndoorPoint, b: IndoorPoint, c: IndoorPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(point: IndoorPoint, start: IndoorPoint, end: IndoorPoint): boolean {
  return point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x) &&
    point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y);
}

function pointSegmentDistance(point: IndoorPoint, start: IndoorPoint, end: IndoorPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const scalar = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  ));
  return Math.hypot(
    point.x - (start.x + scalar * dx),
    point.y - (start.y + scalar * dy)
  );
}

function samePoint(left: IndoorPoint, right: IndoorPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function duplicateIssues<T>(
  values: readonly T[],
  path: string,
  id: (value: T) => string,
  issues: ManorCatalogValidationIssue[]
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const valueId = id(value);
    if (seen.has(valueId)) issues.push({ path: `${path}.${index}.id`, message: `duplicate ID ${valueId}` });
    seen.add(valueId);
  });
}

function formatIssues(issues: readonly ManorCatalogValidationIssue[]): string {
  return `Invalid Manor template catalog: ${issues.map((issue) =>
    `${issue.path}: ${issue.message}`).join("; ")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

/** Read-only view over the Manor spaces of the unified interior data (`data/interiors/manor_*.json`). */
export const DEFAULT_MANOR_TEMPLATE_CATALOG = deepFreeze(
  validateManorTemplateCatalog(manorTemplateCatalogInputFromInterior(
    INTERIOR_DATA as unknown as Parameters<typeof manorTemplateCatalogInputFromInterior>[0]
  ))
);

/** Sub-schemas reused by the unified interior catalog (`interior/interiorCatalog.ts`). */
export const manorTemplateSchemaParts = {
  assetKeySchema,
  colorSchema,
  transformSchema,
  uvPointSchema,
  doorVisualSchema,
  decorationSchema
} as const;

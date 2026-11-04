import type { InteriorAnchor, InteriorCatalog, InteriorPrefab, InteriorRoom, InteriorSpace } from "./interiorCatalog.js";

/**
 * Project the Manor spaces of an interior catalog back into the raw Manor
 * template catalog shape (schema v3). `DEFAULT_MANOR_TEMPLATE_CATALOG` is
 * `validateManorTemplateCatalog(manorTemplateCatalogInputFromInterior(...))`,
 * so the Studio, client and server keep reading the shape they always did
 * while `data/interiors/<template>.json` is the single source of truth.
 *
 * Records the Manor transform adds on top of the legacy catalog (station
 * objects and their anchors/click areas) never appear in the view; the authored
 * world exit is projected as the room's `worldExit` door, and `modules.manor`
 * as the template's overworld `exterior`. Free of runtime imports so `manorTemplateCatalog.ts` can use it.
 */

type Point = { x: number; y: number };

const copyPoints = (points: readonly Point[]): Point[] => points.map((point) => ({ ...point }));

function rectanglePoints(x: number, y: number, width: number, height: number): Point[] {
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}

/** Space ids of every Manor template in an interior catalog, in catalog order. */
export function manorSpacesOf(catalog: Pick<InteriorCatalog, "spaces">): InteriorSpace[] {
  return catalog.spaces.filter((space) => space.kind === "manor");
}

/** The anchor a room's authored world-exit portal starts from (not part of the legacy Manor catalog). */
function worldExitAnchorIds(space: InteriorSpace, room: InteriorRoom): Set<string> {
  return new Set(space.portals.flatMap((portal) => portal.destination.kind === "world" &&
    portal.source.kind === "room" && portal.source.roomId === room.id ? [portal.source.anchorId] : []));
}

function manorAnchors(space: InteriorSpace, room: InteriorRoom): unknown[] {
  const exits = worldExitAnchorIds(space, room);
  return room.anchors.filter((anchor) => anchor.role !== "point" && !exits.has(anchor.id))
    .map((anchor: InteriorAnchor) => {
      // A door may lead to several rooms: one active portal record per destination, each with its typed label.
      const sourced = anchor.role === "portal"
        ? space.portals.filter((candidate) => candidate.source.kind === "room" &&
          candidate.source.roomId === room.id && candidate.source.anchorId === anchor.id &&
          candidate.destination.kind === "room")
        : [];
      const active = sourced.filter((candidate) => !candidate.retired);
      const routes = active.length > 0 ? active : sourced.slice(0, 1);
      const portal = routes[0];
      return {
        id: anchor.id,
        retired: anchor.retired,
        x: anchor.x,
        y: anchor.y,
        ...(anchor.facing !== undefined ? { facing: anchor.facing } : {}),
        type: anchor.role,
        ...(portal && portal.destination.kind === "room" ? {
          destinationRoomId: portal.destination.roomId,
          destinationAnchorId: portal.destination.anchorId,
          locked: !portal.enabled,
          destinations: routes.flatMap((route) => route.destination.kind === "room" ? [{
            destinationRoomId: route.destination.roomId,
            destinationAnchorId: route.destination.anchorId,
            label: route.interactionLabel.trim().slice(0, 80) || route.destination.roomId,
            locked: !route.enabled
          }] : [])
        } : {}),
        ...(anchor.message !== undefined ? { message: anchor.message } : {})
      };
    });
}

function placementSurfaces(room: InteriorRoom): unknown[] {
  const floors = room.floors.map((floor) => ({
    id: floor.id, retired: floor.retired, kind: "floor", polygon: copyPoints(floor.polygon)
  }));
  const walls = room.walls.map((wall) => ({
    id: wall.id,
    retired: wall.retired,
    kind: wall.kind,
    roomPolygon: copyPoints(wall.roomPolygon),
    imagePolygon: wall.imagePolygon.map((point) => ({ ...point })),
    transform: { ...wall.transform }
  }));
  const surfaces = [...floors, ...walls];
  if (!room.surfaceOrder) return surfaces;
  const rank = new Map(room.surfaceOrder.map((id, index) => [id, index]));
  return surfaces
    .map((surface, index) => ({ surface, index }))
    .sort((left, right) => (rank.get(left.surface.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.surface.id) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map((entry) => entry.surface);
}

/**
 * The room's floor picture: the background placement named `<room>_floor_art`
 * (what the Studio "Floor art" control writes), or one using a prefab of that
 * name; its prefab's PNG is the floor. Shared prefabs are fine (several rooms
 * may use the same PNG).
 */
export function manorRoomFloorAssetKey(room: InteriorRoom, prefabs: readonly InteriorPrefab[]): string | undefined {
  const floorId = `${room.id}_floor_art`;
  const placement = room.layers.background.find((candidate) => !candidate.retired && candidate.id === floorId) ??
    room.layers.background.find((candidate) => !candidate.retired && candidate.prefabId === floorId);
  return placement ? prefabs.find((prefab) => prefab.id === placement.prefabId)?.assetKey : undefined;
}

/** The room's authored door to the overworld (anchor plus its click area), when it has one. */
function manorWorldExit(space: InteriorSpace, room: InteriorRoom): Record<string, unknown> | null {
  const portal = space.portals.find((candidate) => !candidate.retired && candidate.destination.kind === "world" &&
    candidate.source.kind === "room" && candidate.source.roomId === room.id);
  if (!portal || portal.source.kind !== "room") return null;
  const anchorId = portal.source.anchorId;
  const anchor = room.anchors.find((candidate) => candidate.id === anchorId && !candidate.retired);
  if (!anchor) return null;
  const area = room.clickAreas.find((candidate) => !candidate.retired && "anchorId" in candidate.target &&
    candidate.target.anchorId === anchorId);
  return {
    anchorId,
    x: anchor.x,
    y: anchor.y,
    interactionLabel: area?.interactionLabel ?? portal.interactionLabel,
    label: portal.interactionLabel,
    polygon: area ? copyPoints(area.polygon) : null
  };
}

function manorRoomInput(space: InteriorSpace, room: InteriorRoom, prefabs: readonly InteriorPrefab[]): Record<string, unknown> {
  const exits = worldExitAnchorIds(space, room);
  const pointAnchors = new Set(room.anchors.filter((anchor) => anchor.role === "point").map((anchor) => anchor.id));
  const floorAssetKey = manorRoomFloorAssetKey(room, prefabs);
  const worldExit = manorWorldExit(space, room);
  return {
    id: room.id,
    revision: room.revision,
    retired: room.retired,
    name: room.name,
    active: room.active,
    themeId: room.environment.environmentId,
    ...(floorAssetKey ? { floorAssetKey } : {}),
    width: room.width,
    height: room.height,
    spatialProfileId: "standard_indoor_v1",
    spawnAnchorId: room.spawnAnchorId,
    camera: room.camera,
    colliders: room.colliders.map((collider) => ({
      id: collider.id,
      retired: collider.retired,
      kind: "polygon",
      points: collider.kind === "polygon"
        ? copyPoints(collider.points)
        : rectanglePoints(collider.x, collider.y, collider.width, collider.height)
    })),
    placementSurfaces: placementSurfaces(room),
    anchors: manorAnchors(space, room),
    portalHotspots: room.clickAreas.flatMap((area) => "anchorId" in area.target &&
      !exits.has(area.target.anchorId) && !pointAnchors.has(area.target.anchorId)
      ? [{
        id: area.id,
        retired: area.retired,
        polygon: copyPoints(area.polygon),
        anchorId: area.target.anchorId,
        interactionLabel: area.interactionLabel
      }]
      : []),
    ...(worldExit ? { worldExit } : {})
  };
}

function manorTemplateInput(space: InteriorSpace, prefabs: readonly InteriorPrefab[]): Record<string, unknown> {
  if (!space.publishedRevisionId) throw new Error(`Manor space ${space.id} has no publishedRevisionId`);
  const environment = space.environment;
  return {
    id: space.id,
    revision: space.revision,
    publishedRevisionId: space.publishedRevisionId,
    retired: space.retired,
    name: space.name,
    description: space.description,
    theme: {
      themeId: environment.environmentId,
      floorAssetKey: environment.floorAssetKey,
      backgroundColor: environment.backgroundColor,
      floorColor: environment.floorColor,
      wallColor: environment.wallColor
    },
    defaultRoomId: space.defaultRoomId,
    rooms: space.rooms.map((room) => manorRoomInput(space, room, prefabs)),
    doorVisual: space.doorVisual ?? null,
    exterior: space.modules?.manor
      ? { assetKey: space.modules.manor.exteriorAssetKey, scale: space.modules.manor.exteriorScale ?? 1 }
      : null,
    decorations: (space.modules?.decoration?.definitions ?? []).map((decoration) => ({ ...decoration }))
  };
}

/** The raw (pre-parse) Manor template catalog for the Manor spaces of an interior catalog. */
export function manorTemplateCatalogInputFromInterior(
  catalog: Pick<InteriorCatalog, "library" | "spaces">
): Record<string, unknown> {
  const spaces = manorSpacesOf(catalog);
  return {
    schemaVersion: 3,
    catalogRevision: Math.max(0, ...spaces.map((space) => space.catalogRevision ?? 0)),
    templates: spaces.map((space) => manorTemplateInput(space, catalog.library.prefabs))
  };
}

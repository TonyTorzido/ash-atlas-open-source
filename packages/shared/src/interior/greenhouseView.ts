import type { InteriorCatalog, InteriorPrefab, InteriorRoom, InteriorSpace } from "./interiorCatalog.js";

/**
 * Project the Greenhouse interior space back into the legacy Greenhouse Studio
 * catalog JSON shape (schema v4). `GREENHOUSE_STUDIO_CATALOG` is
 * `parseGreenhouseStudioCatalog(greenhouseStudioInputFromInterior(...))`, so
 * the Studio, client and server keep reading the shape they always did while
 * `data/interiors/greenhouse.json` is the single source of truth.
 *
 * Deliberately free of runtime imports from `greenhouseStudio.ts` (which
 * imports this module): only ids and prefab ids the transform emits are used.
 */

export const GREENHOUSE_POT_PREFAB_ID = "greenhouse_pot";
export const GREENHOUSE_WATER_TANK_PREFAB_ID = "greenhouse_water_tank";
export const GREENHOUSE_WATER_TANK_ART_PREFAB_ID = "greenhouse_water_tank_art";
export const GREENHOUSE_DOOR_PREFAB_ID = "greenhouse_door";

const REVISION_PATTERN = /^greenhouse-r(\d+)$/u;
const COMPAT_ANCHOR_PATTERN = /^greenhouse-main-anchor:.+:(\d+):(\d+)$/u;

type Point = { x: number; y: number };

/** Scales are recovered from placement/prefab sizes; trim float noise so authored values round-trip. */
function cleanScale(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function touchAreaOf(prefab: InteriorPrefab): unknown {
  const area = prefab.touchArea;
  if (!area) throw new Error(`Greenhouse prefab ${prefab.id} has no touch area`);
  return area.kind === "circle"
    ? { kind: "circle", radius: area.radius }
    : { kind: "polygon", points: area.points.map((point) => ({ ...point })) };
}

function templateOf(templateId: "pot" | "water_tank", prefab: InteriorPrefab): Record<string, unknown> {
  return {
    templateId,
    assetPath: prefab.assetKey,
    renderWidth: prefab.defaultWidth,
    renderHeight: prefab.defaultHeight,
    pivotX: prefab.pivotX,
    pivotY: prefab.pivotY,
    physicalFootprint: (prefab.footprint ?? []).map((point) => ({ ...point })),
    touchArea: touchAreaOf(prefab)
  };
}

function rectanglePoints(x: number, y: number, width: number, height: number): Point[] {
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}

export function greenhouseSpaceOf(catalog: Pick<InteriorCatalog, "spaces">): InteriorSpace {
  const space = catalog.spaces.find((candidate) => candidate.kind === "greenhouse");
  if (!space) throw new Error("Interior catalog has no greenhouse space");
  return space;
}

export function greenhouseRoomOf(space: InteriorSpace): InteriorRoom {
  const room = space.rooms.find((candidate) => candidate.id === space.defaultRoomId);
  if (!room) throw new Error(`Greenhouse space has no room ${space.defaultRoomId}`);
  return room;
}

/** The raw (pre-parse) Greenhouse Studio catalog for a greenhouse space and its library prefabs. */
export function greenhouseStudioInputFromInterior(
  space: InteriorSpace,
  prefabs: readonly InteriorPrefab[]
): Record<string, unknown> {
  const room = greenhouseRoomOf(space);
  const prefab = (id: string): InteriorPrefab => {
    const found = prefabs.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Greenhouse prefab ${id} is missing from the interior library`);
    return found;
  };
  const anchor = (id: string) => {
    const found = room.anchors.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Greenhouse anchor ${id} is missing`);
    return found;
  };
  const revision = REVISION_PATTERN.exec(space.revision);
  if (!revision) throw new Error(`Greenhouse space revision ${space.revision} is not greenhouse-r<number>`);
  const planters = space.modules?.planters;
  if (!planters) throw new Error("Greenhouse space has no planters module");

  const exitPortal = space.portals.find((portal) => !portal.retired && portal.destination.kind === "world" &&
    portal.source.kind === "room" && portal.source.roomId === room.id);
  if (!exitPortal || exitPortal.source.kind !== "room") throw new Error("Greenhouse space has no world exit portal");
  const exitAnchor = anchor(exitPortal.source.anchorId);
  const exitArea = room.clickAreas.find((area) => !area.retired && "anchorId" in area.target && area.target.anchorId === exitAnchor.id);
  if (!exitArea) throw new Error("Greenhouse exit has no click area");
  const door = prefab(GREENHOUSE_DOOR_PREFAB_ID);

  const tank = room.objects.find((object) => object.type === "water_tank" && !object.retired);
  if (!tank) throw new Error("Greenhouse room has no water tank object");
  const tankAnchor = anchor(tank.anchorId);
  const tankArtPlacement = room.layers.actors.find((placement) => placement.prefabId === GREENHOUSE_WATER_TANK_ART_PREFAB_ID);
  if (!tankArtPlacement) throw new Error("Greenhouse room has no water tank art");
  const tankArt = prefab(GREENHOUSE_WATER_TANK_ART_PREFAB_ID);

  const overlays = room.layers.above_player.map((placement) => {
    const source = prefab(placement.prefabId);
    return {
      overlayId: placement.id,
      assetPath: source.assetKey,
      x: placement.x,
      y: placement.y,
      width: source.defaultWidth,
      height: source.defaultHeight,
      rotationDeg: placement.rotationDeg,
      scaleX: cleanScale(placement.width / source.defaultWidth),
      scaleY: cleanScale(placement.height / source.defaultHeight),
      zIndex: placement.zIndex
    };
  });

  return {
    schemaVersion: 4,
    catalogRevision: Number(revision[1]),
    roomId: room.id,
    roomWidth: room.width,
    roomHeight: room.height,
    planterCapacity: planters.capacity,
    anchors: room.anchors.flatMap((candidate) => {
      const match = candidate.role === "point" && !candidate.retired ? COMPAT_ANCHOR_PATTERN.exec(candidate.id) : null;
      return match
        ? [{ anchorId: candidate.id, roomId: room.id, row: Number(match[1]), column: Number(match[2]), x: candidate.x, y: candidate.y }]
        : [];
    }),
    waterStorage: { anchorId: tankAnchor.id, roomId: room.id, x: tankAnchor.x, y: tankAnchor.y },
    waterStorageArt: {
      overlayId: tankArtPlacement.id,
      assetPath: tankArt.assetKey,
      x: tankArtPlacement.x,
      y: tankArtPlacement.y,
      width: tankArt.defaultWidth,
      height: tankArt.defaultHeight,
      rotationDeg: tankArtPlacement.rotationDeg,
      scaleX: cleanScale(tankArtPlacement.width / tankArt.defaultWidth),
      scaleY: cleanScale(tankArtPlacement.height / tankArt.defaultHeight),
      zIndex: tankArtPlacement.zIndex
    },
    overlays,
    geometry: {
      surfaces: [
        ...room.floors.filter((floor) => !floor.retired).map((floor) => ({
          surfaceId: floor.id, kind: "floor", points: floor.polygon.map((point) => ({ ...point }))
        })),
        ...room.walls.filter((wall) => !wall.retired).map((wall) => ({
          surfaceId: wall.id, kind: wall.kind, points: wall.roomPolygon.map((point) => ({ ...point }))
        }))
      ],
      colliders: room.colliders.filter((collider) => !collider.retired).map((collider) => ({
        colliderId: collider.id,
        points: collider.kind === "polygon"
          ? collider.points.map((point) => ({ ...point }))
          : rectanglePoints(collider.x, collider.y, collider.width, collider.height)
      })),
      exit: {
        anchorId: exitAnchor.id,
        assetPath: door.assetKey,
        x: exitAnchor.x,
        y: exitAnchor.y,
        renderWidth: door.defaultWidth,
        renderHeight: door.defaultHeight,
        pivotX: door.pivotX,
        pivotY: door.pivotY,
        touchArea: { kind: "polygon", points: exitArea.polygon.map((point) => ({ ...point })) }
      },
      templates: {
        pot: templateOf("pot", prefab(planters.potPrefabId)),
        waterTank: templateOf("water_tank", prefab(GREENHOUSE_WATER_TANK_PREFAB_ID))
      },
      stageArt: planters.stageArt.map((art) => ({
        cropId: art.cropId,
        stage: art.stage,
        artId: art.artId,
        assetPath: art.assetKey,
        pivotX: art.pivotX,
        pivotY: art.pivotY,
        offsetX: art.offsetX,
        offsetY: art.offsetY,
        scale: art.scale
      }))
    }
  };
}

/** Same as {@link greenhouseStudioInputFromInterior} for a whole interior catalog. */
export function greenhouseStudioInputFromCatalog(catalog: Pick<InteriorCatalog, "library" | "spaces">): Record<string, unknown> {
  return greenhouseStudioInputFromInterior(greenhouseSpaceOf(catalog), catalog.library.prefabs);
}

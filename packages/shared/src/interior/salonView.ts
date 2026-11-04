import { STANDARD_INDOOR_SPATIAL_PROFILE, type IndoorNavigationCollider, type IndoorPoint } from "../indoor.js";
import type { InteriorCatalog, InteriorRoom, InteriorSpace } from "./interiorCatalog.js";

/**
 * Project the Salon interior space (`data/interiors/salon.json`) into the
 * legacy `SALON_MAIN_ROOM` shape. Free of runtime imports from `salon.ts`,
 * which builds the read-only `SALON_MAIN_ROOM` view from it.
 */

export const SALON_CHAIR_OBJECT_ID = "salon_chair";

export function salonSpaceOf(catalog: Pick<InteriorCatalog, "spaces">): InteriorSpace {
  const space = catalog.spaces.find((candidate) => candidate.kind === "salon");
  if (!space) throw new Error("Interior catalog has no salon space");
  return space;
}

export function salonRoomOf(space: InteriorSpace): InteriorRoom {
  const room = space.rooms.find((candidate) => candidate.id === space.defaultRoomId);
  if (!room) throw new Error(`Salon space has no room ${space.defaultRoomId}`);
  return room;
}

export type SalonMainRoomView = Readonly<{
  spaceId: string;
  roomWidth: number;
  roomHeight: number;
  playerRadius: number;
  spawn: IndoorPoint;
  fixtures: Readonly<{
    chair: Readonly<{
      position: IndoorPoint;
      approachPosition: IndoorPoint;
      collider: Extract<IndoorNavigationCollider, { minX: number }>;
    }>;
  }>;
  colliders: readonly IndoorNavigationCollider[];
}>;

export function salonMainRoomFromInterior(space: InteriorSpace): SalonMainRoomView {
  const room = salonRoomOf(space);
  const anchor = (id: string): IndoorPoint => {
    const found = room.anchors.find((candidate) => candidate.id === id && !candidate.retired);
    if (!found) throw new Error(`Salon anchor ${id} is missing`);
    return Object.freeze({ x: found.x, y: found.y });
  };
  const chair = room.objects.find((object) => object.id === SALON_CHAIR_OBJECT_ID && !object.retired);
  if (!chair || !chair.approachAnchorId) throw new Error("Salon room has no salon chair object");
  const colliders = room.colliders.filter((collider) => !collider.retired).map((collider) => {
    if (collider.kind !== "rectangle") throw new Error(`Salon collider ${collider.id} must be a rectangle`);
    return Object.freeze({
      id: collider.id,
      minX: collider.x,
      maxX: collider.x + collider.width,
      minY: collider.y,
      maxY: collider.y + collider.height
    });
  });
  const chairCollider = colliders.find((collider) => collider.id === SALON_CHAIR_OBJECT_ID);
  if (!chairCollider) throw new Error("Salon room has no chair collider");
  return Object.freeze({
    spaceId: room.id,
    roomWidth: room.width,
    roomHeight: room.height,
    playerRadius: STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius,
    spawn: anchor(room.spawnAnchorId),
    fixtures: Object.freeze({
      chair: Object.freeze({
        position: anchor(chair.anchorId),
        approachPosition: anchor(chair.approachAnchorId),
        collider: chairCollider
      })
    }),
    colliders: Object.freeze(colliders)
  });
}

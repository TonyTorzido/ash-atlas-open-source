import {
  MANOR_BREEDER,
  MANOR_BREEDER_INTERACTION_RADIUS,
  MANOR_DOOR,
  MANOR_DOOR_INTERACTION_RADIUS,
  MANOR_INTERACTION_APPROACH_INSET,
  MANOR_JEWEL,
  MANOR_JEWEL_INTERACTION_RADIUS,
  MANOR_SMITH,
  MANOR_SMITH_INTERACTION_RADIUS,
  indoorInteractionApproachPoint,
  isIndoorInteractionInRange,
  manorLobbyStations,
  manorTypeSpace,
  worldExitOf,
  type ManorPosition
} from "@ash-atlas/shared";

export type ManorInteractionKind = "smith" | "jewel" | "breeder" | "door";

export type ManorInteractionIntent = {
  kind: ManorInteractionKind;
  phase: "moving" | "requesting";
  token: number;
  retryCount: number;
  minimumMovementSequence: number;
} | null;

export function manorInteractionInRange(
  kind: ManorInteractionKind,
  position: ManorPosition | null,
  manorTypeId?: string | null
): boolean {
  if (!position) return false;
  const { target, radius } = manorInteractionGeometry(kind, manorTypeId);
  return isIndoorInteractionInRange(position, target, radius);
}

export function manorInteractionApproachPoint(
  kind: ManorInteractionKind,
  position: ManorPosition | null,
  manorTypeId?: string | null
): [number, number] {
  const { target, radius } = manorInteractionGeometry(kind, manorTypeId);
  if (!position) return [target.x, target.y];
  const approach = indoorInteractionApproachPoint(
    position,
    target,
    radius,
    MANOR_INTERACTION_APPROACH_INSET
  );
  return [approach.x, approach.y];
}

/** Station and door points of the Manor type's authored lobby (legacy constants when a type lacks one). */
function manorInteractionGeometry(kind: ManorInteractionKind, manorTypeId?: string | null) {
  if (kind === "door") {
    const exit = worldExitOf(manorTypeSpace(manorTypeId));
    return { target: exit?.position ?? MANOR_DOOR, radius: MANOR_DOOR_INTERACTION_RADIUS };
  }
  const station = manorLobbyStations(manorTypeId)[kind];
  if (station) return { target: { x: station.x, y: station.y }, radius: station.radius };
  if (kind === "smith") return { target: MANOR_SMITH, radius: MANOR_SMITH_INTERACTION_RADIUS };
  if (kind === "jewel") return { target: MANOR_JEWEL, radius: MANOR_JEWEL_INTERACTION_RADIUS };
  return { target: MANOR_BREEDER, radius: MANOR_BREEDER_INTERACTION_RADIUS };
}

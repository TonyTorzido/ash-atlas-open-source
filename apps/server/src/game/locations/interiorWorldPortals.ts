import { worldExitOf, type InteriorSpace, type PortalDefinition } from "@ash-atlas/shared";

type PortalEndpoint = PortalDefinition["source"];
type Position = PortalDefinition["sourceApproach"];
type MakePortal = (definition: Omit<PortalDefinition, "portalId" | "revision" | "enabled">) => PortalDefinition;
type LocalEndpoint = (spaceId: string, x: number, y: number, facing?: number) => PortalEndpoint;

/**
 * Builds the world <-> room portal pair of an interior space from its authored
 * world-exit portal record (`space.portals`): the exit's door position and
 * label come from the data, and a player entering from the world arrives at
 * the room's spawn point. Runtime portal ids stay the registry's; only the
 * geometry is data-driven. Greenhouse, Manor and Salon share it.
 */
export function interiorWorldPortal(input: Readonly<{
  space: InteriorSpace;
  route: "world-to-main" | "main-to-world";
  /** Builds the final definition (portal id, revision, paired id are the registry's business). */
  make: MakePortal;
  world: PortalEndpoint;
  local: LocalEndpoint;
  worldApproach: Position;
  worldThreshold: Position;
  worldArrival: Position;
  /** Portal ids of the reciprocal routes. */
  pairedPortalId: string;
  accessPolicyId: string;
  /** `<prefix>/<space id>` is the preload scene key of the room. */
  sceneKeyPrefix: string;
  /** Legacy door facing used by the exterior portal marker. */
  facing?: number;
  /** Room holding the exit (default: the space's default room). */
  roomId?: string;
  /** Runtime interior space id of a room when it differs from the room id (legacy aliases). */
  spaceIdOf?: (roomId: string) => string;
  /** Label of the world entrance when it is not `Enter <space name>`. */
  enterLabel?: string;
  /** Inside approach point of the exit (default: the exit door itself). */
  roomApproach?: Position;
  /** `immediate` (default) lets the exit commit without walking to the door. */
  roomApproachPolicy?: "required" | "immediate";
  /** Arrival inside the room when it is not the room's spawn point. */
  roomArrival?: Position;
}>): PortalDefinition | null {
  const exit = worldExitOf(input.space, input.roomId);
  if (!exit) return null;
  const spaceId = input.spaceIdOf?.(exit.roomId) ?? exit.roomId;
  const door = input.local(spaceId, exit.position.x, exit.position.y, input.facing ?? exit.facing);
  if (input.route === "world-to-main") {
    return {
      ...input.make({
        source: input.world, destination: door, sourceApproach: input.worldApproach,
        sourceThreshold: input.worldThreshold, destinationArrival: input.roomArrival ?? exit.arrival,
        pairedPortalId: input.pairedPortalId,
        interactionLabel: input.enterLabel ?? `Enter ${input.space.name}`, transitionPresentation: exit.presentation,
        accessPolicyId: input.accessPolicyId, preloadSceneKey: `${input.sceneKeyPrefix}/${spaceId}`
      }),
      enabled: exit.enabled
    };
  }
  const policy = input.roomApproachPolicy ?? "immediate";
  return {
    ...input.make({
      source: door, destination: input.world, sourceApproach: input.roomApproach ?? exit.position,
      sourceThreshold: exit.position, destinationArrival: input.worldArrival,
      ...(policy === "immediate" ? { approachPolicy: "immediate" as const } : {}),
      pairedPortalId: input.pairedPortalId,
      interactionLabel: exit.interactionLabel, transitionPresentation: exit.presentation,
      preloadSceneKey: "world"
    }),
    enabled: exit.enabled
  };
}

/**
 * Builds the room <-> room portal of an interior space from its authored
 * portal record (`space.portals`, id `<room>-<anchor>`): positions and facing
 * come from the source/destination anchors, the label from the source room's
 * click area, and `enabled` from the record. Returns null unless both rooms
 * are active, the record is active and it has a valid reciprocal (a portal one
 * cannot walk back through never resolves).
 */
export function interiorRoomPortal(input: Readonly<{
  space: InteriorSpace;
  roomId: string;
  anchorId: string;
  /** Which destination of a door that leads to several rooms (default: its first). */
  destinationRoomId?: string;
  make: MakePortal;
  local: LocalEndpoint;
  /**
   * Portal id of the reciprocal route (from the destination room and arrival
   * anchor; `returnRoomId` is set when that door itself has several destinations).
   */
  pairedPortalId: (destinationRoomId: string, arrivalAnchorId: string, returnRoomId?: string) => string;
  /** Runtime interior space id of a room when it differs from the room id (legacy aliases). */
  spaceIdOf?: (roomId: string) => string;
  sceneKeyPrefix: string;
  /** Registry revision component (e.g. the placement revision). */
  revisionPrefix: string;
}>): PortalDefinition | null {
  const { space } = input;
  const room = space.rooms.find((candidate) => candidate.id === input.roomId && !candidate.retired && candidate.active);
  const routes = space.portals.filter((candidate) => !candidate.retired && candidate.source.kind === "room" &&
    candidate.source.roomId === input.roomId && candidate.source.anchorId === input.anchorId &&
    candidate.destination.kind === "room");
  const portal = input.destinationRoomId
    ? routes.find((candidate) => candidate.destination.kind === "room" && candidate.destination.roomId === input.destinationRoomId)
    : routes[0];
  if (!room || !portal || portal.destination.kind !== "room" || !portal.reciprocalPortalId) return null;
  const anchor = room.anchors.find((candidate) => candidate.id === input.anchorId && !candidate.retired && candidate.role === "portal");
  const target = portal.destination;
  const destinationRoom = space.rooms.find((candidate) =>
    candidate.id === target.roomId && !candidate.retired && candidate.active);
  const arrival = destinationRoom?.anchors.find((candidate) =>
    candidate.id === target.anchorId && !candidate.retired && candidate.role === "portal");
  if (!anchor || !destinationRoom || !arrival) return null;
  const from = input.local(input.spaceIdOf?.(room.id) ?? room.id, anchor.x, anchor.y, anchor.facing);
  const to = input.local(input.spaceIdOf?.(destinationRoom.id) ?? destinationRoom.id, arrival.x, arrival.y, arrival.facing);
  const position = from.position;
  // A multi-destination door names each destination by its typed portal label.
  const label = routes.length > 1 ? portal.interactionLabel
    : room.clickAreas.find((area) => !area.retired && "anchorId" in area.target && area.target.anchorId === anchor.id)
      ?.interactionLabel ?? destinationRoom.name;
  const returnRoutes = space.portals.filter((candidate) => !candidate.retired && candidate.source.kind === "room" &&
    candidate.source.roomId === destinationRoom.id && candidate.source.anchorId === arrival.id &&
    candidate.destination.kind === "room");
  return {
    ...input.make({
      source: from, destination: to, sourceApproach: position, sourceThreshold: position,
      destinationArrival: to.position,
      pairedPortalId: input.pairedPortalId(destinationRoom.id, arrival.id, returnRoutes.length > 1 ? room.id : undefined),
      interactionLabel: label, transitionPresentation: portal.presentation,
      preloadSceneKey: `${input.sceneKeyPrefix}/${(to as { spaceId: string }).spaceId}`
    }),
    enabled: portal.enabled,
    revision: `${input.revisionPrefix}:${space.revision}:${room.revision}:${destinationRoom.revision}`
  };
}

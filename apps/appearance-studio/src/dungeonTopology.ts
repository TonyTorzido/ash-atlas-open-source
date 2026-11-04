import {
  STANDARD_INDOOR_SPATIAL_PROFILE,
  findIndoorNavigationRoute,
  isIndoorNavigationPointWalkable,
  type DungeonAnchorDefinition,
  type DungeonDefinition,
  type DungeonPortalDefinition,
  type DungeonPrefabDefinition,
  type DungeonRoomDefinition,
  type IndoorRoomNavigation
} from "@ash-atlas/shared";
import { createDungeonObject } from "./dungeonStudioV2.js";

export type DungeonTopologyIssue = Readonly<{
  id: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  roomId?: string;
  anchorId?: string;
  portalId?: string;
}>;
export type DungeonTopologyPort = Readonly<{
  anchorId: string;
  label: string;
  anchor: DungeonAnchorDefinition;
  roles: readonly string[];
  connection: boolean;
  unused: boolean;
  issues: readonly DungeonTopologyIssue[];
}>;
export type DungeonTopologyRoom = Readonly<{
  roomId: string;
  name: string;
  room: DungeonRoomDefinition;
  ports: readonly DungeonTopologyPort[];
  start: boolean;
  exit: boolean;
  boss: boolean;
  reachable: boolean;
  encounterNames: readonly string[];
  issues: readonly DungeonTopologyIssue[];
}>;
export type DungeonTopologyEdge = Readonly<{
  portalId: string;
  portal: DungeonPortalDefinition;
  source: DungeonPortalDefinition["source"];
  destination: DungeonPortalDefinition["destination"];
  valid: boolean;
  /** Potential traversal after authored gates are satisfied, never proof that a gate is solvable. */
  traversable: boolean;
  oneWay: boolean;
  requirements: readonly string[];
  issues: readonly DungeonTopologyIssue[];
}>;
export type DungeonTopologyModel = Readonly<{
  rooms: readonly DungeonTopologyRoom[];
  edges: readonly DungeonTopologyEdge[];
  issues: readonly DungeonTopologyIssue[];
  startRoomId: string | null;
}>;
export type TopologyPoint = Readonly<{ x: number; y: number }>;
export type TopologyPositions = Readonly<Record<string, TopologyPoint>>;

/** Authored floor polygons of a room (interior floors). Absent: the whole room is walkable, as dungeons always were. */
export type DungeonFloorsOf = (room: DungeonRoomDefinition) => readonly (readonly TopologyPoint[])[] | undefined;

function navigation(room: DungeonRoomDefinition, floorsOf?: DungeonFloorsOf): IndoorRoomNavigation {
  const floors = floorsOf?.(room);
  return {
    roomWidth: room.width, roomHeight: room.height,
    playerRadius: STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius,
    ...(floors ? { walkableSurfaces: floors } : {}),
    colliders: room.colliders.filter((shape) => !shape.retired).map((shape) => shape.kind === "polygon"
      ? { id: shape.id, kind: "polygon" as const, points: shape.points }
      : { id: shape.id, minX: shape.x, maxX: shape.x + shape.width, minY: shape.y, maxY: shape.y + shape.height })
  };
}

function sameEndpoint(a: DungeonPortalDefinition["source"], b: DungeonPortalDefinition["source"]): boolean {
  return a.kind === b.kind && (a.kind === "world" || (b.kind === "room" && a.roomId === b.roomId && a.anchorId === b.anchorId));
}

function walk(graph: ReadonlyMap<string, readonly string[]>, start: readonly string[]): Set<string> {
  const seen = new Set(start);
  const pending = [...start];
  for (let index = 0; index < pending.length; index += 1) {
    for (const next of graph.get(pending[index]!) ?? []) if (!seen.has(next)) { seen.add(next); pending.push(next); }
  }
  return seen;
}

function friendlyToken(value: string): string {
  return value.replace(/[-_]+/gu, " ").replace(/^./u, (char) => char.toUpperCase());
}

export function dungeonAnchorLabel(dungeon: DungeonDefinition, room: DungeonRoomDefinition, anchor: DungeonAnchorDefinition): string {
  const object = room.objects.find((value) => !value.retired && value.anchorId === anchor.id);
  const mob = room.mobs.find((value) => !value.retired && value.anchorId === anchor.id);
  const role = dungeon.entrance.roomId === room.id && dungeon.entrance.arrivalAnchorId === anchor.id ? "Start arrival"
    : object?.name ?? (mob ? `${friendlyToken(mob.archetype)} spawn` : room.spawnAnchorId === anchor.id ? "Room spawn" : "Anchor");
  return `${role} · ${Math.round(anchor.x)}, ${Math.round(anchor.y)}`;
}

export function buildDungeonTopology(dungeon: DungeonDefinition): DungeonTopologyModel {
  const issues: DungeonTopologyIssue[] = [];
  const add = (code: string, severity: DungeonTopologyIssue["severity"], message: string,
    location: Omit<DungeonTopologyIssue, "id" | "code" | "severity" | "message"> = {}): void => {
    issues.push({ id: `${code}:${issues.length}`, code, severity, message, ...location });
  };
  const activeRooms = dungeon.rooms.filter((room) => !room.retired);
  const rooms = new Map(activeRooms.map((room) => [room.id, room]));
  const activePortals = dungeon.portals.filter((portal) => !portal.retired);
  const portals = new Map(activePortals.map((portal) => [portal.id, portal]));
  const navigations = new Map(activeRooms.map((room) => [room.id, navigation(room)]));
  const geometryChecks = new Map<string, "blocked_anchor" | "blocked_route" | null>();
  const duplicate = <T,>(values: readonly T[], id: (value: T) => string, report: (value: T) => void): void => {
    const seen = new Set<string>();
    for (const value of values) { if (seen.has(id(value))) report(value); seen.add(id(value)); }
  };
  duplicate(dungeon.rooms, (room) => room.id, (room) => add("duplicate_room", "error", `Room identifier is duplicated: ${room.name}.`, { roomId: room.id }));
  duplicate(dungeon.portals, (portal) => portal.id, (portal) => add("duplicate_portal", "error", `Connection identifier is duplicated: ${portal.interactionLabel}.`, { portalId: portal.id, ...(portal.source.kind === "room" ? { roomId: portal.source.roomId } : {}) }));
  for (const room of activeRooms) {
    duplicate(room.anchors, (anchor) => anchor.id, (anchor) => add("duplicate_anchor", "error", `${room.name} has duplicate anchor identifiers.`, { roomId: room.id, anchorId: anchor.id }));
    if (!room.active) add("inactive_room", "info", `${room.name} is inactive and excluded from playable routes.`, { roomId: room.id });
    for (const anchor of room.anchors.filter((value) => !value.retired)) {
      if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || anchor.x < 0 || anchor.x > room.width || anchor.y < 0 || anchor.y > room.height) {
        add("anchor_outside_room", "error", `An anchor in ${room.name} is outside the room bounds.`, { roomId: room.id, anchorId: anchor.id });
      }
    }
    if (!room.anchors.some((anchor) => !anchor.retired && anchor.id === room.spawnAnchorId)) add("missing_spawn", "error", `${room.name} has no valid room spawn anchor.`, { roomId: room.id });
  }
  const checkAnchor = (roomId: string, anchorId: string | undefined, role: string, portalId?: string, requireWalkable = false): boolean => {
    const location = { roomId, ...(anchorId ? { anchorId } : {}), ...(portalId ? { portalId } : {}) };
    const room = rooms.get(roomId);
    if (!room) { add("missing_room", "error", `${role} references a deleted or retired room.`, location); return false; }
    const anchor = room.anchors.find((value) => value.id === anchorId && !value.retired);
    if (!anchor) { add("missing_anchor", "error", `${role} in ${room.name} has no valid anchor.`, location); return false; }
    if (requireWalkable && room.active) {
      const key = `${roomId}:${anchor.id}`;
      if (!geometryChecks.has(key)) {
        const nav = navigations.get(roomId)!;
        const spawn = room.anchors.find((value) => value.id === room.spawnAnchorId && !value.retired);
        geometryChecks.set(key, !isIndoorNavigationPointWalkable(nav, anchor) ? "blocked_anchor"
          : spawn && !findIndoorNavigationRoute(nav, spawn, anchor) ? "blocked_route" : null);
      }
      const failure = geometryChecks.get(key);
      if (failure) {
        add(failure, "error", `${role} in ${room.name} ${failure === "blocked_anchor" ? "overlaps blocked geometry or the room boundary" : "cannot be reached from its spawn"}.`, location);
        return false;
      }
    }
    return true;
  };
  const start = rooms.get(dungeon.entrance.roomId);
  const startAnchorValid = checkAnchor(dungeon.entrance.roomId, dungeon.entrance.arrivalAnchorId, "Start arrival", undefined, true);
  const entrance = portals.get(dungeon.entrance.portalId);
  const validEntrance = entrance?.source.kind === "world" && entrance.destination.kind === "room"
    && entrance.destination.roomId === dungeon.entrance.roomId && entrance.destinationArrivalAnchorId === dungeon.entrance.arrivalAnchorId;
  const uniqueStart = !issues.some((issue) => (issue.code === "duplicate_room" && issue.roomId === dungeon.entrance.roomId)
    || (issue.code === "duplicate_anchor" && issue.roomId === dungeon.entrance.roomId && issue.anchorId === dungeon.entrance.arrivalAnchorId)
    || (issue.code === "duplicate_portal" && issue.portalId === dungeon.entrance.portalId));
  if (!start?.active || !startAnchorValid || !validEntrance || !uniqueStart) add("invalid_start", "error", "Start must identify one active room, a walkable arrival anchor, and its world entrance without duplicate identifiers.", { roomId: dungeon.entrance.roomId, ...(entrance ? { portalId: entrance.id } : {}) });
  if (entrance && !entrance.enabled) add("unbound_entrance", "info", "The world entrance is disabled. Local Play Test can still start at the authored Start.", { roomId: dungeon.entrance.roomId, portalId: entrance.id });
  const startRoomId = start?.active && startAnchorValid && validEntrance && uniqueStart ? start.id : null;
  const escape = portals.get(dungeon.escape.portalId);
  if (!escape || !escape.enabled || escape.source.kind !== "room" || escape.destination.kind !== "world") add("invalid_exit", "error", "The designated Exit must be an enabled room-to-world connection.", { ...(escape?.source.kind === "room" ? { roomId: escape.source.roomId } : {}), ...(escape ? { portalId: escape.id } : {}) });

  const edges = activePortals.map((portal): DungeonTopologyEdge => {
    const location = { portalId: portal.id, ...(portal.source.kind === "room" ? { roomId: portal.source.roomId, anchorId: portal.source.anchorId } : portal.destination.kind === "room" ? { roomId: portal.destination.roomId, anchorId: portal.destination.anchorId } : {}) };
    if (portal.source.kind === "world" && portal.destination.kind === "world") add("world_self_connection", "error", "A dungeon connection must touch a room.", location);
    if (portal.source.kind === "room") {
      checkAnchor(portal.source.roomId, portal.source.anchorId, "Source", portal.id);
      checkAnchor(portal.source.roomId, portal.sourceApproachAnchorId, "Approach", portal.id, portal.enabled);
      // The canonical catalog validates approach and arrival navigation. A threshold may sit in a doorway's wall geometry.
      checkAnchor(portal.source.roomId, portal.sourceThresholdAnchorId, "Threshold", portal.id);
      const room = rooms.get(portal.source.roomId);
      const objects = room?.objects.filter((object) => !object.retired && object.type === "portal" && object.portalId === portal.id) ?? [];
      if (portal.enabled && (objects.length !== 1 || !objects[0]?.available)) add("missing_portal_object", "error", `“${portal.interactionLabel}” needs exactly one available portal object in its source room.`, location);
      if (portal.enabled && room && !room.active) add("inactive_endpoint", "error", "An enabled connection leaves an inactive room.", location);
    }
    if (portal.destination.kind === "room") {
      checkAnchor(portal.destination.roomId, portal.destination.anchorId, "Destination", portal.id);
      checkAnchor(portal.destination.roomId, portal.destinationArrivalAnchorId, "Arrival", portal.id, portal.enabled);
      if (portal.enabled && rooms.get(portal.destination.roomId)?.active === false) add("inactive_endpoint", "error", "An enabled connection enters an inactive room.", { portalId: portal.id, roomId: portal.destination.roomId });
    }
    if (sameEndpoint(portal.source, portal.destination)) add("self_connection", "error", "A connection cannot lead back to the same anchor.", location);
    else if (portal.source.kind === "room" && portal.destination.kind === "room" && portal.source.roomId === portal.destination.roomId) add("same_room_connection", "warning", "This connection stays in the same room. Check that its teleport is intentional.", location);
    const reciprocal = portal.reciprocalPortalId ? portals.get(portal.reciprocalPortalId) : undefined;
    if (portal.reciprocalPortalId && (!reciprocal || reciprocal.reciprocalPortalId !== portal.id || !sameEndpoint(portal.source, reciprocal.destination) || !sameEndpoint(portal.destination, reciprocal.source))) {
      add("mismatched_reciprocal", "error", `“${portal.interactionLabel}” has a missing or mismatched return connection.`, location);
    }
    const reverse = activePortals.find((candidate) => candidate.id !== portal.id && candidate.enabled && sameEndpoint(portal.source, candidate.destination) && sameEndpoint(portal.destination, candidate.source));
    const requirements = portal.conditions.filter((condition) => condition !== "always").map(friendlyToken);
    if (portal.accessPolicyId) requirements.push(`Access policy: ${friendlyToken(portal.accessPolicyId)}`);
    for (const gate of portal.gates ?? []) requirements.push(gate.type === "item_owned" ? `${gate.quantity} × ${friendlyToken(gate.itemId)}` : `${gate.type === "quest_flag" ? "Quest" : "Dungeon"} flag: ${friendlyToken(gate.flagId)} = ${gate.value ? "on" : "off"}`);
    const locks = dungeon.encounters.filter((encounter) => !encounter.retired && encounter.lockPortalIds.includes(portal.id));
    requirements.push(...locks.map((encounter) => `Encounter lock: ${encounter.name}`));
    const triggerLock = dungeon.triggers.some((trigger) => !trigger.retired && trigger.enabled && trigger.actions.some((action) => action.type === "set_portal_locked" && action.portalId === portal.id));
    if (triggerLock) requirements.push("Trigger-controlled lock");
    const edgeIssues = issues.filter((issue) => issue.portalId === portal.id);
    const valid = !edgeIssues.some((issue) => issue.severity === "error")
      && !issues.some((issue) => issue.code === "duplicate_room" && ((portal.source.kind === "room" && issue.roomId === portal.source.roomId) || (portal.destination.kind === "room" && issue.roomId === portal.destination.roomId)))
      && !issues.some((issue) => issue.code === "duplicate_anchor" && ((portal.source.kind === "room" && issue.roomId === portal.source.roomId && issue.anchorId === portal.source.anchorId) || (portal.destination.kind === "room" && issue.roomId === portal.destination.roomId && issue.anchorId === portal.destination.anchorId)));
    return { portalId: portal.id, portal, source: portal.source, destination: portal.destination, valid, traversable: valid && portal.enabled,
      oneWay: !reverse, requirements, issues: edgeIssues };
  });

  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const weak = new Map<string, string[]>();
  const exits = new Set<string>();
  const append = (graph: Map<string, string[]>, a: string, b: string): void => { graph.set(a, [...(graph.get(a) ?? []), b]); };
  for (const edge of edges) {
    if (!edge.traversable || edge.source.kind !== "room") continue;
    if (edge.destination.kind === "world") { exits.add(edge.source.roomId); continue; }
    append(forward, edge.source.roomId, edge.destination.roomId);
    append(reverse, edge.destination.roomId, edge.source.roomId);
    append(weak, edge.source.roomId, edge.destination.roomId); append(weak, edge.destination.roomId, edge.source.roomId);
  }
  const reachable = startRoomId ? walk(forward, [startRoomId]) : new Set<string>();
  const recovery = walk(reverse, [...exits]);
  const connected = startRoomId ? walk(weak, [startRoomId]) : new Set<string>();
  for (const room of activeRooms.filter((value) => value.active)) {
    if (startRoomId && !reachable.has(room.id)) add(connected.has(room.id) ? "directed_unreachable" : "disconnected_room", "error", `${room.name} ${connected.has(room.id) ? "cannot be reached in the authored travel direction" : "is disconnected from Start"}.`, { roomId: room.id });
    if (!recovery.has(room.id)) add("no_recovery", "error", `${room.name} has no usable return path to the world.`, { roomId: room.id });
    const outgoing = forward.get(room.id) ?? [];
    if (reachable.has(room.id) && !exits.has(room.id) && outgoing.length === 1) add("branch_end", "info", `${room.name} ends a branch with one way onward or back.`, { roomId: room.id });
  }
  if (startRoomId && escape?.source.kind === "room" && !reachable.has(escape.source.roomId)) add("unreachable_exit", "error", "The designated Exit cannot be reached from Start.", { roomId: escape.source.roomId, portalId: escape.id });
  for (const encounter of dungeon.encounters.filter((value) => !value.retired)) {
    if (!rooms.has(encounter.roomId)) add("missing_encounter_room", "error", `Encounter “${encounter.name}” references a deleted room.`, { roomId: encounter.roomId });
    else if (startRoomId && !reachable.has(encounter.roomId)) add(encounter.bossTemplateId ? "unreachable_boss" : "unreachable_encounter", "error", `${encounter.bossTemplateId ? "Boss" : "Encounter"} “${encounter.name}” cannot be reached from Start.`, { roomId: encounter.roomId });
  }
  for (const trigger of dungeon.triggers.filter((value) => !value.retired)) {
    for (const reference of [trigger.event, ...trigger.conditions.items, ...trigger.actions]) {
      if ("roomId" in reference && !rooms.has(reference.roomId)) add("missing_trigger_room", "error", "A room trigger references a deleted or retired room.", { roomId: reference.roomId });
    }
  }
  for (const room of activeRooms) {
    const unused = room.anchors.filter((anchor) => !anchor.retired && anchor.id !== room.spawnAnchorId
      && !(room.id === dungeon.entrance.roomId && anchor.id === dungeon.entrance.arrivalAnchorId)
      && !(room.id === dungeon.deathRecovery.roomId && anchor.id === dungeon.deathRecovery.anchorId)
      && !room.objects.some((object) => !object.retired && object.anchorId === anchor.id)
      && !room.mobs.some((mob) => !mob.retired && mob.anchorId === anchor.id)
      && !room.resourceNodes?.some((node) => !node.retired && node.anchorId === anchor.id)
      && !activePortals.some((portal) => (portal.source.kind === "room" && portal.source.roomId === room.id && [portal.source.anchorId, portal.sourceApproachAnchorId, portal.sourceThresholdAnchorId].includes(anchor.id))
        || (portal.destination.kind === "room" && portal.destination.roomId === room.id && [portal.destination.anchorId, portal.destinationArrivalAnchorId].includes(anchor.id))));
    if (unused.length) add("unused_anchors", "warning", `${room.name} has ${unused.length} unused anchor${unused.length === 1 ? "" : "s"}.`, { roomId: room.id, anchorId: unused[0]!.id });
  }
  if (edges.some((edge) => edge.requirements.length > 0)) add("conditional_routes", "info", "Routes assume authored locks and requirements can be satisfied. Key and quest progression is not proven by topology.");

  return {
    startRoomId, edges, issues,
    rooms: activeRooms.map((room): DungeonTopologyRoom => {
      const encounters = dungeon.encounters.filter((value) => !value.retired && value.roomId === room.id);
      const roomIssues = issues.filter((issue) => issue.roomId === room.id || edges.some((edge) => edge.portalId === issue.portalId && edge.destination.kind === "room" && edge.destination.roomId === room.id));
      return {
        roomId: room.id, name: room.name, room, start: room.id === dungeon.entrance.roomId,
        exit: edges.some((edge) => edge.source.kind === "room" && edge.source.roomId === room.id && edge.destination.kind === "world"),
        boss: encounters.some((value) => Boolean(value.bossTemplateId)), reachable: reachable.has(room.id), encounterNames: encounters.map((value) => value.name), issues: roomIssues,
        ports: room.anchors.filter((anchor) => !anchor.retired).map((anchor): DungeonTopologyPort => {
          const roles: string[] = [];
          const related = activePortals.filter((portal) => (portal.source.kind === "room" && portal.source.roomId === room.id && [portal.source.anchorId, portal.sourceApproachAnchorId, portal.sourceThresholdAnchorId].includes(anchor.id)) || (portal.destination.kind === "room" && portal.destination.roomId === room.id && [portal.destination.anchorId, portal.destinationArrivalAnchorId].includes(anchor.id)));
          if (room.id === dungeon.entrance.roomId && anchor.id === dungeon.entrance.arrivalAnchorId) roles.push("Start arrival");
          if (room.spawnAnchorId === anchor.id) roles.push("Room spawn");
          if (room.id === dungeon.deathRecovery.roomId && dungeon.deathRecovery.anchorId === anchor.id) roles.push("Death recovery");
          if (related.some((portal) => portal.source.kind === "room" && portal.source.roomId === room.id && portal.sourceApproachAnchorId === anchor.id)) roles.push("Approach");
          if (related.some((portal) => portal.source.kind === "room" && portal.source.roomId === room.id && portal.sourceThresholdAnchorId === anchor.id)) roles.push("Threshold");
          if (related.some((portal) => portal.destination.kind === "room" && portal.destination.roomId === room.id && portal.destinationArrivalAnchorId === anchor.id)) roles.push("Arrival");
          if (room.objects.some((object) => !object.retired && object.anchorId === anchor.id)) roles.push("Object");
          if (room.mobs.some((mob) => !mob.retired && mob.anchorId === anchor.id)) roles.push("Mob spawn");
          if (room.resourceNodes?.some((node) => !node.retired && node.anchorId === anchor.id)) roles.push("Resource");
          return { anchorId: anchor.id, anchor, label: dungeonAnchorLabel(dungeon, room, anchor), roles,
            connection: related.length > 0, unused: roles.length === 0 && related.length === 0,
            issues: roomIssues.filter((issue) => issue.anchorId === anchor.id && issue.roomId === room.id) };
        })
      };
    })
  };
}

export type DungeonTopologyRoute = Readonly<{
  roomIds: readonly string[];
  portalIds: readonly string[];
  distance: number | null;
  alternativeCount: number;
  conditional: boolean;
}>;

/** Highlights every shortest directed route without enumerating exponentially many paths. */
export function findDungeonTopologyRoute(model: DungeonTopologyModel, targetRoomId: string): DungeonTopologyRoute {
  const empty: DungeonTopologyRoute = { roomIds: [], portalIds: [], distance: null, alternativeCount: 0, conditional: false };
  if (!model.startRoomId || !model.rooms.some((room) => room.roomId === targetRoomId && room.room.active)) return empty;
  const distance = new Map<string, number>([[model.startRoomId, 0]]);
  const counts = new Map<string, number>([[model.startRoomId, 1]]);
  const parents = new Map<string, DungeonTopologyEdge[]>();
  const outgoing = new Map<string, DungeonTopologyEdge[]>();
  for (const edge of model.edges) if (edge.traversable && edge.source.kind === "room" && edge.destination.kind === "room") outgoing.set(edge.source.roomId, [...(outgoing.get(edge.source.roomId) ?? []), edge]);
  const pending = [model.startRoomId];
  for (let i = 0; i < pending.length; i += 1) {
    const roomId = pending[i]!;
    for (const edge of outgoing.get(roomId) ?? []) {
      if (edge.destination.kind !== "room") continue;
      const next = edge.destination.roomId;
      const nextDistance = distance.get(roomId)! + 1;
      if (!distance.has(next)) { distance.set(next, nextDistance); pending.push(next); }
      if (distance.get(next) === nextDistance) {
        parents.set(next, [...(parents.get(next) ?? []), edge]);
        counts.set(next, Math.min(999, (counts.get(next) ?? 0) + (counts.get(roomId) ?? 0)));
      }
    }
  }
  if (!distance.has(targetRoomId)) return empty;
  const roomIds = new Set([targetRoomId]);
  const portalIds = new Set<string>();
  const trace = [targetRoomId];
  let conditional = false;
  for (let i = 0; i < trace.length; i += 1) for (const edge of parents.get(trace[i]!) ?? []) {
    portalIds.add(edge.portalId); conditional ||= edge.requirements.length > 0;
    if (edge.source.kind === "room" && !roomIds.has(edge.source.roomId)) { roomIds.add(edge.source.roomId); trace.push(edge.source.roomId); }
  }
  return { roomIds: [...roomIds], portalIds: [...portalIds], distance: distance.get(targetRoomId)!, alternativeCount: counts.get(targetRoomId) ?? 1, conditional };
}

export const TOPOLOGY_NODE_WIDTH = 260;
/** Shared with the graph's CSS variables so touch targets, ports and fit bounds have one geometry. */
export const TOPOLOGY_NODE_HEADER_HEIGHT = 87;
export const TOPOLOGY_NODE_META_HEIGHT = 44;
export const TOPOLOGY_PORT_HEIGHT = 44;
export const TOPOLOGY_MORE_HEIGHT = 44;
const TOPOLOGY_NODE_BORDER = 1;
export function visibleTopologyPorts(room: DungeonTopologyRoom, all: boolean): readonly DungeonTopologyPort[] {
  return all ? room.ports : room.ports.filter((port) => port.connection || port.roles.includes("Room spawn") || port.roles.includes("Start arrival") || port.issues.length > 0);
}
export function topologyNodeHeight(room: DungeonTopologyRoom, all: boolean): number {
  const count = visibleTopologyPorts(room, all).length;
  return TOPOLOGY_NODE_BORDER * 2 + TOPOLOGY_NODE_HEADER_HEIGHT + TOPOLOGY_NODE_META_HEIGHT
    + count * TOPOLOGY_PORT_HEIGHT + (count < room.ports.length ? TOPOLOGY_MORE_HEIGHT : 0);
}

export function topologyPortPoint(room: DungeonTopologyRoom, position: TopologyPoint, anchorId: string, outgoing: boolean, all: boolean): TopologyPoint {
  const portIndex = visibleTopologyPorts(room, all).findIndex((port) => port.anchorId === anchorId);
  return { x: position.x + (outgoing ? TOPOLOGY_NODE_WIDTH : 0), y: position.y + TOPOLOGY_NODE_BORDER
    + (portIndex < 0 ? TOPOLOGY_NODE_HEADER_HEIGHT / 2 : TOPOLOGY_NODE_HEADER_HEIGHT + TOPOLOGY_NODE_META_HEIGHT + (portIndex + 0.5) * TOPOLOGY_PORT_HEIGHT) };
}

export function layoutDungeonTopology(model: DungeonTopologyModel, allAnchors = false): TopologyPositions {
  const positions: Record<string, TopologyPoint> = {};
  const depths = new Map<string, number>();
  if (model.startRoomId) {
    depths.set(model.startRoomId, 0);
    const pending = [model.startRoomId];
    for (let i = 0; i < pending.length; i += 1) for (const edge of model.edges) {
      if (!edge.traversable || edge.source.kind !== "room" || edge.destination.kind !== "room" || edge.source.roomId !== pending[i] || depths.has(edge.destination.roomId)) continue;
      depths.set(edge.destination.roomId, depths.get(edge.source.roomId)! + 1); pending.push(edge.destination.roomId);
    }
  }
  const disconnectedDepth = Math.max(0, ...depths.values()) + 1;
  const vertical = new Map<number, number>();
  for (const room of model.rooms) {
    const depth = depths.get(room.roomId) ?? disconnectedDepth;
    const y = vertical.get(depth) ?? 70;
    positions[room.roomId] = { x: 180 + depth * 390, y };
    vertical.set(depth, y + topologyNodeHeight(room, allAnchors) + 64);
  }
  return positions;
}

function uniqueId(base: string, existing: readonly string[]): string {
  let id = base; let index = 2;
  while (existing.includes(id)) id = `${base}_${index++}`;
  return id;
}

export type DungeonConnectionOptions = Readonly<{
  /** Studio room drafts may be inactive; topology edits only connect active rooms. */
  requireActive?: boolean;
  label?: string;
  reverseLabel?: string;
  presentation?: DungeonPortalDefinition["presentation"];
  conditions?: DungeonPortalDefinition["conditions"];
  gates?: DungeonPortalDefinition["gates"];
  portalIds?: Readonly<{ forward: string; reverse?: string }>;
  /** Walkable/reachable checks use these floors (interior spaces) instead of the whole room. */
  floorsOf?: DungeonFloorsOf;
}>;

function connectableRoom(dungeon: DungeonDefinition, roomId: string, requireActive: boolean): DungeonRoomDefinition | undefined {
  return dungeon.rooms.find((value) => value.id === roomId && !value.retired && (!requireActive || value.active));
}

function walkableFromSpawn(room: DungeonRoomDefinition, point: TopologyPoint, floorsOf?: DungeonFloorsOf): boolean {
  const spawn = room.anchors.find((value) => value.id === room.spawnAnchorId && !value.retired);
  const nav = navigation(room, floorsOf);
  return isIndoorNavigationPointWalkable(nav, point) && Boolean(spawn) && Boolean(findIndoorNavigationRoute(nav, spawn!, point));
}

/**
 * Returns `preferred` (default: room center) when a player can stand there and walk to it from the
 * room spawn, otherwise the nearest such point on a coarse grid; null when the room has none.
 */
export function findWalkableAnchorPoint(room: DungeonRoomDefinition, preferred?: TopologyPoint, floorsOf?: DungeonFloorsOf): TopologyPoint | null {
  const origin = preferred ?? { x: room.width / 2, y: room.height / 2 };
  if (walkableFromSpawn(room, origin, floorsOf)) return { x: origin.x, y: origin.y };
  const step = Math.max(20, Math.min(room.width, room.height) / 40);
  const candidates: TopologyPoint[] = [];
  for (let x = 0; x <= room.width; x += step) for (let y = 0; y <= room.height; y += step) candidates.push({ x, y });
  candidates.sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y));
  return candidates.find((point) => walkableFromSpawn(room, point, floorsOf)) ?? null;
}

/** Shared portal-pair creation for anchor-to-anchor and room-to-room connections. */
function linkDungeonAnchors(dungeon: DungeonDefinition, source: { roomId: string; anchorId: string },
  destination: { roomId: string; anchorId: string }, prefab: DungeonPrefabDefinition | null, bidirectional: boolean,
  options: DungeonConnectionOptions = {}): { forwardId: string; reverseId: string | null } {
  if (source.roomId === destination.roomId) throw new Error("Choose an anchor in another room.");
  if (prefab && (prefab.retired || prefab.type !== "portal")) throw new Error("Choose an available portal artwork prefab.");
  const requireActive = options.requireActive ?? true;
  const endpoints = [source, destination].map((endpoint) => {
    const room = connectableRoom(dungeon, endpoint.roomId, requireActive);
    const anchor = room?.anchors.find((value) => value.id === endpoint.anchorId && !value.retired);
    if (!room || !anchor) throw new Error(requireActive ? "Both anchors must belong to active rooms." : "Both anchors must belong to available rooms.");
    if (!walkableFromSpawn(room, anchor, options.floorsOf)) throw new Error(`${room.name}: choose a walkable anchor reachable from the room spawn.`);
    return { room, anchor };
  });
  const from = endpoints[0]!; const to = endpoints[1]!;
  const a = { kind: "room" as const, ...source }; const b = { kind: "room" as const, ...destination };
  if (dungeon.portals.some((portal) => !portal.retired && (sameEndpoint(portal.source, a) && sameEndpoint(portal.destination, b)
    || bidirectional && sameEndpoint(portal.source, b) && sameEndpoint(portal.destination, a)))) throw new Error("These anchors already have that connection. Select its edge to inspect it.");
  const forwardId = options.portalIds?.forward ?? uniqueId(`${source.roomId}_to_${destination.roomId}`, dungeon.portals.map((portal) => portal.id));
  const reverseId = bidirectional ? options.portalIds?.reverse ?? uniqueId(`${destination.roomId}_to_${source.roomId}`, [...dungeon.portals.map((portal) => portal.id), forwardId]) : null;
  const add = (room: DungeonRoomDefinition, target: DungeonRoomDefinition, start: typeof a, end: typeof b, id: string, reciprocalId: string | null, label: string | undefined): void => {
    const interactionLabel = label ?? `Go to ${target.name}`;
    dungeon.portals.push({ id, retired: false, source: start, destination: end, sourceApproachAnchorId: start.anchorId,
      sourceThresholdAnchorId: start.anchorId, destinationArrivalAnchorId: end.anchorId, ...(reciprocalId ? { reciprocalPortalId: reciprocalId } : {}),
      conditions: options.conditions ? [...options.conditions] : ["always"],
      ...(options.gates ? { gates: structuredClone(options.gates) } : {}),
      interactionLabel, presentation: options.presentation ?? "door", preloadSceneKey: `${dungeon.id}/${target.id}`, enabled: true });
    if (!prefab) return;
    const unused = room.objects.find((object) => !object.retired && object.type === "portal" && object.anchorId === start.anchorId && !object.portalId);
    if (unused) { unused.portalId = id; unused.available = true; }
    else room.objects.push(createDungeonObject(prefab, uniqueId(`${id}_object`, room.objects.map((object) => object.id)), start.anchorId, interactionLabel, id));
  };
  add(from.room, to.room, a, b, forwardId, reverseId, options.label);
  if (reverseId) add(to.room, from.room, b, a, reverseId, forwardId, options.reverseLabel);
  return { forwardId, reverseId };
}

/** Mutates an editor draft only. New links get the real source objects required by the portal registry. */
export function connectDungeonAnchors(dungeon: DungeonDefinition, source: { roomId: string; anchorId: string },
  destination: { roomId: string; anchorId: string }, prefab: DungeonPrefabDefinition, bidirectional: boolean): string {
  return linkDungeonAnchors(dungeon, source, destination, prefab, bidirectional).forwardId;
}

export type DungeonRoomEndpointInput = Readonly<{ roomId: string; anchorId?: string; point?: TopologyPoint }>;
export type DungeonRoomConnection = Readonly<{
  portalId: string;
  reciprocalPortalId: string | null;
  sourceObjectId: string;
  sourceAnchorId: string;
  destinationAnchorId: string;
}>;

/**
 * Connects two rooms with a door pair. Each end uses an existing anchor, a new anchor at a given
 * point, or an automatically chosen walkable point. Every anchor is guaranteed walkable and reachable
 * from its room spawn (a bad explicit point throws instead of producing an unusable door).
 */
export function connectDungeonRooms(dungeon: DungeonDefinition, source: DungeonRoomEndpointInput, destination: DungeonRoomEndpointInput,
  prefab: DungeonPrefabDefinition | null, bidirectional: boolean, options: DungeonConnectionOptions = {}): DungeonRoomConnection {
  const requireActive = options.requireActive ?? false;
  const sourceRoom = connectableRoom(dungeon, source.roomId, requireActive);
  const destinationRoom = connectableRoom(dungeon, destination.roomId, requireActive);
  if (!sourceRoom || !destinationRoom || sourceRoom.id === destinationRoom.id) throw new Error("Choose two different available rooms to connect.");
  const forwardId = options.portalIds?.forward ?? uniqueId(`${sourceRoom.id}_to_${destinationRoom.id}`, dungeon.portals.map((portal) => portal.id));
  const reverseId = bidirectional ? options.portalIds?.reverse ?? uniqueId(`${destinationRoom.id}_to_${sourceRoom.id}`, [...dungeon.portals.map((portal) => portal.id), forwardId]) : undefined;
  const resolve = (room: DungeonRoomDefinition, endpoint: DungeonRoomEndpointInput, anchorBase: string): { anchorId: string; created: TopologyPoint | null } => {
    if (endpoint.anchorId) {
      if (!room.anchors.some((anchor) => anchor.id === endpoint.anchorId && !anchor.retired)) throw new Error(`${room.name}: anchor ${endpoint.anchorId} does not exist.`);
      return { anchorId: endpoint.anchorId, created: null };
    }
    let point: TopologyPoint | null;
    if (endpoint.point) {
      if (!walkableFromSpawn(room, endpoint.point, options.floorsOf)) throw new Error(`${room.name}: (${Math.round(endpoint.point.x)}, ${Math.round(endpoint.point.y)}) is not a walkable spot reachable from the room spawn.`);
      point = endpoint.point;
    } else {
      point = findWalkableAnchorPoint(room, undefined, options.floorsOf);
      if (!point) throw new Error(`${room.name}: no walkable spot was found for a door.`);
    }
    return { anchorId: uniqueId(anchorBase, room.anchors.map((anchor) => anchor.id)), created: point };
  };
  const from = resolve(sourceRoom, source, `${forwardId}_anchor`);
  const to = resolve(destinationRoom, destination, `${forwardId}_arrival`);
  if (from.created) sourceRoom.anchors.push({ id: from.anchorId, retired: false, ...from.created });
  if (to.created) destinationRoom.anchors.push({ id: to.anchorId, retired: false, ...to.created });
  try {
    const linked = linkDungeonAnchors(dungeon, { roomId: sourceRoom.id, anchorId: from.anchorId }, { roomId: destinationRoom.id, anchorId: to.anchorId },
      prefab, bidirectional, { ...options, requireActive, portalIds: { forward: forwardId, ...(reverseId ? { reverse: reverseId } : {}) } });
    const sourceObject = sourceRoom.objects.find((object) => !object.retired && object.portalId === linked.forwardId);
    return { portalId: linked.forwardId, reciprocalPortalId: linked.reverseId, sourceObjectId: sourceObject?.id ?? "", sourceAnchorId: from.anchorId, destinationAnchorId: to.anchorId };
  } catch (error) {
    if (from.created) sourceRoom.anchors.pop();
    if (to.created) destinationRoom.anchors.pop();
    throw error;
  }
}

/** Retires a portal record (and unpairs its reciprocal, retires its encounter locks and door objects). Nothing is deleted: published ids stay. */
export function retireDungeonPortalConnection(dungeon: DungeonDefinition, portalId: string): void {
  const portal = dungeon.portals.find((candidate) => candidate.id === portalId);
  if (!portal) return;
  portal.retired = true;
  portal.enabled = false;
  for (const candidate of dungeon.portals) {
    if (candidate.id !== portalId && candidate.reciprocalPortalId === portalId) delete candidate.reciprocalPortalId;
  }
  for (const encounter of dungeon.encounters) {
    encounter.lockPortalIds = encounter.lockPortalIds.filter((candidate) => candidate !== portalId);
  }
  for (const room of dungeon.rooms) for (const object of room.objects) {
    if (object.portalId === portalId) { object.retired = true; object.available = false; }
  }
}

/** True when a player can stand at `point` in the room (bounds and colliders, not spawn reachability). */
export function isDungeonRoomPointWalkable(room: DungeonRoomDefinition, point: TopologyPoint): boolean {
  return isIndoorNavigationPointWalkable(navigation(room), point);
}

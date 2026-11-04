import {
  CISTERN_WARRENS_DUNGEON,
  DUNGEON_CATALOG,
  destinationPoint,
  dungeonAnchorDefinition,
  findDeveloperDungeonEntranceTemplate,
  manorTypeSpace,
  worldExitOf,
  SALON_DOOR,
  SALON_INTERIOR_SPACE,
  GREENHOUSE_INTERIOR_SPACE,
  manorAuthoredPortalId,
  manorAuthoredSpaceId,
  portalIds,
  type PlayerLocationSnapshot,
  type PortalDefinition,
  type DungeonCatalog,
  type DungeonDefinition,
  type DungeonEntranceDefinition,
  type LatLon
} from "@ash-atlas/shared";
import { drownedCityEntranceAt, drownedCityPortalRevision } from "../drownedCityEntrances.js";
import { golemForgeSiteEntrance, golemForgeSitePortalRevision } from "../golemForgeSites.js";
import { worldDungeonEntranceAt, worldDungeonEntrancePortalRevision } from "../worldDungeonEntrances.js";
import type pg from "pg";
import { boundedPortalRevision } from "./portalRevision.js";
import { interiorRoomPortal, interiorWorldPortal } from "./interiorWorldPortals.js";

import { packageIdForPosition } from "../spatialZones.js";
import type { DeveloperSpawnedDungeonEntrance, DeveloperSpawnedDungeonService } from "../developerSpawnedDungeons.js";
import { PortalRegistry } from "./portalRegistry.js";

type Exterior = {
  locationType: "manor" | "salon" | "cistern_warrens" | "greenhouse";
  locationId: string;
  instanceId: string;
  regionCode: string;
  center: { lat: number; lon: number };
  footprintRadiusM: number;
  revision: string;
  /** Manor type of a Manor exterior (rooms, doors and exit come from that type's interior space). */
  manorTypeId?: string;
};

export function createAshAtlasPortalRegistry(
  pool: pg.Pool,
  options: Readonly<{
    catalog?: DungeonCatalog;
    partyIdForPlayer?: (playerId: string) => string | null;
    developerSpawnedDungeons?: DeveloperSpawnedDungeonService;
    /** Drowned City site position when it stands on coastal ocean (fail closed), for world entry. */
    drownedCitySite?: (siteId: string) => Promise<LatLon | null>;
    /** The region's current Golem Forge site for this entrance id (open or collapsed), or null. */
    golemForgeSite?: (entranceId: string) => Promise<Readonly<{ state: "open" | "collapsed" }> | null>;
    /** A rolled ladder-dungeon entrance standing now (and whether it shows at this time of day), or null. */
    worldDungeonEntranceSite?: (entranceId: string) => Promise<Readonly<{ visible: boolean }> | null>;
  }> = {}
): PortalRegistry {
  const registry = new PortalRegistry();
  registry.registerResolver(async (portalId, source, context) => {
    const dynamic = parseDungeonPortalId(portalId);
    const catalog = options.catalog ?? DUNGEON_CATALOG;
    const drowned = dynamic ? drownedCityEntranceAt(catalog, dynamic.entranceId) : null;
    if (drowned) {
      // Derived from the water site id: world entry needs the site on coastal ocean right now; a run
      // inside (exit, room doors) trusts the deterministic site and must belong to this entrance.
      if (source.kind === "world" && !await options.drownedCitySite?.(drowned.siteId)) return null;
      if (source.kind === "interior" &&
          (source.locationType !== "dungeon" || source.locationId !== drowned.entrance.id)) return null;
      return genericDungeonPortal(catalog, portalId, source, context.playerId, options.partyIdForPlayer, undefined, undefined, {
        entrance: drowned.entrance,
        revision: drownedCityPortalRevision(catalog, drowned.entrance)
      });
    }
    const rolled = dynamic ? worldDungeonEntranceAt(catalog, dynamic.entranceId) : null;
    if (rolled) {
      // Derived from the rolled id: world entry needs it standing and visible right now (fail closed);
      // a run inside (exit, room doors) belongs to this entrance and keeps working after it expires.
      if (source.kind === "world" && (await options.worldDungeonEntranceSite?.(rolled.id))?.visible !== true) return null;
      if (source.kind === "interior" &&
          (source.locationType !== "dungeon" || source.locationId !== rolled.id)) return null;
      return genericDungeonPortal(catalog, portalId, source, context.playerId, options.partyIdForPlayer, undefined, undefined, {
        entrance: rolled,
        revision: worldDungeonEntrancePortalRevision(catalog, rolled)
      });
    }
    const forge = dynamic ? golemForgeSiteEntrance(catalog, dynamic.entranceId) : null;
    if (forge) {
      // Derived from the site id: world entry needs the site open right now (fail closed); a run inside
      // (exit, room doors) belongs to this entrance and keeps working after the site collapses.
      if (source.kind === "world" && (await options.golemForgeSite?.(forge.id))?.state !== "open") return null;
      if (source.kind === "interior" &&
          (source.locationType !== "dungeon" || source.locationId !== forge.id)) return null;
      return genericDungeonPortal(catalog, portalId, source, context.playerId, options.partyIdForPlayer, undefined, undefined, {
        entrance: forge,
        revision: golemForgeSitePortalRevision(catalog, forge)
      });
    }
    if (dynamic && options.developerSpawnedDungeons) {
      const placement = await options.developerSpawnedDungeons.find(dynamic.entranceId, true);
      if (placement) {
        if (placement.deletedAt !== null && source.kind === "world") return null;
        if (source.kind === "interior" &&
            (source.locationType !== "dungeon" || source.locationId !== placement.entranceId)) {
          return null;
        }
        return genericDungeonPortal(
          options.catalog ?? DUNGEON_CATALOG,
          portalId,
          source,
          context.playerId,
          options.partyIdForPlayer,
          placement,
          options.developerSpawnedDungeons
        );
      }
    }
    const generic = genericDungeonPortal(
      options.catalog ?? DUNGEON_CATALOG,
      portalId,
      source,
      context.playerId,
      options.partyIdForPlayer
    );
    if (generic) return generic;
    const parsed = parsePortalId(portalId);
    if (!parsed) return null;
    const exterior = await loadExterior(pool, parsed.kind, parsed.id);
    if (!exterior) return null;
    return definitionFor(exterior, parsed.route, source);
  });
  return registry;
}

export function genericDungeonPortal(
  catalog: DungeonCatalog,
  runtimePortalId: string,
  source: PlayerLocationSnapshot,
  playerId: string,
  partyIdForPlayer?: (playerId: string) => string | null,
  placement?: DeveloperSpawnedDungeonEntrance,
  placementService?: DeveloperSpawnedDungeonService,
  /** A derived entrance (a Drowned City site): its world entry is open and it carries its own revision. */
  derived?: Readonly<{ entrance: DungeonEntranceDefinition; revision: string }>
): PortalDefinition | null {
  const parsed = parseDungeonPortalId(runtimePortalId);
  if (!parsed) return null;
  const template = derived?.entrance ?? (placement
    ? findDeveloperDungeonEntranceTemplate(catalog, placement.templateId, true)
    : catalog.entrances.find((candidate) => candidate.id === parsed.entranceId && !candidate.retired));
  if (!template) return null;
  const entrance = placement
    ? { ...template, id: placement.entranceId, lat: placement.position.lat, lon: placement.position.lon }
    : template;
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId && !candidate.retired);
  const portal = dungeon?.portals.find((candidate) =>
    candidate.id === parsed.portalId && (placement ? true : !candidate.retired)
  );
  if (!dungeon || !portal) return null;
  const instanceId = source.kind === "interior"
    ? source.instanceId
    : dungeonInstanceId(entrance, dungeon, playerId, partyIdForPlayer);
  const worldPosition = { lat: entrance.lat, lon: entrance.lon };
  const world = {
    kind: "world" as const,
    regionCode: placement?.regionCode ?? packageIdForPosition(worldPosition),
    position: worldPosition
  };
  const local = (roomId: string, anchorId: string) => {
    const room = dungeon.rooms.find((candidate) => candidate.id === roomId && !candidate.retired);
    if (!room) return null;
    const anchor = dungeonAnchorDefinition(room, anchorId);
    return {
      kind: "interior" as const,
      locationType: "dungeon" as const,
      locationId: entrance.id,
      instanceId,
      spaceId: room.id,
      position: { x: anchor.x, y: anchor.y },
      ...(anchor.facing === undefined ? {} : { facing: anchor.facing })
    };
  };
  const endpoint = (value: typeof portal.source) => value.kind === "world"
    ? world
    : local(value.roomId, value.anchorId);
  const sourceEndpoint = endpoint(portal.source);
  const destinationEndpoint = endpoint(portal.destination);
  if (!sourceEndpoint || !destinationEndpoint) return null;
  const roomPoint = (roomId: string, anchorId: string | undefined) => {
    if (!anchorId) return null;
    const room = dungeon.rooms.find((candidate) => candidate.id === roomId && !candidate.retired);
    if (!room) return null;
    const anchor = dungeonAnchorDefinition(room, anchorId);
    return { x: anchor.x, y: anchor.y };
  };
  const sourceApproach = portal.source.kind === "world"
    ? destinationPoint(worldPosition, entrance.interactionRadiusM, 180)
    : roomPoint(portal.source.roomId, portal.sourceApproachAnchorId);
  const sourceThreshold = portal.source.kind === "world"
    ? worldPosition
    : roomPoint(portal.source.roomId, portal.sourceThresholdAnchorId);
  const destinationArrival = portal.destination.kind === "world"
    ? destinationPoint(worldPosition, entrance.footprintRadiusM + 1.25, 180)
    : roomPoint(portal.destination.roomId, portal.destinationArrivalAnchorId);
  if (!sourceApproach || !sourceThreshold || !destinationArrival) return null;
  const preloadSceneKey = portal.preloadSceneKey ?? entrance.preloadSceneKey;
  return {
    portalId: runtimePortalId,
    source: sourceEndpoint,
    destination: destinationEndpoint,
    sourceApproach,
    sourceThreshold,
    destinationArrival,
    ...(portal.reciprocalPortalId
      ? { pairedPortalId: portalIds.dungeon(entrance.id, portal.reciprocalPortalId) }
      : {}),
    interactionLabel: portal.source.kind === "world" ? entrance.interactionLabel : portal.interactionLabel,
    transitionPresentation: portal.source.kind === "world" ? entrance.presentation : portal.presentation,
    ...(portal.accessPolicyId ? { accessPolicyId: portal.accessPolicyId } : {}),
    ...(preloadSceneKey ? { preloadSceneKey } : {}),
    // A derived developer template has no production world binding (the catalog portal is disabled);
    // only its developer-spawned placement may open that world entrance. Every other portal is unchanged.
    enabled: (derived || (placement && "synthetic" in template && template.synthetic)) && portal.source.kind === "world" ? true : portal.enabled,
    revision: derived ? derived.revision : placement && placementService
      ? placementService.portalRevisionFor(placement)
      : boundedPortalRevision(`${entrance.revision}:${entrance.portalRevision}:${dungeon.revision}`)
  };
}

function parseDungeonPortalId(portalId: string): {
  entranceId: string;
  portalId: string;
} | null {
  const match = /^dungeon:([^:]+):(.+)$/.exec(portalId);
  return match ? { entranceId: match[1]!, portalId: match[2]! } : null;
}

function dungeonInstanceId(
  entrance: DungeonEntranceDefinition,
  dungeon: DungeonDefinition,
  playerId: string,
  partyIdForPlayer?: (playerId: string) => string | null
): string {
  const prefix = `dungeon:${entrance.id}`;
  if (dungeon.instancePolicy === "shared_persistent") return prefix;
  if (dungeon.instancePolicy === "party_ephemeral") {
    const partyId = partyIdForPlayer?.(playerId);
    if (partyId) return `${prefix}:party:${partyId}`;
  }
  return `${prefix}:player:${playerId}`;
}

function definitionFor(
  exterior: Exterior,
  route: string,
  source: PlayerLocationSnapshot
): PortalDefinition | null {
  const doorway = destinationPoint(exterior.center, exterior.footprintRadiusM * 0.82, 180);
  const exteriorApproach = destinationPoint(exterior.center, exterior.footprintRadiusM + 3, 180);
  const exteriorArrival = destinationPoint(exterior.center, exterior.footprintRadiusM + 1.25, 180);
  const world = {
    kind: "world" as const,
    regionCode: packageIdForPosition(doorway),
    position: doorway
  };
  const local = (spaceId: string, x: number, y: number, facing?: number) => ({
    kind: "interior" as const, locationType: exterior.locationType,
    locationId: exterior.locationId, instanceId: exterior.instanceId,
    spaceId, position: { x, y }, ...(facing === undefined ? {} : { facing })
  });
  const make = (definition: Omit<PortalDefinition, "portalId" | "revision" | "enabled">): PortalDefinition => ({
    ...definition, portalId: portalIdFor(exterior, route), revision: exterior.revision, enabled: true
  });

  if (exterior.locationType === "manor") {
    const typeId = exterior.manorTypeId;
    const space = manorTypeSpace(typeId);
    const spaceIdOf = (roomId: string) => manorAuthoredSpaceId(roomId, typeId);
    const authored = /^room:([^:]+):([^:]+)(?::([^:]+))?$/.exec(route);
    if (authored) return interiorRoomPortal({
      space, roomId: authored[1]!, anchorId: authored[2]!, make, local,
      ...(authored[3] ? { destinationRoomId: authored[3] } : {}),
      pairedPortalId: (roomId, anchorId, returnRoomId) => manorAuthoredPortalId(exterior.locationId, roomId, anchorId, returnRoomId),
      spaceIdOf, sceneKeyPrefix: "manor", revisionPrefix: exterior.revision
    });
    // The authored world-exit door of the Manor type (its anchor and click area in the entrance room).
    const exit = worldExitOf(space);
    const lobbySpawn = exit?.arrival ?? { x: 627, y: 1100 };
    const exitDoor = exit?.position ?? lobbySpawn;
    const foyerDoor = local("manor_foyer", 500, 880, -Math.PI / 2);
    const foyerInner = local("manor_foyer", 500, 170, Math.PI / 2);
    const mainDoor = local("manor_main_room", exitDoor.x, exitDoor.y, -Math.PI / 4);
    if (route === "world-to-main" || route === "main-to-world") return interiorWorldPortal({
      space, route, make, world, local,
      worldApproach: exteriorApproach, worldThreshold: doorway, worldArrival: exteriorArrival,
      pairedPortalId: route === "world-to-main"
        ? portalIds.manorMainToWorld(exterior.locationId)
        : portalIds.manorWorldToMain(exterior.locationId),
      accessPolicyId: "manor-entry", sceneKeyPrefix: "manor", facing: -Math.PI / 4,
      // Leaving requires walking to the authored door (no immediate exit from across the room).
      spaceIdOf, enterLabel: "Enter Manor", roomApproachPolicy: "required"
    });
    // Legacy foyer routes remain resolvable so players saved there can leave safely.
    if (route === "world-to-foyer") return make({
      source: world, destination: foyerDoor, sourceApproach: exteriorApproach,
      sourceThreshold: doorway, destinationArrival: { x: 500, y: 840 },
      pairedPortalId: portalIds.manorFoyerToWorld(exterior.locationId),
      interactionLabel: "Enter Manor", transitionPresentation: "door",
      accessPolicyId: "manor-entry", preloadSceneKey: "manor/manor_foyer"
    });
    if (route === "foyer-to-world") return make({
      source: foyerDoor, destination: world, sourceApproach: { x: 500, y: 850 },
      sourceThreshold: { x: 500, y: 880 }, destinationArrival: exteriorArrival,
      pairedPortalId: portalIds.manorWorldToFoyer(exterior.locationId),
      interactionLabel: "Exit Manor", transitionPresentation: "door", preloadSceneKey: "world"
    });
    if (route === "foyer-to-main") return make({
      source: foyerInner, destination: mainDoor, sourceApproach: { x: 500, y: 210 },
      sourceThreshold: { x: 500, y: 170 }, destinationArrival: lobbySpawn,
      pairedPortalId: portalIds.manorMainToFoyer(exterior.locationId),
      interactionLabel: "Enter Main Hall", transitionPresentation: "door",
      preloadSceneKey: "manor/manor_main_room"
    });
    if (route === "main-to-foyer") return make({
      source: mainDoor, destination: foyerInner,
      sourceApproach: exitDoor,
      sourceThreshold: exitDoor, destinationArrival: { x: 500, y: 210 },
      pairedPortalId: portalIds.manorFoyerToMain(exterior.locationId),
      interactionLabel: "Return to Foyer", transitionPresentation: "door",
      preloadSceneKey: "manor/manor_foyer"
    });
  }

  if (exterior.locationType === "salon") {
    if (route === "world-to-main" || route === "main-to-world") return interiorWorldPortal({
      space: SALON_INTERIOR_SPACE, route, make, world, local,
      worldApproach: exteriorApproach, worldThreshold: doorway, worldArrival: exteriorArrival,
      pairedPortalId: route === "world-to-main"
        ? portalIds.salonMainToWorld(exterior.locationId)
        : portalIds.salonWorldToMain(exterior.locationId),
      accessPolicyId: "salon-entry", sceneKeyPrefix: "salon", facing: -Math.PI / 4,
      // Walk-to-the-door exit and the legacy world arrival point are unchanged.
      roomApproach: { x: SALON_DOOR.x - 40, y: SALON_DOOR.y - 40 }, roomApproachPolicy: "required",
      roomArrival: { x: 790, y: 790 }
    });
  }

  if (exterior.locationType === "greenhouse") {
    // Door position, exit label and arrival come from the authored Greenhouse space
    // (data/interiors/greenhouse.json); the runtime portal ids are unchanged.
    if (route === "world-to-main" || route === "main-to-world") return interiorWorldPortal({
      space: GREENHOUSE_INTERIOR_SPACE, route, make, world, local,
      worldApproach: exteriorApproach, worldThreshold: doorway, worldArrival: exteriorArrival,
      pairedPortalId: route === "world-to-main"
        ? portalIds.greenhouseMainToWorld(exterior.locationId)
        : portalIds.greenhouseWorldToMain(exterior.locationId),
      accessPolicyId: "greenhouse-entry", sceneKeyPrefix: "greenhouse", facing: -Math.PI / 4
    });
  }

  if (exterior.locationType === "cistern_warrens") {
    const portal = CISTERN_WARRENS_DUNGEON.portals.find((candidate) => candidate.id === route);
    if (!portal || portal.retired) return null;
    const endpoint = (definition: typeof portal.source) => {
      if (definition.kind === "world") return world;
      const room = CISTERN_WARRENS_DUNGEON.rooms.find((candidate) => candidate.id === definition.roomId)!;
      const anchor = dungeonAnchorDefinition(room, definition.anchorId);
      return local(room.id, anchor.x, anchor.y, anchor.facing);
    };
    const roomAnchor = (roomId: string, anchorId: string | undefined) => {
      const room = CISTERN_WARRENS_DUNGEON.rooms.find((candidate) => candidate.id === roomId)!;
      const anchor = dungeonAnchorDefinition(room, anchorId!);
      return { x: anchor.x, y: anchor.y };
    };
    const sourceApproach = portal.source.kind === "world"
      ? exteriorApproach
      : roomAnchor(portal.source.roomId, portal.sourceApproachAnchorId);
    const sourceThreshold = portal.source.kind === "world"
      ? doorway
      : roomAnchor(portal.source.roomId, portal.sourceThresholdAnchorId);
    const destinationArrival = portal.destination.kind === "world"
      ? exteriorArrival
      : roomAnchor(portal.destination.roomId, portal.destinationArrivalAnchorId);
    return {
      ...make({
        source: endpoint(portal.source),
        destination: endpoint(portal.destination),
        sourceApproach,
        sourceThreshold,
        destinationArrival,
        ...(portal.reciprocalPortalId
          ? { pairedPortalId: portalIdFor(exterior, portal.reciprocalPortalId) }
          : {}),
        interactionLabel: portal.interactionLabel,
        transitionPresentation: portal.presentation,
        ...(portal.accessPolicyId ? { accessPolicyId: portal.accessPolicyId } : {}),
        ...(portal.preloadSceneKey ? { preloadSceneKey: portal.preloadSceneKey } : {})
      }),
      // Keep the reverse exit available for anyone already inside while the
      // public Cistern Warrens entrance is temporarily closed.
      enabled: route === "world-to-entrance" ? false : portal.enabled
    };
  }
  void source;
  return null;
}

async function loadExterior(pool: pg.Pool, kind: string, id: string): Promise<Exterior | null> {
  if (kind === "manor") {
    const result = await pool.query<{
      id: string; world_region_code: string; world_lat: number; world_lon: number;
      placement_revision: string | number; manor_type_id: string;
    }>(`SELECT id::text,world_region_code,world_lat,world_lon,placement_revision,manor_type_id
        FROM player_manors WHERE id=$1::uuid AND built_at IS NOT NULL`, [id]);
    const row = result.rows[0];
    return row ? {
      locationType: "manor", locationId: row.id, instanceId: `manor:${row.id}`,
      regionCode: row.world_region_code, center: { lat: Number(row.world_lat), lon: Number(row.world_lon) },
      footprintRadiusM: 8, revision: String(row.placement_revision), manorTypeId: row.manor_type_id
    } : null;
  }
  if (kind === "greenhouse") {
    const result = await pool.query<{
      greenhouse_id: string; region_code: string; lat: number; lon: number; placement_revision: string | number;
    }>(`SELECT greenhouse_id::text,region_code,lat,lon,placement_revision
        FROM player_greenhouses WHERE greenhouse_id=$1::uuid AND removed_at IS NULL`, [id]);
    const row = result.rows[0];
    return row ? {
      locationType: "greenhouse", locationId: row.greenhouse_id, instanceId: `greenhouse:${row.greenhouse_id}`,
      regionCode: row.region_code, center: { lat: Number(row.lat), lon: Number(row.lon) },
      footprintRadiusM: 8, revision: String(row.placement_revision)
    } : null;
  }
  const type = kind === "salon" ? "salon" : kind === "sewer" ? "cistern_warrens" : null;
  if (!type) return null;
  const result = await pool.query<{
    structure_id: string; region_code: string; lat: number; lon: number;
    footprint_radius_m: number; placement_revision: string | number;
  }>(`SELECT structure_id::text,region_code,lat,lon,footprint_radius_m,placement_revision
      FROM city_structures WHERE structure_id=$1::uuid AND structure_type=$2 AND state='active'`, [id, type]);
  const row = result.rows[0];
  return row ? {
    locationType: type, locationId: row.structure_id,
    instanceId: `${type === "cistern_warrens" ? "sewer" : "salon"}:${row.structure_id}`,
    regionCode: row.region_code, center: { lat: Number(row.lat), lon: Number(row.lon) },
    footprintRadiusM: Number(row.footprint_radius_m), revision: String(row.placement_revision)
  } : null;
}

function parsePortalId(portalId: string): { kind: string; id: string; route: string } | null {
  const match = /^(manor|salon|sewer|greenhouse):([^:]+):(.+)$/.exec(portalId);
  return match ? { kind: match[1]!, id: match[2]!, route: match[3]! } : null;
}

function portalIdFor(exterior: Exterior, route: string): string {
  const prefix = exterior.locationType === "cistern_warrens" ? "sewer" : exterior.locationType;
  return `${prefix}:${exterior.locationId}:${route}`;
}

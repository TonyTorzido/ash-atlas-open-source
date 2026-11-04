import {
  DUNGEON_CATALOG,
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  MANOR_INTERIOR_SPACE,
  worldExitOf,
  manorTypeSpace,
  GREENHOUSE_INTERIOR_ROOM,
  GREENHOUSE_STUDIO_CATALOG,
  manorAnchorDestinations,
  manorAuthoredPortalId,
  manorAuthoredSpaceId,
  manorRoomNavigation,
  interiorNavigation,
  isIndoorNavigationPointWalkable,
  portalIds,
  type DungeonCatalog,
  type PlayerLocationSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { createAshAtlasPortalRegistry } from "./ashAtlasPortalRegistry.js";

const world: PlayerLocationSnapshot = {
  kind: "world", regionCode: "world_v1_lat35_lon-106", zoneId: "world:world_v1_lat35_lon-106",
  position: { lat: 35, lon: -106 }, revision: 1
};

function interior(
  locationType: "manor" | "salon" | "cistern_warrens" | "dungeon" | "greenhouse",
  id: string,
  instanceId: string,
  spaceId: string
): PlayerLocationSnapshot {
  return {
    kind: "interior", locationType, locationId: id, instanceId, spaceId,
    regionCode: `interior:${instanceId}`, zoneId: `interior:${instanceId}:${spaceId}`,
    position: { x: 0, y: 0 }, revision: 1, lastPortalId: "entry"
  };
}

function pool(manorTypeId?: string): pg.Pool {
  return {
    query: vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes("player_manors")) {
        return { rows: [{
          id: values[0], world_region_code: "NM", world_lat: 35, world_lon: -106,
          placement_revision: 11, ...(manorTypeId ? { manor_type_id: manorTypeId } : {})
        }] };
      }
      const type = values[1];
      return { rows: [{
        structure_id: values[0], region_code: "NM", lat: 35, lon: -106,
        footprint_radius_m: type === "salon" ? 9 : 5, placement_revision: 12
      }] };
    })
  } as unknown as pg.Pool;
}

describe("Ash Atlas portal content", () => {
  it("routes every Manor floor and room through paired canonical portals with walkable arrivals and lock authority", async () => {
    const registry = createAshAtlasPortalRegistry(pool());
    const template = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === "manor_lobby")!;
    for (const room of template.rooms) for (const anchor of room.anchors.filter((anchor) => !anchor.retired && anchor.type === "portal")) {
      const destinations = manorAnchorDestinations(anchor);
      for (const target of destinations) {
        const source = interior("manor", "manor-1", "manor:manor-1", manorAuthoredSpaceId(room.id));
        const portalId = manorAuthoredPortalId("manor-1", room.id, anchor.id, destinations.length > 1 ? target.destinationRoomId : undefined);
        const definition = await registry.resolve(portalId, source);
        expect(definition.enabled).toBe(!target.locked);
        expect(definition.destination).toMatchObject({ kind: "interior", locationId: "manor-1", spaceId: manorAuthoredSpaceId(target.destinationRoomId) });
        if (destinations.length > 1) expect(definition.interactionLabel).toBe(target.label);
        expect(isIndoorNavigationPointWalkable(manorRoomNavigation(manorAuthoredSpaceId(target.destinationRoomId)), definition.destinationArrival as { x: number; y: number })).toBe(true);
        const back = await registry.resolve(definition.pairedPortalId!, interior("manor", "manor-1", "manor:manor-1", manorAuthoredSpaceId(target.destinationRoomId)));
        expect(back.destination).toMatchObject({ spaceId: manorAuthoredSpaceId(room.id) });
        expect(back.pairedPortalId).toBe(definition.portalId);
      }
    }
  });
  it("connects all current world boundaries to exact doorway arrivals", async () => {
    const registry = createAshAtlasPortalRegistry(pool());
    const cases = [
      [portalIds.manorWorldToMain("manor-1"), world, "manor_main_room"],
      [portalIds.salonWorldToMain("salon-1"), world, "salon_main_room"],
      [portalIds.sewerWorldToEntrance("sewer-1"), world, "hatch_landing"]
    ] as const;
    for (const [portalId, source, spaceId] of cases) {
      const definition = await registry.resolve(portalId, source);
      expect(definition.destination).toMatchObject({ kind: "interior", spaceId });
      expect(definition.sourceApproach).not.toEqual({ lat: 35, lon: -106 });
      expect(definition.enabled).toBe(
        portalId === portalIds.sewerWorldToEntrance("sewer-1") ? false : true
      );
    }

    const exits = [
      [portalIds.manorMainToWorld("manor-1"), interior("manor", "manor-1", "manor:manor-1", "manor_main_room")],
      [portalIds.salonMainToWorld("salon-1"), interior("salon", "salon-1", "salon:salon-1", "salon_main_room")],
      [portalIds.sewerEntranceToWorld("sewer-1"), interior("cistern_warrens", "sewer-1", "sewer:sewer-1", "hatch_landing")]
    ] as const;
    for (const [portalId, source] of exits) {
      const definition = await registry.resolve(portalId, source);
      expect(definition.destination).toMatchObject({
        kind: "world",
        regionCode: "world_v1_lat34_lon-106"
      });
      expect(definition.destinationArrival).not.toEqual({ lat: 35, lon: -106 });
      expect(definition.enabled).toBe(true);
    }
    expect((await registry.resolve(
      portalIds.manorMainToWorld("manor-1"),
      interior("manor", "manor-1", "manor:manor-1", "manor_main_room")
    )).approachPolicy).toBeUndefined();
  });

  it("keeps legacy Manor foyer and sewer room transitions in the same instance", async () => {
    const registry = createAshAtlasPortalRegistry(pool());
    const cases = [
      [portalIds.manorFoyerToMain("manor-1"), interior("manor", "manor-1", "manor:manor-1", "manor_foyer"), "manor_main_room"],
      [portalIds.manorMainToFoyer("manor-1"), interior("manor", "manor-1", "manor:manor-1", "manor_main_room"), "manor_foyer"],
      [portalIds.sewerHatchToOverflow("sewer-1"), interior("cistern_warrens", "sewer-1", "sewer:sewer-1", "hatch_landing"), "overflow_channel"],
      [portalIds.sewerOverflowToHatch("sewer-1"), interior("cistern_warrens", "sewer-1", "sewer:sewer-1", "overflow_channel"), "hatch_landing"]
    ] as const;
    for (const [portalId, source, destinationSpace] of cases) {
      const definition = await registry.resolve(portalId, source);
      expect(definition.destination).toMatchObject({
        kind: "interior", instanceId: source.kind === "interior" ? source.instanceId : "",
        spaceId: destinationSpace
      });
    }
  });

  it("publishes exact canonical Sewer thresholds, approaches, and arrivals", async () => {
    const registry = createAshAtlasPortalRegistry(pool());
    const hatchToOverflow = await registry.resolve(
      portalIds.sewerHatchToOverflow("sewer-1"),
      interior("cistern_warrens", "sewer-1", "sewer:sewer-1", "hatch_landing")
    );
    expect(hatchToOverflow).toMatchObject({
      source: { spaceId: "hatch_landing", position: { x: 950, y: 475 } },
      sourceApproach: { x: 870, y: 475 },
      sourceThreshold: { x: 950, y: 475 },
      destination: { spaceId: "overflow_channel", position: { x: 30, y: 400 } },
      destinationArrival: { x: 130, y: 400 }
    });
    const overflowToHatch = await registry.resolve(
      portalIds.sewerOverflowToHatch("sewer-1"),
      interior("cistern_warrens", "sewer-1", "sewer:sewer-1", "overflow_channel")
    );
    expect(overflowToHatch).toMatchObject({
      sourceApproach: { x: 110, y: 400 },
      sourceThreshold: { x: 30, y: 400 },
      destinationArrival: { x: 820, y: 475 }
    });
    const worldEntry = await registry.resolve(portalIds.sewerWorldToEntrance("sewer-1"), world);
    expect(worldEntry.enabled).toBe(false);
    expect(worldEntry.destination).toMatchObject({ position: { x: 500, y: 60 } });
    expect(worldEntry.destinationArrival).toEqual({ x: 500, y: 200 });
  });

  it.each([
    ["shared_persistent", "dungeon:cave-a"],
    ["party_ephemeral", "dungeon:cave-a:party:party-a"],
    ["solo_ephemeral", "dungeon:cave-a:player:player-a"]
  ] as const)("resolves authored %s entrance and same-instance room/exit portals", async (policy, instanceId) => {
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    catalog.entrances.push({
      id: "cave-a", dungeonId: "cistern_warrens", revision: "entrance-v1", retired: false,
      name: "Test Cave", description: "Fixture only", lat: 35, lon: -106,
      interactionRadiusM: 8, footprintRadiusM: 5,
      portalId: "world-to-entrance", portalRevision: "portal-v1",
      interactionLabel: "Enter Cave", presentation: "cave", assetKey: null
    });
    catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!.instancePolicy = policy;
    const registry = createAshAtlasPortalRegistry(pool(), {
      catalog,
      partyIdForPlayer: () => "party-a"
    });
    const entry = await registry.resolve(
      portalIds.dungeon("cave-a", "world-to-entrance"),
      world,
      { playerId: "player-a" }
    );
    expect(entry.destination).toMatchObject({
      kind: "interior", locationType: "dungeon", locationId: "cave-a", instanceId,
      spaceId: "hatch_landing"
    });
    const source = interior("dungeon", "cave-a", instanceId, "hatch_landing");
    const room = await registry.resolve(portalIds.dungeon("cave-a", "hatch-to-overflow"), source,
      { playerId: "player-a" });
    expect(room.destination).toMatchObject({ instanceId, spaceId: "overflow_channel" });
    const exit = await registry.resolve(portalIds.dungeon("cave-a", "entrance-to-world"), source,
      { playerId: "player-a" });
    expect(exit.destination.kind).toBe("world");
  });

  it("falls back to a solo authored instance when a party dungeon has no party", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    catalog.entrances.push({ id: "cave-a", dungeonId: "cistern_warrens", revision: "entrance-v1",
      retired: false, name: "Test Cave", description: "Fixture only", lat: 35, lon: -106,
      interactionRadiusM: 8, footprintRadiusM: 5, portalId: "world-to-entrance",
      portalRevision: "portal-v1", interactionLabel: "Enter Cave", presentation: "cave",
      assetKey: null });
    catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!.instancePolicy = "party_ephemeral";
    const registry = createAshAtlasPortalRegistry(pool(), { catalog, partyIdForPlayer: () => null });
    const entry = await registry.resolve(portalIds.dungeon("cave-a", "world-to-entrance"), world,
      { playerId: "player-a" });
    expect(entry.destination).toMatchObject({ instanceId: "dungeon:cave-a:player:player-a" });
  });

  it("opens a derived developer entrance only through its placement, never the disabled catalog portal", async () => {
    const dungeonId = "readiness_tomorrow_slime_2026_09_20_long_accepted_name";
    const dungeon = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === dungeonId)!;
    const catalogPortal = dungeon.portals.find((candidate) => candidate.id === dungeon.entrance.portalId)!;
    expect(catalogPortal.enabled).toBe(false);
    const entranceId = "dev-dungeon-derived-1";
    const placement = {
      entranceId, creatorPlayerId: "developer-1", requestId: "spawn-1",
      templateId: `dungeon:${dungeonId}`, templateRevision: "1", templatePortalRevision: "1",
      dungeonRevision: "1", catalogRevision: 1, placementRevision: 1,
      regionCode: "world_v1_lat40_lon-75", position: { lat: 40.7, lon: -74.1 },
      createdAt: "2026-09-07T00:00:00.000Z", deletedAt: null as string | null
    };
    const service = {
      find: vi.fn(async (id: string) => id === entranceId ? placement : null),
      portalRevisionFor: vi.fn(() => "developer:1")
    };
    const registry = createAshAtlasPortalRegistry(pool(), { developerSpawnedDungeons: service as never });
    const portalId = portalIds.dungeon(entranceId, dungeon.entrance.portalId);

    const entry = await registry.resolve(portalId, world, { playerId: "player-a" });
    expect(entry.enabled).toBe(true);
    expect(entry.destination).toMatchObject({ kind: "interior", locationId: entranceId });

    // The same catalog portal under any non-placement entrance ID stays unavailable.
    await expect(registry.resolve(portalIds.dungeon("some-other-entrance", dungeon.entrance.portalId), world,
      { playerId: "player-a" })).rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });
    await expect(registry.resolve(portalIds.dungeon(dungeonId, dungeon.entrance.portalId), world,
      { playerId: "player-a" })).rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });

    placement.deletedAt = "2026-09-07T00:01:00.000Z";
    await expect(registry.resolve(portalId, world, { playerId: "player-a" }))
      .rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });
  });

  it("resolves developer placements at their exact world anchor and drains tombstones in reverse", async () => {
    const entranceId = "dev-dungeon-placement-1";
    const placement = {
      entranceId,
      creatorPlayerId: "developer-1",
      requestId: "spawn-1",
      templateId: "cistern_warrens_world_entrance",
      templateRevision: "1",
      templatePortalRevision: "1",
      dungeonRevision: "1",
      catalogRevision: 1,
      placementRevision: 1,
      regionCode: "world_v1_lat40_lon-75",
      position: { lat: 40.7, lon: -74.1 },
      createdAt: "2026-09-07T00:00:00.000Z",
      deletedAt: null as string | null
    };
    const service = {
      find: vi.fn(async () => placement),
      portalRevisionFor: vi.fn(() => "developer:1:1:1:1")
    };
    const registry = createAshAtlasPortalRegistry(pool(), {
      developerSpawnedDungeons: service as never
    });
    const worldEntry = await registry.resolve(
      portalIds.dungeon(entranceId, "world-to-entrance"),
      world,
      { playerId: "player-a" }
    );
    expect(worldEntry).toMatchObject({
      revision: "developer:1:1:1:1",
      source: { kind: "world", regionCode: "world_v1_lat40_lon-75", position: placement.position },
      destination: { kind: "interior", locationId: entranceId, instanceId: `dungeon:${entranceId}` }
    });

    placement.deletedAt = "2026-09-07T00:01:00.000Z";
    await expect(registry.resolve(
      portalIds.dungeon(entranceId, "world-to-entrance"),
      world,
      { playerId: "player-a" }
    )).rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });
    const reverse = await registry.resolve(
      portalIds.dungeon(entranceId, "entrance-to-world"),
      interior("dungeon", entranceId, `dungeon:${entranceId}`, "hatch_landing"),
      { playerId: "player-a" }
    );
    expect(reverse.destination).toMatchObject({
      kind: "world", regionCode: "world_v1_lat40_lon-75", position: placement.position
    });
    await expect(registry.resolve(
      portalIds.dungeon(entranceId, "entrance-to-world"),
      interior("dungeon", "another-entrance", `dungeon:${entranceId}`, "hatch_landing"),
      { playerId: "player-a" }
    )).rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });
  });

  it("builds the Greenhouse portals from the authored exit, keeping the runtime portal ids", async () => {
    const greenhousePool = { query: vi.fn(async (_sql: string, values: unknown[]) => ({ rows: [{
      greenhouse_id: values[0], region_code: "NM", lat: 35, lon: -106, placement_revision: 4
    }] })) } as unknown as pg.Pool;
    const registry = createAshAtlasPortalRegistry(greenhousePool);
    const exit = GREENHOUSE_STUDIO_CATALOG.geometry.exit;
    const inside = interior("greenhouse", "gh-1", "greenhouse:gh-1", GREENHOUSE_INTERIOR_ROOM.id);

    const leave = await registry.resolve(portalIds.greenhouseMainToWorld("gh-1"), inside);
    expect(leave.portalId).toBe("greenhouse:gh-1:main-to-world");
    // Authored Studio position, not the retired 830,830 constant.
    expect(leave.sourceThreshold).toEqual({ x: exit.x, y: exit.y });
    expect(leave).toMatchObject({
      source: { kind: "interior", spaceId: GREENHOUSE_INTERIOR_ROOM.id, position: { x: exit.x, y: exit.y } },
      destination: { kind: "world" }, approachPolicy: "immediate", interactionLabel: "Exit Greenhouse",
      pairedPortalId: "greenhouse:gh-1:world-to-main", enabled: true
    });

    const enter = await registry.resolve(portalIds.greenhouseWorldToMain("gh-1"), world);
    expect(enter.portalId).toBe("greenhouse:gh-1:world-to-main");
    expect(enter).toMatchObject({
      destination: { kind: "interior", spaceId: GREENHOUSE_INTERIOR_ROOM.id, position: { x: exit.x, y: exit.y } },
      interactionLabel: "Enter Greenhouse", accessPolicyId: "greenhouse-entry",
      preloadSceneKey: `greenhouse/${GREENHOUSE_INTERIOR_ROOM.id}`, pairedPortalId: "greenhouse:gh-1:main-to-world"
    });
    const arrival = enter.destinationArrival as { x: number; y: number };
    const spawn = GREENHOUSE_INTERIOR_ROOM.anchors.find((anchor) => anchor.id === GREENHOUSE_INTERIOR_ROOM.spawnAnchorId)!;
    expect(arrival).toEqual({ x: spawn.x, y: spawn.y });
    expect(isIndoorNavigationPointWalkable(interiorNavigation(GREENHOUSE_INTERIOR_ROOM), arrival)).toBe(true);
  });

  const manorExit = worldExitOf(MANOR_INTERIOR_SPACE)!.position;

  it("builds the Manor and Salon world portals from their authored exits with the pre-U3 geometry and ids", async () => {
    const registry = createAshAtlasPortalRegistry(pool());
    const manorInside = interior("manor", "manor-1", "manor:manor-1", "manor_main_room");
    const enter = await registry.resolve(portalIds.manorWorldToMain("manor-1"), world);
    expect(enter).toMatchObject({
      portalId: "manor:manor-1:world-to-main", interactionLabel: "Enter Manor", accessPolicyId: "manor-entry",
      preloadSceneKey: "manor/manor_main_room", pairedPortalId: "manor:manor-1:main-to-world", enabled: true, revision: "11",
      destination: { kind: "interior", spaceId: "manor_main_room", position: manorExit, facing: -Math.PI / 4 },
      // Arrival from the world is the lobby spawn anchor, exactly as before.
      destinationArrival: worldExitOf(MANOR_INTERIOR_SPACE)!.arrival
    });
    const leave = await registry.resolve(portalIds.manorMainToWorld("manor-1"), manorInside);
    expect(leave).toMatchObject({
      portalId: "manor:manor-1:main-to-world", interactionLabel: "Leave Manor",
      // The authored world-exit door of the default Manor type.
      sourceApproach: manorExit, sourceThreshold: manorExit, preloadSceneKey: "world",
      pairedPortalId: "manor:manor-1:world-to-main", source: { spaceId: "manor_main_room", position: manorExit }
    });

    expect(leave.approachPolicy).toBeUndefined();

    const salonEnter = await registry.resolve(portalIds.salonWorldToMain("salon-1"), world);
    expect(salonEnter).toMatchObject({
      interactionLabel: "Enter Salon", accessPolicyId: "salon-entry", preloadSceneKey: "salon/salon_main_room",
      destination: { spaceId: "salon_main_room", position: { x: 830, y: 830 } }, destinationArrival: { x: 790, y: 790 },
      pairedPortalId: "salon:salon-1:main-to-world"
    });
    const salonLeave = await registry.resolve(portalIds.salonMainToWorld("salon-1"), interior("salon", "salon-1", "salon:salon-1", "salon_main_room"));
    expect(salonLeave).toMatchObject({
      interactionLabel: "Exit Salon", sourceApproach: { x: 790, y: 790 }, sourceThreshold: { x: 830, y: 830 },
      pairedPortalId: "salon:salon-1:world-to-main"
    });
    expect(salonLeave.approachPolicy).toBeUndefined();
  });

  it("routes a Manor through its own type: rooms, doors and the authored world exit", async () => {
    const registry = createAshAtlasPortalRegistry(pool("samurai_manor"));
    const samurai = manorTypeSpace("samurai_manor");
    const exit = worldExitOf(samurai)!;
    const lobby = interior("manor", "manor-2", "manor:manor-2", "manor_main_room");
    const enter = await registry.resolve(portalIds.manorWorldToMain("manor-2"), world);
    expect(enter).toMatchObject({ destination: { spaceId: "manor_main_room", position: exit.position }, destinationArrival: exit.arrival });
    const upstairs = await registry.resolve("manor:manor-2:room:samurai_manor_lobby:left_door:samurai_manor_hallway", lobby);
    expect(upstairs.destination).toMatchObject({ spaceId: "samurai_manor_hallway" });
    // Another type rooms never resolve inside this Manor.
    await expect(registry.resolve("manor:manor-2:room:manor_lobby_room:anchor", lobby)).rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });
  });

  it("keeps the authored Manor room portal labels, locks, revisions and legacy foyer arrivals", async () => {
    const registry = createAshAtlasPortalRegistry(pool());
    const lobby = interior("manor", "manor-1", "manor:manor-1", "manor_main_room");
    const upstairs = await registry.resolve("manor:manor-1:room:manor_lobby_room:anchor", lobby);
    expect(upstairs).toMatchObject({ interactionLabel: "Upstairs", preloadSceneKey: "manor/upstairs_hallway", enabled: true });
    expect(upstairs.revision).toBe("11:manor_lobby-v102:manor_lobby_room-v3:upstairs_hallway-v3");
    const locked = await registry.resolve("manor:manor-1:room:upstairs_hallway:room_2", interior("manor", "manor-1", "manor:manor-1", "upstairs_hallway"));
    expect(locked.enabled).toBe(false);
    await expect(registry.resolve("manor:manor-1:room:manor_lobby_room:world_exit", lobby)).rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });
    await expect(registry.resolve("manor:manor-1:room:manor_lobby_room:upstairs_door", lobby)).rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });
    const foyer = await registry.resolve(portalIds.manorFoyerToMain("manor-1"), interior("manor", "manor-1", "manor:manor-1", "manor_foyer"));
    expect(foyer).toMatchObject({ destinationArrival: worldExitOf(MANOR_INTERIOR_SPACE)!.arrival, destination: { spaceId: "manor_main_room", position: manorExit } });
  });
});

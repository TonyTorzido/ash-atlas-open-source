import {
  DROWNED_CITY_DUNGEON_ID,
  DUNGEON_CATALOG,
  distanceMeters,
  drownedCityEntranceIdForSite,
  drownedCityEntryPortalId,
  drownedCitySiteIdForEntrance,
  portalIds,
  type DungeonDefinition,
  type LatLon,
  type PlayerLocationSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { DROWNED_CITY_BOSS_SPECS, THE_WATCHER_SPEC } from "./drownedCityBosses.js";
import { drownedCityEntranceAt } from "./drownedCityEntrances.js";
import { CisternWarrensRuntime } from "./dungeon.js";
import { createAshAtlasPortalRegistry } from "./locations/ashAtlasPortalRegistry.js";
import { WATER_SITE_PLACEMENT_VERSION, waterSiteCandidatesNear } from "./waterSitePlacement.js";
import { WaterSiteService } from "./waterSites.js";

const dungeon = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === DROWNED_CITY_DUNGEON_ID)!;
// Any Drowned City slot: placement is deterministic, the surface check is the World's (mocked here).
const site = waterSiteCandidatesNear({ lat: 30, lon: -40 }, 400_000).find((candidate) => candidate.kind === "drowned_city_site")!;
const entranceId = drownedCityEntranceIdForSite(site.siteId)!;

function roomGraph(definition: DungeonDefinition): Map<string, Set<string>> {
  const graph = new Map(definition.rooms.map((room) => [room.id, new Set<string>()]));
  for (const portal of definition.portals) {
    if (portal.retired || portal.source.kind !== "room" || portal.destination.kind !== "room") continue;
    graph.get(portal.source.roomId)!.add(portal.destination.roomId);
  }
  return graph;
}

function reachable(graph: Map<string, Set<string>>, from: string): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) for (const next of graph.get(queue.shift()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
}

describe("Drowned City catalog", () => {
  it("ships 32 dc_ rooms with art floors, the access rules and the boss roster", () => {
    expect(dungeon).toBeDefined();
    expect(dungeon.rooms).toHaveLength(32);
    for (const room of dungeon.rooms) {
      expect(room.id.startsWith("dc_"), room.id).toBe(true);
      const floors = room.layers.background.filter((placement) => placement.prefabId.startsWith("dc_") && placement.prefabId.endsWith("_floor"));
      expect(floors, `${room.id} floor`).toHaveLength(1);
      expect(floors[0]).toMatchObject({ x: 0, y: 0, width: room.width, height: room.height });
    }
    expect(dungeon.instancePolicy).toBe("party_ephemeral");
    expect(dungeon.reset).toMatchObject({ policy: "when_empty", despawnAfterSeconds: 900 });
    expect(dungeon.access).toEqual({
      minimumLevel: 32, entryCost: [{ itemId: "refined_oil", quantity: 18 }, { itemId: "wood", quantity: 1 }],
      lockoutDays: 6, requiresAfloat: true, noReentry: true
    });
    const bosses = dungeon.encounters.flatMap((encounter) => encounter.bossTemplateId ? [encounter.bossTemplateId] : []).sort();
    expect(bosses).toEqual(["abyssal_one", "drowned_admiral", "the_watcher", "tidemaw"]);
  });

  it("reaches every room from the entrance and can walk back out of every room (recovery)", () => {
    const graph = roomGraph(dungeon);
    const entrance = dungeon.entrance.roomId;
    expect(entrance).toBe("dc_sunken_stair");
    expect(reachable(graph, entrance).size).toBe(32);
    for (const room of dungeon.rooms) expect(reachable(graph, room.id).has(entrance), `${room.id} returns`).toBe(true);
    expect(dungeon.deathRecovery.roomId).toBe(entrance);
    const escape = dungeon.portals.find((portal) => portal.id === dungeon.escape.portalId)!;
    expect(escape).toMatchObject({ enabled: true, destination: { kind: "world" }, source: { roomId: entrance } });
  });

  it("opens the Abyssal Gate only on all three wing flags, in any order", () => {
    const gate = dungeon.portals.find((portal) => portal.source.kind === "room" && portal.source.roomId === "dc_circle_of_tides" &&
      portal.destination.kind === "room" && portal.destination.roomId === "dc_abyssal_sanctum")!;
    expect(gate.gates).toEqual(["obs_done", "kelp_done", "harbor_done"].map((flagId) => ({ type: "dungeon_flag", flagId, value: true })));
    const art = dungeon.triggers.filter((trigger) => trigger.actions.some((action) =>
      action.type === "set_object_state" && action.objectId === "abyssal_gate_art" && action.state === "open"));
    expect(art).toHaveLength(3);
    for (const trigger of art) {
      expect(trigger.event.type).toBe("dungeon_flag");
      const flags = new Set([(trigger.event as { flagId: string }).flagId,
        ...trigger.conditions.items.map((item) => (item as { flagId: string }).flagId)]);
      expect([...flags].sort()).toEqual(["harbor_done", "kelp_done", "obs_done"]);
    }
    // Each wing boss sets its flag, lights its hub third and reveals its 2-orb chest.
    for (const [wing, side] of [["obs", "west"], ["kelp", "north"], ["harbor", "east"]] as const) {
      const done = dungeon.triggers.find((trigger) => trigger.id === `${wing}_boss_complete`)!;
      expect(done.actions).toEqual(expect.arrayContaining([
        { type: "set_dungeon_flag", flagId: `${wing}_done`, value: true },
        { type: "set_object_available", roomId: "dc_circle_of_tides", objectId: `tide_circle_${side}_lit`, available: true },
        { type: "set_object_available", roomId: `dc_${wing}_boss`, objectId: `${wing}_chest`, available: true }
      ]));
    }
  });

  it("puts the Watcher's kit anchors (dais, three wave points) in its room", () => {
    const room = dungeon.rooms.find((candidate) => candidate.id === "dc_obs_boss")!;
    const anchors = new Set(room.anchors.map((anchor) => anchor.id));
    for (const phase of THE_WATCHER_SPEC.phases) {
      if (phase.retreatToAnchor) expect(anchors.has(phase.retreatToAnchor)).toBe(true);
      for (const ability of phase.abilities) {
        if (ability.kind === "summon") for (const anchor of ability.spawnAnchors ?? []) expect(anchors.has(anchor), anchor).toBe(true);
      }
    }
    expect(DROWNED_CITY_BOSS_SPECS.map((spec) => spec.id)).toContain(THE_WATCHER_SPEC.id);
  });
});

describe("Drowned City entrances", () => {
  it("maps site ids to colon-free entrance ids and back", () => {
    expect(entranceId).toMatch(/^drowned3_[0-9a-z]+_[0-9a-z]+$/u);
    expect(drownedCitySiteIdForEntrance(entranceId)).toBe(site.siteId);
    expect(drownedCityEntryPortalId(site.siteId)).toBe(`dungeon:${entranceId}:drowned_city_world_to_entrance`);
    expect(drownedCityEntranceIdForSite("pearl:1:2:3")).toBeNull();
    expect(drownedCitySiteIdForEntrance("blightwood_grove_world_entrance")).toBeNull();
    // A well-formed id for a slot that does not exist resolves to nothing.
    expect(drownedCityEntranceAt(DUNGEON_CATALOG, "drowned_zzzz_zzzz")).toBeNull();
    expect(drownedCityEntranceAt(DUNGEON_CATALOG, entranceId)?.entrance).toMatchObject({
      id: entranceId, dungeonId: DROWNED_CITY_DUNGEON_ID, lat: site.position.lat, lon: site.position.lon
    });
  });

  it("is unavailable when the site's slot is not on coastal ocean (land), and fails closed when World is down", async () => {
    const service = (lookup: (points: LatLon[]) => Promise<unknown[]>) => new WaterSiteService({
      pool: { query: vi.fn() } as never, inventory: {} as never,
      worldLookup: { lookupGameplayEnvironments: lookup } as never,
      gameState: {} as never, logger: { warn: vi.fn() }
    });
    const land = service(async (points) => points.map(() => ({ ok: true, surface: "land", waterKind: null })));
    expect(await land.drownedCitySite(site.siteId)).toBeNull();
    const down = service(async () => { throw new Error("world offline"); });
    expect(await down.drownedCitySite(site.siteId)).toBeNull();
    expect(await land.drownedCitySite("pearl:1:2:3")).toBeNull();
    // The runtime and the registry both refuse world entry from such a site.
    const runtime = new CisternWarrensRuntime({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never, {} as never, undefined, undefined,
      { drownedCitySite: (id) => land.drownedCitySite(id) }, DUNGEON_CATALOG);
    await expect(runtime.authorizeEntry("player-1", entranceId)).rejects.toMatchObject({ code: "DUNGEON_NOT_FOUND" });
    expect(await runtime.entrance(entranceId, true)).toBeNull();
    const registry = createAshAtlasPortalRegistry({ query: vi.fn() } as unknown as pg.Pool, { drownedCitySite: (id) => land.drownedCitySite(id) });
    await expect(registry.resolve(drownedCityEntryPortalId(site.siteId)!, worldAt(site.position), { playerId: "player-1" })).rejects.toThrow();
  });

  it("round-trips through the portal registry: world entry to the Sunken Stair, exit back onto the site's water", async () => {
    const registry = createAshAtlasPortalRegistry({ query: vi.fn() } as unknown as pg.Pool, {
      partyIdForPlayer: () => "party-7",
      drownedCitySite: async () => ({ ...site.position })
    });
    const entry = await registry.resolve(drownedCityEntryPortalId(site.siteId)!, worldAt(site.position), { playerId: "player-1" });
    expect(entry.enabled).toBe(true);
    expect(entry.destination).toMatchObject({
      kind: "interior", locationType: "dungeon", locationId: entranceId,
      instanceId: `dungeon:${entranceId}:party:party-7`, spaceId: "dc_sunken_stair"
    });
    expect(entry.revision).toContain(WATER_SITE_PLACEMENT_VERSION);
    expect(entry.pairedPortalId).toBe(portalIds.dungeon(entranceId, dungeon.escape.portalId));
    const inside: PlayerLocationSnapshot = {
      kind: "interior", locationType: "dungeon", locationId: entranceId, instanceId: `dungeon:${entranceId}:party:party-7`,
      spaceId: "dc_sunken_stair", regionCode: `interior:dungeon:${entranceId}:party:party-7`,
      zoneId: `interior:dungeon:${entranceId}:party:party-7:dc_sunken_stair`, position: { x: 500, y: 900 }, revision: 2, lastPortalId: entry.portalId
    };
    const exit = await registry.resolve(entry.pairedPortalId!, inside, { playerId: "player-1" });
    expect(exit.destination.kind).toBe("world");
    // The exit lands on the site's water (World arrival then marks the player afloat for free).
    const landing = exit.destinationArrival as LatLon;
    expect(distanceMeters(landing, site.position)).toBeLessThan(40);
    // A room door inside resolves for this run only.
    const door = portalIds.dungeon(entranceId, "stair_to_causeway");
    await expect(registry.resolve(door, inside, { playerId: "player-1" })).resolves.toMatchObject({ destination: { spaceId: "dc_drowned_causeway" } });
    await expect(registry.resolve(door, { ...inside, locationId: "drowned_0_0" }, { playerId: "player-1" })).rejects.toThrow();
  });

  it("lists nearby Drowned City entrances with this player's party instance", async () => {
    const runtime = new CisternWarrensRuntime({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never, {} as never, undefined, undefined, {
      partyIdForPlayer: () => "party-7",
      drownedCitySitesNear: async () => [site.siteId]
    }, DUNGEON_CATALOG);
    const near = await runtime.entrancesNear(site.position, 1_000, "player-1");
    expect(near.find((entry) => entry.entranceId === entranceId)).toMatchObject({
      dungeonId: DROWNED_CITY_DUNGEON_ID, instanceId: `dungeon:${entranceId}:party:party-7`,
      portalId: drownedCityEntryPortalId(site.siteId), access: expect.objectContaining({ requiresAfloat: true, noReentry: true })
    });
  });
});

function worldAt(position: LatLon): PlayerLocationSnapshot {
  return { kind: "world", regionCode: "world", zoneId: "world:world", position: { ...position }, revision: 1 };
}

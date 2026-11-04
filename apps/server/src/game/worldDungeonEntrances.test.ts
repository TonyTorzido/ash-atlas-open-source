import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DUNGEON_CATALOG,
  DROWNED_CITY_WORLD_ENTRANCE_RULE,
  WORLD_DUNGEON_ENTRANCE_LIFETIME_MS,
  WORLD_DUNGEON_ENTRANCE_RULES,
  destinationPoint,
  distanceMeters,
  findDeveloperDungeonEntranceTemplate,
  worldDungeonEntranceLayersPass,
  worldDungeonEntranceRule,
  worldTimeAt,
  type LatLon,
  type PlayerLocationSnapshot,
  type WorldDungeonEntranceEnvironment,
  type WorldDungeonEntranceRule,
  type WorldTimePhase
} from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { libraryEntranceAssetKey } from "./developerSpawnedDungeons.js";
import { CisternWarrensRuntime } from "./dungeon.js";
import { FALLEN_PRISON_TEMPLATE_ID } from "./fallenPrisonCrash.js";
import {
  GOLEM_FORGE_FAMILY,
  GOLEM_FORGE_NEAREST_TARGET_M,
  GolemForgeSiteService,
  golemForgeEntranceId,
  golemForgeRegionKey,
  golemForgeSlotPosition,
  isLegacyGolemForgeRegionKey,
  parseGolemForgeEntranceId
} from "./golemForgeSites.js";
import { createAshAtlasPortalRegistry } from "./locations/ashAtlasPortalRegistry.js";
import { DROWNED_CITY_FAMILY, domainForPoint, domainsNear, waterSiteCandidateById, waterSiteCandidatesNear } from "./waterSitePlacement.js";
import { WaterSiteService } from "./waterSites.js";
import {
  WorldDungeonEntranceService,
  parseWorldDungeonEntranceId,
  worldDungeonEntranceSeasonLive,
  worldDungeonEntranceSnapshot,
  type WorldDungeonEntranceLookup
} from "./worldDungeonEntrances.js";

const CENTER: LatLon = { lat: 38.5, lon: -107.2 };
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const rule = (dungeonId: string): WorldDungeonEntranceRule => worldDungeonEntranceRule(dungeonId)!;

/** One environment that passes each rule (the "right area"). */
const QUALIFYING: Record<string, WorldDungeonEntranceEnvironment> = {
  fangrock_cavern: { isLand: true, terrainClass: "hilly", landCoverClass: "grassland", elevationM: 1_200, biome: "badlands", isCoastal: false },
  the_eyrie: { isLand: true, terrainClass: "mountainous", landCoverClass: "bare", elevationM: 3_100, biome: "tundra", isCoastal: false },
  blightwood_grove: { isLand: true, terrainClass: "flat", landCoverClass: "forest", elevationM: 300, biome: "greenwood", isCoastal: false },
  still_hand_monastery: { isLand: true, terrainClass: "hilly", landCoverClass: "grassland", elevationM: 2_000, biome: "highmeadow", isCoastal: false },
  wyrm_hollow: { isLand: true, terrainClass: "mountainous", landCoverClass: "bare", elevationM: 2_600, biome: "steppe", isCoastal: false }
};
/** A temperate lowland farm plain: the wrong area for every rolled dungeon. */
const PLAIN: WorldDungeonEntranceEnvironment = {
  isLand: true, terrainClass: "flat", landCoverClass: "cropland", elevationM: 200, biome: "plains", isCoastal: false
};

function lookupOf(environment: WorldDungeonEntranceEnvironment | null, insideCity: (point: LatLon) => boolean = () => false) {
  const calls = { environments: 0, city: 0 };
  const lookup: WorldDungeonEntranceLookup = {
    environments: async (points) => { calls.environments += points.length; return points.map(() => environment); },
    insideCity: async (points) => { calls.city += points.length; return points.map(insideCity); }
  };
  return { lookup, calls };
}

/** The first instant at or after `from` in this world-clock phase. */
function instantIn(phase: WorldTimePhase, from = Date.UTC(2026, 6, 1)): number {
  for (let at = from; at < from + 24 * 60 * 60_000; at += 5 * 60_000) if (worldTimeAt(at).phase === phase) return at;
  throw new Error(`no ${phase}`);
}

function service(dungeonId: string, environment: WorldDungeonEntranceEnvironment | null, now: number) {
  return new WorldDungeonEntranceService({ lookup: lookupOf(environment).lookup, now: () => now, rules: [rule(dungeonId)], lookupPointsPerMinute: Number.POSITIVE_INFINITY });
}

/** The median of a list of numbers. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Deterministic sample spots spread over a square of `sideM` around `center`. */
function sampleSpots(center: LatLon, sideM: number, count: number): LatLon[] {
  const spots: LatLon[] = [];
  for (let index = 0; index < count; index += 1) {
    const north = ((index * 0.618_033_988_75) % 1 - 0.5) * sideM;
    const east = ((index * 0.754_877_666_25) % 1 - 0.5) * sideM;
    spots.push(destinationPoint(destinationPoint(center, Math.abs(north), north < 0 ? 180 : 0), Math.abs(east), east < 0 ? 270 : 90));
  }
  return spots;
}

/** Median nearest-site distance from the spots, and the median and smallest site-to-site nearest distance. */
function ladderStats(sites: readonly LatLon[], spots: readonly LatLon[], innerCenter: LatLon, innerRadiusM: number) {
  const nearest = (from: LatLon, skip?: LatLon) => Math.min(...sites.filter((site) => site !== skip).map((site) => distanceMeters(from, site)));
  const inner = sites.filter((site) => distanceMeters(site, innerCenter) <= innerRadiusM);
  const neighbour = inner.map((site) => nearest(site, site));
  return {
    contactM: median(spots.map((spot) => nearest(spot))),
    neighbourMedianM: median(neighbour),
    neighbourMinM: Math.min(...neighbour),
    count: inner.length
  };
}

const LADDER_REPORT = process.env.LADDER_REPORT === "1";

describe("world dungeon entrance layers", () => {
  it("each rule takes its right area and refuses the wrong one", () => {
    for (const [dungeonId, environment] of Object.entries(QUALIFYING)) {
      const layers = rule(dungeonId).layers;
      expect(worldDungeonEntranceLayersPass(layers, environment), dungeonId).toBe(true);
      expect(worldDungeonEntranceLayersPass(layers, PLAIN), `${dungeonId} on a plain`).toBe(false);
      expect(worldDungeonEntranceLayersPass(layers, { ...environment, isLand: false }), `${dungeonId} on water`).toBe(false);
      expect(worldDungeonEntranceLayersPass(layers, { ...environment, biome: null }), `${dungeonId} unknown biome`).toBe(false);
    }
    // The Eyrie needs 2,500 m; Blightwood refuses coasts and high forest; the Monastery stops at 2,500 m.
    expect(worldDungeonEntranceLayersPass(rule("the_eyrie").layers, { ...QUALIFYING.the_eyrie!, elevationM: 2_400 })).toBe(false);
    expect(worldDungeonEntranceLayersPass(rule("blightwood_grove").layers, { ...QUALIFYING.blightwood_grove!, isCoastal: true })).toBe(false);
    expect(worldDungeonEntranceLayersPass(rule("blightwood_grove").layers, { ...QUALIFYING.blightwood_grove!, elevationM: 1_500 })).toBe(false);
    expect(worldDungeonEntranceLayersPass(rule("still_hand_monastery").layers, { ...QUALIFYING.still_hand_monastery!, elevationM: 2_500 })).toBe(false);
    expect(worldDungeonEntranceLayersPass(rule("wyrm_hollow").layers, { ...QUALIFYING.wyrm_hollow!, terrainClass: "hilly" })).toBe(false);
  });

  it("season multipliers double the live share only in their season", () => {
    const eyrie = rule("the_eyrie");
    const at = (month: number, seasonUnit: number) =>
      worldDungeonEntranceSeasonLive(eyrie, { position: { lat: 45, lon: 7 }, spawnAt: Date.UTC(2026, month, 10), seasonUnit });
    expect(at(6, 0.7)).toBe(true);
    expect(at(0, 0.7)).toBe(false);
    expect(at(0, 0.3)).toBe(true);
  });
});

describe("rolled world entrances", () => {
  const now = instantIn("day");

  it("roll in the right area, never two of one dungeon closer than its spacing, and deterministically", async () => {
    for (const ladderRule of WORLD_DUNGEON_ENTRANCE_RULES) {
      const sites = await service(ladderRule.dungeonId, QUALIFYING[ladderRule.dungeonId]!, now).sitesNear(CENTER, 100_000);
      expect(sites.length, ladderRule.dungeonId).toBeGreaterThan(3);
      for (const [index, left] of sites.entries()) {
        for (const right of sites.slice(index + 1)) {
          expect(distanceMeters(left.position, right.position), ladderRule.dungeonId).toBeGreaterThan(ladderRule.spacingM);
        }
      }
    }
    const first = await service("fangrock_cavern", QUALIFYING.fangrock_cavern!, now).sitesNear(CENTER, 60_000);
    expect(first.length).toBeGreaterThan(0);
    for (const left of first) {
      expect(left.entranceId).toMatch(/^wd2_/u);
      expect(left.expiresAt - left.spawnAt).toBe(WORLD_DUNGEON_ENTRANCE_LIFETIME_MS);
      expect(left.spawnAt <= now && now < left.expiresAt).toBe(true);
      expect(parseWorldDungeonEntranceId(left.entranceId)?.position).toEqual(left.position);
    }
    const again = await service("fangrock_cavern", QUALIFYING.fangrock_cavern!, now).sitesNear(CENTER, 60_000);
    expect(again).toEqual(first);
    // Next week every entrance has moved on (new ids and places).
    const nextWeek = await service("fangrock_cavern", QUALIFYING.fangrock_cavern!, now + WORLD_DUNGEON_ENTRANCE_LIFETIME_MS)
      .sitesNear(CENTER, 60_000);
    const ids = new Set(first.map((site) => site.entranceId));
    expect(nextWeek.length).toBeGreaterThan(0);
    expect(nextWeek.some((site) => ids.has(site.entranceId))).toBe(false);
  });

  it("have zero chance in the wrong area, near a city, or when World does not answer", async () => {
    for (const dungeonId of Object.keys(QUALIFYING)) {
      expect(await service(dungeonId, PLAIN, now).sitesNear(CENTER, 40_000), dungeonId).toEqual([]);
      expect(await service(dungeonId, null, now).sitesNear(CENTER, 40_000), `${dungeonId} World down`).toEqual([]);
    }
    const city = lookupOf(QUALIFYING.fangrock_cavern!, () => true);
    const nearCity = new WorldDungeonEntranceService({ lookup: city.lookup, now: () => now, rules: [rule("fangrock_cavern")], lookupPointsPerMinute: Number.POSITIVE_INFINITY });
    expect(await nearCity.sitesNear(CENTER, 40_000)).toEqual([]);
    expect(city.calls.city).toBeGreaterThan(0);
  });

  it("an entrance resolves by id while it stands; a suppressed or expired slot does not", async () => {
    const roll = service("fangrock_cavern", QUALIFYING.fangrock_cavern!, now);
    const [site] = await roll.sitesNear(CENTER, 40_000);
    expect(await roll.siteForEntrance(site!.entranceId)).toEqual(site);
    const expired = service("fangrock_cavern", QUALIFYING.fangrock_cavern!, site!.expiresAt);
    expect(await expired.siteForEntrance(site!.entranceId)).toBeNull();
    expect(await roll.siteForEntrance("wde_0_0_0_not_a_dungeon")).toBeNull();
    // A first-family (wde_) id still resolves to its point for runs inside, but never stands again.
    const legacyId = site!.entranceId.replace(/^wd2_/u, "wde_");
    expect(parseWorldDungeonEntranceId(legacyId)).toMatchObject({ entranceId: legacyId, legacy: true });
    expect(worldDungeonEntranceSnapshot(DUNGEON_CATALOG, legacyId)).toMatchObject({ entranceId: legacyId });
    expect(await roll.siteForEntrance(legacyId)).toBeNull();
  });

  it("the distance ladder: in fully qualifying land the nearest entrance is near each dungeon's target", async () => {
    const rows: string[] = [];
    for (const ladderRule of WORLD_DUNGEON_ENTRANCE_RULES) {
      // x1 season: the season roll is always live, so the cells are the base rate.
      const base: WorldDungeonEntranceRule = { ...ladderRule, seasonMultipliers: {} };
      const roll = new WorldDungeonEntranceService({ lookup: lookupOf(QUALIFYING[ladderRule.dungeonId]!).lookup, now: () => now,
        rules: [base], lookupPointsPerMinute: Number.POSITIVE_INFINITY });
      const sites = (await roll.sitesNear(CENTER, 200_000)).map((site) => site.position);
      const stats = ladderStats(sites, sampleSpots(CENTER, 200_000, 400), CENTER, 120_000);
      rows.push(`${ladderRule.dungeonId}: cell ${ladderRule.targetAreaKm2} km², spacing ${ladderRule.spacingM / 1_000} km, ` +
        `nearest median ${(stats.contactM / 1_000).toFixed(1)} km (target ${ladderRule.nearestTargetM / 1_000}), ` +
        `entrance-to-entrance median ${(stats.neighbourMedianM / 1_000).toFixed(1)} km, min ${(stats.neighbourMinM / 1_000).toFixed(1)} km`);
      expect(stats.neighbourMinM, ladderRule.dungeonId).toBeGreaterThan(ladderRule.spacingM);
      expect(Math.abs(stats.contactM - ladderRule.nearestTargetM) / ladderRule.nearestTargetM, ladderRule.dungeonId).toBeLessThan(0.15);
    }
    expect(WORLD_DUNGEON_ENTRANCE_RULES.map((entry) => entry.nearestTargetM)).toEqual([10_000, 12_000, 14_000, 17_000, 20_000]);
    if (LADDER_REPORT) console.info(rows.join("\n"));
  });

  it("time-of-day entrances still exist while hidden but are not listed or enterable", async () => {
    const day = service("blightwood_grove", QUALIFYING.blightwood_grove!, instantIn("day"));
    const night = service("blightwood_grove", QUALIFYING.blightwood_grove!, instantIn("night"));
    const hidden = await day.sitesNear(CENTER, 60_000);
    const shown = await night.sitesNear(CENTER, 60_000);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((site) => !site.visible)).toBe(true);
    expect(shown.every((site) => site.visible)).toBe(true);
    const runtime = (worldDungeonEntrances: WorldDungeonEntranceService) => new CisternWarrensRuntime(
      { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never, {} as never, undefined, undefined,
      { worldDungeonEntrances }, DUNGEON_CATALOG);
    expect(await runtime(day).entrancesNear(CENTER, 60_000, "player-1")).toEqual([]);
    const target = hidden[0]!.entranceId;
    await expect(runtime(day).authorizeEntryGates("player-1", target)).rejects.toMatchObject({ code: "DUNGEON_HIDDEN" });
    expect(await runtime(day).entrance(target, true)).toBeNull();
    // A run already inside still resolves the entrance (exit, reconnect) while it is hidden.
    expect(await runtime(day).entrance(target)).toMatchObject({ entranceId: target });
    const listed = await runtime(night).entrancesNear(CENTER, 60_000, "player-1");
    expect(listed.length).toBe(shown.filter((site) => distanceMeters(site.position, CENTER) <= 60_000).length);
    expect(listed[0]).toMatchObject({ dungeonId: "blightwood_grove", assetKey: "apps/client/public/assets/dungeons/blightwood_grove/entrance.png" });
    expect(listed[0]!.instanceId).toBe(`dungeon:${listed[0]!.entranceId}:player:player-1`);
    const registry = (worldDungeonEntrances: WorldDungeonEntranceService) => createAshAtlasPortalRegistry(
      { query: vi.fn() } as unknown as pg.Pool, { worldDungeonEntranceSite: (id) => worldDungeonEntrances.siteForEntrance(id) });
    const portalId = listed[0]!.portalId;
    const world: PlayerLocationSnapshot = { kind: "world", regionCode: "world", zoneId: "world:world", position: { ...CENTER }, revision: 1 };
    await expect(registry(night).resolve(portalId, world, { playerId: "player-1" })).resolves.toMatchObject({ enabled: true });
    await expect(registry(day).resolve(portalId, world, { playerId: "player-1" })).rejects.toThrow();
  });

  it("normal entry enforces the dungeon's level gate", async () => {
    const roll = service("fangrock_cavern", QUALIFYING.fangrock_cavern!, now);
    const [site] = await roll.sitesNear(CENTER, 40_000);
    const runtime = (level: number) => new CisternWarrensRuntime({
      query: vi.fn(async (sql: string) => /player_progression_profiles/u.test(sql)
        ? { rows: [{ level }], rowCount: 1 } : { rows: [], rowCount: 0 })
    } as never, {} as never, undefined, undefined, { worldDungeonEntrances: roll }, DUNGEON_CATALOG);
    await expect(runtime(3).authorizeEntryGates("player-1", site!.entranceId)).rejects.toMatchObject({ code: "DUNGEON_LEVEL_TOO_LOW" });
    await expect(runtime(6).authorizeEntryGates("player-1", site!.entranceId)).resolves.toMatchObject({
      entrance: expect.objectContaining({ entranceId: site!.entranceId })
    });
  });
});

describe("world entrance art", () => {
  const file = (assetKey: string | null | undefined) => Boolean(assetKey) && existsSync(`${REPO_ROOT}${assetKey}`);

  it("every rolled dungeon wears its own entrance PNG", async () => {
    for (const dungeonId of Object.keys(QUALIFYING)) {
      const [site] = await service(dungeonId, QUALIFYING[dungeonId]!, instantIn("dusk")).sitesNear(CENTER, 80_000);
      const snapshot = worldDungeonEntranceSnapshot(DUNGEON_CATALOG, site!.entranceId);
      expect(snapshot?.assetKey, dungeonId).toBe(`apps/client/public/assets/dungeons/${dungeonId}/entrance.png`);
      expect(file(snapshot?.assetKey), dungeonId).toBe(true);
    }
  });

  it("the Fallen Prison crash template exists and wears the prison art; the sewer wears the manhole", () => {
    expect(findDeveloperDungeonEntranceTemplate(DUNGEON_CATALOG, FALLEN_PRISON_TEMPLATE_ID)).not.toBeNull();
    expect(libraryEntranceAssetKey(DUNGEON_CATALOG, "fallen_prison")).toBe("apps/client/public/assets/dungeons/fallen_prison/entrance.png");
    for (const dungeonId of ["fallen_prison", "golem_forge", "drowned_city", "cistern_warrens"]) {
      expect(file(libraryEntranceAssetKey(DUNGEON_CATALOG, dungeonId)), dungeonId).toBe(true);
    }
    expect(libraryEntranceAssetKey(DUNGEON_CATALOG, "cistern_warrens")).toContain("cistern_warrens/entrance.png");
  });
});

describe("Golem Forge slot bias and Drowned City visibility", () => {
  it("the Forge takes the first hill or mountain slot, else the first land slot", async () => {
    const regionKey = golemForgeRegionKey(domainForPoint(GOLEM_FORGE_FAMILY, CENTER));
    expect(regionKey).toMatch(/^x[0-9a-z]+:[0-9a-z]+$/u);
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never;
    const surfaces = (preferred: number[], land: number[]) => (position: LatLon) => {
      const slot = [...Array(16).keys()].find((index) => JSON.stringify(golemForgeSlotPosition(regionKey, index)) === JSON.stringify(position));
      return slot === undefined ? null : preferred.includes(slot) ? "preferred" as const : land.includes(slot) ? "land" as const : "water" as const;
    };
    const site = (preferred: number[], land: number[]) =>
      new GolemForgeSiteService({ pool, worldLookup: undefined, slotSurface: surfaces(preferred, land) }).site(regionKey);
    expect((await site([5], [1, 2]))?.slot).toBe(5);
    expect((await site([], [1, 2]))?.slot).toBe(1);
    expect(await site([], [])).toBeNull();
  });

  it("the median nearest Forge is about 30 km (5,000 km² regions); the 40,000 km² family is retired", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never;
    const forges = new GolemForgeSiteService({ pool, worldLookup: undefined, slotSurface: () => "preferred" });
    const sites = (await forges.sitesNear(CENTER, 450_000)).map((site) => site.position);
    const stats = ladderStats(sites, sampleSpots(CENTER, 400_000, 600), CENTER, 300_000);
    const spacingM = Math.sqrt((Math.PI * 300_000 ** 2) / stats.count);
    if (LADDER_REPORT) {
      console.info(`golem_forge: region ${GOLEM_FORGE_FAMILY.targetAreaKm2} km², mean spacing ${(spacingM / 1_000).toFixed(1)} km, ` +
        `nearest median ${(stats.contactM / 1_000).toFixed(1)} km, forge-to-forge median ${(stats.neighbourMedianM / 1_000).toFixed(1)} km`);
    }
    expect(Math.abs(stats.contactM - GOLEM_FORGE_NEAREST_TARGET_M) / GOLEM_FORGE_NEAREST_TARGET_M).toBeLessThan(0.15);
    // A retired region key / entrance id still resolves to its point, but is never a site.
    const legacyId = "golem_forge_1k_2b_3";
    const legacy = parseGolemForgeEntranceId(legacyId)!;
    expect(isLegacyGolemForgeRegionKey(legacy.regionKey)).toBe(true);
    expect(golemForgeEntranceId(legacy.regionKey, 3)).toBe(legacyId);
    expect(golemForgeSlotPosition(legacy.regionKey, 3)).not.toBeNull();
    expect(await forges.siteForEntrance(legacyId)).toBeNull();
    // A retired Forge that never collapsed is retired once (row upsert, no delete) as a finished collapse.
    const upsert = vi.fn(async () => ({ rows: [{ region_key: legacy.regionKey }], rowCount: 1 }));
    const retiring = new GolemForgeSiteService({ pool: { query: upsert } as never, worldLookup: undefined, now: () => 1_000_000_000 });
    await expect(retiring.retireLegacySite(legacyId)).resolves.toMatchObject({
      regionKey: legacy.regionKey, slot: 3, entranceId: legacyId, state: "collapsed", position: golemForgeSlotPosition(legacy.regionKey, 3)
    });
    const [sql, params] = upsert.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO golem_forge_sites/u);
    expect(sql).not.toMatch(/DELETE/u);
    expect(params).toEqual([legacy.regionKey, 4]);
    const midCollapse = new GolemForgeSiteService({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never, worldLookup: undefined });
    await expect(midCollapse.retireLegacySite(legacyId)).resolves.toBeNull();
    await expect(retiring.retireLegacySite(golemForgeEntranceId(golemForgeRegionKey(domainForPoint(GOLEM_FORGE_FAMILY, CENTER)), 0)))
      .resolves.toBeNull();
    const current = golemForgeRegionKey(domainForPoint(GOLEM_FORGE_FAMILY, CENTER));
    expect(isLegacyGolemForgeRegionKey(current)).toBe(false);
    expect(parseGolemForgeEntranceId(golemForgeEntranceId(current, 4))).toEqual({ regionKey: current, slot: 4 });
  });

  it("the median nearest Drowned City site along a coast is about 25 km", () => {
    // Straight 1,000 km north-south coasts with ocean to the east: coastal ocean is the 5 km strip.
    const lengthM = 1_000_000;
    let count = 0;
    const nearest: number[] = [];
    const coasts = [{ lat: 20, lon: -40 }, { lat: 20, lon: -30.3 }, { lat: -45, lon: 150.7 }, { lat: 35, lon: 10.1 },
      { lat: -30, lon: -70.4 }, { lat: 0, lon: 60.2 }, { lat: 40, lon: -125.6 }, { lat: -10, lon: 120.9 }];
    for (const coast of coasts) {
      const ids = new Set<string>();
      for (let alongM = 0; alongM <= lengthM; alongM += 5_000) {
        for (const domain of domainsNear(DROWNED_CITY_FAMILY, destinationPoint(coast, alongM, 0), 6_000)) {
          ids.add(`drowned3:${domain.band.toString(36)}:${domain.column.toString(36)}`);
        }
      }
      const strip = [...ids].map((id) => waterSiteCandidateById(id)!).filter((site) => {
        const northM = distanceMeters(coast, { lat: site.position.lat, lon: coast.lon }) * Math.sign(site.position.lat - coast.lat);
        const eastM = distanceMeters({ lat: site.position.lat, lon: coast.lon }, site.position) * Math.sign(site.position.lon - coast.lon);
        return northM >= 0 && northM <= lengthM && eastM >= 0 && eastM <= 5_000;
      });
      count += strip.length;
      // Spots on the coast (away from the ends): straight-line distance to the nearest site of this coast.
      for (let alongM = 100_000; alongM <= lengthM - 100_000; alongM += 2_000) {
        const spot = destinationPoint(coast, alongM, 0);
        nearest.push(Math.min(...strip.map((site) => distanceMeters(spot, site.position))));
      }
    }
    const alongCoastM = (coasts.length * lengthM) / count;
    const nearestM = median(nearest);
    if (LADDER_REPORT) {
      console.info(`drowned_city: ${DROWNED_CITY_WORLD_ENTRANCE_RULE.targetAreaKm2} km² cells, one site per ${(alongCoastM / 1_000).toFixed(1)} km ` +
        `of coast, median nearest along a coast ${(nearestM / 1_000).toFixed(1)} km`);
    }
    expect(Math.abs(nearestM - DROWNED_CITY_WORLD_ENTRANCE_RULE.nearestTargetM) / DROWNED_CITY_WORLD_ENTRANCE_RULE.nearestTargetM).toBeLessThan(0.15);
  });

  it("Drowned City sites follow the ladder density and are enterable at dusk and night only", async () => {
    const sites = waterSiteCandidatesNear({ lat: 30, lon: -40 }, 60_000).filter((candidate) => candidate.kind === "drowned_city_site");
    // 60 km radius is ~11,300 km²: one candidate per targetAreaKm2 (about 5 at the old 2,500 km²).
    expect(sites.length).toBeGreaterThan((11_300 / DROWNED_CITY_WORLD_ENTRANCE_RULE.targetAreaKm2) * 0.6);
    expect(sites.every((candidate) => candidate.siteId.startsWith("drowned3:"))).toBe(true);
    const coastal = async (points: LatLon[]) => points.map(() => ({ ok: true, waterKind: "ocean", oceanCoastSurface: { isOceanCoast: true } }));
    const water = (now: number) => new WaterSiteService({
      pool: { query: vi.fn() } as never, inventory: {} as never, worldLookup: { lookupGameplayEnvironments: coastal } as never,
      gameState: {} as never, logger: { warn: vi.fn() }, now: () => now
    });
    expect(await water(instantIn("night")).drownedCitySite(sites[0]!.siteId)).toEqual(sites[0]!.position);
    expect(await water(instantIn("day")).drownedCitySite(sites[0]!.siteId)).toBeNull();
    expect(await water(instantIn("day")).drownedCitySitesNear(sites[0]!.position, 1_000)).toEqual([]);
    expect(await water(instantIn("night")).drownedCitySite("drowned:1:2")).toBeNull();
    expect(await water(instantIn("night")).drownedCitySite("drowned2:1:2")).toBeNull();
    expect(waterSiteCandidateById("drowned2:1:2")).not.toBeNull();
  });
});

describe("rolled entrance World lookups", () => {
  it("stay within the per-minute point budget and fill in as it refills", async () => {
    let now = Date.UTC(2026, 6, 1);
    const { lookup, calls } = lookupOf(QUALIFYING.wyrm_hollow!);
    const rolled = new WorldDungeonEntranceService({ lookup, now: () => now, rules: [rule("wyrm_hollow")], lookupPointsPerMinute: 300 });
    await rolled.sitesNear(CENTER, 25_000);
    expect(calls.environments).toBeLessThanOrEqual(300);
    const first = calls.environments;
    now += 60_000;
    await rolled.sitesNear(CENTER, 25_000);
    expect(calls.environments - first).toBeLessThanOrEqual(300);
  });

  it("pause every lookup after World fails a chunk", async () => {
    let now = Date.UTC(2026, 6, 1);
    let attempts = 0;
    const failing: WorldDungeonEntranceLookup = {
      environments: async (points) => { attempts += 1; throw new Error(`503 for ${points.length}`); },
      insideCity: async (points) => points.map(() => false)
    };
    const rolled = new WorldDungeonEntranceService({ lookup: failing, now: () => now, rules: [rule("wyrm_hollow")], lookupPointsPerMinute: 100_000 });
    expect(await rolled.sitesNear(CENTER, 25_000)).toEqual([]);
    expect(attempts).toBe(1);
    now += 60_000;
    await rolled.sitesNear({ lat: CENTER.lat + 2, lon: CENTER.lon }, 25_000);
    expect(attempts).toBe(1);
  });
});

import { fileURLToPath } from "node:url";

import type { WorldZoneEnvironmentFacts, WorldZoneLookup } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  BIOME_DISCOVERY_MIN_INTERVAL_MS,
  BiomeDiscoveryService,
  loadWorldZoneLookupFromDisk,
  worldZoneLookupCandidates
} from "./biomeDiscovery.js";

const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const PLAINS_LOWLAND = 1 + 7 * 5;
const OPEN_OCEAN_DEEP = 99;

function fakeLookup(code: number): WorldZoneLookup {
  return { codeAt: () => code, nearestCodeAt: () => null };
}

function fakePool(stored: string[] = []) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("INSERT")) {
      const biome = String(values?.[1]);
      if (stored.includes(biome)) return { rowCount: 0, rows: [] };
      stored.push(biome);
      return { rowCount: 1, rows: [{ biome_id: biome }] };
    }
    return { rowCount: stored.length, rows: [...stored, "retired"].map((biome_id) => ({ biome_id })) };
  });
  return { query, stored };
}

function fakeWorld(facts: WorldZoneEnvironmentFacts | Error) {
  return {
    lookupGameplayEnvironment: vi.fn(async () => {
      if (facts instanceof Error) throw facts;
      return facts;
    })
  };
}

const inserts = (pool: ReturnType<typeof fakePool>) =>
  pool.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT")).length;

describe("biome discovery", () => {
  it("finds the bundled lookup from the repository root and from apps/server", () => {
    const logger = { warn: vi.fn() };
    const fromRoot = loadWorldZoneLookupFromDisk(logger, worldZoneLookupCandidates(repositoryRoot));
    const fromServer = loadWorldZoneLookupFromDisk(logger, worldZoneLookupCandidates(serverDirectory));
    // Mid-Pacific is deep ocean in the RESOLVE-derived grid.
    expect(fromRoot?.codeAt(0, -150)).toBeGreaterThanOrEqual(66);
    expect(fromServer?.codeAt(0, -150)).toBe(fromRoot?.codeAt(0, -150));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("disables discovery with a warning when the lookup is missing", async () => {
    const logger = { warn: vi.fn() };
    expect(loadWorldZoneLookupFromDisk(logger, ["Z:/missing/world-zone-lookup-v1.bin"])).toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
    const pool = fakePool();
    await expect(new BiomeDiscoveryService(pool as never, null).discover("p", { lat: 0, lon: 0 })).resolves.toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("classifies with World at the server position and records the discovery", async () => {
    const pool = fakePool();
    const world = fakeWorld({ ok: true, surfaceKind: "land", isLand: true, isRiverbank: true });
    const service = new BiomeDiscoveryService(pool as never, fakeLookup(PLAINS_LOWLAND), world, () => 0);
    await expect(service.discover("p", { lat: 41, lon: -100 })).resolves.toEqual({
      biomes: ["plains"],
      newlyDiscovered: "plains",
      celebration: { biome: "plains", achievements: [] },
      current: { biome: "plains", tags: ["riverside"], heightWord: "Lowland", authority: "world" }
    });
    expect(world.lookupGameplayEnvironment).toHaveBeenCalledWith(41, -100);
  });

  it("awards Legends only on a first discovery, region entry first", async () => {
    const pool = fakePool();
    const world = fakeWorld({ ok: true, surfaceKind: "land", isLand: true });
    const legends = { snapshot: vi.fn(async () => ({ newlyCompletedIds: ["legend_regions_3", "legend_region_plains"] })) };
    let now = 0;
    const service = new BiomeDiscoveryService(pool as never, fakeLookup(PLAINS_LOWLAND), world, () => now, legends);
    const first = await service.discover("p", { lat: 41, lon: -100 });
    expect(first?.celebration?.biome).toBe("plains");
    expect(first?.celebration?.achievements.map((entry) => entry.id)).toEqual(["legend_region_plains", "legend_regions_3"]);
    expect(first?.celebration?.achievements[0]).toMatchObject({ title: "Endless Horizon", points: 10 });
    expect(legends.snapshot).toHaveBeenCalledOnce();
  });

  it("still celebrates the region when the Legend evaluation fails", async () => {
    const pool = fakePool();
    const legends = { snapshot: vi.fn(async () => { throw new Error("boom"); }) };
    const service = new BiomeDiscoveryService(
      pool as never, fakeLookup(PLAINS_LOWLAND), fakeWorld({ ok: true, surfaceKind: "land", isLand: true }), () => 0, legends
    );
    await expect(service.discover("p", { lat: 41, lon: -100 })).resolves.toMatchObject({
      celebration: { biome: "plains", achievements: [] }
    });
  });

  it("answers throttled requests with the last result and no database work", async () => {
    const pool = fakePool();
    let now = 10_000;
    const world = fakeWorld({ ok: true, surfaceKind: "land", isLand: true });
    const service = new BiomeDiscoveryService(pool as never, fakeLookup(PLAINS_LOWLAND), world, () => now);
    const first = await service.discover("p", { lat: 41, lon: -100 });
    now += BIOME_DISCOVERY_MIN_INTERVAL_MS - 1;
    const [throttled, concurrent] = await Promise.all([
      service.discover("p", { lat: 0, lon: -150 }),
      service.discover("p", { lat: 0, lon: -150 })
    ]);
    expect(throttled).toBe(first);
    expect(concurrent).toBe(first);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(world.lookupGameplayEnvironment).toHaveBeenCalledOnce();
    await expect(service.discover("other", { lat: 41, lon: -100 })).resolves.not.toBe(first);
    now += 1;
    const next = await service.discover("p", { lat: 41, lon: -100 });
    expect(next).not.toBe(first);
    expect(next?.newlyDiscovered).toBeNull();
  });

  it("never records Wilds, a player outside the open world, or fallback water", async () => {
    let now = 0;
    const tick = () => (now += BIOME_DISCOVERY_MIN_INTERVAL_MS);
    const pool = fakePool();
    const wilds = new BiomeDiscoveryService(pool as never, fakeLookup(0), fakeWorld({ ok: true, surfaceKind: "land", isLand: true }), () => now);
    await expect(wilds.discover("p", { lat: 89, lon: 0 })).resolves.toMatchObject({
      newlyDiscovered: null, current: { biome: "wilds", authority: "world" }
    });
    tick();
    await expect(wilds.discover("p", null)).resolves.toMatchObject({ newlyDiscovered: null, current: null });
    tick();
    const unavailable = new BiomeDiscoveryService(pool as never, fakeLookup(OPEN_OCEAN_DEEP), fakeWorld({ ok: false }), () => now);
    await expect(unavailable.discover("p", { lat: 0, lon: -150 })).resolves.toMatchObject({
      newlyDiscovered: null, current: { biome: "open_ocean", tags: [], authority: "fallback" }
    });
    tick();
    const thrown = new BiomeDiscoveryService(pool as never, fakeLookup(OPEN_OCEAN_DEEP), fakeWorld(new Error("down")), () => now);
    await expect(thrown.discover("p", { lat: 0, lon: -150 })).resolves.toMatchObject({
      current: { authority: "fallback" }
    });
    expect(inserts(pool)).toBe(0);
  });

  it("records fallback land and World-confirmed water", async () => {
    let now = 0;
    const pool = fakePool();
    const fallbackLand = new BiomeDiscoveryService(pool as never, fakeLookup(PLAINS_LOWLAND), fakeWorld({ ok: false }), () => now);
    await expect(fallbackLand.discover("p", { lat: 41, lon: -100 })).resolves.toMatchObject({ newlyDiscovered: "plains" });
    now += BIOME_DISCOVERY_MIN_INTERVAL_MS;
    const ocean = new BiomeDiscoveryService(pool as never, fakeLookup(PLAINS_LOWLAND), fakeWorld({
      ok: true, surfaceKind: "water", isLand: false, waterKind: "ocean", isSaltwater: true,
      oceanCoastSurface: { isOceanCoast: true }
    }), () => now);
    await expect(ocean.discover("p", { lat: 41, lon: -100 })).resolves.toMatchObject({
      newlyDiscovered: "coast", current: { biome: "coast", heightWord: "Shallows", authority: "world" }
    });
    expect(pool.stored).toEqual(["plains", "coast"]);
  });
});

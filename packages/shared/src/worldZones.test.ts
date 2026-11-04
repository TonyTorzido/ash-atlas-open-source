import { describe, expect, it } from "vitest";

import { WORLD_ENVIRONMENT_OVERLAY_DEFINITION } from "./worldEnvironmentOverlay.js";

import {
  isWorldZoneDiscoverableBiome,
  parseWorldZoneLookup,
  resolveWorldZone,
  WORLD_ZONE_DISCOVERABLE_BIOMES,
  type WorldZoneEnvironmentFacts,
  worldSeasonAt,
  worldZoneBannerContent,
  worldZoneFromCode,
  worldZoneElevationBandFromMeters,
  WORLD_ZONE_ELEVATION_THRESHOLDS_M,
  worldZoneFromParts
} from "./worldZones.js";

const on = (iso: string): Date => new Date(`${iso}T12:00:00Z`);

describe("world zones", () => {
  it("names land by environment category and elevation band", () => {
    // RESOLVE 5 temperate conifer, extreme elevation (3)
    expect(worldZoneFromCode(1 + 4 * 5 + 3, 40.4)).toMatchObject({
      kind: "land",
      name: "Pinewild",
      heightWord: "Peaks",
      elevationBand: 3
    });
  });

  it("keeps real biome distinctions and splits deserts by latitude", () => {
    expect(worldZoneFromCode(1 + 7 * 5, 29.8).name).toBe("Plains");
    expect(worldZoneFromCode(1 + 6 * 5, -2.3).name).toBe("Savanna");
    expect(worldZoneFromCode(1 + 11 * 5, 40).name).toBe("Scrubland");
    expect(worldZoneFromCode(1 + 12 * 5, 23).name).toBe("Badlands");
    expect(worldZoneFromCode(1 + 12 * 5, 43).name).toBe("Steppe");
    expect(worldZoneFromCode(1 + 14 * 5 + 3, 72).name).toBe("Frozen Waste");
  });

  it("names the Summit band above Peaks", () => {
    expect(worldZoneFromCode(1 + 4 * 5 + 4, 28)).toMatchObject({
      name: "Pinewild", heightWord: "Summit", elevationBand: 4
    });
    expect(worldZoneFromParts("pinewild", "Summit").elevationBand).toBe(4);
  });

  it("names water and unknown points", () => {
    expect(worldZoneFromCode(97, 28)).toMatchObject({ name: "Coast", heightWord: "Shallows" });
    expect(worldZoneFromCode(100, 0)).toMatchObject({ name: "Open Ocean", heightWord: "The Abyss" });
    expect(worldZoneFromCode(112, 47)).toMatchObject({ name: "Lake", heightWord: "Freshwater" });
    expect(worldZoneFromCode(0, 88)).toMatchObject({ kind: "unknown", name: "Wilds", heightWord: null });
  });
});

describe("world zone lookup", () => {
  // 4 x 2 grid: north row = [6, 6, 97, 97], south row = [112, 112, 112, 112].
  function lookupBytes(): ArrayBuffer {
    const runs = [[2, 6], [4, 97], [4, 112]] as const;
    const buffer = new ArrayBuffer(12 + 3 * 4 + runs.length * 3);
    const view = new DataView(buffer);
    [..."AAZL"].forEach((char, index) => view.setUint8(index, char.charCodeAt(0)));
    view.setUint16(4, 2, true);
    view.setUint16(6, 4, true);
    view.setUint16(8, 2, true);
    [0, 2, 3].forEach((start, index) => view.setUint32(12 + index * 4, start, true));
    runs.forEach(([end, code], index) => {
      view.setUint16(24 + index * 2, end, true);
      view.setUint8(24 + runs.length * 2 + index, code);
    });
    return buffer;
  }

  it("reads run-length rows in Web Mercator order and wraps longitude", () => {
    const lookup = parseWorldZoneLookup(lookupBytes());
    expect(lookup.codeAt(40, -170)).toBe(6);
    expect(lookup.codeAt(40, 10)).toBe(97);
    expect(lookup.codeAt(40, 190)).toBe(6);
    expect(lookup.codeAt(-40, 100)).toBe(112);
    expect(lookup.codeAt(Number.NaN, 0)).toBe(0);
  });

  it("rejects other formats", () => {
    const bytes = lookupBytes();
    new DataView(bytes).setUint8(0, 0);
    expect(() => parseWorldZoneLookup(bytes)).toThrow("unsupported world zone lookup");
  });

  it("rejects the old 4-band version 1 file", () => {
    const bytes = lookupBytes();
    new DataView(bytes).setUint16(4, 1, true);
    expect(() => parseWorldZoneLookup(bytes)).toThrow("unsupported world zone lookup");
  });

  it("finds the nearest accepted code around a pixel", () => {
    const lookup = parseWorldZoneLookup(lookupBytes());
    expect(lookup.nearestCodeAt(40, 100, (code) => code === 6, 0)).toBeNull();
    expect(lookup.nearestCodeAt(40, 100, (code) => code === 6, 2)).toBe(6);
    expect(lookup.nearestCodeAt(-40, 100, (code) => code === 97, 1)).toBe(97);
  });

  describe("resolveWorldZone", () => {
    // North row: jungle lowland (code 6) at x 0-1, deep-ish ocean band 1 (code 97) at x 2-3.
    const lookup = parseWorldZoneLookup(lookupBytes());
    const onLand = { lat: 40, lon: -100 };
    const onCookedOcean = { lat: 40, lon: 100 };
    const land: WorldZoneEnvironmentFacts = { ok: true, surfaceKind: "land", isLand: true };
    const water = (facts: Partial<WorldZoneEnvironmentFacts>): WorldZoneEnvironmentFacts =>
      ({ ok: true, surfaceKind: "water", isLand: false, ...facts });

    it("derives the land height word from World's point elevation, else the cooked band", () => {
      const at = (elevationM: number | null, extra: Partial<WorldZoneEnvironmentFacts> = {}) =>
        resolveWorldZone(lookup, onLand, { ...land, elevationM, ...extra }).heightWord;
      expect(at(5_200)).toBe("Summit");
      expect(at(5_000)).toBe("Summit");
      expect(at(4_800)).toBe("Peaks");
      expect(at(2_500)).toBe("Peaks");
      expect(at(1_600)).toBe("Highland");
      expect(at(700)).toBe("Upland");
      expect(at(-400)).toBe("Lowland");
      // The cooked pixel says Lowland; unusable elevation falls back to it.
      expect(at(null)).toBe("Lowland");
      expect(resolveWorldZone(lookup, onLand, land).heightWord).toBe("Lowland");
      expect(at(Number.NaN)).toBe("Lowland");
      // River-tagged land uses the same elevation.
      expect(resolveWorldZone(lookup, onLand, water({ waterKind: "river", elevationM: 5_200 })))
        .toMatchObject({ biome: "jungle", tags: ["river"], heightWord: "Summit" });
      // World unavailable: cooked band, no tags.
      expect(resolveWorldZone(lookup, onLand, { ok: false, elevationM: 5_200 }))
        .toMatchObject({ heightWord: "Lowland", authority: "fallback" });
      // Ocean keeps its depth word regardless of elevation.
      expect(resolveWorldZone(lookup, onCookedOcean, water({
        waterKind: "ocean", isSaltwater: true, oceanCoastSurface: { isOceanCoast: false }, elevationM: 0
      })).heightWord).toBe("Shallows");
    });

    it("feeds the resolved height word into the season band", () => {
      const resolved = resolveWorldZone(lookup, { lat: 40, lon: -100 }, { ...land, elevationM: 5_200 });
      const zone = worldZoneFromParts(resolved.biome, resolved.heightWord);
      expect(zone.elevationBand).toBe(4);
      expect(worldSeasonAt({ latitude: 40, date: on("2026-07-15"), elevationBand: zone.elevationBand }).label)
        .toBe("Winter");
    });

    it("reads lakes from World", () => {
      expect(resolveWorldZone(lookup, onLand, water({ waterKind: "lake", isSaltwater: false })))
        .toEqual({ biome: "lake", tags: [], heightWord: "Freshwater", authority: "world" });
      expect(resolveWorldZone(lookup, onLand, water({ waterKind: "inland_water", insideMajorLake: true })).biome)
        .toBe("lake");
    });

    it("splits ocean water into Coast and Open Ocean by the ocean-coast surface", () => {
      expect(resolveWorldZone(lookup, onLand, water({
        waterKind: "ocean", isSaltwater: true, oceanCoastSurface: { isOceanCoast: true }
      }))).toEqual({ biome: "coast", tags: [], heightWord: "Shallows", authority: "world" });
      expect(resolveWorldZone(lookup, onCookedOcean, water({
        waterKind: "ocean", isSaltwater: true, oceanCoastSurface: { isOceanCoast: false }
      }))).toEqual({ biome: "open_ocean", tags: [], heightWord: "Shallows", authority: "world" });
      expect(resolveWorldZone(lookup, onLand, water({
        waterKind: "ocean", isSaltwater: true, oceanCoastSurface: { isOceanCoast: false }
      })).heightWord).toBe("Open Water");
    });

    it("keeps the land biome on river water and tags it", () => {
      expect(resolveWorldZone(lookup, onLand, water({ waterKind: "river", isSaltwater: false })))
        .toEqual({ biome: "jungle", tags: ["river"], heightWord: "Lowland", authority: "world" });
    });

    it("tags land with one shore tag per water kind", () => {
      expect(resolveWorldZone(lookup, onLand, land).tags).toEqual([]);
      expect(resolveWorldZone(lookup, onLand, { ...land, isCoastalLand: true }).tags).toEqual(["shoreline"]);
      expect(resolveWorldZone(lookup, onLand, { ...land, isLakeshore: true, isRiverbank: true }).tags)
        .toEqual(["lakeshore"]);
      expect(resolveWorldZone(lookup, onLand, { ...land, isRiverbank: true, isCoastalLand: true }).tags)
        .toEqual(["shoreline", "riverside"]);
    });

    it("uses the nearest cooked land when World says land on a cooked water pixel", () => {
      expect(resolveWorldZone(lookup, onCookedOcean, { ...land, isCoastalLand: true }))
        .toEqual({ biome: "jungle", tags: ["shoreline"], heightWord: "Lowland", authority: "world" });
    });

    it("falls back to the cooked lookup without tags when World is unavailable", () => {
      const unavailable = { ok: false, surfaceKind: null, isLand: null, isCoastalLand: true };
      expect(resolveWorldZone(lookup, onCookedOcean, unavailable))
        .toEqual({ biome: "coast", tags: [], heightWord: "Shallows", authority: "fallback" });
      expect(resolveWorldZone(lookup, onLand, null).authority).toBe("fallback");
    });
  });

  it("lists sixteen discoverable biomes without the wilds fallback", () => {
    expect(WORLD_ZONE_DISCOVERABLE_BIOMES).toHaveLength(16);
    expect(isWorldZoneDiscoverableBiome("wilds")).toBe(false);
    expect(isWorldZoneDiscoverableBiome("open_ocean")).toBe(true);
    expect(isWorldZoneDiscoverableBiome("atlantis")).toBe(false);
  });
});

describe("elevation thresholds", () => {
  it("match the overlay definition and classify band edges", () => {
    const { moderate, high, extreme, summit } = WORLD_ENVIRONMENT_OVERLAY_DEFINITION.elevationThresholdsM;
    expect([...WORLD_ZONE_ELEVATION_THRESHOLDS_M]).toEqual([moderate, high, extreme, summit]);
    expect([499, 500, 1_499, 1_500, 2_499, 2_500, 4_999, 5_000].map(worldZoneElevationBandFromMeters))
      .toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
  });
});

describe("world seasons", () => {
  it("flips temperate seasons across the equator", () => {
    expect(worldSeasonAt({ latitude: 30, date: on("2026-09-10") }).label).toBe("Early Autumn");
    expect(worldSeasonAt({ latitude: -35, date: on("2026-09-10") }).label).toBe("Early Spring");
    expect(worldSeasonAt({ latitude: 40, date: on("2026-01-15") }).label).toBe("Mid Winter");
    expect(worldSeasonAt({ latitude: 40, date: on("2026-08-28") }).label).toBe("Late Summer");
  });

  it("uses wet and dry seasons in the tropics", () => {
    expect(worldSeasonAt({ latitude: 10, date: on("2026-07-01") }).season).toBe("wet");
    expect(worldSeasonAt({ latitude: -10, date: on("2026-07-01") }).season).toBe("dry");
  });

  it("gives polar and high ground longer winters", () => {
    expect(worldSeasonAt({ latitude: 70, date: on("2026-09-15") }).season).toBe("winter");
    expect(worldSeasonAt({ latitude: 70, date: on("2026-07-15") }).season).toBe("summer");
    expect(worldSeasonAt({ latitude: 40, date: on("2026-11-10"), elevationBand: 2 }).label)
      .toBe("Early Winter");
    expect(worldSeasonAt({ latitude: 40, date: on("2026-10-10"), elevationBand: 3 }).season)
      .toBe("winter");
    expect(worldSeasonAt({ latitude: 72, date: on("2026-07-01"), biome: "frozen_waste" }).label)
      .toBe("Winter");
  });

  it("keeps Summit winter all year outside the tropics and wet/dry inside them", () => {
    expect(worldSeasonAt({ latitude: 28, date: on("2026-07-15"), elevationBand: 4 }))
      .toMatchObject({ season: "winter", phase: null, label: "Winter" });
    expect(worldSeasonAt({ latitude: -16.5, date: on("2026-01-15"), elevationBand: 4 }).season)
      .toBe("wet");
    expect(worldSeasonAt({ latitude: 40, date: on("2026-07-15"), elevationBand: 3 }).season)
      .toBe("summer");
  });

  it("builds a two-part banner line", () => {
    const zone = worldZoneFromCode(1 + 4 * 5 + 2, 40);
    const season = worldSeasonAt({ latitude: 40, date: on("2027-01-05"), elevationBand: 2 });
    expect(worldZoneBannerContent(zone, season)).toEqual({
      key: "pinewild",
      title: "Pinewild",
      detail: "Mid Winter · Highland"
    });
  });
});

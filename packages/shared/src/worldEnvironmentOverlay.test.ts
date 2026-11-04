import { describe, expect, it } from "vitest";

import { WORLD_ENVIRONMENT_OVERLAY_DEFINITION } from "./worldEnvironmentOverlay.js";
import {
  BADLANDS_MAX_ABS_LATITUDE,
  RESOLVE_BIOME_CLASSES,
  WORLD_ZONE_BIOME_NAMES,
  WORLD_ZONE_DISCOVERABLE_BIOMES,
  type WorldZoneBiome
} from "./worldZones.js";

type BiomeCategory = {
  id: string;
  label: string;
  color: string;
  sourceBiomeIds: readonly number[];
  includeEcoregionNames?: readonly string[];
  excludeEcoregionNames?: readonly string[];
  minAbsLatitude?: number;
  maxAbsLatitudeExclusive?: number;
};

const biomeGroup = WORLD_ENVIRONMENT_OVERLAY_DEFINITION.groups.find((group) => group.id === "environment")!;
const categories = biomeGroup.categories as readonly BiomeCategory[];
const LAND_BIOMES = WORLD_ZONE_DISCOVERABLE_BIOMES.slice(0, 13);
const ROCK_AND_ICE_CLASS_INDEX = 14;

describe("World Map Biomes layer definition", () => {
  it("is the Biomes layer with exactly the 13 land biomes of worldZones, in order", () => {
    expect(biomeGroup.label).toBe("Biomes");
    expect(LAND_BIOMES).toHaveLength(13);
    expect(categories.map((category) => category.id)).toEqual([...LAND_BIOMES]);
    expect(categories.map((category) => category.label)).toEqual(
      LAND_BIOMES.map((biome) => WORLD_ZONE_BIOME_NAMES[biome])
    );
    expect(new Set(categories.map((category) => category.color)).size).toBe(13);
  });

  it("maps RESOLVE biome numbers exactly like RESOLVE_BIOME_CLASSES", () => {
    const expectedSources = (biome: WorldZoneBiome): number[] => {
      const numbers: number[] = [];
      RESOLVE_BIOME_CLASSES.slice(0, ROCK_AND_ICE_CLASS_INDEX).forEach((value, index) => {
        // Steppe shares RESOLVE desert biome 13 with Badlands.
        const resolved = biome === "steppe" ? "badlands" : biome;
        if (value === resolved) numbers.push(index + 1);
      });
      return numbers;
    };
    for (const category of categories) {
      const biome = category.id as WorldZoneBiome;
      if (biome === "frozen_waste") {
        expect(RESOLVE_BIOME_CLASSES[ROCK_AND_ICE_CLASS_INDEX]).toBe("frozen_waste");
        expect(category.sourceBiomeIds).toEqual([11]);
        expect(category.includeEcoregionNames).toEqual(["Rock and Ice"]);
        continue;
      }
      expect([...category.sourceBiomeIds].sort((a, b) => a - b)).toEqual(expectedSources(biome));
    }
    expect(categories.find((category) => category.id === "tundra")!.excludeEcoregionNames)
      .toEqual(["Rock and Ice"]);
  });

  it("splits Badlands and Steppe at the same latitude worldZones uses", () => {
    const badlands = categories.find((category) => category.id === "badlands")!;
    const steppe = categories.find((category) => category.id === "steppe")!;
    expect(badlands.maxAbsLatitudeExclusive).toBe(BADLANDS_MAX_ABS_LATITUDE);
    expect(steppe.minAbsLatitude).toBe(BADLANDS_MAX_ABS_LATITUDE);
    expect(badlands.minAbsLatitude).toBeUndefined();
    expect(steppe.maxAbsLatitudeExclusive).toBeUndefined();
  });

  it("covers every RESOLVE land biome number once, apart from the latitude split", () => {
    const covered = categories
      .filter((category) => category.id !== "steppe")
      .flatMap((category) => category.sourceBiomeIds);
    expect(new Set(covered)).toEqual(new Set(Array.from({ length: 14 }, (_, index) => index + 1)));
  });
});

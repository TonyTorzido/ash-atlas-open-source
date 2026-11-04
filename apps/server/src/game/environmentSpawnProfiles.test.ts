import { describe, expect, it } from "vitest";

import {
  countFromEnvironmentRange,
  deriveEnvironmentSpawnProfileKey,
  ENVIRONMENT_SPAWN_PROFILES,
  ENVIRONMENT_SPAWN_PROFILE_KEYS,
  environmentSpawnPolicyMatches,
  environmentSpawnSlotEligible,
  environmentSpawnProfileFor,
  selectEnvironmentEncounter
} from "./environmentSpawnProfiles.js";

describe("environment spawn profiles", () => {
  it.each([
    [{ biomeName: "Deserts and xeric shrublands" }, "hot_desert_lowland"],
    [{ ecoregionName: "Cold temperate desert" }, "cold_desert"],
    [{ biomeName: "Temperate broadleaf forest" }, "temperate_forest"],
    [{ ecoregionName: "Tropical rainforest" }, "tropical_forest"],
    [{
      biomeName: "Tropical & Subtropical Moist Broadleaf Forests"
    }, "tropical_forest"],
    [{ landCoverClass: "Natural grassland" }, "grassland"],
    [{ biomeName: "Tropical savanna" }, "savanna"],
    [{ landCoverClass: "Woody wetland" }, "wetland"],
    [{ isCoastal: true }, "coastal"],
    [{ elevationBand: "alpine" }, "alpine"],
    [{ biomeName: "Arctic tundra" }, "tundra"],
    [{ terrainClass: "plain" }, "generic_land"]
  ] as const)("maps compact geography %o to %s", (facts, expected) => {
    expect(deriveEnvironmentSpawnProfileKey(facts)).toBe(expected);
  });

  it("defines versioned rules using only currently available content", () => {
    expect(Object.keys(ENVIRONMENT_SPAWN_PROFILES).sort())
      .toEqual([...ENVIRONMENT_SPAWN_PROFILE_KEYS].sort());
    for (const key of ENVIRONMENT_SPAWN_PROFILE_KEYS) {
      const profile = ENVIRONMENT_SPAWN_PROFILES[key];
      expect(Object.keys(profile.resourceWeights)).toEqual(["tree"]);
      expect(Object.keys(profile.encounterWeights).sort()).toEqual(["deer", "ogre", "wolf_pack"]);
      expect(Object.values(profile.encounterWeights).reduce((sum, weight) => sum + weight, 0))
        .toBeCloseTo(1);
      expect(profile.slotEligibility).toMatchObject({
        requireLand: true,
        rejectSaltwater: true,
        rejectMajorLake: true
      });
    }
  });

  it("preserves the existing generic 60/30/10 encounter boundaries", () => {
    const generic = environmentSpawnProfileFor({ terrainClass: "plain" });
    expect(selectEnvironmentEncounter(generic, 0.599999)).toBe("deer");
    expect(selectEnvironmentEncounter(generic, 0.6)).toBe("wolf_pack");
    expect(selectEnvironmentEncounter(generic, 0.899999)).toBe("wolf_pack");
    expect(selectEnvironmentEncounter(generic, 0.9)).toBe("ogre");
  });

  it("exposes content-neutral shoreline predicates that fail closed on water", () => {
    const shorelinePolicy = {
      requireLand: true,
      rejectSaltwater: true,
      rejectMajorLake: true,
      requiredFacts: {
        isRiverbank: true,
        isLakeshore: true
      },
      requiredPlacementTags: ["riverbank", "lakeshore"]
    } as const;
    const land = {
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      isRiverbank: true,
      isLakeshore: true,
      placementTags: ["land", "riverbank", "lakeshore"]
    } as const;
    expect(environmentSpawnPolicyMatches(land, shorelinePolicy)).toBe(true);
    expect(environmentSpawnPolicyMatches({
      ...land,
      isLand: false,
      placementTags: ["river", "riverbank", "lakeshore"]
    }, shorelinePolicy)).toBe(false);
    expect(environmentSpawnSlotEligible(
      environmentSpawnProfileFor({ terrainClass: "plain" }),
      land
    )).toBe(true);
    expect(environmentSpawnSlotEligible(
      environmentSpawnProfileFor({ terrainClass: "plain" }),
      { ...land, isSaltwater: true }
    )).toBe(false);
  });

  it("maps deterministic unit rolls across inclusive count ranges", () => {
    expect(countFromEnvironmentRange([2, 4], 0)).toBe(2);
    expect(countFromEnvironmentRange([2, 4], 0.5)).toBe(3);
    expect(countFromEnvironmentRange([2, 4], 0.999999)).toBe(4);
  });
});

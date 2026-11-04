import { describe, expect, it } from "vitest";

import type { KingdomEnvironmentSnapshot } from "@ash-atlas/shared";

import {
  KingdomConstructionPolicy,
  KingdomError,
  environmentModifiersFor,
  normalizeKingdomName
} from "./kingdoms.js";

describe("Kingdom domain helpers", () => {
  it("normalizes a safe display name and case-insensitive identity", () => {
    expect(normalizeKingdomName("  Ember   Guard  ")).toEqual({
      displayName: "Ember Guard",
      normalizedName: "ember guard"
    });
  });

  it.each(["", "ab", "trailing-", "bad!name", "two--separators", "line\nbreak"])(
    "rejects unsafe or visually invalid Kingdom name %j",
    (name) => {
      expect(() => normalizeKingdomName(name)).toThrow(KingdomError);
    }
  );

  it("does not derive construction requirements from environment", () => {
    expect(environmentModifiersFor({
      terrainClass: "temperate forest",
      biome: null,
      elevationM: 1_200
    })).toEqual([]);
    expect(environmentModifiersFor({
      terrainClass: null,
      biome: "unknown",
      elevationM: null
    })).toEqual([]);
  });

  it("quotes intended adjusted costs while keeping free mode server owned", () => {
    const quote = new KingdomConstructionPolicy(true).quote("found", environment({
      terrainClass: "forest"
    }));
    expect(quote).toMatchObject({
      action: "found",
      freeConstruction: true,
      intendedConstructionSeconds: 0,
      adjustedConstructionSeconds: 0
    });
    expect(quote.modifiers).not.toContainEqual(expect.objectContaining({ key: "construction_time" }));
    expect(quote.intendedCost).toContainEqual({ resourceType: "wood", quantity: 450 });
    expect(quote.adjustedCost).toContainEqual({ resourceType: "wood", quantity: 450 });
  });
});

function environment(
  overrides: Partial<KingdomEnvironmentSnapshot> = {}
): KingdomEnvironmentSnapshot {
  return {
    terrainClass: null,
    biome: null,
    ecoregion: null,
    elevationM: null,
    elevationBand: null,
    slope: null,
    slopeBand: null,
    isLand: true,
    isSaltwater: false,
    insideMajorLake: false,
    worldReleaseId: null,
    worldReleaseVersion: null,
    worldPackageId: "test-package",
    environmentSchemaVersion: null,
    environmentRulesVersion: 1,
    sourceVersions: {},
    lookedUpAt: "2026-07-10T00:00:00.000Z",
    ...overrides
  };
}

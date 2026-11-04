import { describe, expect, it } from "vitest";

import {
  CITY_FACILITY_COSTS,
  CITY_HOUSE_BUILD_DURATION_MS,
  CITY_HALL_FOOTPRINT_RADIUS_M,
  MILITARY_FACILITY_CATALOG,
  MILITARY_FACILITY_TYPES,
  CITY_STRUCTURE_BUILD_DURATION_MS,
  CITY_STRUCTURE_EXCLUSION_MARGIN_M,
  CITY_STRUCTURE_FOOTPRINT_RADIUS_M,
  OIL_WELL_BUILD_DURATION_MS,
  OIL_WELL_CAPACITY,
  OIL_WELL_COST,
  cityConstructionDurationMs,
  cityStructureExclusionRadiusM,
  cityStructureRequiredCenterDistanceM
} from "./citySystem.js";
import { buildCityFacilityMessageSchema } from "./protocol/settlementSchemas.js";

describe("city facility costs", () => {
  it("exposes only the active personal military building roster", () => {
    expect(MILITARY_FACILITY_TYPES).toEqual([
      "barracks",
      "demolition_factory"
    ]);
    expect(Object.keys(MILITARY_FACILITY_CATALOG)).toEqual([
      ...MILITARY_FACILITY_TYPES
    ]);
    expect(MILITARY_FACILITY_CATALOG).toMatchObject({
      barracks: { title: "Barracks" },
      demolition_factory: { title: "Demolition Factory" }
    });
    expect(Object.keys(MILITARY_FACILITY_CATALOG)).not.toEqual(
      expect.arrayContaining(["armory", "siege_workshop", "powder_works"])
    );
  });

  it("uses one authoritative 30-second duration for every physical structure action", () => {
    expect(CITY_HOUSE_BUILD_DURATION_MS).toBe(30_000);
    expect(cityConstructionDurationMs("build_house")).toBe(30_000);
    expect(OIL_WELL_BUILD_DURATION_MS).toBe(30_000);
    expect(cityConstructionDurationMs("build_oil_well")).toBe(30_000);
    expect(CITY_STRUCTURE_BUILD_DURATION_MS).toBe(30_000);
    expect(cityConstructionDurationMs("build_facility")).toBe(30_000);
    expect(cityConstructionDurationMs("upgrade_facility")).toBe(30_000);
    expect(cityConstructionDurationMs("build_market")).toBe(30_000);
    expect(cityConstructionDurationMs("build_monument")).toBe(30_000);
    expect(cityConstructionDurationMs("upgrade_monument")).toBe(30_000);
  });

  it("defines the V1 personal Oil Well recipe, capacity, and larger footprint", () => {
    expect(OIL_WELL_COST.materials).toEqual([
      { itemId: "wood", quantity: 225 },
      { itemId: "stone", quantity: 30 },
      { itemId: "balsam_resin", quantity: 110 }
    ]);
    expect(OIL_WELL_CAPACITY).toBe(120);
    expect(CITY_STRUCTURE_FOOTPRINT_RADIUS_M.oil_well).toBe(12);
    expect(CITY_STRUCTURE_FOOTPRINT_RADIUS_M.oil_well).toBe(
      CITY_STRUCTURE_FOOTPRINT_RADIUS_M.city_house * 1.2
    );
  });

  it("defines the Warehouse and one-tier city facility costs", () => {
    expect(CITY_FACILITY_COSTS).toEqual({
      warehouse: {
        1: {
          materials: [
            { itemId: "wood", quantity: 110 },
            { itemId: "stone", quantity: 70 }
          ],
          cityCoins: 110
        },
        2: {
          materials: [
            { itemId: "wood", quantity: 185 },
            { itemId: "stone", quantity: 12 }
          ],
          cityCoins: 450
        },
        3: {
          materials: [
            { itemId: "wood", quantity: 430 },
            { itemId: "stone", quantity: 12 }
          ],
          cityCoins: 1_400
        }
      },
      cistern_warrens: {
        1: {
          materials: [
            { itemId: "wood", quantity: 140 },
            { itemId: "stone", quantity: 160 }
          ],
          cityCoins: 275
        },
        2: { materials: [], cityCoins: 0 },
        3: { materials: [], cityCoins: 0 }
      },
      salon: {
        1: {
          materials: [
            { itemId: "wood", quantity: 90 },
            { itemId: "stone", quantity: 55 }
          ],
          cityCoins: 120
        },
        2: { materials: [], cityCoins: 0 },
        3: { materials: [], cityCoins: 0 }
      },
      city_kennel: {
        1: {
          materials: [
            { itemId: "wood", quantity: 95 },
            { itemId: "stone", quantity: 45 }
          ],
          cityCoins: 90
        },
        2: { materials: [], cityCoins: 0 },
        3: { materials: [], cityCoins: 0 }
      }
    });
  });

  it("accepts the Cistern Warrens as a buildable facility", () => {
    expect(buildCityFacilityMessageSchema.safeParse({
      type: "BUILD_CITY_FACILITY",
      requestId: "cistern-warrens-v1",
      cityId: "00000000-0000-4000-8000-000000000001",
      facilityType: "cistern_warrens"
    }).success).toBe(true);
  });

  it("accepts the City Kennel as a buildable one-tier facility", () => {
    expect(buildCityFacilityMessageSchema.safeParse({
      type: "BUILD_CITY_FACILITY",
      requestId: "city-kennel-v1",
      cityId: "00000000-0000-4000-8000-000000000001",
      facilityType: "city_kennel"
    }).success).toBe(true);
    expect(CITY_STRUCTURE_FOOTPRINT_RADIUS_M.city_kennel).toBe(16);
  });

  it.each(["weaponsmith", "armory"])(
    "rejects crafted %s build commands",
    (facilityType) => {
      expect(buildCityFacilityMessageSchema.safeParse({
        type: "BUILD_CITY_FACILITY",
        requestId: "remove-legacy-facility",
        cityId: "00000000-0000-4000-8000-000000000001",
        facilityType
      }).success).toBe(false);
    }
  );
});

describe("city structure exclusion distances", () => {
  it("reserves each building footprint plus its own 150 meter margin", () => {
    expect(CITY_STRUCTURE_EXCLUSION_MARGIN_M).toBe(150);
    expect(cityStructureExclusionRadiusM(
      CITY_STRUCTURE_FOOTPRINT_RADIUS_M.city_house
    )).toBe(160);
    expect(cityStructureExclusionRadiusM(
      CITY_STRUCTURE_FOOTPRINT_RADIUS_M.warehouse
    )).toBe(168);
  });

  it.each([
    ["House to House", 10, 10, 320],
    ["House to Warehouse", 10, 18, 328],
    ["Warehouse to Warehouse", 18, 18, 336],
    ["House to City Hall", 10, CITY_HALL_FOOTPRINT_RADIUS_M, 330],
    ["Warehouse to City Hall", 18, CITY_HALL_FOOTPRINT_RADIUS_M, 338]
  ])("%s requires the exact summed exclusion distance", (
    _label,
    proposedRadius,
    blockingRadius,
    expected
  ) => {
    const required = cityStructureRequiredCenterDistanceM(
      proposedRadius,
      blockingRadius
    );
    expect(required).toBe(expected);
    expect(required < required).toBe(false);
    expect(required - 0.001 < required).toBe(true);
  });
});
